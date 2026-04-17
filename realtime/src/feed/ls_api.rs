use std::collections::HashMap;

use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick};

use super::MarketFeed;

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
}

impl LsApiFeed {
    pub fn new(
        app_key: String,
        app_secret: String,
        subscriptions: Vec<(String, String)>,
        names: HashMap<String, String>,
    ) -> Self {
        Self {
            app_key,
            app_secret,
            subscriptions,
            names,
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
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        // 토큰 발급 (매 연결마다 새로 발급)
        let token = self.get_token().await?;
        info!("LS API token acquired: {}...", &token[..20]);

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

        let (mut write, mut read) = ws_stream.split();

        // 종목 구독
        for (tr_cd, tr_key) in &self.subscriptions {
            let sub = serde_json::json!({
                "header": {"token": token, "tr_type": "3"},
                "body": {"tr_cd": tr_cd, "tr_key": tr_key}
            });
            write
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
                _ = cancel.cancelled() => {
                    info!("LsApiFeed cancelled");
                    let _ = write.send(tungstenite::Message::Close(None)).await;
                    return Ok(()); // 정상 종료, 재연결 안 함
                }
            }
        }
    }
}

impl MarketFeed for LsApiFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, cancel: CancellationToken) {
        let mut attempt = 0u32;

        loop {
            if cancel.is_cancelled() {
                return;
            }

            match self.connect_and_stream(&tx, &cancel).await {
                Ok(()) => {
                    // 정상 종료 (cancel됨)
                    return;
                }
                Err(e) => {
                    attempt += 1;
                    // 지수 백오프: 2, 4, 8, 16, 32, 60, 60, 60...
                    let delay = (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS);
                    warn!("LS API disconnected: {e} — reconnecting in {delay}s (attempt {attempt})");

                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                        _ = cancel.cancelled() => { return; }
                    }
                }
            }

            // 재연결 성공하면 attempt 리셋은 connect_and_stream 안에서 데이터가 오면
            // → 간단하게: 연결 성공 시 리셋
            // 여기서는 매번 시도이므로, 성공 후 다시 끊기면 attempt=1부터 다시 시작하도록
            // connect_and_stream이 한 번이라도 데이터를 받았으면 attempt을 리셋하는 게 좋지만
            // 단순하게 유지: 연결 실패 시 attempt 증가, 다음 루프에서 다시 시도
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
                    volume,
                    timestamp: now,
                });
                let _ = tx.send(msg).await;
            }
            "JC0" => {
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);

                let msg = WsMessage::FuturesTick(FuturesTick {
                    code: tr_key.to_string(),
                    name: name.to_string(),
                    price,
                    underlying_price: 0.0,
                    basis_bp: 0.0,
                    volume,
                    timestamp: now,
                });
                let _ = tx.send(msg).await;
            }
            "FC0" => {
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);
                let underlying = parse_f64(&body["k200jisu"]);
                let basis_bp = if underlying > 0.0 {
                    (price - underlying) / underlying * 10000.0
                } else {
                    0.0
                };

                let msg = WsMessage::FuturesTick(FuturesTick {
                    code: tr_key.to_string(),
                    name: name.to_string(),
                    price,
                    underlying_price: round2(underlying),
                    basis_bp: round2(basis_bp),
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
