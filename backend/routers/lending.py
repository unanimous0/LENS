import logging
import math

from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from typing import Optional

from schemas.lending import LendingResponse
from services.lending_parser import (
    parse_inquiry, parse_holdings, parse_mm_funds,
    parse_restricted_funds, parse_repayments,
)
from services.lending_calculator import calculate_availability
from services.borrowing_calculator import parse_esafe_for_borrowing, calculate_borrowing
from services.file_resolver import find_files_in_folder, read_file_bytes

logger = logging.getLogger("uvicorn.error")

router = APIRouter(tags=["lending"])

# 폴더 내 파일 탐색 패턴
LENDING_PATTERNS = [
    ("inquiry", "대여문의종목*"),
    ("holdings", "5264*"),
    ("restricted", "대여불가펀드*"),
    ("mm_funds", "MM펀드*"),
    ("repayments", "상환예정*"),
]


@router.post("/lending/calculate", response_model=LendingResponse)
async def calculate_lending(
    inquiry_file: Optional[UploadFile] = File(None),
    holdings_file: Optional[UploadFile] = File(None),
    restricted_file: Optional[UploadFile] = File(None),
    mm_funds_file: Optional[UploadFile] = File(None),
    repayments_file: Optional[UploadFile] = File(None),
    folder_path: Optional[str] = Form(None),
    restricted_suffixes: Optional[str] = Form(None),
):
    # 파일 바이트 결정: 업로드 > 폴더 경로
    inquiry_bytes = holdings_bytes = restricted_bytes = mm_bytes = repay_bytes = None

    if folder_path:
        found = find_files_in_folder(folder_path, LENDING_PATTERNS)
        if "inquiry" in found:
            inquiry_bytes = read_file_bytes(found["inquiry"])
        if "holdings" in found:
            holdings_bytes = read_file_bytes(found["holdings"])
        if "restricted" in found:
            restricted_bytes = read_file_bytes(found["restricted"])
        if "mm_funds" in found:
            mm_bytes = read_file_bytes(found["mm_funds"])
        if "repayments" in found:
            repay_bytes = read_file_bytes(found["repayments"])

    if inquiry_file and inquiry_file.filename:
        inquiry_bytes = await inquiry_file.read()
    if holdings_file and holdings_file.filename:
        holdings_bytes = await holdings_file.read()
    if restricted_file and restricted_file.filename:
        restricted_bytes = await restricted_file.read()
    if mm_funds_file and mm_funds_file.filename:
        mm_bytes = await mm_funds_file.read()
    if repayments_file and repayments_file.filename:
        repay_bytes = await repayments_file.read()

    if not inquiry_bytes or not holdings_bytes:
        raise HTTPException(400, "대여문의종목 파일과 5264 파일이 필요합니다. 파일을 선택하거나 폴더 경로를 지정하세요.")

    try:
        inquiry = parse_inquiry(inquiry_bytes)
        holdings = parse_holdings(holdings_bytes)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    # MM펀드
    mm_funds: set[str] = set()
    if mm_bytes:
        try:
            mm_funds = parse_mm_funds(mm_bytes)
        except Exception as e:
            raise HTTPException(400, f"MM펀드 파싱 오류: {str(e)}")

    # 대여불가펀드: 파일 > 수동 입력
    suffixes: list[str] = []
    if restricted_bytes:
        try:
            suffixes = parse_restricted_funds(restricted_bytes)
        except Exception:
            pass
    if restricted_suffixes:
        manual = [s.strip() for s in restricted_suffixes.split(",") if s.strip()]
        # 파일 + 수동 합산 (중복 제거)
        suffixes = list(dict.fromkeys(suffixes + manual))

    # 상환예정내역
    import pandas as pd
    repayments = pd.DataFrame(columns=["stock_code", "repay_qty"])
    if repay_bytes:
        try:
            repayments = parse_repayments(repay_bytes)
        except Exception as e:
            raise HTTPException(400, f"상환예정내역 파싱 오류: {str(e)}")

    results = calculate_availability(
        inquiry=inquiry,
        holdings=holdings,
        mm_funds=mm_funds,
        restricted_suffixes=suffixes,
        repayments=repayments,
    )

    total_met = sum(1 for r in results if r["meets_request"])

    return LendingResponse(
        results=results,
        total_inquiry=len(results),
        total_met=total_met,
        total_unmet=len(results) - total_met,
    )


@router.post("/lending/restricted-codes")
async def get_restricted_codes(
    file: Optional[UploadFile] = File(None),
    folder_path: Optional[str] = Form(None),
):
    """대여불가펀드 파일에서 펀드코드 목록 반환."""
    file_bytes = None

    if folder_path:
        found = find_files_in_folder(folder_path, [("restricted", "대여불가펀드*")])
        if "restricted" in found:
            file_bytes = read_file_bytes(found["restricted"])

    if file and file.filename:
        file_bytes = await file.read()

    if not file_bytes:
        return {"codes": []}

    try:
        codes = parse_restricted_funds(file_bytes)
        return {"codes": codes}
    except (ValueError, KeyError) as e:
        # 파싱 가능한 형식 오류만 빈 결과로. 그 외 (OS 오류 등)는 그대로 전파.
        logger.warning("parse_restricted_funds failed: %s", e)
        return {"codes": []}


def _clean_nan(obj):
    """NaN/Inf를 JSON 호환 값으로 변환."""
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return 0
    if isinstance(obj, dict):
        return {k: _clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_nan(v) for v in obj]
    return obj


@router.post("/lending/analyze")
async def analyze_lending(
    file: Optional[UploadFile] = File(None),
    folder_path: Optional[str] = Form(None),
):
    """대여내역 파일 분석 — 차입 분석과 동일한 로직 (파일 포맷 동일)."""
    contents = None

    if folder_path:
        found = find_files_in_folder(folder_path, [("lending_history", "대여내역*")])
        if "lending_history" in found:
            contents = read_file_bytes(found["lending_history"])

    if file and file.filename:
        contents = await file.read()

    if not contents:
        raise HTTPException(400, "대여내역 파일이 필요합니다. 파일을 선택하거나 폴더 경로를 지정하세요.")

    try:
        df = parse_esafe_for_borrowing(contents, counterparty="차입자")
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    result = calculate_borrowing(df, expensive_threshold=5.0, expensive_inclusive=True)
    return JSONResponse(content=_clean_nan(result))
