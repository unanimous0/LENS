"""포지션 CRUD API.

엔드포인트:
  GET    /api/positions                  리스트 (?status=open|closed)
  POST   /api/positions                  등록 (+ realtime 영구 sub 동기화)
  GET    /api/positions/:id              상세 (legs + loans 조인)
  DELETE /api/positions/:id              삭제 (CASCADE + 영구 sub 동기화)
  PATCH  /api/positions/:id              note/label
  POST   /api/positions/:id/close        청산 (+ 영구 sub 동기화)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import positions

router = APIRouter(prefix="/positions", tags=["positions"])

logger = logging.getLogger("uvicorn.error")

REALTIME_URL = "http://localhost:8200"

_initialized = False


async def _ensure() -> None:
    global _initialized
    if not _initialized:
        await positions.ensure_schema()
        _initialized = True


async def _sync_realtime() -> None:
    """현재 active 포지션 leg를 realtime의 영구 sub set으로 push.
    실패 시 로그만 — realtime은 다음 호출(다른 포지션 변경)에서 회복.
    """
    try:
        codes = await positions.active_leg_codes()
        async with httpx.AsyncClient(timeout=2.0) as client:
            await client.post(f"{REALTIME_URL}/permanent-stocks", json={"codes": codes})
        logger.info("permanent-stocks synced to realtime: %d codes", len(codes))
    except Exception as e:  # noqa: BLE001
        logger.warning("permanent-stocks sync failed: %s", e)


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


@router.get("/active-leg-codes")
async def get_active_leg_codes() -> dict:
    """활성(open) 포지션의 leg 종목 코드만 반환. realtime startup polling용."""
    await _ensure()
    codes = await positions.active_leg_codes()
    return {"codes": codes}


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
    asyncio.create_task(_sync_realtime())
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
    asyncio.create_task(_sync_realtime())
    return {"deleted": True}


class NoteUpdate(BaseModel):
    note: str | None = None
    label: str | None = None


@router.patch("/{pos_id}")
async def patch_position(pos_id: str, body: NoteUpdate) -> dict:
    """note/label만 부분 업데이트 (PR18). 청산은 별도 endpoint."""
    await _ensure()
    ok = await positions.update_note(pos_id, body.note, body.label)
    if not ok:
        raise HTTPException(404, f"position not found or no change: {pos_id}")
    detail = await positions.get_one(pos_id)
    if not detail:
        raise HTTPException(404, f"position not found after update: {pos_id}")
    return detail


class LegExit(BaseModel):
    leg_id: int
    exit_price: float = Field(..., gt=0)


class PositionClose(BaseModel):
    legs: list[LegExit] = Field(..., min_length=1)
    note: str | None = None


@router.post("/{pos_id}/close")
async def close_position(pos_id: str, body: PositionClose) -> dict:
    """포지션 청산 — leg별 exit_price 박고 status='closed' 전환.
    미종료 대여(position_loans)도 ended_at = now로 종료.
    """
    await _ensure()
    leg_exits = {it.leg_id: it.exit_price for it in body.legs}
    err = await positions.close(pos_id, leg_exits, body.note)
    if err:
        raise HTTPException(400, err)
    detail = await positions.get_one(pos_id)
    if not detail:
        raise HTTPException(500, "closed but not retrievable")
    asyncio.create_task(_sync_realtime())
    return detail
