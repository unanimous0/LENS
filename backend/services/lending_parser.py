import io
import pandas as pd


def parse_lending_file(file_bytes: bytes) -> dict:
    """xlsm 파일의 5개 시트를 파싱하여 정제된 DataFrame dict 반환."""
    buf = io.BytesIO(file_bytes)

    inquiry = _parse_inquiry(buf)
    holdings = _parse_holdings(buf)
    mm_funds = _parse_mm_funds(buf)
    restricted = _parse_restricted_funds(buf)
    repayments = _parse_repayments(buf)

    return {
        "inquiry": inquiry,
        "holdings": holdings,
        "mm_funds": mm_funds,
        "restricted_suffixes": restricted,
        "repayments": repayments,
    }


def _parse_inquiry(buf: io.BytesIO) -> pd.DataFrame:
    """문의종목 시트: 종목코드, 종목명, 최대수량, 요율."""
    df = pd.read_excel(buf, sheet_name="문의종목", engine="openpyxl")
    df = df.dropna(subset=[df.columns[0]])
    df.columns = ["stock_code", "stock_name", "max_qty", "rate"]
    df["stock_code"] = df["stock_code"].astype(str).str.zfill(6)
    df["max_qty"] = pd.to_numeric(df["max_qty"], errors="coerce").fillna(0).astype(int)
    df["rate"] = pd.to_numeric(df["rate"], errors="coerce").fillna(0)
    return df


def _parse_holdings(buf: io.BytesIO) -> pd.DataFrame:
    """원장RAW 시트: 펀드코드, 펀드명, 계정코드, 종목번호, 종목명, 잔고, 담보, 담보가능수량."""
    df = pd.read_excel(buf, sheet_name="원장RAW", engine="openpyxl")
    df = df.dropna(subset=[df.columns[1]])  # 펀드코드 기준

    df = df.iloc[:, :15]  # O,P,Q 함수열 제외 (A~N만)
    df.columns = [
        "book_code", "fund_code", "fund_name", "account_code",
        "stock_code_raw", "stock_name", "settlement_today", "t1_balance",
        "t2_balance", "collateral_locked", "lending", "collateral_free",
        "collateral_amount", "prev_close", "mm_flag",
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


def _parse_mm_funds(buf: io.BytesIO) -> set[str]:
    """MM펀드 시트: 제외할 펀드코드 set 반환."""
    df = pd.read_excel(buf, sheet_name="MM펀드", engine="openpyxl")
    codes = df.iloc[:, 0].dropna().astype(str).str.zfill(6)
    return set(codes)


def _parse_restricted_funds(buf: io.BytesIO) -> list[str]:
    """대여불가펀드 시트: 펀드코드 뒤 3자리 리스트 반환."""
    df = pd.read_excel(buf, sheet_name="대여불가펀드", engine="openpyxl")
    suffixes = df.iloc[:, 0].dropna().astype(str).tolist()
    return suffixes


def _parse_repayments(buf: io.BytesIO) -> pd.DataFrame:
    """상환예정내역 시트: 종목코드(6자리), 대차수량."""
    df = pd.read_excel(buf, sheet_name="상환예정내역", engine="openpyxl")
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
