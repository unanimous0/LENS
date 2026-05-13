"""차입/대여 탭 — 비용/수익 분석 + Rollover 상환 관리."""
import pandas as pd

from services.excel_reader import read_excel
from services.stock_code import normalize_series


def parse_esafe_for_borrowing(file_bytes: bytes, counterparty: str = "대여자") -> pd.DataFrame:
    """대차/대여내역 파일에서 분석에 필요한 컬럼 파싱.
    counterparty: "대여자" (차입 분석) 또는 "차입자" (대여 분석)
    """
    df = read_excel(file_bytes)

    account_col = f"{counterparty}계좌"
    name_col = f"{counterparty}명"

    required_base = [
        "단축코드", "종목명", "수수료율(%)", "대차수량", "대차가액",
        "체결일", "체결번호", "상환만기일", account_col, name_col,
    ]
    # Rollover 횟수는 대여내역에 없을 수 있음 (optional)
    has_rollover = "Rollover 횟수" in df.columns
    required = required_base + (["Rollover 횟수"] if has_rollover else [])

    for col in required:
        if col not in df.columns:
            raise ValueError(f"파일에 '{col}' 컬럼이 없습니다.")

    df = df[required].copy()
    # 컬럼명 통일: 상대방 → 대여자계좌/대여자명
    if counterparty != "대여자":
        df = df.rename(columns={account_col: "대여자계좌", name_col: "대여자명"})
    if not has_rollover:
        df["Rollover 횟수"] = 0
    df["대차수량"] = pd.to_numeric(df["대차수량"], errors="coerce").fillna(0).astype(int)
    df = df[df["대차수량"] > 0].copy()

    df["단축코드"] = normalize_series(df["단축코드"])
    df["수수료율(%)"] = pd.to_numeric(df["수수료율(%)"], errors="coerce").fillna(0)
    df["대차가액"] = pd.to_numeric(df["대차가액"], errors="coerce").fillna(0).astype(int)
    df["체결번호"] = pd.to_numeric(df["체결번호"], errors="coerce").fillna(0).astype(int)
    df["Rollover 횟수"] = pd.to_numeric(df["Rollover 횟수"], errors="coerce").fillna(0).astype(int)

    # 상환만기일: 정수(YYYYMMDD) 또는 문자열 → datetime
    df["상환만기일"] = pd.to_numeric(df["상환만기일"], errors="coerce").fillna(0).astype(int).astype(str)
    df["상환만기일"] = pd.to_datetime(df["상환만기일"], format="%Y%m%d", errors="coerce")
    # 체결일 → str (YYYYMMDD 형태 유지)
    df["체결일"] = pd.to_numeric(df["체결일"], errors="coerce").fillna(0).astype(int).astype(str)

    return df.reset_index(drop=True)


