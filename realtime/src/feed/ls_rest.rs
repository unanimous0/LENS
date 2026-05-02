//! t8402/t1102 REST로 초기 가격을 조회하여 틱으로 발행.
//! WebSocket 구독과 동시에 실행 — 실시간 체결이 먼저 오면 초기값은 프론트에서 무시.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

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
    let h2 = tokio::spawn(async move {
        fetch_stocks_initial(&token2, &spot_codes, &names2, &tx2, &cancel2, &stats2).await
    });

    let (r1, r2) = tokio::join!(h1, h2);
    let f_count = r1.unwrap_or(0);
    let s_count = r2.unwrap_or(0);
    info!("Initial price fetch done: {f_count} futures + {s_count} stocks");
}

/// 요청 간 균등 간격 (초당 5건, TPS 10 한도 대비 여유). 버스트 방지.
const REQ_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
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

/// t1102로 현물 초기 가격 + 거래대금 조회
async fn fetch_stocks_initial(
    token: &str,
    codes: &[String],
    names: &HashMap<String, String>,
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

        match fetch_t1102(&client, token, code).await {
            Ok(detail) => {
                let price = pf(detail.get("price"));
                let value = pu(detail.get("value")); // 백만원 단위 거래대금
                // "체결 없으면 공란" 원칙: 당일 거래대금 0이면 price도 전일 종가 stale 값.
                // S3_/K3_ 실시간 체결이 들어오면 그때 갱신됨.
                if value > 0 {
                    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                    let name = names.get(code.as_str()).cloned().unwrap_or_default();
                    // t1102 응답 필드 (확인됨): high(고가), low(저가), recprice(전일종가)
                    let h = pf(detail.get("high"));
                    let l = pf(detail.get("low"));
                    let pc = pf(detail.get("recprice"));

                    let _ = tx.send(WsMessage::StockTick(StockTick {
                        code: code.clone(), name,
                        price,
                        volume: 0,
                        cum_volume: value * 1_000_000, // 백만원 → 원
                        timestamp: now, is_initial: true,
                        high: if h > 0.0 { Some(h) } else { None },
                        low: if l > 0.0 { Some(l) } else { None },
                        prev_close: if pc > 0.0 { Some(pc) } else { None },
                    })).await;
                    count += 1;
                } else {
                    // value==0: 오늘 거래 없음 → stale 회피 위해 skip.
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
        warn!("t1102 failures: no_data={fail_no_data} http_5xx={fail_http_5xx} tps={fail_tps} other={fail_other}");
    }
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
