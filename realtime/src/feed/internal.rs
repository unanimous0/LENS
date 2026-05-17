use std::collections::{HashMap, HashSet};

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
use crate::model::tick::{EtfTick, FuturesTick, OrderbookLevel, OrderbookTick, StockTick};

use super::{MarketFeed, SubCommand};

const MAX_RECONNECT_DELAY_SECS: u64 = 60;

/// 사내 거래소 데이터 수신 서버 피드
pub struct InternalFeed {
    ws_url: String,
    subscribe_codes: Vec<String>,
    names: HashMap<String, String>,
    real_nav: bool,
}

/// 종목별 최신 상태 (Index/LpBookSnapshot으로 갱신, Trade 시 참조)
struct SymbolState {
    // NAV
    rnav_trade: f64,
    rnav_bid: f64,
    rnav_ask: f64,
    inav: f64,
    // 선물 이론가
    futures_ideal_trade: f64,
    futures_ideal_bid: f64,
    futures_ideal_ask: f64,
    // 호가 (LpBookSnapshot에서 갱신)
    best_bid: f64,
    best_ask: f64,
    // 종목 특성
    is_futures: bool,
    /// ETF 여부 (NAV 데이터가 한 번이라도 왔으면 ETF로 판별)
    is_etf: bool,
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
            best_bid: 0.0,
            best_ask: 0.0,
            is_futures: false,
            is_etf: false,
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

