//! Bar 타입 + 자산 시계열 캐시 + PG 로더.
//!
//! ## 자산군 매핑 (Finance_Data PG)
//!
//! | AssetType   | 일봉 테이블           | 분봉 테이블             | 코드 컬럼                    |
//! |-------------|----------------------|------------------------|------------------------------|
//! | Stock / Etf | `ohlcv_daily`        | `ohlcv_intraday`       | `stock_code`                 |
//! | StockFuture | `futures_ohlcv_daily`| `futures_ohlcv_intraday`| `underlying_code`/`futures_code` |
//! | IndexFuture | `futures_ohlcv_daily`| `futures_ohlcv_intraday`| 동일 (contract_class 로 구분) |
//! | Index       | `index_ohlcv_daily`  | `index_ohlcv_intraday` | `code` / `index_code`        |
//!
//! intraday `interval_seconds` = 30 또는 60.
//!
//! Stock/Etf는 같은 테이블에서 가져옴 — 호출자가 AssetType을 외부에서 부여.
//! ETF 마스터(`etf_master_daily`) 에 해당 코드가 있으면 Etf, 아니면 Stock.

use chrono::{NaiveDate, TimeZone};
use dashmap::DashMap;
use serde::Serialize;
use sqlx::types::BigDecimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Bar {
    /// UNIX epoch milliseconds. 일봉은 해당 일자 15:30 KST 변환.
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: i64,
}

#[allow(dead_code)] // StockFuture/IndexFuture 는 PR3+에서 본격 사용
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum AssetType {
    Stock,
    Etf,
    StockFuture,
    IndexFuture,
    Index,
}

impl AssetType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AssetType::Stock => "S",
            AssetType::Etf => "E",
            AssetType::StockFuture => "SF",
            AssetType::IndexFuture => "IF",
            AssetType::Index => "I",
        }
    }
}

#[allow(dead_code)] // 통계 엔진 (PR3+) 에서 사용
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Timeframe {
    Sec30,
    Min1,
    Day1,
}

/// `Stock:005930`, `Etf:069500`, `SF:101S6000` 같은 prefix 키.
/// Stock과 Etf는 같은 6자리 코드 공간을 쓰지만 의미 다름 — 별도 entry.
pub fn series_key(asset_type: AssetType, code: &str) -> String {
    format!("{}:{}", asset_type.as_str(), code)
}

#[derive(Debug, Clone, Serialize)]
pub struct AssetSeries {
    pub code: String,
    pub asset_type: AssetType,
    pub bars_30s: Vec<Bar>,
    pub bars_1m: Vec<Bar>,
    pub bars_1d: Vec<Bar>,
    /// 마지막 갱신 시각 (UNIX ms).
    pub last_updated: i64,
}

#[allow(dead_code)] // empty/bars 헬퍼는 통계 모듈(PR3+)에서 사용
impl AssetSeries {
    pub fn empty(code: String, asset_type: AssetType) -> Self {
        Self {
            code,
            asset_type,
            bars_30s: Vec::new(),
            bars_1m: Vec::new(),
            bars_1d: Vec::new(),
            last_updated: 0,
        }
    }

    pub fn bars(&self, tf: Timeframe) -> &Vec<Bar> {
        match tf {
            Timeframe::Sec30 => &self.bars_30s,
            Timeframe::Min1 => &self.bars_1m,
            Timeframe::Day1 => &self.bars_1d,
        }
    }
}

pub type SeriesCache = Arc<DashMap<String, AssetSeries>>;

pub fn new_cache() -> SeriesCache {
    Arc::new(DashMap::new())
}

// ---------------------------------------------------------------------------
// PG 로더
// ---------------------------------------------------------------------------

/// 일봉의 의사 timestamp: 해당 일자 15:30 KST (장 마감 시점)을 UNIX ms 로.
fn day_close_ts(date: NaiveDate) -> i64 {
    chrono::FixedOffset::east_opt(9 * 3600)
        .and_then(|kst| {
            date.and_hms_opt(15, 30, 0).map(|dt| {
                kst.from_local_datetime(&dt)
                    .single()
                    .map(|t| t.timestamp_millis())
                    .unwrap_or(0)
            })
        })
        .unwrap_or(0)
}

fn bd_to_f64(v: Option<BigDecimal>) -> f64 {
    v.and_then(|b| f64::from_str(&b.to_string()).ok())
        .unwrap_or(0.0)
}

