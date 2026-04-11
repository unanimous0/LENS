"""Market data REST endpoints"""
from fastapi import APIRouter

from core.data.adapter import NetworkMode
from core.data.mock_adapter import MOCK_ETFS

router = APIRouter(tags=["market"])


@router.get("/network/mode")
async def get_network_mode():
    from core.app_state import app_state
    return {"mode": app_state.network_mode.value}


@router.post("/network/mode/{mode}")
async def set_network_mode(mode: NetworkMode):
    from core.app_state import app_state
    from routers.ws import broadcast
    await app_state.switch_network(mode, broadcast)
    return {"mode": app_state.network_mode.value}


@router.get("/etf/list")
async def get_etf_list():
    return {"etfs": MOCK_ETFS}


@router.get("/basis/{futures_code}")
async def get_basis(futures_code: str):
    from core.app_state import app_state
    basis = await app_state.adapter.get_basis(futures_code)
    return basis.model_dump()
