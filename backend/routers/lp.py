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

import logging

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text

from core.database import korea_async_session
from routers.etfs import _cache as etf_cache, _ensure_loaded, _norm_code
from services import ledger_import, lp_ledger
from services.pdf_futures_match import get_intersect_for_etf
from services.risk_estimator import get_risk_params
from services.stock_code import normalize_stock_code

router = APIRouter(prefix="/lp", tags=["lp"])

logger = logging.getLogger("uvicorn.error")

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
POSITIONS_PATH = DATA_DIR / "lp_positions.json"
COST_INPUTS_PATH = DATA_DIR / "lp_cost_inputs.json"
QUOTE_PARAMS_PATH = DATA_DIR / "lp_quote_params.json"
FUTURES_MASTER_PATH = DATA_DIR / "futures_master.json"

# 지수선물 상품 프리픽스 (A + 2자리): KOSPI200=01, 미니K200=05, KOSDAQ150=06.
INDEX_FUT_PREFIXES = {"01", "05", "06"}

# 선물 마스터 캐시 (front/back 8자리 코드 set + code→name + code→base). mtime 기준 갱신.
_fut_codes_cache: set[str] = set()
_fut_names_cache: dict[str, str] = {}
_fut_to_base_cache: dict[str, str] = {}
_fut_master_mtime: float = 0.0

# 첫 빌드 ETF 2개 (6자리 정규화 코드)
DEFAULT_ETF_CODES = ["229200", "396500"]

DEFAULT_COST_INPUTS = {
    "tax_sell_bp": 20.0,
    "base_rate_annual": 0.028,
    "slippage_bp": 0.0,
    "hold_days": 1,
}

# ---------------------------------------------------------------------------
# LP 호가 유니버스 12종 (§13.7 Phase 2 — memory reference_lp_etf_universe)
# ---------------------------------------------------------------------------
# FV_futures 호가 앵커(§13.3-A)를 계산할 대상. PDF 바스켓(2종)과 별개 경로 —
# 필요한 실시간 입력이 ETF 틱 12개 + 지수선물 3개뿐이라 LS 구독 부담 거의 0.
QUOTE_UNIVERSE_CODES = [
    "069500", "122630", "233740", "102110", "091160", "229200",
    "396500", "114800", "252670", "251340", "364980", "0117V0",
]

# 12종 하드코딩 fallback 맵 (정본). etf_master_daily의 tracking_multiple 컬럼은 레버리지/
# 인버스에도 "일반 (1)"로 채워져 있어 (2026-07-07 실측) 배수 도출 불가 → 코드가 정본이다.
# index_family: 'k200' | 'kq150' — r_implied(지수 함축수익률)의 소스 지수 가족.
#   섹터/테마형은 KOSPI200(risk_estimator MARKET_CODE=K2G01P)에 대해 회귀하므로 'k200'.
# leverage: 부호 있는 일일 배수 (+1/+2/-1/-2). 섹터형은 None (fv_mode='beta'로 β 사용).
# fv_mode: 'index' (배수형) | 'beta' (섹터/테마형 — 지수 베타 + 잔차 프리미엄).
# futures_based: 기초지수가 **선물지수**인 ETF — etf_master_daily.underlying_index 실측
#   (2026-07-07): 114800·252670="코스피 200 선물지수", 251340="F-코스닥150 지수". 나머지는
#   현물지수. 두 leg 모두 선물 연동 → 현물-선물 베이시스 노출 ≈ 0 → 베이시스 북(§13.4)
#   지수 베이시스 etf_leg에서만 제외 (가족 델타·헤지 티켓에는 포함 — 델타는 실재).
_QUOTE_UNIVERSE_FALLBACK: dict[str, dict] = {
    # 지수형 (배수)
    "069500": {"name": "KODEX 200", "index_family": "k200", "leverage": 1, "fv_mode": "index"},
    "122630": {"name": "KODEX 레버리지", "index_family": "k200", "leverage": 2, "fv_mode": "index"},
    "233740": {"name": "KODEX 코스닥150레버리지", "index_family": "kq150", "leverage": 2, "fv_mode": "index"},
    "102110": {"name": "TIGER 200", "index_family": "k200", "leverage": 1, "fv_mode": "index"},
    "229200": {"name": "KODEX 코스닥150", "index_family": "kq150", "leverage": 1, "fv_mode": "index"},
    "114800": {"name": "KODEX 인버스", "index_family": "k200", "leverage": -1, "fv_mode": "index", "futures_based": True},
    "252670": {"name": "KODEX 200선물인버스2X", "index_family": "k200", "leverage": -2, "fv_mode": "index", "futures_based": True},
    "251340": {"name": "KODEX 코스닥150선물인버스", "index_family": "kq150", "leverage": -1, "fv_mode": "index", "futures_based": True},
    # 섹터/테마형 (베타)
    "091160": {"name": "KODEX 반도체", "index_family": "k200", "leverage": None, "fv_mode": "beta"},
    "396500": {"name": "TIGER 반도체TOP10", "index_family": "k200", "leverage": None, "fv_mode": "beta"},
    "364980": {"name": "TIGER 2차전지TOP10", "index_family": "k200", "leverage": None, "fv_mode": "beta"},
    "0117V0": {"name": "TIGER 코리아AI전력기기TOP3플러스", "index_family": "k200", "leverage": None, "fv_mode": "beta"},
}

# index_family → Finance_Data index_ohlcv_daily 코드.
_FAMILY_INDEX_CODE = {"k200": "K2G01P", "kq150": "Q5G01P"}

