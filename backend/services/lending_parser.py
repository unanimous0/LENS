import pandas as pd

from services.excel_reader import read_excel


def parse_inquiry(file_bytes: bytes) -> pd.DataFrame:
    """대여문의종목 파일: 종목코드, 종목명, 최대수량, 요율."""
    df = read_excel(file_bytes)
    df = df.dropna(subset=[df.columns[0]])
    df.columns = ["stock_code", "stock_name", "max_qty", "rate"]
    df["stock_code"] = df["stock_code"].astype(str).str.zfill(6)
    df["max_qty"] = pd.to_numeric(df["max_qty"], errors="coerce").fillna(0).astype(int)
    df["rate"] = pd.to_numeric(df["rate"], errors="coerce").fillna(0)
    return df


def parse_holdings(file_bytes: bytes) -> pd.DataFrame:
    """5264(원장RAW) 파일: 펀드코드, 펀드명, 계정코드, 종목번호, 종목명, 잔고, 담보, 담보가능수량."""
    df = read_excel(file_bytes)
    df = df.dropna(subset=[df.columns[1]])  # 펀드코드 기준

    df = df.iloc[:, :14]  # A~N열만 사용 (O,P,Q 함수열 제외)
    df.columns = [
        "book_code", "fund_code", "fund_name", "account_code",
        "stock_code_raw", "stock_name", "settlement_today", "t1_balance",
        "t2_balance", "collateral_locked", "lending", "collateral_free",
        "collateral_amount", "prev_close",
    ]

    # 종목코드 정규화: A005930 → 005930
    df["stock_code"] = (
        df["stock_code_raw"]
        .astype(str)
        .str.replace(r"^A", "", regex=True)
        .str.zfill(6)
    )
    df["fund_code"] = df["fund_code"].astype(str).str.zfill(6)
    df["account_code"] = df["account_code"].astype(str).str.strip().str.zfill(3)

    for col in ["settlement_today", "collateral_locked", "collateral_free", "lending"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0).astype(int)

    return df


def parse_mm_funds(file_bytes: bytes) -> set[str]:
    """MM펀드 파일: 제외할 펀드코드 set 반환."""
    df = read_excel(file_bytes)
    codes = df.iloc[:, 0].dropna().astype(str).str.zfill(6)
    return set(codes)


def parse_restricted_funds(file_bytes: bytes) -> list[str]:
    """대여불가펀드 파일: 제외할 펀드코드 suffix 리스트 반환."""
    df = read_excel(file_bytes)
    codes = df.iloc[:, 0].dropna().astype(str).str.strip()
    return [c for c in codes if c]


def parse_repayments(file_bytes: bytes) -> pd.DataFrame:
    """상환예정내역 파일: 종목코드(6자리), 대차수량."""
    df = read_excel(file_bytes)
    df = df.dropna(subset=[df.columns[3]])  # D열 종목코드 기준

    result = pd.DataFrame()
    # D열(index 3): ISIN KR7005930003 → [3:9] = 005930
    result["stock_code"] = (
        df.iloc[:, 3]
        .astype(str)
        .str[3:9]
    )
    # J열(index 9): 대차수량
    result["repay_qty"] = pd.to_numeric(df.iloc[:, 9], errors="coerce").fillna(0).astype(int)

    return result
