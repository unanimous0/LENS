//! t8402 REST로 초기 가격을 조회하여 틱으로 발행.
//! WebSocket 구독과 동시에 실행 — 실시간 체결이 먼저 오면 초기값은 프론트에서 무시.

use std::collections::{HashMap, HashSet};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{StockTick, FuturesTick};

const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const T8402_URL: &str = "https://openapi.ls-sec.co.kr:8080/futureoption/market-data";

/// 구독 목록의 모든 종목에 대해 t8402로 현재가를 조회하고 초기 틱으로 발행.
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

    // 선물 코드만 (S3_/K3_는 t8402로 조회 불가 — 주식 현재가는 별도 TR)
    // JC0 코드 = A코드(선물) + D코드(스프레드)
    let futures_codes: Vec<&(String, String)> = subscriptions.iter()
        .filter(|(tr, _)| tr == "JC0")
        .collect();

    // 현물은 t1102로 조회해야 하지만 TPS=10이라 느림.
    // S3_/K3_ 실시간 틱이 빠르게 오니까 선물+스프레드만 초기값 조회.
    let total = futures_codes.len();
    info!("Initial price fetch: {total} futures/spread codes");

    let client = reqwest::Client::new();
    let mut count = 0;
    let mut tps_count = 0;

    for (_, code) in &futures_codes {
        if cancel.is_cancelled() { return; }

        match fetch_t8402(&client, &token, code).await {
            Ok(detail) => {
                let price = pf(detail.get("price"));
                let volume = pu(detail.get("volume"));
                if price <= 0.0 { continue; } // 체결 없으면 skip

                let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                let name = names.get(code.as_str()).cloned().unwrap_or_default();

                // FuturesTick 발행
                let underlying = pf(detail.get("baseprice"));
                let basis = if underlying > 0.0 { price - underlying } else { 0.0 };
                let _ = tx.send(WsMessage::FuturesTick(FuturesTick {
                    code: code.clone(), name: name.clone(),
                    price, underlying_price: underlying, basis: r2(basis), volume,
                    timestamp: now.clone(), is_initial: true,
                })).await;

                // 선물의 기초자산 StockTick도 발행 (D코드 스프레드는 제외)
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
            Err(_) => {} // 실패는 무시 — 실시간 틱이 커버
        }

        tps_count += 1;
        if tps_count >= 9 {
            tps_count = 0;
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        } else {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    info!("Initial price fetch done: {count}/{total} prices emitted");
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
        .header("tr_cd", "t8402")
        .header("tr_cont", "N")
        .json(&body)
        .send().await.map_err(|e| format!("{e}"))?;
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("{e}"))?;
    data["t8402OutBlock"].as_object().cloned().ok_or("no data".into())
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