# 호가 파라미터 default (사용자 합의 전 초기값 — 전부 UI 조정 대상).
DEFAULT_QUOTE_PARAMS = {
    "base_spread_bp": 5.0,          # 기본 반스프레드 (bp)
    "gamma": 1.0,                   # 재고 skew 강도 (A-S 간소화 계수)
    "adverse_buffer_bp": 3.0,       # 역선택 버퍼 (bp)
    "hedge_cost_bp": 2.0,           # 헤지 비용 (bp) — 정보용 별도 표기
    "per_etf_inventory_limit_krw": 1_000_000_000.0,  # ETF별 재고 한도 (기본 10억)
    "inventory_limit_overrides": {},  # {code: krw} ETF별 override
    "max_futures_contracts": 100,   # 선물 헤지 여력 (계약)
    "basis_threshold_bp": 5.0,      # 베이시스 라우터(§13.4) 선물 대체 임계 (bp)
    # ── §13.3-C P&L·리스크 한도 (Phase 4 PR-E) ──
    "futures_fee_bp": 0.3,          # 선물 체결 수수료 (bp × 명목) — 헤지비용 분해 v1
    "basis_vol_bp_daily": 15.0,     # 베이시스 일변동성 근사 (bp) — VaR 조잡 상수
    "limit_net_delta_krw": 2_000_000_000.0,    # 북 순 베타델타 한도 (오버레이 후, 20억)
    "limit_residual_krw": 100_000_000.0,       # 잔차위험 1σ 총량 한도 (1억)
    "limit_basis_var_krw": 200_000_000.0,      # 베이시스 VaR 한도 (2억)
    # ── §13.3-D 출구 (Phase 5) ──
    "cu_fee_bp": 2.0,               # 설정/환매 AP 수수료 (bp × CU 명목) — 출구 3 비교용
}


class QuoteParams(BaseModel):
    # 전 필드 ge=0 — 음수 스프레드/한도는 bid > ask 역전 등 무의미한 제안을 만든다.
    # (Rust 측 half 클램프가 이중 방어.)
    base_spread_bp: float = Field(5.0, ge=0, description="기본 반스프레드 (bp)")
    gamma: float = Field(1.0, ge=0, description="재고 skew 강도 (A-S 간소화)")
    adverse_buffer_bp: float = Field(3.0, ge=0, description="역선택 버퍼 (bp)")
    hedge_cost_bp: float = Field(2.0, ge=0, description="헤지 비용 (bp) — 정보용 별도 표기")
    per_etf_inventory_limit_krw: float = Field(
        1_000_000_000.0, ge=0, description="ETF별 재고 한도 (원, 기본 10억)"
    )
    inventory_limit_overrides: dict[str, float] = Field(
        default_factory=dict, description="{code: krw} ETF별 한도 override (음수 거부)"
    )
    max_futures_contracts: int = Field(100, ge=0, description="선물 헤지 여력 (계약)")
    basis_threshold_bp: float = Field(
        5.0, ge=0, description="베이시스 라우터(§13.4) 선물 대체 임계 (bp)"
    )
    # ── §13.3-C P&L·리스크 한도 (Phase 4 PR-E) ──
    futures_fee_bp: float = Field(
        0.3, ge=0, description="선물 체결 수수료 (bp × 명목) — 헤지비용 분해 v1"
    )
    basis_vol_bp_daily: float = Field(
        15.0, ge=0, description="베이시스 일변동성 근사 (bp) — 베이시스 VaR 조잡 상수"
    )
    limit_net_delta_krw: float = Field(
        2_000_000_000.0, ge=0, description="북 순 베타델타 한도 (오버레이 후, 원)"
    )
    limit_residual_krw: float = Field(
        100_000_000.0, ge=0, description="잔차위험 1σ 총량 한도 (원)"
    )
    limit_basis_var_krw: float = Field(
        200_000_000.0, ge=0, description="베이시스 VaR 한도 (원)"
    )
    # ── §13.3-D 출구 (Phase 5) ──
    cu_fee_bp: float = Field(
        2.0, ge=0, description="설정/환매 AP 수수료 (bp × CU 명목) — 출구 3 비교용"
    )

    @field_validator("inventory_limit_overrides")
    @classmethod
    def _overrides_non_negative(cls, v: dict[str, float]) -> dict[str, float]:
        for code, krw in v.items():
            if krw < 0:
                raise ValueError(f"inventory_limit_overrides[{code}] must be >= 0")
        return v


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


# ---------------------------------------------------------------------------
# 원장 (lp_ledger) — §13.5 Phase 1
# ---------------------------------------------------------------------------

def _load_futures_master() -> None:
    """futures_master.json (273종목 × front/back) → 코드 set + code→name 캐시. mtime 갱신."""
    global _fut_codes_cache, _fut_names_cache, _fut_to_base_cache, _fut_master_mtime
    try:
        mtime = FUTURES_MASTER_PATH.stat().st_mtime
    except OSError:
        return
    if mtime == _fut_master_mtime and _fut_codes_cache:
        return
    codes: set[str] = set()
    names: dict[str, str] = {}
    to_base: dict[str, str] = {}
    try:
        with FUTURES_MASTER_PATH.open() as f:
            data = json.load(f)
        for item in data.get("items", []):
            base = str(item.get("base_code") or "").strip()
            for leg in ("front", "back"):
                node = item.get(leg) or {}
                c = node.get("code")
                if c:
                    c = str(c).strip().upper()
                    codes.add(c)
                    if node.get("name"):
                        names[c] = str(node["name"]).strip()
                    if base:
                        to_base[c] = base
    except Exception:
        return
    _fut_codes_cache = codes
    _fut_names_cache = names
    _fut_to_base_cache = to_base
    _fut_master_mtime = mtime


def _futures_code_set() -> set[str]:
    """front/back 8자리 코드 set (주식선물 판정용)."""
    _load_futures_master()
    return _fut_codes_cache


def _classify_futures(code: str) -> str:
    """8자리 A-prefix 선물코드 → 'stock_fut' | 'index_fut'."""
    if code in _futures_code_set():
        return "stock_fut"
    if code[1:3] in INDEX_FUT_PREFIXES:
        return "index_fut"
    # 마스터에 없는 미상 8자리 A코드 — 종목선물로 가정 (지수는 프리픽스로 이미 걸림).
    return "stock_fut"


