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
// Sparse CCA (Witten et al. 2009 — PMD-CCA)
// ---------------------------------------------------------------------------
//
// M:N 페어 발굴. 두 자산군 X (p개), Y (q개)에 대해 양변 모두 sparse한 선형결합 발굴.
//
//   max  u' (X' Y) v / (T-1)
//   s.t. ||u||₂ = 1, ||v||₂ = 1
//        ||u||₁ ≤ c1,  ||v||₁ ≤ c2
//
// c1, c2는 sparsity 강도 (1.0 = max sparse 1개 leg, sqrt(p) = no sparsity).
// PR-C2가 outer binary search로 leg 수 목표 (각 변 ≤ 5)에 맞춰 c1, c2 조정.
//
// 알고리즘 (Witten PMA package R 참조):
//   1. K = X' Y / (T-1)  — p×q cross-covariance
//   2. 반복:
//      a. u 갱신: argu = K v → soft-threshold → L2 정규화 (L1 ≤ c1 강제)
//      b. v 갱신: argv = K' u → soft-threshold → L2 정규화 (L1 ≤ c2 강제)
//   3. ||u_new - u_old||₂ < tol 또는 max_iter 도달까지

#[derive(Debug, Clone)]
pub struct SparseCcaResult {
    /// X 측 가중치. L2 norm = 1 (정규화). 0인 entry = 해당 변수 미선택.
    pub u: Vec<f64>,
    /// Y 측 가중치. L2 norm = 1.
    pub v: Vec<f64>,
    /// canonical correlation = u' K v (K = X'Y/(T-1)).
    pub correlation: f64,
    pub iterations: usize,
    pub converged: bool,
}

fn soft_threshold(x: f64, d: f64) -> f64 {
    if x > d {
        x - d
    } else if x < -d {
        x + d
    } else {
        0.0
    }
}

fn l2(x: &[f64]) -> f64 {
    x.iter().map(|v| v * v).sum::<f64>().sqrt()
}

fn l1(x: &[f64]) -> f64 {
    x.iter().map(|v| v.abs()).sum()
}

