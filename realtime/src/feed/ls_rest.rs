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
use crate::model::tick::{EtfTick, StockTick, FuturesTick};
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

/// LS OAuth 토큰 TTL — 실제 24시간이지만 1시간 마진 두고 23시간 후 갱신.
/// 매 WS 재연결마다 토큰 받지 않게 프로세스 단위로 캐시.
const TOKEN_TTL: Duration = Duration::from_secs(23 * 3600);

struct CachedToken {
    token: String,
    fetched_at: Instant,
}

static TOKEN_CACHE: OnceLock<TokioMutex<Option<CachedToken>>> = OnceLock::new();

fn token_cache() -> &'static TokioMutex<Option<CachedToken>> {
    TOKEN_CACHE.get_or_init(|| TokioMutex::new(None))
}

/// 캐시된 토큰을 반환. TTL 지났으면 새로 발급. 없거나 401 받았을 때
/// `invalidate_token_cache()` 호출 후 재시도하면 됨.
pub async fn get_or_fetch_token(app_key: &str, app_secret: &str) -> Result<String, String> {
    let cache = token_cache();
    let mut guard = cache.lock().await;

    if let Some(c) = guard.as_ref() {
        if c.fetched_at.elapsed() < TOKEN_TTL {
            return Ok(c.token.clone());
        }
    }

    // 만료/없음 → 새로 발급
    let new_token = fetch_token(app_key, app_secret).await?;
    info!("token cache: refreshed (was {})", if guard.is_some() { "expired" } else { "empty" });
    *guard = Some(CachedToken { token: new_token.clone(), fetched_at: Instant::now() });
    Ok(new_token)
}

