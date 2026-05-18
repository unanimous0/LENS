"""Realtime 영구 sub 목록 조회 — 다중 소스 union.

realtime이 startup polling 시 호출 (backend가 미응답일 때 backend가 늦게 살아나면
realtime이 늦게 받아감). 단방향 회복용 — backend가 라이브로 push도 함께 함.

union = LP 매트릭스 타겟 ∪ 활성 포지션 leg.
"""
from __future__ import annotations

from fastapi import APIRouter

from services.permanent_sub import compute_lp_target_codes, compute_position_codes

router = APIRouter(prefix="/permanent-codes", tags=["permanent-codes"])


@router.get("")
async def get_permanent_codes() -> dict:
    """realtime이 startup polling으로 호출. backend가 push 실패해도 realtime이 회복할 수 있게.

    응답: {codes, lp_count, position_count, total}
    """
    lp = await compute_lp_target_codes()
    pos = await compute_position_codes()
    union = sorted(lp | pos)
    return {
        "codes": union,
        "lp_count": len(lp),
        "position_count": len(pos),
        "total": len(union),
    }
