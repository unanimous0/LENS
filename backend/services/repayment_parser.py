"""상환가능확인 파일 파서 — 오피스 5264와 예탁원 대차내역 파싱"""
import pandas as pd

from services.excel_reader import read_excel


def parse_repayment_files(office_bytes: bytes, esafe_bytes: bytes) -> dict:
    """두 엑셀 파일을 파싱하여 정제된 DataFrame dict 반환."""
    office_df = _parse_office(read_excel(office_bytes))
    esafe_df = _parse_esafe(read_excel(esafe_bytes))
    return {"office": office_df, "esafe": esafe_df}


def _parse_office(df: pd.DataFrame) -> pd.DataFrame:
    """오피스 5264: 펀드코드, 펀드명, 종목번호, 종목명, 담보가능수량."""
    df = df.dropna(subset=[df.columns[1]])

    rename_map = {}
    for col in df.columns:
        clean = col.replace("\n", "")
        if clean != col:
            rename_map[col] = clean
    if rename_map:
        df = df.rename(columns=rename_map)

    required = ["펀드코드", "펀드명", "종목번호", "종목명", "담보가능수량"]
    for col in required:
        if col not in df.columns:
            raise ValueError(f"오피스 파일에 '{col}' 컬럼이 없습니다.")

    optional = ["계정코드", "담보"]
    use_cols = required + [c for c in optional if c in df.columns]
    df = df[use_cols].copy()
    if "계정코드" in df.columns:
        df["계정코드"] = df["계정코드"].astype(str).str.strip().str.zfill(3)
    df["담보가능수량"] = pd.to_numeric(df["담보가능수량"], errors="coerce").fillna(0).astype(int)
    if "담보" in df.columns:
        df["담보"] = pd.to_numeric(df["담보"], errors="coerce").fillna(0).astype(int)
    else:
        df["담보"] = 0
    df = df[(df["담보가능수량"] > 0) | (df["담보"] > 0)].copy()

    # 종목번호 정규화: A005930 → 005930
    df["종목번호"] = df["종목번호"].astype(str).str.replace(r"^A", "", regex=True).str.zfill(6)
    df["펀드코드"] = df["펀드코드"].astype(str).str.zfill(6)

    return df.reset_index(drop=True)


def _parse_esafe(df: pd.DataFrame) -> pd.DataFrame:
    """예탁원 대차내역: 단축코드, 종목명, 수수료율, 대차수량, 체결일, 체결번호, 대여자계좌, 대여자명, 기준가액, 대차가액."""
    required = ["단축코드", "종목명", "수수료율(%)", "대차수량", "체결일", "체결번호",
                 "대여자계좌", "대여자명", "기준가액", "대차가액"]
    for col in required:
        if col not in df.columns:
            raise ValueError(f"예탁원 파일에 '{col}' 컬럼이 없습니다.")

    df = df[required].copy()
    df["대차수량"] = pd.to_numeric(df["대차수량"], errors="coerce").fillna(0).astype(int)
    df = df[df["대차수량"] > 0].copy()

    df["단축코드"] = df["단축코드"].astype(str).str.zfill(6)
    df["수수료율(%)"] = pd.to_numeric(df["수수료율(%)"], errors="coerce").fillna(0)
    df["기준가액"] = pd.to_numeric(df["기준가액"], errors="coerce").fillna(0).astype(int)
    df["대차가액"] = pd.to_numeric(df["대차가액"], errors="coerce").fillna(0).astype(int)
    df["체결번호"] = pd.to_numeric(df["체결번호"], errors="coerce").fillna(0).astype(int)

    return df.reset_index(drop=True)


def parse_esafe_lenders(file_bytes: bytes) -> list[dict]:
    """예탁원 파일에서 대여자 목록(중복 제거)을 추출한다."""
    df = read_excel(file_bytes)

    if "대여자계좌" not in df.columns or "대여자명" not in df.columns:
        raise ValueError("예탁원 파일에 '대여자계좌', '대여자명' 컬럼이 없습니다.")

    lenders = (
        df[["대여자계좌", "대여자명"]]
        .drop_duplicates()
        .sort_values("대여자명")
        .reset_index(drop=True)
    )
    return [{"account": str(row["대여자계좌"]), "name": str(row["대여자명"])} for _, row in lenders.iterrows()]


def parse_repay_schedule(file_bytes: bytes) -> pd.DataFrame:
    """상환예정내역 파일 파싱: D열 ISIN → 종목코드 6자리, J열 대차수량."""
    df = read_excel(file_bytes)
    df = df.dropna(subset=[df.columns[3]])  # D열 종목코드 기준

    result = pd.DataFrame()
    # D열(index 3): ISIN KR7005930003 → [3:9] = 005930
    result["종목번호"] = df.iloc[:, 3].astype(str).str[3:9]
    # J열(index 9): 대차수량
    result["상환예정수량"] = pd.to_numeric(df.iloc[:, 9], errors="coerce").fillna(0).astype(int)

    return result
