//! stat-arb-engine — 통계 차익거래 엔진.
//!
//! port 8300. realtime(8200)과 분리된 별도 binary.
//! 자세한 설계는 ../stat-arb-engine.md 참조.

mod data;
mod holidays;
mod phase;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::Method;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use sqlx::PgPool;
use tokio::signal;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use data::bars::{AssetType, SeriesCache};

const PORT: u16 = 8300;

/// 런타임 카운터. realtime의 Stats 패턴 차용 — `/debug/stats`로 노출.
#[derive(Default)]
pub struct EngineStats {
    /// 통계량 갱신 사이클 횟수
    pub recompute_cycles: AtomicU64,
    /// 후보 풀 재발굴 횟수
    pub discovery_runs: AtomicU64,
    /// 발굴된 페어 총 개수 (마지막 사이클 기준)
    pub pairs_total: AtomicU64,
    /// PG 쿼리 호출 횟수
    pub pg_queries: AtomicU64,
    /// realtime 스냅샷 fetch 호출 횟수
    pub realtime_fetches: AtomicU64,
    started: std::sync::OnceLock<Instant>,
}

#[derive(Clone)]
struct AppState {
    pg: Option<PgPool>,
    cache: SeriesCache,
    stats: Arc<EngineStats>,
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    port: u16,
    phase: String,
    pg_connected: bool,
    uptime_secs: u64,
}

#[derive(Serialize)]
struct StatsResp {
    uptime_secs: u64,
    phase: String,
    pg_connected: bool,
    recompute_cycles: u64,
    discovery_runs: u64,
    pairs_total: u64,
    pg_queries: u64,
    realtime_fetches: u64,
    /// 시계열 캐시: 자산 종목 수
    cache_series: usize,
    /// 시계열 캐시: 모든 자산의 bar 총합 (30s+1m+1d)
    cache_bars_total: usize,
}

async fn health(State(state): State<AppState>) -> Json<Health> {
    let uptime = state
        .stats
        .started
        .get()
        .map(|s| s.elapsed().as_secs())
        .unwrap_or(0);
    Json(Health {
        status: "ok",
        port: PORT,
        phase: phase::current().to_string(),
        pg_connected: state.pg.is_some(),
        uptime_secs: uptime,
    })
}

async fn debug_stats(State(state): State<AppState>) -> Json<StatsResp> {
    let uptime = state
        .stats
        .started
        .get()
        .map(|s| s.elapsed().as_secs())
        .unwrap_or(0);
    let cache_series = state.cache.len();
    let cache_bars_total: usize = state
        .cache
        .iter()
        .map(|e| e.bars_30s.len() + e.bars_1m.len() + e.bars_1d.len())
        .sum();
    Json(StatsResp {
        uptime_secs: uptime,
        phase: phase::current().to_string(),
        pg_connected: state.pg.is_some(),
        recompute_cycles: state.stats.recompute_cycles.load(Ordering::Relaxed),
        discovery_runs: state.stats.discovery_runs.load(Ordering::Relaxed),
        pairs_total: state.stats.pairs_total.load(Ordering::Relaxed),
        pg_queries: state.stats.pg_queries.load(Ordering::Relaxed),
        realtime_fetches: state.stats.realtime_fetches.load(Ordering::Relaxed),
        cache_series,
        cache_bars_total,
    })
}

#[tokio::main]
async fn main() {
    // .env 파일 로드 (있으면). 없어도 OK — 환경변수로 직접 받을 수 있음.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();

    info!("stat-arb-engine starting on port {PORT}");
    info!("startup phase: {}", phase::current());

    let stats = Arc::new(EngineStats::default());
    stats.started.set(Instant::now()).ok();

    // PG 연결. 실패해도 서비스는 기동 (헬스체크에 pg_connected=false 노출).
    let pg = match data::pg_loader::connect().await {
        Ok(pool) => match data::pg_loader::ping(&pool).await {
            Ok(_) => {
                info!("PG 연결 OK (korea_stock_data)");
                Some(pool)
            }
            Err(e) => {
                warn!("PG ping 실패: {e} — DB 없이 기동");
                None
            }
        },
        Err(e) => {
            warn!("PG 연결 실패: {e} — DB 없이 기동");
            None
        }
    };

    let cancel = CancellationToken::new();
    phase::spawn_watchdog(cancel.clone());

    let cache = data::bars::new_cache();

    // 초기 워밍업 — 백그라운드. 서버는 즉시 응답 가능.
    // PR2 검증용 소규모 로드: 삼성전자(005930) + KOSPI200 ETF(069500) + KOSPI200 지수.
    // 본격 universe 로딩은 PR3에서.
    if let Some(pool) = pg.clone() {
        let cache_clone = cache.clone();
        let stats_clone = stats.clone();
        tokio::spawn(async move {
            initial_warmup(&pool, &cache_clone, &stats_clone).await;
        });
    }

    let app_state = AppState {
        pg,
        cache,
        stats: stats.clone(),
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any)
        .allow_origin(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/debug/stats", get(debug_stats))
        .layer(cors)
        .with_state(app_state);

    let addr = format!("0.0.0.0:{PORT}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind failed");

    info!("listening on {addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(cancel))
        .await
        .expect("server error");
}

/// PR2 검증용 초기 워밍업. 본격 universe는 PR3.
async fn initial_warmup(pool: &PgPool, cache: &SeriesCache, stats: &Arc<EngineStats>) {
    let t0 = Instant::now();
    let targets: &[(&str, AssetType)] = &[
        ("005930", AssetType::Stock),     // 삼성전자
        ("069500", AssetType::Etf),       // KODEX 200
        ("K2G01P", AssetType::Index),     // 코스피 200 지수
    ];
    let mut total_bars = 0usize;
    for (code, asset_type) in targets {
        match data::bars::warmup_one(pool, cache, code, *asset_type, 90).await {
            Ok(n) => {
                stats.pg_queries.fetch_add(3, Ordering::Relaxed);
                total_bars += n;
                info!("[warmup] {code} ({}): {n} bars", asset_type.as_str());
            }
            Err(e) => warn!("[warmup] {code} 실패: {e}"),
        }
    }
    info!(
        "[warmup] 완료 — {} series, {} bars total, {:.1}초",
        cache.len(),
        total_bars,
        t0.elapsed().as_secs_f64()
    );
}

async fn shutdown_signal(cancel: CancellationToken) {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("ctrl_c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }

    info!("shutdown signal — cancelling tasks");
    cancel.cancel();
}
