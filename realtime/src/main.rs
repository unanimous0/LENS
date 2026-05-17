mod calc;
mod feed;
mod holidays;
mod model;
mod phase;
mod volume_cache;
mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use dashmap::DashMap;
use serde::Deserialize;
use tokio::sync::{mpsc, Mutex as TokioMutex};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

use feed::internal::InternalFeed;
use feed::ls_api::LsApiFeed;
use feed::mock::MockFeed;
use feed::{MarketFeed, SubCommand};
use model::message::WsMessage;
use ws::broadcast::Broadcaster;
use ws::handler::ws_market;
use calc::scheduler::{spawn_workers, MatrixState};

const PORT: u16 = 8200;
/// 브로드캐스트 링버퍼 크기. batch envelope 도입 후 송출 빈도 ~5/sec로 평탄화 →
/// 8192면 슬로우 클라이언트에 27분 여유 (batch 단위라 단위 시간당 송출 수가 작음).
/// 내부망 7000 코드·5+ 클라이언트 환경에서 한 클라이언트가 잠시 늦어져도 여유.
const BROADCAST_CAPACITY: usize = 8192;

/// 틱 처리 파이프라인 성능 카운터. `/debug/stats`로 노출.
/// hotspot이 JSON 직렬화인지 / send_cached(cache+broadcast) 쪽인지 구분 목적.
#[derive(Default)]
pub struct Stats {
    /// mpsc→broadcast 브리지에서 처리한 총 틱 수.
    tick_count: AtomicU64,
    /// serde_json::to_string 누적 소요 시간 (ns).
    serialize_ns: AtomicU64,
    serialize_calls: AtomicU64,
    /// Broadcaster::send_cached / send 누적 (cache insert + broadcast).
    send_ns: AtomicU64,
    send_calls: AtomicU64,
    /// 구독자 0명이라 OrderbookTick 직렬화 스킵한 횟수.
    tick_skipped_no_subscribers: AtomicU64,
    /// broadcast Lagged로 슬로우 클라이언트가 놓친 메시지 수 누적.
    pub ws_lag_total: AtomicU64,
    /// LS WS 연결 재시도 횟수 (전 conn 합계).
    pub reconnect_count: AtomicU64,
    /// 초기 가격 fetch 실패 분류 카운터 (ls_rest).
    pub fetch_no_data: AtomicU64,
    pub fetch_http_5xx: AtomicU64,
    pub fetch_tps: AtomicU64,
    pub fetch_other: AtomicU64,
    /// t1102 응답 분류별 emit 카운터 — sweep/retry/prioritize 합산.
    /// value>0: 거래대금 있음 = 정상 (현재가 + cum_volume).
    /// pc_only: 거래대금 0이지만 전일종가 있음 = 미거래 종목 (price=0 emit).
    /// 둘 다 0인 케이스는 fetch_no_data에 잡힘.
    pub emit_value_pos: AtomicU64,
    pub emit_pc_only: AtomicU64,
    /// t1102 시도 총 횟수 (성공+실패+pc-only). REQ_INTERVAL 사용량 직관적 추정용.
    pub fetch_attempts: AtomicU64,
    /// LS feed → mpsc channel try_send 실패 (채널 full). 핫 path drop 카운터.
    /// 정상 운영 시 0. 누적되면 bridge가 못 따라잡는 상황 — 토론/튜닝 신호.
    pub tx_dropped: AtomicU64,
    /// 프로세스 시작 시각.
    started: std::sync::OnceLock<Instant>,
}

/// 런타임 피드 핸들: cancel token + JoinHandle
struct FeedHandle {
    cancel: CancellationToken,
    join: tokio::task::JoinHandle<()>,
}

/// 모든 모드가 공유하는 정적 리소스 (마스터 데이터)
struct MasterShared {
    master_names: HashMap<String, String>,
    master_stock_codes: HashSet<String>,
    futures_to_spot: HashMap<String, String>,
    kosdaq_codes: HashSet<String>,
    /// 만기 임박(SPREAD_AUTO_DAYS 이하) 종목의 스프레드 코드 — 자동 구독 대상.
    /// 그 외 스프레드는 호가창에서 모달 열 때 동적 구독됨.
    auto_spread_codes: Vec<String>,
    /// 마스터 원본 순서대로의 현물 코드 — 구독 순서를 결정적으로 만들기 위해.
    /// HashSet 순회는 매 실행마다 순서가 달라져서 재현 디버깅이 어려움.
    ordered_stock_codes: Vec<String>,
    /// 원본 순서의 근월 선물 코드.
    ordered_front_futures: Vec<String>,
    /// ETF PDF에 등장하는 추가 현물 종목 (주식선물 없는 잡주 포함).
    /// 시작 시 backend `/api/etfs/pdf-all`로 받아옴. WS subscribe는 안 하고
    /// (KOSDAQ 분류 정보가 없어 S3_/K3_ 잘못 보낼 위험), t1102 백그라운드 sweep만 실행 →
    /// 사용자가 ETF 페이지 진입 시 가격이 이미 fetched에 채워져 있어 즉시 표시.
    /// (ordered_stock_codes와 중복 코드는 자동 제외)
    etf_pdf_extra_codes: Vec<String>,
    /// ETF 코드 set — `/api/etfs/pdf-all` 응답의 items key. t1102 emit 시
    /// 분기 판단용 (ETF면 EtfTick, 아니면 StockTick). 평일 LS WS attach되면 S3_/I5_
    /// 스트림이 자동 분기하지만, t1102 fetch 단독 시점(휴장/시작 직후)에도 정확히
    /// etfTicks store에 들어가도록.
    etf_codes: HashSet<String>,
}

