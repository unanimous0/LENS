//! t8402/t1102 REST로 초기 가격을 조회하여 틱으로 발행.
//! WebSocket 구독과 동시에 실행 — 실시간 체결이 먼저 오면 초기값은 프론트에서 무시.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;

use tokio::sync::{mpsc, Mutex as TokioMutex};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, StockTick, FuturesTick, VolumeTick};
use crate::Stats;

/// LS OpenAPI 에러 메시지 분류.
/// - no_data: rsp_msg가 "데이터 없음" 계열 (상장폐지/체결이력 없는 스프레드 등) — 정상 꼬리
/// - http_5xx: 서버 장애
/// - tps: TPS 한도 초과 (429/rate)
/// - other: 네트워크/파싱/미분류
fn classify_error(msg: &str) -> &'static str {
    let lc = msg.to_lowercase();
    if msg.contains("없") || lc.contains("no data") {
        "no_data"
    } else if lc.contains("http 5") || lc.contains("timeout") {
        "http_5xx"
    } else if msg.contains("429") || msg.contains("초과") || lc.contains("tps") || lc.contains("rate limit") {
        "tps"
    } else {
        "other"
    }
}

fn bump_fail(stats: &Stats, kind: &str) {
    match kind {
        "no_data" => stats.fetch_no_data.fetch_add(1, Ordering::Relaxed),
        "http_5xx" => stats.fetch_http_5xx.fetch_add(1, Ordering::Relaxed),
        "tps" => stats.fetch_tps.fetch_add(1, Ordering::Relaxed),
        _ => stats.fetch_other.fetch_add(1, Ordering::Relaxed),
    };
}

/// t1102 실패 코드 1건의 상태. 백그라운드 retry worker가 사용.
#[derive(Clone)]
pub struct FailedT1102 {
    pub last_error: String,
    pub error_kind: &'static str,
    pub attempt_count: u32,
}

const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const T8402_URL: &str = "https://openapi.ls-sec.co.kr:8080/futureoption/market-data";
const T1102_URL: &str = "https://openapi.ls-sec.co.kr:8080/stock/market-data";
const STOCK_CHART_URL: &str = "https://openapi.ls-sec.co.kr:8080/stock/chart";

/// Z+X 키 풀 (2026-05-20). 두 LS 계정(아버지/와이프)의 키를 각 역할별로 분리.
/// WS는 키A 영구. REST는 09:00~15:45 KST는 키B, 그 외는 키A.
#[derive(Clone)]
pub struct KeyPool {
    pub key_a: String,    // 아버지 계좌 — LENS WS 영구
    pub secret_a: String,
    pub key_b: String,    // 와이프 계좌 — 09:00~15:45 LENS REST / 그외 FD
    pub secret_b: String,
}

impl KeyPool {
    /// 환경변수에서 읽기. LS_APP_KEY_A/B 필수.
    pub fn from_env() -> Self {
        let key_a = std::env::var("LS_APP_KEY_A").unwrap_or_default();
        let secret_a = std::env::var("LS_APP_SECRET_A").unwrap_or_default();
        let key_b = std::env::var("LS_APP_KEY_B").unwrap_or_default();
        let secret_b = std::env::var("LS_APP_SECRET_B").unwrap_or_default();
        Self { key_a, secret_a, key_b, secret_b }
    }
}

static KEY_POOL: OnceLock<KeyPool> = OnceLock::new();

pub fn init_key_pool(pool: KeyPool) {
    let _ = KEY_POOL.set(pool);
}

fn key_pool() -> Option<&'static KeyPool> {
    KEY_POOL.get()
}

/// 09:00~15:45 KST면 true — LENS가 키B로 REST 호출하는 시간대.
/// 그 외는 키A 사용 (Finance_Data가 키B 점유 가능 시간대라 충돌 회피).
pub fn is_lens_rest_window_now() -> bool {
    use chrono::{Local, Timelike};
    let now = Local::now();
    let mins = (now.hour() * 60 + now.minute()) as i32;
    (9 * 60) <= mins && mins < (15 * 60 + 45)
}

/// REST 호출 시점에 시간대 보고 (key, secret) 반환. Z+X 정책 단일 진실원.
/// 호출자(ls_api.rs)는 이 helper만 사용하면 시간대 분기 자동.
pub fn rest_credentials() -> (String, String) {
    if let Some(p) = key_pool() {
        if is_lens_rest_window_now() {
            return (p.key_b.clone(), p.secret_b.clone());
        }
        return (p.key_a.clone(), p.secret_a.clone());
    }
    // KeyPool 초기화 안 됨 (테스트/오류 케이스) — 환경변수 직접 fallback
    (
        std::env::var("LS_APP_KEY_A").unwrap_or_default(),
        std::env::var("LS_APP_SECRET_A").unwrap_or_default(),
    )
}

/// 키B(와이프 계좌) credential을 명시적으로 반환 — WS 부하 분산용(2026-06-12).
/// 키A WS가 한 계정 한계(연결/구독)를 넘어 LS가 TLS 세션을 강제 종료(SSL shutdown) →
/// 호가 stall + 30초 재연결. ETF 화면의 무거운 스트림(iNAV I5_ / 호가 H1_)을 별도 계정인
/// 키B WS로 옮겨 각자 독립 한계를 받게 한다. 단 키B는 09:00~15:45만 LENS 소유라
/// (15:50~ Finance_Data) 호출부가 `is_lens_rest_window_now()`로 윈도우를 게이트해야 함.
/// 키B 미설정(LS_APP_KEY_B 빈값)이면 None → 호출부가 키A로 폴백.
pub fn ws_key_b_credentials() -> Option<(String, String)> {
    let p = key_pool()?;
    if p.key_b.is_empty() || p.secret_b.is_empty() {
        return None;
    }
    Some((p.key_b.clone(), p.secret_b.clone()))
}

/// LS OAuth 토큰 TTL — 실제 24시간이지만 1시간 마진 두고 23시간 후 갱신.
/// 매 WS 재연결마다 토큰 받지 않게 프로세스 단위로 캐시.
const TOKEN_TTL: Duration = Duration::from_secs(23 * 3600);

struct CachedToken {
    token: String,
    fetched_at: Instant,
}

/// 토큰 캐시 — app_key 별로 별도 저장 (Z+X 키 배분, 2026-05-20).
/// 키A (아버지 계좌) WS 영구 + 키B (와이프 계좌) 09:00~15:45 REST 추가 사용.
/// 단일 OnceLock<TokioMutex<HashMap<app_key, CachedToken>>>.
static TOKEN_CACHE: OnceLock<TokioMutex<HashMap<String, CachedToken>>> = OnceLock::new();

fn token_cache() -> &'static TokioMutex<HashMap<String, CachedToken>> {
    TOKEN_CACHE.get_or_init(|| TokioMutex::new(HashMap::new()))
}

