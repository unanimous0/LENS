"""포지션 CRUD API (PR16 범위).

엔드포인트:
  GET    /api/positions                  리스트 (?status=open|closed)
  POST   /api/positions                  등록
  GET    /api/positions/:id              상세 (legs + loans 조인)
  DELETE /api/positions/:id              삭제 (CASCADE)

* /close, /timeline 은 Phase 5 후속 PR (PR18/19)에서 추가.
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import positions

router = APIRouter(prefix="/positions", tags=["positions"])

_initialized = False


async def _ensure() -> None:
    global _initialized
    if not _initialized:
        await positions.ensure_schema()
        _initialized = True


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class LegLoanIn(BaseModel):
    qty: int = Field(..., gt=0)
    rate_pct: float = Field(..., ge=0, le=1000)


class LegIn(BaseModel):
    asset_type: Literal["S", "E", "I", "F"]
    code: str
    side: Literal[1, -1]
    weight: float
    qty: int = Field(..., gt=0)
    entry_price: float = Field(..., gt=0)
    loan: LegLoanIn | None = None


class PositionCreate(BaseModel):
    label: str | None = None
    note: str | None = None
    left_key: str
    right_key: str
    entry_z: float | None = None
    entry_stats: dict | None = None  # 진입 시점 통계량 freeze
    legs: list[LegIn] = Field(..., min_length=2)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_positions(status: str | None = None) -> dict:
    await _ensure()
    if status and status not in ("open", "closed"):
        raise HTTPException(400, f"invalid status: {status}")
    items = await positions.list_positions(status)
    return {"count": len(items), "items": items}


@router.post("")
async def create_position(body: PositionCreate) -> dict:
    await _ensure()
    payload = body.model_dump()
    errors = positions.validate_payload(payload)
    if errors:
        raise HTTPException(400, {"errors": errors})
    pos_id = await positions.create(payload)
    detail = await positions.get_one(pos_id)
    if detail is None:
        raise HTTPException(500, "created but not retrievable")
    return detail


@router.get("/{pos_id}")
async def get_position(pos_id: str) -> dict:
    await _ensure()
    item = await positions.get_one(pos_id)
    if not item:
        raise HTTPException(404, f"position not found: {pos_id}")
    return item


@router.delete("/{pos_id}")
async def delete_position(pos_id: str) -> dict:
    await _ensure()
    ok = await positions.delete(pos_id)
    if not ok:
        raise HTTPException(404, f"position not found: {pos_id}")
    return {"deleted": True}


class NoteUpdate(BaseModel):
    note: str | None = None
    label: str | None = None


@router.patch("/{pos_id}")
async def patch_position(pos_id: str, body: NoteUpdate) -> dict:
    """note/label만 부분 업데이트 (PR18). 청산은 PR19에서 별도 endpoint."""
    await _ensure()
    ok = await positions.update_note(pos_id, body.note, body.label)
    if not ok:
        raise HTTPException(404, f"position not found or no change: {pos_id}")
    detail = await positions.get_one(pos_id)
    if not detail:
        raise HTTPException(404, f"position not found after update: {pos_id}")
    return detail