/// 앱 공유 상태. 내부 변이 필드는 전부 Arc로 감싸 Clone 비용 최소화.
#[derive(Clone)]
pub struct AppState {
    broadcaster: Arc<Broadcaster>,
    /// 현재 활성 feed의 sub_tx. 모드 전환 시 통째로 교체됨.
    sub_tx: Arc<StdRwLock<mpsc::UnboundedSender<SubCommand>>>,
    /// 현재 feed 모드 ("mock" / "ls_api" / "internal").
    feed_mode: Arc<StdRwLock<String>>,
    /// 현재 feed의 cancel + join handle. 모드 전환 시 cancel → await join → 교체.
    feed_handle: Arc<TokioMutex<Option<FeedHandle>>>,
    /// broadcaster로 가는 tx. 모드 전환해도 고정 (WebSocket 연결 유지).
    tx: mpsc::Sender<WsMessage>,
    shared: Arc<MasterShared>,
    /// 성능 카운터. `/debug/stats`로 확인.
    stats: Arc<Stats>,
    /// LS API 피드 마지막 데이터 수신 시각 (UNIX micros). 모드 무관하게 보관 —
    /// `/debug/stats::feed_age_sec`로 노출하고 LsApiFeed에 같은 Arc 주입.
    feed_last_data_us: Arc<AtomicU64>,
    /// 마지막 모드 전환 시각. 빠른 토글(mock↔ls_api) 시 매번 fresh 토큰 + 5 WS +
    /// 750 REST 돌아서 LS abuse 위험 → 쿨다운으로 차단.
    last_mode_change: Arc<StdRwLock<Instant>>,
    /// Bridge backfill 상태. 모드 전환 시 stale 데이터 leak 방지를 위해 set_mode에서 비워야 함.
    /// (LS API와 internal이 같은 code 키를 쓰지만 의미·범위가 달라 prev_close/etf_state가 섞이면
    /// 변화율·NAV가 잘못 계산됨)
    stock_prev_close: Arc<DashMap<String, f64>>,
    etf_state: Arc<DashMap<String, EtfStateBridge>>,
    /// t1102 fetch 진행 상태 — LsApiFeed가 같은 Arc를 공유. /debug/stats에서 사이즈 노출.
    /// 모드 전환 시 lifecycle: ls_api 진입 시 그대로 사용, mock/internal에선 비어있음.
    pub fetched_stocks: Arc<DashMap<String, ()>>,
    pub failed_stocks: Arc<DashMap<String, feed::ls_rest::FailedT1102>>,
    /// 다음 WebSocket client에 발급할 ID. WS 연결 시 1씩 증가.
    pub next_client_id: Arc<AtomicU64>,
    /// client_id → 그 client가 잡고 있는 종목 코드 집합 (subscribe-stocks).
    /// WS disconnect 시 자동 cleanup으로 ref-count leak 방지. 헤더(X-LENS-Client-Id) 없으면 추적 안 함.
    pub client_subs: Arc<DashMap<u64, dashmap::DashSet<String>>>,
    /// Backend가 영구 sub 의도를 표명한 코드 (active 포지션의 leg 등).
    /// POST /permanent-stocks가 set 전체를 replace. diff로 SubscribeStocks/UnsubscribeStocks 발사.
    /// 페이지 mount/unmount와 무관하게 ref-count 영구 +1 효과.
    pub permanent_codes: Arc<StdRwLock<std::collections::HashSet<String>>>,
}

/// Bridge에서 EtfTick의 0인 필드를 이전 캐시값으로 메우기 위한 stash.
/// 모듈 레벨로 노출 — AppState에서 공유.
#[derive(Default, Clone, Copy)]
pub struct EtfStateBridge { pub price: f64, pub nav: f64, pub volume: u64 }

fn now_us() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// pending 버퍼용 key — 모든 타입에 대해 dedup 가능하도록 unique key 생성.
/// OrderbookTick도 batch에 포함되므로 cache 안 하더라도 buffer key는 필요.
fn msg_pending_key(msg: &WsMessage) -> String {
    match msg {
        WsMessage::StockTick(t) => format!("stock_tick:{}", t.code),
        WsMessage::FuturesTick(t) => format!("futures_tick:{}", t.code),
        WsMessage::EtfTick(t) => format!("etf_tick:{}", t.code),
        WsMessage::OrderbookTick(t) => format!("orderbook_tick:{}", t.code),
        // LP 매트릭스·북 리스크는 각각 단일 인스턴스 — 고정 key로 dedup.
        WsMessage::FairValueMatrix(_) => "fair_value_matrix".to_string(),
        WsMessage::BookRisk(_) => "book_risk".to_string(),
    }
}

/// 캐시(snapshot 복원용) key. OrderbookTick은 캐시 안 함 (재현 의미 적음).
fn msg_cache_key(msg: &WsMessage) -> Option<String> {
    match msg {
        WsMessage::StockTick(t) => Some(format!("stock_tick:{}", t.code)),
        WsMessage::FuturesTick(t) => Some(format!("futures_tick:{}", t.code)),
        WsMessage::EtfTick(t) => Some(format!("etf_tick:{}", t.code)),
        WsMessage::OrderbookTick(_) => None,
        // 매트릭스·북 리스크는 캐시 — 신규 클라이언트 연결 시 즉시 보여주기 위해.
        WsMessage::FairValueMatrix(_) => Some("fair_value_matrix".to_string()),
        WsMessage::BookRisk(_) => Some("book_risk".to_string()),
    }
}

/// KRX 세션 상태 (KST 기준).
///   "closed"     — 주말 / KRX 공휴일
///   "pre_open"   — 영업일 09:00 이전
///   "open"       — 영업일 09:00 ~ 15:45
///   "post_close" — 영업일 15:45 이후
fn session_state_kst() -> &'static str {
    use chrono::{Datelike, Local, Timelike, Weekday};
    let now = Local::now();
    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) { return "closed"; }
    if holidays::is_krx_holiday(now.date_naive()) { return "closed"; }
    let mins = now.hour() * 60 + now.minute();
    if mins < 9 * 60 { "pre_open" }
    else if mins < 15 * 60 + 45 { "open" }
    else { "post_close" }
}

fn is_market_hours_kst() -> bool { session_state_kst() == "open" }

