/// LS증권 REST API — t1102 주식현재가(초기값) 조회.
///
/// WS는 실시간 틱만 주므로, 시작 시 / 장외 시간에 현재가(종가)를
/// REST로 한 번 가져와야 화면에 표시됨.
///
/// TPS 한도: 10/초 → 종목당 100ms 간격 (REQ_INTERVAL).

use tokio::sync::mpsc;

use crate::auth;
use crate::config::Config;
use crate::state::WsEvent;

const T1102_URL: &str = "https://openapi.ls-sec.co.kr:8080/stock/market-data";
const REQ_INTERVAL: std::time::Duration = std::time::Duration::from_millis(110); // TPS 10 안전 마진

/// 주식 코드 목록을 순서대로 t1102 조회해 WsEvent::InitialPrice로 전송.
/// 선물(A-prefix) 등 t1102 대상이 아닌 코드는 skip.
pub async fn fetch_initial_prices(
    config: &Config,
    codes: &[String],
    event_tx: &mpsc::Sender<WsEvent>,
) {
    let token = match auth::get_token(&config.app_key, &config.app_secret).await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("t1102 token error: {e}");
            return;
        }
    };

    let client = reqwest::Client::new();

    for code in codes {
        // 선물(A+7자리), 지수 등은 t1102 대상 아님 — 6자리 숫자만
        if !is_t1102_target(code) {
            tracing::debug!("t1102 skip (non-stock): {code}");
            continue;
        }

        match fetch_t1102(&client, &token, code).await {
            Ok(block) => {
                let price    = parse_f64(block.get("price"));
                let volume   = parse_u64(block.get("volume"));
                let high     = parse_f64(block.get("high"));
                let low      = parse_f64(block.get("low"));
                let open     = parse_f64(block.get("open"));
                let prev_close = parse_f64(block.get("recprice")); // 전일종가
                let name     = block.get("hname")
                    .and_then(|v| v.as_str())
                    .unwrap_or(code)
                    .to_string();

                tracing::info!(
                    "t1102 {code} ({name}) price={price} prev={prev_close} vol={volume}"
                );

                let _ = event_tx.send(WsEvent::InitialPrice {
                    code:       code.clone(),
                    name,
                    price,
                    volume,
                    high,
                    low,
                    open,
                    prev_close,
                    raw_block:  serde_json::Value::Object(block),
                }).await;
            }
            Err(e) => {
                tracing::warn!("t1102 {code} error: {e}");
            }
        }

        // TPS 한도 준수
        tokio::time::sleep(REQ_INTERVAL).await;
    }
}

/// t1102 대상 여부 — 6자리 ASCII 영숫자 (주식/ETF/리츠 등 KRX 표준 종목코드)
/// 예: "005930"(숫자), "0117V0"(영숫자 혼용 ETF) 모두 포함.
/// 선물(A+7자리), 지수 등은 제외.
fn is_t1102_target(code: &str) -> bool {
    code.len() == 6 && code.chars().all(|c| c.is_ascii_alphanumeric())
}

async fn fetch_t1102(
    client: &reqwest::Client,
    token: &str,
    code: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let body = serde_json::json!({ "t1102InBlock": { "shcode": code } });

    let resp = client
        .post(T1102_URL)
        .header("Content-Type",  "application/json")
        .header("authorization", format!("Bearer {token}"))
        .header("tr_cd",         "t1102")
        .header("tr_cont",       "N")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("send: {e}"))?;

    let status = resp.status();
    let data: serde_json::Value = resp.json().await
        .map_err(|e| format!("parse: {e}"))?;

    if !status.is_success() {
        return Err(format!("http {status}: {data}"));
    }

    data["t1102OutBlock"]
        .as_object()
        .cloned()
        .ok_or_else(|| {
            let msg = data.get("rsp_msg")
                .and_then(|v| v.as_str())
                .unwrap_or("no t1102OutBlock");
            msg.to_string()
        })
}

fn parse_f64(v: Option<&serde_json::Value>) -> f64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn parse_u64(v: Option<&serde_json::Value>) -> u64 {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.parse().unwrap_or(0),
        _ => 0,
    }
}
