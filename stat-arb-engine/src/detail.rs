//! 페어 상세 — 시계열 잔차/z + timeframe별 통계 + 히스토그램.
//!
//! `/pairs/detail?left=&right=` 응답 빌더.

use serde::Serialize;

use crate::data::bars::{bucket_ohlc, Bar};
use crate::stats;

// 인트라데이 버킷 크기 (ms). 헤드라인=10분. 비교표=1분/5분/10분/30분/1시간.
const BUCKET_1M_MS: i64 = 60 * 1000;
const BUCKET_5M_MS: i64 = 5 * 60 * 1000;
const BUCKET_10M_MS: i64 = 10 * 60 * 1000;
const BUCKET_30M_MS: i64 = 30 * 60 * 1000;
const BUCKET_1H_MS: i64 = 60 * 60 * 1000;

/// timeframe 1개 통계량 (1d, 1m 별로 각각).
#[derive(Debug, Clone, Serialize)]
pub struct TimeframeStat {
    pub timeframe: &'static str,
    pub sample_size: usize,
    pub hedge_ratio: f64,
    pub alpha: f64,
    pub r_squared: f64,
    pub adf_tstat: f64,
    pub half_life: f64,
    pub corr: f64,
    /// 현재 z-score (가장 최근 잔차의 표준화 값).
    pub z_score: f64,
}

/// 잔차 시계열 한 점.
#[derive(Debug, Clone, Serialize)]
pub struct SpreadPoint {
    pub ts: i64,
    pub spread: f64, // 잔차 그 자체 (원단위)
    pub z: f64,      // 표준화 (mean=0, std=1)
    pub left: f64,   // 그 시점 left(x) 종가 — 프론트 % 등락 차트용
    pub right: f64,  // 그 시점 right(y) 종가
}

