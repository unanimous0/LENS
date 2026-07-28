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

// --- Kalman 시변 β (관계 안정성 감지) 튜닝 상수 ---------------------------------
// 이 상수·판정 규칙은 상세 패널(KalmanStat)과 목록 플래그(PairResult.stability)가
// 공유한다 — 단일 진입점은 `compute_stability()`. 임계를 바꾸면 양쪽이 동시에 바뀐다.
// δ = 상태 전이 분산 Q = δ·I. 튜닝 포인트: 너무 작으면 β 정적 OLS와 동일하게 얼어붙고,
// 너무 크면 β가 관측 노이즈를 좇아 요동. 일봉 raw 가격 레벨(원 단위) 기준 경험값.
const KALMAN_DELTA: f64 = 1e-4;
// 안정성 판정 임계 (튜닝 포인트). drift_pct = |β_current−β_static|/|β_static|, z_gap = |z_static−z_adaptive|.
//
// β_drift 는 관계 "기울기(헤지비율)" 구조 변화의 독립 지표 → 안정성의 1차 판정축.
// z_gap 은 정적 z(3년 고정) 대비 적응모델(Kalman)이 본 현재 편차의 괴리.
//   실측: 적응 z(1-step std_innov)는 random-walk 절편 α가 레벨을 항상 추종해 거의 항상 ≈0
//   (표본 전반 −0.5~+0.4). 따라서 z_gap ≈ |z_static| 로 수렴한다.
//   정상 페어도 당일 |z_static|이 1~2까지 흔히 나오므로 임계 1/2는 건강한 페어를 오분류(과경보).
//   → z_gap 은 사용자 경보 시나리오(정적 z≈−3.85인데 재레벨링)처럼 *극단* 괴리에서만 승격시킨다.
const DRIFT_PCT_CAUTION: f64 = 0.10; // β 10% 이상 변동 → 주의 (구조적 슬로프 변화)
const DRIFT_PCT_DRIFT: f64 = 0.20; // β 20% 이상 → 드리프트
const Z_GAP_CAUTION: f64 = 2.0; // 정적/적응 z 괴리 2σ 이상 → 주의 (정적 z가 상당히 stale)
const Z_GAP_DRIFT: f64 = 3.0; //  3σ 이상 → 드리프트 (정적 z가 심하게 과대 = 재레벨링)
// β 스파크라인 다운샘플 상한 (프론트 전송 경량화).
const BETA_SERIES_MAX: usize = 200;

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

/// Kalman β_t 스파크라인 한 점.
#[derive(Debug, Clone, Serialize)]
pub struct BetaPoint {
    pub ts: i64,
    pub beta: f64,
}

