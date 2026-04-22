use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::WebSocketUpgrade;
use axum::response::IntoResponse;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::ws::broadcast::Broadcaster;
use crate::AppState;

/// WebSocket 업그레이드 핸들러. /ws/market 엔드포인트.
pub async fn ws_market(
    ws: WebSocketUpgrade,
    state: axum::extract::State<AppState>,
) -> impl IntoResponse {
    let bc = state.broadcaster.clone();
    ws.on_upgrade(move |socket| handle_client(socket, bc))
}

async fn handle_client(mut socket: WebSocket, broadcaster: Arc<Broadcaster>) {
    info!("WebSocket client connected");

    // 프론트엔드가 보내는 "subscribe" 메시지 대기 (기존 Python 호환)
    if let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(text) = msg {
            info!("Client sent: {}", text);
        }
    }

    // 순서 중요: subscribe를 먼저 걸고 snapshot을 보내야 중간에 들어오는 새 틱을 놓치지 않음.
    let mut rx = broadcaster.subscribe();

    // 현재 캐시 스냅샷 전체 전송 — 재접속한 클라이언트가 기존 상태 복원.
    let snapshot = broadcaster.snapshot();
    info!("Flushing snapshot to new client: {} messages", snapshot.len());
    for json in snapshot {
        if socket
            .send(Message::Text(String::from(&*json).into()))
            .await
            .is_err()
        {
            info!("WebSocket client disconnected during snapshot flush");
            return;
        }
    }

    // 이후 실시간 틱 전달
    loop {
        match rx.recv().await {
            Ok(json) => {
                if socket
                    .send(Message::Text(String::from(&*json).into()))
                    .await
                    .is_err()
                {
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