/// 캐시된 토큰을 반환. TTL 지났으면 새로 발급. 없거나 401 받았을 때
/// `invalidate_token_cache(app_key)` 호출 후 재시도하면 됨.
pub async fn get_or_fetch_token(app_key: &str, app_secret: &str) -> Result<String, String> {
    let cache = token_cache();
    let mut guard = cache.lock().await;

    if let Some(c) = guard.get(app_key) {
        if c.fetched_at.elapsed() < TOKEN_TTL {
            return Ok(c.token.clone());
        }
    }

    // 만료/없음 → 새로 발급
    let new_token = fetch_token(app_key, app_secret).await?;
    let was_present = guard.contains_key(app_key);
    info!(
        "token cache: refreshed key={}*** (was {})",
        &app_key.chars().take(8).collect::<String>(),
        if was_present { "expired" } else { "empty" }
    );
    guard.insert(app_key.to_string(), CachedToken { token: new_token.clone(), fetched_at: Instant::now() });
    Ok(new_token)
}

/// LS가 401 또는 토큰 무효 응답 줄 때 캐시 강제 무효화 (전체).
/// fetch_t1102/t8402/t1405/t1404가 401/403 받으면 호출. 호출자가 *어느 키*였는지
/// 추적 안 해도 안전하게 모든 키 캐시 비움. 다음 get_or_fetch_token이 새 토큰 발급
/// (필요한 키만). 401/403 발생 빈도 낮아 부담 작음.
pub async fn invalidate_token_cache() {
    let mut guard = token_cache().lock().await;
    let n = guard.len();
    guard.clear();
    info!("token cache: invalidated all ({n} entries, 401/403 received)");
}

// ────────────────────────────────────────────────────────────────────────────
// t1405 종목 상태 캐시 — 매매정지(jongchk=2) / 투자경고(=1) / 정리매매(=3)
// ls_api.rs의 spawn 워커가 1시간 주기로 모두 갱신. StockTick 만들 때 참조해 박음.
// ────────────────────────────────────────────────────────────────────────────

static HALTED_STOCKS: OnceLock<DashMap<String, ()>> = OnceLock::new();
static WARNING_STOCKS: OnceLock<DashMap<String, ()>> = OnceLock::new();      // 투자경고
static LIQUIDATION_STOCKS: OnceLock<DashMap<String, ()>> = OnceLock::new();  // 정리매매

fn halted_stocks() -> &'static DashMap<String, ()> { HALTED_STOCKS.get_or_init(DashMap::new) }
fn warning_stocks() -> &'static DashMap<String, ()> { WARNING_STOCKS.get_or_init(DashMap::new) }
fn liquidation_stocks() -> &'static DashMap<String, ()> { LIQUIDATION_STOCKS.get_or_init(DashMap::new) }

/// 종목이 현재 매매정지 상태인지. 호출자(StockTick 발행 경로)는 lock-free.
pub fn is_halted(code: &str) -> bool { halted_stocks().contains_key(code) }
pub fn is_warning(code: &str) -> bool { warning_stocks().contains_key(code) }
pub fn is_liquidation(code: &str) -> bool { liquidation_stocks().contains_key(code) }

/// t1405로 특정 종류(jongchk) 종목 전체 목록을 받아옴. cts_shcode 페이지네이션 처리.
/// gubun=0(전체 시장), jongchk: 1=투자경고, 2=매매정지, 3=정리매매.
async fn fetch_t1405_stocks(token: &str, jongchk: &str) -> Result<HashSet<String>, String> {
    let client = reqwest::Client::new();
    let mut all = HashSet::new();
    let mut cts: String = " ".to_string();
    let mut page = 0u32;
    loop {
        let body = serde_json::json!({
            "t1405InBlock": {"gubun": "0", "jongchk": jongchk, "cts_shcode": cts}
        });
        let tr_cont = if page == 0 { "N" } else { "Y" };
        let resp = client.post(T1102_URL)
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t1405")
            .header("tr_cont", tr_cont)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("http: {e}"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            invalidate_token_cache().await;
            return Err(format!("http {status} (token invalidated)"));
        }
        if !status.is_success() {
            return Err(format!("http {status}"));
        }
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        let out = j["t1405OutBlock1"].as_array().cloned().unwrap_or_default();
        if out.is_empty() { break; }
        for it in &out {
            if let Some(s) = it["shcode"].as_str() {
                all.insert(s.to_string());
            }
        }
        let next_cts = j["t1405OutBlock"]["cts_shcode"]
            .as_str().unwrap_or("").trim().to_string();
        if next_cts.is_empty() || next_cts == cts.trim() { break; }
        cts = next_cts;
        page += 1;
        tokio::time::sleep(Duration::from_millis(1100)).await;  // TPS=1
        if page > 50 { break; }
    }
    Ok(all)
}

fn replace_set(cache: &DashMap<String, ()>, new_set: &HashSet<String>) -> (usize, usize) {
    let old_size = cache.len();
    // 갱신 중 빈 윈도우 회피 — insert 먼저 (중복은 무해), 차집합만 remove.
    // 이전엔 remove → insert 순이라 그 사이 짧게 set이 비어 is_halted() 등이
    // false로 잘못 답할 수 있었음.
    for c in new_set { cache.insert(c.clone(), ()); }
    let to_remove: Vec<String> = cache.iter()
        .filter(|e| !new_set.contains(e.key()))
        .map(|e| e.key().clone())
        .collect();
    for c in to_remove { cache.remove(&c); }
    (old_size, new_set.len())
}

/// 세 카테고리 한 번에 갱신. (halted_old→new, warning_old→new, liquidation_old→new).
/// TPS=1 가드: 페이지네이션 사이 + 카테고리 사이 각각 sleep.
pub async fn update_t1405_sets(token: &str) -> Result<((usize, usize), (usize, usize), (usize, usize)), String> {
    let halted_set = fetch_t1405_stocks(token, "2").await?;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let warning_set = fetch_t1405_stocks(token, "1").await?;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let liquidation_set = fetch_t1405_stocks(token, "3").await?;
    Ok((
        replace_set(halted_stocks(), &halted_set),
        replace_set(warning_stocks(), &warning_set),
        replace_set(liquidation_stocks(), &liquidation_set),
    ))
}

/// 매매정지만 갱신 (기존 호환). 새 코드는 update_t1405_sets 사용 권장.
pub async fn update_halted_set(token: &str) -> Result<(usize, usize), String> {
    let new_set = fetch_t1405_stocks(token, "2").await?;
    Ok(replace_set(halted_stocks(), &new_set))
}

// ────────────────────────────────────────────────────────────────────────────
// 관리종목 캐시 (t1404)
// ────────────────────────────────────────────────────────────────────────────

static UNDER_MANAGEMENT_STOCKS: OnceLock<DashMap<String, ()>> = OnceLock::new();

fn under_management_stocks() -> &'static DashMap<String, ()> {
    UNDER_MANAGEMENT_STOCKS.get_or_init(DashMap::new)
}

pub fn is_under_management(code: &str) -> bool {
    under_management_stocks().contains_key(code)
}

