"""Market data models"""
from datetime import datetime
from pydantic import BaseModel


class ETFTick(BaseModel):
    code: str
    name: str
    price: float
    nav: float
    spread_bp: float
    volume: int
    timestamp: datetime


class FuturesTick(BaseModel):
    code: str
    name: str
    price: float
    underlying_price: float
    basis_bp: float
    volume: int
    timestamp: datetime


class BasisData(BaseModel):
    futures_code: str
    index_code: str
    basis_bp: float
    near_month_bp: float
    far_month_bp: float
    timestamp: datetime


class ETFInfo(BaseModel):
    code: str
    name: str
    underlying_index: str
    asset_class: str
    leverage: float = 1.0
    tax_bp: float = 0.0