/// Witten BinarySearch — soft-threshold λ 찾기.
/// 목표: soft_threshold(argu, λ) 의 L2 정규화 후 L1 norm ≤ c.
/// λ=0이면 정규화 후 L1 = ||argu||₁ / ||argu||₂. 그게 c 이하면 sparsity 불필요.
fn binary_search_lambda(argu: &[f64], c: f64) -> f64 {
    let nrm = l2(argu);
    if nrm < 1e-12 {
        return 0.0;
    }
    // 정규화 후 L1 (λ=0 케이스)
    let l1_norm: f64 = argu.iter().map(|v| v.abs()).sum::<f64>() / nrm;
    if l1_norm <= c {
        return 0.0;
    }
    let mut lo = 0.0_f64;
    let mut hi = argu.iter().map(|v| v.abs()).fold(0.0_f64, f64::max);
    for _ in 0..150 {
        if hi - lo < 1e-6 {
            break;
        }
        let mid = (lo + hi) / 2.0;
        let su: Vec<f64> = argu.iter().map(|v| soft_threshold(*v, mid)).collect();
        let su_l2 = l2(&su);
        if su_l2 < 1e-12 {
            hi = mid;
            continue;
        }
        let metric = l1(&su) / su_l2;
        if metric < c {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    (lo + hi) / 2.0
}

/// L1 ball 사영 + L2 정규화. 결과 ||·||₂ = 1 이면서 ||·||₁ ≤ c.
/// 모든 entry가 0이 되면 (c가 너무 작음) 결과는 zero vector — 호출자가 처리.
fn project_l1_ball(argu: &[f64], c: f64) -> Vec<f64> {
    let lam = binary_search_lambda(argu, c);
    let su: Vec<f64> = argu.iter().map(|v| soft_threshold(*v, lam)).collect();
    let n = l2(&su);
    if n < 1e-12 {
        return vec![0.0; argu.len()];
    }
    su.iter().map(|v| v / n).collect()
}

/// PMD-CCA — Witten et al. 2009.
/// 입력 X = [변수1 시계열, 변수2 시계열, ...] (총 p개), 각 시계열 길이 T.
/// 호출자가 *컬럼별 z-score 표준화* 한 데이터를 넘김 (PR-B의 stats::pca 와 같은 정책).
///
/// c1, c2: sqrt(p), sqrt(q) 이하 양수. 1.0이면 최대 sparse (실효 leg ≈ 1),
/// sqrt(p)이면 sparsity 없음 (Dense CCA와 같음).
///
/// 반환:
///   - u (p차원), v (q차원): L2=1 정규화. |u[i]|>tol인 i = X 측 선택된 leg.
///   - correlation: in-sample canonical correlation.
///   - converged: max_iter 안에 ||u_new - u_old||₂ < tol 도달했는지.
///
/// 실패 케이스: 입력 부적합 / K 모두 0 / 모든 entry 0 (c1·c2 너무 작음).
pub fn sparse_cca(
    x: &[Vec<f64>],
    y: &[Vec<f64>],
    c1: f64,
    c2: f64,
    max_iter: usize,
    tol: f64,
) -> Option<SparseCcaResult> {
    let p = x.len();
    let q = y.len();
    if p == 0 || q == 0 {
        return None;
    }
    let t = x[0].len();
    if t < 3 {
        return None;
    }
    if x.iter().any(|v| v.len() != t) || y.iter().any(|v| v.len() != t) {
        return None;
    }
    if !(1.0..=(p as f64).sqrt() + 1e-9).contains(&c1) {
        return None;
    }
    if !(1.0..=(q as f64).sqrt() + 1e-9).contains(&c2) {
        return None;
    }
    let t_f = (t - 1) as f64;

    // Cross-covariance K = X'Y / (T-1). p×q.
    let mut k_mat: Vec<Vec<f64>> = vec![vec![0.0; q]; p];
    for i in 0..p {
        for j in 0..q {
            let mut s = 0.0;
            for k_idx in 0..t {
                s += x[i][k_idx] * y[j][k_idx];
            }
            k_mat[i][j] = s / t_f;
        }
    }

    // 초기 v: K' * 1 정규화. (Witten 권장 시작점 중 하나)
    let mut v = {
        let mut tmp = vec![0.0; q];
        for j in 0..q {
            for i in 0..p {
                tmp[j] += k_mat[i][j];
            }
        }
        let n = l2(&tmp);
        if n < 1e-12 {
            return None;
        }
        tmp.iter().map(|x| x / n).collect::<Vec<_>>()
    };

    let mut u = vec![0.0_f64; p];
    let mut converged = false;
    let mut iters = 0_usize;

    for iter in 0..max_iter {
        iters = iter + 1;
        let u_old = u.clone();
        let v_old = v.clone();

        // u 갱신
        let argu: Vec<f64> = (0..p)
            .map(|i| (0..q).map(|j| k_mat[i][j] * v[j]).sum::<f64>())
            .collect();
        u = project_l1_ball(&argu, c1);
        if l2(&u) < 1e-12 {
            return None;
        }

        // v 갱신
        let argv: Vec<f64> = (0..q)
            .map(|j| (0..p).map(|i| k_mat[i][j] * u[i]).sum::<f64>())
            .collect();
        v = project_l1_ball(&argv, c2);
        if l2(&v) < 1e-12 {
            return None;
        }

        // 수렴
        let du: f64 = u
            .iter()
            .zip(&u_old)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f64>()
            .sqrt();
        let dv: f64 = v
            .iter()
            .zip(&v_old)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f64>()
            .sqrt();
        if du < tol && dv < tol {
            converged = true;
            break;
        }
    }

    // canonical correlation = u' K v
    let mut corr = 0.0;
    for i in 0..p {
        for j in 0..q {
            corr += u[i] * k_mat[i][j] * v[j];
        }
    }

    Some(SparseCcaResult {
        u,
        v,
        correlation: corr,
        iterations: iters,
        converged,
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

    // 표준화 헬퍼 — Sparse CCA 입력 준비
    fn standardize(v: &[f64]) -> Vec<f64> {
        let n = v.len() as f64;
        let m = v.iter().sum::<f64>() / n;
        let var = v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (n - 1.0);
        let sd = var.sqrt();
        v.iter().map(|x| (x - m) / sd).collect()
    }

    #[test]
    fn sparse_cca_perfect_1x1() {
        // X = [x], Y = [2x+1]. 표준화 후 corr=1. c1=c2=1 (max sparse).
        // 결과: |u|=1, |v|=1, correlation ≈ 1.
        let x_raw: Vec<f64> = (0..50).map(|i| (i as f64).sin()).collect();
        let y_raw: Vec<f64> = x_raw.iter().map(|v| 2.0 * v + 1.0).collect();
        let x = vec![standardize(&x_raw)];
        let y = vec![standardize(&y_raw)];
        let r = sparse_cca(&x, &y, 1.0, 1.0, 50, 1e-6).unwrap();
        assert!(r.converged);
        assert!((r.correlation.abs() - 1.0).abs() < 1e-6);
        assert!((r.u[0].abs() - 1.0).abs() < 1e-6);
        assert!((r.v[0].abs() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn sparse_cca_picks_signal_among_noise() {
        // X 컬럼 2개: [신호, 노이즈]. Y 컬럼 2개: [신호+ε, 노이즈]. 신호=sin.
        // c1=c2=1 (강한 sparsity) → 신호 컬럼만 가중치 1, 노이즈 0이어야.
        let t = 100;
        let signal: Vec<f64> = (0..t).map(|i| ((i as f64) * 0.1).sin()).collect();
        // 노이즈는 다른 시퀀스 (cos)
        let noise: Vec<f64> = (0..t).map(|i| ((i as f64) * 0.3).cos()).collect();
        // Y의 신호는 X 신호와 거의 동일 (small perturbation)
        let signal_y: Vec<f64> = signal.iter().enumerate().map(|(i, v)| v + 0.001 * (i as f64).cos()).collect();
        let noise_y: Vec<f64> = (0..t).map(|i| ((i as f64) * 0.5).sin()).collect();
        let x = vec![standardize(&signal), standardize(&noise)];
        let y = vec![standardize(&signal_y), standardize(&noise_y)];
        let r = sparse_cca(&x, &y, 1.0, 1.0, 100, 1e-6).unwrap();
        assert!(r.converged);
        // 신호 컬럼 (index 0) 가중치가 노이즈보다 압도적
        assert!(r.u[0].abs() > r.u[1].abs() * 5.0);
        assert!(r.v[0].abs() > r.v[1].abs() * 5.0);
        // correlation ≈ 1 (둘이 거의 동일 신호)
        assert!(r.correlation.abs() > 0.99);
    }

    #[test]
    fn sparse_cca_dense_when_c_relaxed() {
        // c가 sqrt(p) (max)이면 sparsity 없음 → 모든 leg 살아남음 (Dense CCA).
        let t = 50;
        let a: Vec<f64> = (0..t).map(|i| (i as f64).sin()).collect();
        let b: Vec<f64> = (0..t).map(|i| (i as f64).cos()).collect();
        let x = vec![standardize(&a), standardize(&b)];
        let y = vec![standardize(&a), standardize(&b)];
        // c = sqrt(2) ≈ 1.414 — sparsity 강제 X
        let r = sparse_cca(&x, &y, 2.0_f64.sqrt(), 2.0_f64.sqrt(), 100, 1e-6).unwrap();
        assert!(r.converged);
        // 두 leg 다 0 아님
        assert!(r.u[0].abs() > 1e-3);
        assert!(r.u[1].abs() > 1e-3);
    }

    #[test]
    fn sparse_cca_invalid_inputs() {
        let x = vec![vec![1.0, 2.0, 3.0]];
        let y = vec![vec![1.0, 2.0, 3.0]];
        // c1 범위 외 (0.5 < 1)
        assert!(sparse_cca(&x, &y, 0.5, 1.0, 10, 1e-6).is_none());
        // c1 범위 외 (sqrt(1)=1 초과 2.0)
        assert!(sparse_cca(&x, &y, 2.0, 1.0, 10, 1e-6).is_none());
        // 길이 mismatch
        let y_bad = vec![vec![1.0, 2.0]];
        assert!(sparse_cca(&x, &y_bad, 1.0, 1.0, 10, 1e-6).is_none());
    }
}
