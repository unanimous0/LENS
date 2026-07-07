use serde::Serialize;

use super::lp::{BookRiskSnapshot, FairValueMatrixSnapshot, QuoteBoardSnapshot};
use super::tick::{EtfTick, FuturesTick, IndexFuturesTick, OrderbookTick, StockTick, VolumeTick};

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
    /// 지수선물 (KOSPI200/미니/KOSDAQ150, LS FC9). 주식선물과 별도 스트림.
    #[serde(rename = "index_futures_tick")]
    IndexFuturesTick(IndexFuturesTick),
    #[serde(rename = "orderbook_tick")]
    OrderbookTick(OrderbookTick),
    /// 외부망 ETF 거래대금 30초 폴링(t8407 REST, 키B). 순위 매기기 전용 — 상위 N만 WS 실시간.
    #[serde(rename = "volume_tick")]
    VolumeTick(VolumeTick),
    /// LP 매트릭스 — ETF × 헤지 경로 fair value (Level 2 + Level 3). 50~200ms throttle broadcast.
    #[serde(rename = "fair_value_matrix")]
    FairValueMatrix(FairValueMatrixSnapshot),
    /// LP 북 리스크 — #2 베타조정 델타 + #3 잔차위험 + #4 손익분해 (첫 빌드는 #4 스텁).
    #[serde(rename = "book_risk")]
    BookRisk(BookRiskSnapshot),
    /// LP 호가 보드 — FV_futures 기준 12종 제안 호가/수량 (§13.3-A). 200ms throttle broadcast.
    #[serde(rename = "quote_board")]
    QuoteBoard(QuoteBoardSnapshot),
}
