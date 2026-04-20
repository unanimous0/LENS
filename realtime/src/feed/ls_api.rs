use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick, StockTick};

use super::{MarketFeed, SubCommand};

const WS_URL: &str = "wss://openapi.ls-sec.co.kr:9443/websocket";
const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const MAX_RECONNECT_DELAY_SECS: u64 = 60;

/// LS증권 OpenAPI WebSocket 피드
pub struct LsApiFeed {
    app_key: String,
    app_secret: String,
    /// 구독할 종목: (TR코드, 종목코드) 목록
    subscriptions: Vec<(String, String)>,
    /// 종목코드 → 종목명 매핑 (표시용)
    names: HashMap<String, String>,
    /// 현물 주식 코드 (ETF가 아닌 종목). StockTick으로 전송.
    stock_codes: std::collections::HashSet<String>,
    /// 선물코드 → 현물코드 매핑 (JC0 틱에서 StockTick 발행용)
    futures_to_spot: HashMap<String, String>,
    /// 코스닥 종목 코드 Set. S3_(코스피) 대신 K3_(코스닥)로 구독.
    kosdaq_codes: std::collections::HashSet<String>,
}

impl LsApiFeed {
    pub fn new(
        app_key: String,
        app_secret: String,
        subscriptions: Vec<(String, String)>,
        names: HashMap<String, String>,
        stock_codes: std::collections::HashSet<String>,
        futures_to_spot: HashMap<String, String>,
        kosdaq_codes: std::collections::HashSet<String>,
    ) -> Self {
        Self {
            app_key,
            app_secret,
            subscriptions,
            names,
            stock_codes,
            futures_to_spot,
            kosdaq_codes,
        }
    }

