"""상환가능확인 계산 로직 — 오피스 담보가능수량과 예탁원 대차내역 매칭"""
import pandas as pd


def deduct_repay_schedule(office: pd.DataFrame, repay: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """상환예정 수량을 오피스 담보가능수량에서 차감. 052 우선 → 담보가능수량 큰 순.
    Returns: (차감된 office, {종목코드: {펀드코드: 차감수량}})
    """
    office = office.copy()
    repay_by_stock = repay.groupby("종목번호")["상환예정수량"].sum().to_dict()
    deductions: dict[str, dict[str, int]] = {}  # {종목코드: {펀드코드: 차감량}}

    for stock_code, repay_qty in repay_by_stock.items():
        mask = office["종목번호"] == stock_code
        if not mask.any():
            continue

        stock_rows = office[mask].copy()
        if "계정코드" in stock_rows.columns:
            stock_rows = stock_rows.sort_values(
                by=["계정코드", "담보가능수량"],
                key=lambda s: s if s.name == "담보가능수량" else s.map(
                    lambda x: 0 if str(x).lstrip("0") == "52" else 1
                ),
                ascending=[True, False],
            )
        else:
            stock_rows = stock_rows.sort_values("담보가능수량", ascending=False)

        remaining = repay_qty
        stock_deductions: dict[str, int] = {}
        for idx in stock_rows.index:
            if remaining <= 0:
                break
            available = office.at[idx, "담보가능수량"]
            deduct = min(available, remaining)
            office.at[idx, "담보가능수량"] = available - deduct
            remaining -= deduct
            fund_code = str(office.at[idx, "펀드코드"])
            stock_deductions[fund_code] = stock_deductions.get(fund_code, 0) + deduct

        if stock_deductions:
            deductions[stock_code] = stock_deductions

    office = office[office["담보가능수량"] > 0].reset_index(drop=True)
    return office, deductions


def apply_filters(office: pd.DataFrame, esafe: pd.DataFrame, filters: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """계산 전 필터링 적용."""
    o = office.copy()
    e = esafe.copy()

    # MM펀드 제외
    if filters.get("mm_funds"):
        o = o[~o["펀드코드"].isin(filters["mm_funds"])]

    # 상환불가펀드 제외 (파일 기반)
    if filters.get("restricted_suffixes"):
        r_exact = [c for c in filters["restricted_suffixes"] if len(c) == 6]
        r_suffixes = [c for c in filters["restricted_suffixes"] if len(c) == 3]
        r_mask = pd.Series(False, index=o.index)
        if r_exact:
            r_mask = r_mask | o["펀드코드"].isin(r_exact)
        if r_suffixes:
            r_mask = r_mask | o["펀드코드"].str[-3:].isin(r_suffixes)
        o = o[~r_mask]

    # 5264 필터 (수동 입력)
    if filters["exclude_fund_codes"]:
        exact = [c for c in filters["exclude_fund_codes"] if len(c) == 6]
        suffixes = [c for c in filters["exclude_fund_codes"] if len(c) == 3]
        mask = pd.Series(False, index=o.index)
        if exact:
            mask = mask | o["펀드코드"].isin(exact)
        if suffixes:
            mask = mask | o["펀드코드"].str[-3:].isin(suffixes)
        o = o[~mask]
    if filters["exclude_office_stock_code"]:
        codes = [c.strip() for c in filters["exclude_office_stock_code"].split(",") if c.strip()]
        if codes:
            o = o[~o["종목번호"].isin(codes)]
    if filters["exclude_office_stock_name"]:
        names = [n.strip() for n in filters["exclude_office_stock_name"].split(",") if n.strip()]
        if names:
            o = o[~o["종목명"].isin(names)]

    # 예탁원 필터
    if filters.get("exclude_asset_mgmt"):
        e = e[~e["대여자명"].str.contains("운용", na=False)]
    if filters.get("exclude_securities"):
        e = e[~e["대여자명"].str.contains("증권", na=False)]
    if filters["exclude_lender"]:
        lenders = [l.strip() for l in filters["exclude_lender"].split(",") if l.strip()]
        if lenders:
            e = e[~e["대여자명"].isin(lenders)]
    if filters["exclude_fee_rate_below"] is not None:
        e = e[e["수수료율(%)"] > filters["exclude_fee_rate_below"]]
    if filters["exclude_dates"]:
        date_strs = set(filters["exclude_dates"])
        e = e[~e["체결일"].astype(str).str.replace(".0", "", regex=False).isin(date_strs)]
    if filters["exclude_esafe_stock_code"]:
        codes = [c.strip() for c in filters["exclude_esafe_stock_code"].split(",") if c.strip()]
        if codes:
            e = e[~e["단축코드"].isin(codes)]
    if filters["exclude_esafe_stock_name"]:
        names = [n.strip() for n in filters["exclude_esafe_stock_name"].split(",") if n.strip()]
        if names:
            e = e[~e["종목명"].isin(names)]

    return o.reset_index(drop=True), e.reset_index(drop=True)


def calculate_repayment(office: pd.DataFrame, esafe: pd.DataFrame) -> dict:
    """종목별 투 포인터 매칭으로 상환 계획을 산출한다.

    오피스: 담보가능수량 작은 순 (짜투리부터 소진)
    예탁원: 수수료율 높은 순 → 수량 작은 순 (비싼 차입부터 상환)

    Returns:
        {
            "matches": [...],           # 상환 매칭 내역
            "remaining_office": [...],   # 상환 후 남은 오피스 내역
            "remaining_esafe": [...],    # 상환 후 남은 예탁원 내역
            "no_esafe_stocks": [...],    # 예탁원에 없는 종목 (내부차입 추정)
            "summary": [...],           # 종목별 합산
            "total_qty": int,
            "total_amount": int,
        }
    """
    stock_codes = office["종목번호"].unique()

    all_matches = []
    all_remaining_office = []
    all_remaining_esafe = []
    all_no_esafe = []

    for code in stock_codes:
        o = office[office["종목번호"] == code].copy()
        e = esafe[esafe["단축코드"] == code].copy()

        if e["대차수량"].sum() == 0:
            all_no_esafe.append(o)
            continue

        # 오피스: 052 우선 → 담보가능수량 작은 순 (짜투리부터 소진)
        if "계정코드" in o.columns:
            o = o.sort_values(
                by=["계정코드", "담보가능수량"],
                key=lambda s: s if s.name == "담보가능수량" else s.map(
                    lambda x: 0 if str(x).lstrip("0") == "52" else 1
                ),
                ascending=[True, True],
            ).reset_index(drop=True)
        else:
            o = o.sort_values(["담보가능수량", "펀드코드"], ascending=True).reset_index(drop=True)
        # 예탁원: 수수료율 높은 순 → 수량 작은 순
        e = e.sort_values(["수수료율(%)", "대차수량"], ascending=[False, True]).reset_index(drop=True)

        matches = _match_two_pointer(o, e)
        all_matches.extend(matches)

        remaining_o = o[o["담보가능수량"] > 0]
        remaining_e = e[e["대차수량"] > 0]
        if len(remaining_o) > 0:
            all_remaining_office.append(remaining_o)
        if len(remaining_e) > 0:
            all_remaining_esafe.append(remaining_e)

    # 종목별 합산
    summary = _build_summary(all_matches)

    total_qty = sum(m["상환수량"] for m in all_matches)
    total_amount = sum(m["대차금액"] for m in all_matches)
    qty_052 = sum(m["상환수량"] for m in all_matches if m.get("계정코드", "").lstrip("0") == "52")
    qty_031 = sum(m["상환수량"] for m in all_matches if m.get("계정코드", "").lstrip("0") == "31")

    remaining_office = pd.concat(all_remaining_office).reset_index(drop=True).to_dict("records") if all_remaining_office else []
    remaining_esafe = pd.concat(all_remaining_esafe).reset_index(drop=True).to_dict("records") if all_remaining_esafe else []
    no_esafe = pd.concat(all_no_esafe).reset_index(drop=True).to_dict("records") if all_no_esafe else []

    return {
        "matches": all_matches,
        "remaining_office": remaining_office,
        "remaining_esafe": remaining_esafe,
        "no_esafe_stocks": no_esafe,
        "summary": summary,
        "total_qty": total_qty,
        "total_amount": total_amount,
        "qty_052": qty_052,
        "qty_031": qty_031,
    }


def _match_two_pointer(office: pd.DataFrame, esafe: pd.DataFrame) -> list[dict]:
    """투 포인터로 오피스 담보가능수량과 예탁원 대차수량을 매칭한다."""
    matches = []
    ix = 0
    iy = 0
    max_x = len(office)
    max_y = len(esafe)

    while ix < max_x and iy < max_y:
        x = office.at[ix, "담보가능수량"]
        y = esafe.at[iy, "대차수량"]

        if x <= 0:
            ix += 1
            continue
        if y <= 0:
            iy += 1
            continue

        repay = min(x, y)

        matches.append({
            "펀드코드": str(office.at[ix, "펀드코드"]),
            "펀드명": str(office.at[ix, "펀드명"]),
            "계정코드": str(office.at[ix, "계정코드"]) if "계정코드" in office.columns else "",
            "종목코드": str(office.at[ix, "종목번호"]),
            "종목명": str(office.at[ix, "종목명"]),
            "상환수량": int(repay),
            "체결일": _safe_str(esafe.at[iy, "체결일"]),
            "체결번호": int(esafe.at[iy, "체결번호"]),
            "대여자계좌": str(esafe.at[iy, "대여자계좌"]),
            "대여자명": str(esafe.at[iy, "대여자명"]),
            "수수료율": float(esafe.at[iy, "수수료율(%)"]),
            "기준가액": int(esafe.at[iy, "기준가액"]),
            "대차금액": int(esafe.at[iy, "기준가액"]) * int(repay),
        })

        office.at[ix, "담보가능수량"] -= repay
        esafe.at[iy, "대차수량"] -= repay

        if x > y:
            iy += 1
        elif x < y:
            ix += 1
        else:
            ix += 1
            iy += 1

    return matches


def _build_summary(matches: list[dict]) -> list[dict]:
    """종목별 상환 합산."""
    if not matches:
        return []

    by_stock: dict[str, dict] = {}
    for m in matches:
        code = m["종목코드"]
        if code not in by_stock:
            by_stock[code] = {
                "종목코드": code,
                "종목명": m["종목명"],
                "상환수량": 0,
                "대차금액": 0,
                "체결건수": 0,
                "최고수수료율": 0.0,
            }
        s = by_stock[code]
        s["상환수량"] += m["상환수량"]
        s["대차금액"] += m["대차금액"]
        s["체결건수"] += 1
        s["최고수수료율"] = max(s["최고수수료율"], m["수수료율"])

    return sorted(by_stock.values(), key=lambda x: x["대차금액"], reverse=True)


def _safe_str(val) -> str:
    """체결일 등의 값을 안전하게 문자열로 변환."""
    if pd.isna(val):
        return ""
    s = str(val)
    if s.endswith(".0"):
        s = s[:-2]
    return s
