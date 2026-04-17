use std::collections::HashMap;

use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick};

use super::MarketFeed;

const WS_URL: &str = "wss://openapi.ls-sec.co.kr:9443/websocket";
const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";

/// LS증권 OpenAPI WebSocket 피드
pub struct LsApiFeed {
    app_key: String,
    app_secret: String,
    /// 구독할 종목: (TR코드, 종목코드) 목록
    /// 예: ("S3_", "005930"), ("JC0", "A1165000")
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

    /// OAuth2 토큰 발급
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
}

impl MarketFeed for LsApiFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, cancel: CancellationToken) {
        // 토큰 발급
        let token = match self.get_token().await {
            Ok(t) => {
                info!("LS API token acquired: {}...", &t[..20]);
                t
            }
            Err(e) => {
                error!("Failed to get LS API token: {e}");
                return;
            }
        };

        // WebSocket 연결 (필수 헤더 포함)
        let mut request = WS_URL
            .into_client_request()
            .expect("invalid WS URL");
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
        let (ws_stream, _resp) = match tokio_tungstenite::connect_async_tls_with_config(
            request, None, false, Some(connector),
        )
        .await
        {
            Ok((stream, resp)) => {
                info!("LS API WebSocket connected (status: {})", resp.status());
                (stream, resp)
            }
            Err(e) => {
                error!("LS API WebSocket connection failed: {e}");
                return;
            }
        };

        let (mut write, mut read) = ws_stream.split();

        // 종목 구독
        for (tr_cd, tr_key) in &self.subscriptions {
            let sub = serde_json::json!({
                "header": {"token": token, "tr_type": "3"},
                "body": {"tr_cd": tr_cd, "tr_key": tr_key}
            });
            if let Err(e) = write
                .send(tungstenite::Message::Text(sub.to_string().into()))
                .await
            {
                error!("Subscribe failed for {tr_cd} {tr_key}: {e}");
                return;
            }
            info!("Subscribed: {tr_cd} {tr_key}");
        }

        // 메시지 수신 루프
        loop {
            tokio::select! {
                msg = read.next() => {
                    match msg {
                        Some(Ok(tungstenite::Message::Text(text))) => {
                            self.handle_message(&text, &tx).await;
                        }
                        Some(Ok(tungstenite::Message::Binary(data))) => {
                            // LS API는 가끔 binary로 보내기도 함
                            if let Ok(text) = String::from_utf8(data.to_vec()) {
                                self.handle_message(&text, &tx).await;
                            }
                        }
                        Some(Ok(tungstenite::Message::Close(_))) => {
                            info!("LS API WebSocket closed by server");
                            break;
                        }
                        Some(Err(e)) => {
                            error!("LS API WebSocket error: {e}");
                            break;
                        }
                        None => {
                            info!("LS API WebSocket stream ended");
                            break;
                        }
                        _ => {} // Ping/Pong handled automatically
                    }
                }
                _ = cancel.cancelled() => {
                    info!("LsApiFeed cancelled");
                    let _ = write.send(tungstenite::Message::Close(None)).await;
                    break;
                }
            }
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

        // 구독 응답 (body가 null)
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
                // 주식/ETF 체결
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);
                let offerho = parse_f64(&body["offerho"]);
                let bidho = parse_f64(&body["bidho"]);
                // 간이 NAV: ETF인 경우 중간가를 NAV 근사치로 사용
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
                // 주식선물 체결
                let price = parse_f64(&body["price"]);
                let volume = parse_u64(&body["volume"]);
                // 주식선물은 underlying_price가 별도 필드로 안 옴
                // 기초자산 현재가는 별도 S3_ 구독에서 가져와야 함
                // 일단 0으로 두고 state에서 채움
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
                // KOSPI200 선물 체결 (베이시스 포함)
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
            _ => {
                // 기타 TR은 무시
            }
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
