"""대여요율 CRUD + CSV import API.

저장소: backend/data/lens.db (SQLite). 사용자 수동 입력 영속화.
종목코드는 services.stock_code.normalize_stock_code 통과 (6자리 정규화).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel, Field

from services import loan_rates

router = APIRouter(prefix="/loan-rates", tags=["loan-rates"])


# 시작 시 1회 — 라우터 로드 자체는 동기, schema 보장만.
async def _bootstrap():
    await loan_rates.ensure_schema()


# include_router 시 호출 안 함. 첫 요청에서 ensure_schema 호출.
_initialized = False


async def _ensure() -> None:
    global _initialized
    if not _initialized:
        await loan_rates.ensure_schema()
        _initialized = True


class LoanRateIn(BaseModel):
    rate_pct: float = Field(..., ge=0, le=1000)
    source: str = Field("manual", max_length=20)


class LoanRateRow(BaseModel):
    code: str
    rate_pct: float
    source: str
    updated_at: int


class BulkItem(BaseModel):
    code: str
    rate_pct: float = Field(..., ge=0, le=1000)
    source: str = Field("manual", max_length=20)


@router.get("")
async def list_loan_rates() -> dict:
    await _ensure()
    rows = await loan_rates.get_all()
    return {"count": len(rows), "items": rows}


@router.put("/{code}")
async def put_loan_rate(code: str, body: LoanRateIn) -> LoanRateRow:
    await _ensure()
    try:
        saved = await loan_rates.put(code, body.rate_pct, body.source)
    except ValueError as e:
        raise HTTPException(400, str(e))
    # source/updated_at 포함 응답 만들기
    rows = await loan_rates.get_all()
    for r in rows:
        if r["code"] == saved["code"]:
            return LoanRateRow(**r)
    # 이론상 unreachable
    raise HTTPException(500, "saved but not found")


@router.post("/bulk")
async def bulk_put(items: list[BulkItem]) -> dict:
    await _ensure()
    inserted = await loan_rates.put_many(
        (it.code, it.rate_pct, it.source) for it in items
    )
    return {"received": inserted}


@router.delete("/{code}")
async def delete_loan_rate(code: str) -> dict:
    await _ensure()
    ok = await loan_rates.delete(code)
    if not ok:
        raise HTTPException(404, f"loan rate not found: {code}")
    return {"deleted": True}


@router.post("/csv-import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """CSV 일괄 업로드. 포맷: code,rate_pct[,source]

    예:
        code,rate_pct
        005930,15.5
        000660,8.2
    """
    await _ensure()
    try:
        content = (await file.read()).decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(400, "CSV must be UTF-8 encoded")
    result = await loan_rates.import_csv(content)
    return result
