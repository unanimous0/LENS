import math
import json

from fastapi import APIRouter, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse

from services.borrowing_calculator import parse_esafe_for_borrowing, calculate_borrowing

router = APIRouter(tags=["borrowing"])


def _clean_nan(obj):
    """NaN/Inf를 JSON 호환 값으로 변환."""
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return 0
    if isinstance(obj, dict):
        return {k: _clean_nan(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_nan(v) for v in obj]
    return obj


@router.post("/borrowing/analyze")
async def analyze_borrowing(file: UploadFile = File(...)):
    if not file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(400, "대차내역 파일은 엑셀(.xlsx, .xls)만 가능합니다.")

    contents = await file.read()
    try:
        df = parse_esafe_for_borrowing(contents)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    result = calculate_borrowing(df)
    return JSONResponse(content=_clean_nan(result))
