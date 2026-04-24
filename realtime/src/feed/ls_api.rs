use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use std::sync::atomic::Ordering;

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick, OrderbookLevel, OrderbookTick, StockTick};
use crate::Stats;

use super::{MarketFeed, SubCommand};

const WS_URL: &str = "wss://openapi.ls-sec.co.kr:9443/websocket";
const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const MAX_RECONNECT_DELAY_SECS: u64 = 60;
const MAX_SUBS_PER_CONNECTION: usize = 190;

/// LS증권 OpenAPI WebSocket 피드.
/// 구독 수가 190개를 초과하면 여러 WebSocket 연결로 자동 분산.
///
/// 대형 map/set들은 `Arc<...>`로 저장. 연결 재생성(월물 전환·재연결)마다
/// `.clone()` 호출되는데 HashMap/HashSet 전체 복제 대신 Arc refcount만 증가.
pub struct LsApiFeed {
    pub app_key: String,
    pub app_secret: String,
    pub subscriptions: Vec<(String, String)>,
    pub names: Arc<HashMap<String, String>>,
    pub stock_codes: Arc<HashSet<String>>,
    pub futures_to_spot: Arc<HashMap<String, String>>,
    pub kosdaq_codes: Arc<HashSet<String>>,
    pub stats: Arc<Stats>,
}

impl LsApiFeed {
    pub fn new(
        app_key: String,
        app_secret: String,
        subscriptions: Vec<(String, String)>,
        names: HashMap<String, String>,
        stock_codes: HashSet<String>,
        futures_to_spot: HashMap<String, String>,
        kosdaq_codes: HashSet<String>,
        stats: Arc<Stats>,
    ) -> Self {
        Self {
            app_key, app_secret, subscriptions,
            names: Arc::new(names),
            stock_codes: Arc::new(stock_codes),
            futures_to_spot: Arc::new(futures_to_spot),
            kosdaq_codes: Arc::new(kosdaq_codes),
            stats,
        }
    }
}

impl MarketFeed for LsApiFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, mut sub_rx: mpsc::UnboundedReceiver<SubCommand>, cancel: CancellationToken) {
        // 고정 그룹 (현물 S3_/K3_ + 스프레드 D코드): 변경 없음
        let fixed: Vec<(String, String)> = self.subscriptions.iter()
            .filter(|(_, key)| !key.starts_with('A') || key.len() != 8)  // A+7자리 선물코드가 아닌 것
            .cloned().collect();

        // 전환 그룹 (선물 JC0 A코드): 월물 전환 대상
        let initial_futures: Vec<(String, String)> = self.subscriptions.iter()
            .filter(|(tr, key)| tr == "JC0" && key.starts_with('A') && key.len() == 8)
            .cloned().collect();

        info!("LS API: fixed={} (spot+spread), switchable={} (futures)",
            fixed.len(), initial_futures.len());

        // 초기값 fetch (t8402) — WebSocket과 동시 실행, is_initial=true
        {
            let all_subs = self.subscriptions.clone();
            let tx2 = tx.clone();
            let cancel2 = cancel.clone();
            let ak = self.app_key.clone();
            let as_ = self.app_secret.clone();
            let n = self.names.clone();
            let sc = self.stock_codes.clone();
            let f2s = self.futures_to_spot.clone();
            let stats = self.stats.clone();
            tokio::spawn(async move {
                super::ls_rest::fetch_initial_prices(
                    &ak, &as_, &all_subs, &n, &sc, &f2s, &tx2, &cancel2, &stats,
                ).await;
            });
        }

        // 고정 그룹 연결 시작
        let fixed_chunks: Vec<Vec<(String, String)>> = fixed
            .chunks(MAX_SUBS_PER_CONNECTION).map(|c| c.to_vec()).collect();

