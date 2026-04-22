mod feed;
mod model;
mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock as StdRwLock};

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
const BROADCAST_CAPACITY: usize = 16384;

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
    let (master_names, master_stock_codes, futures_to_spot, kosdaq_codes) = load_futures_master();
    // 만기 임박 스프레드만 자동 구독 (기본 7일, 환경변수로 조정)
    let spread_days = std::env::var("SPREAD_AUTO_DAYS")
        .ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(7);
    let auto_spread_codes = load_auto_spread_codes(spread_days);
    info!("Auto-spread: {} codes (days_left <= {})", auto_spread_codes.len(), spread_days);
    let shared = Arc::new(MasterShared {
        master_names,
        master_stock_codes,
        futures_to_spot,
        kosdaq_codes,
        auto_spread_codes,
    });

    // 초기 모드
    let initial_mode = std::env::var("FEED_MODE").unwrap_or_else(|_| "mock".to_string());
    info!("Initial feed mode: {initial_mode}");
    let (initial_handle, initial_sub_tx) =
        spawn_feed(&initial_mode, tx.clone(), &shared).expect("Failed to spawn initial feed");

    // mpsc → broadcast 브릿지
    let bc = broadcaster.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => bc.send(Arc::from(json)),
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
    };

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
        .with_state(state.clone())
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{PORT}"))
        .await
        .expect("Failed to bind port");

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

            let mut subscriptions: Vec<(String, String)> = Vec::new();
            for code in &shared.master_stock_codes {
                let tr = if shared.kosdaq_codes.contains(code) {
                    "K3_"
                } else {
                    "S3_"
                };
                subscriptions.push((tr.to_string(), code.clone()));
            }
            for (futures_code, _) in &shared.futures_to_spot {
                if futures_code.ends_with("65000") {
                    subscriptions.push(("JC0".to_string(), futures_code.clone()));
                }
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

    // 새 feed 먼저 spawn 시도 (실패 시 기존 feed 유지)
    let (new_handle, new_sub_tx) = spawn_feed(&mode, state.tx.clone(), &state.shared)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // 성공했으니 기존 feed 교체
    let mut handle_guard = state.feed_handle.lock().await;
    if let Some(old) = handle_guard.take() {
        old.cancel.cancel();
        let _ = old.join.await;
    }
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

/// futures_master.json에서 종목명 매핑, 현물 코드 Set, 선물→현물 매핑, 코스닥 코드를 로드.
fn load_futures_master() -> (
    HashMap<String, String>,
    HashSet<String>,
    HashMap<String, String>,
    HashSet<String>,
) {
    let mut names = HashMap::new();
    let mut stock_codes = HashSet::new();
    let mut futures_to_spot = HashMap::new();
    let mut kosdaq_codes = HashSet::new();

    let master_path = std::path::Path::new("../data/futures_master.json");
    let data = match std::fs::read_to_string(master_path) {
        Ok(d) => d,
        Err(e) => {
            warn!("futures_master.json not found: {e}");
            return (names, stock_codes, futures_to_spot, kosdaq_codes);
        }
    };

    let master: serde_json::Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(e) => {
            warn!("futures_master.json parse failed: {e}");
            return (names, stock_codes, futures_to_spot, kosdaq_codes);
        }
    };

    if let Some(items) = master["items"].as_array() {
        for item in items {
            let base_code = item["base_code"].as_str().unwrap_or("");
            let base_name = item["base_name"].as_str().unwrap_or("");

            if !base_code.is_empty() && !base_name.is_empty() {
                names.insert(base_code.to_string(), base_name.to_string());
                stock_codes.insert(base_code.to_string());

                let market = item["market"].as_str().unwrap_or("KOSPI");
                if market == "KOSDAQ" {
                    kosdaq_codes.insert(base_code.to_string());
                }

                if let Some(front) = item.get("front") {
                    if let Some(code) = front["code"].as_str() {
                        let fname = front["name"].as_str().unwrap_or(base_name);
                        names.insert(code.to_string(), fname.to_string());
                        futures_to_spot.insert(code.to_string(), base_code.to_string());
                    }
                }
                if let Some(back) = item.get("back") {
                    if let Some(code) = back["code"].as_str() {
                        let bname = back["name"].as_str().unwrap_or(base_name);
                        names.insert(code.to_string(), bname.to_string());
                        futures_to_spot.insert(code.to_string(), base_code.to_string());
                    }
                }
            }
        }
    }

    info!(
        "Loaded futures master: {} names, {} stock codes, {} futures→spot, {} kosdaq",
        names.len(),
        stock_codes.len(),
        futures_to_spot.len(),
        kosdaq_codes.len()
    );
    (names, stock_codes, futures_to_spot, kosdaq_codes)
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
