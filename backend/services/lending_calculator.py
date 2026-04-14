import pandas as pd


def calculate_availability(
    inquiry: pd.DataFrame,
    holdings: pd.DataFrame,
    mm_funds: set[str],
    restricted_suffixes: list[str],
    repayments: pd.DataFrame,
) -> list[dict]:
    """문의종목 기준 대여 가능 내역 산출.

    1. 문의종목과 원장 매칭
    2. MM펀드 제외
    3. 대여불가펀드 제외
    4. 상환예정 수량 차감 (052 우선 → 큰 수량 순 → 분산)
    5. 종목별 담보가능/담보잡힌/합산 집계
    """
    # 중복 종목코드 제거 (첫 번째 유지)
    inquiry = inquiry.drop_duplicates(subset="stock_code", keep="first")
    inquiry_codes = set(inquiry["stock_code"])

    # 1. 문의종목만 필터
    df = holdings[holdings["stock_code"].isin(inquiry_codes)].copy()

    # 2. MM펀드 제외
    df = df[~df["fund_code"].isin(mm_funds)]

    # 3. 대여불가펀드 제외 (펀드코드 뒤 3자리)
    exact = [c for c in restricted_suffixes if len(c) == 6]
    suffixes = [c for c in restricted_suffixes if len(c) == 3]
    mask = pd.Series(False, index=df.index)
    if exact:
        mask = mask | df["fund_code"].isin(exact)
    if suffixes:
        mask = mask | df["fund_code"].str[-3:].isin(suffixes)
    df = df[~mask]

    # 4. 상환예정 수량 종목별 합산
    repay_by_stock = (
        repayments.groupby("stock_code")["repay_qty"]
        .sum()
        .to_dict()
    )

    # 상환 차감 적용 + 결과 조립
    inquiry_map = inquiry.set_index("stock_code").to_dict("index")
    results = []

    for stock_code in sorted(inquiry_codes):
        info = inquiry_map[stock_code]
        stock_holdings = df[df["stock_code"] == stock_code].copy()

        if stock_holdings.empty:
            results.append(_empty_result(stock_code, info))
            continue

        # 상환 차감: 계정코드 052 우선 → 담보가능수량 내림차순
        repay_remaining = repay_by_stock.get(stock_code, 0)
        stock_holdings = stock_holdings.sort_values(
            by=["account_code", "collateral_free"],
            key=lambda s: s if s.name == "collateral_free" else s.map(
                lambda x: 0 if str(x).lstrip("0") == "52" else 1
            ),
            ascending=[True, False],
        )

        deductions = []
        for idx in stock_holdings.index:
            if repay_remaining <= 0:
                deductions.append(0)
                continue
            available = stock_holdings.at[idx, "collateral_free"]
            deduct = min(available, repay_remaining)
            stock_holdings.at[idx, "collateral_free"] = available - deduct
            repay_remaining -= deduct
            deductions.append(deduct)

        stock_holdings["repayment_deducted"] = deductions

        # 펀드별 상세
        funds = []
        for _, row in stock_holdings.iterrows():
            funds.append({
                "fund_code": row["fund_code"],
                "fund_name": row["fund_name"],
                "account_code": str(row["account_code"]),
                "settlement_balance": int(row["settlement_today"]),
                "collateral_free": int(row["collateral_free"]),
                "collateral_locked": int(row["collateral_locked"]),
                "lending": int(row["lending"]),
                "repayment_deducted": int(row["repayment_deducted"]),
            })

        total_free = sum(f["collateral_free"] for f in funds)
        total_locked = sum(f["collateral_locked"] for f in funds)
        total_combined = total_free + total_locked
        repay_scheduled = repay_by_stock.get(stock_code, 0)

        results.append({
            "stock_code": stock_code,
            "stock_name": info["stock_name"],
            "requested_qty": int(info["max_qty"]),
            "rate": float(info["rate"]),
            "total_free": total_free,
            "total_locked": total_locked,
            "total_combined": total_combined,
            "repay_scheduled": repay_scheduled,
            "meets_request": total_combined >= int(info["max_qty"]),
            "funds": funds,
        })

    return results


def _empty_result(stock_code: str, info: dict) -> dict:
    return {
        "stock_code": stock_code,
        "stock_name": info["stock_name"],
        "requested_qty": int(info["max_qty"]),
        "rate": float(info["rate"]),
        "total_free": 0,
        "total_locked": 0,
        "total_combined": 0,
        "repay_scheduled": 0,
        "meets_request": False,
        "funds": [],
    }