        for (i, chunk) in fixed_chunks.into_iter().enumerate() {
            let tx = tx.clone();
            let cancel = cancel.clone();
            let app_key = self.app_key.clone();
            let app_secret = self.app_secret.clone();
            let names = self.names.clone();
            let stock_codes = self.stock_codes.clone();
            let futures_to_spot = self.futures_to_spot.clone();
            let stats = self.stats.clone();

            tokio::spawn(async move {
                let mut attempt = 0u32;
                loop {
                    if cancel.is_cancelled() { return; }
                    match run_single_connection(
                        i, &app_key, &app_secret, &chunk, &names, &stock_codes, &futures_to_spot, &tx, &cancel,
                    ).await {
                        Ok(()) => return,
                        Err(e) => {
                            attempt += 1;
                            stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                            let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                            warn!("fixed[{i}] disconnected: {e} — reconnecting in {delay}s");
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                                _ = cancel.cancelled() => { return; }
                            }
                        }
                    }
                }
            });
        }

        // 전환 그룹: 선물 연결 관리
        let app_key = self.app_key.clone();
        let app_secret = self.app_secret.clone();
        let names = self.names.clone();
        let stock_codes = self.stock_codes.clone();
        let futures_to_spot = self.futures_to_spot.clone();

        // 초기 선물 연결 시작
        let mut futures_cancel = CancellationToken::new();
        let stats = self.stats.clone();
        spawn_futures_connections(
            &initial_futures, &app_key, &app_secret, &names, &stock_codes,
            &futures_to_spot, &tx, &cancel, &futures_cancel, &stats,
        );

        // 호가 전용 연결 (온디맨드)
        let mut ob_cancel = CancellationToken::new();

        // sub_rx에서 전환 명령 대기
        loop {
            tokio::select! {
                cmd = sub_rx.recv() => {
                    match cmd {
                        Some(SubCommand::Subscribe(codes)) => {
                            // 기존 선물 연결 종료
                            futures_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            // 새 선물 코드로 연결
                            let new_futures: Vec<(String, String)> = codes.iter()
                                .map(|c| ("JC0".to_string(), c.clone()))
                                .collect();
                            info!("Switching futures: {} codes", new_futures.len());

                            futures_cancel = CancellationToken::new();
                            spawn_futures_connections(
                                &new_futures, &app_key, &app_secret, &names, &stock_codes,
                                &futures_to_spot, &tx, &cancel, &futures_cancel, &stats,
                            );
                        }
                        Some(SubCommand::Unsubscribe(_)) => {
                            futures_cancel.cancel();
                        }
                        Some(SubCommand::SubscribeOrderbook { codes }) => {
                            // 기존 호가 연결 종료
                            ob_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;

                            info!("Orderbook subscribe: {:?}", codes);
                            ob_cancel = CancellationToken::new();
                            spawn_orderbook_connection(
                                &codes, &app_key, &app_secret, &names,
                                &stock_codes, &futures_to_spot, &tx, &cancel, &ob_cancel, &stats,
                            );
                        }
                        Some(SubCommand::UnsubscribeOrderbook) => {
                            info!("Orderbook unsubscribe");
                            ob_cancel.cancel();
                        }
                        None => break,
                    }
                }
                _ = cancel.cancelled() => {
                    futures_cancel.cancel();
                    ob_cancel.cancel();
                    return;
                }
            }
        }
    }
}

/// 선물 전용 연결 그룹 스폰 (전환 가능)
fn spawn_futures_connections(
    futures: &[(String, String)],
    app_key: &str, app_secret: &str,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    global_cancel: &CancellationToken,
    futures_cancel: &CancellationToken,
    stats: &Arc<Stats>,
) {
    let chunks: Vec<Vec<(String, String)>> = futures
        .chunks(MAX_SUBS_PER_CONNECTION).map(|c| c.to_vec()).collect();

    for (i, chunk) in chunks.into_iter().enumerate() {
        let tx = tx.clone();
        let gc = global_cancel.clone();
        let fc = futures_cancel.clone();
        let ak = app_key.to_string();
        let as_ = app_secret.to_string();
        let n = names.clone();
        let sc = stock_codes.clone();
        let f2s = futures_to_spot.clone();
        let stats = stats.clone();

        tokio::spawn(async move {
            let combined_cancel = CancellationToken::new();
            let gc2 = gc.clone();
            let fc2 = fc.clone();
            let cc = combined_cancel.clone();
            // global 또는 futures cancel 어느 쪽이든 이 연결 종료
            tokio::spawn(async move {
                tokio::select! {
                    _ = gc2.cancelled() => cc.cancel(),
                    _ = fc2.cancelled() => cc.cancel(),
                }
            });

            let mut attempt = 0u32;
            loop {
                if combined_cancel.is_cancelled() { return; }
                let conn_id = 100 + i; // 고정 그룹과 구분
                match run_single_connection(
                    conn_id, &ak, &as_, &chunk, &n, &sc, &f2s, &tx, &combined_cancel,
                ).await {
                    Ok(()) => return,
                    Err(e) => {
                        if combined_cancel.is_cancelled() { return; }
                        attempt += 1;
                        stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                        let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                        warn!("futures[{i}] disconnected: {e} — reconnecting in {delay}s");
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                            _ = combined_cancel.cancelled() => { return; }
                        }
                    }
                }
            }
        });
    }
}