def _classify_sync(
    raw: str, etf_codes: set[str], override: Optional[str] = None
) -> tuple[str, str]:
    """자유 입력 코드 → (정규화 코드, instrument). 순수 동기 (ETF 코드 집합 주입).

    - 선물(8자리 영숫자 — A+7 또는 '1GNW4000' 등, 또는 KR4 ISIN)은 정규화 없이 유지.
    - 나머지는 stock_code.normalize_stock_code 로 6자리 정규화.
    - override 주어지면 instrument 는 그대로 채택 (코드 정규화만 수행).
    - 정규화 불가/빈 코드는 ValueError (배치 import 가 excluded 로 흡수).

    엑셀 import(services.ledger_import)와 원장 CRUD 라우트가 **같은 분류 로직**을
    쓰도록 순수 함수로 추출 — 드리프트 방지.
    """
    s = str(raw or "").strip().upper()
    if not s:
        raise ValueError("code required")

    # 선물 ISIN 'KR4A' + 7 + 체크1 (12자) → 'A' + 7
    if len(s) == 12 and s.startswith("KR4"):
        s = "A" + s[4:11]

    # 선물 단축코드: 8자 영숫자 (A+7 또는 '1GNW4000' 등 비-A 접두 포함).
    # 주식 6자·A+6(7자)·ISIN 12자와 자릿수로 구분되어 8자 영숫자는 선물로 안전 판정.
    # 순수 8자리 숫자만 제외(정규화 대상 아님이나 선물 단축코드도 아님).
    if len(s) == 8 and s.isalnum() and not s.isdigit():
        inst = override if override in lp_ledger.VALID_INSTRUMENTS else _classify_futures(s)
        return s, inst

    # 주식/ETF → 6자리 정규화
    code = normalize_stock_code(s)
    if not code:
        raise ValueError(f"cannot normalize code: {raw}")
    if override in lp_ledger.VALID_INSTRUMENTS:
        return code, override
    if code in etf_codes:
        return code, "etf"
    return code, "stock"


async def _classify(raw: str, override: Optional[str] = None) -> tuple[str, str]:
    """자유 입력 코드 → (정규화 코드, instrument). ETF 마스터 로드 후 `_classify_sync` 위임."""
    etf_codes: set[str] = set()
    try:
        await _ensure_loaded()
        etf_codes = set(etf_cache.etfs.keys())
    except Exception:
        # ETF 마스터 로드 실패 → 주식으로 폴백 (원장 입력을 막지 않음).
        pass
    try:
        return _classify_sync(raw, etf_codes, override)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _name_for(code: str, instrument: str) -> Optional[str]:
    """표시용 이름 (있으면). ETF 는 마스터 캐시, 선물은 mtime 캐시된 code→name 맵."""
    if instrument == "etf":
        meta = etf_cache.etfs.get(code)
        if meta:
            return meta.get("name")
    if instrument in ("stock_fut", "index_fut"):
        _load_futures_master()
        return _fut_names_cache.get(code)
    return None


def _base_for(code: str, instrument: str) -> Optional[str]:
    """주식선물 코드 → 기초 종목 6자리 (베이시스 페어 태그용). 그 외 None."""
    if instrument == "stock_fut":
        _load_futures_master()
        return _fut_to_base_cache.get(str(code).strip().upper())
    return None


class LedgerEntryPayload(BaseModel):
    code: str = Field(..., description="자유 형식 코드 (6자리/A접두/ISIN/선물 8자리)")
    side: str = Field(..., description="'buy' | 'sell'")
    qty: int = Field(..., description="수량 (양수)")
    kind: str = Field("fill", description="'fill' | 'carryover'")
    price: Optional[float] = Field(None, description="체결가/평단 (선택)")
    note: Optional[str] = Field(None, description="메모")
    entry_basis: Optional[float] = Field(
        None,
        description="진입 베이시스 (선물가 − 현물가, 주당 원). §13.4 베이시스 대체 기장 leg에 기록",
    )
    fv_at_fill: Optional[float] = Field(
        None,
        description="체결 시점 FV_futures 스냅샷 (§13.3-C 스프레드 귀속). ETF 유니버스 fill만 첨부",
    )
    mid_at_fill: Optional[float] = Field(
        None, description="체결 시점 현재가(mid) 스냅샷 (markout 기준선 참고)"
    )
    instrument: Optional[str] = Field(
        None, description="수동 override (etf|stock|index_fut|stock_fut). 미지정 시 자동 분류"
    )
    ts: Optional[str] = Field(None, description="ISO 시각 (미지정 시 서버 now)")


class CarryoverPayload(BaseModel):
    code: str = Field(..., description="자유 형식 코드")
    qty: int = Field(..., description="부호있는 수량 (롱=+, 숏=−). 0 이면 해당 코드 이월 삭제")
    price: Optional[float] = Field(None, description="평단 (선택)")
    note: Optional[str] = Field(None, description="메모")
    instrument: Optional[str] = Field(None, description="수동 override")


# ---------------------------------------------------------------------------
# quote_universe 빌더 (§13.3-A FV_futures 정적 입력)
# ---------------------------------------------------------------------------

async def _fetch_etf_prev_close(session, codes: list[str]) -> dict[str, float]:
    """각 ETF의 *직전 거래일* 수정종가 (adj_close). 오늘 일봉은 EOD 전엔 없으므로
    time < CURRENT_DATE 로 안전하게 직전 완결 거래일 종가를 잡는다."""
    rows = (await session.execute(text(
        "SELECT DISTINCT ON (stock_code) stock_code, adj_close "
        "FROM ohlcv_daily "
        "WHERE stock_code = ANY(:codes) AND time < CURRENT_DATE AND adj_close IS NOT NULL "
        "ORDER BY stock_code, time DESC"
    ), {"codes": codes})).all()
    return {r.stock_code: float(r.adj_close) for r in rows}