/// t1404 "관리/불성실/투자유의조회" — jongchk=1 (관리종목 추정. PDF 없어 검증 호출 시 결과 확인).
async fn fetch_t1404_stocks(token: &str, jongchk: &str) -> Result<HashSet<String>, String> {
    let client = reqwest::Client::new();
    let mut all = HashSet::new();
    let mut cts: String = " ".to_string();
    let mut page = 0u32;
    loop {
        let body = serde_json::json!({
            "t1404InBlock": {"gubun": "0", "jongchk": jongchk, "cts_shcode": cts}
        });
        let tr_cont = if page == 0 { "N" } else { "Y" };
        let resp = client.post(T1102_URL)
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t1404")
            .header("tr_cont", tr_cont)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("http: {e}"))?;
        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            invalidate_token_cache().await;
            return Err(format!("http {status} (token invalidated)"));
        }
        if !status.is_success() { return Err(format!("http {status}")); }
        let j: serde_json::Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
        let out = j["t1404OutBlock1"].as_array().cloned().unwrap_or_default();
        if out.is_empty() { break; }
        for it in &out {
            if let Some(s) = it["shcode"].as_str() { all.insert(s.to_string()); }
        }
        let next_cts = j["t1404OutBlock"]["cts_shcode"]
            .as_str().unwrap_or("").trim().to_string();
        if next_cts.is_empty() || next_cts == cts.trim() { break; }
        cts = next_cts;
        page += 1;
        tokio::time::sleep(Duration::from_millis(1100)).await;
        if page > 50 { break; }
    }
    Ok(all)
}

pub async fn update_under_management_set(token: &str) -> Result<(usize, usize), String> {
    let new_set = fetch_t1404_stocks(token, "1").await?;
    Ok(replace_set(under_management_stocks(), &new_set))
}

// ────────────────────────────────────────────────────────────────────────────
// VI(변동성완화장치) 발동 종목 캐시
// VI_ 실시간 stream이 vi_gubun "0"(해제) / 그 외(발동) 토글로 갱신.
// ls_api.rs가 직접 set_vi_active(code, active)로 set/clear.
// ────────────────────────────────────────────────────────────────────────────

static VI_ACTIVE_STOCKS: OnceLock<DashMap<String, ()>> = OnceLock::new();

fn vi_active_stocks() -> &'static DashMap<String, ()> {
    VI_ACTIVE_STOCKS.get_or_init(DashMap::new)
}

pub fn is_vi_active(code: &str) -> bool {
    vi_active_stocks().contains_key(code)
}

/// VI 상태 토글. active=true면 set에 추가, false면 제거.
pub fn set_vi_active(code: &str, active: bool) {
    let cache = vi_active_stocks();
    if active {
        cache.insert(code.to_string(), ());
    } else {
        cache.remove(code);
    }
}

/// 구독 목록의 모든 종목에 대해 초기 가격 조회.
/// t8402(선물/스프레드)와 t1102(현물)을 **병렬 태스크**로 동시 실행.
pub async fn fetch_initial_prices(
    app_key: &str,
    app_secret: &str,
    subscriptions: &[(String, String)],
    names: &HashMap<String, String>,
    stock_codes: &HashSet<String>,
    futures_to_spot: &HashMap<String, String>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
    stats: &Arc<Stats>,
    fetched_stocks: Option<&Arc<DashMap<String, ()>>>,
    failed_stocks: Option<&Arc<DashMap<String, FailedT1102>>>,
    etf_codes: Option<&Arc<HashSet<String>>>,
) {
    let token = match get_or_fetch_token(app_key, app_secret).await {
        Ok(t) => t,
        Err(e) => { warn!("Initial price: token failed: {e}"); return; }
    };

    // 선물/스프레드 코드 (JC0)
    let futures_codes: Vec<String> = subscriptions.iter()
        .filter(|(tr, _)| tr == "JC0")
        .map(|(_, code)| code.clone())
        .collect();

    // 현물 코드 (S3_/K3_)
    let spot_codes: Vec<String> = subscriptions.iter()
        .filter(|(tr, _)| tr == "S3_" || tr == "K3_")
        .map(|(_, code)| code.clone())
        .collect();

    info!("Initial price fetch: {} futures/spread + {} stocks", futures_codes.len(), spot_codes.len());

    // t8402 (선물) — 별도 태스크
    let tx1 = tx.clone();
    let cancel1 = cancel.clone();
    let token1 = token.clone();
    let names1 = names.clone();
    let sc1 = stock_codes.clone();
    let f2s1 = futures_to_spot.clone();
    let stats1 = stats.clone();
    let h1 = tokio::spawn(async move {
        fetch_futures_initial(&token1, &futures_codes, &names1, &sc1, &f2s1, &tx1, &cancel1, &stats1).await
    });

    // t1102 (현물) — 별도 태스크 (병렬)
    let tx2 = tx.clone();
    let cancel2 = cancel.clone();
    let token2 = token.clone();
    let names2 = names.clone();
    let stats2 = stats.clone();
    let fetched2 = fetched_stocks.cloned();
    let failed2 = failed_stocks.cloned();
    let etf_codes2 = etf_codes.cloned();
    let h2 = tokio::spawn(async move {
        fetch_stocks_initial(&token2, &spot_codes, &names2, &tx2, &cancel2, &stats2, fetched2.as_ref(), failed2.as_ref(), etf_codes2.as_ref()).await
    });

    let (r1, r2) = tokio::join!(h1, h2);
    let f_count = r1.unwrap_or(0);
    let s_count = r2.unwrap_or(0);
    info!("Initial price fetch done: {f_count} futures + {s_count} stocks");
}

/// 요청 간 균등 간격. TPS 10 한도에 맞춰 100ms (10/초). 한도 도달 시 fetch_t1102 내부 retry가 처리.
const REQ_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
/// t8407(주식멀티현재가) 배치 — 한 콜 최대 50종목 (실측 2026-06-02: 55+ HTTP 500).
/// TPS 5 한도 → 청크 간 220ms (5콜/초 미만 여유). 50종목/220ms = ~225종목/초 (t1102 단건의 ~22배).
const T8407_CHUNK: usize = 50;
const T8407_INTERVAL: std::time::Duration = std::time::Duration::from_millis(220);
/// HTTP 에러 시 재시도 횟수 (최초 1회 + 재시도 2회 = 총 3회)
const MAX_RETRIES: usize = 2;

