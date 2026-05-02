mod feed;
mod holidays;
mod model;
mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
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

const PORT: u16 = 8200;
/// 브로드캐스트 링버퍼 크기. 500종목 × ~2 tps ≈ 1000 msg/s 기준,
/// 4096이면 슬로우 클라이언트에 약 4초 여유. 그 이상 밀리면 Lagged → skip.
/// 16384는 22초 버퍼로 과했음.
const BROADCAST_CAPACITY: usize = 4096;

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
}

fn now_us() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// KST 평일 09:00~15:45, KRX 휴장일 제외 — debug_stats에서 feed_state 산출용.
/// ls_api.rs의 is_market_hours()와 중복이지만 거기 모듈 함수는 private이라 복제 OK.
fn is_market_hours_kst() -> bool {
    use chrono::{Datelike, Local, Timelike, Weekday};
    let now = Local::now();
    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) { return false; }
    if holidays::is_krx_holiday(now.date_naive()) { return false; }
    let mins = now.hour() * 60 + now.minute();
    (9 * 60..15 * 60 + 45).contains(&mins)
}

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

    let broadcaster = Arc::new(Broadcaster::new(BROADCAST_CAPACITY));

    // 피드 → 브로드캐스터 파이프라인 (고정)
    let (tx, mut rx) = mpsc::channel::<WsMessage>(8192);

    // 마스터 데이터 로드 (모든 모드에서 공유)
    let lm = load_futures_master();
    // 스프레드 자동 구독: 기본은 전체(SPREAD_AUTO_DAYS 미설정 시 무제한).
    // 환경변수로 "D-7 이내만" 같은 제한 가능.
    let spread_days = std::env::var("SPREAD_AUTO_DAYS")
        .ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(i64::MAX);
    let auto_spread_codes = load_auto_spread_codes(spread_days);
    info!("Auto-spread: {} codes (days_left <= {})", auto_spread_codes.len(),
        if spread_days == i64::MAX { "∞".to_string() } else { spread_days.to_string() });
    let shared = Arc::new(MasterShared {
        master_names: lm.names,
        master_stock_codes: lm.stock_codes,
        futures_to_spot: lm.futures_to_spot,
        kosdaq_codes: lm.kosdaq_codes,
        auto_spread_codes,
        ordered_stock_codes: lm.ordered_stocks,
        ordered_front_futures: lm.ordered_front_futures,
    });

    let stats = Arc::new(Stats::default());
    let _ = stats.started.set(Instant::now());
    let feed_last_data_us = Arc::new(AtomicU64::new(now_us()));

    // 초기 모드
    let initial_mode = std::env::var("FEED_MODE").unwrap_or_else(|_| "mock".to_string());
    info!("Initial feed mode: {initial_mode}");
    let (initial_handle, initial_sub_tx) =
        spawn_feed(&initial_mode, tx.clone(), &shared, &stats, &feed_last_data_us).expect("Failed to spawn initial feed");

    // mpsc → broadcast 브릿지.
    // 타입별로 cache key를 만들어 send_cached로 저장하면 재접속 클라이언트가 snapshot 복원.
    // Orderbook은 스트림성이라 cache 없이 전달.
    let bc = broadcaster.clone();
    let stats_bridge = stats.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let key = match &msg {
                WsMessage::StockTick(t) => Some(format!("stock_tick:{}", t.code)),
                WsMessage::FuturesTick(t) => Some(format!("futures_tick:{}", t.code)),
                WsMessage::EtfTick(t) => Some(format!("etf_tick:{}", t.code)),
                WsMessage::OrderbookTick(_) => None,
            };
            // 캐시 안 하는 스트림(OrderbookTick) + 연결된 WS 클라이언트 0명 → 직렬화 스킵.
            // 캐시 대상 틱은 새 클라이언트 스냅샷 복원에 필요해서 항상 직렬화해야 함.
            if key.is_none() && bc.receiver_count() == 0 {
                stats_bridge.tick_skipped_no_subscribers.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let t_ser_start = Instant::now();
            let ser = serde_json::to_string(&msg);
            let ser_elapsed = t_ser_start.elapsed().as_nanos() as u64;
            stats_bridge.serialize_ns.fetch_add(ser_elapsed, Ordering::Relaxed);
            stats_bridge.serialize_calls.fetch_add(1, Ordering::Relaxed);
            match ser {
                Ok(json) => {
                    let arc: Arc<str> = Arc::from(json);
                    let t_send_start = Instant::now();
                    if let Some(k) = key {
                        bc.send_cached(k, arc);
                    } else {
                        bc.send(arc);
                    }
                    let send_elapsed = t_send_start.elapsed().as_nanos() as u64;
                    stats_bridge.send_ns.fetch_add(send_elapsed, Ordering::Relaxed);
                    stats_bridge.send_calls.fetch_add(1, Ordering::Relaxed);
                    stats_bridge.tick_count.fetch_add(1, Ordering::Relaxed);
                }
                Err(e) => tracing::error!("JSON serialization error: {}", e),
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
    };

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
        .route("/orderbook/subscribe", post(subscribe_orderbook))
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
fn spawn_feed(
    mode: &str,
    tx: mpsc::Sender<WsMessage>,
    shared: &Arc<MasterShared>,
    stats: &Arc<Stats>,
    feed_last_data_us: &Arc<AtomicU64>,
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

    // 새 feed 먼저 spawn 시도 (실패 시 기존 feed 유지)
    let (new_handle, new_sub_tx) = spawn_feed(&mode, state.tx.clone(), &state.shared, &state.stats, &state.feed_last_data_us)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // 성공했으니 기존 feed 교체
    let mut handle_guard = state.feed_handle.lock().await;
    if let Some(old) = handle_guard.take() {
        old.cancel.cancel();
        let _ = old.join.await;
    }
    // 이전 모드 cache 전부 비움 (mock → ls_api 전환 시 mock 종목이 snapshot으로 섞이는 것 방지).
    // 새 feed가 초기값 fetch하면 다시 채워짐.
    state.broadcaster.clear_cache();
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
    m
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

#[derive(Deserialize)]
struct OrderbookRequest {
    #[serde(default)]
    spot_code: Option<String>,
    #[serde(default)]
    futures_code: Option<String>,
    #[serde(default)]
    spread_code: Option<String>,
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

    info!("REST orderbook subscribe: {:?}", codes);
    let count = codes.len();
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
    // ls_api 모드는 장 시간 + 마지막 데이터 시각 기반:
    //   장 시간 외 → "closed"
    //   <30s → "fresh", <300s → "quiet", >=300s → "stale"
    let mode = state.feed_mode.read().unwrap().clone();
    let last_us = state.feed_last_data_us.load(Ordering::Relaxed);
    let age_us = now_us().saturating_sub(last_us);
    let age_sec = age_us as f64 / 1_000_000.0;
    let feed_state = match mode.as_str() {
        "mock" => "mock",
        "internal" => "internal",
        "ls_api" => {
            if !is_market_hours_kst() { "closed" }
            else if age_us < 30_000_000 { "fresh" }
            else if age_us < 300_000_000 { "quiet" }
            else { "stale" }
        }
        _ => "unknown",
    };

    Json(serde_json::json!({
        "uptime_sec": uptime_s,
        "ticks_total": ticks,
        "ticks_per_sec": if uptime_s > 0.0 { ticks as f64 / uptime_s } else { 0.0 },
        "ticks_skipped_no_subscribers": s.tick_skipped_no_subscribers.load(Ordering::Relaxed),
        "ws_clients": state.broadcaster.receiver_count(),
        "ws_lag_total": s.ws_lag_total.load(Ordering::Relaxed),
        "reconnect_count": s.reconnect_count.load(Ordering::Relaxed),
        "feed_mode": mode,
        "feed_state": feed_state,
        "feed_age_sec": age_sec,
        "is_market_hours": is_market_hours_kst(),
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
    }))
}
