"""포지션 CRUD API.

엔드포인트:
  GET    /api/positions                  리스트 (?status=open|closed)
  POST   /api/positions                  등록 (+ realtime 영구 sub 동기화)
  GET    /api/positions/:id              상세 (legs + loans 조인)
  DELETE /api/positions/:id              삭제 (CASCADE + 영구 sub 동기화)
  PATCH  /api/positions/:id              note/label
  PUT    /api/positions/:id              기록 수정 (진입일·leg 수량/진입가·라벨/메모, §24.7)
  POST   /api/positions/:id/close        청산 (+ 영구 sub 동기화)
  POST   /api/positions/estimate-entry-band  진입일 기준 밴드 재계산 (§24.8)
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import entry_band, positions
from services.permanent_sub import schedule_sync

router = APIRouter(prefix="/positions", tags=["positions"])

logger = logging.getLogger("uvicorn.error")

_initialized = False


async def _ensure() -> None:
    global _initialized
    if not _initialized:
        await positions.ensure_schema()
        _initialized = True


# 포지션 변경 핸들러는 schedule_sync()로 fire-and-forget 발사.
# 실제 union 계산 + retry + task ref 관리는 services.permanent_sub에 위임.


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
    # 진입 시점 통계량 freeze — {alpha, beta, center, scale, basis, half_life, adf, r2}.
    # alpha/beta/center/scale = 고정 z 좌표계 (services/positions.py docstring · §24).
    entry_stats: dict | None = None
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
    """활성(open) 포지션의 leg 종목 코드만 반환. 단독 디버깅용 (deprecated for realtime polling)."""
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
    schedule_sync()
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
    schedule_sync()
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


class LegUpdate(BaseModel):
    leg_id: int
    qty: int | None = Field(None, gt=0)
    entry_price: float | None = Field(None, gt=0)


class EntryBandIn(BaseModel):
    """진입일 기준으로 재계산한 밴드 (§24.8) — `POST /estimate-entry-band` 응답 그대로.

    보내면 entry_stats의 α₀·β₀·μ₀·σ₀를 이 값으로 갈아끼우고 entry_z도 같이 재계산한다
    (`mode: refit`). 응답의 `sigma`가 여기 `scale`이다.
    """

    alpha: float
    beta: float
    center: float
    scale: float = Field(..., gt=0)
    basis: str = "1d"
    source: Literal["refit"] = "refit"
    # 추적용 — 어느 날짜·몇 봉으로 뜬 밴드인지. 화면 툴팁·사후 검증에 쓴다.
    asof: str | None = None
    window_bars: int | None = None
    r2: float | None = None
    adf: float | None = None
    half_life: float | None = None


class PositionUpdate(BaseModel):
    """기록 수정 — 보낸 필드만 반영 (exclude_unset). 명시적 null = 지움.

    종목·방향·페어 키는 못 바꾼다 (바꿀 일이면 지우고 다시 등록하는 게 맞다 —
    밴드·대여 기록이 다른 페어의 것이 되어버린다).
    """

    opened_at: int | None = Field(None, gt=0)  # epoch ms
    label: str | None = None
    note: str | None = None
    # 밴드 미저장(구) 기록 전용. 저장 밴드가 있거나 entry_band를 보내면 무시된다.
    entry_z: float | None = None
    # 진입일 기준 재계산 밴드. entry_z보다 우선한다 (밴드가 자, z는 종속변수).
    entry_band: EntryBandIn | None = None
    legs: list[LegUpdate] | None = None


@router.put("/{pos_id}")
async def update_position(pos_id: str, body: PositionUpdate) -> dict:
    """포지션 기록 수정 (덮어쓰기, 이력 없음).

    진입가를 고치면 entry_z 정합을 서버가 맞춘다 — 결과는 응답 `entry_z_update`에 담아
    화면이 무슨 일이 일어났는지(재계산/입력값 사용/무시) 보여줄 수 있게 한다.
    """
    await _ensure()
    patch = body.model_dump(exclude_unset=True)
    if not patch:
        raise HTTPException(400, "no fields to update")
    if "opened_at" in patch and patch["opened_at"] is None:
        raise HTTPException(400, "opened_at cannot be null")
    # entry_band는 기본값(basis·source)까지 채워서 넘긴다 — exclude_unset이 중첩 모델에도
    # 전파돼 안 보낸 필드가 통째로 빠지면 밴드 출처 마커가 사라진다.
    if body.entry_band is not None:
        patch["entry_band"] = body.entry_band.model_dump()
    err, meta = await positions.update(pos_id, patch)
    if err:
        raise HTTPException(404 if "not found" in err else 400, err)
    detail = await positions.get_one(pos_id)
    if not detail:
        raise HTTPException(500, "updated but not retrievable")
    detail["entry_z_update"] = meta["entry_z"]
    return detail


class EntryBandRequest(BaseModel):
    """진입일·진입가만으로 그날의 밴드를 되살린다 (§24.8).

    가격은 회귀에 안 들어가고 z 계산에만 쓰인다 — left/right는 **포지션의 페어 키 방향**
    그대로여야 부호가 화면(고정 z)과 맞는다.
    """

    left_key: str
    right_key: str
    entry_date: date
    left_price: float = Field(..., gt=0)
    right_price: float = Field(..., gt=0)


@router.post("/estimate-entry-band")
async def estimate_entry_band(body: EntryBandRequest) -> dict:
    """진입 시점 밴드 재계산 — 엔진과 같은 자(일봉 레벨 OLS)로 되짚는다.

    엔진은 최신 사이클 통계만 들고 있어 과거 밴드를 못 준다. 대신 재료(Finance_Data 일봉)가
    남아 있으므로 진입일 이전 창만으로 다시 회귀하면 그날의 α·β·μ·σ가 복원된다.
    표본 부족·미지원 자산군은 422 + 사유 (services/entry_band.py).
    """
    try:
        return await entry_band.estimate(
            body.left_key,
            body.right_key,
            body.entry_date,
            body.left_price,
            body.right_price,
        )
    except entry_band.RefitError as e:
        raise HTTPException(422, str(e)) from e


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
    schedule_sync()
    return detail
