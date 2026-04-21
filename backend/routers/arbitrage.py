"""종목차익 API"""
from fastapi import APIRouter, HTTPException
from services.futures_master import ensure_master, fetch_and_save_master, load_master

router = APIRouter(prefix="/arbitrage", tags=["arbitrage"])


@router.get("/master")
async def get_master():
    """주식선물 마스터 데이터 조회.
    파일이 있으면 반환, 만기 지났으면 자동 갱신 시도."""
    try:
        master = await ensure_master()
        return master
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.post("/master/refresh")
async def refresh_master():
    """마스터 데이터 강제 갱신 (LS API 호출)."""
    try:
        master = await fetch_and_save_master()
        return {"status": "ok", "count": master["count"], "updated": master["updated"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