/// t8402로 선물/스프레드 초기 가격 조회
async fn fetch_futures_initial(
    token: &str,
    codes: &[String],
    names: &HashMap<String, String>,
    _stock_codes: &HashSet<String>,
    _futures_to_spot: &HashMap<String, String>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
    stats: &Arc<Stats>,
) -> usize {
    let client = reqwest::Client::new();
    let mut count = 0;
    let mut fail_no_data = 0;
    let mut fail_http_5xx = 0;
    let mut fail_tps = 0;
    let mut fail_other = 0;

    for code in codes {
        if cancel.is_cancelled() { return count; }

        match fetch_t8402(&client, token, code).await {
            Ok(detail) => {
                let price = pf(detail.get("price"));
                let volume = pu(detail.get("volume"));
                // "체결 없으면 공란" 원칙 (stock-arbitrage.md): 오늘 거래량이 0이면
                // t8402의 price는 전일 종가가 이월된 stale 값이라 initial tick 발행 안 함.
                // 당일 체결(WS JC0)이 들어오면 그때 실제 값으로 갱신됨.
                if volume > 0 {
                    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                    let name = names.get(code.as_str()).cloned().unwrap_or_default();
                    let underlying = pf(detail.get("baseprice"));
                    let basis = if underlying > 0.0 { price - underlying } else { 0.0 };
                    // 미결제약정: mgjv(잔고), mgjvdiff(전일대비). 키 없거나 Null이면 None.
                    let oi = detail.get("mgjv").filter(|v| !v.is_null()).map(|v| pi(Some(v)));
                    let oi_change = detail.get("mgjvdiff").filter(|v| !v.is_null()).map(|v| pi(Some(v)));

                    let _ = tx.send(WsMessage::FuturesTick(FuturesTick {
                        code: code.clone(), name: name.clone(),
                        price, underlying_price: underlying, basis: r2(basis), volume,
                        timestamp: now, is_initial: true,
                        open_interest: oi,
                        open_interest_change: oi_change,
                    })).await;
                    // 기초자산 StockTick은 여기서 파생하지 않음 — t1102가 250/250 커버하고,
                    // 여기서 cum_volume=0으로 보내면 현물대금을 덮어써 공란이 됨.
                    count += 1;
                } else {
                    // volume==0: 오늘 체결 없음 (price는 전일 종가). stale 회피 위해 skip.
                    fail_no_data += 1;
                    bump_fail(stats, "no_data");
                }
            }
            Err(e) => {
                let kind = classify_error(&e);
                match kind {
                    "no_data" => fail_no_data += 1,
                    "http_5xx" => fail_http_5xx += 1,
                    "tps" => fail_tps += 1,
                    _ => fail_other += 1,
                }
                bump_fail(stats, kind);
            }
        }
        tokio::time::sleep(REQ_INTERVAL).await;
    }
    let failed = fail_no_data + fail_http_5xx + fail_tps + fail_other;
    if failed > 0 {
        warn!("t8402 failures: no_data={fail_no_data} http_5xx={fail_http_5xx} tps={fail_tps} other={fail_other}");
    }
    count
}

