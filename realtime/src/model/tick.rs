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
    /// 그 체결의 단일 수량 (LS S3_/K3_의 `cvolume`). 누적 volume과 별개.
    /// 실시간 체결 stream에서만 채워짐. 초기 fetch / nav-only(I5_) 메시지는 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_trade_volume: Option<u64>,
    /// 그 체결의 매수/매도 구분 (+1 매수 / -1 매도). LS S3_/K3_의 `cgubun`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trade_side: Option<i8>,
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
    /// 그 체결의 단일 수량 (LS S3_/K3_의 `cvolume`). 누적 cum_volume과 별개.
    /// 실시간 체결 stream에서만 채워짐. t1102/초기 fetch는 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_trade_volume: Option<u64>,
    /// 그 체결의 매수/매도 구분 (+1 매수 / -1 매도). LS S3_/K3_의 `cgubun`.
    /// t1102/초기 fetch / 모르는 케이스는 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trade_side: Option<i8>,
    /// 매매정지 상태 (t1405 jongchk=2). true면 가격/거래량 무의미 — UI는 "거래정지" 표시,
    /// 차익 계산은 null 처리.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub halted: bool,
    /// 상한가 (t1102 `uplmtprice`). 당일 거의 안 변함 — 초기 fetch 시 한 번 박음.
    /// 프론트가 price >= upper_limit 으로 상한가 도달 판정.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upper_limit: Option<f64>,
    /// 하한가 (t1102 `dnlmtprice`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lower_limit: Option<f64>,
    /// VI(변동성완화장치) 발동 상태 (VI_ stream vi_gubun ≠ "0"). 2분 단일가 매매 중 — 즉각 거래 불가.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub vi_active: bool,
    /// 투자경고 종목 (t1405 jongchk=1). 거래 가능, 위험 종목 표시.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub warning: bool,
    /// 정리매매 종목 (t1405 jongchk=3). 상장폐지 직전, 가격 거의 안 움직임.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub liquidation: bool,
    /// 이상급등 (t1102 abnormal_rise_gu ≠ "0").
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub abnormal_rise: bool,
    /// 저유동성 (t1102 low_lqdt_gu ≠ "0").
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub low_liquidity: bool,
    /// 관리종목 (t1404 폴러).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub under_management: bool,
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
