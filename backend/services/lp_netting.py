"""넷팅 바스켓 빌더 (§13.3-D 메인 출구 · §13.2) — Phase 5.

보유 ETF 재고 전체의 PDF를 합산해 종목별 순 주수 실행 주문표를 만든다. 사용자가
정리 시점에 수동으로 하던 "보유 ETF들의 넷팅 바스켓" 작업의 자동화. 실시간 스트림이
아니라 **버튼 트리거 스냅샷 계산** (backend REST, `POST /api/lp/netting-basket`).

핵심 개념 (§13.2):
    보유 ETF 롱 = 그 ETF PDF 종목을 합성적으로 롱. 정리하려면 바스켓을 **매도**.
    보유 ETF 숏 = 바스켓 **매수**로 청산.
    여러 ETF를 함께 들면 겹치는 PDF 종목이 상쇄(넷팅)되어 실제 실행 주수가 줄어든다.

부호 규약:
    units_signed(ETF) = net_qty / cu_unit           (ETF 부호 유지)
    종목별 주문 기여   = − units_signed × pdf_shares  (롱 ETF → 음수 = 매도 leg)
    종목별 순 주문     = Σ_ETF 기여 (float 누적) → **최종 1회 반올림**(round-half-to-even)
    side = 'buy'(순 주문 > 0) | 'sell'(< 0). 0주는 leg에서 제외.

반올림: ETF마다 반올림하면 겹침 종목의 상쇄가 깨져 잔여 주수가 부풀 수 있어, 종목별로
float을 끝까지 누적한 뒤 **한 번만** round() (banker's) 한다.

futures_based ETF(114800·252670·251340)와 레버리지 ETF(122630·233740)는 PDF가
지수선물/스왑(+타 ETF) 혼합이라 현물 종목으로 환산 불가 → `excluded`로 사유와 함께 반환
(단, 설정/환매 출구에는 여전히 포함되므로 `etf_holdings`에는 남긴다).

비용 추정:
    (a) 매도 leg 거래세 tax_sell_bp (cost-inputs, 기본 20bp). 매수 leg 0.
    (b) ADV 임팩트 — |주문주수| / ADV20(20일 평균 거래량, ohlcv_daily) 비율 + 캡 초과 플래그.
        (백테스트 C4 ADV 캡과 같은 "포지션 vs ADV" 아이디어 재활용. 단위만 주수/거래량.)
    (c) 종목 스프레드 비용은 실시간 호가가 필요 → v1 생략 (caveat).

가격/ADV 소스: Finance_Data `ohlcv_daily` (직전 완결 거래일 close = 현재가 프록시,
최근 20거래일 평균 volume = ADV20). read-only.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text

from core.database import korea_async_session
from routers.etfs import _cache as etf_cache, _ensure_loaded, _norm_code
from services import futures_master as fut_master
from services import lp_ledger

logger = logging.getLogger("uvicorn.error")

# 선물지수 추종 ETF — PDF가 선물/스왑이라 현물 바스켓 환산 불가 (routers/lp.py 정본과 동일).
FUTURES_BASED_ETFS = {"114800", "252670", "251340"}

# 레버리지 ETF — PDF가 현물 + 지수선물 + 타 ETF 혼합이라 현물 leg만 환산하면 실델타(2x)의
# ~50%만 커버하는 주문표가 무경고 생성됨 (122630 실측: 주식 8,769M + K200F 27계약 8,802M
# ≈ NAV 8,860M의 2x 노출). 게다가 PDF에 069500 등 타 ETF 성분이 leg로 등장 → excluded.
# etf_holdings에는 잔존 (설정/환매 출구 참조 — futures_based 처리와 동일).
LEVERAGED_MIXED_ETFS = {"122630", "233740"}

# ADV 임팩트 캡 — 단일 leg 주문주수가 ADV20의 이 % 초과면 실현성 경고 (v1 휴리스틱).
ADV_CAP_PCT = 10.0

# 주식선물 base_code 캐시 (mtime 무관 — 요청당 1회 재빌드는 저렴, 273종).
def _stock_future_bases() -> set[str]:
    """주식선물 상장 종목의 기초 6자리 코드 set. futures_master.json items[].base_code."""
    master = fut_master.load_master()
    if not master:
        return set()
    out: set[str] = set()
    for item in master.get("items", []):
        base = item.get("base_code")
        if base:
            c = _norm_code(str(base))
            if c:
                out.add(c)
    return out


async def _fetch_pdf_on_demand(session, code: str) -> Optional[dict]:
    """etf_cache에 없는 ETF의 PDF를 on-demand 조회.

    마스터/PDF snapshot_date를 **독립 MAX**로 잡는다 (§9.8 버그1 방어 — 한쪽만 새 날짜로
    들어온 짧은 윈도우에 PDF 0 rows가 되는 것 방지). 반환: {cu_unit, name, stocks[], cash}.
    """
    master = (await session.execute(text(
        "SELECT kr_name, creation_unit FROM etf_master_daily "
        "WHERE etf_code = :c AND snapshot_date = "
        "(SELECT MAX(snapshot_date) FROM etf_master_daily WHERE etf_code = :c)"
    ), {"c": code})).first()
    rows = (await session.execute(text(
        "SELECT component_code, component_name, shares, is_cash FROM etf_portfolio_daily "
        "WHERE etf_code = :c AND snapshot_date = "
        "(SELECT MAX(snapshot_date) FROM etf_portfolio_daily WHERE etf_code = :c)"
    ), {"c": code})).all()
    if not rows:
        return None
    stocks: list[dict] = []
    cash = 0
    for r in rows:
        if r.is_cash:
            # 설정현금액(H00000) = CU 전체 설정금액 summary 행 — cash 성분 아님 (etfs.py와
            # 동일 규칙: 122630 실측 H00000 = NAV×CU). 원화현금 등만 SUM.
            code_u = (str(r.component_code) if r.component_code else "").strip().upper()
            if code_u != "H00000" and "설정현금" not in (r.component_name or ""):
                cash += int(r.shares or 0)
            continue
        nc = _norm_code(r.component_code)
        if not nc:
            continue
        stocks.append({"code": nc, "name": (r.component_name or "").strip(), "qty": int(r.shares or 0)})
    return {
        "cu_unit": master.creation_unit if master else None,
        "name": master.kr_name if master else None,
        "stocks": stocks,
        "cash": cash,
    }


async def _fetch_prices_and_adv(session, codes: list[str]) -> dict[str, dict]:
    """종목별 (직전 close = 현재가 프록시, ADV20 = 최근 20거래일 평균 volume).

    수정주가(adj_close) 아닌 **raw close**를 현재가 프록시로 쓴다 — 최신 거래일 raw close가
    실제 체결가에 가장 가까움(과거 back-adjust는 최신 행엔 미적용). ADV는 raw volume 평균.
    """
    if not codes:
        return {}
    rows = (await session.execute(text(
        """
        WITH recent AS (
            SELECT stock_code, close_price, volume,
                   ROW_NUMBER() OVER (PARTITION BY stock_code ORDER BY time DESC) AS rn
            FROM ohlcv_daily
            WHERE stock_code = ANY(:codes) AND time < CURRENT_DATE
        )
        SELECT stock_code,
               MAX(close_price) FILTER (WHERE rn = 1)     AS last_close,
               AVG(volume) FILTER (WHERE rn <= 20)        AS adv20_vol,
               COUNT(*) FILTER (WHERE rn <= 20)           AS n
        FROM recent
        WHERE rn <= 20
        GROUP BY stock_code
        """
    ), {"codes": codes})).all()
    out: dict[str, dict] = {}
    for r in rows:
        out[r.stock_code] = {
            "price": float(r.last_close) if r.last_close is not None else None,
            "adv20_vol": float(r.adv20_vol) if r.adv20_vol is not None else None,
            "adv_n": int(r.n or 0),
        }
    return out


async def build_netting_basket() -> dict:
    """원장 ETF 재고 → 넷팅 바스켓 실행 주문표 스냅샷.

    반환 (routers/lp.py 응답과 1:1):
        legs: [{code, name, side, shares, est_notional, adv_ratio, adv_capped, tax_bp, has_stock_future}]
        cash_residual: 현금분 순합 (원)
        excluded: [{etf_code, name, reason}]  (futures_based / PDF·CU 결측)
        etf_holdings: [{code, name, net_qty, cu_unit, units_exact, cu_count, price, notional,
                        futures_based, basket_eligible}]  (설정/환매 출구·재고명목 소스)
        inventory_notional_krw: 재고 총 명목 (전 ETF, 억 아님 원)
        totals, caveats, adv_cap_pct
    """
    await lp_ledger.ensure_schema_once()
    agg = await lp_ledger.aggregate()
    try:
        await _ensure_loaded()
    except Exception as e:  # noqa: BLE001
        logger.warning("netting-basket: ETF 캐시 로드 실패 — %s", e)

    # 보유 ETF (instrument=='etf', net!=0)
    held = [a for a in agg.values() if a.get("instrument") == "etf" and a.get("net_qty", 0) != 0]

    fut_bases = _stock_future_bases()
    caveats: list[str] = [
        "종목 스프레드 비용은 실시간 호가가 필요해 v1 생략 (거래세·ADV 임팩트만 반영).",
        "가격/ADV는 직전 거래일 종가·최근 20거래일 평균 거래량 프록시 (장중 실시간 아님).",
        "종목별 float 누적 후 최종 1회 반올림(round-half-to-even) — 0주 leg는 제외.",
    ]

    # ── 종목별 float 누적 + ETF holdings + excluded ──
    comp_shares: dict[str, float] = {}   # 6자리 → 순 주문주수 (float, +매수/−매도)
    comp_names: dict[str, str] = {}
    cash_residual = 0.0
    holdings: list[dict] = []
    excluded: list[dict] = []

    async with korea_async_session() as session:
        for a in held:
            code = a["code"]
            net_qty = int(a["net_qty"])
            meta = etf_cache.etfs.get(code, {})
            pdf = etf_cache.pdfs.get(code)
            name = a.get("name") or meta.get("name")
            cu_unit = meta.get("cu_unit")

            # on-demand 보강 (캐시 miss)
            if pdf is None or cu_unit is None:
                od = await _fetch_pdf_on_demand(session, code)
                if od is not None:
                    if pdf is None and od["stocks"]:
                        pdf = {"stocks": od["stocks"], "cash": od["cash"]}
                    if cu_unit is None:
                        cu_unit = od["cu_unit"]
                    if not name:
                        name = od["name"]

            futures_based = code in FUTURES_BASED_ETFS
            leveraged = code in LEVERAGED_MIXED_ETFS
            cu_count = (abs(net_qty) // cu_unit) if (cu_unit and cu_unit > 0) else 0
            units_exact = (net_qty / cu_unit) if (cu_unit and cu_unit > 0) else None

            basket_eligible = (
                (not futures_based) and (not leveraged)
                and pdf is not None and cu_unit and cu_unit > 0
            )

            holdings.append({
                "code": code,
                "name": name,
                "net_qty": net_qty,
                "cu_unit": cu_unit,
                "units_exact": units_exact,
                "cu_count": int(cu_count),
                "price": None,          # 아래에서 채움
                "notional": None,
                "futures_based": futures_based,
                "basket_eligible": bool(basket_eligible),
            })

            if futures_based:
                excluded.append({
                    "etf_code": code, "name": name,
                    "reason": "선물지수 추종 ETF — PDF가 지수선물/스왑이라 현물 바스켓 환산 불가",
                })
                continue
            if leveraged:
                excluded.append({
                    "etf_code": code, "name": name,
                    "reason": "레버리지 (스왑·선물 혼합 PDF) — 현물 바스켓 환산 불가 (현물 leg만으론 실델타 ~50%)",
                })
                continue
            if cu_unit is None or cu_unit <= 0:
                excluded.append({"etf_code": code, "name": name, "reason": "creation_unit 결측 — 환산 불가"})
                continue
            if pdf is None or not pdf.get("stocks"):
                excluded.append({"etf_code": code, "name": name, "reason": "PDF 구성종목 없음"})
                continue

            units_signed = net_qty / cu_unit
            for s in pdf["stocks"]:
                sc = s["code"]
                if not sc:
                    continue
                # 롱 ETF(units_signed>0) → 매도(음수) 기여
                comp_shares[sc] = comp_shares.get(sc, 0.0) + (-units_signed * s["qty"])
                if sc not in comp_names and s.get("name"):
                    comp_names[sc] = s["name"]
            cash_residual += -units_signed * float(pdf.get("cash", 0) or 0)

        # ── 가격·ADV 일괄 조회 (종목 + ETF) ──
        rounded: dict[str, int] = {}
        for sc, fsh in comp_shares.items():
            r = int(round(fsh))  # banker's rounding
            if r != 0:
                rounded[sc] = r
        price_codes = list(rounded.keys()) + [h["code"] for h in holdings]
        pxadv = await _fetch_prices_and_adv(session, list(dict.fromkeys(price_codes)))

    # ── ETF holdings 가격/명목 채우고 재고 명목 합산 ──
    inventory_notional = 0.0
    for h in holdings:
        info = pxadv.get(h["code"])
        if info and info["price"] is not None:
            h["price"] = info["price"]
            h["notional"] = abs(h["net_qty"]) * info["price"]
            inventory_notional += h["notional"]

    # ── legs 빌드 ──
    from routers.lp import _read_json, COST_INPUTS_PATH, DEFAULT_COST_INPUTS  # 지연 import (순환 회피)
    cost_inputs = _read_json(COST_INPUTS_PATH, DEFAULT_COST_INPUTS)
    tax_sell_bp = float(cost_inputs.get("tax_sell_bp", 20.0))

    legs: list[dict] = []
    buy_notional = 0.0
    sell_notional = 0.0
    est_tax = 0.0
    n_adv_capped = 0
    n_missing_price = 0

    for sc, shares_signed in rounded.items():
        side = "buy" if shares_signed > 0 else "sell"
        shares = abs(shares_signed)
        info = pxadv.get(sc) or {}
        price = info.get("price")
        adv20 = info.get("adv20_vol")
        est_notional = (shares * price) if price is not None else None
        adv_ratio = (shares / adv20 * 100.0) if (adv20 and adv20 > 0) else None
        adv_capped = bool(adv_ratio is not None and adv_ratio > ADV_CAP_PCT)
        tax_bp = tax_sell_bp if side == "sell" else 0.0

        if est_notional is None:
            n_missing_price += 1
        else:
            if side == "buy":
                buy_notional += est_notional
            else:
                sell_notional += est_notional
                est_tax += est_notional * tax_sell_bp / 1e4
        if adv_capped:
            n_adv_capped += 1

        legs.append({
            "code": sc,
            "name": comp_names.get(sc),
            "side": side,
            "shares": shares,
            "est_notional": est_notional,
            "adv_ratio": adv_ratio,
            "adv_capped": adv_capped,
            "tax_bp": tax_bp,
            "has_stock_future": sc in fut_bases,
        })

    # 명목 큰 순 정렬 (없으면 주수 순)
    legs.sort(key=lambda l: (l["est_notional"] or 0, l["shares"]), reverse=True)

    if n_missing_price:
        caveats.append(f"가격 결측 {n_missing_price}종목 — 명목/거래세 미산입 (신규상장·거래정지 등).")

    totals = {
        "n_legs": len(legs),
        "n_buy": sum(1 for l in legs if l["side"] == "buy"),
        "n_sell": sum(1 for l in legs if l["side"] == "sell"),
        "buy_notional": buy_notional,
        "sell_notional": sell_notional,
        "gross_notional": buy_notional + sell_notional,
        "net_notional": buy_notional - sell_notional,   # +면 순매수(현금 유출)
        "est_tax_krw": est_tax,
        "n_adv_capped": n_adv_capped,
    }

    return {
        "legs": legs,
        "cash_residual": cash_residual,
        "excluded": excluded,
        "etf_holdings": holdings,
        "inventory_notional_krw": inventory_notional,
        "totals": totals,
        "adv_cap_pct": ADV_CAP_PCT,
        "caveats": caveats,
        "n_etfs_held": len(held),
    }
