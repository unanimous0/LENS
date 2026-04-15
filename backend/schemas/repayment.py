from pydantic import BaseModel


class RepaymentMatch(BaseModel):
    펀드코드: str
    펀드명: str
    계정코드: str = ""
    종목코드: str
    종목명: str
    상환수량: int
    체결일: str
    체결번호: int
    대여자계좌: str
    대여자명: str
    수수료율: float
    기준가액: int
    대차금액: int


class StockSummary(BaseModel):
    종목코드: str
    종목명: str
    상환수량: int
    대차금액: int
    체결건수: int
    최고수수료율: float


class RemainingOffice(BaseModel):
    펀드코드: str
    펀드명: str
    종목번호: str
    종목명: str
    담보가능수량: int


class RemainingEsafe(BaseModel):
    단축코드: str
    종목명: str
    대차수량: int
    수수료율: float = 0
    체결일: str = ""
    체결번호: int = 0
    대여자계좌: str = ""
    대여자명: str = ""
    기준가액: int = 0
    대차가액: int = 0


class RepaymentResponse(BaseModel):
    matches: list[RepaymentMatch]
    summary: list[StockSummary]
    remaining_office: list[dict]
    remaining_esafe: list[dict]
    no_esafe_stocks: list[dict]
    total_qty: int
    total_amount: int
    qty_052: int = 0
    qty_031: int = 0
    repay_deductions: dict[str, dict[str, int]] = {}  # {종목코드: {펀드코드: 차감수량}}
    original_collateral: dict[str, int] = {}  # {종목코드: 원본 담보가능수량}
    original_by_fund: dict[str, dict[str, int]] = {}  # {종목코드: {펀드코드: 원본 담보가능수량}}
    locked_collateral: dict[str, int] = {}  # {종목코드: 담보잡힌수량}
    locked_by_fund: dict[str, dict[str, int]] = {}  # {종목코드: {펀드코드: 담보잡힌수량}}
    fund_names: dict[str, str] = {}  # {펀드코드: 펀드명}
