use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::WebSocketUpgrade;
use axum::response::IntoResponse;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use crate::ws::broadcast::Broadcaster;
use crate::{AppState, Stats};

/// WebSocket 업그레이드 핸들러. /ws/market 엔드포인트.
pub async fn ws_market(
    ws: WebSocketUpgrade,
    state: axum::extract::State<AppState>,
) -> impl IntoResponse {
    let bc = state.broadcaster.clone();
    let stats = state.stats.clone();
    ws.on_upgrade(move |socket| handle_client(socket, bc, stats))
}

async fn handle_client(mut socket: WebSocket, broadcaster: Arc<Broadcaster>, stats: Arc<Stats>) {
    info!("WebSocket client connected");

    // 프론트엔드가 보내는 "subscribe" 메시지 대기 (기존 Python 호환)
    if let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(text) = msg {
            debug!("Client sent: {}", text);
        }
    }

    // Trade-off 결정: 이 순서는 "메시지 유실 없음, 중복 가능"을 택한 것.
    //  - subscribe() 먼저 → snapshot() → rx 수신 루프.
    //  - subscribe ~ snapshot 사이에 도착한 tick은 cache에도 반영되고 rx에도 쌓임 → 같은 종목이
    //    snapshot과 rx로 두 번 전달될 수 있음.
    //  - 프론트 store는 멱등(같은 값 덮어씀)이라 무해. 대안인 "snapshot → subscribe" 순서는
    //    사이 tick이 유실되는데, 트레이딩 화면에선 유실이 중복보다 위험하므로 거부.
    let mut rx = broadcaster.subscribe();
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
                stats.ws_lag_total.fetch_add(n, Ordering::Relaxed);
                warn!("Client lagged, skipped {} messages", n);
            }
            Err(broadcast::error::RecvError::Closed) => {
                break;
            }
        }
    }

    info!("WebSocket client disconnected");
}
