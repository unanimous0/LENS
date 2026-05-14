//! 페어 상세 — 시계열 잔차/z + timeframe별 통계 + 히스토그램.
//!
//! `/pairs/detail?left=&right=` 응답 빌더.

use serde::Serialize;

use crate::data::bars::{AssetSeries, Bar, Timeframe};
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

/// timeframe 한 가지에 대한 통계만 계산 (시계열은 일봉만 별도로).
fn timeframe_stat(
    label: &'static str,
    left: &AssetSeries,
    right: &AssetSeries,
    tf: Timeframe,
) -> Option<TimeframeStat> {
    let (x, y, _ts) = intersect_by_ts(left.bars(tf), right.bars(tf));
    if x.len() < 30 {
        return None;
    }
    // 로그수익률 correlation (사전 신뢰도 표시용).
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

    // timeframes 별 통계 (1d 는 이미 위에서 계산했지만 깔끔히 다시)
    let mut timeframes: Vec<TimeframeStat> = Vec::new();
    if let Some(s) = timeframe_stat("1d", left, right, Timeframe::Day1) {
        timeframes.push(s);
    }
    if let Some(s) = timeframe_stat("1m", left, right, Timeframe::Min1) {
        timeframes.push(s);
    }
    // 30s 는 universe 워밍업에 안 들어옴 — 결과 빈 vec.
    if let Some(s) = timeframe_stat("30s", left, right, Timeframe::Sec30) {
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
