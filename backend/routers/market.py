"""Market data REST endpoints.

실시간 모드 전환과 베이시스 스트림은 Rust 서비스(8200)가 소유한다.
프론트가 호출하던 레거시 /network/mode, /basis 엔드포인트는 제거됨.
"""
from fastapi import APIRouter

from core.data.mock_adapter import MOCK_ETFS

router = APIRouter(tags=["market"])


@router.get("/etf/list")
async def get_etf_list():
    return {"etfs": MOCK_ETFS}
