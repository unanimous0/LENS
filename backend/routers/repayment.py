from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from typing import Optional

from schemas.repayment import RepaymentResponse
from services.repayment_parser import parse_repayment_files, parse_esafe_lenders
from services.repayment_calculator import calculate_repayment, apply_filters

router = APIRouter(tags=["repayment"])


@router.post("/repayment/calculate", response_model=RepaymentResponse)
async def calculate_repay(
    office_file: UploadFile = File(...),
    esafe_file: UploadFile = File(...),
    exclude_fund_codes: Optional[str] = Form(None),
    exclude_office_stock_code: Optional[str] = Form(None),
    exclude_office_stock_name: Optional[str] = Form(None),
    exclude_lender: Optional[str] = Form(None),
    exclude_asset_mgmt: Optional[str] = Form(None),
    exclude_securities: Optional[str] = Form(None),
    exclude_fee_rate_below: Optional[float] = Form(None),
    exclude_dates: Optional[str] = Form(None),
    exclude_esafe_stock_code: Optional[str] = Form(None),
    exclude_esafe_stock_name: Optional[str] = Form(None),
):
    if not office_file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(400, "오피스 파일은 엑셀(.xlsx, .xls)만 가능합니다.")
    if not esafe_file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(400, "예탁원 파일은 엑셀(.xlsx, .xls)만 가능합니다.")

    office_bytes = await office_file.read()
    esafe_bytes = await esafe_file.read()

    try:
        data = parse_repayment_files(office_bytes, esafe_bytes)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    filters = {
        "exclude_fund_codes": [c.strip() for c in exclude_fund_codes.split(",") if c.strip()] if exclude_fund_codes else [],
        "exclude_office_stock_code": exclude_office_stock_code or "",
        "exclude_office_stock_name": exclude_office_stock_name or "",
        "exclude_lender": exclude_lender or "",
        "exclude_asset_mgmt": exclude_asset_mgmt == "true",
        "exclude_securities": exclude_securities == "true",
        "exclude_fee_rate_below": exclude_fee_rate_below,
        "exclude_dates": [d.strip() for d in exclude_dates.split(",") if d.strip()] if exclude_dates else [],
        "exclude_esafe_stock_code": exclude_esafe_stock_code or "",
        "exclude_esafe_stock_name": exclude_esafe_stock_name or "",
    }

    office_df, esafe_df = apply_filters(data["office"], data["esafe"], filters)
    result = calculate_repayment(office_df, esafe_df)
    return RepaymentResponse(**result)


@router.post("/repayment/lenders")
async def get_lenders(esafe_file: UploadFile = File(...)):
    if not esafe_file.filename.endswith((".xlsx", ".xls")):
        raise HTTPException(400, "예탁원 파일은 엑셀(.xlsx, .xls)만 가능합니다.")

    contents = await esafe_file.read()
    try:
        lenders = parse_esafe_lenders(contents)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    return {"lenders": lenders}
