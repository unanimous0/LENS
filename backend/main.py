"""LENS API -- unified entry point.

실시간 시세/호가/모드 전환은 Rust 서비스(8200)가 전담한다.
여기서는 파일 분석(대차·상환·대여)과 정적 JSON(마스터) REST만 제공.

내부망 등 일부 환경에서 종속성이 빠질 수 있어 router import 실패 시 해당 router만
스킵하고 나머지는 정상 등록. 핵심 router(대차/상환/borrowing/health)는 의존성이 가벼워
거의 항상 로드 성공.
"""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings


app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger = logging.getLogger("uvicorn.error")

for module_name in ("arbitrage", "backtest", "borrowing", "dividends", "etfs", "flow", "health", "lending", "loan_rates", "lp", "permanent_sub", "positions", "repayment", "stat_arb", "stocks"):
    try:
        module = __import__(f"routers.{module_name}", fromlist=["router"])
        app.include_router(module.router, prefix="/api")
    except Exception as e:  # noqa: BLE001
        logger.warning("Router '%s' load skipped: %s", module_name, e)


@app.on_event("startup")
async def _ensure_schemas_on_startup() -> None:
    """SQLite 스키마 보장 — 라우터의 lazy _ensure는 안전망 (uvicorn reload race 회피)."""
    for module_name in ("positions", "loan_rates"):
        try:
            module = __import__(f"services.{module_name}", fromlist=["ensure_schema"])
            await module.ensure_schema()
        except Exception as e:  # noqa: BLE001
            logger.warning("startup schema ensure %s skipped: %s", module_name, e)
    # backtest 전략·실행 이력 (lens.db 공유) — backtest.md §6.
    try:
        from services.backtest import store as backtest_store
        await backtest_store.ensure_schema()
    except Exception as e:  # noqa: BLE001
        logger.warning("startup schema ensure backtest store skipped: %s", e)


@app.on_event("startup")
async def _warmup_flow_ranking() -> None:
    """수급 랭킹 백그라운드 워밍업 — 콜д 계산(190일 lookback)을 미리 캐시에 채워
    첫 사용자 진입 시 캐시 히트. 서버 부팅은 막지 않도록 create_task로 분리."""
    import asyncio

    async def _run() -> None:
        try:
            from services import flow_metrics as fm

            info = await fm.resolve_as_of()
            await fm.ranking(info.as_of)
            if info.prev:
                await fm.ranking(info.prev)  # NEW 뱃지 비교용
            logger.info("flow ranking warmup done (as_of=%s)", info.as_of)
        except Exception as e:  # noqa: BLE001
            logger.warning("flow ranking warmup skipped: %s", e)

    asyncio.create_task(_run())


@app.on_event("startup")
async def _refresh_flow_backtest_if_stale() -> None:
    """수급 태그 검증(백테스트) 결과 주기 갱신 — data/flow_backtest.json이 없거나 30일 초과 시
    백그라운드 subprocess로 재실행. 무거운 pandas 작업이라 이벤트 루프를 막지 않게 격리 실행.
    실패해도 flow_ai는 하드코딩 기본값으로 degrade. Finance_Data read-only(SELECT만)."""
    import os
    import subprocess
    import sys
    import time
    from pathlib import Path

    try:
        repo = Path(__file__).resolve().parents[1]
        out = repo / "data" / "flow_backtest.json"
        lock = repo / "data" / ".flow_backtest.running"
        now = time.time()
        fresh = out.exists() and (now - out.stat().st_mtime) < 30 * 86400
        # 스키마 갱신(PR-A rank_ic / PR-B universe_index): 신 필드 없는 구스키마 파일은 아직
        # 신선해도 재생성 대상 — 검증 근거 곡선(rank_ic)·에피소드 벤치마크(universe_index)에 필요.
        # 실패해도 flow_ai는 구파일로 degrade.
        if fresh:
            import json as _json

            try:
                data = _json.loads(out.read_text(encoding="utf-8"))
                fresh = "rank_ic" in data and "universe_index" in data
            except Exception:  # noqa: BLE001 — 손상 파일이면 재생성
                fresh = False
        running = lock.exists() and (now - lock.stat().st_mtime) < 1200  # 20분 내 실행 중이면 스킵
        if fresh or running:
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(str(now))
        env = {**os.environ, "PYTHONPATH": str(repo / "backend")}
        subprocess.Popen(
            [sys.executable, str(repo / "backend" / "scripts" / "flow_tag_backtest.py"), "--save", str(out)],
            cwd=str(repo / "backend"),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        logger.info("flow backtest refresh spawned (missing/stale)")
    except Exception as e:  # noqa: BLE001
        logger.warning("flow backtest refresh skipped: %s", e)


@app.on_event("startup")
async def _sync_permanent_subs_on_startup() -> None:
    """LENS 시작 시 LP 매트릭스 타겟 + active 포지션 leg를 realtime 영구 sub로 동기화.

    LP 매트릭스가 fair_value 계산에 필요한 가격을 받으려면 PDF 구성종목 + 매칭 선물이
    LS WS sub되어 있어야 함. 사용자가 ETF 페이지를 열지 않아도 *항상* sub되도록 startup에 push.
    """
    try:
        from services.permanent_sub import sync_full_set
        await sync_full_set()
    except Exception as e:  # noqa: BLE001
        logger.warning("startup permanent-sub sync skipped: %s", e)
