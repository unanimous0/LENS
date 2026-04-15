from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from typing import Optional

from schemas.lending import LendingResponse
from services.lending_parser import (
    parse_inquiry, parse_holdings, parse_mm_funds,
    parse_restricted_funds, parse_repayments,
)
from services.lending_calculator import calculate_availability
from services.file_resolver import find_files_in_folder, read_file_bytes

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
