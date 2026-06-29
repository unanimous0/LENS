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
//
// PR-B.1 (PR-A 진단 결과 기반 완화):
//   MIN_HALF_LIFE 3.0 → 0.5    — ETF 카테고리/짝 ETF 같은 빠른 수렴도 진짜 시그널
//   MIN_R²        0.3 → 0.5    — 짧은 half-life 우연 거르기. R² 강화로 보완
const MIN_CORR: f64 = 0.5;
const ADF_CRIT: f64 = -3.0;
const MIN_SAMPLES: usize = 150;
const MIN_HALF_LIFE: f64 = 0.5;
const MAX_HALF_LIFE: f64 = 90.0;
const MIN_R_SQUARED: f64 = 0.5;
// 최근창 안정성 (2026-06-26): 1년 OLS 관계가 "최근에도 평균회귀하나" 검정.
// 1년 잔차의 최근 N영업일 tail(같은 β) ADF가 여전히 stationary여야 함 →
// "과거엔 좋았으나 최근 깨진 페어"(false discovery의 실질 구멍) 제거.
// 표본이 1년창(~252)보다 작아 검정력↓ → 임계는 ADF_CRIT(-3.0)보다 완화(-2.5). 최근 가장
// 약해진 ~20%만 컷(측정 2026-06-26). 더 빡세면 검정력 부족으로 진짜 페어도 버림. env로 튜닝.
const RECENT_WINDOW_DAYS: usize = 126; // ~6개월 영업일
// 최근창 ADF 임계 — env로 튜닝(기본 -2.0). 표본 작아 검정력 약하므로 운영 중 조정 여지.
fn recent_adf_crit() -> f64 {
    use std::sync::OnceLock;
    static CELL: OnceLock<f64> = OnceLock::new();
    *CELL.get_or_init(|| {
        std::env::var("STATARB_RECENT_ADF_CRIT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(-2.5)
    })
}

/// M:N 페어 한 쪽 최대 leg 수. stat-arb-engine.md §2 결정사항.
/// PR-C (Sparse CCA) / PR-E (Sparse PCA) 진입 시 L1 sparsity 강도와 결과 leg 수 cap에 사용.
/// PR-A 시점엔 1:1만 다루므로 미사용 — 상수 사전 정의로 의도 명시.
#[allow(dead_code)]
pub const MAX_LEGS_PER_SIDE: usize = 5;

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
    /// 최근 ~6개월 잔차(같은 β) ADF — "최근에도 평균회귀하나" 안정성 지표. 게이트도 겸함.
    pub recent_adf_tstat: f64,
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
    if r.r_squared < MIN_R_SQUARED {
        // 잔차가 너무 큼 — cointegration 가능성 낮음
        return None;
    }

    // 3. ADF on residuals — 양방향 대칭 게이트.
    //    주 방향(y=b, x=a) 잔차뿐 아니라 역방향(y=a, x=b) 잔차 ADF도 둘 다 통과해야 함.
    //    OLS는 y/x 선택에 따라 잔차가 달라져 ADF가 비대칭 → 한쪽만 통과하는 "방향 취약"
    //    페어를 거른다. 견고히 공적분된 페어는 양 방향 다 통과(개념: 강한 기준이면
    //    방향 비대칭은 비이슈). 대칭 정석은 M:N Johansen(PR-D)에서.
    let adf = stats::adf_tstat(&r.residuals)?;
    if adf > ADF_CRIT {
        return None;
    }
    let r_rev = stats::ols(&b, &a)?;
    let adf_rev = stats::adf_tstat(&r_rev.residuals)?;
    if adf_rev > ADF_CRIT {
        return None;
    }

    // 4. half-life — 너무 짧으면 우연, 너무 길면 활용 불가
    let hl = stats::half_life(&r.residuals)?;
    if !hl.is_finite() || hl < MIN_HALF_LIFE || hl > MAX_HALF_LIFE {
        return None;
    }

    // 4.5 최근창 안정성 — 1년 잔차(같은 β)의 최근 N영업일 tail이 여전히 stationary한지.
    //     "과거엔 묶였으나 최근 깨진" 페어를 제거. 표본 부족 시(데이터 짧음) 전체 ADF로 대체(통과).
    let recent_adf = if r.residuals.len() >= RECENT_WINDOW_DAYS {
        let tail = &r.residuals[r.residuals.len() - RECENT_WINDOW_DAYS..];
        stats::adf_tstat(tail).unwrap_or(0.0)
    } else {
        adf
    };
    if recent_adf > recent_adf_crit() {
        return None; // 최근창에서 관계 붕괴 — 발굴 제외
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
        recent_adf_tstat: recent_adf,
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
    // 키로 정렬 — DashMap 순회 순서가 비결정적이라 정렬 안 하면 페어 좌/우(=z 부호)가
    // 재시작마다 뒤바뀜. 정렬 고정 시 항상 작은 키가 left(x), 큰 키가 right(y)로 일관.
    series_data.sort_by(|a, b| a.0.cmp(&b.0));
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

// ---------------------------------------------------------------------------
// PR-B: Dense PCA pre-filter
// ---------------------------------------------------------------------------

/// 그룹별 PCA 결과 + candidate pool (총 explanatory power 상위 종목).
/// PR-C (Sparse CCA)는 candidate_pool로 입력 변수 폭 줄임 (예: 반도체 164→30).
#[derive(Debug, Clone, Serialize)]
pub struct GroupPcaResult {
    /// 그룹에서 PCA에 실제 들어간 멤버 (캐시 미존재/샘플 부족 자동 제외).
    pub members_used: Vec<String>,
    /// 사용된 영업일 샘플 수 (T).
    pub n_samples: usize,
    /// 상위 factor 표시. 보통 3 factor면 80~90% explained variance 흡수.
    pub factors: Vec<GroupPcaFactor>,
    /// 총 explanatory power 상위 종목 (factor별 loading² 합 내림차순).
    pub candidate_pool: Vec<CandidateMember>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupPcaFactor {
    pub factor_idx: usize,
    pub eigenvalue: f64,
    pub explained_variance_ratio: f64,
    /// 이 factor의 top loading 종목 (|loading| 내림차순, 상위 N개만).
    pub top_loadings: Vec<FactorLoading>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FactorLoading {
    pub key: String,
    pub loading: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CandidateMember {
    pub key: String,
    /// Σ (loading² × explained_variance_ratio) over kept factors — communality 비슷한 지표.
    pub power: f64,
    /// factor1 loading (부호 포함). PR-C2 양변 분할에 사용.
    pub factor1_loading: f64,
}

/// 그룹 멤버 종가 시계열에 Dense PCA 적용.
/// 입력: 그룹 멤버 key 목록 + cache + 일봉 길이 정책 (MIN_SAMPLES 동일).
/// 결과: 상위 `n_factors_keep` factor + 총 explanatory power top `pool_size` 종목.
///
/// 멤버가 적거나 데이터 부족하면 None.
pub fn compute_group_pca(
    members: &[String],
    cache: &SeriesCache,
    n_factors_keep: usize,
    pool_size: usize,
    top_loadings_per_factor: usize,
) -> Option<GroupPcaResult> {
    // 1. 멤버 일봉 종가 → 로그수익률
    let mut keys: Vec<String> = Vec::new();
    let mut series: Vec<Vec<f64>> = Vec::new();
    for key in members {
        let Some(entry) = cache.get(key) else { continue };
        let Some(closes) = closes_daily(entry.value()) else { continue };
        let rets = log_returns(&closes);
        keys.push(key.clone());
        series.push(rets);
    }
    if keys.len() < 3 {
        // PCA 의미 있으려면 변수 ≥ 3
        return None;
    }

    // 2. 시리즈 길이 통일 — 최소 길이로 right-align (가장 최근 데이터 보존)
    let min_len = series.iter().map(|s| s.len()).min()?;
    if min_len < MIN_SAMPLES {
        return None;
    }
    for s in series.iter_mut() {
        let start = s.len() - min_len;
        s.drain(0..start);
    }

    // 3. PCA
    let pca_r = crate::stats::pca(&series)?;
    let n_vars = keys.len();
    let n_keep = n_factors_keep.min(pca_r.eigenvalues.len());

    // 4. factor별 top loading
    let mut factors: Vec<GroupPcaFactor> = Vec::with_capacity(n_keep);
    for f in 0..n_keep {
        let loadings_f = &pca_r.loadings[f];
        let mut pairs: Vec<(usize, f64)> = (0..n_vars).map(|i| (i, loadings_f[i])).collect();
        pairs.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal));
        let top: Vec<FactorLoading> = pairs
            .into_iter()
            .take(top_loadings_per_factor)
            .map(|(i, l)| FactorLoading { key: keys[i].clone(), loading: l })
            .collect();
        factors.push(GroupPcaFactor {
            factor_idx: f,
            eigenvalue: pca_r.eigenvalues[f],
            explained_variance_ratio: pca_r.explained_variance_ratio[f],
            top_loadings: top,
        });
    }

    // 5. candidate pool — 각 변수에 대해 Σ_kept (loading² × evr)
    let mut power: Vec<(usize, f64)> = (0..n_vars).map(|i| (i, 0.0)).collect();
    for f in 0..n_keep {
        let evr = pca_r.explained_variance_ratio[f];
        let loadings_f = &pca_r.loadings[f];
        for i in 0..n_vars {
            power[i].1 += loadings_f[i] * loadings_f[i] * evr;
        }
    }
    power.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let f1_loadings = &pca_r.loadings[0];
    let candidate_pool: Vec<CandidateMember> = power
        .into_iter()
        .take(pool_size)
        .map(|(i, p)| CandidateMember {
            key: keys[i].clone(),
            power: p,
            factor1_loading: f1_loadings[i],
        })
        .collect();

    Some(GroupPcaResult {
        members_used: keys,
        n_samples: pca_r.n_samples,
        factors,
        candidate_pool,
    })
}

// ---------------------------------------------------------------------------
// PR-C2: M:N 발굴 — Sparse CCA + 양변 분할 + 합성 spread 검증
// ---------------------------------------------------------------------------

/// 양변 분할 전략. group_kind 따라 main.rs가 결정.
#[derive(Debug, Clone, Copy)]
pub enum MnSplitStrategy {
    /// ETF 그룹: ETF 1개 ↔ 보유주식 다수. 자연 분할.
    EtfNatural,
    /// 그 외 (sector/index/etf_category): PCA factor1 부호로 분할.
    Factor1Sign,
}

#[derive(Debug, Clone, Serialize)]
pub struct MLeg {
    pub key: String,
    pub name: String,
    /// L2 정규화 가중치 (CCA u 또는 v entry). 절댓값 0.05 이상만 leg로 인정.
    pub weight: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MPairResult {
    pub group_id: String,
    pub group_name: String,
    pub timeframe: String,
    pub x_legs: Vec<MLeg>,
    pub y_legs: Vec<MLeg>,
    /// CCA in-sample canonical correlation (u' K v).
    pub cca_correlation: f64,
    /// 합성 spread (log price) 회귀 hedge ratio.
    pub hedge_ratio: f64,
    pub adf_tstat: f64,
    pub half_life: f64,
    pub r_squared: f64,
    pub z_score: f64,
    pub sample_size: usize,
    /// 발굴 점수 = -ADF × (1/hl) × |cca_correlation|.
    pub score: f64,
}

/// candidate pool을 ETF / 주식 분할 (key prefix 기반).
fn split_etf_natural(pool: &[CandidateMember]) -> (Vec<String>, Vec<String>) {
    let mut etfs = Vec::new();
    let mut stocks = Vec::new();
    for m in pool {
        if m.key.starts_with("E:") {
            etfs.push(m.key.clone());
        } else if m.key.starts_with("S:") {
            stocks.push(m.key.clone());
        }
    }
    (etfs, stocks)
}

/// candidate pool을 factor1 부호 분할.
fn split_by_factor1(pool: &[CandidateMember]) -> (Vec<String>, Vec<String>) {
    let mut pos = Vec::new();
    let mut neg = Vec::new();
    for m in pool {
        if m.factor1_loading > 0.0 {
            pos.push(m.key.clone());
        } else if m.factor1_loading < 0.0 {
            neg.push(m.key.clone());
        }
    }
    (pos, neg)
}

/// 컬럼 z-score 표준화. 분산 0이면 None (해당 시리즈 제외 마커).
fn standardize(v: &[f64]) -> Option<Vec<f64>> {
    let n = v.len() as f64;
    if n < 3.0 {
        return None;
    }
    let m = v.iter().sum::<f64>() / n;
    let var = v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (n - 1.0);
    if !(var > 0.0) {
        return None;
    }
    let sd = var.sqrt();
    Some(v.iter().map(|x| (x - m) / sd).collect())
}

/// 멤버 key 목록 → (log returns 표준화 매트릭스, 살아남은 key 목록).
/// 길이 통일은 호출자에서 (모든 변수가 같은 T 길이여야 sparse_cca 호출 가능).
fn build_standardized_returns(
    keys: &[String],
    cache: &SeriesCache,
    target_len: usize,
) -> (Vec<Vec<f64>>, Vec<String>) {
    let mut out_series = Vec::new();
    let mut out_keys = Vec::new();
    for key in keys {
        let Some(entry) = cache.get(key) else { continue };
        let Some(closes) = closes_daily(entry.value()) else { continue };
        let rets = log_returns(&closes);
        if rets.len() < target_len {
            continue;
        }
        let trimmed = rets[rets.len() - target_len..].to_vec();
        let Some(z) = standardize(&trimmed) else { continue };
        out_series.push(z);
        out_keys.push(key.clone());
    }
    (out_series, out_keys)
}

/// 멤버 key → log close prices. CCA로 선택된 leg에 대해 OLS 적용용.
fn log_closes_aligned(
    keys: &[String],
    cache: &SeriesCache,
    target_len: usize,
) -> Vec<Vec<f64>> {
    let mut out = Vec::new();
    for key in keys {
        let Some(entry) = cache.get(key) else {
            out.push(Vec::new());
            continue;
        };
        let Some(closes) = closes_daily(entry.value()) else {
            out.push(Vec::new());
            continue;
        };
        if closes.len() < target_len {
            out.push(Vec::new());
            continue;
        }
        let trimmed: Vec<f64> = closes[closes.len() - target_len..]
            .iter()
            .map(|p| if *p > 0.0 { p.ln() } else { 0.0 })
            .collect();
        out.push(trimmed);
    }
    out
}

/// Outer search — c1, c2 다이얼링으로 leg 수 목표 (≤5 + m+n≥3) 달성.
/// 단순 grid 탐색: c = 1.2, 1.5, 2.0 시도 후 첫 적합 결과 채택.
/// 더 정교한 binary search는 후속 PR에서 도입 가능.
fn find_sparse_cca_with_target(
    x: &[Vec<f64>],
    y: &[Vec<f64>],
    max_legs: usize,
    min_total: usize,
    weight_threshold: f64,
) -> Option<crate::stats::SparseCcaResult> {
    let p = x.len();
    let q = y.len();
    let sqrt_p = (p as f64).sqrt();
    let sqrt_q = (q as f64).sqrt();

    // c 값들을 작은 것부터 (더 sparse) → 큰 것 (덜 sparse) 순서로 시도.
    // 첫 적합 결과 채택.
    let c_grid = [1.2_f64, 1.5, 2.0, 2.5, 3.0];
    for c in c_grid {
        let c1 = c.min(sqrt_p);
        let c2 = c.min(sqrt_q);
        if c1 < 1.0 || c2 < 1.0 {
            continue;
        }
        let Some(r) = crate::stats::sparse_cca(x, y, c1, c2, 50, 1e-5) else {
            continue;
        };
        let n_x = r.u.iter().filter(|w| w.abs() > weight_threshold).count();
        let n_y = r.v.iter().filter(|w| w.abs() > weight_threshold).count();
        if n_x == 0 || n_y == 0 {
            continue;
        }
        if n_x > max_legs || n_y > max_legs {
            continue;
        }
        if n_x + n_y < min_total {
            continue;
        }
        return Some(r);
    }
    None
}

/// 그룹에서 M:N 페어 1개 발굴. candidate_pool은 PR-B PCA 산출 결과.
///
/// 절차:
///   1. strategy 따라 candidate pool 양변 분할
///   2. log returns 표준화 매트릭스 구성, 길이 통일
///   3. Sparse CCA — c 다이얼링으로 leg 수 목표 충족 결과 채택
///   4. 선택된 leg의 *log close prices* multi-variate OLS → cointegration vector + 잔차
///   5. 잔차에 ADF + half-life + z 검증
///   6. 통과하면 MPairResult, 실패면 None
///
/// 한 그룹당 1 페어만 반환 (deflation 미지원, PR-C 후속에서 확장 가능).
pub fn discover_mn_in_group(
    group_id: &str,
    group_name: &str,
    strategy: MnSplitStrategy,
    group_members: &[String],
    candidate_pool: &[CandidateMember],
    cache: &SeriesCache,
    names: &std::collections::HashMap<String, String>,
) -> Result<MPairResult, &'static str> {
    const WEIGHT_THRESHOLD: f64 = 0.05;
    const MAX_LEGS: usize = 5;
    const MIN_TOTAL: usize = 3;

    let (x_keys, y_keys) = match strategy {
        MnSplitStrategy::EtfNatural => {
            // ETF는 PCA candidate_pool에서 자주 누락됨 (보유주식 평균이라 individual factor
            // 적재가 분산). 그룹 멤버에서 직접 ETF 보장. 주식 측은 candidate_pool 활용.
            let etfs: Vec<String> = group_members
                .iter()
                .filter(|k| k.starts_with("E:"))
                .cloned()
                .collect();
            let stocks: Vec<String> = candidate_pool
                .iter()
                .filter(|m| m.key.starts_with("S:"))
                .map(|m| m.key.clone())
                .collect();
            (etfs, stocks)
        }
        MnSplitStrategy::Factor1Sign => split_by_factor1(candidate_pool),
    };
    // ETF 그룹의 자연 분할은 m=1 (ETF 1개) vs n≥2 (보유주식)이 정상.
    // factor1 분할은 양변 각 2 이상 일반적. 통합 조건: 각 변 ≥ 1 + 합 ≥ 3.
    if x_keys.is_empty() || y_keys.is_empty() || (x_keys.len() + y_keys.len()) < 3 {
        return Err("split: empty side or |x|+|y|<3");
    }

    // 길이 통일 — 모든 멤버가 MIN_SAMPLES 이상 가졌어야 candidate pool에 들어왔으므로 안전
    let target_len = MIN_SAMPLES;
    let (x_series, x_keys_kept) = build_standardized_returns(&x_keys, cache, target_len);
    let (y_series, y_keys_kept) = build_standardized_returns(&y_keys, cache, target_len);
    // ETF Natural 분할은 X 측 1개도 정상. Factor1 분할은 양변 ≥ 2 권장.
    if x_series.is_empty() || y_series.is_empty() {
        return Err("standardize: empty side (cache miss or var=0)");
    }
    if x_series.len() + y_series.len() < 3 {
        return Err("standardize: |x|+|y|<3 after cache filter");
    }

    let cca = find_sparse_cca_with_target(
        &x_series,
        &y_series,
        MAX_LEGS,
        MIN_TOTAL,
        WEIGHT_THRESHOLD,
    ).ok_or("sparse_cca: no c grid satisfied leg constraints")?;

    // PMD-CCA는 X'X=I 가정 → cca.correlation이 [-sqrt(q), sqrt(q)] 범위 가능.
    // 진짜 합성 시리즈 correlation은 별도 계산: corr(X·u, Y·v).
    let t_ret = x_series[0].len();
    let xu: Vec<f64> = (0..t_ret)
        .map(|k| (0..x_series.len()).map(|i| cca.u[i] * x_series[i][k]).sum::<f64>())
        .collect();
    let yv: Vec<f64> = (0..t_ret)
        .map(|k| (0..y_series.len()).map(|j| cca.v[j] * y_series[j][k]).sum::<f64>())
        .collect();
    let true_corr = crate::stats::pearson(&xu, &yv).unwrap_or(cca.correlation);

    // 선택된 leg 인덱스
    let x_sel: Vec<usize> = cca
        .u
        .iter()
        .enumerate()
        .filter(|(_, w)| w.abs() > WEIGHT_THRESHOLD)
        .map(|(i, _)| i)
        .collect();
    let y_sel: Vec<usize> = cca
        .v
        .iter()
        .enumerate()
        .filter(|(_, w)| w.abs() > WEIGHT_THRESHOLD)
        .map(|(i, _)| i)
        .collect();

    // log close prices (level) — OLS cointegration
    let x_log_prices = log_closes_aligned(&x_keys_kept, cache, target_len + 1); // +1: returns가 차분 1번
    let y_log_prices = log_closes_aligned(&y_keys_kept, cache, target_len + 1);
    if x_log_prices.iter().any(|p| p.is_empty()) || y_log_prices.iter().any(|p| p.is_empty()) {
        return Err("log_closes: aligned prices empty (data length mismatch)");
    }

    // 합성 log price — Σ w_i × log_close_i (선택된 leg만)
    let t_price = target_len + 1;
    let mut x_combined = vec![0.0_f64; t_price];
    let mut x_weight_sum = 0.0;
    for &i in &x_sel {
        let w = cca.u[i];
        for k in 0..t_price {
            x_combined[k] += w * x_log_prices[i][k];
        }
        x_weight_sum += w.abs();
    }
    let mut y_combined = vec![0.0_f64; t_price];
    let mut y_weight_sum = 0.0;
    for &j in &y_sel {
        let w = cca.v[j];
        for k in 0..t_price {
            y_combined[k] += w * y_log_prices[j][k];
        }
        y_weight_sum += w.abs();
    }
    if !(x_weight_sum > 0.0) || !(y_weight_sum > 0.0) {
        return Err("weight_sum: zero");
    }

    // OLS: y_combined = α + β × x_combined → 잔차 spread
    let ols = crate::stats::ols(&x_combined, &y_combined).ok_or("ols: fail")?;
    if ols.r_squared < MIN_R_SQUARED {
        return Err("ols: r²<0.5");
    }
    let adf = crate::stats::adf_tstat(&ols.residuals).ok_or("adf: fail")?;
    if adf > ADF_CRIT {
        return Err("adf: t-stat>-3 (not stationary)");
    }
    let hl = crate::stats::half_life(&ols.residuals).ok_or("hl: fail")?;
    if !hl.is_finite() {
        return Err("hl: non-finite");
    }
    if hl < MIN_HALF_LIFE {
        return Err("hl: <0.5d (too fast/noise)");
    }
    if hl > MAX_HALF_LIFE {
        return Err("hl: >90d (too slow)");
    }
    let z = crate::stats::current_z(&ols.residuals).ok_or("z: fail")?;

    // legs 변환 (가중치 정규화 후 보존)
    let x_legs: Vec<MLeg> = x_sel
        .iter()
        .map(|&i| MLeg {
            key: x_keys_kept[i].clone(),
            name: names.get(&x_keys_kept[i]).cloned().unwrap_or_else(|| x_keys_kept[i].clone()),
            weight: cca.u[i],
        })
        .collect();
    let y_legs: Vec<MLeg> = y_sel
        .iter()
        .map(|&j| MLeg {
            key: y_keys_kept[j].clone(),
            name: names.get(&y_keys_kept[j]).cloned().unwrap_or_else(|| y_keys_kept[j].clone()),
            weight: cca.v[j],
        })
        .collect();

    let score = (-adf) * (1.0 / hl) * true_corr.abs();

    Ok(MPairResult {
        group_id: group_id.to_string(),
        group_name: group_name.to_string(),
        timeframe: "1d".into(),
        x_legs,
        y_legs,
        cca_correlation: true_corr,
        hedge_ratio: ols.beta,
        adf_tstat: adf,
        half_life: hl,
        r_squared: ols.r_squared,
        z_score: z,
        sample_size: t_price,
        score,
    })
}

/// 그룹 한정 1:1 발굴 — 그룹 멤버끼리만 페어 평가.
/// PR-A 본 cron은 시장 전체 결과를 필터링해 그룹별 pair_count 산출 (저렴).
/// 이 함수는 PR-B (Dense PCA) 진입 시 그룹별 series 매트릭스 구성의 *발판*.
/// 향후 임계치 완화(min_corr↓) 시 동일 알고리즘으로 그룹별 재평가도 가능.
#[allow(dead_code)]
pub fn discover_within_group(
    members: &[String],
    cache: &SeriesCache,
    names: &std::collections::HashMap<String, String>,
) -> Vec<PairResult> {
    let mut series_data: Vec<(String, Vec<f64>)> = Vec::with_capacity(members.len());
    for key in members {
        if let Some(entry) = cache.get(key) {
            if let Some(closes) = closes_daily(entry.value()) {
                series_data.push((key.clone(), closes));
            }
        }
    }
    // 키로 정렬 — 페어 좌/우(=z 부호) 결정성 보장 (members 순서와 무관하게 일관).
    series_data.sort_by(|a, b| a.0.cmp(&b.0));
    let n = series_data.len();
    if n < 2 {
        return Vec::new();
    }

    let mut out: Vec<PairResult> = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            let (a_key, a_closes) = &series_data[i];
            let (b_key, b_closes) = &series_data[j];
            let a_name = names.get(a_key).cloned().unwrap_or_else(|| a_key.clone());
            let b_name = names.get(b_key).cloned().unwrap_or_else(|| b_key.clone());
            if let Some(pair) = evaluate_pair(a_key, &a_name, a_closes, b_key, &b_name, b_closes) {
                out.push(pair);
            }
        }
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out
}