def calculate_borrowing(df: pd.DataFrame, expensive_threshold: float = 5.0, expensive_inclusive: bool = True) -> dict:
    """차입/대여 분석 결과 산출.

    expensive_threshold: 고비용 기준 수수료율(%). 단위는 % (예: 5.0 = 5%).
    expensive_inclusive: True면 이상(≥), False면 초과(>).

    기본값 5.0/True 는 대차거래 관행상 "고비용" 임계.
    이전 기본값(0.05/False)은 0.05%로 너무 낮아 거의 모든 종목이 고비용으로
    분류되는 버그였음 — borrowing 페이지가 그 기본값 사용 중이라 의미 깨졌음.
    """
    by_lender = _cost_by_group(df, group_cols=["대여자계좌", "대여자명"], include_details=True)
    by_stock = _cost_by_group(df, group_cols=["단축코드", "종목명"], include_details=True)

    expensive_df = df[df["수수료율(%)"] >= expensive_threshold] if expensive_inclusive else df[df["수수료율(%)"] > expensive_threshold]
    by_expensive = _cost_by_group(expensive_df, group_cols=["단축코드", "종목명"], include_details=True)

    # 전체 합산
    total_value = int(df["대차가액"].sum())
    total_wa_rate = _weighted_avg_rate(df)
    total_daily_cost = total_value * total_wa_rate / 100 / 365

    expensive_value = int(expensive_df["대차가액"].sum())
    expensive_wa_rate = _weighted_avg_rate(expensive_df)
    expensive_daily_cost = expensive_value * expensive_wa_rate / 100 / 365

    # Rollover 횟수 == 3
    rollover_df = df[df["Rollover 횟수"] >= 3].copy()
    rollover_items = []
    for _, row in rollover_df.iterrows():
        maturity = row["상환만기일"]
        rollover_items.append({
            "stock_code": row["단축코드"],
            "stock_name": row["종목명"],
            "maturity_date": maturity.strftime("%Y-%m-%d") if pd.notna(maturity) else "",
            "maturity_month": maturity.strftime("%Y-%m") if pd.notna(maturity) else "",
            "lender_account": str(row["대여자계좌"]),
            "lender_name": row["대여자명"],
            "settlement_date": row["체결일"],
            "settlement_no": int(row["체결번호"]),
            "qty": int(row["대차수량"]),
            "value": int(row["대차가액"]),
            "fee_rate": float(row["수수료율(%)"]),
            "rollover_count": int(row["Rollover 횟수"]),
        })

    # rollover 월 목록 추출
    rollover_months = sorted(set(
        item["maturity_month"] for item in rollover_items if item["maturity_month"]
    ))

    return {
        "summary": {
            "total_value": total_value,
            "total_wa_rate": round(total_wa_rate, 4),
            "total_daily_cost": round(total_daily_cost),
            "expensive_value": expensive_value,
            "expensive_wa_rate": round(expensive_wa_rate, 4),
            "expensive_daily_cost": round(expensive_daily_cost),
            "total_count": len(df),
            "expensive_count": len(expensive_df),
            "rollover_count": len(rollover_items),
        },
        "by_lender": by_lender,
        "by_stock": by_stock,
        "by_expensive": by_expensive,
        "rollover_items": rollover_items,
        "rollover_months": rollover_months,
    }


def _weighted_avg_rate(df: pd.DataFrame) -> float:
    """가중평균 수수료율 (%) = sum(rate * value) / sum(value)."""
    total_value = df["대차가액"].sum()
    if total_value == 0:
        return 0.0
    return float((df["수수료율(%)"] * df["대차가액"]).sum() / total_value)


def _cost_by_group(df: pd.DataFrame, group_cols: list[str], include_details: bool = False) -> list[dict]:
    """그룹별 가중평균 수수료, 총 대차가액, 일일 비용 산출."""
    if df.empty:
        return []

    grouped = df.groupby(group_cols, sort=False)
    agg = grouped.agg(
        total_value=("대차가액", "sum"),
        total_qty=("대차수량", "sum"),
        count=("대차수량", "count"),
        weighted_fee=("대차가액", lambda x: (df.loc[x.index, "수수료율(%)"] * x).sum()),
    ).reset_index()

    agg["wa_rate"] = agg["weighted_fee"] / agg["total_value"]
    agg["wa_rate"] = agg["wa_rate"].fillna(0)
    agg["daily_cost"] = agg["total_value"] * agg["wa_rate"] / 100 / 365

    # 상세 내역 미리 그룹화
    detail_map: dict[tuple, list[dict]] = {}
    if include_details:
        for key, grp in grouped:
            k = key if isinstance(key, tuple) else (key,)
            details = []
            for _, r in grp.iterrows():
                details.append({
                    "lender": str(r.get("대여자명", "")),
                    "lender_account": str(r.get("대여자계좌", "")),
                    "stock_code": str(r.get("단축코드", "")),
                    "stock_name": str(r.get("종목명", "")),
                    "fee_rate": round(float(r["수수료율(%)"]), 4),
                    "qty": int(r["대차수량"]),
                    "value": int(r["대차가액"]),
                    "settlement_date": str(r.get("체결일", "")),
                    "settlement_no": int(r.get("체결번호", 0)),
                })
            details.sort(key=lambda x: x["value"] * x["fee_rate"], reverse=True)
            detail_map[k] = details

    results = []
    for _, row in agg.iterrows():
        item = {}
        for col in group_cols:
            item[col] = str(row[col])
        item["total_value"] = int(row["total_value"])
        item["total_qty"] = int(row["total_qty"])
        item["count"] = int(row["count"])
        item["wa_rate"] = round(float(row["wa_rate"]), 4)
        item["daily_cost"] = round(float(row["daily_cost"]))
        if include_details:
            k = tuple(str(row[col]) for col in group_cols)
            item["details"] = detail_map.get(k, [])
        results.append(item)

    # 일일 비용 내림차순 정렬
    results.sort(key=lambda x: x["daily_cost"], reverse=True)
    return results