/// t1102로 현물 초기 가격 + 거래대금 조회.
/// `fetched`가 Some이면 이미 fetch 성공한 코드는 건너뜀 (페이지 재진입 시 11분 풀 fetch 회피).
/// 성공 시 fetched에 등록되어 다음 호출에선 같은 코드 스킵.
/// `failed`가 Some이면 실패 코드를 기록 (백그라운드 retry worker가 처리). 성공 시 제거.
/// 코드가 t1102 호출 대상으로 유효한지 — KRX 종목 표준 6자리 영숫자.
/// 'CASH'(4자리), 'KA0166000'(9자리 지수선물), 'KRZF14599WG4'(12자리 워런트 ISIN),
/// 8자리 주식선물(A...) 등은 t1102 대상이 아니므로 호출 단계에서 제외.
fn is_t1102_target(code: &str) -> bool {
    code.len() == 6 && code.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 한 종목 스냅샷 처리 결과 — 호출자가 카운터/에러샘플 집계에 사용.
enum EmitOutcome {
    /// 거래대금/거래량 있음 → 정상 emit, fetched 등록됨.
    Emitted,
    /// 거래대금 0 + 전일종가만 → pc 박음, fetched 미등록(재시도 대상).
    PcOnly,
    /// 데이터 없음(value=0, 전일종가도 0).
    NoData,
}

/// t1102(단건) / t8407(멀티) 응답 detail Map 하나를 받아 Stock/Etf 틱 emit.
/// 두 TR은 필드가 거의 동일하나 **전일종가 키만 다름**: t1102=`recprice`, t8407=`jnilclose`
/// (값은 동일, 본 함수가 양쪽을 fallback 처리). abnormal_rise_gu/low_lqdt_gu는 t8407 미제공
/// → false로 시작하고 WS S3_ 스트림이 정확값으로 갱신.
#[allow(clippy::too_many_arguments)]
async fn emit_stock_from_detail(
    code: &str,
    detail: &serde_json::Map<String, serde_json::Value>,
    names: &HashMap<String, String>,
    is_etf: bool,
    tx: &mpsc::Sender<WsMessage>,
    stats: &Arc<Stats>,
    fetched: Option<&Arc<DashMap<String, ()>>>,
    failed: Option<&Arc<DashMap<String, FailedT1102>>>,
) -> EmitOutcome {
    let price = pf(detail.get("price"));
    let value = pu(detail.get("value")); // 백만원 단위 거래대금
    let volume_qty = pu(detail.get("volume")); // 당일 누적 거래량 (주)
    let h = pf(detail.get("high"));
    let l = pf(detail.get("low"));
    // 전일종가: t1102=recprice, t8407=jnilclose (값 동일, 필드명만 차이).
    let pc = {
        let r = pf(detail.get("recprice"));
        if r > 0.0 { r } else { pf(detail.get("jnilclose")) }
    };
    let uplmt = pf(detail.get("uplmtprice"));
    let dnlmt = pf(detail.get("dnlmtprice"));
    // 이상급등/저유동성 — t1102 응답에 직접 들어옴(t8407엔 없어 false). "0" = 정상.
    let abnormal_rise = detail.get("abnormal_rise_gu")
        .and_then(|v| v.as_str()).map(|s| s != "0" && !s.is_empty()).unwrap_or(false);
    let low_liquidity = detail.get("low_lqdt_gu")
        .and_then(|v| v.as_str()).map(|s| s != "0" && !s.is_empty()).unwrap_or(false);
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    let name = names.get(code).cloned().unwrap_or_default();

    if value > 0 || volume_qty > 0 {
        // 거래대금 또는 거래량 있음 = 정상 emit. fetched 등록해서 다음 sweep skip.
        // 거래대금(value)은 백만원 단위 반올림이라 소액 거래는 0이 될 수 있음 — volume>0이면 정상 처리.
        stats.emit_value_pos.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        crate::volume_cache::record(code, value);
        if is_etf {
            // ETF: 이 시점에 nav는 모름 (I5_ 스트림이 채움). price + cum_volume + prev_close 박음.
            let _ = tx.send(WsMessage::EtfTick(EtfTick {
                code: code.to_string(), name,
                price,
                nav: 0.0,
                spread_bp: 0.0,
                spread_bid_bp: 0.0,
                spread_ask_bp: 0.0,
                volume: volume_qty,
                cum_volume: value * 1_000_000,
                timestamp: now,
                prev_close: if pc > 0.0 { Some(pc) } else { None },
                last_trade_volume: None,
                trade_side: None,
                halted: is_halted(code),
                vi_active: is_vi_active(code),
            })).await;
        } else {
            let _ = tx.send(WsMessage::StockTick(StockTick {
                code: code.to_string(), name,
                price,
                volume: volume_qty,
                cum_volume: value * 1_000_000,
                timestamp: now, is_initial: true,
                high: if h > 0.0 { Some(h) } else { None },
                low: if l > 0.0 { Some(l) } else { None },
                prev_close: if pc > 0.0 { Some(pc) } else { None },
                last_trade_volume: None,  // 스냅샷 — 체결 단위 정보 X
                trade_side: None,
                halted: is_halted(code),
                upper_limit: if uplmt > 0.0 { Some(uplmt) } else { None },
                lower_limit: if dnlmt > 0.0 { Some(dnlmt) } else { None },
                vi_active: is_vi_active(code),
                warning: is_warning(code),
                liquidation: is_liquidation(code),
                abnormal_rise,
                low_liquidity,
                under_management: is_under_management(code),
            })).await;
        }
        if let Some(set) = fetched { set.insert(code.to_string(), ()); }
        if let Some(fmap) = failed { fmap.remove(code); }
        EmitOutcome::Emitted
    } else if pc > 0.0 {
        // 거래대금 0이지만 전일종가 있음. 주식은 price=0 + prev_close=pc로 fallback 표시.
        // ETF는 price=pc로 박아 종가 표시. fetched 미등록 → retry worker가 거래 발생까지 재시도.
        stats.emit_pc_only.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if is_etf {
            let _ = tx.send(WsMessage::EtfTick(EtfTick {
                code: code.to_string(), name,
                price: pc,  // 전일종가를 참고 가격으로
                nav: 0.0,
                spread_bp: 0.0,
                spread_bid_bp: 0.0,
                spread_ask_bp: 0.0,
                volume: 0,
                cum_volume: 0,  // pc_only는 미거래 — cum_volume 0
                timestamp: now,
                prev_close: Some(pc),
                last_trade_volume: None,
                trade_side: None,
                halted: is_halted(code),
                vi_active: is_vi_active(code),
            })).await;
        } else {
            let _ = tx.send(WsMessage::StockTick(StockTick {
                code: code.to_string(), name,
                price: 0.0,
                volume: 0,
                cum_volume: 0,
                timestamp: now, is_initial: true,
                high: None, low: None,
                prev_close: Some(pc),
                last_trade_volume: None,
                trade_side: None,
                halted: is_halted(code),
                upper_limit: if uplmt > 0.0 { Some(uplmt) } else { None },
                lower_limit: if dnlmt > 0.0 { Some(dnlmt) } else { None },
                vi_active: is_vi_active(code),
                warning: is_warning(code),
                liquidation: is_liquidation(code),
                abnormal_rise,
                low_liquidity,
                under_management: is_under_management(code),
            })).await;
        }
        if let Some(fmap) = failed {
            let prev = fmap.get(code).map(|e| e.attempt_count).unwrap_or(0);
            fmap.insert(code.to_string(), FailedT1102 {
                last_error: "pc_only (value=0, awaiting trade)".to_string(),
                error_kind: "pc_only",
                attempt_count: prev + 1,
            });
        }
        EmitOutcome::PcOnly
    } else {
        // value==0 + 전일종가 없음 (신규상장 등 정말 데이터 없는 케이스).
        bump_fail(stats, "no_data");
        if let Some(fmap) = failed {
            let prev = fmap.get(code).map(|e| e.attempt_count).unwrap_or(0);
            fmap.insert(code.to_string(), FailedT1102 {
                last_error: "value=0, recprice=0".to_string(),
                error_kind: "no_data",
                attempt_count: prev + 1,
            });
        }
        EmitOutcome::NoData
    }
}

pub async fn fetch_stocks_initial(
    token: &str,
    codes: &[String],
    names: &HashMap<String, String>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
    stats: &Arc<Stats>,
    fetched: Option<&Arc<DashMap<String, ()>>>,
    failed: Option<&Arc<DashMap<String, FailedT1102>>>,
    etf_codes: Option<&Arc<HashSet<String>>>,
) -> usize {
    let client = reqwest::Client::new();
    let mut count = 0;
    let mut skipped = 0;
    let mut invalid = 0;
    let mut fail_no_data = 0;
    let mut fail_http_5xx = 0;
    let mut fail_tps = 0;
    let mut fail_other = 0;
    // 에러 종류별 샘플 — 첫 5개 코드/메시지 로그용.
    let mut error_samples: HashMap<&'static str, Vec<(String, String)>> = HashMap::new();

    // 1) 호출 대상 필터 — 잡코드(CASH/지수선물/ISIN) 제외 + 이미 fetch된 코드 skip.
    //    frontend SubscribeStocks가 PDF의 'CASH'/ISIN 등을 무차별 보내도 여기서 차단.
    let mut targets: Vec<&String> = Vec::with_capacity(codes.len());
    for code in codes {
        if !is_t1102_target(code) {
            invalid += 1;
            if let Some(fmap) = failed { fmap.remove(code); }
            continue;
        }
        // 이미 fetch 성공(value>0)한 코드는 건너뜀. pc-only emit 코드는 fetched에 없어 재시도 대상.
        if let Some(set) = fetched {
            if set.contains_key(code) { skipped += 1; continue; }
        }
        targets.push(code);
    }

    // 2) t8407(주식멀티현재가)로 T8407_CHUNK개씩 배치 조회 — t1102 단건 대비 대폭 가속.
    //    TPS 5 → 청크 간 T8407_INTERVAL. 청크 전체 실패 시 코드들을 failed에 기록(retry worker 처리).
    for chunk in targets.chunks(T8407_CHUNK) {
        if cancel.is_cancelled() { return count; }
        stats.fetch_attempts.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);

        match fetch_t8407(&client, token, chunk).await {
            Ok(map) => {
                for &code in chunk {
                    let detail = match map.get(code.as_str()) {
                        Some(d) => d,
                        None => {
                            // t8407은 데이터 없는 코드(신규상장/유동성0/잡 ISIN 등)를 응답 배열에서
                            // 아예 제외함 → t1102의 "value=0, recprice=0" no_data와 동일 의미.
                            // failed에 기록해 retry worker가 거래 발생 시까지 재시도.
                            fail_no_data += 1;
                            bump_fail(stats, "no_data");
                            if error_samples.get("no_data").map(|v| v.len()).unwrap_or(0) < 5 {
                                error_samples.entry("no_data").or_default()
                                    .push((code.clone(), "t8407 무응답 (데이터 없음)".to_string()));
                            }
                            if let Some(fmap) = failed {
                                let prev = fmap.get(code).map(|e| e.attempt_count).unwrap_or(0);
                                fmap.insert(code.clone(), FailedT1102 {
                                    last_error: "t8407 무응답 (데이터 없음)".to_string(),
                                    error_kind: "no_data",
                                    attempt_count: prev + 1,
                                });
                            }
                            continue;
                        }
                    };
                    // ETF 코드는 EtfTick으로 분기 — frontend etfTicks store에 들어가도록.
                    let is_etf = etf_codes.map(|s| s.contains(code.as_str())).unwrap_or(false);
                    match emit_stock_from_detail(code, detail, names, is_etf, tx, stats, fetched, failed).await {
                        EmitOutcome::Emitted => count += 1,
                        EmitOutcome::PcOnly => {}
                        EmitOutcome::NoData => {
                            fail_no_data += 1;
                            if error_samples.get("no_data").map(|v| v.len()).unwrap_or(0) < 5 {
                                error_samples.entry("no_data").or_default()
                                    .push((code.clone(), "value=0, recprice=0".to_string()));
                            }
                        }
                    }
                }
            }
            Err(e) => {
                // 청크 전체 실패 — 종류 분류 후 각 코드를 failed에 기록.
                let kind = classify_error(&e);
                match kind {
                    "no_data" => fail_no_data += chunk.len(),
                    "http_5xx" => fail_http_5xx += chunk.len(),
                    "tps" => fail_tps += chunk.len(),
                    _ => fail_other += chunk.len(),
                }
                for &code in chunk {
                    bump_fail(stats, kind);
                    if error_samples.get(kind).map(|v| v.len()).unwrap_or(0) < 5 {
                        error_samples.entry(kind).or_default().push((code.clone(), e.clone()));
                    }
                    if let Some(fmap) = failed {
                        let prev = fmap.get(code).map(|en| en.attempt_count).unwrap_or(0);
                        fmap.insert(code.clone(), FailedT1102 {
                            last_error: e.clone(),
                            error_kind: kind,
                            attempt_count: prev + 1,
                        });
                    }
                }
            }
        }
        // 청크 간 간격은 fetch_t8407 내부 전역 게이트(t8407_rate_gate)가 처리 — 여기선 별도 sleep 불필요.
    }
    if invalid > 0 {
        warn!("t8407 invalid codes skipped: {invalid} (CASH/지수선물/ISIN 등 — 호출 대상 아님)");
    }
    let failed_total = fail_no_data + fail_http_5xx + fail_tps + fail_other;
    if failed_total > 0 {
        warn!("t8407 failures: no_data={fail_no_data} http_5xx={fail_http_5xx} tps={fail_tps} other={fail_other}");
        // 종류별 첫 5개 코드+에러 샘플 — 디버그용.
        for (kind, samples) in &error_samples {
            let head: Vec<String> = samples.iter()
                .map(|(c, e)| format!("{}={}", c, e.chars().take(60).collect::<String>()))
                .collect();
            warn!("t8407 {} samples: [{}]", kind, head.join(", "));
        }
    }
    if skipped > 0 {
        info!("t8407 skipped (already fetched): {skipped}");
    }
    // sweep 끝 — 거래대금 캐시 강제 flush (incremental save가 못 따라잡은 잔여 보장).
    crate::volume_cache::flush();
    count
}