/// 일봉 cutoff 날짜를 Rust에서 계산. PG에 *상수 date*로 bind 해야
/// TimescaleDB chunk plan-time pruning이 작동 — `current_date - $param::int`
/// 같은 parameterized 표현은 모든 chunk를 plan에 포함시켜 lock 누적/메모리 폭주.
fn cutoff_date(days: i32) -> NaiveDate {
    chrono::Local::now().date_naive() - chrono::Duration::days(days as i64)
}

/// 일봉의 분봉용 cutoff (timestamp). 분봉 hypertable도 동일 이유로 *상수 timestamp* 필요.
fn cutoff_ts(days: i32) -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() - chrono::Duration::days(days as i64)
}

/// 주식/ETF 일봉. `days`일 전부터 오늘까지 ASC. (단일 종목)
pub async fn load_stock_daily(
    pool: &PgPool,
    code: &str,
    days: i32,
) -> Result<Vec<Bar>, sqlx::Error> {
    let sql = "SELECT time, open_price, high_price, low_price, close_price, COALESCE(volume, 0)
               FROM ohlcv_daily
               WHERE stock_code = $1 AND time >= $2
               ORDER BY time ASC";
    let rows: Vec<(NaiveDate, Option<i32>, Option<i32>, Option<i32>, Option<i32>, i64)> =
        sqlx::query_as(sql)
            .bind(code)
            .bind(cutoff_date(days))
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(t, o, h, l, c, v)| Bar {
            ts: day_close_ts(t),
            open: o.unwrap_or(0) as f64,
            high: h.unwrap_or(0) as f64,
            low: l.unwrap_or(0) as f64,
            close: c.unwrap_or(0) as f64,
            volume: v,
        })
        .collect())
}

/// 주식/ETF 분봉. `interval_sec` = 30 또는 60. `days`일 전부터 오늘까지 ASC. (단일 종목)
pub async fn load_stock_intraday(
    pool: &PgPool,
    code: &str,
    interval_sec: i16,
    days: i32,
) -> Result<Vec<Bar>, sqlx::Error> {
    let sql = "SELECT time, open, high, low, close, volume
               FROM ohlcv_intraday
               WHERE stock_code = $1 AND interval_seconds = $2 AND time >= $3
               ORDER BY time ASC";
    let rows: Vec<(
        chrono::DateTime<chrono::Utc>,
        BigDecimal,
        BigDecimal,
        BigDecimal,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(code)
        .bind(interval_sec)
        .bind(cutoff_ts(days))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(t, o, h, l, c, v)| Bar {
            ts: t.timestamp_millis(),
            open: bd_to_f64(Some(o)),
            high: bd_to_f64(Some(h)),
            low: bd_to_f64(Some(l)),
            close: bd_to_f64(Some(c)),
            volume: v,
        })
        .collect())
}

/// 선물 일봉. `code`는 `futures_code` (contract_code 아님).
/// 주식선물/지수선물 공용 — 호출자가 AssetType을 부여.
/// 본 테이블 키는 `(underlying_code, contract_class, time)`이라 contract_class 필요.
/// 일단 front month 한 가지만 보려면 `contract_class = 'F'` 기본.
pub async fn load_futures_daily(
    pool: &PgPool,
    underlying_code: &str,
    contract_class: &str,
    days: i32,
) -> Result<Vec<Bar>, sqlx::Error> {
    let sql = "SELECT time, open, high, low, close, COALESCE(volume, 0)
               FROM futures_ohlcv_daily
               WHERE underlying_code = $1 AND contract_class = $2 AND time >= $3
               ORDER BY time ASC";
    let rows: Vec<(
        NaiveDate,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        i64,
    )> = sqlx::query_as(sql)
        .bind(underlying_code)
        .bind(contract_class)
        .bind(cutoff_date(days))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(t, o, h, l, c, v)| Bar {
            ts: day_close_ts(t),
            open: bd_to_f64(o),
            high: bd_to_f64(h),
            low: bd_to_f64(l),
            close: bd_to_f64(c),
            volume: v,
        })
        .collect())
}

