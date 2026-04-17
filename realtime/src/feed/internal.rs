use std::collections::HashMap;

use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::model::internal::{
    self, InternalMsg, Index, LpBookSnapshot, Trade,
    INDEX_EXCHANGE_NAV, INDEX_FUTURES_IDEAL, INDEX_QUOTE, INDEX_REAL_NAV, INDEX_TRADE,
};
use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick};

use super::MarketFeed;

const MAX_RECONNECT_DELAY_SECS: u64 = 60;

/// 사내 거래소 데이터 수신 서버 피드
pub struct InternalFeed {
    /// WebSocket 주소 (e.g. "ws://10.21.1.208:41001")
    ws_url: String,
    /// 구독할 종목 코드 (내부망 형식: A005930, KA1165000)
    subscribe_codes: Vec<String>,
    /// ISIN → 단축코드 매핑 (런타임에 구독 코드에서 생성)
    /// e.g. "KR7005930003" → "005930"
    /// 실제 데이터의 `s` 필드(ISIN)가 오면 이 맵으로 단축코드를 찾는다.
    /// 미리 알 수 없으므로 데이터 수신 시 동적으로 매핑.
    names: HashMap<String, String>,
    /// real_nav 옵션 (rNAV, 선물이론가 수신 여부)
    real_nav: bool,
}

/// 종목별 최신 상태 (Index 메시지로 갱신)
struct SymbolState {
    /// 최신 rNAV (체결 기반, fl=10)
    rnav_trade: f64,
    /// 최신 rNAV bid/ask (호가 기반, fl=18)
    rnav_bid: f64,
    rnav_ask: f64,
    /// 거래소 공식 iNAV (fl=1)
    inav: f64,
    /// 선물 이론가 (체결 기반, fl=12)
    futures_ideal_trade: f64,
    /// 선물 이론가 bid/ask (호가 기반, fl=20)
    futures_ideal_bid: f64,
    futures_ideal_ask: f64,
    /// 이 종목이 선물인지 여부 (ex == "XKRF")
    is_futures: bool,
}

impl Default for SymbolState {
    fn default() -> Self {
        Self {
            rnav_trade: 0.0,
            rnav_bid: 0.0,
            rnav_ask: 0.0,
            inav: 0.0,
            futures_ideal_trade: 0.0,
            futures_ideal_bid: 0.0,
            futures_ideal_ask: 0.0,
            is_futures: false,
        }
    }
}

impl InternalFeed {
    pub fn new(
        ws_url: String,
        subscribe_codes: Vec<String>,
        names: HashMap<String, String>,
        real_nav: bool,
    ) -> Self {
        Self {
            ws_url,
            subscribe_codes,
            names,
            real_nav,
        }
    }

