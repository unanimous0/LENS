from pydantic import BaseModel


class FundBreakdown(BaseModel):
    fund_code: str
    fund_name: str
    account_code: str
    settlement_balance: int
    collateral_free: int
    collateral_locked: int
    lending: int
    repayment_deducted: int


class StockResult(BaseModel):
    stock_code: str
    stock_name: str
    requested_qty: int
    rate: float
    total_free: int
    total_locked: int
    total_combined: int
    repay_scheduled: int
    prev_close: int = 0
    meets_request: bool
    funds: list[FundBreakdown]


class LendingResponse(BaseModel):
    results: list[StockResult]
    total_inquiry: int
    total_met: int
    total_unmet: int
