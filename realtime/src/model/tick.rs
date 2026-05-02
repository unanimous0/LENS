use serde::Serialize;

/// ETF 틱
#[derive(Debug, Clone, Serialize)]
pub struct EtfTick {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub nav: f64,
    /// (현재가 - NAV) / NAV × 10000
    pub spread_bp: f64,
    /// (매수1호가 - NAV) / NAV × 10000
    pub spread_bid_bp: f64,
    /// (매도1호가 - NAV) / NAV × 10000
    pub spread_ask_bp: f64,
    pub volume: u64,
    pub timestamp: String,
}

/// 주식 틱 (일반 주식 체결)
#[derive(Debug, Clone, Serialize)]
pub struct StockTick {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub volume: u64,
    /// 당일 누적 거래량
    pub cum_volume: u64,
    pub timestamp: String,
    /// true = t8402 초기값 (실시간 체결이 아님). 이미 실시간 값이 있으면 무시해야 함.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_initial: bool,
    /// 당일 고가 (없으면 미발행)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub high: Option<f64>,
    /// 당일 저가
    #[serde(skip_serializing_if = "Option::is_none")]
    pub low: Option<f64>,
    /// 전일 종가 (변화율 계산용). 초기값에서만 발행하면 충분.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_close: Option<f64>,
}

/// 선물 틱
#[derive(Debug, Clone, Serialize)]
pub struct FuturesTick {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub underlying_price: f64,
    /// 시장 베이시스 = 선물가 - 현물가 (순수 가격 차이)
    pub basis: f64,
    pub volume: u64,
    pub timestamp: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_initial: bool,
    /// 미결제약정수량 (LS JC0 openyak / t8402 mgjv)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_interest: Option<i64>,
    /// 미결제약정 전일대비 증감 (LS JC0 openyakcha / t8402 mgjvdiff)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_interest_change: Option<i64>,
}

/// 호가 단일 레벨 (가격 + 잔량)
#[derive(Debug, Clone, Serialize)]
pub struct OrderbookLevel {
    pub price: f64,
    pub quantity: u64,
}

/// 호가 틱 — 현물(H1_/HA_) 10호가, 선물(JH0) 5호가
#[derive(Debug, Clone, Serialize)]
pub struct OrderbookTick {
    pub code: String,
    pub name: String,
    /// 매도호가 (낮은가→높은가, index 0이 최우선 매도)
    pub asks: Vec<OrderbookLevel>,
    /// 매수호가 (높은가→낮은가, index 0이 최우선 매수)
    pub bids: Vec<OrderbookLevel>,
    /// 총 매도잔량
    pub total_ask_qty: u64,
    /// 총 매수잔량
    pub total_bid_qty: u64,
    pub timestamp: String,
}
