from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from typing import Optional

from schemas.repayment import RepaymentResponse
from services.repayment_parser import parse_repayment_files, parse_esafe_lenders, parse_repay_schedule
from services.repayment_calculator import calculate_repayment, apply_filters, deduct_repay_schedule
from services.lending_parser import parse_mm_funds, parse_restricted_funds
from services.file_resolver import find_files_in_folder, read_file_bytes

router = APIRouter(tags=["repayment"])

# 상환가능확인 폴더 내 파일 탐색 패턴
REPAYMENT_PATTERNS = [
    ("office", "5264*"),
    ("esafe", "대차내역*"),
    ("repay", "상환예정*"),
    ("mm_funds", "MM펀드*"),
    ("restricted", "대여불가펀드*"),
]


@router.post("/repayment/calculate", response_model=RepaymentResponse)
async def calculate_repay(
    office_file: Optional[UploadFile] = File(None),
    esafe_file: Optional[UploadFile] = File(None),
    repay_file: Optional[UploadFile] = File(None),
    mm_funds_file: Optional[UploadFile] = File(None),
    restricted_file: Optional[UploadFile] = File(None),
    folder_path: Optional[str] = Form(None),
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
    # 파일 결정: 업로드 > 폴더 경로
    office_bytes = esafe_bytes = repay_bytes = mm_bytes = restricted_bytes = None

    if folder_path:
        found = find_files_in_folder(folder_path, REPAYMENT_PATTERNS)
        if "office" in found and not (office_file and office_file.filename):
            office_bytes = read_file_bytes(found["office"])
        if "esafe" in found and not (esafe_file and esafe_file.filename):
            esafe_bytes = read_file_bytes(found["esafe"])
        if "repay" in found and not (repay_file and repay_file.filename):
            repay_bytes = read_file_bytes(found["repay"])
        if "mm_funds" in found and not (mm_funds_file and mm_funds_file.filename):
            mm_bytes = read_file_bytes(found["mm_funds"])
        if "restricted" in found and not (restricted_file and restricted_file.filename):
            restricted_bytes = read_file_bytes(found["restricted"])

    if office_file and office_file.filename:
        office_bytes = await office_file.read()
    if esafe_file and esafe_file.filename:
        esafe_bytes = await esafe_file.read()
    if repay_file and repay_file.filename:
        repay_bytes = await repay_file.read()
    if mm_funds_file and mm_funds_file.filename:
        mm_bytes = await mm_funds_file.read()
    if restricted_file and restricted_file.filename:
        restricted_bytes = await restricted_file.read()

    if not office_bytes or not esafe_bytes:
        raise HTTPException(400, "오피스 파일과 예탁원 파일이 필요합니다. 파일을 선택하거나 폴더 경로를 지정하세요.")

    try:
        data = parse_repayment_files(office_bytes, esafe_bytes)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    # MM펀드 / 상환불가펀드 파싱
    mm_funds: set[str] = set()
    if mm_bytes:
        try:
            mm_funds = parse_mm_funds(mm_bytes)
        except Exception:
            pass

    restricted_suffixes: list[str] = []
    if restricted_bytes:
        try:
            restricted_suffixes = parse_restricted_funds(restricted_bytes)
        except Exception:
            pass

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
        "mm_funds": mm_funds,
        "restricted_suffixes": restricted_suffixes,
    }

    office_df, esafe_df = apply_filters(data["office"], data["esafe"], filters)

    # 종목별/펀드별 원본 담보가능수량 (상환예정 차감 전) + 담보잡힌수량
    original_collateral: dict = {
        str(k): int(v) for k, v in office_df.groupby("종목번호")["담보가능수량"].sum().items()
    }
    original_by_fund: dict = {}
    for (stock, fund), qty in office_df.groupby(["종목번호", "펀드코드"])["담보가능수량"].sum().items():
        original_by_fund.setdefault(str(stock), {})[str(fund)] = int(qty)

    locked_collateral: dict = {
        str(k): int(v) for k, v in office_df.groupby("종목번호")["담보"].sum().items()
    }
    locked_by_fund: dict = {}
    for (stock, fund), qty in office_df.groupby(["종목번호", "펀드코드"])["담보"].sum().items():
        if int(qty) > 0:
            locked_by_fund.setdefault(str(stock), {})[str(fund)] = int(qty)

    # 펀드코드 → 펀드명 매핑
    fund_names: dict = dict(
        zip(office_df["펀드코드"].astype(str), office_df["펀드명"].astype(str))
    )

    # 상환예정내역 차감
    repay_deductions: dict = {}
    if repay_bytes:
        try:
            repay_df = parse_repay_schedule(repay_bytes)
            office_df, repay_deductions = deduct_repay_schedule(office_df, repay_df)
        except Exception as e:
            raise HTTPException(400, f"상환예정내역 파싱 오류: {str(e)}")

    result = calculate_repayment(office_df, esafe_df)
    result["repay_deductions"] = repay_deductions
    result["original_collateral"] = original_collateral
    result["original_by_fund"] = original_by_fund
    result["locked_collateral"] = locked_collateral
    result["locked_by_fund"] = locked_by_fund
    result["fund_names"] = fund_names
    return RepaymentResponse(**result)


@router.post("/repayment/lenders")
async def get_lenders(
    esafe_file: Optional[UploadFile] = File(None),
    folder_path: Optional[str] = Form(None),
):
    esafe_bytes = None

    if folder_path:
        found = find_files_in_folder(folder_path, [("esafe", "대차내역*")])
        if "esafe" in found:
            esafe_bytes = read_file_bytes(found["esafe"])

    if esafe_file and esafe_file.filename:
        esafe_bytes = await esafe_file.read()

    if not esafe_bytes:
        raise HTTPException(400, "예탁원 파일이 필요합니다.")

    try:
        lenders = parse_esafe_lenders(esafe_bytes)
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {str(e)}")

    return {"lenders": lenders}