pub async fn fetch_token(app_key: &str, app_secret: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client.post(TOKEN_URL)
        .form(&[("grant_type", "client_credentials"), ("appkey", app_key), ("appsecretkey", app_secret), ("scope", "oob")])
        .send().await.map_err(|e| format!("{e}"))?;
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("{e}"))?;
    body["access_token"].as_str().map(|s| s.to_string()).ok_or("no token".into())
}

async fn fetch_t8402(client: &reqwest::Client, token: &str, code: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let body = serde_json::json!({"t8402InBlock": {"focode": code}});
    // HTTP 5xx 또는 네트워크 에러 시 1초 간격으로 MAX_RETRIES만큼 재시도
    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 { tokio::time::sleep(std::time::Duration::from_secs(1)).await; }
        match client.post(T8402_URL)
            .header("Content-Type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t8402").header("tr_cont", "N")
            .json(&body).send().await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        if let Some(block) = data["t8402OutBlock"].as_object() {
                            return Ok(block.clone());
                        }
                        // rsp_msg가 "기초자산정보가 없습니다" 같은 유의미 응답이면 재시도 무의미
                        return Err(data.get("rsp_msg").and_then(|v| v.as_str()).unwrap_or("no data").into());
                    }
                    Err(e) => last_err = format!("parse: {e}"),
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN => {
                invalidate_token_cache().await;
                return Err(format!("http {} (token invalidated)", resp.status()));
            }
            Ok(resp) => last_err = format!("http {}", resp.status()),
            Err(e) => last_err = format!("send: {e}"),
        }
    }
    Err(last_err)
}

/// t8407 프로세스 전역 호출 게이트. 여러 sweep(메인 + 5초 후 ETF PDF + retry/Subscribe)이
/// 동시에 돌아도 합산 호출 간격을 T8407_INTERVAL 이상으로 직렬화해 TPS 5 한도 초과를 예방.
/// (per-caller pacing만으론 동시 2개 = ~9콜/초로 한도 초과 → 1초 재시도 백오프 누적 위험.)
static T8407_GATE: OnceLock<TokioMutex<Instant>> = OnceLock::new();

async fn t8407_rate_gate() {
    let gate = T8407_GATE.get_or_init(|| {
        TokioMutex::new(Instant::now().checked_sub(T8407_INTERVAL).unwrap_or_else(Instant::now))
    });
    let mut last = gate.lock().await;
    let elapsed = last.elapsed();
    if elapsed < T8407_INTERVAL {
        tokio::time::sleep(T8407_INTERVAL - elapsed).await;
    }
    *last = Instant::now();
}

/// t8407(API용주식멀티현재가조회) — 6자리 주식코드를 구분자 없이 연접해 한 콜에 최대 50종목.
/// 응답 `t8407OutBlock1` 배열을 `{shcode: detail}` 맵으로 반환. 필드는 t1102와 호환
/// (전일종가만 jnilclose, emit_stock_from_detail이 fallback 처리). 401/403은 토큰 무효화 후 에러.
async fn fetch_t8407(
    client: &reqwest::Client,
    token: &str,
    codes: &[&String],
) -> Result<HashMap<String, serde_json::Map<String, serde_json::Value>>, String> {
    let shcode: String = codes.iter().map(|s| s.as_str()).collect();
    let body = serde_json::json!({"t8407InBlock": {"nrec": codes.len(), "shcode": shcode}});
    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 { tokio::time::sleep(std::time::Duration::from_secs(1)).await; }
        t8407_rate_gate().await; // 전역 TPS 게이트 — 동시 sweep 합산 한도 보호
        match client.post(T1102_URL)
            .header("Content-Type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t8407").header("tr_cont", "N")
            .json(&body).send().await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        let mut out = HashMap::new();
                        if let Some(arr) = data["t8407OutBlock1"].as_array() {
                            for item in arr {
                                if let Some(obj) = item.as_object() {
                                    if let Some(sc) = obj.get("shcode").and_then(|v| v.as_str()) {
                                        out.insert(sc.to_string(), obj.clone());
                                    }
                                }
                            }
                        }
                        return Ok(out);
                    }
                    Err(e) => last_err = format!("parse: {e}"),
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN => {
                invalidate_token_cache().await;
                return Err(format!("http {} (token invalidated)", resp.status()));
            }
            Ok(resp) => last_err = format!("http {}", resp.status()),
            Err(e) => last_err = format!("send: {e}"),
        }
    }
    Err(last_err)
}

