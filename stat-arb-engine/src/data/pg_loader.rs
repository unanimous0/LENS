//! Finance_Data PostgreSQL (korea_stock_data) 연결.
//!
//! peer 인증 — connection string에 비밀번호 없음. SELECT만 사용 (코드 차원 약속).
//! backend/core/database.py 와 동일한 DB. 통계 엔진은 read-only.

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::time::Duration;

/// 기본: unix socket peer auth. backend/core/config.py 와 동일 경로.
/// 환경변수 `STATARB_DATABASE_URL` 로 풀 DSN 오버라이드 가능 (TCP/원격 PG 등).
const DEFAULT_SOCKET: &str = "/var/run/postgresql";
const DEFAULT_USER: &str = "una0";
const DEFAULT_DB: &str = "korea_stock_data";

pub async fn connect() -> Result<PgPool, sqlx::Error> {
    let opts = if let Ok(dsn) = std::env::var("STATARB_DATABASE_URL") {
        dsn.parse::<PgConnectOptions>()?
    } else {
        // sqlx URL 파서가 query string `host=` 를 host 슬롯으로 못 넘기므로 빌더 API 사용.
        PgConnectOptions::new()
            .socket(DEFAULT_SOCKET)
            .username(DEFAULT_USER)
            .database(DEFAULT_DB)
    };
    // 작은 풀로 시작 — 통계 엔진은 동시 쿼리 적음 (배치 로드 위주).
    PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await
}

/// 헬스체크 — Phase 1에서 PG 가용성 확인.
pub async fn ping(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(pool)
        .await?;
    Ok(())
}