/// 히스토그램 한 bin.
#[derive(Debug, Clone, Serialize)]
pub struct HistBin {
    /// bin 중심값 (잔차 단위).
    pub center: f64,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairDetail {
    pub left_key: String,
    pub right_key: String,
    pub left_name: String,
    pub right_name: String,
    /// timeframe 별 통계 (1분/5분/10분/30분/1시간 인트라데이) — 데이터 부족·fit 실패 시 빠짐.
    pub timeframes: Vec<TimeframeStat>,
    /// 10분 인트라데이 잔차 시계열 (일봉 종가 스파이크 배제). 헤드라인 차트.
    pub spread_series: Vec<SpreadPoint>,
    /// 잔차 분포 히스토그램 — 10분 인트라데이 잔차 기준.
    pub histogram: Vec<HistBin>,
    /// 헤드라인(10분) 잔차 정규화 기준 — 프론트 실시간 z를 차트 z와 동일 기준으로 맞추기 위함.
    /// z = (spread - spread_center) / spread_scale.
    pub spread_center: f64,
    pub spread_scale: f64,
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/// 두 bar 시리즈를 *timestamp 교집합*으로 align.
/// 단순화: 양쪽 다 ASC 정렬 가정. timestamp 일치하는 점만 추출.
fn intersect_by_ts(a: &[Bar], b: &[Bar]) -> (Vec<f64>, Vec<f64>, Vec<i64>) {
    let mut a_close = Vec::new();
    let mut b_close = Vec::new();
    let mut ts = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (ai, bj) = (&a[i], &b[j]);
        if ai.ts == bj.ts {
            a_close.push(ai.close);
            b_close.push(bj.close);
            ts.push(ai.ts);
            i += 1;
            j += 1;
        } else if ai.ts < bj.ts {
            i += 1;
        } else {
            j += 1;
        }
    }
    (a_close, b_close, ts)
}

/// 두 bar 시리즈를 받아 timestamp 교집합 + 통계 계산.
/// raw 시계열 (30s/1m/1d) 과 집계 시계열 (5m/30m/1h/1w/1mo) 둘 다 동일 시그니처로.
fn timeframe_stat_from_bars(
    label: &'static str,
    left_bars: &[Bar],
    right_bars: &[Bar],
) -> Option<TimeframeStat> {
    let (x, y, _ts) = intersect_by_ts(left_bars, right_bars);
    if x.len() < 30 {
        return None;
    }
    let x_ret: Vec<f64> = (1..x.len())
        .map(|i| if x[i - 1] > 0.0 && x[i] > 0.0 { (x[i] / x[i - 1]).ln() } else { 0.0 })
        .collect();
    let y_ret: Vec<f64> = (1..y.len())
        .map(|i| if y[i - 1] > 0.0 && y[i] > 0.0 { (y[i] / y[i - 1]).ln() } else { 0.0 })
        .collect();
    let corr = stats::pearson(&x_ret, &y_ret).unwrap_or(0.0);

    let r = stats::ols(&x, &y)?;
    let adf = stats::adf_tstat(&r.residuals).unwrap_or(0.0);
    let hl = stats::half_life(&r.residuals).unwrap_or(0.0);
    let z = stats::current_z(&r.residuals).unwrap_or(0.0);
    Some(TimeframeStat {
        timeframe: label,
        sample_size: x.len(),
        hedge_ratio: r.beta,
        alpha: r.alpha,
        r_squared: r.r_squared,
        adf_tstat: adf,
        half_life: hl,
        corr,
        z_score: z,
    })
}

fn histogram(values: &[f64], n_bins: usize) -> Vec<HistBin> {
    if values.is_empty() || n_bins == 0 {
        return Vec::new();
    }
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for v in values {
        if *v < min {
            min = *v;
        }
        if *v > max {
            max = *v;
        }
    }
    if !min.is_finite() || !max.is_finite() || (max - min).abs() < f64::EPSILON {
        return Vec::new();
    }
    let width = (max - min) / n_bins as f64;
    let mut counts = vec![0usize; n_bins];
    for v in values {
        let mut idx = ((v - min) / width).floor() as isize;
        if idx < 0 {
            idx = 0;
        }
        if idx >= n_bins as isize {
            idx = n_bins as isize - 1;
        }
        counts[idx as usize] += 1;
    }
    counts
        .iter()
        .enumerate()
        .map(|(i, c)| HistBin {
            center: min + width * (i as f64 + 0.5),
            count: *c,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 메인 빌더
// ---------------------------------------------------------------------------

/// `left_raw`/`right_raw` = stitched 인트라데이 raw (과거 1분봉 + 최근 30초봉, ts ASC).
/// 일봉(종가 단일가 스파이크)을 배제하고 인트라데이만 사용 — 사용자 결정 2026-06-19.
/// 헤드라인·차트는 10분 버킷(장 시작/마감 단일가 제외), 비교표는 1분/5분/10분/30분/1시간.
pub fn build_pair_detail(
    left_key: String,
    right_key: String,
    left_name: String,
    right_name: String,
    left_raw: &[Bar],
    right_raw: &[Bar],
    left_daily: &[Bar],
    right_daily: &[Bar],
) -> Option<PairDetail> {
    // 헤드라인 = 10분 버킷 시계열 (메인 차트 + KPI z 기준)
    let l10 = bucket_ohlc(left_raw, BUCKET_10M_MS);
    let r10 = bucket_ohlc(right_raw, BUCKET_10M_MS);
    let (x, y, ts) = intersect_by_ts(&l10, &r10);
    if x.len() < 30 {
        return None;
    }
    let r = stats::ols(&x, &y)?;
    let resid = &r.residuals;
    let mean = resid.iter().sum::<f64>() / resid.len() as f64;
    let sigma = stats::stddev_pop(resid)?;
    let sigma_safe = if sigma.abs() < f64::EPSILON { 1.0 } else { sigma };

    let spread_series: Vec<SpreadPoint> = ts
        .iter()
        .zip(resid.iter())
        .enumerate()
        .map(|(i, (t, e))| SpreadPoint {
            ts: *t,
            spread: *e,
            z: (e - mean) / sigma_safe,
            left: x[i],
            right: y[i],
        })
        .collect();

    let hist = histogram(resid, 30);

    // 비교표 — 전부 인트라데이 버킷 (일/주/월 제거). 10분은 위 헤드라인 OLS와 동일 입력이라 일관.
    let mut timeframes: Vec<TimeframeStat> = Vec::new();
    if let Some(s) = timeframe_stat_from_bars(
        "1m",
        &bucket_ohlc(left_raw, BUCKET_1M_MS),
        &bucket_ohlc(right_raw, BUCKET_1M_MS),
    ) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_from_bars(
        "5m",
        &bucket_ohlc(left_raw, BUCKET_5M_MS),
        &bucket_ohlc(right_raw, BUCKET_5M_MS),
    ) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_from_bars("10m", &l10, &r10) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_from_bars(
        "30m",
        &bucket_ohlc(left_raw, BUCKET_30M_MS),
        &bucket_ohlc(right_raw, BUCKET_30M_MS),
    ) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_from_bars(
        "1h",
        &bucket_ohlc(left_raw, BUCKET_1H_MS),
        &bucket_ohlc(right_raw, BUCKET_1H_MS),
    ) {
        timeframes.push(s);
    }
    // 일봉(1d) — 장기 관계(수일~수개월 회귀) + 발굴 기준과 일치. 캐시 bars_1d(adj_close, ~1년)
    // 그대로 (버킷 불필요, 당일 stitch 안 함 — 일봉은 장 마감 후 확정). 차트는 인트라데이 유지.
    if let Some(s) = timeframe_stat_from_bars("1d", left_daily, right_daily) {
        timeframes.push(s);
    }

    Some(PairDetail {
        left_key,
        right_key,
        left_name,
        right_name,
        timeframes,
        spread_series,
        histogram: hist,
        spread_center: mean,
        spread_scale: sigma_safe,
    })
}
