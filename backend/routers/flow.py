"""수급(외국인/기관) 랭킹 API — 지표 정의는 services/flow_metrics.py 한 곳뿐.

라우터는 얇은 소비자: as_of 결정 → 정본 조회 → 프리셋 필터 → 뱃지 부착.
프론트는 지표를 절대 재계산하지 않는다 (포맷팅만).
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from services import flow_metrics as fm

router = APIRouter(prefix="/flow", tags=["flow"])


@router.get("/ai-summary/{code}")
async def flow_ai_summary(code: str) -> dict:
    """AI 수급 요약 (프로토타입, 외부망 전용).

    사실(facts)은 전부 코드가 계산(flow_metrics 정본)하고 LLM엔 숫자 해석만 맡긴다.
    키 없으면(내부망) available:false 로 graceful degrade. 데이터버전 캐시로 재호출 억제.
    """
    from services import flow_ai

    return await flow_ai.summarize(code)

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

    # 판정(verdict) = 백테스트가 측정한 태그별 초과수익 조회. edge는 요청당 1회 로드.
    from services import flow_ai, flow_verdict
    edges, edges_as_of = flow_ai._load_edges()

    out = []
    for r in rows:
        item = {k: v for k, v in r.items() if not k.startswith("_")}
        item["is_new"] = r["code"] in new_codes
        # 전체 멤버십 목록 (배타 체인 순서, 유의성 미달 포함) — 프론트 태그·판정 통합 열의
        # 뱃지 정본. 프론트 미러링 금지(공식 2벌 방지) — 여기 한 벌만.
        item["patterns"] = flow_verdict.applicable_patterns(r)
        item["verdict"] = flow_verdict.verdict(r, edges)
        out.append(item)
    return {
        "as_of": info.as_of,
        "is_partial": info.is_partial,
        "preset": preset,
        "count": len(out),
        "edges_as_of": edges_as_of,  # 검증 기준일 (flow_backtest.json generated_at, 없으면 None)
        "edges": edges,  # 태그 범례용: {패턴명: {edge, t, direction}} — 측정값 조회 (튜닝 없음)
        "rows": out,
    }


@router.get("/backtest-report")
async def flow_backtest_report() -> dict:
    """수급 태그 백테스트 검증 리포트 원본 — 화면 '검증 근거' 패널용 열람 전용.

    data/flow_backtest.json(주기 갱신본)을 그대로 반환 + available:true. 파일 부재/파싱 실패면
    available:false (404 아님 — 내부망 첫 배포는 JSON 없이 시작, 프론트가 안내 문구로 degrade).
    경로는 flow_ai._BACKTEST_PATH 재사용(중복 상수 금지). 파일이 작아 매 요청 read 무방.
    """
    from services import flow_ai

    try:
        path = flow_ai._BACKTEST_PATH
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return {"available": True, **data}
    except Exception:  # noqa: BLE001 — 손상/부재 시 available:false로 degrade
        pass
    return {"available": False}


@router.get("/stocks/{code}")
async def flow_stock_series(code: str, days: int = 365) -> dict:
    """종목 상세 시계열 — 일별 외인/기관 순매수(억) + 누적 + 수정종가. 최대 3년."""
    days = max(30, min(days, 1100))
    info = await fm.resolve_as_of()
    rows = await fm.series(code, info.as_of, days)
    if not rows:
        raise HTTPException(404, f"no flow data for {code}")
    return {"code": code, "as_of": info.as_of, "days": days, "rows": rows}


@router.get("/episodes/{code}")
async def flow_episodes(code: str) -> dict:
    """종목 태그 에피소드 히스토리 — 과거 각 태그 onset + 이후 20/60/120거래일 초과수익.

    판정은 flow_verdict 정본 재호출(공식 1벌 — 화면 태그와 바이트 일치), 성과는 look-ahead
    차단(onset D+1 시가 진입) + universe_index 벤치 대비. 데이터 없으면 404(/stocks 관례)."""
    from services import flow_episodes as fe
    from services.stock_code import normalize_stock_code

    result = await fe.episodes(normalize_stock_code(code) or code)
    if result is None:
        raise HTTPException(404, f"no flow data for {code}")
    return result
