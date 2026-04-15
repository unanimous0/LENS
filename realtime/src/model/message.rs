use serde::Serialize;

use super::tick::{EtfTick, FuturesTick};

/// 프론트엔드로 전송하는 WebSocket 메시지.
/// 기존 Python 포맷과 정확히 일치: {"type": "etf_tick", "data": {...}}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum WsMessage {
    #[serde(rename = "etf_tick")]
    EtfTick(EtfTick),
    #[serde(rename = "futures_tick")]
    FuturesTick(FuturesTick),
}
