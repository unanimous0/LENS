"""종목코드 정규화 — 다양한 입력 형식을 6자리 표준 코드로 통일.

KRX 종목코드 표준은 6자리 (영문 포함 가능, 예: '0000J0').
입력 형식이 다양하기 때문에 (사용자 직접 입력 vs 시스템 export):
  - "005930"        ← 표준 6자리
  - "A005930"       ← 일부 시스템 (오피스 5264, 사용자 입력 등) 'A' 접두 형식
  - "KR7005930003"  ← ISIN
  - "5930"          ← 앞 0 빠진 케이스 (드물지만 zfill로 복구)

대차 페이지에서 사용자가 직접 입력하는 파일(대여문의종목, 5264 원장 등)은
6자리/'A'접두 형식이 혼재해서, 매칭 실패 방지를 위해 모든 stock code 컬럼을
이 함수로 통일한다. 호출 체인 양쪽이 같은 함수를 쓰면 매칭 누락이 사라진다.
"""
from __future__ import annotations

import pandas as pd


def normalize_stock_code(code) -> str:
    """단일 종목코드 정규화.

    NaN/None/빈 문자열은 빈 문자열 반환 (호출 측에서 dropna로 걸러냄을 가정).
    """
    if code is None:
        return ""
    # pandas NA/NaN
    try:
        if pd.isna(code):
            return ""
    except (TypeError, ValueError):
        pass
    s = str(code).strip().upper()
    if not s:
        return ""
    # ISIN 'KR7XXXXXX_C' (12자) → 가운데 6자리.
    if len(s) == 12 and s.startswith("KR"):
        return s[3:9]
    # 'A' 접두 제거 — 7~8자에 한정 (ETF 코드 'KAM566000' 같은 9자 선물코드 보호).
    if s.startswith("A") and 6 < len(s) <= 8:
        s = s[1:]
    # 6자리 zfill (5자리 등 짧은 입력 보정).
    if len(s) < 6:
        s = s.zfill(6)
    return s


def normalize_series(series: pd.Series) -> pd.Series:
    """pandas Series 일괄 정규화. dtype object 반환."""
    return series.map(normalize_stock_code)