async def _fetch_index_prev_and_vol(
    session, index_codes: list[str], window: int = 60
) -> dict[str, tuple[Optional[float], Optional[float]]]:
    """지수별 (직전 종가, 일일 변동성 σ). σ는 최근 window 거래일 단순수익률 표준편차."""
    out: dict[str, tuple[Optional[float], Optional[float]]] = {}
    for code in index_codes:
        rows = (await session.execute(text(
            "SELECT close FROM index_ohlcv_daily "
            "WHERE code = :c AND time < CURRENT_DATE ORDER BY time DESC LIMIT :n"
        ), {"c": code, "n": window + 1})).all()
        if not rows:
            out[code] = (None, None)
            continue
        closes = np.array([float(r.close) for r in reversed(rows)], dtype=np.float64)
        prev_close = float(closes[-1])
        sigma: Optional[float] = None
        if len(closes) >= 5:
            rets = (closes[1:] - closes[:-1]) / closes[:-1]
            sigma = float(rets.std())
        out[code] = (prev_close, sigma)
    return out


async def build_quote_universe() -> list[dict]:
    """FV_futures 계산에 필요한 12종 정적 입력 (§13.3-A).

    각 항목: {code, name, index_family, leverage(부호), fv_mode, beta(섹터형),
             residual_sigma_daily, index_sigma_daily, prev_nav, prev_close, prev_index_close}.

    - beta / residual_sigma_daily: risk_estimator (KOSPI200 60일 OLS). 섹터형 FV에 사용.
    - index_sigma_daily: 소속 지수 60일 일변동성 (skew의 σ_day 계산용).
    - prev_nav: ETF 직전 종가를 NAV 프록시로 사용. etf_master_daily의
      net_asset/listed_shares는 일부 종목(252670)에서 ~10× 어긋나 신뢰 불가 (2026-07-07 실측)
      → adj_close가 시장가와 직접 비교되는 안정 소스라 이를 정본으로 채택. ETF는 NAV를
      촘촘히 추종하므로 프록시 오차 미미.
    - prev_index_close: 소속 지수 직전 종가 (r_implied 앵커).
    """
    risk = await get_risk_params()
    betas: dict = risk.get("betas", {}) or {}
    resid: dict = risk.get("residual_sigmas_daily", {}) or {}

    async with korea_async_session() as session:
        etf_prev = await _fetch_etf_prev_close(session, QUOTE_UNIVERSE_CODES)
        idx = await _fetch_index_prev_and_vol(session, list(_FAMILY_INDEX_CODE.values()))

    universe: list[dict] = []
    for code in QUOTE_UNIVERSE_CODES:
        fb = _QUOTE_UNIVERSE_FALLBACK[code]
        family = fb["index_family"]
        idx_code = _FAMILY_INDEX_CODE.get(family)
        prev_index_close, index_sigma = idx.get(idx_code, (None, None)) if idx_code else (None, None)
        prev_close = etf_prev.get(code)
        universe.append({
            "code": code,
            "name": fb["name"],
            "index_family": family,
            "leverage": fb["leverage"],
            "fv_mode": fb["fv_mode"],
            "beta": betas.get(code),
            "residual_sigma_daily": resid.get(code),
            "index_sigma_daily": index_sigma,
            "prev_nav": prev_close,       # ETF 직전 종가 = NAV 프록시 (위 docstring 근거)
            "prev_close": prev_close,
            "prev_index_close": prev_index_close,
            # 선물지수 추종 ETF (베이시스 북 지수 베이시스 etf_leg 제외 대상 — 맵 주석 참조)
            "futures_based": bool(fb.get("futures_based", False)),
        })
    return universe


@router.get("/matrix-config")
async def get_matrix_config():
    """Rust startup이 한 번 fetch. 첫 빌드의 모든 정적 입력을 한 번에."""
    await _ensure_loaded()
    cost_inputs = _read_json(COST_INPUTS_PATH, DEFAULT_COST_INPUTS)
    quote_params = _read_json(QUOTE_PARAMS_PATH, DEFAULT_QUOTE_PARAMS)
    try:
        quote_universe = await build_quote_universe()
    except Exception as e:  # noqa: BLE001
        # 유니버스 빌드 실패 (risk 회귀/DB 등) — 호가 보드만 비고 나머지 매트릭스는 정상 동작.
        # Rust 5초 poll이 quote_universe 빈 배열을 보고 재fetch하므로 복구 가능. warn 필수.
        logger.warning("build_quote_universe failed — quote_universe empty: %s", e)
        quote_universe = []

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
        # §13.7 Phase 2 — FV_futures 호가 보드 정적 입력 (12종) + 호가 파라미터.
        "quote_universe": quote_universe,
        "quote_params": quote_params,
        "loaded_at": etf_cache.loaded_at,
    }


@router.get("/positions")
async def get_positions():
    """현재 포지션 (호환 계약). 원장 집계 net_qty → flat dict `{code: signed_qty}`.

    Rust scheduler.rs 가 5초 poll. 응답 shape `{positions, updated_at}` 무변경.
    startup ensure 실패 시 재기동 전까지 500 지속 이력 → lazy ensure 안전망.
    """
    await lp_ledger.ensure_schema_once()
    positions = await lp_ledger.positions_flat()
    updated_at = await lp_ledger.latest_ts()
    return {"positions": positions, "updated_at": updated_at}


