use serde::Serialize;

use super::lp::{BookRiskSnapshot, FairValueMatrixSnapshot};
use super::tick::{EtfTick, FuturesTick, OrderbookTick, StockTick};

/// 프론트엔드로 전송하는 WebSocket 메시지.
/// {"type": "etf_tick", "data": {...}} 형태.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum WsMessage {
    #[serde(rename = "etf_tick")]
    EtfTick(EtfTick),
    #[serde(rename = "stock_tick")]
    StockTick(StockTick),
    #[serde(rename = "futures_tick")]
    FuturesTick(FuturesTick),
    #[serde(rename = "orderbook_tick")]
    OrderbookTick(OrderbookTick),
    /// LP 매트릭스 — ETF × 헤지 경로 fair value (Level 2 + Level 3). 50~200ms throttle broadcast.
    #[serde(rename = "fair_value_matrix")]
    FairValueMatrix(FairValueMatrixSnapshot),
    /// LP 북 리스크 — #2 베타조정 델타 + #3 잔차위험 + #4 손익분해 (첫 빌드는 #4 스텁).
    #[serde(rename = "book_risk")]
    BookRisk(BookRiskSnapshot),
}