/// 선물 분봉. `futures_code`는 만기 포함 코드 (예: `101S6000`).
#[allow(dead_code)] // PR3+ 에서 사용 (선물 분봉 차익)
pub async fn load_futures_intraday(
    pool: &PgPool,
    futures_code: &str,
    interval_sec: i16,
    days: i32,
) -> Result<Vec<Bar>, sqlx::Error> {
    let sql = "SELECT time, open, high, low, close, volume
               FROM futures_ohlcv_intraday
               WHERE futures_code = $1 AND interval_seconds = $2 AND time >= $3
               ORDER BY time ASC";
    let rows: Vec<(
        chrono::DateTime<chrono::Utc>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(futures_code)
        .bind(interval_sec)
        .bind(cutoff_ts(days))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(t, o, h, l, c, v)| Bar {
            ts: t.timestamp_millis(),
            open: bd_to_f64(o),
            high: bd_to_f64(h),
            low: bd_to_f64(l),
            close: bd_to_f64(Some(c)),
            volume: v,
        })
        .collect())
}

/// 지수 일봉.
pub async fn load_index_daily(
    pool: &PgPool,
    code: &str,
    days: i32,
) -> Result<Vec<Bar>, sqlx::Error> {
    let sql = "SELECT time, open, high, low, close, COALESCE(volume, 0)
               FROM index_ohlcv_daily
               WHERE code = $1 AND time >= $2
               ORDER BY time ASC";
    let rows: Vec<(
        NaiveDate,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(code)
        .bind(cutoff_date(days))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(t, o, h, l, c, v)| Bar {
            ts: day_close_ts(t),
            open: bd_to_f64(o),
            high: bd_to_f64(h),
            low: bd_to_f64(l),
            close: bd_to_f64(Some(c)),
            volume: v,
        })
        .collect())
}

