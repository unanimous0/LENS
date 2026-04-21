//! t8402/t1102 REST로 초기 가격을 조회하여 틱으로 발행.
//! WebSocket 구독과 동시에 실행 — 실시간 체결이 먼저 오면 초기값은 프론트에서 무시.

use std::collections::{HashMap, HashSet};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{StockTick, FuturesTick};

const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const T8402_URL: &str = "https://openapi.ls-sec.co.kr:8080/futureoption/market-data";
const T1102_URL: &str = "https://openapi.ls-sec.co.kr:8080/stock/market-data";

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
) {
    let token = match fetch_token(app_key, app_secret).await {
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
    let h1 = tokio::spawn(async move {
        fetch_futures_initial(&token1, &futures_codes, &names1, &sc1, &f2s1, &tx1, &cancel1).await
    });

    // t1102 (현물) — 별도 태스크 (병렬)
    let tx2 = tx.clone();
    let cancel2 = cancel.clone();
    let token2 = token.clone();
    let names2 = names.clone();
    let h2 = tokio::spawn(async move {
        fetch_stocks_initial(&token2, &spot_codes, &names2, &tx2, &cancel2).await
    });

    let (r1, r2) = tokio::join!(h1, h2);
    let f_count = r1.unwrap_or(0);
    let s_count = r2.unwrap_or(0);
    info!("Initial price fetch done: {f_count} futures + {s_count} stocks");
}

/// t8402로 선물/스프레드 초기 가격 조회
async fn fetch_futures_initial(
    token: &str,
    codes: &[String],
    names: &HashMap<String, String>,
    stock_codes: &HashSet<String>,
    futures_to_spot: &HashMap<String, String>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
) -> usize {
    let client = reqwest::Client::new();
    let mut count = 0;
    let mut tps = 0;

    for code in codes {
        if cancel.is_cancelled() { return count; }

        if let Ok(detail) = fetch_t8402(&client, token, code).await {
            let price = pf(detail.get("price"));
            let volume = pu(detail.get("volume"));
            if price <= 0.0 { tps_wait(&mut tps).await; continue; }

            let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
            let name = names.get(code.as_str()).cloned().unwrap_or_default();
            let underlying = pf(detail.get("baseprice"));
            let basis = if underlying > 0.0 { price - underlying } else { 0.0 };

            let _ = tx.send(WsMessage::FuturesTick(FuturesTick {
                code: code.clone(), name: name.clone(),
                price, underlying_price: underlying, basis: r2(basis), volume,
                timestamp: now.clone(), is_initial: true,
            })).await;

            // 기초자산 StockTick (D코드 스프레드 제외)
            if underlying > 0.0 && code.starts_with('A') {
                if let Some(spot_code) = futures_to_spot.get(code.as_str()) {
                    let sname = names.get(spot_code).cloned().unwrap_or_default();
                    let _ = tx.send(WsMessage::StockTick(StockTick {
                        code: spot_code.clone(), name: sname,
                        price: underlying, volume: 0, cum_volume: 0,
                        timestamp: now, is_initial: true,
                    })).await;
                }
            }
            count += 1;
        }
        tps_wait(&mut tps).await;
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
) -> usize {
    let client = reqwest::Client::new();
    let mut count = 0;
    let mut tps = 0;

    for code in codes {
        if cancel.is_cancelled() { return count; }

        if let Ok(detail) = fetch_t1102(&client, token, code).await {
            let price = pf(detail.get("price"));
            let value = pu(detail.get("value")); // 백만원 단위 거래대금
            if price <= 0.0 { tps_wait(&mut tps).await; continue; }

            let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
            let name = names.get(code.as_str()).cloned().unwrap_or_default();

            let _ = tx.send(WsMessage::StockTick(StockTick {
                code: code.clone(), name,
                price,
                volume: 0,
                cum_volume: value * 1_000_000, // 백만원 → 원
                timestamp: now, is_initial: true,
            })).await;
            count += 1;
        }
        tps_wait(&mut tps).await;
    }
    count
}

/// TPS 제한 대응: 9건마다 1초 대기, 그 외 50ms 간격
async fn tps_wait(tps: &mut u32) {
    *tps += 1;
    if *tps >= 9 {
        *tps = 0;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    } else {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
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
    let resp = client.post(T8402_URL)
        .header("Content-Type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("tr_cd", "t8402").header("tr_cont", "N")
        .json(&body).send().await.map_err(|e| format!("{e}"))?;
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("{e}"))?;
    data["t8402OutBlock"].as_object().cloned().ok_or("no data".into())
}

async fn fetch_t1102(client: &reqwest::Client, token: &str, code: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let body = serde_json::json!({"t1102InBlock": {"shcode": code}});
    let resp = client.post(T1102_URL)
        .header("Content-Type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("tr_cd", "t1102").header("tr_cont", "N")
        .json(&body).send().await.map_err(|e| format!("{e}"))?;
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("{e}"))?;
    data["t1102OutBlock"].as_object().cloned().ok_or("no data".into())
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
fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
