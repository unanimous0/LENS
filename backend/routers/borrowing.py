from fastapi import APIRouter, File, UploadFile, HTTPException

from services.borrowing_calculator import parse_esafe_for_borrowing, calculate_borrowing

router = APIRouter(tags=["borrowing"])


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
    return result
