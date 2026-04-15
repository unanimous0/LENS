use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::WebSocketUpgrade;
use axum::response::IntoResponse;
use tokio::sync::broadcast;
use tracing::{info, warn};

use super::broadcast::Broadcaster;

/// WebSocket 업그레이드 핸들러. /ws/market 엔드포인트.
pub async fn ws_market(
    ws: WebSocketUpgrade,
    broadcaster: axum::extract::State<Arc<Broadcaster>>,
) -> impl IntoResponse {
    let rx = broadcaster.subscribe();
    ws.on_upgrade(move |socket| handle_client(socket, rx))
}

async fn handle_client(mut socket: WebSocket, mut rx: broadcast::Receiver<Arc<str>>) {
    info!("WebSocket client connected");

    // 프론트엔드가 보내는 "subscribe" 메시지 대기 (기존 Python 호환)
    if let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(text) => {
                info!("Client sent: {}", text);
            }
            _ => {}
        }
    }

    // 브로드캐스트 수신 → 클라이언트로 전달
    loop {
        match rx.recv().await {
            Ok(json) => {
                if socket.send(Message::Text(json.to_string().into())).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                warn!("Client lagged, skipped {} messages", n);
            }
            Err(broadcast::error::RecvError::Closed) => {
                break;
            }
        }
    }

    info!("WebSocket client disconnected");
}