#[tokio::main]
async fn main() {
    let _ = dotenvy::from_path("../.env");
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lens_realtime=info".into()),
        )
        .init();

    // Phase watchdog — KST 시간대 전환 INFO 로그 (Sleep/WarmUp/Live/WindDown).
    // start_dev.sh 터미널과 logs/realtime.log 양쪽에서 시간대 변화 보임.
    phase::spawn_watchdog(CancellationToken::new());

    let broadcaster = Arc::new(Broadcaster::new(BROADCAST_CAPACITY));

    // 피드 → 브로드캐스터 파이프라인 (고정)
    // 8192 → 32768. 내부망 LpBookSnapshot burst (수천/sec)이 200ms drain 윈도우보다 빨라
    // 일시 backpressure 가능. 4배 여유 두면 burst 흡수 + 정상 부하에선 의미 0.
    let (tx, mut rx) = mpsc::channel::<WsMessage>(32768);

    // 마스터 데이터 로드 (모든 모드에서 공유)
    let lm = load_futures_master();
    // 스프레드 자동 구독: 기본은 전체(SPREAD_AUTO_DAYS 미설정 시 무제한).
    // 환경변수로 "D-7 이내만" 같은 제한 가능.
    let spread_days = std::env::var("SPREAD_AUTO_DAYS")
        .ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(i64::MAX);
    let auto_spread_codes = load_auto_spread_codes(spread_days);
    info!("Auto-spread: {} codes (days_left <= {})", auto_spread_codes.len(),
        if spread_days == i64::MAX { "∞".to_string() } else { spread_days.to_string() });

    // ETF PDF extra 종목 — backend가 미가동이면 빈 Vec, 그 외엔 ETF + PDF stocks union의
    // master 미포함 코드만 추출해서 백그라운드 t1102 sweep 대상에 추가.
    let already_in_master: HashSet<String> = lm.stock_codes.clone();
    let (etf_pdf_extra_codes, etf_codes) = load_etf_pdf_extra_codes(&already_in_master).await;

    let shared = Arc::new(MasterShared {
        master_names: lm.names,
        master_stock_codes: lm.stock_codes,
        futures_to_spot: lm.futures_to_spot,
        kosdaq_codes: lm.kosdaq_codes,
        auto_spread_codes,
        ordered_stock_codes: lm.ordered_stocks,
        ordered_front_futures: lm.ordered_front_futures,
        etf_pdf_extra_codes,
        etf_codes,
    });

    let stats = Arc::new(Stats::default());
    let _ = stats.started.set(Instant::now());
    let feed_last_data_us = Arc::new(AtomicU64::new(now_us()));

    // t1102 진행 상태 — AppState와 LsApiFeed가 같은 Arc 공유 → /debug/stats에서 사이즈 노출.
    let fetched_stocks: Arc<DashMap<String, ()>> = Arc::new(DashMap::new());
    let failed_stocks: Arc<DashMap<String, feed::ls_rest::FailedT1102>> = Arc::new(DashMap::new());

    // 초기 모드
    let initial_mode = std::env::var("FEED_MODE").unwrap_or_else(|_| "mock".to_string());
    info!("Initial feed mode: {initial_mode}");
    let (initial_handle, initial_sub_tx) =
        spawn_feed(&initial_mode, tx.clone(), &shared, &stats, &feed_last_data_us, &fetched_stocks, &failed_stocks).expect("Failed to spawn initial feed");

    // mpsc → broadcast 브릿지.
    // 타입별로 cache key를 만들어 send_cached로 저장하면 재접속 클라이언트가 snapshot 복원.
    // Orderbook은 스트림성이라 cache 없이 전달.
    //
    // StockTick prev_close 백필 — 초기 t1102 응답에만 포함되고 라이브 S3_/K3_ 틱에는
    // 없음. 라이브 틱이 캐시를 덮어쓰면 prev_close가 사라져서 재접속 클라이언트의
    // snapshot에 빠지므로, code별 prev_close를 별도 보존하고 직렬화 직전에 채워줌.
    let stock_prev_close: Arc<DashMap<String, f64>> = Arc::new(DashMap::new());
    // EtfTick 필드 백필 — S3_(체결: price, volume)와 I5_(거래소 NAV) 두 스트림이 같은 EtfTick
    // 캐시 키를 덮어쓰므로, 한쪽만 들어오면 다른 쪽 필드가 사라짐. code별로 각 필드 마지막 값을
    // 보존하다 직렬화 직전에 0인 필드 채워줌.
    let etf_state: Arc<DashMap<String, EtfStateBridge>> = Arc::new(DashMap::new());
    let bc = broadcaster.clone();
    let stats_bridge = stats.clone();
    let prev_close_map = stock_prev_close.clone();
    let etf_state_map = etf_state.clone();

    // ─── LP 매트릭스 워커 ────────────────────────────────────────────────
    // startup에 backend(/api/lp/matrix-config + risk-params + positions + cost-inputs) fetch.
    // 200ms throttle로 fair_value_matrix + book_risk를 bridge tx에 발행 → envelope에 자동 묶임.
    // 가격은 bridge 안에서 sync로 dispatch (lock-free DashMap insert).
    let matrix_state = Arc::new(MatrixState::new());
    let fastapi_base = std::env::var("LENS_API_URL")
        .unwrap_or_else(|_| "http://localhost:8100".to_string());
    spawn_workers(matrix_state.clone(), tx.clone(), fastapi_base);
    let matrix_for_bridge = matrix_state.clone();

    // Bridge: rx에서 WsMessage 받아 backfill → pending 버퍼에 (code별 dedup) → 150ms마다
    // 일괄 직렬화 + 캐시 갱신 + batch envelope 한 번 broadcast.
    //
    // 효과:
    //   - 1500/sec 이벤트가 ~7/sec 배치로 압축 → 브라우저 onmessage 60Hz → 7Hz
    //   - 같은 code 중복 tick은 마지막 값만 (dedup) → 호가 50% 감소 추정
    //   - 클라이언트당 WebSocket write 빈도 7Hz로 평탄화 → 내부망 5+ 사용자 스케일 가능
    //
    // 트레이드오프: 최대 150ms 표시 지연. 트레이딩 모니터링 화면엔 무해 (KRX 발행 cadence와 동급).
    //   체결 경로엔 부적합 — 추후 별도 endpoint 분리 시 검토.
    tokio::spawn(async move {
        use std::collections::HashMap as StdHashMap;
        use tokio::time::{interval, Duration, MissedTickBehavior};

        let mut pending: StdHashMap<String, WsMessage> = StdHashMap::with_capacity(8192);
        // 200ms 윈도우 — KRX 발행 cadence와 동급. 7000 코드 부하 시 cache_only 쓰기율 절반.
        // 사람 눈엔 6.7Hz와 5Hz 차이 거의 무감각.
        let mut tick_interval = interval(Duration::from_millis(200));
        tick_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                maybe_msg = rx.recv() => {
                    let Some(mut msg) = maybe_msg else { break };
                    // LP 매트릭스 — 가격 dictionary 갱신 (sync, lock-free)
                    matrix_for_bridge.handle_tick(&msg);
                    // StockTick prev_close 백필
                    if let WsMessage::StockTick(ref mut t) = msg {
                        match t.prev_close {
                            Some(pc) => { prev_close_map.insert(t.code.clone(), pc); }
                            None => {
                                if let Some(pc) = prev_close_map.get(&t.code) {
                                    t.prev_close = Some(*pc);
                                }
                            }
                        }
                    }
                    // EtfTick 필드 백필
                    if let WsMessage::EtfTick(ref mut t) = msg {
                        let mut prev = etf_state_map.entry(t.code.clone()).or_default();
                        if t.price > 0.0 { prev.price = t.price; } else { t.price = prev.price; }
                        if t.nav > 0.0 { prev.nav = t.nav; } else { t.nav = prev.nav; }
                        if t.volume > 0 { prev.volume = t.volume; } else { t.volume = prev.volume; }
                    }
                    let key = msg_pending_key(&msg);
                    pending.insert(key, msg);
                    stats_bridge.tick_count.fetch_add(1, Ordering::Relaxed);
                }
                _ = tick_interval.tick() => {
                    if pending.is_empty() { continue; }
                    if bc.receiver_count() == 0 {
                        // 구독자 없으면 직렬화 스킵. 다음 클라이언트 접속 시 캐시 스냅샷에서
                        // 복원되도록 cacheable 만큼만 직렬화해서 캐시에 넣어둠.
                        for (_, msg) in pending.drain() {
                            if let Some(cache_key) = msg_cache_key(&msg) {
                                if let Ok(j) = serde_json::to_string(&msg) {
                                    bc.cache_if_changed(cache_key, axum::extract::ws::Utf8Bytes::from(j));
                                }
                            }
                            stats_bridge.tick_skipped_no_subscribers.fetch_add(1, Ordering::Relaxed);
                        }
                        continue;
                    }

                    // batch envelope: 개별 직렬화 + 캐시 갱신 + ticks 배열에 누적
                    // 핵심: item을 Utf8Bytes로 변환 후 cache는 cheap clone(Arc refcount inc),
                    // envelope 조립은 str push_str. 이전엔 cache용 String::clone(heap 전체 복사)이
                    // 매 tick × 600+ 종목에 발생했음.
                    let t_ser_start = Instant::now();
                    let mut items_bytes: Vec<axum::extract::ws::Utf8Bytes> = Vec::with_capacity(pending.len());
                    let mut total_len: usize = 0;
                    for (_, msg) in pending.drain() {
                        let Ok(item) = serde_json::to_string(&msg) else { continue };
                        // String → Utf8Bytes: 내부 heap을 통째 인수 (복사 0).
                        let item_bytes = axum::extract::ws::Utf8Bytes::from(item);
                        if let Some(cache_key) = msg_cache_key(&msg) {
                            // cheap clone — Bytes(Arc) refcount inc만, heap 복사 X.
                            bc.cache_if_changed(cache_key, item_bytes.clone());
                        }
                        total_len += item_bytes.len();
                        items_bytes.push(item_bytes);
                    }
                    if items_bytes.is_empty() { continue; }

                    // {"type":"batch","ticks":[<item1>,<item2>,...]} 직접 조립.
                    let mut envelope = String::with_capacity(total_len + items_bytes.len() + 32);
                    envelope.push_str("{\"type\":\"batch\",\"ticks\":[");
                    let mut first = true;
                    for item_bytes in &items_bytes {
                        if !first { envelope.push(','); }
                        first = false;
                        envelope.push_str(item_bytes);
                    }
                    envelope.push_str("]}");
                    let ser_elapsed = t_ser_start.elapsed().as_nanos() as u64;
                    stats_bridge.serialize_ns.fetch_add(ser_elapsed, Ordering::Relaxed);
                    stats_bridge.serialize_calls.fetch_add(1, Ordering::Relaxed);

                    let t_send_start = Instant::now();
                    // Utf8Bytes::from(String): String의 heap을 통째 인수, refcount Bytes로 래핑 — 복사 0.
                    // 클라이언트별 broadcast.recv()는 refcount inc만, 1.7MB envelope 통째 복제 회피.
                    bc.send(axum::extract::ws::Utf8Bytes::from(envelope));
                    let send_elapsed = t_send_start.elapsed().as_nanos() as u64;
                    stats_bridge.send_ns.fetch_add(send_elapsed, Ordering::Relaxed);
                    stats_bridge.send_calls.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    });

    let state = AppState {
        broadcaster,
        sub_tx: Arc::new(StdRwLock::new(initial_sub_tx)),
        feed_mode: Arc::new(StdRwLock::new(initial_mode)),
        feed_handle: Arc::new(TokioMutex::new(Some(initial_handle))),
        tx,
        shared,
        stats,
        feed_last_data_us,
        last_mode_change: Arc::new(StdRwLock::new(Instant::now())),
        stock_prev_close: stock_prev_close.clone(),
        etf_state: etf_state.clone(),
        fetched_stocks: fetched_stocks.clone(),
        failed_stocks: failed_stocks.clone(),
        next_client_id: Arc::new(AtomicU64::new(1)),
        client_subs: Arc::new(DashMap::new()),
        permanent_codes: Arc::new(StdRwLock::new(std::collections::HashSet::new())),
    };

    // Startup polling — realtime 단독 재시작 시 backend의 active 포지션 leg를
    // 가져와 permanent_codes 초기화. backend가 평소엔 변경 시점에 push하지만,
    // realtime이 backend보다 늦게 시작되거나 둘 다 재시작되면 push 받기 전 공백.
    // 그 공백을 polling으로 메움. backend 안 떠있으면 5초 × 12회 = 1분 retry 후 give up.
    {
        let bg_state = state.clone();
        tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .expect("reqwest client");
            for attempt in 1..=12u32 {
                tokio::time::sleep(std::time::Duration::from_secs(if attempt == 1 { 1 } else { 5 })).await;
                let resp = client
                    .get("http://localhost:8100/api/positions/active-leg-codes")
                    .send()
                    .await;
                let Ok(r) = resp else { continue };
                if !r.status().is_success() { continue }
                let Ok(body) = r.json::<serde_json::Value>().await else { continue };
                let codes: Vec<String> = body
                    .get("codes")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let (added, removed, total) = apply_permanent_set(&bg_state, codes);
                info!(
                    "Startup polling: synced permanent set from backend on attempt {} — set={} (+{} -{})",
                    attempt, total, added, removed
                );
                return;
            }
            warn!("Startup polling: backend unreachable after 12 attempts — permanent set stays empty. backend가 다음 변경 시점에 push할 때 회복.");
        });
    }

    // 스냅샷 캐시 stale watcher.
    // LS가 5분+ 침묵 시 broadcaster.cache가 옛 가격을 stale 상태로 보유 →
    // 재접속 클라이언트가 받은 스냅샷이 "지금 가격"인 양 표시되는 문제 방지.
    // ls_api 모드 + 장중에만 동작. 장 외(저녁/주말/휴장)엔 무신호가 정상이고
    // 전일 종가를 참고용으로 계속 보여주는 게 더 유용하므로 wipe 안 함.
    {
        let bg_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.tick().await;  // 시작 직후 1회 tick은 즉시 발생, skip
            let mut last_was_stale = false;
            loop {
                interval.tick().await;
                let mode = bg_state.feed_mode.read().unwrap().clone();
                if mode != "ls_api" { last_was_stale = false; continue; }
                // 장 외에는 무신호가 정상 — 캐시 유지 (전일 종가 참고용)
                if !is_market_hours_kst() { last_was_stale = false; continue; }
                let last_us = bg_state.feed_last_data_us.load(Ordering::Relaxed);
                let age_us = now_us().saturating_sub(last_us);
                let is_stale = age_us > 300_000_000;  // 5분
                if is_stale && !last_was_stale {
                    bg_state.broadcaster.clear_cache();
                    warn!("Feed stale (5min+ silent) — cleared snapshot cache to avoid serving outdated prices");
                }
                last_was_stale = is_stale;
            }
        });
    }

    // CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws/market", get(ws_market))
        .route("/health", get(health))
        .route("/mode", get(get_mode))
        .route("/mode/{mode}", post(set_mode))
        .route("/subscribe", post(subscribe))
        .route("/unsubscribe", post(unsubscribe))
        .route("/subscribe-stocks", post(subscribe_stocks))
        .route("/unsubscribe-stocks", post(unsubscribe_stocks))
        .route("/permanent-stocks", post(permanent_stocks))
        .route("/prioritize-stocks", post(prioritize_stocks))
        .route("/subscribe-inav", post(subscribe_inav))
        .route("/unsubscribe-inav", post(unsubscribe_inav))
        .route("/orderbook/subscribe", post(subscribe_orderbook))
        .route("/orderbook/subscribe-bulk", post(subscribe_orderbook_bulk))
        .route("/orderbook/unsubscribe", post(unsubscribe_orderbook))
        .route("/debug/stats", get(debug_stats))
        .with_state(state.clone())
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{PORT}"))
        .await
        .expect("Failed to bind port");

    // Nagle 끄기: WebSocket은 작은 JSON 프레임을 자주 쏘는 구조라 Nagle이 켜져있으면
    // 최대 40ms까지 지연된다. tap_io로 accept된 모든 TcpStream에 set_nodelay(true).
    use axum::serve::ListenerExt;
    let listener = listener.tap_io(|s| {
        if let Err(e) = s.set_nodelay(true) {
            tracing::warn!("set_nodelay failed: {e}");
        }
    });

    info!("Rust realtime service listening on port {PORT}");

    // Graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("Shutting down...");
            if let Some(h) = state.feed_handle.lock().await.take() {
                h.cancel.cancel();
                let _ = h.join.await;
            }
        })
        .await
        .expect("Server error");
}

