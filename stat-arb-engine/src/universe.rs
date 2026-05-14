//! Universe — 통계 발굴 대상 자산 집합.
//!
//! PR3: KOSPI200 주식만.
//! PR5: KOSPI200 + KOSDAQ150 주식 + 거래대금 상위 ETF + 주요 지수.
//! 선물(Stock/Index)은 PR5b+에서 — front month rolling 처리 필요.

use serde::Serialize;
use sqlx::PgPool;

#[derive(Debug, Clone, Serialize)]
pub struct UniverseStock {
    pub code: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UniverseEtf {
    pub code: String,
    pub name: String,
    /// 1개월 평균 거래대금 (원). 정렬용.
    pub avg_value: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct UniverseIndex {
    pub code: String,
    pub name: String,
}

/// 한 화면에 다 보이는 universe 한 묶음.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Universe {
    pub stocks_kospi200: Vec<UniverseStock>,
    pub stocks_kosdaq150: Vec<UniverseStock>,
    pub etfs: Vec<UniverseEtf>,
    pub indices: Vec<UniverseIndex>,
}

impl Universe {
    pub fn total_count(&self) -> usize {
        self.stocks_kospi200.len()
            + self.stocks_kosdaq150.len()
            + self.etfs.len()
            + self.indices.len()
    }
}

/// 지수 구성종목 (KOSPI200 또는 KOSDAQ150 등).
pub async fn load_index_components(
    pool: &PgPool,
    index_name: &str,
) -> Result<Vec<UniverseStock>, sqlx::Error> {
    let sql = r#"
        SELECT ic.stock_code, s.stock_name
        FROM index_components ic
        JOIN stocks s ON s.stock_code = ic.stock_code
        WHERE ic.index_name = $1
          AND (ic.end_date IS NULL OR ic.end_date > current_date)
          AND s.is_active = true
        ORDER BY ic.stock_code
    "#;
    let rows: Vec<(String, String)> = sqlx::query_as(sql).bind(index_name).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(code, name)| UniverseStock { code, name })
        .collect())
}

/// 거래대금 상위 ETF. 1개월 평균 거래대금 기준 내림차순 상위 `top_n`개.
/// PR5: 상위 100개 정도면 의미있는 ETF 페어 발굴 충분.
pub async fn load_active_etfs(pool: &PgPool, top_n: i32) -> Result<Vec<UniverseEtf>, sqlx::Error> {
    let sql = r#"
        SELECT m.etf_code, m.kr_name, COALESCE(AVG(o.trading_value)::bigint, 0) AS avg_value
        FROM etf_master_daily m
        JOIN ohlcv_daily o ON o.stock_code = m.etf_code AND o.time > current_date - 30
        WHERE m.snapshot_date = (SELECT MAX(snapshot_date) FROM etf_master_daily)
        GROUP BY m.etf_code, m.kr_name
        HAVING AVG(o.trading_value) > 1000000000  -- 평균 10억원 이상
        ORDER BY avg_value DESC NULLS LAST
        LIMIT $1
    "#;
    let rows: Vec<(String, Option<String>, i64)> =
        sqlx::query_as(sql).bind(top_n as i64).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(code, name, avg_value)| UniverseEtf {
            code: code.clone(),
            name: name.unwrap_or(code),
            avg_value,
        })
        .collect())
}

/// 주요 지수 — 고정 리스트. 가끔만 갱신 (KRX 신규 지수 출시 시).
/// 페어 발굴에 의미있는 광범위 지수 + 섹터 지수.
pub fn main_index_codes() -> Vec<(&'static str, &'static str)> {
    vec![
        // 광범위
        ("KGG01P", "코스피"),
        ("QGG01P", "코스닥"),
        ("K2G01P", "코스피 200"),
        ("Q5G01P", "코스닥 150"),
        // KOSPI200 섹터 (K2S01P ~ K2S08P)
        ("K2S01P", "코스피 200 헬스케어"),
        ("K2S02P", "코스피 200 건설"),
        ("K2S03P", "코스피 200 금융"),
        ("K2S04P", "코스피 200 산업재"),
        ("K2S05P", "코스피 200 에너지/화학"),
        ("K2S06P", "코스피 200 경기소비재"),
        ("K2S07P", "코스피 200 정보기술"),
        ("K2S08P", "코스피 200 중공업"),
        // KOSDAQ150 섹터
        ("Q5S02P", "코스닥 150 정보기술"),
        ("Q5S03P", "코스닥 150 헬스케어"),
        ("Q5S04P", "코스닥 150 커뮤니케이션서비스"),
        ("Q5S05P", "코스닥 150 소재"),
        ("Q5S06P", "코스닥 150 산업재"),
        ("Q5S07P", "코스닥 150 필수소비재"),
        ("Q5S08P", "코스닥 150 자유소비재"),
    ]
}

pub fn load_main_indices() -> Vec<UniverseIndex> {
    main_index_codes()
        .into_iter()
        .map(|(code, name)| UniverseIndex {
            code: code.to_string(),
            name: name.to_string(),
        })
        .collect()
}

/// 한 번에 universe 전체 로딩 (try_join).
pub async fn load_full(pool: &PgPool, etf_top_n: i32) -> Result<Universe, sqlx::Error> {
    let (kospi, kosdaq, etfs) = tokio::try_join!(
        load_index_components(pool, "KOSPI200"),
        load_index_components(pool, "KOSDAQ150"),
        load_active_etfs(pool, etf_top_n),
    )?;
    Ok(Universe {
        stocks_kospi200: kospi,
        stocks_kosdaq150: kosdaq,
        etfs,
        indices: load_main_indices(),
    })
}

// 후방 호환 — main.rs의 기존 호출자가 한동안 쓸 수 있게.
#[allow(dead_code)]
pub async fn load_kospi200(pool: &PgPool) -> Result<Vec<UniverseStock>, sqlx::Error> {
    load_index_components(pool, "KOSPI200").await
}
