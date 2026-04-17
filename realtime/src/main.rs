mod feed;
mod model;
mod ws;

use std::collections::HashMap;
use std::sync::Arc;

use axum::http::Method;
use axum::routing::get;
use axum::Router;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use feed::internal::InternalFeed;
use feed::ls_api::LsApiFeed;
use feed::mock::MockFeed;
use feed::MarketFeed;
use ws::broadcast::Broadcaster;
use ws::handler::ws_market;

const PORT: u16 = 8200;
const BROADCAST_CAPACITY: usize = 4096;

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
    let (tx, mut rx) = mpsc::channel(256);
    let feed_cancel = cancel.clone();

    // 모드 선택: FEED_MODE 환경변수 (mock / ls_api)
    let mode = std::env::var("FEED_MODE").unwrap_or_else(|_| "mock".to_string());
    info!("Feed mode: {mode}");

    match mode.as_str() {
        "ls_api" => {
            let app_key = std::env::var("LS_APP_KEY").expect("LS_APP_KEY not set");
            let app_secret = std::env::var("LS_APP_SECRET").expect("LS_APP_SECRET not set");

            // 기본 구독 종목 (환경변수 또는 기본값)
            let subs_str = std::env::var("LS_SUBSCRIPTIONS").unwrap_or_else(|_| {
                "S3_:005930,S3_:069500".to_string()
            });

            let subscriptions: Vec<(String, String)> = subs_str
                .split(',')
                .filter_map(|s| {
                    let parts: Vec<&str> = s.trim().split(':').collect();
                    if parts.len() == 2 {
                        Some((parts[0].to_string(), parts[1].to_string()))
                    } else {
                        None
                    }
                })
                .collect();

            // 종목명 매핑 (TODO: REST API로 조회하여 자동 설정)
            let mut names = HashMap::new();
            names.insert("005930".to_string(), "삼성전자".to_string());
            names.insert("069500".to_string(), "KODEX 200".to_string());
            names.insert("A1165000".to_string(), "삼성전자 F 근월".to_string());

            info!("LS API subscriptions: {:?}", subscriptions);

            let feed = LsApiFeed::new(app_key, app_secret, subscriptions, names);
            tokio::spawn(async move {
                feed.run(tx, feed_cancel).await;
            });
        }
        "internal" => {
            let ws_url = std::env::var("INTERNAL_WS_URL")
                .unwrap_or_else(|_| "ws://10.21.1.208:41001".to_string());

            // 구독 종목: "A005930,A069500,KA1165000" (내부망 형식)
            // 또는 사용자 입력 형식도 OK: "005930,069500,A1165000"
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

            // 종목명 매핑 (TODO: 자동 조회)
            let mut names = HashMap::new();
            names.insert("005930".to_string(), "삼성전자".to_string());
            names.insert("069500".to_string(), "KODEX 200".to_string());
            names.insert("364980".to_string(), "KODEX K-반도체".to_string());
            names.insert("A1165000".to_string(), "삼성전자 F 근월".to_string());
            names.insert("A0166000".to_string(), "코스닥150 F 근월".to_string());

            info!("Internal subscriptions: {:?} (real_nav={real_nav})", subscribe_codes);

            let feed = InternalFeed::new(ws_url, subscribe_codes, names, real_nav);
            tokio::spawn(async move {
                feed.run(tx, feed_cancel).await;
            });
        }
        _ => {
            // Mock 모드 (기본)
            let feed = MockFeed;
            tokio::spawn(async move {
                feed.run(tx, feed_cancel).await;
            });
        }
    }

    // mpsc → broadcast 브릿지: 메시지를 JSON 직렬화 후 브로드캐스트
    let bc = broadcaster.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(json) => bc.send(Arc::from(json.as_str())),
                Err(e) => tracing::error!("JSON serialization error: {}", e),
            }
        }
    });

    // CORS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    // 라우터
    let app = Router::new()
        .route("/ws/market", get(ws_market))
        .route("/health", get(health))
        .with_state(broadcaster)
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
