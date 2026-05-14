//! stat-arb-engine — 통계 차익거래 엔진.
//!
//! port 8300. realtime(8200)과 분리된 별도 binary.
//! 자세한 설계는 ../stat-arb-engine.md 참조.

mod data;
mod discovery;
mod groups;
mod holidays;
mod phase;
mod stats;
mod universe;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
use groups::Group;

const PORT: u16 = 8300;

/// 일봉 워밍업 길이 (캘린더일). 1년 ≈ 252영업일 = 365캘린더일.
const WARMUP_DAYS_DAILY: i32 = 365;
/// 1분봉 워밍업 길이 (캘린더일). 너무 길면 메모리 큼 — 14일치면 약 영업일 10일 = 3,900 bar/종목.
const WARMUP_DAYS_1M: i32 = 14;

/// 통계량 재계산 cron 주기. 10분 — 분봉 한두 개 들어오는 단위.
/// 환경변수 `STATARB_RECOMPUTE_SECS` 로 오버라이드 (시연/테스트용).
fn recompute_interval() -> Duration {
    std::env::var("STATARB_RECOMPUTE_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(10 * 60))
}

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

/// 자동 생성된 도메인 그룹 + id → Group 룩업.
#[derive(Default)]
pub struct GroupsState {
    pub groups: Vec<Group>,
    pub by_id: HashMap<String, usize>, // id → groups index
    pub last_run_ms: i64,
}

#[derive(Clone)]
struct AppState {
    pg: Option<PgPool>,
    cache: SeriesCache,
    pairs: Arc<RwLock<PairsState>>,
    groups: Arc<RwLock<GroupsState>>,
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
    groups_total: usize,
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
    let groups_total = state.groups.read().await.groups.len();
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
        groups_total,
    })
}

#[derive(Deserialize)]
struct PairsQuery {
    /// 반환할 최대 페어 수. 디폴트 100.
    #[serde(default = "default_limit")]
    limit: usize,
    /// 도메인 그룹 id 필터 (예: `index:KOSPI200`, `sector:화학`, `etf:069500`).
    /// 멤버 둘 다 그룹에 속하는 페어만 반환.
    group: Option<String>,
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
    /// 그룹 필터링 후 매칭된 페어 수 (필터 없으면 total과 동일).
    filtered: usize,
    pairs: Vec<PairResult>,
}

async fn list_pairs(State(state): State<AppState>, Query(q): Query<PairsQuery>) -> Json<PairsResp> {
    let s = state.pairs.read().await;
    let group_members: Option<HashSet<String>> = if let Some(gid) = q.group.as_ref() {
        let gs = state.groups.read().await;
        gs.by_id
            .get(gid)
            .and_then(|i| gs.groups.get(*i))
            .map(|g| g.members.iter().cloned().collect())
    } else {
        None
    };

    let filtered: Vec<PairResult> = match &group_members {
        Some(members) => s
            .pairs
            .iter()
            .filter(|p| members.contains(&p.left_key) && members.contains(&p.right_key))
            .cloned()
            .collect(),
        None => s.pairs.clone(),
    };

    let returned = filtered.iter().take(q.limit).cloned().collect::<Vec<_>>();
    Json(PairsResp {
        total: s.pairs.len(),
        returned: returned.len(),
        last_run_ms: s.last_run_ms,
        last_run_duration_ms: s.last_run_duration_ms,
        filtered: filtered.len(),
        pairs: returned,
    })
}

#[derive(Deserialize)]
struct GroupsQuery {
    /// kind 필터 (index/sector/etf). 미지정 시 전체.
    kind: Option<String>,
    /// members 배열을 응답에 포함할지 (디폴트 false — 리스트 페이지 가벼움).
    #[serde(default)]
    with_members: bool,
}

#[derive(Serialize)]
struct GroupSummary {
    id: String,
    name: String,
    kind: String,
    member_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    members: Option<Vec<String>>,
}

#[derive(Serialize)]
struct GroupsResp {
    total: usize,
    last_run_ms: i64,
    groups: Vec<GroupSummary>,
}

