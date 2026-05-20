//! 통계 함수 — OLS, ADF, half-life, Pearson correlation, PCA.
//!
//! 외부 BLAS 없이 직접 구현 (n이 작은 단변수 회귀 위주라 ndarray보다 raw Vec/슬라이스가 빠름).
//! PCA는 nalgebra의 SymmetricEigen 사용 — pure Rust, 시스템 LAPACK 불필요.

/// 단변수 OLS 결과: `y = alpha + beta * x + ε`.
#[derive(Debug, Clone)]
pub struct OlsResult {
    pub alpha: f64,
    pub beta: f64,
    pub residuals: Vec<f64>,
    pub r_squared: f64,
    /// SE(beta). t-stat 계산용.
    pub se_beta: f64,
}

/// 단변수 OLS. x, y 길이 같아야 함. 길이 < 3 또는 분산 0이면 None.
pub fn ols(x: &[f64], y: &[f64]) -> Option<OlsResult> {
    let n = x.len();
    if n < 3 || y.len() != n {
        return None;
    }
    let n_f = n as f64;
    let x_mean = x.iter().sum::<f64>() / n_f;
    let y_mean = y.iter().sum::<f64>() / n_f;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    let mut syy = 0.0;
    for i in 0..n {
        let dx = x[i] - x_mean;
        let dy = y[i] - y_mean;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx.abs() < f64::EPSILON || syy.abs() < f64::EPSILON {
        return None;
    }
    let beta = sxy / sxx;
    let alpha = y_mean - beta * x_mean;
    let residuals: Vec<f64> = (0..n).map(|i| y[i] - alpha - beta * x[i]).collect();
    let rss: f64 = residuals.iter().map(|r| r * r).sum();
    let r_squared = 1.0 - rss / syy;
    // 잔차 분산 → SE(beta) = sqrt(RSS / (n-2) / Sxx)
    let mse = rss / (n_f - 2.0);
    let se_beta = (mse / sxx).sqrt();
    Some(OlsResult {
        alpha,
        beta,
        residuals,
        r_squared,
        se_beta,
    })
}

/// Pearson correlation.
pub fn pearson(x: &[f64], y: &[f64]) -> Option<f64> {
    let n = x.len();
    if n < 3 || y.len() != n {
        return None;
    }
    let n_f = n as f64;
    let mx = x.iter().sum::<f64>() / n_f;
    let my = y.iter().sum::<f64>() / n_f;
    let mut cov = 0.0;
    let mut vx = 0.0;
    let mut vy = 0.0;
    for i in 0..n {
        let dx = x[i] - mx;
        let dy = y[i] - my;
        cov += dx * dy;
        vx += dx * dx;
        vy += dy * dy;
    }
    let denom = (vx * vy).sqrt();
    if denom < f64::EPSILON {
        return None;
    }
    Some(cov / denom)
}

/// Augmented Dickey-Fuller 테스트 (lag=0, 기본 DF).
///
/// 회귀: `Δy_t = α + ρ y_{t-1} + ε_t`
/// 귀무가설: ρ = 0 (unit root, non-stationary).
/// 통계량: `t = ρ̂ / SE(ρ̂)`. 작을수록(음수) stationary 증거 강함.
///
/// 임계값 (n=100):
///   1%: -3.51, 5%: -2.89, 10%: -2.58
/// 본 함수는 t-stat만 반환. 호출자가 임계값 비교.
///
/// 반환 None: 시리즈가 너무 짧거나 분산 0.
pub fn adf_tstat(series: &[f64]) -> Option<f64> {
    if series.len() < 4 {
        return None;
    }
    let y_lag: Vec<f64> = series[..series.len() - 1].to_vec();
    let dy: Vec<f64> = series.windows(2).map(|w| w[1] - w[0]).collect();
    let r = ols(&y_lag, &dy)?;
    // t-stat for beta (= ρ̂).
    if r.se_beta < f64::EPSILON {
        return None;
    }
    Some(r.beta / r.se_beta)
}

/// Mean-reversion half-life.
///
/// 회귀: `Δy_t = θ y_{t-1} + ε_t`
/// θ < 0 면 mean-reverting → `half_life = ln(2) / -θ`.
/// θ >= 0 면 비회귀(발산/random walk) → None.
pub fn half_life(series: &[f64]) -> Option<f64> {
    if series.len() < 4 {
        return None;
    }
    let y_lag: Vec<f64> = series[..series.len() - 1].to_vec();
    let dy: Vec<f64> = series.windows(2).map(|w| w[1] - w[0]).collect();
    let r = ols(&y_lag, &dy)?;
    if r.beta >= 0.0 {
        return None;
    }
    Some(std::f64::consts::LN_2 / -r.beta)
}

/// 표준편차 (모집단 σ, 분모 n).
pub fn stddev_pop(series: &[f64]) -> Option<f64> {
    let n = series.len();
    if n < 2 {
        return None;
    }
    let mean = series.iter().sum::<f64>() / n as f64;
    let var: f64 = series.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n as f64;
    Some(var.sqrt())
}

/// 현재 z-score: `(현재 잔차 - 잔차 평균) / 잔차 표준편차`.
pub fn current_z(residuals: &[f64]) -> Option<f64> {
    let n = residuals.len();
    if n < 2 {
        return None;
    }
    let mean = residuals.iter().sum::<f64>() / n as f64;
    let sigma = stddev_pop(residuals)?;
    if sigma < f64::EPSILON {
        return None;
    }
    Some((residuals[n - 1] - mean) / sigma)
}

// ---------------------------------------------------------------------------
// PCA (Dense)
// ---------------------------------------------------------------------------

/// PCA 결과 — eigenvalue 내림차순. loadings는 column-major (loadings[j][i] = i번째
/// 변수의 j번째 factor 적재량). 호출자는 변수 인덱스와 입력 series 인덱스가 같다고 가정.
#[derive(Debug, Clone)]
pub struct PcaResult {
    /// 고유값 내림차순. 길이 = N (변수 수).
    pub eigenvalues: Vec<f64>,
    /// factor당 설명력 비율 (eigenvalue / sum). 길이 = N. 합 = 1.
    pub explained_variance_ratio: Vec<f64>,
    /// loadings[factor_idx][var_idx] = 적재량. 외층 N(factor), 내층 N(변수).
    pub loadings: Vec<Vec<f64>>,
    /// 사용된 sample size (T 행 수).
    pub n_samples: usize,
}

/// Dense PCA — 입력은 [변수1 시계열, 변수2 시계열, ...]. 각 시계열 길이 T 동일.
/// 짧은 시리즈는 호출자가 align_tail로 맞춰서 전달.
/// 1) 각 컬럼을 z-score 표준화 (변동성 편향 회피)
/// 2) 공분산 = 표준화 후 X'X / (T-1) = 상관행렬
/// 3) SymmetricEigen → 내림차순 정렬 → eigenvalues + eigenvectors
/// 4) explained variance ratio = λ_i / Σλ
///
/// 실패 케이스: N<2, T<3, 분산 0인 컬럼 존재.
pub fn pca(series: &[Vec<f64>]) -> Option<PcaResult> {
    use nalgebra::{DMatrix, SymmetricEigen};

    let n_vars = series.len();
    if n_vars < 2 {
        return None;
    }
    let t = series[0].len();
    if t < 3 || series.iter().any(|s| s.len() != t) {
        return None;
    }
    let t_f = t as f64;

    // z-score 표준화. 분산 0이면 fail.
    let mut z: Vec<Vec<f64>> = Vec::with_capacity(n_vars);
    for col in series {
        let mean = col.iter().sum::<f64>() / t_f;
        let var = col.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (t_f - 1.0);
        if !(var > 0.0) {
            return None;
        }
        let sd = var.sqrt();
        z.push(col.iter().map(|v| (v - mean) / sd).collect());
    }

    // 상관행렬 R = (1/(T-1)) Z'Z. nalgebra DMatrix는 column-major.
    // 변수가 컬럼이라 X = T×N, R = N×N.
    let mut r = DMatrix::<f64>::zeros(n_vars, n_vars);
    for i in 0..n_vars {
        for j in i..n_vars {
            let mut s = 0.0;
            for k in 0..t {
                s += z[i][k] * z[j][k];
            }
            let cov = s / (t_f - 1.0);
            r[(i, j)] = cov;
            r[(j, i)] = cov;
        }
    }

    let eig = SymmetricEigen::new(r);
    // nalgebra 고유값 정렬 보장 X → 내림차순 재정렬
    let mut paired: Vec<(f64, usize)> = eig.eigenvalues.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    paired.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let sum: f64 = paired.iter().map(|(v, _)| v.max(0.0)).sum();
    if !(sum > 0.0) {
        return None;
    }

    let mut eigenvalues = Vec::with_capacity(n_vars);
    let mut explained_variance_ratio = Vec::with_capacity(n_vars);
    let mut loadings: Vec<Vec<f64>> = Vec::with_capacity(n_vars);

    for (val, orig_idx) in &paired {
        let v = val.max(0.0); // numerical noise 음수 클램프
        eigenvalues.push(v);
        explained_variance_ratio.push(v / sum);
        // eigenvector — eig.eigenvectors는 column-major, *원래 인덱스* 컬럼.
        let col = eig.eigenvectors.column(*orig_idx);
        loadings.push((0..n_vars).map(|i| col[i]).collect());
    }

    Some(PcaResult {
        eigenvalues,
        explained_variance_ratio,
        loadings,
        n_samples: t,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ols_recovers_simple_line() {
        let x: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| 2.0 * v + 3.0).collect();
        let r = ols(&x, &y).unwrap();
        assert!((r.alpha - 3.0).abs() < 1e-9);
        assert!((r.beta - 2.0).abs() < 1e-9);
        assert!((r.r_squared - 1.0).abs() < 1e-9);
    }

    #[test]
    fn pearson_perfect() {
        let x: Vec<f64> = (0..10).map(|i| i as f64).collect();
        let y: Vec<f64> = x.iter().map(|v| 2.0 * v + 1.0).collect();
        assert!((pearson(&x, &y).unwrap() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn half_life_known_ar1() {
        // AR(1): y_t = 0.5 * y_{t-1} + ε, half-life ≈ ln(2)/ln(2) = 1
        // Δy = -0.5 y_{t-1} + ε → θ = -0.5, hl = ln2/0.5 ≈ 1.386
        let mut y = vec![10.0];
        let phi = 0.5;
        for _ in 0..200 {
            let last = y[y.len() - 1];
            y.push(phi * last); // 잡음 없는 deterministic
        }
        let hl = half_life(&y).unwrap();
        assert!((hl - std::f64::consts::LN_2 / (1.0 - phi)).abs() < 0.05);
    }

    #[test]
    fn pca_two_perfectly_correlated_series() {
        // 두 시리즈가 동일 → standardize 후 첫 factor가 100% variance 흡수.
        let a: Vec<f64> = (0..50).map(|i| (i as f64).sin()).collect();
        let b = a.clone();
        let r = pca(&[a, b]).unwrap();
        assert_eq!(r.eigenvalues.len(), 2);
        // 두 컬럼 z-score가 동일 → 공분산 행렬 [[1,1],[1,1]] → 고유값 2, 0
        assert!((r.explained_variance_ratio[0] - 1.0).abs() < 1e-9);
        assert!(r.explained_variance_ratio[1].abs() < 1e-9);
    }

    #[test]
    fn pca_two_anticorrelated_series() {
        // 정확히 반대 부호 → 여전히 첫 factor가 100%.
        let a: Vec<f64> = (0..50).map(|i| (i as f64).sin()).collect();
        let b: Vec<f64> = a.iter().map(|v| -v).collect();
        let r = pca(&[a, b]).unwrap();
        assert!((r.explained_variance_ratio[0] - 1.0).abs() < 1e-9);
    }
}
