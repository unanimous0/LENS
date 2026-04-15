mod feed;
mod model;
mod ws;

use std::sync::Arc;

use axum::http::Method;
use axum::routing::get;
use axum::Router;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use feed::mock::MockFeed;
use feed::MarketFeed;
use ws::broadcast::Broadcaster;
use ws::handler::ws_market;

const PORT: u16 = 8200;
const BROADCAST_CAPACITY: usize = 4096;

#[tokio::main]
async fn main() {
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
    let feed = MockFeed;
    let feed_cancel = cancel.clone();
    tokio::spawn(async move {
        feed.run(tx, feed_cancel).await;
    });

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
