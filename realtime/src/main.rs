mod feed;
mod model;
mod ws;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::State;
use axum::http::Method;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

use feed::internal::InternalFeed;
use feed::ls_api::LsApiFeed;
use feed::mock::MockFeed;
use feed::{MarketFeed, SubCommand};
use ws::broadcast::Broadcaster;
use ws::handler::ws_market;

const PORT: u16 = 8200;
const BROADCAST_CAPACITY: usize = 16384;

/// 앱 공유 상태: broadcaster + 구독 명령 채널 + 피드 모드
#[derive(Clone)]
pub struct AppState {
    broadcaster: Arc<Broadcaster>,
    sub_tx: mpsc::UnboundedSender<SubCommand>,
    feed_mode: Arc<str>,
}

#[tokio::main]
async fn main() {
    // .env 파일 로드 (없으면 무시)
    let _ = dotenvy::from_path("../.env");
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lens_realtime=info".into()),
        )
        .init();

    let cancel = CancellationToken::new();
    let broadcaster = Arc::new(Broadcaster::new(BROADCAST_CAPACITY));

    // 피드 → 브로드캐스터 파이프라인
    let (tx, mut rx) = mpsc::channel(8192);
    let (sub_tx, sub_rx) = mpsc::unbounded_channel::<SubCommand>();
    let feed_cancel = cancel.clone();

    // 모드 선택: FEED_MODE 환경변수 (mock / ls_api / internal)
    let mode = std::env::var("FEED_MODE").unwrap_or_else(|_| "mock".to_string());
    info!("Feed mode: {mode}");

    match mode.as_str() {
        "ls_api" => {
            let app_key = std::env::var("LS_APP_KEY").expect("LS_APP_KEY not set");
            let app_secret = std::env::var("LS_APP_SECRET").expect("LS_APP_SECRET not set");

            // futures_master.json에서 종목명 + 현물코드 + 선물→현물 매핑 + 코스닥 로드
            let (master_names, master_stock_codes, futures_to_spot, kosdaq_codes) = load_futures_master();

            // 마스터 기반으로 전체 종목 자동 구독 구성
            let mut subscriptions: Vec<(String, String)> = Vec::new();

            // 현물: 코스닥은 K3_, 나머지는 S3_
            for code in &master_stock_codes {
                let tr = if kosdaq_codes.contains(code) { "K3_" } else { "S3_" };
                subscriptions.push((tr.to_string(), code.clone()));
            }

            // 선물: 근월물 JC0
            for (futures_code, _spot_code) in &futures_to_spot {
                // 근월물만 (코드가 65000으로 끝나는 것)
                if futures_code.ends_with("65000") {
                    subscriptions.push(("JC0".to_string(), futures_code.clone()));
                }
            }

            info!("LS API auto-subscribe: {} codes ({} stocks, {} futures), {} kosdaq",
                subscriptions.len(),
                master_stock_codes.len(),
                subscriptions.iter().filter(|(tr, _)| tr == "JC0").count(),
                kosdaq_codes.len(),
            );

            let feed = LsApiFeed::new(app_key, app_secret, subscriptions, master_names, master_stock_codes, futures_to_spot, kosdaq_codes);
            tokio::spawn(async move {
                feed.run(tx, sub_rx, feed_cancel).await;
            });
        }
        "internal" => {
            let ws_url = std::env::var("INTERNAL_WS_URL")
                .unwrap_or_else(|_| "ws://10.21.1.208:41001".to_string());

            let subs_str = std::env::var("INTERNAL_SUBSCRIPTIONS").unwrap_or_else(|_| {
                "A005930,A069500".to_string()
            });

            use crate::model::internal::short_to_subscribe;
            let subscribe_codes: Vec<String> = subs_str
                .split(',')
                .map(|s| {
                    let trimmed = s.trim();
                    short_to_subscribe(trimmed)
                })
                .collect();

            let real_nav = std::env::var("INTERNAL_REAL_NAV")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(true);

            // futures_master.json에서 종목명 로드
            let (names, _, _, _) = load_futures_master();

            info!("Internal subscriptions: {:?} (real_nav={real_nav}), names: {} entries",
                subscribe_codes, names.len());

            let feed = InternalFeed::new(ws_url, subscribe_codes, names, real_nav);
            tokio::spawn(async move {
                feed.run(tx, sub_rx, feed_cancel).await;
            });
        }
        _ => {
            // Mock 모드 (기본)
            let feed = MockFeed;
            tokio::spawn(async move {
                feed.run(tx, sub_rx, feed_cancel).await;
            });
        }
    }

    // mpsc → broadcast 브릿지: 메시지를 JSON 직렬화 후 브로드캐스트
    let bc = broadcaster.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => bc.send(Arc::from(json)),  // 소유권 이동, 복사 없음
                Err(e) => tracing::error!("JSON serialization error: {}", e),
            }
        }
    });

    // CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let state = AppState {
        broadcaster,
        sub_tx,
        feed_mode: Arc::from(mode.as_str()),
    };

    // 라우터
    let app = Router::new()
        .route("/ws/market", get(ws_market))
        .route("/health", get(health))
        .route("/mode", get(get_mode))
        .route("/subscribe", post(subscribe))
        .route("/unsubscribe", post(unsubscribe))
        .with_state(state)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{PORT}"))
        .await
        .expect("Failed to bind port");

    info!("Rust realtime service listening on port {PORT}");

    // Graceful shutdown: Ctrl+C → cancel feed → drain connections
    let shutdown_cancel = cancel.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::signal::ctrl_c().await.ok();
            info!("Shutting down...");
            shutdown_cancel.cancel();
        })
        .await
        .expect("Server error");
}

async fn health() -> &'static str {
    "ok"
}

async fn get_mode(State(state): State<AppState>) -> String {
    state.feed_mode.to_string()
}

/// futures_master.json에서 종목명 매핑, 현물 코드 Set, 선물→현물 매핑, 코스닥 코드를 로드.
fn load_futures_master() -> (HashMap<String, String>, HashSet<String>, HashMap<String, String>, HashSet<String>) {
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

                // 코스닥 구분
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

    info!("Loaded futures master: {} names, {} stock codes, {} futures→spot, {} kosdaq",
        names.len(), stock_codes.len(), futures_to_spot.len(), kosdaq_codes.len());
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
    let _ = state.sub_tx.send(SubCommand::Subscribe(req.codes));
    Json(serde_json::json!({"status": "ok", "subscribed": count}))
}

async fn unsubscribe(
    State(state): State<AppState>,
    Json(req): Json<SubRequest>,
) -> Json<serde_json::Value> {
    let count = req.codes.len();
    info!("REST unsubscribe: {} codes", count);
    let _ = state.sub_tx.send(SubCommand::Unsubscribe(req.codes));
    Json(serde_json::json!({"status": "ok", "unsubscribed": count}))
}
