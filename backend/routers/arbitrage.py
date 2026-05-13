"""종목차익 API.

주식선물 마스터는 Finance_Data 측 daily_update가 매일 새벽 5:30 KST에
`data/futures_master.json` 으로 export. LENS는 read-only로 읽기만 함.
"""
from fastapi import APIRouter, HTTPException

from services.futures_master import ensure_master

router = APIRouter(prefix="/arbitrage", tags=["arbitrage"])


@router.get("/master")
async def get_master():
    """주식선물 마스터 데이터 조회."""
    try:
        return await ensure_master()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