/// 지정된 모드로 feed를 spawn. 공유 tx는 broadcaster 경로 유지용.
/// 새 (sub_tx, sub_rx) 페어를 생성해서 feed에 넘기고 sub_tx를 반환.
/// fetched/failed는 AppState 소유 — ls_api 모드일 때만 채워지고 mock/internal에선 unused.
fn spawn_feed(
    mode: &str,
    tx: mpsc::Sender<WsMessage>,
    shared: &Arc<MasterShared>,
    stats: &Arc<Stats>,
    feed_last_data_us: &Arc<AtomicU64>,
    fetched_stocks: &Arc<DashMap<String, ()>>,
    failed_stocks: &Arc<DashMap<String, feed::ls_rest::FailedT1102>>,
) -> Result<(FeedHandle, mpsc::UnboundedSender<SubCommand>), String> {
    let cancel = CancellationToken::new();
    let (sub_tx, sub_rx) = mpsc::unbounded_channel::<SubCommand>();
    let cancel_c = cancel.clone();

    let join = match mode {
        "ls_api" => {
            let app_key =
                std::env::var("LS_APP_KEY").map_err(|_| "LS_APP_KEY not set".to_string())?;
            let app_secret = std::env::var("LS_APP_SECRET")
                .map_err(|_| "LS_APP_SECRET not set".to_string())?;

            // 마스터 원본 순서대로 구독 — HashSet 순회는 비결정적이라
            // 실행마다 "어떤 종목이 먼저 뜨는지"가 달라져 디버깅이 어려움.
            let mut subscriptions: Vec<(String, String)> = Vec::new();
            for code in &shared.ordered_stock_codes {
                let tr = if shared.kosdaq_codes.contains(code) {
                    "K3_"
                } else {
                    "S3_"
                };
                subscriptions.push((tr.to_string(), code.clone()));
            }
            for futures_code in &shared.ordered_front_futures {
                subscriptions.push(("JC0".to_string(), futures_code.clone()));
            }
            // 스프레드: 만기 임박(기본 D-7) 종목만 자동 구독.
            // 그 외는 호가창에서 스프 모달 열 때만 동적 구독.
            for code in &shared.auto_spread_codes {
                subscriptions.push(("JC0".to_string(), code.clone()));
            }

            info!(
                "LS API auto-subscribe: {} codes ({} stocks, {} futures, {} auto-spreads), {} kosdaq",
                subscriptions.len(),
                shared.master_stock_codes.len(),
                subscriptions.iter().filter(|(tr, _)| tr == "JC0").count() - shared.auto_spread_codes.len(),
                shared.auto_spread_codes.len(),
                shared.kosdaq_codes.len(),
            );

            let feed = LsApiFeed::new(
                app_key,
                app_secret,
                subscriptions,
                shared.master_names.clone(),
                shared.master_stock_codes.clone(),
                shared.futures_to_spot.clone(),
                shared.kosdaq_codes.clone(),
                stats.clone(),
                feed_last_data_us.clone(),
                fetched_stocks.clone(),
                failed_stocks.clone(),
                shared.etf_pdf_extra_codes.clone(),
                shared.etf_codes.clone(),
            );
            tokio::spawn(async move { feed.run(tx, sub_rx, cancel_c).await })
        }
        "internal" => {
            let ws_url = std::env::var("INTERNAL_WS_URL")
                .unwrap_or_else(|_| "ws://10.21.1.208:41001".to_string());

            let subs_str = std::env::var("INTERNAL_SUBSCRIPTIONS")
                .unwrap_or_else(|_| "A005930,A069500".to_string());

            use crate::model::internal::short_to_subscribe;
            let subscribe_codes: Vec<String> = subs_str
                .split(',')
                .map(|s| short_to_subscribe(s.trim()))
                .collect();

            let real_nav = std::env::var("INTERNAL_REAL_NAV")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(true);

            info!(
                "Internal subscriptions: {:?} (real_nav={real_nav}), names: {} entries",
                subscribe_codes,
                shared.master_names.len()
            );

            let feed = InternalFeed::new(
                ws_url,
                subscribe_codes,
                shared.master_names.clone(),
                real_nav,
            );
            tokio::spawn(async move { feed.run(tx, sub_rx, cancel_c).await })
        }
        "mock" => {
            info!("Spawning mock feed");
            let feed = MockFeed;
            tokio::spawn(async move { feed.run(tx, sub_rx, cancel_c).await })
        }
        other => return Err(format!("Unknown mode: {other}")),
    };

    Ok((FeedHandle { cancel, join }, sub_tx))
}

