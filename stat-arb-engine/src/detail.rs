//! 페어 상세 — 시계열 잔차/z + timeframe별 통계 + 히스토그램.
//!
//! `/pairs/detail?left=&right=` 응답 빌더.

use serde::Serialize;

use crate::data::bars::{aggregate, AssetSeries, Bar, Timeframe};
use crate::stats;

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
    /// timeframe 별 통계 — 데이터 부족하거나 fit 실패하면 빠짐.
    pub timeframes: Vec<TimeframeStat>,
    /// 일봉 기준 잔차 시계열 (전체 일자, 최대 ~250 point).
    pub spread_series: Vec<SpreadPoint>,
    /// 잔차 분포 히스토그램 — 일봉 잔차 기준.
    pub histogram: Vec<HistBin>,
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

/// raw timeframe (캐시에서 그대로) 통계.
fn timeframe_stat_raw(
    label: &'static str,
    left: &AssetSeries,
    right: &AssetSeries,
    tf: Timeframe,
) -> Option<TimeframeStat> {
    timeframe_stat_from_bars(label, left.bars(tf), right.bars(tf))
}

/// 집계 timeframe — 양쪽 시리즈를 base에서 N-bar 집계 후 통계.
fn timeframe_stat_aggregated(
    label: &'static str,
    left: &AssetSeries,
    right: &AssetSeries,
    base: Timeframe,
    multiplier: usize,
) -> Option<TimeframeStat> {
    let left_agg = aggregate(left.bars(base), multiplier);
    let right_agg = aggregate(right.bars(base), multiplier);
    timeframe_stat_from_bars(label, &left_agg, &right_agg)
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

pub fn build_pair_detail(
    left_key: String,
    right_key: String,
    left_name: String,
    right_name: String,
    left: &AssetSeries,
    right: &AssetSeries,
) -> Option<PairDetail> {
    // 일봉 시계열 — 응답의 메인 차트
    let (x_d, y_d, ts) = intersect_by_ts(left.bars(Timeframe::Day1), right.bars(Timeframe::Day1));
    if x_d.len() < 30 {
        return None;
    }
    let r = stats::ols(&x_d, &y_d)?;
    let resid = &r.residuals;
    let mean = resid.iter().sum::<f64>() / resid.len() as f64;
    let sigma = stats::stddev_pop(resid)?;
    let sigma_safe = if sigma.abs() < f64::EPSILON { 1.0 } else { sigma };

    let spread_series: Vec<SpreadPoint> = ts
        .iter()
        .zip(resid.iter())
        .map(|(t, e)| SpreadPoint {
            ts: *t,
            spread: *e,
            z: (e - mean) / sigma_safe,
        })
        .collect();

    let hist = histogram(resid, 30);

    // 8 timeframe 통계 — raw 3개 + 집계 5개. 데이터 부족 시 자연 None.
    //
    // raw: 30s(4/27~), 1m(1/2~4/24), 1d(1년)
    // 집계: 5m/30m/1h = bars_1m × N (sample 풍부)
    //       1w/1mo = bars_1d × N
    //
    // 단위 해석 (half_life 단위 = 그 timeframe의 단위):
    //   30s hl=120 → 120×30s = 1시간
    //   1m hl=60 → 60분 = 1시간
    //   5m hl=12 → 60분 = 1시간
    //   1d hl=3 → 3일
    //   1w hl=2 → 2주
    let mut timeframes: Vec<TimeframeStat> = Vec::new();
    if let Some(s) = timeframe_stat_raw("30s", left, right, Timeframe::Sec30) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_raw("1m", left, right, Timeframe::Min1) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_aggregated("5m", left, right, Timeframe::Min1, 5) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_aggregated("30m", left, right, Timeframe::Min1, 30) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_aggregated("1h", left, right, Timeframe::Min1, 60) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_raw("1d", left, right, Timeframe::Day1) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_aggregated("1w", left, right, Timeframe::Day1, 5) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat_aggregated("1mo", left, right, Timeframe::Day1, 21) {
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
    })
}
