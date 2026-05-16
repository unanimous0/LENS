"""ETF 마스터 + PDF(구성종목) API.

데이터 소스: Finance_Data DB (`korea_stock_data`)
- `etf_master_daily`: ETF 마스터 (creation_unit, kr_company, underlying_index 등)
- `etf_portfolio_daily`: ETF 구성종목 (shares + is_cash)
- 매일 새벽 5:30 KST 인포맥스 API로 적재, 5일 슬라이딩 윈도우 (FIFO)

캐싱: 60초 TTL. 동시 요청 시 락으로 중복 fetch 방지.
종목코드는 'A' 접두 제거하여 6자리로 정규화 (futures_master와 통일).
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from core.database import korea_async_session

router = APIRouter(prefix="/etfs", tags=["etfs"])

CACHE_TTL_SEC = 60.0

# 자체 NAV/fNAV 산출 불가 ETF 키워드 (종목명 기준).
# 레버리지/인버스/선물형/커버드콜: PDF에 지수선물·스왑 들어가 일중 평가 불가.
# 채권/혼합/통화/원자재/부동산: 종목명에 그룹 키워드가 보통 들어감.
_NON_ARBITRABLE_NAME_KEYWORDS = (
    "레버리지", "인버스", "2X", "2x", "3X", "3x", "선물", "커버드콜",
    "채권", "회사채", "국고채", "국채", "단기채", "장기채", "물가채", "신용채",
    "혼합", "원자재", "통화", "부동산", "리츠", "금현물", "은현물", "WTI", "원유",
    "달러", "엔화", "위안", "Dollar", "Yen", "Yuan",
)


def _is_arbitrable(name: Optional[str], tracking_multiple: Optional[str], replication: Optional[str]) -> bool:
    """ETF가 'PDF 현물 바스켓 vs 개별주식선물' 차익 거래 대상인지.
    False면 fNAV/실집행/차익BP 컬럼 의미 없음 → 프론트에서 흐림 처리.
    """
    if tracking_multiple and "일반" not in str(tracking_multiple):
        return False  # 2X 레버리지 / 인버스 등
    if replication and "실물" not in str(replication):
        return False  # 합성 ETF
    n = name or ""
    if any(k in n for k in _NON_ARBITRABLE_NAME_KEYWORDS):
        return False
    return True


class _Cache:
    fetched_at: float = 0.0
    etfs: dict[str, dict] = {}        # code → {name, cu_unit, arbitrable}
    pdfs: dict[str, dict] = {}        # code → {as_of, stocks: [...], cash}
    snapshot_date: Optional[str] = None
    loaded_at: Optional[str] = None


_cache = _Cache()
_load_lock = asyncio.Lock()


def _norm_code(code) -> str:
    """'A000370' → '000370', '000370' → '000370'. None은 빈 문자열."""
    if code is None:
        return ""
    s = str(code).strip().upper()
    if len(s) == 7 and s.startswith("A"):
        return s[1:]
    return s


async def _ensure_loaded() -> None:
    """캐시 만료 시 Finance_Data DB에서 최신 snapshot 일괄 로드."""
    if time.monotonic() - _cache.fetched_at < CACHE_TTL_SEC and _cache.etfs:
        return
    async with _load_lock:
        # 락 획득 후 다시 검사 — 다른 코루틴이 채웠을 수 있음
        if time.monotonic() - _cache.fetched_at < CACHE_TTL_SEC and _cache.etfs:
            return
        try:
            await _load_from_db()
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"Finance_Data DB 로드 실패: {e}")


async def _load_from_db() -> None:
    """각 테이블의 최신 snapshot_date 기준으로 마스터/PDF 일괄 fetch.
    LATERAL 조인 대신 max(snapshot_date) 한 번 + 그 날짜로 필터링 (간단·빠름).
    """
    async with korea_async_session() as session:
        # 마스터/PDF는 Finance_Data 적재 타이밍이 어긋날 수 있어 (예: 마스터 5/16,
        # PDF 5/15) 각 테이블의 MAX(snapshot_date)를 독립 조회. 마스터 날짜로 PDF를
        # 필터링하면 PDF 0 rows가 되어 매트릭스/차익 전체가 공백이 됨.
        master_date = (await session.execute(text(
            "SELECT MAX(snapshot_date) FROM etf_master_daily"
        ))).scalar()
        if master_date is None:
            raise RuntimeError("etf_master_daily에 데이터 없음")
        pdf_date = (await session.execute(text(
            "SELECT MAX(snapshot_date) FROM etf_portfolio_daily"
        ))).scalar()
        if pdf_date is None:
            raise RuntimeError("etf_portfolio_daily에 데이터 없음")

        # 마스터
        master_rows = (await session.execute(text(
            "SELECT etf_code, kr_name, creation_unit, tracking_multiple, replication "
            "FROM etf_master_daily WHERE snapshot_date = :d"
        ), {"d": master_date})).all()

        # PDF (현금 + 종목 모두) — PDF 자체 최신 날짜 사용
        pdf_rows = (await session.execute(text(
            "SELECT etf_code, component_code, component_name, shares, is_cash "
            "FROM etf_portfolio_daily WHERE snapshot_date = :d"
        ), {"d": pdf_date})).all()

    # 마스터 dict
    etfs: dict[str, dict] = {}
    for r in master_rows:
        code = _norm_code(r.etf_code)
        if not code:
            continue
        etfs[code] = {
            "code": code,
            "name": r.kr_name or "",
            "cu_unit": r.creation_unit,
            "arbitrable": _is_arbitrable(r.kr_name, r.tracking_multiple, r.replication),
        }

    # PDF dict: 종목은 stocks 배열, 현금은 cash 필드 (음수 가능)
    # as_of/snapshot_date는 PDF 기준 (fair value 계산의 핵심이 PDF라서).
    pdfs: dict[str, dict] = {}
    snap_iso = pdf_date.isoformat() if pdf_date else None
    for r in pdf_rows:
        etf_code = _norm_code(r.etf_code)
        if not etf_code:
            continue
        bucket = pdfs.setdefault(etf_code, {"as_of": snap_iso, "stocks": [], "cash": 0})
        if r.is_cash:
            bucket["cash"] = int(r.shares or 0)
            continue
        bucket["stocks"].append({
            "code": _norm_code(r.component_code),
            "name": (r.component_name or "").strip(),
            "qty": int(r.shares or 0),
        })

    _cache.etfs = etfs
    _cache.pdfs = pdfs
    _cache.snapshot_date = snap_iso
    _cache.fetched_at = time.monotonic()
    _cache.loaded_at = snap_iso


@router.get("")
async def list_etfs():
    """ETF 마스터 목록."""
    await _ensure_loaded()
    items = sorted(_cache.etfs.values(), key=lambda d: d["code"])
    return {
        "loaded_at": _cache.loaded_at,
        "count": len(items),
        "items": items,
    }


@router.get("/pdf-all")
async def get_all_pdfs():
    """모든 ETF의 PDF를 한 번에. 스크리너 페이지가 1회 fetch로 다 받음."""
    await _ensure_loaded()
    out = {}
    for code, pdf in _cache.pdfs.items():
        meta = _cache.etfs.get(code, {})
        out[code] = {
            "code": code,
            "name": meta.get("name"),
            "cu_unit": meta.get("cu_unit"),
            "arbitrable": meta.get("arbitrable", True),
            "as_of": pdf["as_of"],
            "cash": pdf["cash"],
            "stocks": pdf["stocks"],
        }
    return {
        "loaded_at": _cache.loaded_at,
        "count": len(out),
        "items": out,
    }


@router.get("/{code}/pdf")
async def get_etf_pdf(code: str):
    """ETF PDF 구성종목."""
    await _ensure_loaded()
    norm = _norm_code(code)
    pdf = _cache.pdfs.get(norm)
    if not pdf:
        raise HTTPException(status_code=404, detail=f"PDF 없음: {code}")
    meta = _cache.etfs.get(norm, {})
    return {
        "code": norm,
        "name": meta.get("name"),
        "cu_unit": meta.get("cu_unit"),
        "arbitrable": meta.get("arbitrable", True),
        "as_of": pdf["as_of"],
        "cash": pdf["cash"],
        "stocks": pdf["stocks"],
    }
