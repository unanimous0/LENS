//! 도메인 그룹 — 통계 페어 발굴 범위 제한자.
//!
//! 자동 생성:
//!   - Index  : index_components 의 KOSPI200 / KOSDAQ150
//!   - Sector : stock_sectors.fics_sector (FICS 분류). 멤버 N개 이상만.
//!   - Etf    : etf_master_daily + etf_portfolio_daily 최신 snapshot. ETF 자체 + 그 PDF.
//!
//! 그룹 멤버는 *series_key* (자산군 prefix 포함) 형태로 저장 — `S:005930`, `E:069500`.

use chrono::NaiveDate;
use serde::Serialize;
use sqlx::PgPool;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    Index,
    Sector,
    Etf,
}

impl GroupKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            GroupKind::Index => "index",
            GroupKind::Sector => "sector",
            GroupKind::Etf => "etf",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Group {
    /// `index:KOSPI200`, `sector:화학`, `etf:069500` 등.
    pub id: String,
    pub name: String,
    pub kind: GroupKind,
    /// series_key 형태 (S:005930, E:069500 등).
    pub members: Vec<String>,
    pub member_count: usize,
}

impl Group {
    fn new(id: String, name: String, kind: GroupKind, members: Vec<String>) -> Self {
        let member_count = members.len();
        Self {
            id,
            name,
            kind,
            members,
            member_count,
        }
    }
}

// ---------------------------------------------------------------------------

pub async fn load_index_groups(pool: &PgPool) -> Result<Vec<Group>, sqlx::Error> {
    let sql = "SELECT index_name, stock_code
               FROM index_components
               WHERE (end_date IS NULL OR end_date > current_date)
                 AND index_name IN ('KOSPI200', 'KOSDAQ150')
               ORDER BY index_name, stock_code";
    let rows: Vec<(String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for (idx, code) in rows {
        grouped.entry(idx).or_default().push(format!("S:{code}"));
    }
    let mut out: Vec<Group> = grouped
        .into_iter()
        .map(|(name, members)| {
            Group::new(
                format!("index:{name}"),
                name.clone(),
                GroupKind::Index,
                members,
            )
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub async fn load_sector_groups(
    pool: &PgPool,
    min_members: usize,
) -> Result<Vec<Group>, sqlx::Error> {
    // is_active=true 인 종목만 — delisted 종목은 통계 페어 의미 없음.
    let sql = "SELECT ss.fics_sector, ss.stock_code
               FROM stock_sectors ss
               JOIN stocks s ON s.stock_code = ss.stock_code
               WHERE ss.fics_sector IS NOT NULL AND ss.fics_sector != ''
                 AND s.is_active = true
               ORDER BY ss.fics_sector, ss.stock_code";
    let rows: Vec<(String, String)> = sqlx::query_as(sql).fetch_all(pool).await?;
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for (sector, code) in rows {
        grouped.entry(sector).or_default().push(format!("S:{code}"));
    }
    let mut out: Vec<Group> = grouped
        .into_iter()
        .filter(|(_, m)| m.len() >= min_members)
        .map(|(sector, members)| {
            Group::new(
                format!("sector:{sector}"),
                sector.clone(),
                GroupKind::Sector,
                members,
            )
        })
        .collect();
    out.sort_by(|a, b| b.member_count.cmp(&a.member_count));
    Ok(out)
}

pub async fn load_etf_groups(
    pool: &PgPool,
    min_members: usize,
) -> Result<Vec<Group>, sqlx::Error> {
    // 최신 snapshot_date — master/portfolio 양쪽 공통 가용 일자.
    let latest: Option<NaiveDate> = sqlx::query_scalar(
        "SELECT LEAST(
            (SELECT MAX(snapshot_date) FROM etf_master_daily),
            (SELECT MAX(snapshot_date) FROM etf_portfolio_daily)
        )",
    )
    .fetch_one(pool)
    .await?;
    let Some(snap) = latest else {
        return Ok(Vec::new());
    };

    // ETF 마스터 + PDF 조인 — 한 번에.
    let sql = "SELECT m.etf_code, m.kr_name, p.component_code
               FROM etf_master_daily m
               JOIN etf_portfolio_daily p
                 ON p.etf_code = m.etf_code AND p.snapshot_date = m.snapshot_date
               WHERE m.snapshot_date = $1
                 AND p.is_cash = false
                 AND p.shares > 0
                 AND p.component_code ~ '^[0-9A-Z]{6}$'  -- 6자리 정상 종목코드만 (CASH/원화 등 제외)
               ORDER BY m.etf_code, p.component_code";
    let rows: Vec<(String, Option<String>, String)> =
        sqlx::query_as(sql).bind(snap).fetch_all(pool).await?;

    let mut grouped: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for (etf_code, etf_name, component_code) in rows {
        let entry = grouped.entry(etf_code.clone()).or_insert_with(|| {
            (
                etf_name.unwrap_or_default(),
                vec![format!("E:{etf_code}")], // ETF 자체도 멤버
            )
        });
        entry.1.push(format!("S:{component_code}"));
    }

    let mut out: Vec<Group> = grouped
        .into_iter()
        .filter(|(_, (_, m))| m.len() >= min_members)
        .map(|(code, (name, members))| {
            let display = if name.is_empty() {
                code.clone()
            } else {
                name
            };
            Group::new(
                format!("etf:{code}"),
                display,
                GroupKind::Etf,
                members,
            )
        })
        .collect();
    out.sort_by(|a, b| b.member_count.cmp(&a.member_count));
    Ok(out)
}

/// 모든 종류의 그룹을 한 번에 자동 생성.
pub async fn load_all_groups(pool: &PgPool) -> Result<Vec<Group>, sqlx::Error> {
    // 동시 3 쿼리 — 작은 쿼리들이라 PG 부담 없음.
    let (idx, sec, etf) = tokio::try_join!(
        load_index_groups(pool),
        load_sector_groups(pool, 3),
        load_etf_groups(pool, 5),
    )?;
    let mut all = Vec::with_capacity(idx.len() + sec.len() + etf.len());
    all.extend(idx);
    all.extend(sec);
    all.extend(etf);
    Ok(all)
}
