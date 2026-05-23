/// LS증권 OAuth 토큰 취득 + 캐시 (23h TTL).
///
/// LS API 토큰은 raw JWT 문자열 (Bearer 접두어 없음).
/// WS 구독 JSON의 `token` 필드에는 raw JWT 그대로 넣는다.
/// REST API Authorization 헤더에는 호출자가 `Bearer {token}`으로 조합.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const TOKEN_URL: &str = "https://openapi.ls-sec.co.kr:8080/oauth2/token";
const TOKEN_TTL: Duration = Duration::from_secs(23 * 3600);

struct Cached {
    token: String,
    at:    Instant,
}

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static C: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 캐시 확인 후 만료 시 재발급. 동시 요청이 있어도 Mutex로 직렬화.
pub async fn get_token(app_key: &str, app_secret: &str) -> Result<String, String> {
    let mut guard = cache().lock().await;

    if let Some(c) = guard.get(app_key) {
        if c.at.elapsed() < TOKEN_TTL {
            return Ok(c.token.clone());
        }
    }

    let token = fetch_token(app_key, app_secret).await?;
    tracing::info!(
        "token issued key={}…",
        &app_key[..app_key.len().min(8)]
    );
    guard.insert(app_key.to_string(), Cached { token: token.clone(), at: Instant::now() });
    Ok(token)
}

/// 강제 재발급 (401/403 수신 시).
#[allow(dead_code)]
pub async fn invalidate(app_key: &str) {
    cache().lock().await.remove(app_key);
    tracing::warn!("token cache invalidated for key={}…", &app_key[..app_key.len().min(8)]);
}

async fn fetch_token(app_key: &str, app_secret: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "client_credentials"),
            ("appkey",      app_key),
            ("appsecretkey", app_secret),
            ("scope",       "oob"),
        ])
        .send()
        .await
        .map_err(|e| format!("token HTTP error: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("token response parse: {e}"))?;

    if !status.is_success() {
        return Err(format!("token endpoint {status}: {body}"));
    }

    body["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("no access_token in response: {body}"))
}
