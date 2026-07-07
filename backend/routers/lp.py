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

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from routers.etfs import _cache as etf_cache, _ensure_loaded, _norm_code
from services import lp_ledger
from services.pdf_futures_match import get_intersect_for_etf
from services.risk_estimator import get_risk_params
from services.stock_code import normalize_stock_code

router = APIRouter(prefix="/lp", tags=["lp"])

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"
POSITIONS_PATH = DATA_DIR / "lp_positions.json"
COST_INPUTS_PATH = DATA_DIR / "lp_cost_inputs.json"
FUTURES_MASTER_PATH = DATA_DIR / "futures_master.json"

# 지수선물 상품 프리픽스 (A + 2자리): KOSPI200=01, 미니K200=05, KOSDAQ150=06.
INDEX_FUT_PREFIXES = {"01", "05", "06"}

# 선물 마스터 캐시 (front/back 8자리 코드 set + code→name). mtime 기준 갱신.
_fut_codes_cache: set[str] = set()
_fut_names_cache: dict[str, str] = {}
_fut_master_mtime: float = 0.0

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


# ---------------------------------------------------------------------------
# 원장 (lp_ledger) — §13.5 Phase 1
# ---------------------------------------------------------------------------

def _load_futures_master() -> None:
    """futures_master.json (273종목 × front/back) → 코드 set + code→name 캐시. mtime 갱신."""
    global _fut_codes_cache, _fut_names_cache, _fut_master_mtime
    try:
        mtime = FUTURES_MASTER_PATH.stat().st_mtime
    except OSError:
        return
    if mtime == _fut_master_mtime and _fut_codes_cache:
        return
    codes: set[str] = set()
    names: dict[str, str] = {}
    try:
        with FUTURES_MASTER_PATH.open() as f:
            data = json.load(f)
        for item in data.get("items", []):
            for leg in ("front", "back"):
                node = item.get(leg) or {}
                c = node.get("code")
                if c:
                    c = str(c).strip().upper()
                    codes.add(c)
                    if node.get("name"):
                        names[c] = str(node["name"]).strip()
    except Exception:
        return
    _fut_codes_cache = codes
    _fut_names_cache = names
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


async def _classify(raw: str, override: Optional[str] = None) -> tuple[str, str]:
    """자유 입력 코드 → (정규화 코드, instrument).

    - 선물(8자리 A+7 또는 KR4 ISIN)은 정규화하지 않고 8자리 유지.
    - 나머지는 stock_code.normalize_stock_code 로 6자리 정규화.
    - override 주어지면 instrument 는 그대로 채택 (코드 정규화만 수행).
    """
    s = str(raw or "").strip().upper()
    if not s:
        raise HTTPException(status_code=400, detail="code required")

    # 선물 ISIN 'KR4A' + 7 + 체크1 (12자) → 'A' + 7
    if len(s) == 12 and s.startswith("KR4"):
        s = "A" + s[4:11]

    # 선물 단축코드: A + 7 (8자)
    if len(s) == 8 and s.startswith("A") and s[1:].isalnum():
        inst = override if override in lp_ledger.VALID_INSTRUMENTS else _classify_futures(s)
        return s, inst

    # 주식/ETF → 6자리 정규화
    code = normalize_stock_code(s)
    if not code:
        raise HTTPException(status_code=400, detail=f"cannot normalize code: {raw}")
    if override in lp_ledger.VALID_INSTRUMENTS:
        return code, override
    try:
        await _ensure_loaded()
        if code in etf_cache.etfs:
            return code, "etf"
    except Exception:
        # ETF 마스터 로드 실패 → 주식으로 폴백 (원장 입력을 막지 않음).
        pass
    return code, "stock"


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


class LedgerEntryPayload(BaseModel):
    code: str = Field(..., description="자유 형식 코드 (6자리/A접두/ISIN/선물 8자리)")
    side: str = Field(..., description="'buy' | 'sell'")
    qty: int = Field(..., description="수량 (양수)")
    kind: str = Field("fill", description="'fill' | 'carryover'")
    price: Optional[float] = Field(None, description="체결가/평단 (선택)")
    note: Optional[str] = Field(None, description="메모")
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
        "ts": payload.ts,
    })
    entry["name"] = _name_for(code, instrument)
    return entry


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
