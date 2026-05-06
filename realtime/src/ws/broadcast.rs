use std::sync::Arc;

use axum::extract::ws::Utf8Bytes;
use dashmap::DashMap;
use tokio::sync::broadcast;

/// 브로드캐스트 허브 + 최신 틱 스냅샷 캐시.
///
/// 클라이언트가 새로고침/재접속하면 과거 메시지는 받을 수 없다. 그래서 종목별
/// "최신 상태"를 cache에 항상 최신 JSON으로 저장해두고, 접속 시 전체를 한 번에
/// 쏴준 뒤 실시간 broadcast를 이어준다.
///
/// Orderbook처럼 빠르게 갱신되는 스트림은 캐시 안 함 (다음 호가가 곧 옴).
///
/// 메시지 타입은 `Utf8Bytes` (= `bytes::Bytes` + UTF-8 검증 마커). 내부적으로
/// 참조카운트 기반이라 N 클라이언트로 fan-out 시 `clone()`은 refcount inc만.
/// 이전엔 `Arc<str>` → `String::from(&*arc)`로 매번 envelope 통째 복제 → 7000 코드
/// envelope 1.7MB × 5 클라이언트 × 6.7Hz = ~57MB/s alloc. 지금은 0.
#[derive(Clone)]
pub struct Broadcaster {
    tx: broadcast::Sender<Utf8Bytes>,
    cache: Arc<DashMap<String, Utf8Bytes>>,
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
    pub fn send_cached(&self, key: String, json: Utf8Bytes) {
        self.cache.insert(key, json.clone());
        let _ = self.tx.send(json);
    }

    /// 캐시만 저장 (브로드캐스트 안 함). batch envelope 송출 시 스냅샷용 보존.
    pub fn cache_only(&self, key: String, json: Utf8Bytes) {
        self.cache.insert(key, json);
    }

    /// 캐시 저장 — 동일 내용이면 skip. 7000 코드 부하 시 DashMap 쓰기율 감소
    /// (LS에서 같은 호가가 반복 송출되거나 가격 변동 없는 종목이 많을 때 큼).
    pub fn cache_if_changed(&self, key: String, json: Utf8Bytes) {
        if let Some(prev) = self.cache.get(&key) {
            if prev.value().as_str() == json.as_str() { return; }
        }
        self.cache.insert(key, json);
    }

    /// 캐시 없이 브로드캐스트만. Orderbook 등 재현 의미 적은 스트림용.
    pub fn send(&self, json: Utf8Bytes) {
        let _ = self.tx.send(json);
    }

    /// 현재 캐시의 모든 메시지 복제 (refcount inc). 재접속 시 flush용.
    pub fn snapshot(&self) -> Vec<Utf8Bytes> {
        self.cache.iter().map(|e| e.value().clone()).collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Utf8Bytes> {
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