/// 지수 분봉.
pub async fn load_index_intraday(
    pool: &PgPool,
    code: &str,
    interval_sec: i16,
    days: i32,
) -> Result<Vec<Bar>, sqlx::Error> {
    let sql = "SELECT time, open, high, low, close, volume
               FROM index_ohlcv_intraday
               WHERE index_code = $1 AND interval_seconds = $2 AND time >= $3
               ORDER BY time ASC";
    let rows: Vec<(
        chrono::DateTime<chrono::Utc>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(code)
        .bind(interval_sec)
        .bind(cutoff_ts(days))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(t, o, h, l, c, v)| Bar {
            ts: t.timestamp_millis(),
            open: bd_to_f64(o),
            high: bd_to_f64(h),
            low: bd_to_f64(l),
            close: bd_to_f64(Some(c)),
            volume: v,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// 워밍업 — 캐시에 채워넣기
// ---------------------------------------------------------------------------

/// 자산 한 종목에 대해 시계열을 로드해서 캐시에 넣는다.
///
/// `with_intraday=false` 면 일봉만. 단일 종목 detail 조회용 (PR4a부터 universe 워밍업은 batch).
/// 향후 페어 상세/수동 검증 API에서 사용.
#[allow(dead_code)]
pub async fn warmup_one(
    pool: &PgPool,
    cache: &SeriesCache,
    code: &str,
    asset_type: AssetType,
    days_daily: i32,
    with_intraday: bool,
) -> Result<usize, sqlx::Error> {
    let (bars_30s, bars_1m, bars_1d) = match asset_type {
        AssetType::Stock | AssetType::Etf => {
            let d = load_stock_daily(pool, code, days_daily).await?;
            if with_intraday {
                let s30 = load_stock_intraday(pool, code, 30, 1).await?;
                let m1 = load_stock_intraday(pool, code, 60, 3).await?;
                (s30, m1, d)
            } else {
                (Vec::new(), Vec::new(), d)
            }
        }
        AssetType::StockFuture | AssetType::IndexFuture => {
            let d = load_futures_daily(pool, code, "F", days_daily).await?;
            (Vec::new(), Vec::new(), d)
        }
        AssetType::Index => {
            let d = load_index_daily(pool, code, days_daily).await?;
            if with_intraday {
                let s30 = load_index_intraday(pool, code, 30, 1).await?;
                let m1 = load_index_intraday(pool, code, 60, 3).await?;
                (s30, m1, d)
            } else {
                (Vec::new(), Vec::new(), d)
            }
        }
    };
    let total = bars_30s.len() + bars_1m.len() + bars_1d.len();
    let series = AssetSeries {
        code: code.to_string(),
        asset_type,
        bars_30s,
        bars_1m,
        bars_1d,
        last_updated: chrono::Utc::now().timestamp_millis(),
    };
    cache.insert(series_key(asset_type, code), series);
    Ok(total)
}

// ---------------------------------------------------------------------------
// Batch 로더 — universe 대량 워밍업용. 200 종목을 1 쿼리로.
// ---------------------------------------------------------------------------

/// 주식/ETF 일봉 batch. `codes` 배열을 PG `ANY($1)` 로 한 번에. 결과는 종목별 dict.
pub async fn load_stock_daily_batch(
    pool: &PgPool,
    codes: &[String],
    days: i32,
) -> Result<HashMap<String, Vec<Bar>>, sqlx::Error> {
    if codes.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = "SELECT stock_code, time, open_price, high_price, low_price, close_price, COALESCE(volume, 0)
               FROM ohlcv_daily
               WHERE stock_code = ANY($1) AND time >= $2
               ORDER BY stock_code, time ASC";
    let rows: Vec<(
        String,
        NaiveDate,
        Option<i32>,
        Option<i32>,
        Option<i32>,
        Option<i32>,
        i64,
    )> = sqlx::query_as(sql)
        .bind(codes)
        .bind(cutoff_date(days))
        .fetch_all(pool)
        .await?;
    let mut out: HashMap<String, Vec<Bar>> = HashMap::with_capacity(codes.len());
    for (code, t, o, h, l, c, v) in rows {
        out.entry(code).or_default().push(Bar {
            ts: day_close_ts(t),
            open: o.unwrap_or(0) as f64,
            high: h.unwrap_or(0) as f64,
            low: l.unwrap_or(0) as f64,
            close: c.unwrap_or(0) as f64,
            volume: v,
        });
    }
    Ok(out)
}

/// 주식/ETF 분봉 batch.
pub async fn load_stock_intraday_batch(
    pool: &PgPool,
    codes: &[String],
    interval_sec: i16,
    days: i32,
) -> Result<HashMap<String, Vec<Bar>>, sqlx::Error> {
    if codes.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = "SELECT stock_code, time, open, high, low, close, volume
               FROM ohlcv_intraday
               WHERE stock_code = ANY($1) AND interval_seconds = $2 AND time >= $3
               ORDER BY stock_code, time ASC";
    let rows: Vec<(
        String,
        chrono::DateTime<chrono::Utc>,
        BigDecimal,
        BigDecimal,
        BigDecimal,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(codes)
        .bind(interval_sec)
        .bind(cutoff_ts(days))
        .fetch_all(pool)
        .await?;
    let mut out: HashMap<String, Vec<Bar>> = HashMap::with_capacity(codes.len());
    for (code, t, o, h, l, c, v) in rows {
        out.entry(code).or_default().push(Bar {
            ts: t.timestamp_millis(),
            open: bd_to_f64(Some(o)),
            high: bd_to_f64(Some(h)),
            low: bd_to_f64(Some(l)),
            close: bd_to_f64(Some(c)),
            volume: v,
        });
    }
    Ok(out)
}

/// 지수 일봉 batch.
pub async fn load_index_daily_batch(
    pool: &PgPool,
    codes: &[String],
    days: i32,
) -> Result<HashMap<String, Vec<Bar>>, sqlx::Error> {
    if codes.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = "SELECT code, time, open, high, low, close, COALESCE(volume, 0)
               FROM index_ohlcv_daily
               WHERE code = ANY($1) AND time >= $2
               ORDER BY code, time ASC";
    let rows: Vec<(
        String,
        NaiveDate,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(codes)
        .bind(cutoff_date(days))
        .fetch_all(pool)
        .await?;
    let mut out: HashMap<String, Vec<Bar>> = HashMap::with_capacity(codes.len());
    for (code, t, o, h, l, c, v) in rows {
        out.entry(code).or_default().push(Bar {
            ts: day_close_ts(t),
            open: bd_to_f64(o),
            high: bd_to_f64(h),
            low: bd_to_f64(l),
            close: bd_to_f64(Some(c)),
            volume: v,
        });
    }
    Ok(out)
}

/// 지수 분봉 batch.
pub async fn load_index_intraday_batch(
    pool: &PgPool,
    codes: &[String],
    interval_sec: i16,
    days: i32,
) -> Result<HashMap<String, Vec<Bar>>, sqlx::Error> {
    if codes.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = "SELECT index_code, time, open, high, low, close, volume
               FROM index_ohlcv_intraday
               WHERE index_code = ANY($1) AND interval_seconds = $2 AND time >= $3
               ORDER BY index_code, time ASC";
    let rows: Vec<(
        String,
        chrono::DateTime<chrono::Utc>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        Option<BigDecimal>,
        BigDecimal,
        i64,
    )> = sqlx::query_as(sql)
        .bind(codes)
        .bind(interval_sec)
        .bind(cutoff_ts(days))
        .fetch_all(pool)
        .await?;
    let mut out: HashMap<String, Vec<Bar>> = HashMap::with_capacity(codes.len());
    for (code, t, o, h, l, c, v) in rows {
        out.entry(code).or_default().push(Bar {
            ts: t.timestamp_millis(),
            open: bd_to_f64(o),
            high: bd_to_f64(h),
            low: bd_to_f64(l),
            close: bd_to_f64(Some(c)),
            volume: v,
        });
    }
    Ok(out)
}

/// 지수 universe 워밍업 — 일봉 + 1분봉 + 30초봉 batch. 분봉 정책은 §12 참조.
pub async fn warmup_universe_indices_batch(
    pool: &PgPool,
    cache: &SeriesCache,
    codes: &[String],
    days_daily: i32,
    days_1m: i32,
    days_30s: i32,
) -> Result<(usize, usize), sqlx::Error> {
    let daily = load_index_daily_batch(pool, codes, days_daily).await?;
    let m1 = load_index_intraday_batch(pool, codes, 60, days_1m).await?;
    let s30 = load_index_intraday_batch(pool, codes, 30, days_30s).await?;

    let mut total_bars = 0usize;
    let mut series_count = 0usize;
    let now_ms = chrono::Utc::now().timestamp_millis();
    for code in codes {
        let bars_1d = daily.get(code).cloned().unwrap_or_default();
        let bars_1m = m1.get(code).cloned().unwrap_or_default();
        let bars_30s = s30.get(code).cloned().unwrap_or_default();
        let n = bars_1d.len() + bars_1m.len() + bars_30s.len();
        if n == 0 {
            continue;
        }
        total_bars += n;
        series_count += 1;
        let series = AssetSeries {
            code: code.clone(),
            asset_type: AssetType::Index,
            bars_30s,
            bars_1m,
            bars_1d,
            last_updated: now_ms,
        };
        cache.insert(series_key(AssetType::Index, code), series);
    }
    Ok((series_count, total_bars))
}

/// universe 전체를 batch 쿼리로 워밍업해서 캐시에 저장. asset_type은 호출자가 부여.
///
/// **분봉 정책 — stat-arb-engine.md §12 참조**:
/// Finance_Data DB는 시점 기준 분기 (2026-04-24까지 1분봉, 04-27부터 30초봉).
/// 합치지 않고 *raw 그대로*:
///   - `bars_30s`  : 30초봉 raw (4/27~, days_30s 일치)
///   - `bars_1m`   : 1분봉 raw (1/2~4/24, days_1m 일치) — 시간 지나면 자연 fade out
///   - `bars_1d`   : 일봉 raw (days_daily 일치)
///
/// 반환: (insert된 series 수, bar 총합)
pub async fn warmup_universe_stocks_batch(
    pool: &PgPool,
    cache: &SeriesCache,
    codes: &[String],
    asset_type: AssetType,
    days_daily: i32,
    days_1m: i32,
    days_30s: i32,
) -> Result<(usize, usize), sqlx::Error> {
    let daily = load_stock_daily_batch(pool, codes, days_daily).await?;
    let m1 = load_stock_intraday_batch(pool, codes, 60, days_1m).await?;
    let s30 = load_stock_intraday_batch(pool, codes, 30, days_30s).await?;

    let mut total_bars = 0usize;
    let mut series_count = 0usize;
    let now_ms = chrono::Utc::now().timestamp_millis();
    for code in codes {
        let bars_1d = daily.get(code).cloned().unwrap_or_default();
        let bars_1m = m1.get(code).cloned().unwrap_or_default();
        let bars_30s = s30.get(code).cloned().unwrap_or_default();
        let n = bars_1d.len() + bars_1m.len() + bars_30s.len();
        if n == 0 {
            continue;
        }
        total_bars += n;
        series_count += 1;
        let series = AssetSeries {
            code: code.clone(),
            asset_type,
            bars_30s,
            bars_1m,
            bars_1d,
            last_updated: now_ms,
        };
        cache.insert(series_key(asset_type, code), series);
    }
    Ok((series_count, total_bars))
}