async fn health() -> &'static str {
    "ok"
}

async fn get_mode(State(state): State<AppState>) -> String {
    state.feed_mode.read().unwrap().clone()
}

/// 런타임 피드 모드 전환. 기존 feed cancel → await join → 새 feed spawn.
const MODE_COOLDOWN_SECS: u64 = 5;

async fn set_mode(
    State(state): State<AppState>,
    Path(mode): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // 같은 모드면 no-op
    {
        let current = state.feed_mode.read().unwrap().clone();
        if current == mode {
            return Ok(Json(serde_json::json!({
                "status": "ok", "mode": mode, "changed": false
            })));
        }
    }

    // 쿨다운 체크 + 슬롯 claim을 한 critical section에서 처리.
    // 두 동시 요청이 read-then-write 사이를 비집고 들어가 둘 다 spawn_feed 호출하는
    // TOCTOU race 방지 — write 락 잡고 즉시 갱신 후 후속 작업 진행.
    {
        let mut last = state.last_mode_change.write().unwrap();
        let elapsed = last.elapsed().as_secs();
        if elapsed < MODE_COOLDOWN_SECS {
            let remain = MODE_COOLDOWN_SECS - elapsed;
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                format!("mode change cooldown — wait {remain}s"),
            ));
        }
        *last = Instant::now();  // 즉시 claim
    }

    // ls_api로 전환 시 feed_last_data_us reset.
    // 안 하면: mock 10분 돈 후 ls_api 켜면 last_data_us=10분전 → 뱃지 즉시 "stale"
    // (LS 연결도 시작 안 했는데). 또는 직전 ls_api 데이터가 잔존해 잠시 "fresh" 거짓말.
    if mode == "ls_api" {
        state.feed_last_data_us.store(now_us(), Ordering::Relaxed);
    }

    // 새 feed 먼저 spawn 시도 (실패 시 기존 feed 유지).
    // 모드 전환 시 fetched/failed는 비움 — 데이터 의미가 모드별로 다름 (mock 종목 등이 섞이지 않게).
    state.fetched_stocks.clear();
    state.failed_stocks.clear();
    let (new_handle, new_sub_tx) = spawn_feed(
        &mode, state.tx.clone(), &state.shared, &state.stats, &state.feed_last_data_us,
        &state.fetched_stocks, &state.failed_stocks,
    ).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // 성공했으니 기존 feed 교체
    let mut handle_guard = state.feed_handle.lock().await;
    if let Some(old) = handle_guard.take() {
        old.cancel.cancel();
        let _ = old.join.await;
    }
    // 이전 모드 cache 전부 비움 (mock → ls_api 전환 시 mock 종목이 snapshot으로 섞이는 것 방지).
    // 새 feed가 초기값 fetch하면 다시 채워짐.
    state.broadcaster.clear_cache();
    // Bridge backfill 상태도 비움 — LS API의 prev_close가 internal 모드로 leak되거나
    // 그 반대로 stale EtfState (price/nav/volume)가 다음 모드에 남는 것 방지.
    state.stock_prev_close.clear();
    state.etf_state.clear();
    *handle_guard = Some(new_handle);
    *state.sub_tx.write().unwrap() = new_sub_tx;
    *state.feed_mode.write().unwrap() = mode.clone();

    info!("Feed mode switched to: {mode}");
    Ok(Json(serde_json::json!({
        "status": "ok", "mode": mode, "changed": true
    })))
}