/// 호가 전용 연결 스폰 (온디맨드, 최대 2-3 종목)
fn spawn_orderbook_connection(
    codes: &[(String, String)],
    app_key: &str, app_secret: &str,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    global_cancel: &CancellationToken,
    ob_cancel: &CancellationToken,
    stats: &Arc<Stats>,
) {
    let codes = codes.to_vec();
    let tx = tx.clone();
    let gc = global_cancel.clone();
    let fc = ob_cancel.clone();
    let ak = app_key.to_string();
    let as_ = app_secret.to_string();
    let n = names.clone();
    let sc = stock_codes.clone();
    let f2s = futures_to_spot.clone();
    let stats = stats.clone();

    tokio::spawn(async move {
        let combined = CancellationToken::new();
        let gc2 = gc.clone();
        let fc2 = fc.clone();
        let cc = combined.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = gc2.cancelled() => cc.cancel(),
                _ = fc2.cancelled() => cc.cancel(),
            }
        });

        let mut attempt = 0u32;
        loop {
            if combined.is_cancelled() { return; }
            match run_single_connection(
                200, &ak, &as_, &codes, &n, &sc, &f2s, &tx, &combined,
            ).await {
                Ok(()) => return,
                Err(e) => {
                    if combined.is_cancelled() { return; }
                    attempt += 1;
                    stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                    let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                    warn!("orderbook disconnected: {e} — reconnecting in {delay}s");
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                        _ = combined.cancelled() => { return; }
                    }
                }
            }
        }
    });
}

/// 단일 WebSocket 연결: 토큰 발급 → 연결 → 구독 → 수신 루프
async fn run_single_connection(
    conn_id: usize,
    app_key: &str,
    app_secret: &str,
    subscriptions: &[(String, String)],
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    // 토큰 발급
    let client = reqwest::Client::new();
    let resp = client.post(TOKEN_URL)
        .form(&[("grant_type", "client_credentials"), ("appkey", app_key), ("appsecretkey", app_secret), ("scope", "oob")])
        .send().await.map_err(|e| format!("token: {e}"))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("token parse: {e}"))?;
    let token = body["access_token"].as_str().ok_or("no token")?.to_string();
    info!("conn[{conn_id}] token ok");

    // WebSocket 연결
    let mut request = WS_URL.into_client_request().expect("bad URL");
    request.headers_mut().insert("User-Agent", HeaderValue::from_static("Mozilla/5.0 LENS/1.0"));
    request.headers_mut().insert("Accept-Language", HeaderValue::from_static("ko-KR,ko;q=0.9"));

    let connector = tokio_tungstenite::Connector::NativeTls(native_tls::TlsConnector::new().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector))
        .await.map_err(|e| format!("ws connect: {e}"))?;

    let (mut write, mut read) = ws.split();
    info!("conn[{conn_id}] connected, subscribing {} codes", subscriptions.len());

    // 구독
    for (tr_cd, tr_key) in subscriptions {
        let msg = serde_json::json!({"header": {"token": &token, "tr_type": "3"}, "body": {"tr_cd": tr_cd, "tr_key": tr_key}});
        write.send(tungstenite::Message::Text(msg.to_string().into())).await.map_err(|e| format!("sub: {e}"))?;
    }
    info!("conn[{conn_id}] all subscribed");

    // 수신 루프
    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(tungstenite::Message::Text(text))) => {
                        handle_tick(&text, tx, names, stock_codes, futures_to_spot).await;
                    }
                    Some(Ok(tungstenite::Message::Binary(data))) => {
                        if let Ok(text) = String::from_utf8(data.to_vec()) {
                            handle_tick(&text, tx, names, stock_codes, futures_to_spot).await;
                        }
                    }
                    Some(Ok(tungstenite::Message::Close(f))) => {
                        return Err(format!("closed: {}", f.map(|f| f.reason.to_string()).unwrap_or_default()));
                    }
                    Some(Err(e)) => return Err(format!("error: {e}")),
                    None => return Err("stream ended".into()),
                    _ => {}
                }
            }
            _ = cancel.cancelled() => {
                let _ = write.send(tungstenite::Message::Close(None)).await;
                return Ok(());
            }
        }
    }
}

