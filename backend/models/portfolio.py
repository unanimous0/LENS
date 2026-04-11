"""Portfolio models"""
from datetime import datetime
from pydantic import BaseModel


class Position(BaseModel):
    code: str
    name: str
    quantity: int
    avg_price: float
    current_price: float
    delta: float
    underlying_index: str


class PortfolioGreeks(BaseModel):
    total_delta: float
    total_gamma: float
    total_vega: float
    total_theta: float
    delta_by_index: dict[str, float]
    delta_by_sector: dict[str, float]
    risk_usage_pct: float
    timestamp: datetime


class ScenarioPnL(BaseModel):
    scenario: str
    expected_pnl: float