/// 만기 D-N 이내 종목의 스프레드 코드만 로드 (자동 구독용).
/// 그 외 스프레드는 호가창에서 모달 열 때만 동적 구독.
fn load_auto_spread_codes(days_threshold: i64) -> Vec<String> {
    let master_path = std::path::Path::new("../data/futures_master.json");
    let data = match std::fs::read_to_string(master_path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let master: serde_json::Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut codes = Vec::new();
    if let Some(items) = master["items"].as_array() {
        for item in items {
            let days_left = item.get("front")
                .and_then(|f| f.get("days_left"))
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            if days_left > days_threshold { continue; }
            if let Some(code) = item["spread_code"].as_str() {
                if !code.is_empty() {
                    codes.push(code.to_string());
                }
            }
        }
    }
    codes
}

/// futures_master.json 로드 결과. HashSet/HashMap은 lookup용, Vec은 구독 순서용.
struct LoadedMaster {
    names: HashMap<String, String>,
    stock_codes: HashSet<String>,
    futures_to_spot: HashMap<String, String>,
    kosdaq_codes: HashSet<String>,
    /// 마스터 items 원본 순서의 base_code. 구독 순서 결정용.
    ordered_stocks: Vec<String>,
    /// 원본 순서의 front 선물 코드. 근월 JC0 구독 순서용.
    ordered_front_futures: Vec<String>,
}

fn load_futures_master() -> LoadedMaster {
    let mut m = LoadedMaster {
        names: HashMap::new(),
        stock_codes: HashSet::new(),
        futures_to_spot: HashMap::new(),
        kosdaq_codes: HashSet::new(),
        ordered_stocks: Vec::new(),
        ordered_front_futures: Vec::new(),
    };

    let master_path = std::path::Path::new("../data/futures_master.json");
    let data = match std::fs::read_to_string(master_path) {
        Ok(d) => d,
        Err(e) => {
            warn!("futures_master.json not found: {e}");
            return m;
        }
    };

    let master: serde_json::Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(e) => {
            warn!("futures_master.json parse failed: {e}");
            return m;
        }
    };

    if let Some(items) = master["items"].as_array() {
        for item in items {
            let base_code = item["base_code"].as_str().unwrap_or("");
            let base_name = item["base_name"].as_str().unwrap_or("");

            if !base_code.is_empty() && !base_name.is_empty() {
                m.names.insert(base_code.to_string(), base_name.to_string());
                m.stock_codes.insert(base_code.to_string());
                m.ordered_stocks.push(base_code.to_string());

                let market = item["market"].as_str().unwrap_or("KOSPI");
                if market == "KOSDAQ" {
                    m.kosdaq_codes.insert(base_code.to_string());
                }

                if let Some(front) = item.get("front") {
                    if let Some(code) = front["code"].as_str() {
                        let fname = front["name"].as_str().unwrap_or(base_name);
                        m.names.insert(code.to_string(), fname.to_string());
                        m.futures_to_spot.insert(code.to_string(), base_code.to_string());
                        m.ordered_front_futures.push(code.to_string());
                    }
                }
                if let Some(back) = item.get("back") {
                    if let Some(code) = back["code"].as_str() {
                        let bname = back["name"].as_str().unwrap_or(base_name);
                        m.names.insert(code.to_string(), bname.to_string());
                        m.futures_to_spot.insert(code.to_string(), base_code.to_string());
                    }
                }
            }
        }
    }

    info!(
        "Loaded futures master: {} names, {} stock codes, {} futures→spot, {} kosdaq",
        m.names.len(),
        m.stock_codes.len(),
        m.futures_to_spot.len(),
        m.kosdaq_codes.len()
    );

    // 거래대금 캐시 (전 sweep 누적) 기준 desc 정렬 — 활발한 종목부터 t1102 fetch.
    // 캐시 없으면 마스터 원본 순서 유지 (sort_by stable).
    let volumes = volume_cache::snapshot();
    if !volumes.is_empty() {
        m.ordered_stocks.sort_by(|a, b| {
            let va = volumes.get(a).copied().unwrap_or(0);
            let vb = volumes.get(b).copied().unwrap_or(0);
            vb.cmp(&va)
        });
        let covered = m.ordered_stocks.iter().filter(|c| volumes.contains_key(*c)).count();
        info!("ordered_stocks resorted by 거래대금 ({covered}/{} 종목에 캐시값 있음)", m.ordered_stocks.len());
    }

    m
}

