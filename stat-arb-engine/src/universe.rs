//! Universe — 통계 발굴 대상 자산 집합.
//!
//! PR3: KOSPI200 주식만.
//! PR5: KOSPI200 + KOSDAQ150 주식 + 거래대금 상위 ETF + 주요 지수.
//! 선물(Stock/Index)은 PR5b+에서 — front month rolling 처리 필요.

use serde::Serialize;
use sqlx::PgPool;
use std::collections::HashMap;

use crate::classify::{benchmark_family, classify_etf, EtfCategory};
use crate::data::bars::{series_key, AssetType};

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

/// 전체 ETF 코드 → 종목명 맵. `load_active_etfs`(거래대금 top-N·당일 스냅샷)와 달리
/// **필터 없이 코드별 '가장 최근 스냅샷의 kr_name'** 을 반환한다.
///
/// 존재 이유: 가격 cache(`DashMap`)는 한 번 적재된 종목을 영구 보관하는데, `names` 맵은
/// top-N·당일 스냅샷 ETF로만 만들어진다. 그래서 (1) 마스터 적재 지연으로 당일 스냅샷에
/// 아직 안 들어온 ETF, (2) 거래대금이 떨어져 top-100 밖으로 밀린 ETF 가 발굴 결과에
/// 나오면 종목명이 없어 raw series_key(`E:495050`)가 이름 자리에 노출됐다.
/// 이 맵으로 ETF 이름을 보강해 폴백 노출을 막는다. (예: 495050 → "RISE 코리아밸류업")
pub async fn load_all_etf_names(pool: &PgPool) -> Result<HashMap<String, String>, sqlx::Error> {
    let sql = r#"
        SELECT DISTINCT ON (etf_code) etf_code, kr_name
        FROM etf_master_daily
        WHERE kr_name IS NOT NULL AND kr_name != ''
        ORDER BY etf_code, snapshot_date DESC
    "#;
    let rows: Vec<(String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    Ok(rows.into_iter().collect())
}

/// ETF 분류 메타. `load_all_etf_names`와 같은 정책(코드별 최신 스냅샷)으로 로딩하되
/// 카테고리 태깅 + 기초지수 문자열까지 담는다. 발굴 결과 엔리치(페어 leg 분류, 베이시스형
/// 판정)에만 쓰이는 부가 메타 — 발굴 게이팅엔 개입 안 함.
#[derive(Debug, Clone)]
pub struct EtfMeta {
    pub category: EtfCategory,
    /// 원본 기초지수 문자열(빈 문자열 가능). 동일 기초지수 완전일치 베이시스 판정 키.
    pub underlying_index: String,
    /// 광범위 복제 패밀리(`KOSPI_BROAD`/`KOSDAQ_BROAD`) — 두 leg 일치 시 베이시스. 별상품은 None.
    pub family: Option<&'static str>,
}

/// 전체 ETF 메타 맵 — `series_key(Etf, code)`(=`E:{code}`) → EtfMeta.
///
/// `load_all_etf_names`와 동일 정책(필터 없이 코드별 가장 최근 스냅샷)으로 로딩해
/// 가격 cache에 잔존하는 ETF(top-N/당일 스냅샷 밖)까지 커버한다. 분류 후크 3개
/// (underlying_index·kr_name·replication)를 `classify_etf`에 넘겨 카테고리 확정.
pub async fn load_all_etf_meta(pool: &PgPool) -> Result<HashMap<String, EtfMeta>, sqlx::Error> {
    let sql = r#"
        SELECT DISTINCT ON (etf_code)
               etf_code, kr_name, COALESCE(underlying_index, '') AS ui, COALESCE(replication, '') AS repl
        FROM etf_master_daily
        WHERE kr_name IS NOT NULL AND kr_name != ''
        ORDER BY etf_code, snapshot_date DESC
    "#;
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(code, name, ui, repl)| {
            let category = classify_etf(&ui, &name, &repl);
            let family = benchmark_family(&ui, &name);
            (
                series_key(AssetType::Etf, &code),
                EtfMeta {
                    category,
                    underlying_index: ui,
                    family,
                },
            )
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
