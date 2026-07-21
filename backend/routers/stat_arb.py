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
    basis: Optional[str] = None,
    exclude_categories: Optional[str] = None,
    asset_combo: Optional[str] = None,
) -> dict:
    """통계차익 1:1 페어 리스트.

    basis 미지정 시 엔진 기본값 exclude(베이시스형=같은 기초지수 복제 페어 제외).
    basis=only 로 베이시스형만, all 로 전체 조회.
    exclude_categories: 카테고리 태그 CSV(어느 한 leg라도 해당하면 제외).
    asset_combo: etf_etf|etf_stock|stock_stock|any.
    """
    params: dict[str, Any] = {"limit": limit}
    if group:
        params["group"] = group
    if basis:
        params["basis"] = basis
    if exclude_categories:
        params["exclude_categories"] = exclude_categories
    if asset_combo:
        params["asset_combo"] = asset_combo
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


@router.get("/groups/{group_id}/pca")
async def group_pca(group_id: str) -> dict:
    """PR-B: 그룹 한정 Dense PCA 결과. 멤버 < 10이거나 데이터 부족이면 엔진이 404."""
    return await _proxy_get(f"/groups/{group_id}/pca", {})


@router.get("/groups/{group_id}/mn-pair")
async def group_mn_pair(group_id: str) -> dict:
    """PR-C2: 그룹의 M:N 발굴 페어 (Sparse CCA + ADF 통과). 없으면 엔진 404."""
    return await _proxy_get(f"/groups/{group_id}/mn-pair", {})


@router.get("/mn-pairs")
async def list_mn_pairs(
    limit: int = 50,
    kind: Optional[str] = None,
) -> dict:
    """PR-C2: 전체 M:N 페어 score 내림차순. kind=etf/sector/index/etf_category."""
    params: dict[str, Any] = {"limit": limit}
    if kind:
        params["kind"] = kind
    return await _proxy_get("/mn-pairs", params)


@router.get("/health")
async def health() -> dict:
    return await _proxy_get("/health", {})


@router.get("/debug/stats")
async def debug_stats() -> dict:
    return await _proxy_get("/debug/stats", {})