    async fn connect_and_stream(
        &self,
        tx: &mpsc::Sender<WsMessage>,
        sub_rx: &mut mpsc::UnboundedReceiver<SubCommand>,
        cancel: &CancellationToken,
        current_switchable: &mut Vec<String>,
        active_ob_codes: &mut HashSet<String>,
        // ref-count: 다중 페이지·다중 클라이언트가 같은 코드 공유. 0 도달 시만 server unsubscribe.
        current_stocks: &mut HashMap<String, u32>,
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

        // 시작 시 startup 코드 + 재연결 시 누적된 동적 stocks/futures 모두 한번에 구독.
        let mut startup_set: HashSet<String> = self.subscribe_codes.iter().cloned().collect();
        for c in current_switchable.iter() { startup_set.insert(c.clone()); }
        for c in current_stocks.keys() { startup_set.insert(c.clone()); }
        let symbols: Vec<String> = startup_set.into_iter().collect();
        let sub_msg = serde_json::json!({
            "symbols": &symbols,
            "real_nav": self.real_nav,
        });
        write
            .send(tungstenite::Message::Text(sub_msg.to_string().into()))
            .await
            .map_err(|e| format!("subscribe send failed: {e}"))?;

        info!(
            "Internal subscribed: {} codes (startup {}, switchable {}, stocks {}, real_nav={})",
            symbols.len(), self.subscribe_codes.len(), current_switchable.len(), current_stocks.len(), self.real_nav
        );

        let mut isin_cache: HashMap<String, String> = HashMap::new();
        let mut states: HashMap<String, SymbolState> = HashMap::new();

        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(tungstenite::Message::Text(text))) => {
                            self.handle_message(&text, tx, &mut isin_cache, &mut states, active_ob_codes).await;
                        }
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            if let Ok(text) = String::from_utf8(data.to_vec()) {
                                self.handle_message(&text, tx, &mut isin_cache, &mut states, active_ob_codes).await;
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
                cmd = sub_rx.recv() => {
                    use crate::model::internal::short_to_subscribe;
                    match cmd {
                        Some(SubCommand::Subscribe(codes)) => {
                            // 이전 전환 그룹 해지
                            if !current_switchable.is_empty() {
                                let unsub_msg = serde_json::json!({
                                    "unsubscribe": &current_switchable,
                                });
                                let _ = write.send(tungstenite::Message::Text(unsub_msg.to_string().into())).await;
                                info!("Auto-unsubscribe previous: {} codes", current_switchable.len());
                            }
                            // 새 코드 구독
                            let sub_codes: Vec<String> = codes.iter()
                                .map(|c| short_to_subscribe(c))
                                .collect();
                            let sub_msg = serde_json::json!({
                                "symbols": sub_codes,
                                "real_nav": self.real_nav,
                            });
                            let _ = write.send(tungstenite::Message::Text(sub_msg.to_string().into())).await;
                            info!("Runtime subscribe: {:?} ({} codes)", sub_codes.first(), sub_codes.len());
                            *current_switchable = sub_codes;
                        }
                        Some(SubCommand::Unsubscribe(codes)) => {
                            let unsub_codes: Vec<String> = codes.iter()
                                .map(|c| short_to_subscribe(c))
                                .collect();
                            let unsub_msg = serde_json::json!({
                                "unsubscribe": unsub_codes,
                            });
                            let _ = write.send(tungstenite::Message::Text(unsub_msg.to_string().into())).await;
                            info!("Runtime unsubscribe: {:?}", unsub_codes);
                            // 전환 그룹에서도 제거
                            current_switchable.retain(|c| !unsub_codes.contains(c));
                        }
                        Some(SubCommand::SubscribeStocks(codes)) => {
                            // ref-count: 처음 보는 코드만 server subscribe.
                            let mut newly_added: Vec<String> = Vec::new();
                            for c in &codes {
                                let key = short_to_subscribe(c);
                                let count = current_stocks.entry(key.clone()).or_insert(0);
                                *count += 1;
                                if *count == 1 { newly_added.push(key); }
                            }
                            if newly_added.is_empty() {
                                info!("SubscribeStocks: +{} (refcount only)", codes.len());
                                continue;
                            }
                            let sub_msg = serde_json::json!({
                                "symbols": &newly_added,
                                "real_nav": self.real_nav,
                            });
                            let _ = write.send(tungstenite::Message::Text(sub_msg.to_string().into())).await;
                            info!("SubscribeStocks: +{} new ({} unique)", newly_added.len(), current_stocks.len());
                        }
                        Some(SubCommand::UnsubscribeStocks(codes)) => {
                            let mut actually_dropped: Vec<String> = Vec::new();
                            for c in &codes {
                                let key = short_to_subscribe(c);
                                if let Some(count) = current_stocks.get_mut(&key) {
                                    *count = count.saturating_sub(1);
                                    if *count == 0 { actually_dropped.push(key); }
                                }
                            }
                            for c in &actually_dropped { current_stocks.remove(c); }
                            if actually_dropped.is_empty() { continue; }
                            let unsub_msg = serde_json::json!({
                                "unsubscribe": &actually_dropped,
                            });
                            let _ = write.send(tungstenite::Message::Text(unsub_msg.to_string().into())).await;
                            info!("UnsubscribeStocks: -{} actually dropped (out of {} requests)", actually_dropped.len(), codes.len());
                        }
                        Some(SubCommand::SubscribeInav(_)) | Some(SubCommand::UnsubscribeInav(_)) => {
                            // 내부망은 nav가 trade tick과 함께 흘러옴 (rnav_trade/inav). 별도 구독 불필요.
                        }
                        Some(SubCommand::PrioritizeStocks(_)) => {
                            // 내부망은 데이터 즉시 도착 — 우선화 의미 없음. no-op.
                        }
                        Some(SubCommand::SubscribeOrderbook { codes }) => {
                            // 내부망은 호가가 자동으로 오므로 서버 구독 불필요.
                            // 활성 코드만 추적하여 발행 필터링.
                            active_ob_codes.clear();
                            for (_, code) in &codes {
                                active_ob_codes.insert(code.clone());
                            }
                            info!("Orderbook filter active: {} codes", active_ob_codes.len());
                        }
                        Some(SubCommand::UnsubscribeOrderbook) => {
                            active_ob_codes.clear();
                            info!("Orderbook filter cleared");
                        }
                        None => {}
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

    async fn handle_message(
        &self,
        text: &str,
        tx: &mpsc::Sender<WsMessage>,
        isin_cache: &mut HashMap<String, String>,
        states: &mut HashMap<String, SymbolState>,
        active_ob_codes: &HashSet<String>,
    ) {
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

        let msgs: Vec<InternalMsg> = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
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
                    self.handle_book(&book, tx, isin_cache, states, active_ob_codes).await;
                }
                InternalMsg::Index(index) => {
                    self.handle_index(&index, isin_cache, states);
                }
                InternalMsg::Auction(_) | InternalMsg::Status(_) => {}
            }
        }
    }

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