    /// WebSocket 연결 → 구독 → 수신 루프. 끊기면 Err 반환.
    async fn connect_and_stream(
        &self,
        tx: &mpsc::Sender<WsMessage>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let (ws_stream, resp) = tokio_tungstenite::connect_async(&self.ws_url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {e}"))?;

        info!(
            "Internal server connected: {} (status: {})",
            self.ws_url,
            resp.status()
        );

        let (mut write, mut read) = ws_stream.split();

        // 구독 요청
        let sub_msg = serde_json::json!({
            "symbols": self.subscribe_codes,
            "real_nav": self.real_nav,
        });
        write
            .send(tungstenite::Message::Text(sub_msg.to_string().into()))
            .await
            .map_err(|e| format!("subscribe send failed: {e}"))?;

        info!(
            "Internal subscribed: {:?} (real_nav={})",
            self.subscribe_codes, self.real_nav
        );

        // ISIN → 단축코드 캐시 (데이터 수신 시 동적 구축)
        let mut isin_cache: HashMap<String, String> = HashMap::new();
        // 종목별 상태 (Index로 갱신, Trade 시 참조)
        let mut states: HashMap<String, SymbolState> = HashMap::new();

        // 수신 루프
        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(tungstenite::Message::Text(text))) => {
                            self.handle_message(&text, tx, &mut isin_cache, &mut states).await;
                        }
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            if let Ok(text) = String::from_utf8(data.to_vec()) {
                                self.handle_message(&text, tx, &mut isin_cache, &mut states).await;
                            }
                        }
                        Some(Ok(tungstenite::Message::Close(frame))) => {
                            let reason = frame
                                .map(|f| format!("{} {}", f.code, f.reason))
                                .unwrap_or_default();
                            return Err(format!("server closed: {reason}"));
                        }
                        Some(Err(e)) => {
                            return Err(format!("WebSocket error: {e}"));
                        }
                        None => {
                            return Err("WebSocket stream ended".to_string());
                        }
                        _ => {}
                    }
                }
                _ = cancel.cancelled() => {
                    info!("InternalFeed cancelled");
                    let _ = write.send(tungstenite::Message::Close(None)).await;
                    return Ok(());
                }
            }
        }
    }

    /// JSON 배열 메시지 파싱 + 처리
    async fn handle_message(
        &self,
        text: &str,
        tx: &mpsc::Sender<WsMessage>,
        isin_cache: &mut HashMap<String, String>,
        states: &mut HashMap<String, SymbolState>,
    ) {
        // 구독 응답: {"code": 0, "error": null}
        if text.starts_with('{') {
            match serde_json::from_str::<serde_json::Value>(text) {
                Ok(v) => {
                    let code = v["code"].as_i64().unwrap_or(-1);
                    let err = v["error"].as_str().unwrap_or("null");
                    info!("Internal subscribe response: code={code}, error={err}");
                }
                Err(e) => warn!("Failed to parse subscribe response: {e}"),
            }
            return;
        }

        // 메시지는 항상 JSON 배열
        let msgs: Vec<InternalMsg> = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                // 파싱 실패는 무시 (알 수 없는 메시지 타입 등)
                if !text.is_empty() {
                    warn!("Failed to parse internal message: {e}");
                }
                return;
            }
        };

        for msg in msgs {
            match msg {
                InternalMsg::Trade(trade) => {
                    self.handle_trade(&trade, tx, isin_cache, states).await;
                }
                InternalMsg::LpBookSnapshot(book) => {
                    self.handle_book(&book, isin_cache, states);
                }
                InternalMsg::Index(index) => {
                    self.handle_index(&index, isin_cache, states);
                }
                InternalMsg::Auction(_) | InternalMsg::Status(_) => {
                    // Phase 3에서는 Auction/Status는 로그만
                }
            }
        }
    }

    /// ISIN → 단축코드 조회 (캐시 미스 시 변환 후 캐시)
    fn resolve_code<'a>(
        &self,
        isin: &str,
        isin_cache: &'a mut HashMap<String, String>,
    ) -> Option<&'a String> {
        if !isin_cache.contains_key(isin) {
            if let Some(short) = internal::isin_to_short(isin) {
                isin_cache.insert(isin.to_string(), short);
            } else {
                return None;
            }
        }
        isin_cache.get(isin)
    }

    /// Trade 처리 → EtfTick 또는 FuturesTick 전송
    async fn handle_trade(
        &self,
        trade: &Trade,
        tx: &mpsc::Sender<WsMessage>,
        isin_cache: &mut HashMap<String, String>,
        states: &mut HashMap<String, SymbolState>,
    ) {
        let short_code = match self.resolve_code(&trade.s, isin_cache) {
            Some(c) => c.clone(),
            None => return,
        };

        let price = parse_f64(&trade.tp);
        let volume: u64 = trade.ts.parse().unwrap_or(0);
        let timestamp = epoch_us_to_iso(trade.et);
        let name = self
            .names
            .get(&short_code)
            .cloned()
            .unwrap_or_else(|| short_code.clone());

        let is_futures = trade.ex == "XKRF";
        let state = states.entry(short_code.clone()).or_default();
        state.is_futures = is_futures;

        if is_futures {
            // 선물: 이론가를 underlying_price로, 베이시스 계산
            let underlying = if state.futures_ideal_trade > 0.0 {
                state.futures_ideal_trade
            } else {
                0.0
            };
            let basis_bp = if underlying > 0.0 {
                (price - underlying) / underlying * 10000.0
            } else {
                0.0
            };

            debug!("{name} {price} (이론 {underlying}, 베이시스 {basis_bp:.1}bp) x{volume}");
            let msg = WsMessage::FuturesTick(FuturesTick {
                code: short_code,
                name,
                price,
                underlying_price: round2(underlying),
                basis_bp: round2(basis_bp),
                volume,
                timestamp,
            });
            let _ = tx.send(msg).await;
        } else {
            // 주식/ETF: rNAV 우선, 없으면 iNAV
            let nav = if state.rnav_trade > 0.0 {
                state.rnav_trade
            } else if state.inav > 0.0 {
                state.inav
            } else {
                0.0
            };
            let spread_bp = if nav > 0.0 {
                (price - nav) / nav * 10000.0
            } else {
                0.0
            };

            debug!("{name} {price} (NAV {nav}, 괴리 {spread_bp:.1}bp) x{volume}");
            let msg = WsMessage::EtfTick(EtfTick {
                code: short_code,
                name,
                price,
                nav: round2(nav),
                spread_bp: round2(spread_bp),
                volume,
                timestamp,
            });
            let _ = tx.send(msg).await;
        }
    }

    /// LpBookSnapshot 처리 — 호가 mid price를 state에 반영
    fn handle_book(
        &self,
        book: &LpBookSnapshot,
        isin_cache: &mut HashMap<String, String>,
        states: &mut HashMap<String, SymbolState>,
    ) {
        let short_code = match self.resolve_code(&book.s, isin_cache) {
            Some(c) => c.clone(),
            None => return,
        };

        // best ask / best bid로 mid price 계산 (호가 데이터 활용)
        let _state = states.entry(short_code).or_default();
        // 호가 데이터는 향후 호가창 화면에서 직접 활용 예정
        // 현재는 state 갱신만 (별도 브로드캐스트 없음)
    }

    /// Index 처리 — fl 비트마스크에 따라 state 갱신
    fn handle_index(
        &self,
        index: &Index,
        isin_cache: &mut HashMap<String, String>,
        states: &mut HashMap<String, SymbolState>,
    ) {
        let short_code = match self.resolve_code(&index.s, isin_cache) {
            Some(c) => c.clone(),
            None => return,
        };

        let state = states.entry(short_code).or_default();
        let fl = index.fl;
        let i1 = parse_f64(&index.i1);
        let i2_str = &index.i2;

        if (fl & INDEX_EXCHANGE_NAV) != 0 {
            // fl=1: 거래소 공식 iNAV (i1=현재, i2=전일종가)
            if i1 > 0.0 {
                state.inav = i1;
            }
        } else if (fl & INDEX_REAL_NAV) != 0 && (fl & INDEX_TRADE) != 0 {
            // fl=10: rNAV (체결 기반)
            if i1 > 0.0 {
                state.rnav_trade = i1;
            }
        } else if (fl & INDEX_REAL_NAV) != 0 && (fl & INDEX_QUOTE) != 0 {
            // fl=18: rNAV (호가 기반) — i1=bid NAV, i2=ask NAV
            if i1 > 0.0 {
                state.rnav_bid = i1;
            }
            let i2 = parse_f64(i2_str);
            if i2 > 0.0 {
                state.rnav_ask = i2;
            }
        } else if (fl & INDEX_FUTURES_IDEAL) != 0 && (fl & INDEX_TRADE) != 0 {
            // fl=12: 선물 이론가 (체결 기반)
            if i1 > 0.0 {
                state.futures_ideal_trade = i1;
            }
        } else if (fl & INDEX_FUTURES_IDEAL) != 0 && (fl & INDEX_QUOTE) != 0 {
            // fl=20: 선물 이론가 (호가 기반)
            if i1 > 0.0 {
                state.futures_ideal_bid = i1;
            }
            let i2 = parse_f64(i2_str);
            if i2 > 0.0 {
                state.futures_ideal_ask = i2;
            }
        }
    }
}

impl MarketFeed for InternalFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, cancel: CancellationToken) {
        let mut attempt = 0u32;

        loop {
            if cancel.is_cancelled() {
                return;
            }

            match self.connect_and_stream(&tx, &cancel).await {
                Ok(()) => return, // 정상 종료 (cancel)
                Err(e) => {
                    attempt += 1;
                    let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                    warn!(
                        "Internal server disconnected: {e} — reconnecting in {delay}s (attempt {attempt})"
                    );

                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                        _ = cancel.cancelled() => { return; }
                    }
                }
            }
        }
    }
}

// ── 유틸리티 ──

fn parse_f64(s: &str) -> f64 {
    s.parse().unwrap_or(0.0)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// epoch 마이크로초 → ISO 8601 문자열
fn epoch_us_to_iso(us: i64) -> String {
    let dt: DateTime<Utc> = DateTime::from_timestamp_micros(us)
        .unwrap_or_default();
    dt.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}