@router.post("/positions")
async def set_positions(payload: PositionsPayload):
    """포지션 full replace (하위호환). 부호있는 수량(롱=+, 숏=-).

    받은 dict 를 carryover 로 해석하여 원장 전체를 교체 (기존 carryover+fill 삭제 후
    carryover 재삽입). 결과적으로 GET /positions net 이 정확히 payload 와 일치 —
    레거시 "전체 저장" 계약 보존. 빈 dict = 전체 클리어.
    신규 UI 는 /ledger 계열을 사용하며 이 엔드포인트를 호출하지 않는다.
    """
    await lp_ledger.ensure_schema_once()
    items: list[tuple[str, str, int]] = []
    for raw_code, signed in payload.positions.items():
        try:
            code, instrument = await _classify(raw_code)
        except HTTPException:
            continue
        items.append((code, instrument, int(signed)))
    await lp_ledger.replace_all_carryover(items)
    # 레거시 JSON 미러 유지 (감사/롤백 안전망).
    _write_json(POSITIONS_PATH, {
        "positions": payload.positions,
        "updated_at": datetime.now().isoformat(),
    })
    positions = await lp_ledger.positions_flat()
    return {"positions": positions, "updated_at": await lp_ledger.latest_ts()}


# ---- 원장 (§13.5) ----------------------------------------------------------

@router.get("/ledger")
async def get_ledger():
    """전체 엔트리(최신순) + 코드별 집계.

    응답: {entries: [...], aggregates: [{code, name, instrument, carryover_qty,
           fills_qty, fills_qty_today, net_qty, avg_price}], updated_at}
    """
    await lp_ledger.ensure_schema_once()
    entries = await lp_ledger.list_entries()
    agg = await lp_ledger.aggregate()
    # 이름 부여 (ETF 마스터 캐시가 로드돼 있으면).
    try:
        await _ensure_loaded()
    except Exception:
        pass
    aggregates = []
    for code, a in agg.items():
        aggregates.append({
            **a,
            "name": _name_for(code, a["instrument"]),
            # 주식선물 → 기초 종목 6자리. 원장 보드가 현물↔선물 베이시스 페어 태그에 사용.
            "base_code": _base_for(code, a["instrument"]),
        })
    aggregates.sort(key=lambda x: (x["instrument"], x["code"]))
    return {
        "entries": entries,
        "aggregates": aggregates,
        "updated_at": await lp_ledger.latest_ts(),
    }


@router.post("/ledger/entry")
async def add_ledger_entry(payload: LedgerEntryPayload):
    """엔트리 추가 (fill 또는 carryover)."""
    await lp_ledger.ensure_schema_once()
    code, instrument = await _classify(payload.code, payload.instrument)
    errs = lp_ledger.validate_entry(payload.kind, payload.side, instrument, payload.qty)
    if errs:
        raise HTTPException(status_code=400, detail="; ".join(errs))
    entry = await lp_ledger.add_entry({
        "code": code,
        "instrument": instrument,
        "kind": payload.kind,
        "side": payload.side,
        "qty": int(payload.qty),
        "price": payload.price,
        "note": payload.note,
        "entry_basis": payload.entry_basis,
        "fv_at_fill": payload.fv_at_fill,
        "mid_at_fill": payload.mid_at_fill,
        "ts": payload.ts,
    })
    entry["name"] = _name_for(code, instrument)
    return entry


class FillMarkPayload(BaseModel):
    fill_id: str = Field(..., description="대상 fill 엔트리 id")
    horizon: str = Field(..., description="'5m' | '30m'")
    price: Optional[float] = Field(None, description="마크 시점 현재가")
    fv: Optional[float] = Field(None, description="마크 시점 FV (ETF 유니버스만)")
    marked_at: Optional[str] = Field(None, description="ISO 시각 (미지정 시 서버 now)")


@router.post("/fill-marks")
async def add_fill_mark(payload: FillMarkPayload):
    """markout 기록 (§13.3-C) — Rust가 fill 후 5분/30분 경과 시 현재가·FV 첨부해 POST.

    (fill_id, horizon) UNIQUE — 이미 있으면 무시(멱등). 재시도·재기동 시 이중 기록 안 됨.
    """
    await lp_ledger.ensure_schema_once()
    if payload.horizon not in lp_ledger.VALID_HORIZONS:
        raise HTTPException(status_code=400, detail=f"horizon invalid: {payload.horizon}")
    inserted = await lp_ledger.add_fill_mark(payload.model_dump())
    return {"inserted": inserted, "fill_id": payload.fill_id, "horizon": payload.horizon}


@router.get("/fill-marks")
async def get_fill_marks(date: str = "today"):
    """markout 목록. date='today'(기본)/'all'/'YYYY-MM-DD'. Rust가 due 마크 dedup에 사용."""
    await lp_ledger.ensure_schema_once()
    if date == "all":
        prefix = None
    elif date == "today":
        prefix = datetime.now().date().isoformat()
    else:
        prefix = date
    marks = await lp_ledger.list_fill_marks(prefix)
    return {"marks": marks, "date": date}


@router.delete("/ledger/entry/{entry_id}")
async def delete_ledger_entry(entry_id: str):
    await lp_ledger.ensure_schema_once()
    ok = await lp_ledger.delete_entry(entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"entry not found: {entry_id}")
    return {"deleted": entry_id}


@router.post("/ledger/carryover")
async def set_ledger_carryover(payload: CarryoverPayload):
    """특정 코드 carryover 일괄 세팅 (수량+평단). 기존 carryover 교체, fill 보존."""
    await lp_ledger.ensure_schema_once()
    code, instrument = await _classify(payload.code, payload.instrument)
    await lp_ledger.set_carryover(
        code, instrument, int(payload.qty), payload.price, payload.note
    )
    agg = await lp_ledger.aggregate()
    a = agg.get(code)
    if a:
        a["name"] = _name_for(code, instrument)
    return {"code": code, "instrument": instrument, "aggregate": a}


# ---- 원장 엑셀 업로드 (회사 원장 → LP 매트릭스 반영) ------------------------