/// 거래대금 폴링 — codes를 t8407로 배치 조회해 VolumeTick(거래대금)을 broadcast.
/// 외부망 순위 매기기 전용(30초 주기 호출). fetch_t8407 재사용 → 내부 t8407_rate_gate가
/// 청크 간격(TPS 5)을 처리. value(백만원) × 1_000_000 = cum_volume(원).
pub async fn fetch_t8407_volumes(
    token: &str,
    codes: &[String],
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
) {
    let client = reqwest::Client::new();
    for chunk in codes.chunks(T8407_CHUNK) {
        if cancel.is_cancelled() { return; }
        let refs: Vec<&String> = chunk.iter().collect();
        match fetch_t8407(&client, token, &refs).await {
            Ok(map) => {
                for (code, detail) in map {
                    let value = pu(detail.get("value")); // 백만원 단위 거래대금
                    if value > 0 {
                        let _ = tx.send(WsMessage::VolumeTick(VolumeTick {
                            code,
                            cum_volume: value * 1_000_000,
                        })).await;
                    }
                }
            }
            Err(e) => warn!("t8407 volume poll: {e}"),
        }
    }
}

// ─── 지수선물 front-month 해석 (t8467 지수선물마스터) ─────────────────────────
// LP FV_futures 앵커(lp-system-design.md §13.3-A / §13.7 Phase 2 전제조건)용.
// 기동 시 1회 t8467로 KOSPI200(01)/미니(05)/KOSDAQ150(06) 최근월물 코드를 해석.

/// t8467 엔드포인트 — futureoption/market-data (t8402와 동일 그룹).
const INDEX_FUT_MASTER_URL: &str = T8402_URL;

/// 만기 임박 롤 임계치(일). 만기(2번째 목요일)까지 남은 일수가 이 값 미만이면 그 월물을
/// 건너뛰고 차근월물을 front로 선택. (만기 당일=0·전일=1 → 롤. 스펙 "만기 당일~전일 차근월물".)
const INDEX_FUT_ROLL_THRESHOLD_DAYS: i64 = 2;

/// 해석된 지수선물 front-month 1건.
#[derive(Clone, Debug)]
pub struct ResolvedIndexFuture {
    /// "kospi200" | "mini_k200" | "kosdaq150"
    pub product: &'static str,
    /// FC9 tr_key (A + 상품2 + 연1 + 월1 + 000, 8자리).
    pub code: String,
    pub name: String,
}

static RESOLVED_INDEX_FUTURES: OnceLock<std::sync::RwLock<Vec<ResolvedIndexFuture>>> = OnceLock::new();
fn resolved_slot() -> &'static std::sync::RwLock<Vec<ResolvedIndexFuture>> {
    RESOLVED_INDEX_FUTURES.get_or_init(|| std::sync::RwLock::new(Vec::new()))
}

/// /debug/stats 노출용. (product, code, name) 리스트. 해석 전이면 빈 Vec.
pub fn resolved_index_futures() -> Vec<(String, String, String)> {
    resolved_slot()
        .read()
        .unwrap()
        .iter()
        .map(|r| (r.product.to_string(), r.code.clone(), r.name.clone()))
        .collect()
}

fn index_product_of(prefix: &str) -> Option<&'static str> {
    match prefix {
        "01" => Some("kospi200"),
        "05" => Some("mini_k200"),
        "06" => Some("kosdaq150"),
        _ => None,
    }
}

/// 월 코드 문자 → 월(1~12). '1'..'9' + 'A'=10,'B'=11,'C'=12.
fn month_from_code(c: char) -> Option<u32> {
    match c {
        '1'..='9' => Some(c as u32 - '0' as u32),
        'A' => Some(10),
        'B' => Some(11),
        'C' => Some(12),
        _ => None,
    }
}

/// 지수선물 코드(A + 상품2 + 연1 + 월1 + 000)에서 (year, month) 파싱.
/// 한 자리 연도는 today 기준 가장 가까운 미래 decade로 보정.
pub(crate) fn parse_index_fut_ym(code: &str, today_year: i32) -> Option<(i32, u32)> {
    let b = code.as_bytes();
    if code.len() != 8 || b[0] != b'A' {
        return None;
    }
    let year_digit = (b[3] as char).to_digit(10)? as i32;
    let month = month_from_code(b[4] as char)?;
    let decade = today_year - today_year % 10;
    let mut y = decade + year_digit;
    if y < today_year - 1 {
        y += 10;
    }
    Some((y, month))
}

/// 해당 연월의 2번째 목요일 (KRX 지수선물/옵션 만기일).
pub(crate) fn second_thursday(year: i32, month: u32) -> Option<chrono::NaiveDate> {
    use chrono::{Datelike, NaiveDate};
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let dow = first.weekday().num_days_from_monday(); // Mon=0..Sun=6, Thu=3
    let first_thu_day = 1 + ((3 + 7 - dow as i64) % 7) as u32;
    NaiveDate::from_ymd_opt(year, month, first_thu_day + 7)
}

