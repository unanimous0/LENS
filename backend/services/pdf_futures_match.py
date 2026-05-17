"""PDF 구성종목 ∩ 주식선물 마스터 교집합 매핑.

각 ETF의 PDF 구성종목 중 주식선물이 상장된 종목을 찾아, 그 종목의 front month 선물 코드 반환.

- PDF 출처: `routers.etfs._cache.pdfs` (Finance_Data DB, 60s 캐시)
- 주식선물 마스터: `data/futures_master.json` (KOSPI 191 + KOSDAQ 59 = 250종목)
- 종목코드 비교는 6자리 정규화 후 (`_norm_code`로 'A' 접두 제거)

주식선물 마스터 갱신 (롤오버 후 수동 갱신) — 첫 빌드 후순위.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

from routers.etfs import _cache as etf_cache, _ensure_loaded, _norm_code

FUTURES_MASTER_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "futures_master.json"

CACHE_TTL_SEC = 60.0


class _MasterCache:
    loaded_at: float = 0.0
    front_month: Optional[str] = None
    back_month: Optional[str] = None
    # base_stock_code(6자리) → {futures_code, multiplier, expiry}
    stock_to_front: dict[str, dict] = {}


_master = _MasterCache()


def _load_master() -> None:
    if time.monotonic() - _master.loaded_at < CACHE_TTL_SEC and _master.stock_to_front:
        return
    with FUTURES_MASTER_PATH.open() as f:
        master = json.load(f)
    mapping: dict[str, dict] = {}
    for item in master.get("items", []):
        base = _norm_code(item.get("base_code"))
        if not base:
            continue
        front = item.get("front") or {}
        code = front.get("code")
        if not code:
            continue
        mapping[base] = {
            "futures_code": code,
            "multiplier": float(front.get("multiplier") or 1.0),
            "expiry": front.get("expiry"),
            "base_name": item.get("base_name"),
            "market": item.get("market"),
        }
    _master.stock_to_front = mapping
    _master.front_month = master.get("front_month")
    _master.back_month = master.get("back_month")
    _master.loaded_at = time.monotonic()


async def get_intersect_for_etf(etf_code: str) -> Optional[dict]:
    """ETF PDF ∩ 주식선물 교집합.

    반환:
    {
      "etf_code": "229200",
      "front_month": "202605",
      "intersect": [{stock_code, name, qty, futures_code, multiplier, expiry}, ...],
      "non_intersect_stocks": [{stock_code, name, qty}, ...],  # 선물 없는 종목 (현물로 헤지)
      "intersect_weight_pct": 0~100,  # 교집합이 PDF 비중에서 차지하는 비율 (수량 가중)
    }

    PDF 없으면 None.
    """
    await _ensure_loaded()
    _load_master()

    norm = _norm_code(etf_code)
    pdf = etf_cache.pdfs.get(norm)
    if not pdf:
        return None

    intersect: list[dict] = []
    non_intersect: list[dict] = []
    total_qty = 0
    covered_qty = 0

    for stock in pdf["stocks"]:
        sc = stock["code"]
        qty = int(stock.get("qty") or 0)
        total_qty += qty
        m = _master.stock_to_front.get(sc)
        if m:
            covered_qty += qty
            intersect.append({
                "stock_code": sc,
                "name": stock["name"],
                "qty": qty,
                "futures_code": m["futures_code"],
                "multiplier": m["multiplier"],
                "expiry": m["expiry"],
                "market": m.get("market"),
            })
        else:
            # 필드명 'code'로 통일 — PdfStock(code) 형태 그대로 재사용 가능
            non_intersect.append({
                "code": sc,
                "name": stock["name"],
                "qty": qty,
            })

    return {
        "etf_code": norm,
        "front_month": _master.front_month,
        "back_month": _master.back_month,
        "intersect": intersect,
        "non_intersect_stocks": non_intersect,
        "intersect_count": len(intersect),
        "non_intersect_count": len(non_intersect),
        "intersect_weight_pct": round(100.0 * covered_qty / total_qty, 2) if total_qty else 0.0,
    }