@router.post("/ledger/import-excel")
async def import_ledger_excel(
    files: list[UploadFile] = File(...),
    dry_run: bool = Form(True),
    futures_unit: str = Form("contracts"),
    replace_all: bool = Form(True),
):
    """회사 원장 엑셀(5264/3454/2514) 업로드 → 파싱 후 미리보기(dry_run) 또는 반영.

    - dry_run=True(기본): 파싱 결과 전체 반환 (positions/fills/excluded/warnings +
      replace_all 시 삭제될 기존 원장 종목 + 선물 환산 명세). DB 무변경.
    - dry_run=False: 트랜잭션으로 반영. replace_all=True 면 원장 전체 삭제 후 재구성
      (실계좌 스냅샷이 정본 → 청산 종목 유령 방지), False 면 포함 종목만 교체.

    자세한 규칙은 services/ledger_import.py docstring.
    """
    await lp_ledger.ensure_schema_once()
    if futures_unit not in ("contracts", "shares"):
        raise HTTPException(status_code=400, detail=f"futures_unit invalid: {futures_unit}")

    # 파일 바이트 읽기 (빈 파일 방지).
    blobs: list[tuple[str, bytes]] = []
    for uf in files:
        data = await uf.read()
        if not data:
            continue
        blobs.append((uf.filename or "unnamed", data))
    if not blobs:
        raise HTTPException(status_code=400, detail="빈 업로드 (파일 없음)")

    # ETF 마스터 + 선물 마스터 로드 후 동기 분류기 주입.
    etf_codes: set[str] = set()
    try:
        await _ensure_loaded()
        etf_codes = set(etf_cache.etfs.keys())
    except Exception:  # noqa: BLE001
        pass
    _load_futures_master()

    def classify(raw: str) -> tuple[str, str]:
        return _classify_sync(raw, etf_codes)

    parsed = ledger_import.parse_ledger_files(blobs, classify, futures_unit)

    # 삭제 예상 종목 (replace_all): 현재 원장에 있으나 새 스냅샷에 없는 코드.
    removed: list[dict] = []
    if replace_all:
        new_codes = {p["code"] for p in parsed["positions"]}
        agg = await lp_ledger.aggregate()
        for code, a in agg.items():
            if a["net_qty"] != 0 and code not in new_codes:
                removed.append({
                    "code": code, "name": _name_for(code, a["instrument"]),
                    "instrument": a["instrument"], "net_qty": a["net_qty"],
                })
        removed.sort(key=lambda x: x["code"])

    result = {
        "dry_run": dry_run,
        "futures_unit": futures_unit,
        "replace_all": replace_all,
        "files": parsed["files"],
        "positions": parsed["positions"],
        "excluded": parsed["excluded"],
        "warnings": parsed["warnings"],
        "summary": parsed["summary"],
        "removed": removed,
    }

    if dry_run:
        return result

    # ── 확정 가드 (dry_run=false) ──
    # M1: 파싱 실패 파일이 섞인 채 확정하면, 그 파일에 있던 포지션이 replace_all 로
    # 조용히 삭제됨 → 전면 거부. 미리보기는 부분 결과 + 에러 표시를 유지.
    bad_files = [f["filename"] for f in parsed["files"] if f.get("error")]
    if bad_files:
        raise HTTPException(
            status_code=400,
            detail=f"파싱 실패 파일 {len(bad_files)}개 — 확정 거부. "
                   f"실패 파일을 제외하고 다시 업로드: {', '.join(bad_files)}",
        )
    # H1: 빈 스냅샷 + 전체 교체 = 원장 전멸. 서버측에서 무조건 거부
    # (UI 는 버튼 disabled 로 막지만 API 직접 호출 방어).
    if replace_all and not parsed["positions"]:
        raise HTTPException(
            status_code=400,
            detail="포지션 0건 — 전체 교체 거부 (원장 전멸 방지). "
                   "3454/2514 파일이 포함됐는지 확인하세요 (5264 는 경고 추출 전용).",
        )

    # 반영 — carryover(이월 평단) + 당일 체결(fill). fv_at_fill 없음(스프레드 미귀속·정직).
    import_positions: list[dict] = []
    for p in parsed["positions"]:
        note = f"excel import: {', '.join(p['sources'])}"
        fills = [
            {"side": f["side"], "qty": f["qty"], "price": f.get("price"),
             "note": f"excel import: {f.get('source', '')}"}
            for f in p["fills"]
        ]
        import_positions.append({
            "code": p["code"], "instrument": p["instrument"],
            "carryover_signed": p["carryover_qty"],
            # carryover 행 평단 — 이월 가중 평균 (표시용 avg_price 는 blended VWAP
            # 시뮬레이션이라 여기 쓰면 fill 이 이중 가중됨).
            "price": p.get("carryover_avg_price"),
            "note": note, "fills": fills,
        })
    write_stats = await lp_ledger.import_positions(import_positions, replace_all)
    result["applied"] = write_stats
    result["updated_at"] = await lp_ledger.latest_ts()
    return result


async def migrate_positions_json_once() -> int:
    """서버 기동 시 — lp_positions.json → carryover 이관, lp_meta 키로 평생 1회.

    트리거는 lp_meta `migrated_positions_json` 키 부재 *만*. "원장 비어있음"을 조건으로
    쓰면 사용자가 원장 UI에서 전부 삭제 후 재기동(--reload는 파일 저장마다!) 시 옛 JSON이
    carryover로 부활 → Rust 북에 유령 포지션. 키 방식은 시도 후 무조건 기록해 봉인.
    동시 기동 race는 서비스 쪽 BEGIN IMMEDIATE + 키 재확인이 차단.

    반환: 이관된 엔트리 수 (이미 이관/스킵이면 0).
    """
    await lp_ledger.ensure_schema()
    if await lp_ledger.get_meta(lp_ledger.META_MIGRATED_KEY) is not None:
        return 0
    data = _read_json(POSITIONS_PATH, {"positions": {}})
    positions = data.get("positions", {}) if isinstance(data, dict) else {}
    items: list[tuple[str, str, int]] = []
    for raw_code, signed in positions.items():
        try:
            code, instrument = await _classify(raw_code)
        except HTTPException:
            continue
        items.append((code, instrument, int(signed)))
    n = await lp_ledger.migrate_carryover_once(items)
    return max(n, 0)


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


