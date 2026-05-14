//! stat-arb-engine — 통계 차익거래 엔진.
//!
//! port 8300. realtime(8200)과 분리된 별도 binary.
//! 자세한 설계는 ../stat-arb-engine.md 참조.

mod data;
mod discovery;
mod holidays;
mod phase;
mod stats;
mod universe;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{Query, State};
use axum::http::Method;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::signal;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use data::bars::{series_key, AssetType, SeriesCache};
use discovery::PairResult;

const PORT: u16 = 8300;

/// 일봉 워밍업 길이 (캘린더일). 1년 ≈ 252영업일 = 365캘린더일.
const WARMUP_DAYS_DAILY: i32 = 365;
/// 1분봉 워밍업 길이 (캘린더일). 너무 길면 메모리 큼 — 14일치면 약 영업일 10일 = 3,900 bar/종목.
const WARMUP_DAYS_1M: i32 = 14;

/// 런타임 카운터. realtime의 Stats 패턴 차용 — `/debug/stats`로 노출.
#[derive(Default)]
pub struct EngineStats {
    pub recompute_cycles: AtomicU64,
    pub discovery_runs: AtomicU64,
    pub pairs_total: AtomicU64,
    pub pg_queries: AtomicU64,
    pub realtime_fetches: AtomicU64,
    started: std::sync::OnceLock<Instant>,
}

/// 발굴된 1:1 페어 + 종목명 룩업 테이블 (key → 표시명).
#[derive(Default)]
pub struct PairsState {
    pub pairs: Vec<PairResult>,
    pub names: HashMap<String, String>,
    pub last_run_ms: i64,
    pub last_run_duration_ms: u64,
}

#[derive(Clone)]
struct AppState {
    pg: Option<PgPool>,
    cache: SeriesCache,
    pairs: Arc<RwLock<PairsState>>,
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
    cache_series: usize,
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

#[derive(Deserialize)]
struct PairsQuery {
    /// 반환할 최대 페어 수. 디폴트 100.
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    100
}

#[derive(Serialize)]
struct PairsResp {
    total: usize,
    returned: usize,
    last_run_ms: i64,
    last_run_duration_ms: u64,
    pairs: Vec<PairResult>,
}

async fn list_pairs(State(state): State<AppState>, Query(q): Query<PairsQuery>) -> Json<PairsResp> {
    let s = state.pairs.read().await;
    let returned = s.pairs.iter().take(q.limit).cloned().collect::<Vec<_>>();
    Json(PairsResp {
        total: s.pairs.len(),
        returned: returned.len(),
        last_run_ms: s.last_run_ms,
        last_run_duration_ms: s.last_run_duration_ms,
        pairs: returned,
    })
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();

    info!("stat-arb-engine starting on port {PORT}");
    info!("startup phase: {}", phase::current());

    let engine_stats = Arc::new(EngineStats::default());
    engine_stats.started.set(Instant::now()).ok();

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
    let pairs = Arc::new(RwLock::new(PairsState::default()));

    // 백그라운드: universe 워밍업 + 1:1 발굴. 서버는 즉시 응답 가능.
    if let Some(pool) = pg.clone() {
        let cache_clone = cache.clone();
        let pairs_clone = pairs.clone();
        let stats_clone = engine_stats.clone();
        tokio::spawn(async move {
            warmup_and_discover(&pool, &cache_clone, &pairs_clone, &stats_clone).await;
        });
    }

    let app_state = AppState {
        pg,
        cache,
        pairs,
        stats: engine_stats.clone(),
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers(Any)
        .allow_origin(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/debug/stats", get(debug_stats))
        .route("/pairs", get(list_pairs))
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

/// universe 워밍업 + 1:1 발굴.
/// PR3: KOSPI200 구성종목 일봉 90일.
async fn warmup_and_discover(
    pool: &PgPool,
    cache: &SeriesCache,
    pairs: &Arc<RwLock<PairsState>>,
    stats: &Arc<EngineStats>,
) {
    let t_total = Instant::now();

    // 1. universe 추출
    let universe = match universe::load_kospi200(pool).await {
        Ok(v) => v,
        Err(e) => {
            warn!("[universe] KOSPI200 로딩 실패: {e}");
            return;
        }
    };
    info!("[universe] KOSPI200 {} 종목", universe.len());

    // 2. Batch 워밍업 — universe 전체를 일봉 1쿼리 + 1분봉 1쿼리로.
    // TimescaleDB hypertable이라 cutoff 고정 date가 plan-time chunk pruning 가능 — out of shared memory 방지.
    let t_warm = Instant::now();
    let codes: Vec<String> = universe.iter().map(|s| s.code.clone()).collect();
    let (series_n, total_bars) = match data::bars::warmup_universe_stocks_batch(
        pool,
        cache,
        &codes,
        AssetType::Stock,
        WARMUP_DAYS_DAILY,
        WARMUP_DAYS_1M,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            warn!("[warmup] batch 로딩 실패: {e}");
            return;
        }
    };
    stats.pg_queries.fetch_add(2, Ordering::Relaxed); // daily + 1m
    info!(
        "[warmup] 완료 — {} series, {} bars total, {:.1}초 (batch 2 query)",
        series_n,
        total_bars,
        t_warm.elapsed().as_secs_f64()
    );

    // 3. 종목명 룩업
    let names: HashMap<String, String> = universe
        .iter()
        .map(|s| (series_key(AssetType::Stock, &s.code), s.name.clone()))
        .collect();

    // 4. 1:1 발굴
    let t_disc = Instant::now();
    let result = discovery::discover_all_one_to_one(cache, &names);
    let disc_ms = t_disc.elapsed().as_millis() as u64;
    stats.discovery_runs.fetch_add(1, Ordering::Relaxed);
    stats.pairs_total.store(result.len() as u64, Ordering::Relaxed);

    // 5. 상태 저장
    {
        let mut s = pairs.write().await;
        s.pairs = result;
        s.names = names;
        s.last_run_ms = chrono::Utc::now().timestamp_millis();
        s.last_run_duration_ms = disc_ms;
    }

    info!(
        "[전체] 완료 {:.1}초 (warmup + discovery)",
        t_total.elapsed().as_secs_f64()
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
