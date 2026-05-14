//! Universe — 통계 발굴 대상 종목 집합.
//!
//! PR3: KOSPI200 구성종목 (200) 만. KOSDAQ150/ETF는 추후 PR.
//! PG `index_components` 에서 `index_name='KOSPI200'` 현재(end_date null/미래) 구성종목 추출.

use sqlx::PgPool;

#[derive(Debug, Clone)]
pub struct UniverseStock {
    pub code: String,
    pub name: String,
}

/// KOSPI200 현재 구성종목 + 종목명. 거래 가능(is_active=true)인 것만.
pub async fn load_kospi200(pool: &PgPool) -> Result<Vec<UniverseStock>, sqlx::Error> {
    let sql = r#"
        SELECT ic.stock_code, s.stock_name
        FROM index_components ic
        JOIN stocks s ON s.stock_code = ic.stock_code
        WHERE ic.index_name = 'KOSPI200'
          AND (ic.end_date IS NULL OR ic.end_date > current_date)
          AND s.is_active = true
        ORDER BY ic.stock_code
    "#;
    let rows: Vec<(String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(code, name)| UniverseStock { code, name })
        .collect())
}