/// Kalman 시변 헤지비율 요약 — 관계 안정성(β 드리프트) 감지. 일봉 기준.
///
/// 정적 OLS β는 3년 전체 표본 1벌. Kalman은 매일 β_t·α_t를 적응 갱신 →
/// 관계가 최근 재레벨링/드리프트하면 β_current가 β_static에서 벌어지고,
/// 적응모델 기준 z(z_adaptive)가 정적 z(z_static)와 괴리한다.
#[derive(Debug, Clone, Serialize)]
pub struct KalmanStat {
    /// 적응 β 마지막값.
    pub beta_current: f64,
    /// 전체표본 OLS β (정적).
    pub beta_static: f64,
    /// |β_current − β_static| / |β_static| (0.15 = 15%).
    pub beta_drift_pct: f64,
    /// 정적 z (OLS 잔차 current_z) = timeframes[1d].z_score 와 동일.
    pub z_static: f64,
    /// 적응모델 기준 z (std_innov 마지막값).
    pub z_adaptive: f64,
    /// |z_static − z_adaptive|.
    pub z_gap: f64,
    /// "stable" | "caution" | "drift".
    pub stability: String,
    /// (ts, β) 스파크라인 — 최대 BETA_SERIES_MAX 점으로 균등 다운샘플.
    pub beta_series: Vec<BetaPoint>,
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
    /// 일봉(1d) 잔차 시계열 (adj_close, ~3년). 일봉 기준 헤드라인 차트 — 스윙 판단용.
    /// OLS α·β는 `timeframes`의 "1d" stat과 동일 입력이라 자동 일관. 표본 부족 시 빈 벡터.
    #[serde(default)]
    pub spread_series_daily: Vec<SpreadPoint>,
    /// 일봉 잔차 분포 히스토그램.
    #[serde(default)]
    pub histogram_daily: Vec<HistBin>,
    /// 일봉 잔차 정규화 기준. z = (spread - daily_center) / daily_scale. 표본 부족 시 0.
    #[serde(default)]
    pub daily_center: f64,
    #[serde(default)]
    pub daily_scale: f64,
    /// Kalman 시변 β 요약 (관계 안정성). 일봉 표본<30 또는 필터 실패 시 None.
    #[serde(default)]
    pub kalman: Option<KalmanStat>,
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/// 두 bar 시리즈를 *timestamp 교집합*으로 align.
/// 단순화: 양쪽 다 ASC 정렬 가정. timestamp 일치하는 점만 추출.
///
/// **양쪽 종가가 모두 양수인 시점만** 채택한다 — 비양수 가격은 레벨 OLS 의 지렛대 점이자
/// 로그수익률의 정의역 밖이다. 로더(`data::bars`)가 결측 봉을 버리므로 정상 운영에선
/// 발동하지 않고, 캐시 불변식의 방어선으로만 존재한다.
fn intersect_by_ts(a: &[Bar], b: &[Bar]) -> (Vec<f64>, Vec<f64>, Vec<i64>) {
    let mut a_close = Vec::new();
    let mut b_close = Vec::new();
    let mut ts = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (ai, bj) = (&a[i], &b[j]);
        if ai.ts == bj.ts {
            if ai.close > 0.0 && bj.close > 0.0 {
                a_close.push(ai.close);
                b_close.push(bj.close);
                ts.push(ai.ts);
            }
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
    // `intersect_by_ts` 가 양수 종가만 통과시키므로 여기 ln 은 항상 정의된다
    // (예전의 `else { 0.0 }` 치환 = 결측일을 "수익률 0%" 관측으로 위조하던 경로. 제거됨).
    let x_ret: Vec<f64> = (1..x.len()).map(|i| (x[i] / x[i - 1]).ln()).collect();
    let y_ret: Vec<f64> = (1..y.len()).map(|i| (y[i] / y[i - 1]).ln()).collect();
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

/// 헤드라인 잔차 시계열 빌더 — intersect → OLS → 잔차 시계열/히스토그램/정규화 기준(center·scale).
/// 10분 버킷·일봉 어느 입력이든 동일 패턴. 표본(교집합) < 30 이거나 fit 실패 시 None.
///
/// M:N 상세(`mn_detail`)도 **합성 leg 을 Bar 로 포장해** 이 함수를 그대로 쓴다 —
/// 차트·히스토그램·정규화 기준 산식을 1:1 과 1벌로 유지하기 위함.
pub(crate) fn build_headline(
    left_bars: &[Bar],
    right_bars: &[Bar],
) -> Option<(Vec<SpreadPoint>, Vec<HistBin>, f64, f64)> {
    let (x, y, ts) = intersect_by_ts(left_bars, right_bars);
    if x.len() < 30 {
        return None;
    }
    let r = stats::ols(&x, &y)?;
    let resid = &r.residuals;
    let mean = resid.iter().sum::<f64>() / resid.len() as f64;
    let sigma = stats::stddev_pop(resid)?;
    let sigma_safe = if sigma.abs() < f64::EPSILON { 1.0 } else { sigma };

    let series: Vec<SpreadPoint> = ts
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
    Some((series, hist, mean, sigma_safe))
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

/// 관계 안정성 지표 — Kalman 시변 β 기반. 상세 패널(KalmanStat)과 목록 플래그가
/// **같은 산식·같은 임계**를 쓰도록 하는 공용 계산 결과.
#[derive(Debug, Clone)]
pub struct StabilityMetrics {
    pub beta_current: f64,
    pub beta_static: f64,
    pub beta_drift_pct: f64,
    pub z_static: f64,
    pub z_adaptive: f64,
    pub z_gap: f64,
    /// "stable" | "caution" | "drift".
    pub stability: &'static str,
    /// β_t 스파크라인 — `with_series=false`(목록 경로)면 빈 벡터.
    pub beta_series: Vec<BetaPoint>,
}

/// (β 드리프트, z 괴리) → 안정성 등급. OR 규칙: 둘 중 하나라도 임계 초과하면 승격.
/// 판정 규칙은 여기 한 곳뿐 — 상세/목록 분기 없음.
fn classify_stability(beta_drift_pct: f64, z_gap: f64) -> &'static str {
    if beta_drift_pct > DRIFT_PCT_DRIFT || z_gap > Z_GAP_DRIFT {
        "drift"
    } else if beta_drift_pct > DRIFT_PCT_CAUTION || z_gap > Z_GAP_CAUTION {
        "caution"
    } else {
        "stable"
    }
}

/// Kalman 상태전이 분산 Q = δ·I 의 δ 지정 방식.
///
/// δ 는 **입력 스케일에 종속**이다 (β 한 스텝 이동폭 ≈ √δ, α 도 마찬가지).
/// 1:1 은 원 단위 raw 가격(x~5만, 잔차~수백원), M:N 은 합성 로그가격(x~10, 잔차~0.0x)이라
/// 같은 절대 δ 를 쓰면 두 경로의 적응 속도가 수천만 배 어긋난다.
#[derive(Debug, Clone, Copy)]
pub enum KalmanDelta {
    /// 절대 δ — 일봉 raw 가격 레벨(원 단위) 기준 경험값. **1:1 경로 전용**(목록·상세 판정 불변 계약).
    Absolute(f64),
    /// 스케일 상대 δ — x·y 를 각각 표준화한 공간에서의 δ.
    ///
    /// 표준화하면 x'~N(0,1), y'~N(0,1), R' = (1−R²) 가 되어 δ 가 x·y 스케일 양쪽에 불변이 된다
    /// (Q/R 비만 맞추는 방식은 x 스케일에 여전히 종속 — 게인이 x²·P/(x²·P+R) 이라서).
    /// 필터는 표준화 공간에서 돌리고 β_t 만 σ_y/σ_x 로 되돌려 원 스케일 β 로 보고한다.
    Relative(f64),
}

/// 관계 안정성 지표 본체 — align 된 (x, y, ts) 위에서 정적 OLS vs Kalman 적응 β 비교.
/// 판정 임계·산식은 δ 방식과 무관하게 1벌.
fn stability_metrics(
    x: &[f64],
    y: &[f64],
    ts: &[i64],
    delta: KalmanDelta,
    with_series: bool,
) -> Option<StabilityMetrics> {
    if x.len() < 30 {
        return None;
    }
    let ols = stats::ols(x, y)?;
    // R = OLS 잔차 분산 (모집단 σ²).
    let obs_var = stats::stddev_pop(&ols.residuals)?.powi(2);
    let z_static = stats::current_z(&ols.residuals)?;
    // β_t 를 원 스케일로 되돌리는 배율 (표준화 공간에서 돌렸을 때만 ≠ 1).
    let (kf, beta_scale) = match delta {
        KalmanDelta::Absolute(d) => (stats::kalman_hedge(x, y, d, obs_var)?, 1.0),
        KalmanDelta::Relative(d) => {
            let (mx, sx) = mean_sd(x)?;
            let (my, sy) = mean_sd(y)?;
            let xs: Vec<f64> = x.iter().map(|v| (v - mx) / sx).collect();
            let ys: Vec<f64> = y.iter().map(|v| (v - my) / sy).collect();
            // 표준화 잔차 분산 = obs_var / σ_y². y' = β'x' + α' 의 β' = β·σ_x/σ_y.
            (stats::kalman_hedge(&xs, &ys, d, obs_var / (sy * sy))?, sy / sx)
        }
    };

    let beta_current = *kf.beta.last()? * beta_scale;
    let beta_static = ols.beta;
    let beta_drift_pct = if beta_static.abs() > f64::EPSILON {
        (beta_current - beta_static).abs() / beta_static.abs()
    } else {
        0.0
    };
    let z_adaptive = *kf.std_innov.last()?;
    let z_gap = (z_static - z_adaptive).abs();

    // β 스파크라인 — 균등 다운샘플 (마지막 점 반드시 포함) 후 원 스케일 환원.
    let mut beta_series = if with_series {
        downsample_beta(ts, &kf.beta, BETA_SERIES_MAX)
    } else {
        Vec::new()
    };
    if beta_scale != 1.0 {
        for p in &mut beta_series {
            p.beta *= beta_scale;
        }
    }

    Some(StabilityMetrics {
        beta_current,
        beta_static,
        beta_drift_pct,
        z_static,
        z_adaptive,
        z_gap,
        stability: classify_stability(beta_drift_pct, z_gap),
        beta_series,
    })
}

/// 평균·모표준편차. σ≈0(상수 시리즈)이면 None.
fn mean_sd(v: &[f64]) -> Option<(f64, f64)> {
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    let sd = stats::stddev_pop(v)?;
    if sd < f64::EPSILON {
        return None;
    }
    Some((mean, sd))
}

/// 일봉 raw 가격 레벨로 Kalman 시변 β 지표 산출. 표본<30 또는 필터 실패 시 None.
/// 발굴·정적 z와 동일하게 raw close 교집합(잔차=원 단위) 기준 — basis 토글 무관 일봉 고정.
///
/// `with_series`=true 면 β_t 스파크라인까지 채운다(상세 패널). 목록 엔리치는 false —
/// 3천여 페어에 대해 다운샘플 벡터를 만들지 않는다.
pub fn compute_stability(
    left_daily: &[Bar],
    right_daily: &[Bar],
    with_series: bool,
) -> Option<StabilityMetrics> {
    let (x, y, ts) = intersect_by_ts(left_daily, right_daily);
    stability_metrics(&x, &y, &ts, KalmanDelta::Absolute(KALMAN_DELTA), with_series)
}

/// 상세 응답용 래핑 — 계산은 `stability_metrics` 1벌. δ 방식만 호출자가 고른다
/// (1:1 = 절대 δ 고정, M:N 합성 로그가격 = 상대 δ).
pub(crate) fn build_kalman_stat_with(
    left_daily: &[Bar],
    right_daily: &[Bar],
    delta: KalmanDelta,
) -> Option<KalmanStat> {
    let (x, y, ts) = intersect_by_ts(left_daily, right_daily);
    let m = stability_metrics(&x, &y, &ts, delta, true)?;
    Some(KalmanStat {
        beta_current: m.beta_current,
        beta_static: m.beta_static,
        beta_drift_pct: m.beta_drift_pct,
        z_static: m.z_static,
        z_adaptive: m.z_adaptive,
        z_gap: m.z_gap,
        stability: m.stability.to_string(),
        beta_series: m.beta_series,
    })
}

/// 1:1 상세 응답용 — 절대 δ 고정(기존 판정값 불변 계약).
fn build_kalman_stat(left_daily: &[Bar], right_daily: &[Bar]) -> Option<KalmanStat> {
    build_kalman_stat_with(left_daily, right_daily, KalmanDelta::Absolute(KALMAN_DELTA))
}

/// (ts, beta) → 최대 `max` 점으로 균등 다운샘플. 마지막 점 포함.
fn downsample_beta(ts: &[i64], beta: &[f64], max: usize) -> Vec<BetaPoint> {
    let n = ts.len().min(beta.len());
    if n == 0 {
        return Vec::new();
    }
    if n <= max || max < 2 {
        return (0..n).map(|i| BetaPoint { ts: ts[i], beta: beta[i] }).collect();
    }
    let step = (n - 1) as f64 / (max - 1) as f64;
    (0..max)
        .map(|k| {
            let i = ((k as f64) * step).round() as usize;
            let i = i.min(n - 1);
            BetaPoint { ts: ts[i], beta: beta[i] }
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
    let (spread_series, hist, mean, sigma_safe) = build_headline(&l10, &r10)?;

    // 일봉(1d) 헤드라인 — 스윙 판단 기준. left_daily/right_daily(adj_close, ~3년).
    // OLS α·β는 아래 "1d" timeframe stat과 동일 입력이라 자동 일관. 표본 부족 시 빈 벡터/0으로 graceful.
    let (spread_series_daily, histogram_daily, daily_center, daily_scale) =
        build_headline(left_daily, right_daily).unwrap_or_else(|| (Vec::new(), Vec::new(), 0.0, 0.0));

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

    // Kalman 시변 β 관계 안정성 — 일봉 raw 레벨 기준 (basis 토글 무관). 표본 부족 시 None.
    let kalman = build_kalman_stat(left_daily, right_daily);

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
        spread_series_daily,
        histogram_daily,
        daily_center,
        daily_scale,
        kalman,
    })
}