@router.get("/quote-params")
async def get_quote_params():
    """호가 제안 파라미터 (§13.3-A). Rust scheduler가 5초 poll — UI 조정 즉시 반영.

    default를 병합 반환 — 구버전 lp_quote_params.json이 신규 키(basis_threshold_bp 등)를
    누락해도 프론트/스케줄러가 default를 받게 한다 (Rust는 serde default가 이중 방어).
    """
    saved = _read_json(QUOTE_PARAMS_PATH, {})
    return {**DEFAULT_QUOTE_PARAMS, **saved}


@router.post("/quote-params")
async def set_quote_params(payload: QuoteParams):
    """호가 제안 파라미터 갱신 (base_spread / gamma / buffer / hedge_cost / 재고 한도 등)."""
    data = payload.model_dump()
    _write_json(QUOTE_PARAMS_PATH, data)
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


@router.get("/corporate-actions-today")
async def get_corporate_actions_today():
    """오늘(KST) 발생 corporate action 종목 목록.

    매트릭스 상단 배너 — 분할 당일 PDF qty 갱신 latency로 NAV가 일시적으로 잘못 보일
    수 있어 사용자에게 인지시킴. price_factor != 1 만 (배당·소속변경 등 무영향 제외).

    응답: {as_of, count, items: [{stock_code, event_type, price_factor, description}]}
    """
    from datetime import date
    from sqlalchemy import text
    from core.database import korea_async_session

    today = date.today()
    async with korea_async_session() as session:
        rows = (await session.execute(text(
            "SELECT stock_code, event_type, price_factor, description "
            "FROM corporate_actions "
            "WHERE event_date = :d AND price_factor IS NOT NULL AND price_factor != 1 "
            "ORDER BY stock_code"
        ), {"d": today})).all()

    items = [
        {
            "stock_code": r.stock_code,
            "event_type": r.event_type,
            "price_factor": float(r.price_factor),
            "description": r.description,
        }
        for r in rows
    ]
    return {"as_of": today.isoformat(), "count": len(items), "items": items}


# ---------------------------------------------------------------------------
# §13.3-D 출구 (Phase 5) — 넷팅 바스켓 빌더 + 지수 베이시스 z-score 모니터
# ---------------------------------------------------------------------------

@router.post("/netting-basket")
async def post_netting_basket():
    """넷팅 바스켓 실행 주문표 생성 (§13.3-D 메인 출구 · §13.2).

    body 없음 — 원장 ETF 재고를 읽어 PDF 합산 후 종목별 순 주수 주문표를 스냅샷 계산.
    상세·부호 규약·비용 추정은 services/lp_netting.py docstring 참조.
    """
    from services import lp_netting
    return await lp_netting.build_netting_basket()


class HedgeReconParams(BaseModel):
    tol_abs_shares: float = Field(
        1.0, ge=0, description="정합 tolerance 절대 하한 (주). 기본 1주"
    )
    tol_pct: float = Field(
        0.005, ge=0, description="정합 tolerance = max(abs, |required|×pct). 기본 0.5%"
    )
    offset_warn_krw: float = Field(
        50_000_000.0, ge=0,
        description="상쇄 경고 임계 (원) — 주문 0인데 |gapδ| 초과 시 '매크로(상쇄)' + "
                    "가족 gross 상쇄 경고 하한. 기본 5천만",
    )


@router.post("/hedge-recon")
async def post_hedge_recon(payload: Optional[HedgeReconParams] = None):
    """헤지 정합 보드 (§13.12) — 무기억 진단.

    현재 원장이 PDF 기준으로 알맞게 헤지돼 있는지, 어디가 어긋났는지, 델타가 얼마나 떠
    있는지를 원장 스냅샷 하나만으로 진단. 과거 체결·의도 기록 미사용. 상세·부호 규약·
    분류 캐스케이드·커버리지 산식(H1 단조 수정)은 services/hedge_recon.py docstring 참조.
    """
    from services import hedge_recon
    p = payload or HedgeReconParams()
    return await hedge_recon.build_hedge_recon(
        tol_abs_shares=p.tol_abs_shares, tol_pct=p.tol_pct,
        offset_warn_krw=p.offset_warn_krw,
    )


# 지수 베이시스 raw 행 캐시 (1시간). key='01'/'06' → (computed_at_monotonic, rows).
# excess 통계는 금리(cost_inputs) 의존이라 캐시하지 않고 요청마다 재계산 (60 floats, 저렴)
# — 사용자가 금리를 바꾸면 즉시 반영.
_basis_rows_cache: dict[str, tuple[float, list[dict]]] = {}
_BASIS_DIST_TTL_SEC = 3600.0
# 지수 z-score 창 (거래일).
_BASIS_ZSCORE_WINDOW = 60

# family(베이시스 북) → 지수선물 underlying_code.
_FAMILY_TO_UNDERLYING = {"k200": "01", "kq150": "06"}


def _second_thursday(year: int, month: int) -> "date":
    """해당 월의 두 번째 목요일 (지수선물 만기 — memory reference_stock_futures_expiry)."""
    from datetime import date as _date
    d1 = _date(year, month, 1)
    first_thu = 1 + (3 - d1.weekday()) % 7  # Mon=0 … Thu=3
    return _date(year, month, first_thu + 7)


