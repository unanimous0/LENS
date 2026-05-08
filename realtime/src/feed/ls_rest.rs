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
use crate::model::tick::{StockTick, FuturesTick};
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
#[allow(dead_code)]
pub async fn invalidate_token_cache() {
    *token_cache().lock().await = None;
    info!("token cache: invalidated");
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
    let h2 = tokio::spawn(async move {
        fetch_stocks_initial(&token2, &spot_codes, &names2, &tx2, &cancel2, &stats2, fetched2.as_ref(), failed2.as_ref()).await
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
                    // 미결제약정: mgjv(잔고), mgjvdiff(전일대비). 키 없으면 None.
                    let oi = detail.get("mgjv").map(|v| pi(Some(v)));
                    let oi_change = detail.get("mgjvdiff").map(|v| pi(Some(v)));

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
pub async fn fetch_stocks_initial(
    token: &str,
    codes: &[String],
    names: &HashMap<String, String>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
    stats: &Arc<Stats>,
    fetched: Option<&Arc<DashMap<String, ()>>>,
    failed: Option<&Arc<DashMap<String, FailedT1102>>>,
) -> usize {
    let client = reqwest::Client::new();
    let mut count = 0;
    let mut skipped = 0;
    let mut fail_no_data = 0;
    let mut fail_http_5xx = 0;
    let mut fail_tps = 0;
    let mut fail_other = 0;
    // 에러 종류별 샘플 — 첫 5개 코드/메시지 로그용.
    let mut error_samples: HashMap<&'static str, Vec<(String, String)>> = HashMap::new();

    for code in codes {
        if cancel.is_cancelled() { return count; }

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
                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                let name = names.get(code.as_str()).cloned().unwrap_or_default();

                if value > 0 {
                    // 거래대금 있음 = 정상 emit. fetched 등록해서 다음 sweep skip.
                    stats.emit_value_pos.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    crate::volume_cache::record(code, value);
                    let _ = tx.send(WsMessage::StockTick(StockTick {
                        code: code.clone(), name,
                        price,
                        volume: 0,
                        cum_volume: value * 1_000_000,
                        timestamp: now, is_initial: true,
                        high: if h > 0.0 { Some(h) } else { None },
                        low: if l > 0.0 { Some(l) } else { None },
                        prev_close: if pc > 0.0 { Some(pc) } else { None },
                    })).await;
                    if let Some(set) = fetched { set.insert(code.clone(), ()); }
                    if let Some(fmap) = failed { fmap.remove(code); }
                    count += 1;
                } else if pc > 0.0 {
                    // 거래대금 0이지만 전일종가 있음 — prev_close만 보내 화면 폴백 표시 (price=0).
                    // 핵심: fetched에 등록하지 않음 → retry worker가 거래 발생할 때까지 60초 cycle로 재시도,
                    // 거래 발생 즉시 정상 가격(value>0)으로 갱신됨. 사용자가 "한참 0이다가 거래되면 갱신" 원하는 동작.
                    stats.emit_pc_only.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let _ = tx.send(WsMessage::StockTick(StockTick {
                        code: code.clone(), name,
                        price: 0.0,
                        volume: 0,
                        cum_volume: 0,
                        timestamp: now, is_initial: true,
                        high: None, low: None,
                        prev_close: Some(pc),
                    })).await;
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
