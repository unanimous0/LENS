"""수급(외국인/기관) 랭킹 API — 지표 정의는 services/flow_metrics.py 한 곳뿐.

라우터는 얇은 소비자: as_of 결정 → 정본 조회 → 프리셋 필터 → 뱃지 부착.
프론트는 지표를 절대 재계산하지 않는다 (포맷팅만).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from services import flow_metrics as fm

router = APIRouter(prefix="/flow", tags=["flow"])

# NEW 뱃지 비교 대상: 정렬 상위 N (전일 상위 N에 없던 종목만 NEW)
_TOP_N_FOR_NEW = 50


@router.get("/meta")
async def flow_meta() -> dict:
    info = await fm.resolve_as_of()
    version = await fm.data_version()
    return {
        "as_of": info.as_of,
        "latest": info.latest,
        "is_partial": info.is_partial,
        "score_version": fm.SCORE_VERSION,
        "windows": list(fm.WINDOWS),
        "presets": {k: v for k, v in fm.PRESETS.items()},
        "sort_key": "f_20d_bp",
        "data_version": {"max_date": version[0], "rows": version[1]},
        "convention": "D일 수급은 D일 장 마감 후 확정 — D 신호는 D+1 시가부터 실행 가능",
    }


@router.get("/ranking")
async def flow_ranking(preset: str = "default") -> dict:
    if preset not in fm.PRESETS:
        raise HTTPException(400, f"unknown preset: {preset} (use {list(fm.PRESETS)})")
    info = await fm.resolve_as_of()
    rows = fm.apply_preset(await fm.ranking(info.as_of), preset)
    rows.sort(key=lambda r: r["f_20d_bp"], reverse=True)

    # NEW 뱃지: 전 거래일 같은 프리셋 상위 N에 없던 종목
    new_codes: set[str] = set()
    if info.prev:
        prev_rows = fm.apply_preset(await fm.ranking(info.prev), preset)
        prev_rows.sort(key=lambda r: r["f_20d_bp"], reverse=True)
        prev_top = {r["code"] for r in prev_rows[:_TOP_N_FOR_NEW]}
        new_codes = {r["code"] for r in rows[:_TOP_N_FOR_NEW]} - prev_top

    out = []
    for r in rows:
        item = {k: v for k, v in r.items() if not k.startswith("_")}
        item["is_new"] = r["code"] in new_codes
        out.append(item)
    return {
        "as_of": info.as_of,
        "is_partial": info.is_partial,
        "preset": preset,
        "count": len(out),
        "rows": out,
    }


@router.get("/stocks/{code}")
async def flow_stock_series(code: str, days: int = 365) -> dict:
    """종목 상세 시계열 — 일별 외인/기관 순매수(억) + 누적 + 수정종가. 최대 3년."""
    days = max(30, min(days, 1100))
    info = await fm.resolve_as_of()
    rows = await fm.series(code, info.as_of, days)
    if not rows:
        raise HTTPException(404, f"no flow data for {code}")
    return {"code": code, "as_of": info.as_of, "days": days, "rows": rows}
