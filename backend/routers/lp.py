"""LP 시그널 데스크 API.

- `GET /api/lp/matrix-config` : Rust 실시간 서비스가 startup에 1회 fetch. 북 정의 + ETF 마스터/PDF + 각 ETF의 헤지 경로 매핑 + Level 3 cost params.
- `GET/POST /api/lp/positions` : 사용자 수동 포지션 입력 (JSON 파일 r/w). 가상 북 OK.
- `GET/POST /api/lp/cost-inputs` : Level 3 입력값 (거래세 / 회사금리 / 슬리피지 / hold_days).

저장 파일은 `data/lp_positions.json`, `data/lp_cost_inputs.json` — gitignore.

cost-inputs default (사용자 합의, 2026-05-12):
- 거래세 0.20% (매도 측만), 회사금리 2.8% (캐리·이론가 베이스),
- 슬리피지 0% (사용자 UI 입력), hold_days 1일 (헤지 회전 가정).
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from routers.etfs import _cache as etf_cache, _ensure_loaded, _norm_code
from services.pdf_futures_match import get_intersect_for_etf
from services.risk_estimator import get_risk_params

router = APIRouter(prefix="/lp", tags=["lp"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
POSITIONS_PATH = DATA_DIR / "lp_positions.json"
COST_INPUTS_PATH = DATA_DIR / "lp_cost_inputs.json"

# 첫 빌드 ETF 2개 (6자리 정규화 코드)
DEFAULT_ETF_CODES = ["229200", "396500"]

DEFAULT_COST_INPUTS = {
    "tax_sell_bp": 20.0,
    "base_rate_annual": 0.028,
    "slippage_bp": 0.0,
    "hold_days": 1,
}


class CostInputs(BaseModel):
    tax_sell_bp: float = Field(20.0, description="거래세 (매도 측, bp). 기본 0.20% = 20bp")
    base_rate_annual: float = Field(0.028, description="회사금리 (연, 소수). 기본 2.8% = 0.028")
    slippage_bp: float = Field(0.0, description="슬리피지 (bp). 사용자 입력, 기본 0")
    hold_days: int = Field(1, description="헤지 회전 가정 (일). 캐리 일할 계산용")


class PositionsPayload(BaseModel):
    positions: dict[str, int] = Field(
        default_factory=dict,
        description="코드(6자리, ETF/주식/선물) → 부호있는 수량 (롱=+, 숏=-)",
    )


def _read_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        with path.open() as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@router.get("/matrix-config")
async def get_matrix_config():
    """Rust startup이 한 번 fetch. 첫 빌드의 모든 정적 입력을 한 번에."""
    await _ensure_loaded()
    cost_inputs = _read_json(COST_INPUTS_PATH, DEFAULT_COST_INPUTS)

    per_etf: dict[str, dict] = {}
    for code in DEFAULT_ETF_CODES:
        pdf = etf_cache.pdfs.get(code)
        meta = etf_cache.etfs.get(code, {})
        if not pdf:
            # ETF 마스터/PDF 없음 — 다음 fetch 때 채워질 것
            continue
        intersect = await get_intersect_for_etf(code)
        per_etf[code] = {
            "code": code,
            "name": meta.get("name"),
            "cu_unit": meta.get("cu_unit"),
            "arbitrable": meta.get("arbitrable", True),
            "pdf": {
                "as_of": pdf["as_of"],
                "stocks": pdf["stocks"],
                "cash": pdf["cash"],
            },
            "intersect": intersect,
            # 다음 빌드 wire 자리 — Rust enum에는 정의되어 있으나 첫 빌드 미운영
            "pending_routes": ["index_futures", "correlated_etf", "beta_hedge"],
        }

    return {
        "book": {
            "etf_codes": DEFAULT_ETF_CODES,
            "cost_inputs": cost_inputs,
        },
        "per_etf": per_etf,
        "loaded_at": etf_cache.loaded_at,
    }


@router.get("/positions")
async def get_positions():
    """현재 포지션. 파일 없으면 빈 dict."""
    return _read_json(POSITIONS_PATH, {"positions": {}, "updated_at": None})


@router.post("/positions")
async def set_positions(payload: PositionsPayload):
    """포지션 갱신. 부호있는 수량(롱=+, 숏=-). 빈 dict 전달 = 전체 클리어."""
    data = {
        "positions": payload.positions,
        "updated_at": datetime.now().isoformat(),
    }
    _write_json(POSITIONS_PATH, data)
    return data


@router.get("/cost-inputs")
async def get_cost_inputs():
    """Level 3 cost params 조회."""
    return _read_json(COST_INPUTS_PATH, DEFAULT_COST_INPUTS)


@router.post("/cost-inputs")
async def set_cost_inputs(payload: CostInputs):
    """Level 3 cost params 갱신 (슬리피지/hold_days는 UI에서 자주, 거래세/금리는 거의 안 바뀜)."""
    data = payload.model_dump()
    _write_json(COST_INPUTS_PATH, data)
    return data


@router.get("/risk-params")
async def get_risk_params_route(refresh: bool = False):
    """LP 북 리스크 파라미터: 베타 + 잔차 σ + 잔차 공분산 + 섹터 매핑.

    - 시장 변수: KOSPI200 (K2G01P). 60일 OLS 회귀.
    - 대상: DEFAULT_ETF_CODES + 각 PDF 구성종목 union (~160종목).
    - 잔차 공분산: Ledoit-Wolf shrinkage (대각 타겟).
    - 캐시: 24h. `?refresh=true`로 강제 재산출.

    Rust 실시간 서비스가 startup에 1회 fetch (Task #4).
    """
    return await get_risk_params(force_refresh=refresh)
