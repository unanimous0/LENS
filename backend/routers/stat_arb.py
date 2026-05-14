"""stat-arb-engine (port 8300) 의 단순 proxy.

frontend가 8300에 직접 가는 대신 backend(/api/stat-arb/...) 거치게 해서:
  - 동일 origin (8100) 으로 통일
  - 단일 CORS 정책
  - 향후 인증/캐싱/레이트리밋 hook 자리

stat-arb-engine이 안 떠있으면 503.
"""
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/stat-arb", tags=["stat-arb"])

STATARB_BASE = "http://localhost:8300"
TIMEOUT = httpx.Timeout(10.0, connect=2.0)


async def _proxy_get(path: str, params: dict[str, Any]) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        try:
            r = await client.get(f"{STATARB_BASE}{path}", params=params)
        except httpx.HTTPError as e:
            raise HTTPException(503, f"stat-arb-engine unavailable: {e}") from e
        if r.status_code >= 400:
            raise HTTPException(r.status_code, r.text)
        return r.json()


@router.get("/pairs")
async def list_pairs(
    limit: int = Query(100, ge=0, le=10000),
    group: Optional[str] = None,
) -> dict:
    params: dict[str, Any] = {"limit": limit}
    if group:
        params["group"] = group
    return await _proxy_get("/pairs", params)


@router.get("/pairs/detail")
async def pair_detail(left: str, right: str) -> dict:
    return await _proxy_get("/pairs/detail", {"left": left, "right": right})


@router.get("/groups")
async def list_groups(
    kind: Optional[str] = None,
    with_members: bool = False,
) -> dict:
    params: dict[str, Any] = {"with_members": str(with_members).lower()}
    if kind:
        params["kind"] = kind
    return await _proxy_get("/groups", params)


@router.get("/health")
async def health() -> dict:
    return await _proxy_get("/health", {})


@router.get("/debug/stats")
async def debug_stats() -> dict:
    return await _proxy_get("/debug/stats", {})