/// 백엔드 `/api/etfs/pdf-all`에서 ETF + PDF stocks 코드 union 추출 → 주식선물 마스터 외의
/// 종목만 반환 (= 잡주). 시작 시 LsApiFeed가 백그라운드 t1102 sweep 대상에 추가하면
/// 사용자가 ETF 페이지 진입 시 가격이 이미 채워져 있어 즉시 표시.
///
/// backend 미가동 / 응답 실패 시 빈 Vec 반환 (graceful degradation — fixed 마스터 250개로 폴백).
/// 코드 형식 정규화: 'CASH' / 9자리 선물코드(KA*, KAM*) 제외, 6자리 영숫자만.
async fn load_etf_pdf_extra_codes(already_in_master: &HashSet<String>) -> (Vec<String>, HashSet<String>) {
    let url = std::env::var("BACKEND_URL")
        .unwrap_or_else(|_| "http://localhost:8100".to_string());
    let endpoint = format!("{url}/api/etfs/pdf-all");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("build reqwest client");

    let resp = match client.get(&endpoint).send().await {
        Ok(r) => r,
        Err(e) => {
            warn!("ETF PDF master fetch skipped — backend unreachable ({e}). 마스터 fallback.");
            return (Vec::new(), HashSet::new());
        }
    };
    if !resp.status().is_success() {
        warn!("ETF PDF master fetch failed: status={} → fallback", resp.status());
        return (Vec::new(), HashSet::new());
    }
    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            warn!("ETF PDF master JSON parse failed: {e} → fallback");
            return (Vec::new(), HashSet::new());
        }
    };

    let mut union: HashSet<String> = HashSet::new();
    let mut etf_codes: HashSet<String> = HashSet::new();  // ETF 자체 코드만 따로 보존
    let mut etf_count = 0usize;
    let mut stock_count = 0usize;
    if let Some(items) = body.get("items").and_then(|v| v.as_object()) {
        for (etf_code, etf_obj) in items {
            // ETF 자체 코드 (6자리 영숫자만 통과)
            if is_six_alnum(etf_code) {
                union.insert(etf_code.clone());
                etf_codes.insert(etf_code.clone());
                etf_count += 1;
            }
            if let Some(stocks) = etf_obj.get("stocks").and_then(|v| v.as_array()) {
                for s in stocks {
                    if let Some(c) = s.get("code").and_then(|v| v.as_str()) {
                        if is_six_alnum(c) {
                            union.insert(c.to_string());
                            stock_count += 1;
                        }
                    }
                }
            }
        }
    }

    // 마스터에 이미 있는 종목 제외 — t1102 sweep 중복 회피.
    let extra: Vec<String> = union.into_iter()
        .filter(|c| !already_in_master.contains(c))
        .collect();

    info!(
        "ETF PDF master loaded: {etf_count} ETFs ({} unique codes), {stock_count} PDF rows → {} extra codes (마스터 미포함)",
        etf_codes.len(), extra.len()
    );
    (extra, etf_codes)
}

/// 6자리 ASCII 영숫자 코드인지 (KRX 종목 표준 형식). 'CASH'/9자리 선물코드 등 배제.
fn is_six_alnum(s: &str) -> bool {
    s.len() == 6 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

#[derive(Deserialize)]
struct SubRequest {
    codes: Vec<String>,
}

async fn subscribe(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    info!("REST subscribe: {} codes", count);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::Subscribe(req.codes));
    Json(serde_json::json!({"status": "ok", "subscribed": count}))
}

async fn unsubscribe(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    info!("REST unsubscribe: {} codes", count);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::Unsubscribe(req.codes));
    Json(serde_json::json!({"status": "ok", "unsubscribed": count}))
}

/// 헤더에서 X-LENS-Client-Id 파싱 (옵셔널). 없거나 파싱 실패면 None — legacy 호출 호환.
fn extract_client_id(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("x-lens-client-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
}

/// 주식/ETF 코드 누적 구독 (S3_/K3_). 선물 /subscribe와 격리된 그룹.
async fn subscribe_stocks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    let cid = extract_client_id(&headers);
    if let Some(id) = cid {
        let entry = state.client_subs.entry(id).or_insert_with(dashmap::DashSet::new);
        for c in &req.codes { entry.insert(c.clone()); }
    }
    info!("REST subscribe-stocks: {} codes (client={:?})", count, cid);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::SubscribeStocks(req.codes));
    Json(serde_json::json!({"status": "ok", "subscribed": count}))
}

async fn unsubscribe_stocks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    let cid = extract_client_id(&headers);
    if let Some(id) = cid {
        if let Some(entry) = state.client_subs.get(&id) {
            for c in &req.codes { entry.remove(c); }
        }
    }
    info!("REST unsubscribe-stocks: {} codes (client={:?})", count, cid);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::UnsubscribeStocks(req.codes));
    Json(serde_json::json!({"status": "ok", "unsubscribed": count}))
}

/// 영구 sub set을 통째로 replace — REST 핸들러와 startup polling이 공유.
/// 반환: (added 수, removed 수, 새 set 크기).
fn apply_permanent_set(state: &AppState, codes: Vec<String>) -> (usize, usize, usize) {
    use std::collections::HashSet;
    let new_set: HashSet<String> = codes.into_iter().collect();
    let (added, removed): (Vec<String>, Vec<String>) = {
        let mut cur = state.permanent_codes.write().unwrap();
        let added: Vec<String> = new_set.iter().filter(|c| !cur.contains(*c)).cloned().collect();
        let removed: Vec<String> = cur.iter().filter(|c| !new_set.contains(*c)).cloned().collect();
        *cur = new_set.clone();
        (added, removed)
    };
    let tx = state.sub_tx.read().unwrap();
    if !added.is_empty() {
        let _ = tx.send(SubCommand::SubscribeStocks(added.clone()));
    }
    if !removed.is_empty() {
        let _ = tx.send(SubCommand::UnsubscribeStocks(removed.clone()));
    }
    (added.len(), removed.len(), new_set.len())
}

/// Backend가 영구 sub set을 통째로 replace. 활성 포지션 leg 코드 등.
/// 현재 set과 diff 계산해서 SubscribeStocks/UnsubscribeStocks 발사 (ref-count + warm-down에 위임).
/// 페이지 mount/unmount와 무관하게 영구 효과 — client_subs 추적 안 함(헤더 없음).
async fn permanent_stocks(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let (added, removed, total) = apply_permanent_set(&state, req.codes);
    info!("REST permanent-stocks: set={} (+{} -{})", total, added, removed);
    Json(serde_json::json!({
        "status": "ok",
        "total": total,
        "added": added,
        "removed": removed,
    }))
}

/// 우선 fetch — 사용자 ETF 클릭 시 그 PDF 종목들 즉시 보충.
/// 이미 fetched면 자동 skip, 아니면 retry worker가 다음 cycle에 처리.
async fn prioritize_stocks(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    info!("REST prioritize-stocks: {} codes", count);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::PrioritizeStocks(req.codes));
    Json(serde_json::json!({"status": "ok", "prioritized": count}))
}

/// ETF iNAV 누적 구독 (I5_) — 거래소 발행 NAV stream.
async fn subscribe_inav(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    info!("REST subscribe-inav: {} codes", count);
    let _ = state.sub_tx.read().unwrap().send(SubCommand::SubscribeInav(req.codes));
    Json(serde_json::json!({"status": "ok", "subscribed": count}))
}

async fn unsubscribe_inav(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    info!("REST unsubscribe-inav: {} codes", count);
    let _ = state.sub_tx.read().unwrap().send(SubCommand::UnsubscribeInav(req.codes));
    Json(serde_json::json!({"status": "ok", "unsubscribed": count}))
}

#[derive(Deserialize)]
struct OrderbookRequest {
    #[serde(default)]
    spot_code: Option<String>,
    #[serde(default)]
    futures_code: Option<String>,
    #[serde(default)]
    spread_code: Option<String>,
}

#[derive(Deserialize)]
struct OrderbookBulkRequest {
    codes: Vec<String>,
}

