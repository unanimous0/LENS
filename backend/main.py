"""LENS API -- unified entry point.

실시간 시세/호가/모드 전환은 Rust 서비스(8200)가 전담한다.
여기서는 파일 분석(대차·상환·대여)과 정적 JSON(마스터) REST만 제공.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import settings
from routers import arbitrage, borrowing, health, lending, repayment


app = FastAPI(title=settings.APP_NAME, debug=settings.DEBUG)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(arbitrage.router, prefix="/api")
app.include_router(borrowing.router, prefix="/api")
app.include_router(health.router, prefix="/api")
app.include_router(lending.router, prefix="/api")
app.include_router(repayment.router, prefix="/api")
