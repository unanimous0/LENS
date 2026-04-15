use std::sync::Arc;

use tokio::sync::broadcast;

/// 브로드캐스트 허브.
/// 피드에서 받은 메시지를 JSON 직렬화 후 모든 WebSocket 클라이언트에 전달.
#[derive(Clone)]
pub struct Broadcaster {
    tx: broadcast::Sender<Arc<str>>,
}

impl Broadcaster {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// JSON 문자열을 모든 구독자에게 전송. 구독자가 없으면 무시.
    pub fn send(&self, json: Arc<str>) {
        let _ = self.tx.send(json);
    }

    /// 새 수신자 생성 (WebSocket 클라이언트용).
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.tx.subscribe()
    }
}