def _next_quarterly_expiry(d: "date") -> "date":
    """d 이후(당일 포함) 첫 분기(3/6/9/12월) 만기일.

    NEAR 정의와 정합: futures_daily_with_class는 만기 당일까지 해당 월물이 NEAR
    (2026-06-11 A0166000 실측 — 만기일 NEAR 유지, 익일 롤). 따라서 행 날짜 기준
    '당일 포함 다음 분기 만기'가 그 행 계약의 만기다. 계약 코드 파싱 불필요.
    """
    y, m = d.year, d.month
    for _ in range(6):
        qm = ((m - 1) // 3 + 1) * 3  # 이번 분기의 만기월 (3/6/9/12)
        exp = _second_thursday(y, qm)
        if exp >= d:
            return exp
        m = qm + 1
        if m > 12:
            y, m = y + 1, 1
    return exp  # unreachable (2 iter 내 반환)


async def _basis_excess_rows(underlying: str) -> list[dict]:
    """underlying('01'|'06') NEAR 최근 60거래일 raw 행 (1h 캐시).

    각 행: {time(date), basis(선물−현물지수), spot(현물지수 종가), days_left(만기 잔존일)}.
    - basis: futures_daily_with_class.underlying_basis — 정확히 (close − 현물지수 close)
      실측 확인 (2026-07-06: 1303.95 − K2G01P 1293.13 = 10.82 = ub).
    - spot = close − underlying_basis (지수 테이블 조인 불필요).
    - days_left = 행 날짜 기준 다음 분기 만기까지 일수 (_next_quarterly_expiry).
    """
    import time as _time
    cached = _basis_rows_cache.get(underlying)
    if cached and (_time.monotonic() - cached[0]) < _BASIS_DIST_TTL_SEC:
        return cached[1]

    async with korea_async_session() as session:
        db_rows = (await session.execute(text(
            "SELECT time, close, underlying_basis FROM futures_daily_with_class "
            "WHERE underlying_code = :u AND contract_class = 'NEAR' "
            "AND underlying_basis IS NOT NULL AND close IS NOT NULL "
            "ORDER BY time DESC LIMIT :n"
        ), {"u": underlying, "n": _BASIS_ZSCORE_WINDOW})).all()

    rows = [
        {
            "time": r.time,
            "basis": float(r.underlying_basis),
            "spot": float(r.close) - float(r.underlying_basis),
            "days_left": (_next_quarterly_expiry(r.time) - r.time).days,
        }
        for r in db_rows
    ]
    _basis_rows_cache[underlying] = (_time.monotonic(), rows)
    return rows


@router.get("/basis-zscore")
async def get_basis_zscore(
    k200: Optional[float] = None,
    kq150: Optional[float] = None,
    k200_spot: Optional[float] = None,
    kq150_spot: Optional[float] = None,
):
    """지수 베이시스 z-score 모니터 (§13.3-D) — **만기 정규화 excess 기준**.

    raw 베이시스는 만기 잔존일에 비례해 자연 수축하므로, 60일 창에 월물이 섞이면
    이봉 분포가 되어 z 부호가 반전될 수 있다 (2026-07-07 실측: 6월물 43d + 9월물 17d
    혼합 5.91±6.24 vs 월물별 2.97/13.34 — basis 10.82의 z가 +0.79 vs −0.64 반전).
    → 행별 excess = basis − (spot × r × 잔존일/365) 로 정규화 (r = cost_inputs 자체 금리,
    §9.7 인포맥스 theoretical_basis는 금리 불명이라 미사용). 월물 혼합이 무해해짐.

    현재값도 동일 정의: `k200`/`kq150` = 실시간 베이시스(IndexFuturesTick.basis),
    `*_spot` = 기초지수 레벨(tick.underlying_index, 이론 베이시스 계산용 — 미제공 시
    직전 종가 폴백, 오차 미미).
    """
    cost_inputs = _read_json(COST_INPUTS_PATH, DEFAULT_COST_INPUTS)
    r_annual = float(cost_inputs.get("base_rate_annual", 0.028))
    from datetime import date as _date
    today = _date.today()

    current = {"k200": (k200, k200_spot), "kq150": (kq150, kq150_spot)}
    families: dict[str, dict] = {}
    for family, underlying in _FAMILY_TO_UNDERLYING.items():
        rows = await _basis_excess_rows(underlying)
        excess = np.array(
            [row["basis"] - row["spot"] * r_annual * row["days_left"] / 365.0 for row in rows],
            dtype=np.float64,
        )
        cur_basis, cur_spot = current[family]
        days_now = (_next_quarterly_expiry(today) - today).days
        # 현재 이론 베이시스의 spot: 실시간 기초지수 우선, 없으면 직전 종가 폴백.
        spot_ref = cur_spot if (cur_spot and cur_spot > 0) else (rows[0]["spot"] if rows else None)
        theory_now = (spot_ref * r_annual * days_now / 365.0) if spot_ref else None
        cur_excess = (float(cur_basis) - theory_now) if (cur_basis is not None and theory_now is not None) else None

        stats: dict = {
            "underlying": underlying,
            "n": int(excess.size),
            "window": _BASIS_ZSCORE_WINDOW,
            "r_annual": r_annual,
            "days_to_expiry": days_now,
            "asof": rows[0]["time"].isoformat() if rows else None,
            "current": float(cur_basis) if cur_basis is not None else None,
            "theory_now": theory_now,
            "current_excess": cur_excess,
        }
        if excess.size >= 2:
            mean = float(excess.mean())
            std = float(excess.std(ddof=1))  # 표본 표준편차
            stats.update({
                "mean": mean, "std": std,
                "min": float(excess.min()), "max": float(excess.max()),
                "z": ((cur_excess - mean) / std) if (cur_excess is not None and std > 0) else None,
            })
        else:
            stats.update({"mean": None, "std": None, "min": None, "max": None, "z": None})
        families[family] = stats

    return {
        "families": families,
        "caveat": "만기 정규화 excess(베이시스 − spot×r×잔존일/365, r=자체 금리) 기준 z — "
                  "월물 혼합 무해. 배당 미반영·현물지수 폴백 시 직전 종가 근사. "
                  "인포맥스 이론값은 금리 가정 불명이라 미사용(§9.7).",
    }
