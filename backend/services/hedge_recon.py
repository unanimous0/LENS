"""헤지 정합 보드 (Hedge Reconciliation, §13.12) — 무기억(memoryless) 진단.

"현재 원장이 PDF 기준으로 알맞게 헤지돼 있는지, 어디가 어떻게 어긋났는지, 델타가
얼마나 떠 있는지"를 **원장 스냅샷 하나만** 입력으로 진단한다 (버튼 트리거 REST,
`POST /api/lp/hedge-recon`).

핵심 설계 원칙 — **무기억**: 과거 체결 기록·의도 태그에 절대 의존하지 않는다. 엑셀
임포트가 매일 아침 원장을 회사 스냅샷으로 재구성하므로 기록 기반 분류는 구조적으로
불가능하다. 따라서 "이 leg가 어떤 의도였나"가 아니라 **"이 종목의 노출이 지금 다른
헤지 수단으로 설명되는가"**를 분류한다.

────────────────────────────────────────────────────────────────────────────
부호 규약 (핵심 — 전 계산의 뿌리)
────────────────────────────────────────────────────────────────────────────
    units_signed(ETF)     = etf_net_qty / cu_unit                  (ETF 부호 유지)
    required[종목]        = −units_signed × pdf_shares             (여러 ETF 합산)
        → 롱 ETF(net>0)는 그 종목을 **숏**해야 헤지 → required < 0 (목표 헤지 수량)
    actual[종목]          = 현물 net_qty + Σ(주식선물 net_qty)     (부호 有, 둘 다 주수)
        → 주식선물은 원장에 이미 **주수**(계약×10)로 기장됨 (ledger_import STOCK_FUT_MULT)
    gap[종목]             = actual − required

    **gap = 그 종목에 남은 순 델타원 노출** (헤지되지 않은 방향 노출):
        gap = actual − required = actual + units_signed×pdf_shares
            = (ETF가 만든 합성 종목 노출) + (원장의 명시적 종목 포지션)
        gap = 0 이면 그 종목은 PDF 기준 완전 헤지. gap ≠ 0 이면 그만큼 방향 노출 잔존.

────────────────────────────────────────────────────────────────────────────
분류 캐스케이드 (per 종목)
────────────────────────────────────────────────────────────────────────────
    tolerance = max(tol_abs_shares, |required| × tol_pct)          (기본 1주 / 0.5%)

    |gap| ≤ tolerance:
        |actual_spot − required| ≤ tolerance → "정합" (aligned_spot, 현물만으로 정합)
        그 외                                → "대체 헤지" (alt_hedge, 주식선물 합쳐 정합)
    |gap| > tolerance:                                             (미정합 — 방향 노출 잔존)
        → 종목 gap 델타(gap×price×β)를 **K200 풀**에 적재 (M1 — 헤지 티켓과 동일 규칙:
          β가 KOSPI200 단일 팩터라 KQ150 구성종목 잔여도 K200 합산, §9.5 multi-factor 전
          한계. 지수선물경로 ETF 요구 델타만 자기 가족 풀).
          풀 needed를 원장 지수선물 델타와 대조 → covered_fraction (아래) 산출.
          리밸런싱 주문 = round(−gap × (1 − covered))   (매크로가 못 잡는 만큼만)
            |주문| ≥ 1주 → "미설명" (unexplained, 진짜 리스크 — 종목 리밸런싱 대상)
            |주문| < 1주 → "매크로" (macro, gap은 있으나 지수선물로 설명됨)
              단 |gapδ| > offset_warn_krw 면 "매크로(상쇄)" (macro_offset — 커버리지는
              net 기준이라 주문은 0이지만 종목 스프레드 리스크 잔존, 숨기지 않음. H2)

────────────────────────────────────────────────────────────────────────────
가족 커버리지 — 부호 분리 + 단조 (H1 수정, 2026-07-08)
────────────────────────────────────────────────────────────────────────────
    naive (|needed|−|needed+fut|)/|needed| 는 fut에 비단조 — 정확 커버에서 1, 2배
    과다 헤지에서 0으로 붕괴해 "델타를 키우는 주문표"를 생성했다 (실측). 수정:

    선물이 needed **반대 방향**일 때만:
        covered_krw       = min(|fut|, |needed|)
        covered_fraction  = covered_krw / |needed|              (fut에 단조 비감소, 캡 1)
    같은 방향(또는 needed=0 / fut=0)이면 covered_fraction = 0.

    분해 (가산 항등: needed + fut = stock_unexplained + futures_excess):
        stock_unexplained = needed × (1 − covered_fraction)     (종목 리밸런싱 몫)
        futures_excess    = (needed + fut) − stock_unexplained  (선물 초과/동방향 잔여 —
                            헤지 티켓의 몫. 종목 주문으로 절대 대응하지 않음)

    → 과다 헤지(|fut| > |needed|)에서 covered=1: 종목 전부 매크로·주문 0, 초과분은
      "선물 과다"로 1급 표시 (티켓이 청산 제안). 동방향 선물은 covered=0 + 전량 excess.

    **gross 병기 (H2)**: 가족 gross δ = Σ|gapδ| (+ 지수경로 ETF |δ|). 부호 넷팅이 반대
    방향 종목 리스크를 숨길 수 있어 gross > 3×|needed| 이면서 gross > offset_warn_krw 면
    "종목 간 상쇄 큼" warning — 델타는 중립이나 잔차 위험(#3) 잔존.

────────────────────────────────────────────────────────────────────────────
역할 분리 + 이중 실행 방어 (M2)
────────────────────────────────────────────────────────────────────────────
    이 보드 = **종목 레벨 리밸런싱** (미설명 gap의 (1−covered) 몫만 종목 주문).
    헤지 티켓 = **북 델타 지수선물 마감** (가족 잔여 + futures_excess).
    두 수치는 같은 델타의 회계 분해이지 주문 중복 제거가 아니다 — **리밸런싱 주문을
    실행·기장하면 티켓이 자동 재계산되므로, 티켓과 동시 실행 금지** (UI 상시 명기).

지수선물경로 ETF (114800·252670·251340 선물지수추종 + 122630·233740 레버리지): PDF가
선물/스왑 혼합이라 현물 종목 환산 불가 → 종목 gap을 만들지 않고, 베타/배수로 **요구 델타만**
산출해 자기 가족 풀에 적재 (지수선물로만 헤지 가능).

가격·β 프록시: 직전 거래일 종가(ohlcv_daily raw close)·KOSPI200 60일 OLS β(risk_estimator).
가격이 없어도 **주수 레벨 gap·분류는 동작** — 가격은 델타 환산·주문 예상대금·매크로 커버
판정에만 쓰인다 (가격 결측 시 그 종목은 매크로 커버를 증명할 수 없어 보수적으로 미설명 처리).
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text

from core.database import korea_async_session

logger = logging.getLogger("uvicorn.error")

# 사용자 확정 승수. 주식선물은 원장에 이미 주수(계약×10)로 기장되므로 gap 계산엔 불필요
# (참고 상수). 지수선물은 계약 → 원 명목 승수: K200F 250,000 / 미니 50,000 / KQ150F 10,000.
STOCK_FUT_MULT = 10
_INDEX_FUT_MULT: dict[str, int] = {"01": 250_000, "05": 50_000, "06": 10_000}
# 지수선물 prefix(A+2자리) → 가족.
_INDEX_FUT_FAMILY: dict[str, str] = {"01": "k200", "05": "k200", "06": "kq150"}
# 가족 → Finance_Data 현물지수 코드 (지수선물가 프록시 = 현물지수 직전 종가, 베이시스 무시).
_FAMILY_INDEX_CODE: dict[str, str] = {"k200": "K2G01P", "kq150": "Q5G01P"}

# 기본 tolerance (파라미터화 — 요청 body로 override).
DEFAULT_TOL_ABS_SHARES = 1.0
DEFAULT_TOL_PCT = 0.005                   # |required|의 0.5%

# 상쇄/매크로 숨김 경고 임계 (H2, 파라미터화) — 주문 0인데 |gapδ|가 이 값 초과면
# "매크로(상쇄)" warning. 가족 gross 상쇄 경고의 절대 하한으로도 사용.
DEFAULT_OFFSET_WARN_KRW = 50_000_000.0
# 가족 gross/|net| 상쇄 경고 비율 임계.
OFFSET_GROSS_RATIO = 3.0

# "헤지 정합" 초록 배지 임계 — 미설명·선물 초과 δ가 이 값 미만이면 정합으로 간주
# (1원 기준은 정상 북에서도 라운딩 잔차로 배지가 안 뜨는 문제 → 100만원 채택).
FULLY_ALIGNED_KRW = 1_000_000.0

# ADV 임팩트 캡 — 리밸런싱 주문주수가 ADV20의 이 % 초과면 실현성 경고 (netting과 동일 휴리스틱).
ADV_CAP_PCT = 10.0


def _index_family_of(code: str) -> Optional[str]:
    """지수선물 8자리(A+2자리 prefix) → 'k200' | 'kq150'. 미상이면 None."""
    if len(code) >= 3 and code[0] == "A":
        return _INDEX_FUT_FAMILY.get(code[1:3])
    return None


def _index_mult_of(code: str) -> int:
    if len(code) >= 3 and code[0] == "A":
        return _INDEX_FUT_MULT.get(code[1:3], 1)
    return 1


async def _fetch_index_prev_close(session, index_codes: list[str]) -> dict[str, float]:
    """가족 현물지수 직전 거래일 종가 (지수선물가 프록시). index_ohlcv_daily raw close."""
    if not index_codes:
        return {}
    rows = (await session.execute(text(
        "SELECT DISTINCT ON (code) code, close FROM index_ohlcv_daily "
        "WHERE code = ANY(:codes) AND time < CURRENT_DATE AND close IS NOT NULL "
        "ORDER BY code, time DESC"
    ), {"codes": index_codes})).all()
    return {r.code: float(r.close) for r in rows}


async def build_hedge_recon(
    tol_abs_shares: float = DEFAULT_TOL_ABS_SHARES,
    tol_pct: float = DEFAULT_TOL_PCT,
    offset_warn_krw: float = DEFAULT_OFFSET_WARN_KRW,
) -> dict:
    """원장 스냅샷 → 헤지 정합 진단 (§13.12).

    반환 (routers/lp.py 응답과 1:1, types/lp.ts HedgeReconResponse):
        stocks[], index_route_etfs[], families{}, summary{}, tolerance_params{},
        etf_rollup[], rebalance_orders[], caveats[], as_of, n_etfs*
    """
    # 지연 import (순환 회피) — netting과 동일 패턴.
    from routers.etfs import _cache as etf_cache, _ensure_loaded, _norm_code
    from routers.lp import _QUOTE_UNIVERSE_FALLBACK, _load_futures_master
    from routers import lp as lp_router
    from services import lp_ledger
    from services.lp_netting import (
        FUTURES_BASED_ETFS,
        LEVERAGED_MIXED_ETFS,
        _fetch_pdf_on_demand,
        _fetch_prices_and_adv,
        _stock_future_bases,
    )
    from services.risk_estimator import get_risk_params

    tol_abs_shares = max(0.0, float(tol_abs_shares))
    tol_pct = max(0.0, float(tol_pct))
    offset_warn_krw = max(0.0, float(offset_warn_krw))
    index_route_etf_codes = FUTURES_BASED_ETFS | LEVERAGED_MIXED_ETFS

    await lp_ledger.ensure_schema_once()
    agg = await lp_ledger.aggregate()
    try:
        await _ensure_loaded()
    except Exception as e:  # noqa: BLE001
        logger.warning("hedge-recon: ETF 캐시 로드 실패 — %s", e)

    # 베타 (매크로 델타용). 실패해도 gap 진단은 동작 → 폴백 β=1.0.
    betas: dict[str, float] = {}
    try:
        risk = await get_risk_params()
        betas = {k: float(v) for k, v in (risk.get("betas") or {}).items()}
    except Exception as e:  # noqa: BLE001
        logger.warning("hedge-recon: risk-params 로드 실패 (β=1.0 폴백) — %s", e)

    _load_futures_master()
    fut_bases = _stock_future_bases()

    # ── 원장 분해 ──
    held_etfs = [a for a in agg.values() if a.get("instrument") == "etf" and a.get("net_qty", 0) != 0]
    spot_by_code: dict[str, int] = {}
    stockfut_by_base: dict[str, int] = {}
    index_fut_by_family: dict[str, float] = {}   # 부호 有 델타 KRW
    index_fut_positions: dict[str, list[dict]] = {}
    unresolved_stock_futs: list[str] = []        # base 미해석 주식선물 (LOW3 — 조용한 소실 방지)

    for a in agg.values():
        inst = a.get("instrument")
        nq = int(a.get("net_qty", 0) or 0)
        if nq == 0:
            continue
        if inst == "stock":
            spot_by_code[a["code"]] = spot_by_code.get(a["code"], 0) + nq
        elif inst == "stock_fut":
            base = lp_router._base_for(a["code"], "stock_fut")
            # 현물/PDF 키는 _norm_code 6자리 정규화 → 주식선물 base도 같은 정규화로 조인
            # (마스터 base_code 대부분 6자리 숫자지만 비정규 코드 방어).
            base = _norm_code(base) if base else None
            if base:
                stockfut_by_base[base] = stockfut_by_base.get(base, 0) + nq
            else:
                unresolved_stock_futs.append(a["code"])
        elif inst == "index_fut":
            fam = _index_family_of(a["code"])
            if fam:
                index_fut_positions.setdefault(fam, []).append({
                    "code": a["code"], "name": a.get("name"),
                    "net_qty": nq, "mult": _index_mult_of(a["code"]),
                })

    caveats: list[str] = [
        "무기억 진단 — 현재 원장 상태만 입력 (과거 체결·의도 기록 미사용).",
        "가격/ADV는 직전 거래일 종가·최근 20거래일 평균 거래량 프록시 (장중 실시간 아님).",
        "종목·주식선물 잔여 델타는 헤지 티켓과 동일하게 K200 단일 팩터(60일 OLS β)로 합산 — "
        "KQ150 구성종목 포함 (multi-factor §9.5 전 한계).",
        "커버리지는 가족 net 델타 기준 — 종목 간 상쇄된 스프레드 리스크는 잔차위험(#3)으로 관리.",
        "지수선물 델타는 현물지수 직전 종가 × 승수 프록시 (베이시스 무시).",
    ]

    # ── 요구 헤지 (종목별 required 누적) + ETF 롤업 + 지수선물경로 ETF ──
    required: dict[str, float] = {}                      # 종목 → required (부호 有 float)
    comp_names: dict[str, str] = {}
    etf_rollup: dict[str, list[dict]] = {}               # 종목 → [{etf_code, name, contribution}]
    index_route_etfs: list[dict] = []
    unknown_family_etfs: list[str] = []
    n_convertible = 0

    async with korea_async_session() as session:
        for a in held_etfs:
            code = a["code"]
            net_qty = int(a["net_qty"])
            meta = etf_cache.etfs.get(code, {})
            fb = _QUOTE_UNIVERSE_FALLBACK.get(code, {})
            name = a.get("name") or meta.get("name") or fb.get("name")
            family = fb.get("index_family")
            if family not in ("k200", "kq150"):
                # 유니버스 밖 지수경로 ETF — 가족 미상. k200 기본 + caveat.
                if family is None and code in index_route_etf_codes:
                    unknown_family_etfs.append(code)
                family = "k200"
            leverage = fb.get("leverage")

            # 지수선물경로 ETF (선물지수추종/레버리지) — PDF 환산 불가 → 요구 델타만.
            if code in index_route_etf_codes:
                index_route_etfs.append({
                    "code": code, "name": name, "net_qty": net_qty,
                    "family": family, "leverage": leverage,
                    "price": None, "required_delta_krw": None,
                    "reason": ("선물지수 추종 — PDF가 지수선물/스왑"
                               if code in FUTURES_BASED_ETFS
                               else "레버리지 — PDF가 현물+선물+타ETF 혼합"),
                })
                continue

            cu_unit = meta.get("cu_unit")
            pdf = etf_cache.pdfs.get(code)
            if pdf is None or cu_unit is None:
                od = await _fetch_pdf_on_demand(session, code)
                if od is not None:
                    if pdf is None and od["stocks"]:
                        pdf = {"stocks": od["stocks"]}
                    if cu_unit is None:
                        cu_unit = od["cu_unit"]
                    if not name:
                        name = od["name"]
            if not cu_unit or cu_unit <= 0 or pdf is None or not pdf.get("stocks"):
                index_route_etfs.append({
                    "code": code, "name": name, "net_qty": net_qty,
                    "family": family, "leverage": leverage,
                    "price": None, "required_delta_krw": None,
                    "reason": "PDF/creation_unit 결측 — 환산 불가",
                })
                continue

            n_convertible += 1
            units_signed = net_qty / cu_unit
            for s in pdf["stocks"]:
                sc = s.get("code")
                if not sc:
                    continue
                contrib = -units_signed * float(s.get("qty", 0) or 0)   # 롱 ETF → 숏(음수)
                required[sc] = required.get(sc, 0.0) + contrib
                if sc not in comp_names and s.get("name"):
                    comp_names[sc] = s["name"]
                etf_rollup.setdefault(sc, []).append({
                    "etf_code": code, "name": name, "contribution": contrib,
                })

        # ── 가격·ADV 일괄 조회 (요구 or 실제에 등장하는 전 종목 + 지수선물경로 ETF) ──
        stock_codes = set(required) | set(spot_by_code) | set(stockfut_by_base)
        price_query_codes = list(stock_codes) + [e["code"] for e in index_route_etfs]
        pxadv = await _fetch_prices_and_adv(session, list(dict.fromkeys(price_query_codes)))
        idx_prev = await _fetch_index_prev_close(session, list(_FAMILY_INDEX_CODE.values()))

    # ── 지수선물 가족 델타 (현물지수 프록시) ──
    idx_price_missing: list[str] = []
    for fam, positions in index_fut_positions.items():
        idx_px = idx_prev.get(_FAMILY_INDEX_CODE.get(fam, ""))
        if idx_px is None:
            # 현물지수 종가 결측 → 그 가족 지수선물 델타를 0으로 둘 수밖에 없어 매크로 커버가
            # 과소평가됨(미설명 과대) → 조용히 넘기지 말고 명시 (신선도·honest 원칙).
            idx_price_missing.append(fam)
            continue
        for p in positions:
            index_fut_by_family[fam] = index_fut_by_family.get(fam, 0.0) + p["net_qty"] * idx_px * p["mult"]

    # ── 지수선물경로 ETF 요구 델타 채우기 ──
    for e in index_route_etfs:
        info = pxadv.get(e["code"])
        price = info.get("price") if info else None
        e["price"] = price
        lev = e["leverage"] if e["leverage"] is not None else 1
        if price is not None:
            e["required_delta_krw"] = e["net_qty"] * price * lev   # 북 델타 (부호 有)

    # ── 종목별 gap — 미정합 gap 델타는 전부 K200 풀 (M1: 헤지 티켓 규칙과 통일).
    #    지수선물경로 ETF 요구 델타만 자기 가족 풀. 분류는 covered 확정 후 2패스. ──
    stock_rows: list[dict] = []
    family_needed: dict[str, float] = {}     # net (부호 有)
    family_gross: dict[str, float] = {}      # Σ|δ| (H2 — 부호 넷팅 은닉 방지)
    n_missing_price = 0

    for e in index_route_etfs:
        if e["required_delta_krw"] is not None:
            fam = e["family"]
            family_needed[fam] = family_needed.get(fam, 0.0) + e["required_delta_krw"]
            family_gross[fam] = family_gross.get(fam, 0.0) + abs(e["required_delta_krw"])

    for sc in sorted(set(required) | set(spot_by_code) | set(stockfut_by_base)):
        req = required.get(sc, 0.0)
        spot = spot_by_code.get(sc, 0)
        sfut = stockfut_by_base.get(sc, 0)
        actual = spot + sfut
        gap = actual - req
        tol = max(tol_abs_shares, abs(req) * tol_pct)
        info = pxadv.get(sc) or {}
        price = info.get("price")
        adv20 = info.get("adv20_vol")
        beta = betas.get(sc, 1.0)
        gap_delta = (gap * price * beta) if price is not None else None
        if price is None and abs(gap) > tol:
            n_missing_price += 1

        aligned = abs(gap) <= tol
        cls = None
        if aligned:
            cls = "aligned_spot" if abs(spot - req) <= tol else "alt_hedge"
        else:
            # 미정합 gap 델타 → K200 풀 (티켓과 동일 — β가 K200 단일 팩터).
            if gap_delta is not None:
                family_needed["k200"] = family_needed.get("k200", 0.0) + gap_delta
                family_gross["k200"] = family_gross.get("k200", 0.0) + abs(gap_delta)

        stock_rows.append({
            "code": sc,
            "name": comp_names.get(sc) or info.get("name"),
            "required": req,
            "actual": actual,
            "actual_spot": spot,
            "actual_stockfut": sfut,
            "gap": gap,
            "gap_delta_krw": gap_delta,
            "family": "k200",   # M1 — 종목 잔여 델타는 티켓과 동일하게 K200 풀
            "tolerance": tol,
            "price": price,
            "adv20_vol": adv20,
            "has_stock_future": sc in fut_bases,
            "_aligned_cls": cls,   # aligned면 확정, 아니면 None(2패스)
        })

    # ── 가족별 커버리지 (H1 — 부호 분리 + 단조) ──
    families: dict[str, dict] = {}
    for fam in set(family_needed) | set(family_gross) | set(index_fut_by_family) | {"k200", "kq150"}:
        needed = family_needed.get(fam, 0.0)
        gross = family_gross.get(fam, 0.0)
        fut = index_fut_by_family.get(fam, 0.0)
        # 반대 방향 선물만 커버로 인정: covered = min(|fut|,|needed|)/|needed| — fut에 단조.
        if needed != 0.0 and fut != 0.0 and (needed > 0) != (fut > 0):
            covered_krw = min(abs(fut), abs(needed))
            covered = covered_krw / abs(needed)
        else:
            covered_krw = 0.0
            covered = 0.0
        # 가산 항등: needed + fut = stock_unexplained + futures_excess.
        stock_unexplained = needed * (1.0 - covered)
        futures_excess = (needed + fut) - stock_unexplained
        # H2 — 부호 넷팅 은닉 경고: gross가 net보다 크게 크면 종목 간 상쇄가 커버를 가장.
        offset_warning = bool(
            gross > OFFSET_GROSS_RATIO * abs(needed) and gross > offset_warn_krw
        )
        families[fam] = {
            "family": fam,
            "needed_delta_krw": needed,
            "gross_delta_krw": gross,
            "index_fut_delta_krw": fut,
            "explained_delta_krw": covered_krw,
            "unexplained_delta_krw": stock_unexplained,
            "futures_excess_krw": futures_excess,
            "coverage_ratio": covered,
            "offset_warning": offset_warning,
            "index_fut_positions": index_fut_positions.get(fam, []),
        }

    # ── 2패스: 미정합 종목 분류 + 리밸런싱 주문 (covered_fraction 적용) ──
    #    종목 풀은 M1로 전부 K200 — covered도 K200 것 하나.
    covered_k200 = families.get("k200", {}).get("coverage_ratio", 0.0)
    rebalance_orders: list[dict] = []
    rebalance_gross = 0.0
    n_adv_capped = 0
    for row in stock_rows:
        if row["_aligned_cls"] is not None:
            row["classification"] = row["_aligned_cls"]
            row["order_side"] = None
            row["order_shares"] = 0
            row["order_notional"] = None
            row["adv_ratio"] = None
            row["adv_capped"] = False
            del row["_aligned_cls"]
            continue
        covered = covered_k200
        # 가격 없으면 매크로 커버 증명 불가 → 전량 미설명(covered=0).
        if row["gap_delta_krw"] is None:
            covered = 0.0
        order_shares = int(round(-row["gap"] * (1.0 - covered)))
        if abs(order_shares) >= 1:
            row["classification"] = "unexplained"
            side = "buy" if order_shares > 0 else "sell"
            shares = abs(order_shares)
            price = row["price"]
            est_notional = (shares * price) if price is not None else None
            adv20 = row["adv20_vol"]
            adv_ratio = (shares / adv20 * 100.0) if (adv20 and adv20 > 0) else None
            adv_capped = bool(adv_ratio is not None and adv_ratio > ADV_CAP_PCT)
            if adv_capped:
                n_adv_capped += 1
            if est_notional is not None:
                rebalance_gross += est_notional
            row["order_side"] = side
            row["order_shares"] = shares
            row["order_notional"] = est_notional
            row["adv_ratio"] = adv_ratio
            row["adv_capped"] = adv_capped
            rebalance_orders.append({
                "code": row["code"], "name": row["name"], "side": side,
                "shares": shares, "est_notional": est_notional,
                "adv_ratio": adv_ratio, "adv_capped": adv_capped,
                "has_stock_future": row["has_stock_future"],
            })
        else:
            # 주문 0 = 매크로 설명. 단 |gapδ|가 임계 초과면 "매크로(상쇄)" — net 커버 뒤에
            # 숨은 종목 스프레드 리스크를 숨기지 않는다 (H2).
            big_offset = (
                row["gap_delta_krw"] is not None
                and abs(row["gap_delta_krw"]) > offset_warn_krw
            )
            row["classification"] = "macro_offset" if big_offset else "macro"
            row["order_side"] = None
            row["order_shares"] = 0
            row["order_notional"] = None
            row["adv_ratio"] = None
            row["adv_capped"] = False
        del row["_aligned_cls"]

    # 미설명 우선 → 상쇄 → 매크로 → 대체 → 정합, 각 그룹 내 gap 델타 크기 순.
    _CLS_ORDER = {"unexplained": 0, "macro_offset": 1, "macro": 2, "alt_hedge": 3, "aligned_spot": 4}
    stock_rows.sort(key=lambda r: (
        _CLS_ORDER.get(r["classification"], 9),
        -(abs(r["gap_delta_krw"]) if r["gap_delta_krw"] is not None else 0.0),
        -abs(r["gap"]),
    ))

    # ── 요약 ──
    n_aligned_spot = sum(1 for r in stock_rows if r["classification"] == "aligned_spot")
    n_alt = sum(1 for r in stock_rows if r["classification"] == "alt_hedge")
    n_macro = sum(1 for r in stock_rows if r["classification"] == "macro")
    n_macro_offset = sum(1 for r in stock_rows if r["classification"] == "macro_offset")
    n_unexplained = sum(1 for r in stock_rows if r["classification"] == "unexplained")
    unexplained_by_family = {
        fam: f["unexplained_delta_krw"] for fam, f in families.items()
        if abs(f["unexplained_delta_krw"]) > 1e-6 or abs(f["needed_delta_krw"]) > 1e-6
    }
    futures_excess_by_family = {
        fam: f["futures_excess_krw"] for fam, f in families.items()
        if abs(f["futures_excess_krw"]) > 1e-6
    }
    unexplained_total = sum(abs(v) for v in unexplained_by_family.values())
    futures_excess_total = sum(abs(v) for v in futures_excess_by_family.values())

    if n_missing_price:
        caveats.append(
            f"가격 결측 {n_missing_price}종목 — 매크로 커버 판정 불가로 보수적 미설명 처리 "
            "(신규상장·거래정지 등)."
        )
    if idx_price_missing:
        caveats.append(
            f"현물지수 종가 결측 {', '.join(idx_price_missing)} — 해당 가족 지수선물 델타 0 처리로 "
            "매크로 커버 과소평가(미설명 과대) 가능."
        )
    if unknown_family_etfs:
        caveats.append(
            f"유니버스 밖 ETF {len(unknown_family_etfs)}종({', '.join(unknown_family_etfs)}) — "
            "가족 미상으로 k200 기본 배정 (매크로 델타 근사)."
        )
    if unresolved_stock_futs:
        caveats.append(
            f"기초 종목 미해석 주식선물 {len(unresolved_stock_futs)}건"
            f"({', '.join(unresolved_stock_futs[:5])}) — 정합 판정에서 제외됨 "
            "(futures_master 갱신 필요, 티켓 unmapped와 동일 케이스)."
        )
    caveats.append(
        "역할 분리: 이 보드는 종목 레벨 리밸런싱, 헤지 티켓은 북 델타 지수선물 마감. "
        "두 수치는 같은 델타의 회계 분해 — 리밸런싱 주문 실행·기장 후 티켓이 재계산되므로 "
        "티켓과 동시 실행 금지 (이중 헤지)."
    )

    # 초록 배지: 미설명 종목 0 + 미설명 δ·선물 초과 δ 모두 임계(100만원) 미만.
    fully_aligned = (
        n_unexplained == 0
        and unexplained_total < FULLY_ALIGNED_KRW
        and futures_excess_total < FULLY_ALIGNED_KRW
    )

    return {
        "as_of": etf_cache.loaded_at,
        "stocks": stock_rows,
        "index_route_etfs": index_route_etfs,
        "etf_rollup": etf_rollup,
        "families": families,
        "summary": {
            "n_stocks": len(stock_rows),
            "n_aligned_spot": n_aligned_spot,
            "n_alt_hedge": n_alt,
            "n_macro": n_macro,
            "n_macro_offset": n_macro_offset,
            "n_unexplained": n_unexplained,
            "unexplained_delta_by_family": unexplained_by_family,
            "unexplained_delta_total": unexplained_total,
            "futures_excess_by_family": futures_excess_by_family,
            "futures_excess_total": futures_excess_total,
            "n_rebalance_orders": len(rebalance_orders),
            "rebalance_gross_notional": rebalance_gross,
            "n_adv_capped": n_adv_capped,
            "fully_aligned": fully_aligned,
        },
        "rebalance_orders": rebalance_orders,
        "tolerance_params": {
            "abs_shares": tol_abs_shares,
            "pct": tol_pct,
            "offset_warn_krw": offset_warn_krw,
        },
        "adv_cap_pct": ADV_CAP_PCT,
        "n_etfs_held": len(held_etfs),
        "n_etfs_convertible": n_convertible,
        "n_etfs_index_route": len(index_route_etfs),
        "caveats": caveats,
    }