/// 일괄 호가 구독 — ETF 스크리너처럼 다수 종목 호가가 필요한 화면용.
/// 단일 모달용 `subscribe_orderbook`과 달리 KOSPI/KOSDAQ 분류만 자동으로
/// 처리. 선물 호가(JH0)는 미지원 — 필요 시 별도 엔드포인트 추가.
async fn subscribe_orderbook_bulk(
    State(state): State<AppState>,
    Json(req): Json<OrderbookBulkRequest>,
) -> Json<serde_json::Value> {
    let mut codes: Vec<(String, String)> = Vec::with_capacity(req.codes.len());
    for code in req.codes {
        let tr = if state.shared.kosdaq_codes.contains(&code) {
            "HA_"
        } else {
            "H1_"
        };
        codes.push((tr.to_string(), code));
    }
    let count = codes.len();
    info!("REST orderbook bulk subscribe: {} codes", count);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::SubscribeOrderbook { codes });
    Json(serde_json::json!({"status": "ok", "subscribed": count}))
}

async fn subscribe_orderbook(
    State(state): State<AppState>,
    Json(req): Json<OrderbookRequest>,
) -> Json<serde_json::Value> {
    let mut codes: Vec<(String, String)> = Vec::new();

    if let Some(spot) = &req.spot_code {
        let tr = if state.shared.kosdaq_codes.contains(spot) {
            "HA_"
        } else {
            "H1_"
        };
        codes.push((tr.to_string(), spot.clone()));
    }
    if let Some(fut) = &req.futures_code {
        codes.push(("JH0".to_string(), fut.clone()));
    }
    if let Some(spr) = &req.spread_code {
        // 스프레드 호가창을 열면 호가(JH0)와 체결(JC0)을 함께 구독.
        // 체결은 자동 구독 대상이 아니라 모달 열 때만 받음 (한도 보호).
        codes.push(("JH0".to_string(), spr.clone()));
        codes.push(("JC0".to_string(), spr.clone()));
    }

    let count = codes.len();
    info!("REST orderbook subscribe: {} codes", count);
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::SubscribeOrderbook { codes });
    Json(serde_json::json!({"status": "ok", "subscribed": count}))
}

async fn unsubscribe_orderbook(State(state): State<AppState>) -> Json<serde_json::Value> {
    info!("REST orderbook unsubscribe");
    let _ = state
        .sub_tx
        .read()
        .unwrap()
        .send(SubCommand::UnsubscribeOrderbook);
    Json(serde_json::json!({"status": "ok"}))
}

/// 틱 처리 파이프라인 성능 카운터. 9번(Arc<str> 인터닝 / struct deserialize)
/// 적용 여부를 판단하기 위한 실측 근거 수집용.
async fn debug_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    let s = &state.stats;
    let ticks = s.tick_count.load(Ordering::Relaxed);
    let ser_ns = s.serialize_ns.load(Ordering::Relaxed);
    let ser_calls = s.serialize_calls.load(Ordering::Relaxed);
    let send_ns = s.send_ns.load(Ordering::Relaxed);
    let send_calls = s.send_calls.load(Ordering::Relaxed);
    let uptime_s = s.started.get().map(|i| i.elapsed().as_secs_f64()).unwrap_or(0.0);
    let avg = |n: u64, c: u64| if c > 0 { n / c } else { 0 };

    // Feed health 산출.
    // mock/internal 모드는 별도 상태로 분리 (LS API와 무관).
    // ls_api 모드는 세션 상태 + 마지막 데이터 시각 기반:
    //   장 외 4단계: closed(주말·공휴일) / pre_open(09:00 전) / post_close(15:45 후)
    //   장 중: <30s → "fresh", <300s → "quiet", >=300s → "stale"
    let mode = state.feed_mode.read().unwrap().clone();
    let session = session_state_kst();
    let last_us = state.feed_last_data_us.load(Ordering::Relaxed);
    let age_us = now_us().saturating_sub(last_us);
    let age_sec = age_us as f64 / 1_000_000.0;
    let feed_state = match mode.as_str() {
        "mock" => "mock",
        "internal" => "internal",
        "ls_api" => match session {
            "open" => {
                if age_us < 30_000_000 { "fresh" }
                else if age_us < 300_000_000 { "quiet" }
                else { "stale" }
            }
            other => other, // pre_open / post_close / closed 그대로 전달
        },
        _ => "unknown",
    };

    // t1102 진행 상태 + emit 분류 — "왜 클릭 전엔 못 받지?" 디버깅용.
    // ordered_total: 마스터 현물 코드 수.
    // fetched_size: value>0로 emit되어 sweep skip 대상 (= 정상 가격 보유).
    // failed_size: 실패/pc_only 등 retry worker 처리 대상 (= 가격 0 또는 미수신).
    // emit_value_pos vs emit_pc_only: pc_only 비율이 높으면 거래량 적은 잡주가 많은 상태 (정상).
    let ordered_total = state.shared.ordered_stock_codes.len();
    let fetched_size = state.fetched_stocks.len();
    let failed_size = state.failed_stocks.len();
    // failed 분류별 카운트 — pc_only / no_data / http_5xx / tps / other.
    let mut failed_by_kind: std::collections::HashMap<&'static str, usize> = std::collections::HashMap::new();
    for entry in state.failed_stocks.iter() {
        *failed_by_kind.entry(entry.error_kind).or_insert(0) += 1;
    }

    Json(serde_json::json!({
        "uptime_sec": uptime_s,
        "ticks_total": ticks,
        "ticks_per_sec": if uptime_s > 0.0 { ticks as f64 / uptime_s } else { 0.0 },
        "ticks_skipped_no_subscribers": s.tick_skipped_no_subscribers.load(Ordering::Relaxed),
        "ws_clients": state.broadcaster.receiver_count(),
        "ws_lag_total": s.ws_lag_total.load(Ordering::Relaxed),
        "reconnect_count": s.reconnect_count.load(Ordering::Relaxed),
        // LS feed → bridge mpsc 채널 full로 drop된 틱 수. 0이 정상.
        // 누적되면 bridge가 못 따라잡거나 broadcast/serialize 핫 path가 느린 신호.
        "tx_dropped": crate::feed::ls_api::TX_DROPPED.load(Ordering::Relaxed),
        "feed_mode": mode,
        "feed_state": feed_state,
        "feed_age_sec": age_sec,
        "session": session,
        "is_market_hours": session == "open",
        "serialize": {
            "calls": ser_calls,
            "total_ns": ser_ns,
            "avg_ns": avg(ser_ns, ser_calls),
        },
        "send_cached": {
            "calls": send_calls,
            "total_ns": send_ns,
            "avg_ns": avg(send_ns, send_calls),
        },
        "fetch_failures": {
            "no_data": s.fetch_no_data.load(Ordering::Relaxed),
            "http_5xx": s.fetch_http_5xx.load(Ordering::Relaxed),
            "tps": s.fetch_tps.load(Ordering::Relaxed),
            "other": s.fetch_other.load(Ordering::Relaxed),
        },
        "t1102_progress": {
            "ordered_total": ordered_total,
            "fetched_size": fetched_size,
            "failed_size": failed_size,
            "failed_by_kind": failed_by_kind,
            "fetch_attempts": s.fetch_attempts.load(Ordering::Relaxed),
            "emit_value_pos": s.emit_value_pos.load(Ordering::Relaxed),
            "emit_pc_only": s.emit_pc_only.load(Ordering::Relaxed),
        },
    }))
}
