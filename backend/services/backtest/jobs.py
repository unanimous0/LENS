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
from .engine import run_event_study
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
    status: str = "queued"          # queued | running | done | error
    progress: int = 0
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None


async def _run_backtest(spec: Strategy, progress_cb) -> dict:
    panel = await panel_mod.ensure_panel(progress_cb)          # 0~55 (콜드 빌드 시)
    result = await asyncio.to_thread(run_event_study, panel, spec, progress_cb)
    # 에피소드에 등장한 코드만 종목명 조인 (경량 조회 — 프론트 에피소드 테이블용).
    codes = sorted({e["stock"] for e in result.get("episodes", [])})
    if codes:
        result["meta"]["stock_names"] = await panel_mod.fetch_stock_names(codes)
    return result


async def _run(job: Job) -> None:
    async with _run_lock:       # 대기 중엔 status=queued 유지
        job.status = "running"

        def cb(p: int) -> None:
            job.progress = max(job.progress, int(p))

        try:
            job.result = await _run_backtest(job.spec, cb)
            job.progress = 100
            job.status = "done"
        except Exception as e:  # noqa: BLE001 — 사용자에게 error 상태로 전달
            logger.exception("backtest job %s failed", job.id)
            job.status = "error"
            job.error = f"{type(e).__name__}: {e}"
        finally:
            job.finished_at = time.time()


def submit(spec: Strategy) -> str:
    _gc()
    job = Job(id=uuid.uuid4().hex[:12], spec=spec)
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
