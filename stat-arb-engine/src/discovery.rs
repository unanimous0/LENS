//! 1:1 페어 발굴.
//!
//! 알고리즘:
//!  1. 사전 필터 — log-가격 1차차분(=로그수익률)의 Pearson |r| > MIN_CORR
//!  2. OLS hedge ratio (y = α + βx + ε)
//!  3. ADF on residuals — t-stat < ADF_CRIT_5
//!  4. half-life of residuals (양수면 발산 → 탈락)
//!  5. 점수 score = -adf_tstat × (1/half_life) × |corr|  (높을수록 좋음)
//!
//! 결과는 PairsState 에 score 내림차순으로 저장.

use serde::Serialize;

use crate::data::bars::{AssetSeries, SeriesCache, Timeframe};
use crate::stats;

// 필터 임계값. 일봉 기준. 1년치 (영업일 ~252) 가정.
//
// PR3 (90일/sample 60) → PR4a (365일/sample 250) 로 확장하면서 임계 강화:
//   MIN_SAMPLES   60 → 150     — 통계 신뢰도 확보
//   ADF_CRIT      -2.89 → -3.0 — 5% → 약 1%~2% 유의수준 (보수적)
//   MIN_HALF_LIFE 신규 3일      — 1일 미만은 데이터 끝점 우연 가능성
//   MAX_HALF_LIFE 60 → 90      — 1년 데이터면 더 긴 회귀도 합리적
const MIN_CORR: f64 = 0.5;
const ADF_CRIT: f64 = -3.0;
const MIN_SAMPLES: usize = 150;
const MIN_HALF_LIFE: f64 = 3.0;
const MAX_HALF_LIFE: f64 = 90.0;

#[derive(Debug, Clone, Serialize)]
pub struct PairResult {
    pub left_key: String,
    pub right_key: String,
    pub left_name: String,
    pub right_name: String,
    pub timeframe: String,
    pub corr: f64,
    pub hedge_ratio: f64,  // β
    pub alpha: f64,
    pub adf_tstat: f64,
    pub half_life: f64,
    pub r_squared: f64,
    pub z_score: f64,      // 현재 잔차의 z
    pub sample_size: usize,
    pub score: f64,
}

/// 시리즈의 일봉 종가만 추출. 길이 < MIN_SAMPLES 면 None.
fn closes_daily(series: &AssetSeries) -> Option<Vec<f64>> {
    let bars = series.bars(Timeframe::Day1);
    if bars.len() < MIN_SAMPLES {
        return None;
    }
    Some(bars.iter().map(|b| b.close).collect())
}

/// 두 시리즈 길이 맞춰서 마지막 n개만 — 두 시리즈가 정렬돼 있다고 가정 (ASC by time).
/// 단순화: 둘의 최소 길이만큼 *오른쪽 정렬* (가장 최근 데이터).
/// 실제로는 timestamp 기준 join이 정확. PR3는 동일 시장 동일 영업일 가정으로 단순 정렬.
fn align_tail(a: &[f64], b: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let n = a.len().min(b.len());
    (a[a.len() - n..].to_vec(), b[b.len() - n..].to_vec())
}

/// 가격 → 로그수익률 (사전 필터용).
fn log_returns(prices: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(prices.len().saturating_sub(1));
    for i in 1..prices.len() {
        if prices[i - 1] > 0.0 && prices[i] > 0.0 {
            out.push((prices[i] / prices[i - 1]).ln());
        } else {
            out.push(0.0);
        }
    }
    out
}

/// 하나의 페어 (a, b) 평가. 통계량 통과하면 PairResult.
fn evaluate_pair(
    a_key: &str,
    a_name: &str,
    a_closes: &[f64],
    b_key: &str,
    b_name: &str,
    b_closes: &[f64],
) -> Option<PairResult> {
    let (a, b) = align_tail(a_closes, b_closes);
    if a.len() < MIN_SAMPLES {
        return None;
    }

    // 1. 사전 필터: 로그수익률 correlation
    let a_ret = log_returns(&a);
    let b_ret = log_returns(&b);
    let corr = stats::pearson(&a_ret, &b_ret)?;
    if corr.abs() < MIN_CORR {
        return None;
    }

    // 2. OLS: y = b, x = a → β = hedge ratio
    let r = stats::ols(&a, &b)?;
    if r.r_squared < 0.3 {
        // 잔차가 너무 큼 — cointegration 가능성 낮음
        return None;
    }

    // 3. ADF on residuals
    let adf = stats::adf_tstat(&r.residuals)?;
    if adf > ADF_CRIT {
        return None;
    }

    // 4. half-life — 너무 짧으면 우연, 너무 길면 활용 불가
    let hl = stats::half_life(&r.residuals)?;
    if !hl.is_finite() || hl < MIN_HALF_LIFE || hl > MAX_HALF_LIFE {
        return None;
    }

    // 5. 현재 z-score
    let z = stats::current_z(&r.residuals)?;

    // score: ADF가 음수일수록 좋음, half-life 작을수록 좋음, |corr| 클수록 좋음
    let score = (-adf) * (1.0 / hl) * corr.abs();

    Some(PairResult {
        left_key: a_key.to_string(),
        right_key: b_key.to_string(),
        left_name: a_name.to_string(),
        right_name: b_name.to_string(),
        timeframe: "1d".into(),
        corr,
        hedge_ratio: r.beta,
        alpha: r.alpha,
        adf_tstat: adf,
        half_life: hl,
        r_squared: r.r_squared,
        z_score: z,
        sample_size: a.len(),
        score,
    })
}

/// 시장 전체 1:1 발굴.
/// 캐시에 들어있는 모든 시리즈를 양방향 페어로 평가. 통과 페어만 반환.
/// 양/음 부호 페어를 별도로 보지 않음 (절댓값으로 corr 봄, β 음수면 short 페어).
pub fn discover_all_one_to_one(
    cache: &SeriesCache,
    names: &std::collections::HashMap<String, String>,
) -> Vec<PairResult> {
    // 1단계: 캐시에서 일봉 closes 추출.
    let mut series_data: Vec<(String, Vec<f64>)> = Vec::new();
    for entry in cache.iter() {
        if let Some(closes) = closes_daily(entry.value()) {
            series_data.push((entry.key().clone(), closes));
        }
    }
    let n_series = series_data.len();
    tracing::info!("[discovery] 1:1 후보 시리즈 {} 개", n_series);

    let mut out: Vec<PairResult> = Vec::new();
    for i in 0..n_series {
        for j in (i + 1)..n_series {
            let (a_key, a_closes) = &series_data[i];
            let (b_key, b_closes) = &series_data[j];
            let a_name = names.get(a_key).cloned().unwrap_or_else(|| a_key.clone());
            let b_name = names.get(b_key).cloned().unwrap_or_else(|| b_key.clone());
            if let Some(pair) = evaluate_pair(a_key, &a_name, a_closes, b_key, &b_name, b_closes) {
                out.push(pair);
            }
        }
    }

    // score 내림차순.
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    tracing::info!("[discovery] 통과 페어 {} 개 (시리즈 {} 중)", out.len(), n_series);
    out
}
