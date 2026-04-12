"""차입 탭 — 비용 분석 + Rollover 상환 관리."""
import io
from datetime import datetime

import pandas as pd


def parse_esafe_for_borrowing(file_bytes: bytes) -> pd.DataFrame:
    """대차내역 파일에서 차입 분석에 필요한 컬럼 파싱."""
    buf = io.BytesIO(file_bytes)
    try:
        df = pd.read_excel(buf, engine="openpyxl")
    except Exception:
        buf.seek(0)
        df = pd.read_excel(buf, engine="xlrd")

    required = [
        "단축코드", "종목명", "수수료율(%)", "대차수량", "대차가액",
        "체결일", "체결번호", "상환만기일", "대여자계좌", "대여자명",
        "Rollover 횟수",
    ]
    for col in required:
        if col not in df.columns:
            raise ValueError(f"대차내역 파일에 '{col}' 컬럼이 없습니다.")

    df = df[required].copy()
    df["대차수량"] = pd.to_numeric(df["대차수량"], errors="coerce").fillna(0).astype(int)
    df = df[df["대차수량"] > 0].copy()

    df["단축코드"] = df["단축코드"].astype(str).str.zfill(6)
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


def calculate_borrowing(df: pd.DataFrame) -> dict:
    """차입 비용 분석 + Rollover 관리 결과 산출."""
    by_lender = _cost_by_group(df, group_cols=["대여자계좌", "대여자명"], include_details=True)
    by_stock = _cost_by_group(df, group_cols=["단축코드", "종목명"], include_details=True)

    # 고비용: 수수료율 > 0.05%
    expensive_df = df[df["수수료율(%)"] > 0.05]
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
