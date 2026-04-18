use serde::Serialize;

use super::tick::{EtfTick, FuturesTick, StockTick};

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
}