/// t8467(지수선물마스터)로 KOSPI200/미니/KOSDAQ150 front-month를 해석.
/// - t8467이 세 상품을 모두 반환하면 각자 최근월물(만기 임박 제외)을 선택.
/// - 미니/KOSDAQ150 미반환 시 KOSPI200 front에서 상품 prefix 치환으로 파생(best-effort, 경고 로그).
///
/// 실패/빈 응답 시 Err/빈 Vec — 호출자는 "지수선물 없이 진행".
pub async fn fetch_index_futures_front_months(
    app_key: &str,
    app_secret: &str,
) -> Result<Vec<ResolvedIndexFuture>, String> {
    use chrono::{Datelike, Local};

    let token = get_or_fetch_token(app_key, app_secret).await?;
    let client = reqwest::Client::new();
    let body = serde_json::json!({"t8467InBlock": {"gubun": ""}});
    let mut last_err = String::new();
    let mut resp_data: Option<serde_json::Value> = None;
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        match client
            .post(INDEX_FUT_MASTER_URL)
            .header("Content-Type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t8467")
            .header("tr_cont", "N")
            .json(&body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
                Ok(data) => {
                    resp_data = Some(data);
                    break;
                }
                Err(e) => last_err = format!("parse: {e}"),
            },
            Ok(resp)
                if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                    || resp.status() == reqwest::StatusCode::FORBIDDEN =>
            {
                invalidate_token_cache().await;
                return Err(format!("http {} (token invalidated)", resp.status()));
            }
            Ok(resp) => last_err = format!("http {}", resp.status()),
            Err(e) => last_err = format!("send: {e}"),
        }
    }
    let data = resp_data.ok_or(last_err)?;
    let arr = data["t8467OutBlock"].as_array().ok_or_else(|| {
        data.get("rsp_msg")
            .and_then(|v| v.as_str())
            .unwrap_or("t8467OutBlock 누락")
            .to_string()
    })?;

    let today = Local::now().date_naive();
    let today_year = today.year();

    // product prefix → 후보 (year, month, code, name).
    let mut by_product: HashMap<&'static str, Vec<(i32, u32, String, String)>> = HashMap::new();
    let mut all_shcodes: Vec<String> = Vec::new(); // A06 가설 실측용 원 응답 로깅
    for item in arr {
        let shcode = item.get("shcode").and_then(|v| v.as_str()).unwrap_or("");
        // 스프레드(shcode 'D...')·비정규 코드 제외. 정규 지수선물만 A + 8자리.
        if shcode.len() != 8 || !shcode.starts_with('A') {
            continue;
        }
        all_shcodes.push(shcode.to_string());
        let prod = match index_product_of(&shcode[1..3]) {
            Some(p) => p,
            None => continue,
        };
        let hname = item
            .get("hname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if let Some((y, m)) = parse_index_fut_ym(shcode, today_year) {
            by_product.entry(prod).or_default().push((y, m, shcode.to_string(), hname));
        }
    }
    info!(
        "t8467 지수선물마스터: 정규 {} 계약 (products: {:?}, shcode 샘플: {:?})",
        all_shcodes.len(),
        by_product.keys().collect::<Vec<_>>(),
        &all_shcodes[..all_shcodes.len().min(12)]
    );

    // product별 front = 만기 임박(threshold 미만) 제외 후 가장 이른 만기.
    let pick_front = |cands: &[(i32, u32, String, String)]| -> Option<(String, String)> {
        cands
            .iter()
            .filter(|(y, m, _, _)| {
                second_thursday(*y, *m)
                    .map(|exp| (exp - today).num_days() >= INDEX_FUT_ROLL_THRESHOLD_DAYS)
                    .unwrap_or(false)
            })
            .min_by_key(|(y, m, _, _)| (*y, *m))
            .map(|(_, _, code, name)| (code.clone(), name.clone()))
    };

    let mut resolved: Vec<ResolvedIndexFuture> = Vec::new();
    for &prod in &["kospi200", "mini_k200", "kosdaq150"] {
        if let Some(cands) = by_product.get(prod) {
            if let Some((code, name)) = pick_front(cands) {
                resolved.push(ResolvedIndexFuture { product: prod, code, name });
            }
        }
    }

    // t8467이 미니/KOSDAQ150 미반환 → KOSPI200 front에서 prefix 치환으로 파생.
    // 세 지수선물 모두 분기물 만기 사이클 공유(2번째 목요일). 단 미니는 월물 존재 가능 →
    // 파생은 best-effort, FC9 실측으로 검증 필요.
    if let Some(kospi) = resolved.iter().find(|r| r.product == "kospi200").cloned() {
        for &(prod, prefix) in &[("mini_k200", "05"), ("kosdaq150", "06")] {
            if !resolved.iter().any(|r| r.product == prod) {
                let derived = format!("A{}{}", prefix, &kospi.code[3..]);
                warn!(
                    "지수선물 {prod}: t8467 미반환 → KOSPI200 front에서 파생 {derived} (만기 사이클 미검증, FC9 실측 필요)"
                );
                resolved.push(ResolvedIndexFuture {
                    product: prod,
                    code: derived,
                    name: format!("{prod} F(derived)"),
                });
            }
        }
    }

    *resolved_slot().write().unwrap() = resolved.clone();
    Ok(resolved)
}

#[allow(dead_code)] // t8407 배치로 대체됨. 단건 디버그/폴백용 보존.
async fn fetch_t1102(client: &reqwest::Client, token: &str, code: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let body = serde_json::json!({"t1102InBlock": {"shcode": code}});
    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 { tokio::time::sleep(std::time::Duration::from_secs(1)).await; }
        match client.post(T1102_URL)
            .header("Content-Type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t1102").header("tr_cont", "N")
            .json(&body).send().await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        if let Some(block) = data["t1102OutBlock"].as_object() {
                            return Ok(block.clone());
                        }
                        return Err(data.get("rsp_msg").and_then(|v| v.as_str()).unwrap_or("no data").into());
                    }
                    Err(e) => last_err = format!("parse: {e}"),
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN => {
                invalidate_token_cache().await;
                return Err(format!("http {} (token invalidated)", resp.status()));
            }
            Ok(resp) => last_err = format!("http {}", resp.status()),
            Err(e) => last_err = format!("send: {e}"),
        }
    }
    Err(last_err)
}

// t8412(주식차트 N분) TPS 1 — 호출 간 1.1초 직렬화 게이트.
const T8412_INTERVAL: std::time::Duration = std::time::Duration::from_millis(1100);
static T8412_GATE: OnceLock<TokioMutex<std::time::Instant>> = OnceLock::new();
async fn t8412_rate_gate() {
    let gate = T8412_GATE.get_or_init(|| {
        TokioMutex::new(
            std::time::Instant::now()
                .checked_sub(T8412_INTERVAL)
                .unwrap_or_else(std::time::Instant::now),
        )
    });
    let mut last = gate.lock().await;
    let elapsed = last.elapsed();
    if elapsed < T8412_INTERVAL {
        tokio::time::sleep(T8412_INTERVAL - elapsed).await;
    }
    *last = std::time::Instant::now();
}

/// t8412 — 주식차트(N분). 당일(nday="0") N분봉 `t8412OutBlock1` 배열 반환.
/// 주식·ETF용 (shcode 6자리). 당일 09:00~현재 N분봉을 한 번에 받음(qrycnt 500).
/// 각 원소: {date:"YYYYMMDD", time:"HHMMSS"(KST), open, high, low, close, jdiff_vol, ...}.
/// TPS 1 — `t8412_rate_gate`로 직렬화. 토큰은 호출자가 획득해 전달(fetch_t1102 패턴).
pub async fn fetch_t8412_today(
    client: &reqwest::Client,
    token: &str,
    code: &str,
    ncnt: u32,
) -> Result<Vec<serde_json::Value>, String> {
    t8412_rate_gate().await;
    let body = serde_json::json!({"t8412InBlock": {
        "shcode": code, "ncnt": ncnt, "qrycnt": 500, "nday": "0",
        "sdate": "", "stime": "", "edate": "99999999", "etime": "",
        "cts_date": "", "cts_time": "", "comp_yn": "N"
    }});
    let mut last_err = String::new();
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 { tokio::time::sleep(std::time::Duration::from_secs(1)).await; }
        match client.post(STOCK_CHART_URL)
            .header("Content-Type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("tr_cd", "t8412").header("tr_cont", "N")
            .json(&body).send().await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        if let Some(arr) = data["t8412OutBlock1"].as_array() {
                            return Ok(arr.clone());
                        }
                        return Err(data.get("rsp_msg").and_then(|v| v.as_str()).unwrap_or("no data").into());
                    }
                    Err(e) => last_err = format!("parse: {e}"),
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN => {
                invalidate_token_cache().await;
                return Err(format!("http {} (token invalidated)", resp.status()));
            }
            Ok(resp) => last_err = format!("http {}", resp.status()),
            Err(e) => last_err = format!("send: {e}"),
        }
    }
    Err(last_err)
}

fn pf(v: Option<&serde_json::Value>) -> f64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}
fn pu(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}
fn pi(v: Option<&serde_json::Value>) -> i64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}
fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
