"""메모리 job 레지스트리 — backtest.md §2/§6.

submit(spec) → job_id, 상태 queued|running(progress 0~100)|done|error. 무거운 연산은
asyncio.to_thread. **동시 실행 1개** (초과는 asyncio.Lock 대기 = 큐). 패널 미빌드/stale이면
job이 빌드부터 (진행률에 반영). 재시작 시 실행 중 job 소실 허용 (단일 사용자 데스크 도구).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from . import panel as panel_mod
from . import store
from .engine import run_event_study
from .engine_portfolio import run_portfolio
from .schema import Strategy

logger = logging.getLogger("uvicorn.error")

_jobs: dict[str, "Job"] = {}
_run_lock = asyncio.Lock()   # 동시 실행 1개
_MAX_JOBS = 200              # 오래된 job 정리 상한
_tasks: set[asyncio.Task] = set()  # create_task 참조 보관 (GC 조기 수거 방지 — asyncio 권장 패턴)


@dataclass
class Job:
    id: str
    spec: Strategy
    strategy_id: str | None = None
    status: str = "queued"          # queued | running | done | error
    progress: int = 0
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None


async def _run_backtest(spec: Strategy, strategy_id: str | None, progress_cb) -> dict:
    panel = await panel_mod.ensure_panel(progress_cb)          # 0~55 (콜드 빌드 시)
    # holdout 개봉 판정: 저장 전략이 개봉됐고 **실행 spec_hash가 개봉 시점 해시와 일치**할 때만
    # 전체 기간 측정(우회 차단). ad-hoc·미개봉·hash 불일치 → train 캡(기본 레일).
    holdout_unlocked = False
    if strategy_id:
        s = await store.get_strategy(strategy_id)
        if (s and s.get("holdout_unlocked_at")
                and s.get("holdout_spec_hash") == store.spec_hash(spec)):
            holdout_unlocked = True
    runner = run_portfolio if spec.portfolio.mode == "portfolio" else run_event_study
    result = await asyncio.to_thread(
        lambda: runner(panel, spec, progress_cb, holdout_unlocked=holdout_unlocked))
    # 에피소드에 등장한 코드만 종목명 조인 (경량 조회 — 프론트 에피소드 테이블용).
    codes = sorted({e["stock"] for e in result.get("episodes", [])})
    if codes:
        result["meta"]["stock_names"] = await panel_mod.fetch_stock_names(codes)
    return result


async def _run(job: Job) -> None:
    async with _run_lock:       # 대기 중엔 status=queued 유지
        job.status = "running"
        started_ms = int(time.time() * 1000)

        def cb(p: int) -> None:
            job.progress = max(job.progress, int(p))

        result: dict | None = None
        status = "error"
        try:
            result = await _run_backtest(job.spec, job.strategy_id, cb)
            status = "done"
        except Exception as e:  # noqa: BLE001 — 사용자에게 error 상태로 전달
            logger.exception("backtest job %s failed", job.id)
            job.error = f"{type(e).__name__}: {e}"
        finally:
            job.finished_at = time.time()

        # 실행 이력 자동 기록(성공/실패 모두) + 다중검정 카운터 → 결과에 attempts 주입.
        # status를 done으로 올리기 **전에** attempts를 채워 poll이 attempts 없는 result를 보지 않게.
        try:
            summary = store.summary_of(result) if result is not None else None
            attempts = await store.record_run(
                spec=job.spec, strategy_id=job.strategy_id, summary=summary,
                started_at=started_ms, finished_at=int((job.finished_at or 0) * 1000),
                status=status)
            if result is not None:
                result["attempts"] = attempts
        except Exception as e:  # noqa: BLE001 — 이력 기록 실패는 결과 반환을 막지 않음
            logger.warning("backtest run history record skipped: %s", e)

        if status == "done":
            job.result = result
            job.progress = 100
            job.status = "done"
        else:
            job.status = "error"


def submit(spec: Strategy, strategy_id: str | None = None) -> str:
    _gc()
    job = Job(id=uuid.uuid4().hex[:12], spec=spec, strategy_id=strategy_id)
    _jobs[job.id] = job
    task = asyncio.create_task(_run(job))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return job.id


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def _gc() -> None:
    if len(_jobs) <= _MAX_JOBS:
        return
    # 완료/에러 중 오래된 것부터 제거
    done = sorted((j for j in _jobs.values() if j.finished_at),
                  key=lambda j: j.finished_at)
    for j in done[: len(_jobs) - _MAX_JOBS]:
        _jobs.pop(j.id, None)
