"""상환가능확인 계산 로직 — 오피스 담보가능수량과 예탁원 대차내역 매칭"""
import pandas as pd


def apply_filters(office: pd.DataFrame, esafe: pd.DataFrame, filters: dict) -> tuple[pd.DataFrame, pd.DataFrame]:
    """계산 전 필터링 적용."""
    o = office.copy()
    e = esafe.copy()

    # 5264 필터
    if filters["exclude_fund_codes"]:
        o = o[~o["펀드코드"].isin(filters["exclude_fund_codes"])]
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

        # 오피스: 담보가능수량 작은 순 → 펀드코드 순
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
