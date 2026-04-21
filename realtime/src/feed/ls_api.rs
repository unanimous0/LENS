use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick, StockTick};

use super::{MarketFeed, SubCommand};

const WS_URL: &str = "wss://openapi.ls-sec.co.kr:9443/websocket";
const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const MAX_RECONNECT_DELAY_SECS: u64 = 60;
const MAX_SUBS_PER_CONNECTION: usize = 190;

/// LS증권 OpenAPI WebSocket 피드.
/// 구독 수가 190개를 초과하면 여러 WebSocket 연결로 자동 분산.
pub struct LsApiFeed {
    pub app_key: String,
    pub app_secret: String,
    pub subscriptions: Vec<(String, String)>,
    pub names: HashMap<String, String>,
    pub stock_codes: HashSet<String>,
    pub futures_to_spot: HashMap<String, String>,
    pub kosdaq_codes: HashSet<String>,
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
    ) -> Self {
        Self { app_key, app_secret, subscriptions, names, stock_codes, futures_to_spot, kosdaq_codes }
    }
}

impl MarketFeed for LsApiFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, mut _sub_rx: mpsc::UnboundedReceiver<SubCommand>, cancel: CancellationToken) {
        let chunks: Vec<Vec<(String, String)>> = self.subscriptions
            .chunks(MAX_SUBS_PER_CONNECTION)
            .map(|c| c.to_vec())
            .collect();

        let n = chunks.len();
        info!("LS API: {} subscriptions → {} connections (max {} per conn)",
            self.subscriptions.len(), n, MAX_SUBS_PER_CONNECTION);

        let mut handles = Vec::new();

        for (i, chunk) in chunks.into_iter().enumerate() {
            let tx = tx.clone();
            let cancel = cancel.clone();
            let app_key = self.app_key.clone();
            let app_secret = self.app_secret.clone();
            let names = self.names.clone();
            let stock_codes = self.stock_codes.clone();
            let futures_to_spot = self.futures_to_spot.clone();

            handles.push(tokio::spawn(async move {
                let mut attempt = 0u32;
                loop {
                    if cancel.is_cancelled() { return; }
                    match run_single_connection(
                        i, &app_key, &app_secret, &chunk, &names, &stock_codes, &futures_to_spot, &tx, &cancel,
                    ).await {
                        Ok(()) => return,
                        Err(e) => {
                            attempt += 1;
                            let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                            warn!("conn[{i}] disconnected: {e} — reconnecting in {delay}s");
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                                _ = cancel.cancelled() => { return; }
                            }
                        }
                    }
                }
            }));
        }

        for h in handles {
            let _ = h.await;
        }
    }
}

/// 단일 WebSocket 연결: 토큰 발급 → 연결 → 구독 → 수신 루프
async fn run_single_connection(
    conn_id: usize,
    app_key: &str,
    app_secret: &str,
    subscriptions: &[(String, String)],
    names: &HashMap<String, String>,
    stock_codes: &HashSet<String>,
    futures_to_spot: &HashMap<String, String>,
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
    names: &HashMap<String, String>,
    stock_codes: &HashSet<String>,
    futures_to_spot: &HashMap<String, String>,
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
                price, underlying_price: underlying, basis: r2(basis), volume, timestamp: now.clone(),
            })).await;

            if underlying > 0.0 {
                if let Some(spot_code) = futures_to_spot.get(tr_key) {
                    let sname = names.get(spot_code).cloned().unwrap_or_else(|| spot_code.clone());
                    let _ = tx.send(WsMessage::StockTick(StockTick {
                        code: spot_code.clone(), name: sname,
                        price: underlying, volume: 0, cum_volume: 0, timestamp: now,
                    })).await;
                }
            }
        }
        _ => {}
    }
}

fn pf(v: &serde_json::Value) -> f64 {
    match v { serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0), serde_json::Value::String(s) => s.parse().unwrap_or(0.0), _ => 0.0 }
}
fn pu(v: &serde_json::Value) -> u64 {
    match v { serde_json::Value::Number(n) => n.as_u64().unwrap_or(0), serde_json::Value::String(s) => s.parse().unwrap_or(0), _ => 0 }
}
fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
