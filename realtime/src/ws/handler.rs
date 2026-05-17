use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::WebSocketUpgrade;
use axum::response::IntoResponse;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use crate::feed::SubCommand;
use crate::ws::broadcast::Broadcaster;
use crate::{AppState, Stats};

/// WebSocket 업그레이드 핸들러. /ws/market 엔드포인트.
pub async fn ws_market(
    ws: WebSocketUpgrade,
    state: axum::extract::State<AppState>,
) -> impl IntoResponse {
    let state_clone = state.0.clone();
    let bc = state.broadcaster.clone();
    let stats = state.stats.clone();
    ws.on_upgrade(move |socket| handle_client(socket, bc, stats, state_clone))
}

async fn handle_client(
    mut socket: WebSocket,
    broadcaster: Arc<Broadcaster>,
    stats: Arc<Stats>,
    state: AppState,
) {
    // 새 client에 unique id 발급. frontend가 hello 메시지로 받아서 subscribe-stocks
    // 호출 시 X-LENS-Client-Id 헤더에 첨부 → disconnect 시 자동 cleanup.
    let client_id = state.next_client_id.fetch_add(1, Ordering::Relaxed);
    info!("WebSocket client connected (id={})", client_id);

    // hello 메시지 전송 (snapshot 전에 보내야 frontend가 client_id를 먼저 확보).
    let hello = format!("{{\"type\":\"hello\",\"client_id\":{client_id}}}");
    if socket.send(Message::Text(hello.into())).await.is_err() {
        info!("WS client {} disconnected before hello flush", client_id);
        return;
    }

    // 프론트엔드가 보내는 "subscribe" 메시지 대기 (기존 Python 호환). 옵셔널.
    if let Some(Ok(msg)) = socket.recv().await {
        if let Message::Text(text) = msg {
            debug!("Client {} sent: {}", client_id, text);
        }
    }

    // Trade-off: "메시지 유실 없음, 중복 가능" 택함.
    //  subscribe() 먼저 → snapshot() → rx 수신 루프.
    //  cache snapshot과 rx 사이 도착 tick은 두 번 전달될 수 있으나, 프론트 store가 멱등이라 무해.
    let mut rx = broadcaster.subscribe();
    let snapshot = broadcaster.snapshot();
    info!("Flushing snapshot to client {}: {} messages", client_id, snapshot.len());
    for json in snapshot {
        if socket.send(Message::Text(json)).await.is_err() {
            info!("WS client {} disconnected during snapshot flush", client_id);
            cleanup_client_subs(&state, client_id).await;
            return;
        }
    }

    // 이후 실시간 틱 전달
    loop {
        match rx.recv().await {
            Ok(json) => {
                if socket.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => {
                stats.ws_lag_total.fetch_add(n, Ordering::Relaxed);
                warn!("Client {} lagged, skipped {} messages", client_id, n);
            }
            Err(broadcast::error::RecvError::Closed) => {
                break;
            }
        }
    }

    info!("WebSocket client {} disconnected", client_id);
    cleanup_client_subs(&state, client_id).await;
}

/// disconnect 시 client가 잡고 있던 stocks/inav 코드들을 자동 unsubscribe.
/// frontend 정상 unmount면 이미 명시 unsubscribe로 비어있음. 강제 종료(F5/X) 케이스 안전망.
async fn cleanup_client_subs(state: &AppState, client_id: u64) {
    // stocks
    if let Some((_, subs)) = state.client_subs.remove(&client_id) {
        let codes: Vec<String> = subs.iter().map(|s| s.key().clone()).collect();
        if !codes.is_empty() {
            info!("WS client {} disconnect cleanup stocks: -{} codes", client_id, codes.len());
            let _ = state
                .sub_tx
                .read()
                .unwrap()
                .send(SubCommand::UnsubscribeStocks(codes));
        }
    }
    // inav
    if let Some((_, subs)) = state.client_subs_inav.remove(&client_id) {
        let codes: Vec<String> = subs.iter().map(|s| s.key().clone()).collect();
        if !codes.is_empty() {
            info!("WS client {} disconnect cleanup inav: -{} codes", client_id, codes.len());
            let _ = state
                .sub_tx
                .read()
                .unwrap()
                .send(SubCommand::UnsubscribeInav(codes));
        }
    }
}