async fn list_groups(
    State(state): State<AppState>,
    Query(q): Query<GroupsQuery>,
) -> Json<GroupsResp> {
    let s = state.groups.read().await;
    let mut out: Vec<GroupSummary> = s
        .groups
        .iter()
        .filter(|g| q.kind.as_deref().map_or(true, |k| g.kind.as_str() == k))
        .map(|g| GroupSummary {
            id: g.id.clone(),
            name: g.name.clone(),
            kind: g.kind.as_str().to_string(),
            member_count: g.member_count,
            members: if q.with_members {
                Some(g.members.clone())
            } else {
                None
            },
        })
        .collect();
    // index → sector → etf 순, 각 종류 안에선 멤버 많은 순.
    out.sort_by(|a, b| a.kind.cmp(&b.kind).then(b.member_count.cmp(&a.member_count)));
    Json(GroupsResp {
        total: out.len(),
        last_run_ms: s.last_run_ms,
        groups: out,
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
    let groups_state = Arc::new(RwLock::new(GroupsState::default()));

    // 백그라운드: 그룹 자동 생성 + 초기 발굴 + 10분 cron 재발굴 루프.
    if let Some(pool) = pg.clone() {
        let cache_clone = cache.clone();
        let pairs_clone = pairs.clone();
        let groups_clone = groups_state.clone();
        let stats_clone = engine_stats.clone();
        let cancel_clone = cancel.clone();
        tokio::spawn(async move {
            spawn_recompute_loop(
                pool,
                cache_clone,
                pairs_clone,
                groups_clone,
                stats_clone,
                cancel_clone,
            )
            .await;
        });
    }

    let app_state = AppState {
        pg,
        cache,
        pairs,
        groups: groups_state,
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
        .route("/groups", get(list_groups))
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

/// 백그라운드 루프 — 기동 직후 초기 발굴 1회, 그 후 RECOMPUTE_INTERVAL 마다 재발굴.
/// Phase가 Sleep 시 wait_until_active로 대기. 다음 영업일 08:30에 자동 깨어남.
async fn spawn_recompute_loop(
    pool: PgPool,
    cache: SeriesCache,
    pairs: Arc<RwLock<PairsState>>,
    groups: Arc<RwLock<GroupsState>>,
    stats: Arc<EngineStats>,
    cancel: CancellationToken,
) {
    let interval = recompute_interval();
    info!(
        "[scheduler] recompute interval = {}초",
        interval.as_secs()
    );

    // 초기 1회 — Sleep phase 여도 첫 데이터는 채워둠 (장 외 시간 시작 시 빈 화면 방지).
    load_groups(&pool, &groups, &stats).await;
    warmup_and_discover(&pool, &cache, &pairs, &stats).await;

    // 메인 루프
    loop {
        // 다음 cycle 까지 대기 (또는 cancel)
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = cancel.cancelled() => {
                info!("[scheduler] cancelled");
                return;
            }
        }

        // Sleep phase면 활성화될 때까지 대기 — 야간엔 분봉 안 들어오니까 재발굴 의미 없음.
        if !phase::wait_until_active(&cancel, "recompute").await {
            return; // cancelled during wait
        }

        warmup_and_discover(&pool, &cache, &pairs, &stats).await;
        stats.recompute_cycles.fetch_add(1, Ordering::Relaxed);
    }
}

/// 도메인 그룹 (index/sector/etf) 자동 생성. PG 3 쿼리 (try_join).
async fn load_groups(
    pool: &PgPool,
    groups: &Arc<RwLock<GroupsState>>,
    stats: &Arc<EngineStats>,
) {
    let t = Instant::now();
    match groups::load_all_groups(pool).await {
        Ok(all) => {
            stats.pg_queries.fetch_add(3, Ordering::Relaxed);
            let by_id: HashMap<String, usize> = all
                .iter()
                .enumerate()
                .map(|(i, g)| (g.id.clone(), i))
                .collect();
            let n = all.len();
            let now_ms = chrono::Utc::now().timestamp_millis();
            {
                let mut s = groups.write().await;
                s.groups = all;
                s.by_id = by_id;
                s.last_run_ms = now_ms;
            }
            info!(
                "[groups] 완료 — {} 그룹, {:.1}초",
                n,
                t.elapsed().as_secs_f64()
            );
        }
        Err(e) => warn!("[groups] 로딩 실패: {e}"),
    }
}

/// ETF universe 상위 N개 (1개월 평균 거래대금 내림차순).
const ETF_TOP_N: i32 = 100;

/// universe 워밍업 + 1:1 발굴.
/// PR5: KOSPI200 + KOSDAQ150 주식 + ETF + 주요 지수 통합.
async fn warmup_and_discover(
    pool: &PgPool,
    cache: &SeriesCache,
    pairs: &Arc<RwLock<PairsState>>,
    stats: &Arc<EngineStats>,
) {
    let t_total = Instant::now();

    // 1. universe 추출
    let universe = match universe::load_full(pool, ETF_TOP_N).await {
        Ok(u) => u,
        Err(e) => {
            warn!("[universe] 로딩 실패: {e}");
            return;
        }
    };
    info!(
        "[universe] KOSPI200 {} + KOSDAQ150 {} + ETF {} + Index {} = total {}",
        universe.stocks_kospi200.len(),
        universe.stocks_kosdaq150.len(),
        universe.etfs.len(),
        universe.indices.len(),
        universe.total_count()
    );

    // 2. 자산군별 batch 워밍업
    let t_warm = Instant::now();

    // Stock: KOSPI200 + KOSDAQ150 합쳐서 한 batch
    let mut stock_codes: Vec<String> = Vec::with_capacity(
        universe.stocks_kospi200.len() + universe.stocks_kosdaq150.len(),
    );
    stock_codes.extend(universe.stocks_kospi200.iter().map(|s| s.code.clone()));
    stock_codes.extend(universe.stocks_kosdaq150.iter().map(|s| s.code.clone()));

    let etf_codes: Vec<String> = universe.etfs.iter().map(|e| e.code.clone()).collect();
    let index_codes: Vec<String> = universe.indices.iter().map(|i| i.code.clone()).collect();

    let (stock_n, stock_b) = data::bars::warmup_universe_stocks_batch(
        pool,
        cache,
        &stock_codes,
        AssetType::Stock,
        WARMUP_DAYS_DAILY,
        WARMUP_DAYS_1M,
    )
    .await
    .unwrap_or_else(|e| {
        warn!("[warmup] Stock 실패: {e}");
        (0, 0)
    });

    let (etf_n, etf_b) = data::bars::warmup_universe_stocks_batch(
        pool,
        cache,
        &etf_codes,
        AssetType::Etf,
        WARMUP_DAYS_DAILY,
        WARMUP_DAYS_1M,
    )
    .await
    .unwrap_or_else(|e| {
        warn!("[warmup] ETF 실패: {e}");
        (0, 0)
    });

    let (idx_n, idx_b) = data::bars::warmup_universe_indices_batch(
        pool,
        cache,
        &index_codes,
        WARMUP_DAYS_DAILY,
        WARMUP_DAYS_1M,
    )
    .await
    .unwrap_or_else(|e| {
        warn!("[warmup] Index 실패: {e}");
        (0, 0)
    });

    let total_series = stock_n + etf_n + idx_n;
    let total_bars = stock_b + etf_b + idx_b;
    stats.pg_queries.fetch_add(6, Ordering::Relaxed); // 3자산군 × 2 (daily+1m)
    info!(
        "[warmup] Stock {}series/{}b · ETF {}/{}  · Index {}/{}  = total {}/{} ({:.1}초)",
        stock_n,
        stock_b,
        etf_n,
        etf_b,
        idx_n,
        idx_b,
        total_series,
        total_bars,
        t_warm.elapsed().as_secs_f64()
    );

    // 3. 종목명 룩업 — 모든 자산군 통합 (series_key 형식)
    let mut names: HashMap<String, String> = HashMap::with_capacity(total_series);
    for s in &universe.stocks_kospi200 {
        names.insert(series_key(AssetType::Stock, &s.code), s.name.clone());
    }
    for s in &universe.stocks_kosdaq150 {
        names.insert(series_key(AssetType::Stock, &s.code), s.name.clone());
    }
    for e in &universe.etfs {
        names.insert(series_key(AssetType::Etf, &e.code), e.name.clone());
    }
    for i in &universe.indices {
        names.insert(series_key(AssetType::Index, &i.code), i.name.clone());
    }

    // 4. 1:1 발굴
    let t_disc = Instant::now();
    let result = discovery::discover_all_one_to_one(cache, &names);
    let disc_ms = t_disc.elapsed().as_millis() as u64;
    stats.discovery_runs.fetch_add(1, Ordering::Relaxed);
    stats.pairs_total.store(result.len() as u64, Ordering::Relaxed);

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