/// LS가 401 또는 토큰 무효 응답 줄 때 캐시 강제 무효화.
/// fetch_t1102/t8402/t1405/t1404가 401/403 받으면 호출. 다음 get_or_fetch_token이
/// 새 토큰 발급 → 폴러/sweep 다음 cycle부터 회복.
pub async fn invalidate_token_cache() {
    *token_cache().lock().await = None;
    info!("token cache: invalidated (401/403 received)");
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

    for code in codes {
        if cancel.is_cancelled() { return count; }

        // 잡코드 가드 — frontend SubscribeStocks가 PDF의 'CASH'/지수선물/ISIN 등을 무차별 보내도
        // 여기서 차단해 LS 5xx + retry 무한루프 방지. failed에 들어 있으면 청소.
        if !is_t1102_target(code) {
            invalid += 1;
            if let Some(fmap) = failed { fmap.remove(code); }
            continue;
        }

        // 이미 fetch 성공(value>0)한 코드는 건너뜀.
        // pc-only로만 emit된 코드는 fetched에 안 들어가므로 자동 재시도 대상 — 거래 발생 시 가격 채움.
        if let Some(set) = fetched {
            if set.contains_key(code) {
                skipped += 1;
                continue;
            }
        }
        stats.fetch_attempts.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        match fetch_t1102(&client, token, code).await {
            Ok(detail) => {
                let price = pf(detail.get("price"));
                let value = pu(detail.get("value")); // 백만원 단위 거래대금
                let h = pf(detail.get("high"));
                let l = pf(detail.get("low"));
                let pc = pf(detail.get("recprice"));
                let uplmt = pf(detail.get("uplmtprice"));
                let dnlmt = pf(detail.get("dnlmtprice"));
                // 이상급등/저유동성 — t1102 응답에 직접 들어옴. "0" = 정상, 그 외 = 해당 상태.
                let abnormal_rise = detail.get("abnormal_rise_gu")
                    .and_then(|v| v.as_str()).map(|s| s != "0" && !s.is_empty()).unwrap_or(false);
                let low_liquidity = detail.get("low_lqdt_gu")
                    .and_then(|v| v.as_str()).map(|s| s != "0" && !s.is_empty()).unwrap_or(false);
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                let name = names.get(code.as_str()).cloned().unwrap_or_default();

                // ETF 코드는 EtfTick으로 분기 — frontend etfTicks store에 들어가도록.
                // 평일 LS WS S3_/I5_ 스트림은 동일 분기지만, t1102 단독 시점(휴장·시작 직후)에도
                // 정확히 etfTicks에 들어가게 (PR15b의 frontend fallback 의존 해소).
                let is_etf = etf_codes.map(|s| s.contains(code)).unwrap_or(false);

                if value > 0 {
                    // 거래대금 있음 = 정상 emit. fetched 등록해서 다음 sweep skip.
                    stats.emit_value_pos.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    crate::volume_cache::record(code, value);
                    if is_etf {
                        // ETF: t1102 시점에 nav는 모름 (I5_ 스트림이 채움). price + cum_volume + prev_close 박음.
                        let _ = tx.send(WsMessage::EtfTick(EtfTick {
                            code: code.clone(), name,
                            price,
                            nav: 0.0,
                            spread_bp: 0.0,
                            spread_bid_bp: 0.0,
                            spread_ask_bp: 0.0,
                            volume: 0,
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
                            code: code.clone(), name,
                            price,
                            volume: 0,
                            cum_volume: value * 1_000_000,
                            timestamp: now, is_initial: true,
                            high: if h > 0.0 { Some(h) } else { None },
                            low: if l > 0.0 { Some(l) } else { None },
                            prev_close: if pc > 0.0 { Some(pc) } else { None },
                            last_trade_volume: None,  // t1102 스냅샷 — 체결 단위 정보 X
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
                    if let Some(set) = fetched { set.insert(code.clone(), ()); }
                    if let Some(fmap) = failed { fmap.remove(code); }
                    count += 1;
                } else if pc > 0.0 {
                    // 거래대금 0이지만 전일종가 있음. 주식은 price=0 + prev_close=pc로 fallback 표시.
                    // ETF는 prev_close 필드 없음 → price=pc로 박아 종가 표시.
                    // 핵심: fetched에 등록하지 않음 → retry worker가 거래 발생할 때까지 60초 cycle로 재시도.
                    stats.emit_pc_only.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if is_etf {
                        let _ = tx.send(WsMessage::EtfTick(EtfTick {
                            code: code.clone(), name,
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
                            code: code.clone(), name,
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
                        fmap.insert(code.clone(), FailedT1102 {
                            last_error: "pc_only (value=0, awaiting trade)".to_string(),
                            error_kind: "pc_only",
                            attempt_count: prev + 1,
                        });
                    }
                } else {
                    // value==0 + recprice 없음 (신규상장 등 정말 데이터 없는 케이스).
                    fail_no_data += 1;
                    bump_fail(stats, "no_data");
                    if error_samples.get("no_data").map(|v| v.len()).unwrap_or(0) < 5 {
                        error_samples.entry("no_data").or_default()
                            .push((code.clone(), "value=0, recprice=0".to_string()));
                    }
                    if let Some(fmap) = failed {
                        let prev = fmap.get(code).map(|e| e.attempt_count).unwrap_or(0);
                        fmap.insert(code.clone(), FailedT1102 {
                            last_error: "value=0, recprice=0".to_string(),
                            error_kind: "no_data",
                            attempt_count: prev + 1,
                        });
                    }
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
                if error_samples.get(kind).map(|v| v.len()).unwrap_or(0) < 5 {
                    error_samples.entry(kind).or_default().push((code.clone(), e.clone()));
                }
                if let Some(fmap) = failed {
                    let prev = fmap.get(code).map(|en| en.attempt_count).unwrap_or(0);
                    fmap.insert(code.clone(), FailedT1102 {
                        last_error: e,
                        error_kind: kind,
                        attempt_count: prev + 1,
                    });
                }
            }
        }
        tokio::time::sleep(REQ_INTERVAL).await;
    }
    if invalid > 0 {
        warn!("t1102 invalid codes skipped: {invalid} (CASH/지수선물/ISIN 등 — 호출 대상 아님)");
    }
    let failed_total = fail_no_data + fail_http_5xx + fail_tps + fail_other;
    if failed_total > 0 {
        warn!("t1102 failures: no_data={fail_no_data} http_5xx={fail_http_5xx} tps={fail_tps} other={fail_other}");
        // 종류별 첫 5개 코드+에러 샘플 — 디버그용.
        for (kind, samples) in &error_samples {
            let head: Vec<String> = samples.iter()
                .map(|(c, e)| format!("{}={}", c, e.chars().take(60).collect::<String>()))
                .collect();
            warn!("t1102 {} samples: [{}]", kind, head.join(", "));
        }
    }
    if skipped > 0 {
        info!("t1102 skipped (already fetched): {skipped}");
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
