"""주식 가격 일괄 조회 — ETF PDF 구성종목 rNAV 계산용.

ETF 페이지는 WS 구독 없이 REST 일봉 종가로 rNAV를 근사한다.
(WS 구독을 유지하면 660종목 × 4+개 LS API WS 연결 → 연결 과부하)
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from core.database import korea_async_session

router = APIRouter(prefix="/stocks", tags=["stocks"])


class DailyCloseRequest(BaseModel):
    codes: list[str]


@router.post("/daily-close")
async def get_stocks_daily_close(req: DailyCloseRequest) -> dict:
    """PDF 구성종목 adj_close 일봉 최신값 일괄 조회.

    - 최대 600종목. 초과 시 앞 600개만 처리.
    - adj_close NULL 또는 해당 종목 없으면 응답에서 제외.
    - DISTINCT ON (stock_code) ORDER BY time DESC → 종목별 가장 최근 일봉.

    반환: {"prices": {"005930": 73400.0, "000660": 196000.0, ...}}
    """
    codes = [c for c in req.codes if c][:600]
    if not codes:
        return {"prices": {}}

    async with korea_async_session() as session:
        rows = (await session.execute(
            text("""
                SELECT DISTINCT ON (stock_code) stock_code, adj_close
                FROM ohlcv_daily
                WHERE stock_code = ANY(:codes)
                  AND adj_close IS NOT NULL
                ORDER BY stock_code, time DESC
            """),
            {"codes": codes},
        )).all()

    return {"prices": {r.stock_code: float(r.adj_close) for r in rows}}
