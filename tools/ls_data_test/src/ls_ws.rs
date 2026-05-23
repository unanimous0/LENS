/// LS증권 OpenAPI WebSocket 연결 + 재연결 루프.
///
/// 구독 목록(subscriptions)을 받아 단일 WS 연결로 모두 구독.
/// 수신된 메시지는 WsEvent::Tick으로 event_tx에 전송.
/// 연결 끊김 시 지수 백오프(최대 60s) 후 재연결.
///
/// Phase 1: 단일 연결. 190개 초과 테스트는 Phase 9에서 확장.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};

use crate::auth;
use crate::config::Config;
use crate::state::{now_us, WsEvent};

/// rustls ClientConfig: TLS 1.2만 허용.
/// LS API WS 서버(9443)가 TLS 1.3 ClientHello를 거부함.
/// native-tls의 max_protocol_version 설정이 이 Linux/OpenSSL 환경에서 무효 → rustls로 교체.
///
/// rustls 0.23: builder() → WantsVerifier (프로토콜 선택 불가)
///              builder_with_provider() → WantsProtocol → with_protocol_versions() 가능
fn make_tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    // 시스템 CA 인증서 로드 (rustls-native-certs 0.8: Result가 아닌 CertificateResult 반환)
    let mut root_store = rustls::RootCertStore::empty();
    let result = rustls_native_certs::load_native_certs();
    for err in &result.errors {
        tracing::warn!("native cert warning: {err}");
    }
    for cert in result.certs {
        root_store.add(cert).ok();
    }

    // ring crypto provider로 TLS 1.2 전용 config 구성
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS12])
        .map_err(|e| format!("TLS 1.2 config error: {e}"))?
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(Arc::new(config))
}

const WS_URL: &str = "wss://openapi.ls-sec.co.kr:9443/websocket";
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);

/// 외부에서 호출하는 진입점. 영구 재연결 루프.
pub async fn run(
    config: Arc<Config>,
    subscriptions: Vec<(String, String)>,
    event_tx: mpsc::Sender<WsEvent>,
) {
    let mut attempt = 0u32;
    loop {
        match connect_once(&config, &subscriptions, &event_tx).await {
            Ok(()) => {
                tracing::info!("ls_ws: normal exit");
                return;
            }
            Err(e) => {
                let _ = event_tx.send(WsEvent::Disconnected(e.clone())).await;
                attempt += 1;
                let delay = Duration::from_secs(
                    2u64.pow(attempt.min(6)).min(MAX_RECONNECT_DELAY.as_secs()),
                );
                tracing::warn!("ls_ws: error — {e}. reconnecting in {delay:?}");
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// 단일 연결 + 수신 루프. 오류 시 Err 반환 → 상위에서 재연결.
async fn connect_once(
    config: &Config,
    subscriptions: &[(String, String)],
    event_tx: &mpsc::Sender<WsEvent>,
) -> Result<(), String> {
    // 1. 토큰 취득
    let token = auth::get_token(&config.app_key, &config.app_secret).await?;
    tracing::debug!("token ok ({}…)", &token[..token.len().min(16)]);

    // 2. WS 연결
    let mut request = WS_URL.into_client_request().map_err(|e| format!("bad URL: {e}"))?;
    request.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static("ls-data-test/0.1"),
    );
    request.headers_mut().insert(
        "Accept-Language",
        HeaderValue::from_static("ko-KR,ko;q=0.9"),
    );

    let tls_config = make_tls_config()?;
    let connector = tokio_tungstenite::Connector::Rustls(tls_config);
    let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(
        request, None, false, Some(connector),
    )
    .await
    .map_err(|e| format!("ws connect: {e}"))?;

    let (mut write, mut read) = ws.split();
    tracing::info!("ls_ws: connected. subscribing {} pairs", subscriptions.len());

    // 3. 구독 메시지 전송
    //    형식: {"header": {"token": "<raw JWT>", "tr_type": "3"}, "body": {"tr_cd": "...", "tr_key": "..."}}
    for (tr_cd, tr_key) in subscriptions {
        let msg = serde_json::json!({
            "header": { "token": &token, "tr_type": "3" },
            "body":   { "tr_cd": tr_cd, "tr_key": tr_key }
        });
        write
            .send(tungstenite::Message::Text(msg.to_string().into()))
            .await
            .map_err(|e| format!("subscribe send: {e}"))?;
        tracing::debug!("subscribed: {tr_cd} {tr_key}");
    }

    // 연결 성공 이벤트
    let _ = event_tx.send(WsEvent::Connected).await;

    // 4. 수신 루프
    while let Some(msg) = read.next().await {
        match msg {
            Ok(tungstenite::Message::Text(text)) => {
                handle_message(&text, event_tx).await;
            }
            Ok(tungstenite::Message::Binary(data)) => {
                if let Ok(text) = String::from_utf8(data.to_vec()) {
                    handle_message(&text, event_tx).await;
                }
            }
            Ok(tungstenite::Message::Ping(data)) => {
                // Pong 응답 (keep-alive)
                write
                    .send(tungstenite::Message::Pong(data))
                    .await
                    .map_err(|e| format!("pong: {e}"))?;
            }
            Ok(tungstenite::Message::Close(frame)) => {
                let reason = frame
                    .map(|f| f.reason.to_string())
                    .unwrap_or_else(|| "no reason".into());
                return Err(format!("server closed: {reason}"));
            }
            Ok(_) => {} // Pong, Frame 등 무시
            Err(e) => return Err(format!("ws error: {e}")),
        }
    }

    Err("stream ended".into())
}

/// 수신된 Text 메시지를 파싱하여 WsEvent::Tick으로 변환.
///
/// LS API WS 메시지 형식:
///   {"header": {"tr_cd": "S3_", "tr_key": "005930"}, "body": {...}}
///
/// body가 없거나 null이면 (구독 확인 응답 등) 무시.
async fn handle_message(text: &str, event_tx: &mpsc::Sender<WsEvent>) {
    let recv_us = now_us();

    // raw 메시지 전체 로그 (debug 레벨)
    tracing::debug!("raw: {text}");

    let data: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("json parse error: {e} | raw: {text}");
            return;
        }
    };

    let header = &data["header"];
    let body   = &data["body"];

    // body가 null/없는 메시지 = 구독 확인 응답 (info 로그만)
    if body.is_null() || !body.is_object() {
        tracing::info!("non-data msg: {}", header);
        return;
    }

    let tr_cd  = header["tr_cd"].as_str().unwrap_or("").to_string();
    let tr_key = header["tr_key"].as_str().unwrap_or("").to_string();

    if tr_cd.is_empty() || tr_key.is_empty() {
        tracing::warn!("missing tr_cd/tr_key: {text}");
        return;
    }

    let _ = event_tx
        .send(WsEvent::Tick {
            tr_cd,
            tr_key,
            recv_us,
            body: body.clone(),
        })
        .await;
}