    async fn get_token(&self) -> Result<String, String> {
        let client = reqwest::Client::new();
        let params = [
            ("grant_type", "client_credentials"),
            ("appkey", &self.app_key),
            ("appsecretkey", &self.app_secret),
            ("scope", "oob"),
        ];
        let resp = client
            .post(TOKEN_URL)
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("token request failed: {e}"))?;

        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("token parse failed: {e}"))?;

        body["access_token"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| format!("no access_token in response: {body}"))
    }

    /// WebSocket 연결 + 구독 + 수신. 끊기면 return.
    async fn connect_and_stream(
        &self,
        tx: &mpsc::Sender<WsMessage>,
        sub_rx: &mut mpsc::UnboundedReceiver<SubCommand>,
        token_cache: &mut Option<String>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        // 토큰: 캐시된 것 사용, 없으면 새로 발급
        let token = if let Some(t) = token_cache.as_ref() {
            t.clone()
        } else {
            let t = self.get_token().await?;
            info!("LS API token acquired: {}...", &t[..20]);
            *token_cache = Some(t.clone());
            t
        };

        // WebSocket 연결
        let mut request = WS_URL.into_client_request().expect("invalid WS URL");
        let headers = request.headers_mut();
        headers.insert(
            "User-Agent",
            HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LENS_Terminal/1.0",
            ),
        );
        headers.insert(
            "Accept-Language",
            HeaderValue::from_static("ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"),
        );

        let connector = tokio_tungstenite::Connector::NativeTls(
            native_tls::TlsConnector::new().expect("TLS connector failed"),
        );
        let (ws_stream, resp) = tokio_tungstenite::connect_async_tls_with_config(
            request, None, false, Some(connector),
        )
        .await
        .map_err(|e| format!("WebSocket connection failed: {e}"))?;

        info!("LS API WebSocket connected (status: {})", resp.status());

        let (write, mut read) = ws_stream.split();
        let write = Arc::new(tokio::sync::Mutex::new(write));

        // 종목 구독
        for (tr_cd, tr_key) in &self.subscriptions {
            let sub = serde_json::json!({
                "header": {"token": token, "tr_type": "3"},
                "body": {"tr_cd": tr_cd, "tr_key": tr_key}
            });
            write.lock().await
                .send(tungstenite::Message::Text(sub.to_string().into()))
                .await
                .map_err(|e| format!("subscribe failed: {e}"))?;
            info!("Subscribed: {tr_cd} {tr_key}");
        }

        // 수신 루프
        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(tungstenite::Message::Text(text))) => {
                            self.handle_message(&text, tx).await;
                        }
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            if let Ok(text) = String::from_utf8(data.to_vec()) {
                                self.handle_message(&text, tx).await;
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
                    match cmd {
                        Some(SubCommand::Subscribe(codes)) => {
                            let w = write.clone();
                            let t = token.clone();
                            let kd = self.kosdaq_codes.clone();
                            tokio::spawn(async move {
                                info!("Runtime subscribing {} codes", codes.len());
                                for code in &codes {
                                    let tr_cd = if code.len() == 8 && code.starts_with('A') { "JC0" }
                                        else if code.starts_with("101") || code.starts_with("106") || code.starts_with("109") { "FC0" }
                                        else if kd.contains(code.as_str()) { "K3_" }
                                        else { "S3_" };
                                    let tr_key = code.as_str();
                                    let sub = serde_json::json!({
                                        "header": {"token": t, "tr_type": "3"},
                                        "body": {"tr_cd": tr_cd, "tr_key": tr_key}
                                    });
                                    let _ = w.lock().await.send(tungstenite::Message::Text(sub.to_string().into())).await;
                                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                                }
                                info!("Runtime subscribe done: {} codes", codes.len());
                            });
                        }
                        Some(SubCommand::Unsubscribe(codes)) => {
                            let w = write.clone();
                            let t = token.clone();
                            let kd = self.kosdaq_codes.clone();
                            tokio::spawn(async move {
                                info!("Runtime unsubscribing {} codes", codes.len());
                                for code in &codes {
                                    let tr_cd = if code.len() == 8 && code.starts_with('A') { "JC0" }
                                        else if code.starts_with("101") || code.starts_with("106") || code.starts_with("109") { "FC0" }
                                        else if kd.contains(code.as_str()) { "K3_" }
                                        else { "S3_" };
                                    let tr_key = code.as_str();
                                    let unsub = serde_json::json!({
                                        "header": {"token": t, "tr_type": "4"},
                                        "body": {"tr_cd": tr_cd, "tr_key": tr_key}
                                    });
                                    let _ = w.lock().await.send(tungstenite::Message::Text(unsub.to_string().into())).await;
                                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                                }
                            });
                        }
                        None => {}
                    }
                }
                _ = cancel.cancelled() => {
                    info!("LsApiFeed cancelled");
                    let _ = write.lock().await.send(tungstenite::Message::Close(None)).await;
                    return Ok(()); // 정상 종료, 재연결 안 함
                }
            }
        }
    }
}

impl MarketFeed for LsApiFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, mut sub_rx: mpsc::UnboundedReceiver<SubCommand>, cancel: CancellationToken) {
        let mut attempt = 0u32;
        let mut token_cache: Option<String> = None;

        loop {
            if cancel.is_cancelled() {
                return;
            }

            match self.connect_and_stream(&tx, &mut sub_rx, &mut token_cache, &cancel).await {
                Ok(()) => return,
                Err(e) => {
                    attempt += 1;
                    let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                    warn!("LS API disconnected: {e} — reconnecting in {delay}s (attempt {attempt})");
                    // 토큰 무효화 (재연결 시 새로 발급)
                    token_cache = None;

                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                        _ = cancel.cancelled() => { return; }
                    }
                }
            }
        }
    }
}

impl LsApiFeed {
    /// 종목 코드에서 LS API TR 코드 추론.
    /// - 주식선물 (8자리, A+숫자 시작) → JC0
    /// - 지수선물 (101, 106 등 시작) → FC0
    /// - 코스닥 (kosdaq_codes에 있으면) → K3_
    /// - 나머지 (6자리 숫자) → S3_ (코스피)
    fn code_to_tr<'a>(&self, code: &'a str) -> (&'static str, &'a str) {
        if code.len() == 8 && code.starts_with('A') {
            ("JC0", code)
        } else if code.len() >= 4
            && (code.starts_with("101")
                || code.starts_with("106")
                || code.starts_with("109"))
        {
            ("FC0", code)
        } else if self.kosdaq_codes.contains(code) {
            ("K3_", code)
        } else {
            ("S3_", code)
        }
    }
}

