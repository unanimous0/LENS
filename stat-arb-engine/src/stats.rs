//! 통계 함수 — OLS, ADF, half-life, Pearson correlation.
//!
//! 외부 BLAS 없이 직접 구현 (n이 작은 단변수 회귀 위주라 ndarray보다 raw Vec/슬라이스가 빠름).
//! 향후 PCA/Sparse CCA는 ndarray-linalg 도입 예정.

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
}
