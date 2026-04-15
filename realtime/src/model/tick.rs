use serde::Serialize;

/// ETF 틱 — 기존 Python ETFTick과 동일한 필드명/타입
#[derive(Debug, Clone, Serialize)]
pub struct EtfTick {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub nav: f64,
    pub spread_bp: f64,
    pub volume: u64,
    pub timestamp: String, // ISO 8601
}

/// 선물 틱 — 기존 Python FuturesTick과 동일한 필드명/타입
#[derive(Debug, Clone, Serialize)]
pub struct FuturesTick {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub underlying_price: f64,
    pub basis_bp: f64,
    pub volume: u64,
    pub timestamp: String, // ISO 8601
}