impl LsApiFeed {
    async fn handle_message(&self, text: &str, tx: &mpsc::Sender<WsMessage>) {
        let data: serde_json::Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(_) => return,
        };

        let header = &data["header"];
        let body = &data["body"];

        if body.is_null() {
            let rsp_msg = header["rsp_msg"].as_str().unwrap_or("");
            let tr_cd = header["tr_cd"].as_str().unwrap_or("");
            info!("LS API response: {tr_cd} → {rsp_msg}");
            return;
        }

        let tr_cd = header["tr_cd"].as_str().unwrap_or("");
        let tr_key = header["tr_key"].as_str().unwrap_or("");
        let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
        let name = self
            .names
            .get(tr_key)
            .map(|s| s.as_str())
            .unwrap_or(tr_key);

        match tr_cd {
            "S3_" | "K3_" => {
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);
                // value = 누적거래대금 (백만원 단위)
                let value = parse_u64(&body["value"]);

                if self.stock_codes.contains(tr_key) {
                    // 현물 주식 → StockTick (cum_volume에 거래대금 저장)
                    let msg = WsMessage::StockTick(StockTick {
                        code: tr_key.to_string(),
                        name: name.to_string(),
                        price,
                        volume,
                        cum_volume: value * 1_000_000, // 백만원 → 원
                        timestamp: now,
                    });
                    let _ = tx.send(msg).await;
                } else {
                    // ETF → EtfTick
                    let offerho = parse_f64(&body["offerho"]);
                    let bidho = parse_f64(&body["bidho"]);
                    let nav = (offerho + bidho) / 2.0;
                    let spread_bp = if nav > 0.0 {
                        (price - nav) / nav * 10000.0
                    } else {
                        0.0
                    };
                    let msg = WsMessage::EtfTick(EtfTick {
                        code: tr_key.to_string(),
                        name: name.to_string(),
                        price,
                        nav: round2(nav),
                        spread_bp: round2(spread_bp),
                        spread_bid_bp: 0.0,
                        spread_ask_bp: 0.0,
                        volume,
                        timestamp: now,
                    });
                    let _ = tx.send(msg).await;
                }
            }
            "JC0" => {
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);
                let underlying = parse_f64(&body["basprice"]);
                let basis = if underlying > 0.0 { price - underlying } else { 0.0 };

                let msg = WsMessage::FuturesTick(FuturesTick {
                    code: tr_key.to_string(),
                    name: name.to_string(),
                    price,
                    underlying_price: underlying,
                    basis: round2(basis),
                    volume,
                    timestamp: now.clone(),
                });
                let _ = tx.send(msg).await;

                // 기초자산 StockTick도 발행 (현물 S3_ 체결 없어도 가격 갱신)
                if underlying > 0.0 {
                    if let Some(spot_code) = self.futures_to_spot.get(tr_key) {
                        let spot_name = self.names.get(spot_code)
                            .cloned().unwrap_or_else(|| spot_code.clone());
                        let msg = WsMessage::StockTick(StockTick {
                            code: spot_code.clone(),
                            name: spot_name,
                            price: underlying,
                            volume: 0,
                            cum_volume: 0, // JC0에서는 거래대금 모름 — 0이면 store에서 기존값 유지
                            timestamp: now,
                        });
                        let _ = tx.send(msg).await;
                    }
                }
            }
            "FC0" => {
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);
                let underlying = parse_f64(&body["k200jisu"]);
                let basis = price - underlying;

                let msg = WsMessage::FuturesTick(FuturesTick {
                    code: tr_key.to_string(),
                    name: name.to_string(),
                    price,
                    underlying_price: round2(underlying),
                    basis: round2(basis),
                    volume,
                    timestamp: now,
                });
                let _ = tx.send(msg).await;
            }
            _ => {}
        }
    }
}

fn parse_f64(v: &serde_json::Value) -> f64 {
    match v {
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0),
        serde_json::Value::String(s) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn parse_u64(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0),
        serde_json::Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