/// 틱 메시지 파싱 및 WsMessage 발행
async fn handle_tick(
    text: &str,
    tx: &mpsc::Sender<WsMessage>,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
) {
    let data: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let header = &data["header"];
    let body = &data["body"];
    if body.is_null() { return; }

    let tr_cd = header["tr_cd"].as_str().unwrap_or("");
    let tr_key = header["tr_key"].as_str().unwrap_or("");
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    let name = names.get(tr_key).map(|s| s.as_str()).unwrap_or(tr_key);

    match tr_cd {
        "S3_" | "K3_" => {
            let price = pf(&body["price"]);
            let volume = pu(&body["volume"]);
            let value = pu(&body["value"]);

            if stock_codes.contains(tr_key) {
                let _ = tx.send(WsMessage::StockTick(StockTick {
                    code: tr_key.into(), name: name.into(),
                    price, volume, cum_volume: value * 1_000_000, timestamp: now,
                    is_initial: false,
                })).await;
            } else {
                let offerho = pf(&body["offerho"]);
                let bidho = pf(&body["bidho"]);
                let nav = (offerho + bidho) / 2.0;
                let spread_bp = if nav > 0.0 { (price - nav) / nav * 10000.0 } else { 0.0 };
                let _ = tx.send(WsMessage::EtfTick(EtfTick {
                    code: tr_key.into(), name: name.into(),
                    price, nav: r2(nav), spread_bp: r2(spread_bp),
                    spread_bid_bp: 0.0, spread_ask_bp: 0.0, volume, timestamp: now,
                })).await;
            }
        }
        "JC0" => {
            let price = pf(&body["price"]);
            let volume = pu(&body["volume"]);
            let underlying = pf(&body["basprice"]);
            let basis = if underlying > 0.0 { price - underlying } else { 0.0 };

            let _ = tx.send(WsMessage::FuturesTick(FuturesTick {
                code: tr_key.into(), name: name.into(),
                price, underlying_price: underlying, basis: r2(basis), volume, timestamp: now,
                is_initial: false,
            })).await;
            // 주의: 기초자산(현물) StockTick은 파생해서 보내지 않음.
            // 현물은 S3_/K3_로 별도 구독 중이고, 여기서 보내면 cum_volume을 0으로 덮어써버려
            // 현물대금이 빈 칸이 되는 문제가 발생함.
        }
        // 주식 호가 (KOSPI H1_, KOSDAQ HA_): 10호가
        "H1_" | "HA_" => {
            let (asks, bids) = parse_orderbook_levels(body, 10);
            let total_ask = pu(&body["totofferrem"]);
            let total_bid = pu(&body["totbidrem"]);
            let _ = tx.send(WsMessage::OrderbookTick(OrderbookTick {
                code: tr_key.into(), name: name.into(),
                asks, bids, total_ask_qty: total_ask, total_bid_qty: total_bid,
                timestamp: now,
            })).await;
        }
        // 주식선물/스프레드 호가 (JH0): 5호가
        "JH0" => {
            let (asks, bids) = parse_orderbook_levels(body, 5);
            let total_ask = pu(&body["totofferrem"]);
            let total_bid = pu(&body["totbidrem"]);
            let _ = tx.send(WsMessage::OrderbookTick(OrderbookTick {
                code: tr_key.into(), name: name.into(),
                asks, bids, total_ask_qty: total_ask, total_bid_qty: total_bid,
                timestamp: now,
            })).await;
        }
        _ => {}
    }
}

/// 호가 레벨 정적 키 (format!() 할당 제거)
static OB_KEYS: [(&str, &str, &str, &str); 10] = [
    ("offerho1", "offerrem1", "bidho1", "bidrem1"),
    ("offerho2", "offerrem2", "bidho2", "bidrem2"),
    ("offerho3", "offerrem3", "bidho3", "bidrem3"),
    ("offerho4", "offerrem4", "bidho4", "bidrem4"),
    ("offerho5", "offerrem5", "bidho5", "bidrem5"),
    ("offerho6", "offerrem6", "bidho6", "bidrem6"),
    ("offerho7", "offerrem7", "bidho7", "bidrem7"),
    ("offerho8", "offerrem8", "bidho8", "bidrem8"),
    ("offerho9", "offerrem9", "bidho9", "bidrem9"),
    ("offerho10", "offerrem10", "bidho10", "bidrem10"),
];

/// 호가 레벨 파싱: offerho1~N, bidho1~N, offerrem1~N, bidrem1~N
fn parse_orderbook_levels(body: &serde_json::Value, levels: usize) -> (Vec<OrderbookLevel>, Vec<OrderbookLevel>) {
    let mut asks = Vec::with_capacity(levels);
    let mut bids = Vec::with_capacity(levels);
    for &(ak, ark, bk, brk) in &OB_KEYS[..levels] {
        let ask_price = pf(&body[ak]);
        let ask_qty = pu(&body[ark]);
        let bid_price = pf(&body[bk]);
        let bid_qty = pu(&body[brk]);
        if ask_price > 0.0 {
            asks.push(OrderbookLevel { price: ask_price, quantity: ask_qty });
        }
        if bid_price > 0.0 {
            bids.push(OrderbookLevel { price: bid_price, quantity: bid_qty });
        }
    }
    (asks, bids)
}

fn pf(v: &serde_json::Value) -> f64 {
    match v { serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0), serde_json::Value::String(s) => s.parse().unwrap_or(0.0), _ => 0.0 }
}
fn pu(v: &serde_json::Value) -> u64 {
    match v { serde_json::Value::Number(n) => n.as_u64().unwrap_or(0), serde_json::Value::String(s) => s.parse().unwrap_or(0), _ => 0 }
}
fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
