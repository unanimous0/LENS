from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from typing import Optional

from schemas.lending import LendingResponse
from services.lending_parser import parse_lending_file
from services.lending_calculator import calculate_availability

router = APIRouter(tags=["lending"])


@router.post("/lending/calculate", response_model=LendingResponse)
async def calculate_lending(
    file: UploadFile = File(...),
    restricted_suffixes: Optional[str] = Form(None),
):
    if not file.filename.endswith((".xlsm", ".xlsx")):
        raise HTTPException(400, "엑셀 파일(.xlsm, .xlsx)만 업로드 가능합니다.")

    contents = await file.read()
    try:
        data = parse_lending_file(contents)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    suffixes = [s.strip() for s in restricted_suffixes.split(",") if s.strip()] if restricted_suffixes else []

    results = calculate_availability(
        inquiry=data["inquiry"],
        holdings=data["holdings"],
        mm_funds=data["mm_funds"],
        restricted_suffixes=suffixes,
        repayments=data["repayments"],
    )

    total_met = sum(1 for r in results if r["meets_request"])

    return LendingResponse(
        results=results,
        total_inquiry=len(results),
        total_met=total_met,
        total_unmet=len(results) - total_met,
    )