    /// Trade → 종목 특성에 따라 StockTick / EtfTick / FuturesTick 전송
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
        let cum_volume: u64 = trade.cs.parse().unwrap_or(0);
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
            // 선물 → FuturesTick
            let underlying = if state.futures_ideal_trade > 0.0 {
                state.futures_ideal_trade
            } else {
                0.0
            };
            let basis = price - underlying;

            debug!("{name} {price} (기초 {underlying}, 베이시스 {basis}) x{volume}");
            let msg = WsMessage::FuturesTick(FuturesTick {
                code: short_code,
                name,
                price,
                underlying_price: round2(underlying),
                basis: round2(basis),
                volume,
                timestamp,
                is_initial: false,
                open_interest: None,
                open_interest_change: None,
            });
            let _ = tx.send(msg).await;
        } else if state.is_etf {
            // ETF → EtfTick (NAV 데이터가 한 번이라도 온 종목)
            let nav = if state.rnav_trade > 0.0 {
                state.rnav_trade
            } else if state.inav > 0.0 {
                state.inav
            } else {
                0.0
            };

            let spread_bp = calc_spread_bp(price, nav);
            let spread_bid_bp = calc_spread_bp(state.best_bid, nav);
            let spread_ask_bp = calc_spread_bp(state.best_ask, nav);

            debug!("{name} {price} (NAV {nav}, 괴리 {spread_bp:.1}bp, bid {spread_bid_bp:.1}bp, ask {spread_ask_bp:.1}bp) x{volume}");
            let msg = WsMessage::EtfTick(EtfTick {
                code: short_code,
                name,
                price,
                nav: round2(nav),
                spread_bp: round2(spread_bp),
                spread_bid_bp: round2(spread_bid_bp),
                spread_ask_bp: round2(spread_ask_bp),
                volume,
                cum_volume: 0,  // 내부망 stream에 누적 거래량 매핑 미구현
                timestamp,
                prev_close: None,
                last_trade_volume: None,  // 내부망 stream에 cgubun/cvolume 매핑 미구현
                trade_side: None,
                halted: false,
                vi_active: false,
            });
            let _ = tx.send(msg).await;
        } else {
            // 일반 주식 → StockTick
            debug!("{name} {price} x{volume} (누적 {cum_volume})");
            let msg = WsMessage::StockTick(StockTick {
                code: short_code,
                name,
                price,
                volume,
                cum_volume,
                timestamp,
                is_initial: false,
                high: None,
                low: None,
                prev_close: None,
                last_trade_volume: None,
                trade_side: None,
                halted: false,  // 사내망 stream엔 halt 정보 없음
                upper_limit: None,
                lower_limit: None,
                vi_active: false,
                warning: false,
                liquidation: false,
                abnormal_rise: false,
                low_liquidity: false,
                under_management: false,
            });
            let _ = tx.send(msg).await;
        }
    }

    /// LpBookSnapshot → best bid/ask 저장 + OrderbookTick 발행 (활성 코드만)
    async fn handle_book(
        &self,
        book: &LpBookSnapshot,
        tx: &mpsc::Sender<WsMessage>,
        isin_cache: &mut HashMap<String, String>,
        states: &mut HashMap<String, SymbolState>,
        active_ob_codes: &HashSet<String>,
    ) {
        let short_code = match self.resolve_code(&book.s, isin_cache) {
            Some(c) => c.clone(),
            None => return,
        };

        let state = states.entry(short_code.clone()).or_default();

        // best bid/ask 저장 (ETF 스프레드 계산용 — 항상)
        if let Some(first_bid) = book.b.first() {
            state.best_bid = parse_f64(&first_bid[0]);
        }
        if let Some(first_ask) = book.a.first() {
            state.best_ask = parse_f64(&first_ask[0]);
        }

        // 활성 호가 코드가 아니면 발행 안 함 (직렬화+브로드캐스트 비용 절약)
        if active_ob_codes.is_empty() || !active_ob_codes.contains(&short_code) {
            return;
        }

        // OrderbookTick 발행
        let mut asks = Vec::with_capacity(book.a.len());
        let mut bids = Vec::with_capacity(book.b.len());
        let mut total_ask = 0u64;
        let mut total_bid = 0u64;

        for level in &book.a {
            let price = parse_f64(&level[0]);
            let qty: u64 = level[1].parse().unwrap_or(0);
            if price > 0.0 {
                total_ask += qty;
                asks.push(OrderbookLevel { price, quantity: qty });
            }
        }
        for level in &book.b {
            let price = parse_f64(&level[0]);
            let qty: u64 = level[1].parse().unwrap_or(0);
            if price > 0.0 {
                total_bid += qty;
                bids.push(OrderbookLevel { price, quantity: qty });
            }
        }

        let name = self.names.get(&short_code).cloned().unwrap_or_else(|| short_code.clone());
        let timestamp = epoch_us_to_iso(book.et);

        let _ = tx.send(WsMessage::OrderbookTick(OrderbookTick {
            code: short_code, name,
            asks, bids, total_ask_qty: total_ask, total_bid_qty: total_bid,
            timestamp,
        })).await;
    }

    /// Index → fl 비트마스크에 따라 state 갱신
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
            // fl=1: 거래소 iNAV → ETF 확정
            state.is_etf = true;
            if i1 > 0.0 {
                state.inav = i1;
            }
        } else if (fl & INDEX_REAL_NAV) != 0 && (fl & INDEX_TRADE) != 0 {
            // fl=10: rNAV (체결 기반) → ETF 확정
            state.is_etf = true;
            if i1 > 0.0 {
                state.rnav_trade = i1;
            }
        } else if (fl & INDEX_REAL_NAV) != 0 && (fl & INDEX_QUOTE) != 0 {
            // fl=18: rNAV (호가 기반)
            state.is_etf = true;
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
    async fn run(&self, tx: mpsc::Sender<WsMessage>, mut sub_rx: mpsc::UnboundedReceiver<SubCommand>, cancel: CancellationToken) {
        let mut attempt = 0u32;
        // 재연결 시에도 유지되는 상태
        let mut current_switchable: Vec<String> = Vec::new();
        let mut active_ob_codes: HashSet<String> = HashSet::new();
        let mut current_stocks: HashMap<String, u32> = HashMap::new();

        loop {
            if cancel.is_cancelled() {
                return;
            }

            match self.connect_and_stream(&tx, &mut sub_rx, &cancel, &mut current_switchable, &mut active_ob_codes, &mut current_stocks).await {
                Ok(()) => return,
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

/// (value - nav) / nav × 10000. nav가 0이면 0.0 반환.
fn calc_spread_bp(value: f64, nav: f64) -> f64 {
    if nav > 0.0 && value > 0.0 {
        (value - nav) / nav * 10000.0
    } else {
        0.0
    }
}

fn epoch_us_to_iso(us: i64) -> String {
    let dt: DateTime<Utc> = DateTime::from_timestamp_micros(us).unwrap_or_default();
    dt.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}
