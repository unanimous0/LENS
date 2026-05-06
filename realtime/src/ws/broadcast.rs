use std::sync::Arc;

use dashmap::DashMap;
use tokio::sync::broadcast;

/// 브로드캐스트 허브 + 최신 틱 스냅샷 캐시.
///
/// 클라이언트가 새로고침/재접속하면 과거 메시지는 받을 수 없다. 그래서 종목별
/// "최신 상태"를 cache에 항상 최신 JSON으로 저장해두고, 접속 시 전체를 한 번에
/// 쏴준 뒤 실시간 broadcast를 이어준다.
///
/// Orderbook처럼 빠르게 갱신되는 스트림은 캐시 안 함 (다음 호가가 곧 옴).
#[derive(Clone)]
pub struct Broadcaster {
    tx: broadcast::Sender<Arc<str>>,
    /// key = "{type}:{code}" (예: "stock_tick:005930"). 최신 JSON 1개만 유지.
    cache: Arc<DashMap<String, Arc<str>>>,
}

impl Broadcaster {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            cache: Arc::new(DashMap::new()),
        }
    }

    /// 캐시 저장 + 브로드캐스트. 재접속 스냅샷에 포함됨.
    pub fn send_cached(&self, key: String, json: Arc<str>) {
        self.cache.insert(key, json.clone());
        let _ = self.tx.send(json);
    }

    /// 캐시만 저장 (브로드캐스트 안 함). batch envelope로 묶어 보낼 때 스냅샷용으로
    /// 개별 JSON은 캐시에 보존하고, 실제 송출은 envelope 한 번만 하기 위함.
    pub fn cache_only(&self, key: String, json: Arc<str>) {
        self.cache.insert(key, json);
    }

    /// 캐시 없이 브로드캐스트만. Orderbook 등 재현 의미 적은 스트림용.
    pub fn send(&self, json: Arc<str>) {
        let _ = self.tx.send(json);
    }

    /// 현재 캐시의 모든 메시지 복제. 재접속 시 flush용.
    pub fn snapshot(&self) -> Vec<Arc<str>> {
        self.cache.iter().map(|e| e.value().clone()).collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<str>> {
        self.tx.subscribe()
    }

    /// 현재 연결된 WS 클라이언트 수. 구독자 0명이면 OrderbookTick 같은 캐시 안 하는
    /// 스트림은 직렬화부터 스킵 가능.
    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// 캐시 전부 비움. 모드 전환 시 이전 모드의 stale 데이터를 날려야 함.
    pub fn clear_cache(&self) {
        self.cache.clear();
    }
}
