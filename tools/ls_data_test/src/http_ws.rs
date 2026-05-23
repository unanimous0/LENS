/// axum WebSocket 핸들러: 브라우저에 snapshot JSON push.
///
/// 연결 즉시 현재 상태를 1회 전송 (초기 렌더링).
/// 이후 state_updater broadcast를 구독해 실시간 갱신.

use axum::{
    extract::{State, WebSocketUpgrade},
    response::Response,
};
use axum::extract::ws::{Message, WebSocket};
use tokio::sync::broadcast;
use futures_util::{SinkExt, StreamExt};

use crate::state::{self, SharedState};

pub type BroadcastTx = broadcast::Sender<String>;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(tx): State<BroadcastTx>,
    axum::Extension(shared): axum::Extension<SharedState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, tx.subscribe(), shared))
}

async fn handle_socket(
    socket: WebSocket,
    mut rx: broadcast::Receiver<String>,
    shared: SharedState,
) {
    let (mut sender, mut receiver) = socket.split();

    // 연결 직후 현재 상태 즉시 전송 — 브라우저가 이전 broadcast를 놓쳤어도 바로 렌더링 가능
    {
        let g = shared.read().await;
        let snap = state::Snapshot {
            ts:      state::now_us(),
            conn:    g.conn.clone(),
            entries: g.entries.clone(),
        };
        if let Ok(json) = serde_json::to_string(&snap) {
            let _ = sender.send(Message::Text(json.into())).await;
        }
    }

    // push 태스크: broadcast 수신 → 브라우저 전송
    let push = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(json) => {
                    if sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("browser ws lagged {n} messages — skipping");
                }
            }
        }
    });

    // 브라우저 → 서버 방향 (ping/close)
    while let Some(Ok(msg)) = receiver.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }

    push.abort();
}
