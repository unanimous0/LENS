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

for module_name in ("arbitrage", "borrowing", "dividends", "etfs", "health", "lending", "repayment"):
    try:
        module = __import__(f"routers.{module_name}", fromlist=["router"])
        app.include_router(module.router, prefix="/api")
    except Exception as e:  # noqa: BLE001
        logger.warning("Router '%s' load skipped: %s", module_name, e)
