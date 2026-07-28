//! Johansen 공적분 검정 (PR-D) — reduced rank regression (Johansen 1991).
//!
//! ## 왜 필요한가
//!
//! 1:1 발굴은 "무엇이 y인가"를 **양방향 ADF**로 해소했지만, M:N(`discovery.rs`
//! `discover_mn_in_group`)은 Sparse CCA 가중치로 만든 합성 스프레드 하나에 **단방향 ADF**만
//! 건다. 게다가 CCA 가중치는 *상관 최대화*이지 *공적분 벡터*가 아니다.
//! Johansen 은 n개 시계열을 대칭적으로(어느 쪽이 y인지 정하지 않고) 검정하고 공적분 벡터를
//! 직접 준다 — 3개 이상 leg 가 붙는 M:N 이 이 검정의 본래 무대다.
//!
//! **현 단계는 측정 전용이다.** 결과는 부가 지표로만 실리고 발굴 게이팅에 개입하지 않는다.
//!
//! ## 모형
//!
//! VECM: `ΔY_t = Π Y_{t-1} + Σ_{i=1}^{p-1} Γ_i ΔY_{t-i} + μ + ε_t`,  `Π = αβ'`.
//! rank(Π) = r = 공적분 관계 수. 상수항 μ 는 **비제약(unrestricted constant, Johansen case 3)** —
//! 즉 회귀자로 넣고 두 변에서 소거(concentrate out)한다.
//!
//! 절차:
//!   1. `Z0 = ΔY_t`, `Z1 = Y_{t-1}`, `Z2 = [1, ΔY_{t-1}, …, ΔY_{t-p+1}]` (행 = t = p..T-1)
//!   2. `R0 = Z0 − Z2(Z2'Z2)⁻¹Z2'Z0`, `R1` 도 동일 (p=1 이면 Z2 가 상수뿐 → 단순 평균 제거)
//!   3. `S00 = R0'R0/T`, `S01 = R0'R1/T`, `S11 = R1'R1/T`
//!   4. 일반화 고유값 `|λS11 − S10 S00⁻¹ S01| = 0`
//!      → `S11 = LL'` (Cholesky), `M = L⁻¹ S10 S00⁻¹ S01 L⁻ᵀ` 은 대칭 → `SymmetricEigen`
//!      → 공적분 벡터 `β = L⁻ᵀ v` (`stats::pca` 와 같은 pure-Rust 경로, LAPACK 불필요)
//!   5. `LR_trace(r) = −T Σ_{i>r} ln(1−λ_i)`, `LR_max(r) = −T ln(1−λ_{r+1})`
//!   6. r=0 부터 순차 검정 — 기각되면 r+1 로 진행, 처음 기각 실패한 r 이 추정 rank
//!
//! ## statsmodels 와의 관계 (검증 경로)
//!
//! `statsmodels.tsa.vector_ar.vecm.coint_johansen(y, det_order=0, k_ar_diff=lags-1)` 과
//! **lags ≥ 2 에서 완전 일치**한다 (테스트가 그 값을 golden 으로 박아 대조).
//! lags = 1 에서만 갈리는데, statsmodels 가 레벨 항으로 `Y_{t-1}` 이 아니라 `Y_t` 를 쓰기
//! 때문이다 (`vecm.py`: `lx = endog[:T-k_ar_diff][1:]`). k_ar_diff ≥ 1 이면 그 한 칸 차이가
//! `ΔY_{t-1}` 회귀자에 흡수돼 결과가 같아지지만, k_ar_diff = 0 이면 Z2 가 상수뿐이라 흡수되지
//! 않고 다른 값이 나온다. 본 구현은 교과서 VECM 정의(`Y_{t-1}`)를 따른다.

use nalgebra::{Cholesky, DMatrix, Dyn, SymmetricEigen};
use serde::Serialize;

// ---------------------------------------------------------------------------
// 임계값 표
// ---------------------------------------------------------------------------

/// 유의수준 열 인덱스 — 표의 열 순서 `[90%, 95%, 99%]`.
const COL_95: usize = 1;
const COL_99: usize = 2;

/// 표가 커버하는 최대 `n − r`. 이를 넘으면 미판정(None).
const CRIT_MAX_DIM: usize = 12;

/// **Trace** 통계량 임계값 — 비제약 상수(Johansen case 3) 케이스.
/// 행 = `n − r` (1..12), 열 = `[90%, 95%, 99%]`.
///
/// 출처: MacKinnon, Haug & Michelis (1999), *Numerical Distribution Functions of
/// Likelihood Ratio Tests for Cointegration*, Journal of Applied Econometrics 14(5), 563–577.
/// 수치는 statsmodels `statsmodels/tsa/coint_tables.py` 의 `ss_tjcp1`
/// (= `c_sjt(n, p=0)`, "p = 0, for constant term") 표를 그대로 옮겼다.
/// 같은 표를 쓰므로 우리 산출이 `coint_johansen` 과 임계값까지 직접 대조 가능하다.
///
/// Osterwald-Lenum(1992) 표도 **같은 케이스의 구판**이지만 검증 가능한 사본이 손에 없어
/// 채택하지 않았다 (임계값 추측 하드코딩은 조용한 오판정을 낳으므로 금지).
/// `n − r > 12` 는 표 밖 → 임계값 None → rank 미판정.
const TRACE_CRIT: [[f64; 3]; CRIT_MAX_DIM] = [
    [2.7055, 3.8415, 6.6349],
    [13.4294, 15.4943, 19.9349],
    [27.0669, 29.7961, 35.4628],
    [44.4929, 47.8545, 54.6815],
    [65.8202, 69.8189, 77.8202],
    [91.1090, 95.7542, 104.9637],
    [120.3673, 125.6185, 135.9825],
    [153.6341, 159.5290, 171.0905],
    [190.8714, 197.3772, 210.0366],
    [232.1030, 239.2468, 253.2526],
    [277.3740, 285.1402, 300.2821],
    [326.5354, 334.9795, 351.2150],
];

/// **Max-eigenvalue** 통계량 임계값 — 같은 케이스·같은 출처(statsmodels `ss_ejcp1`,
/// `c_sja(n, p=0)`). rank 결정은 trace 로만 하고, 이 표는 참고 지표 표시용이다.
const MAX_EIG_CRIT: [[f64; 3]; CRIT_MAX_DIM] = [
    [2.7055, 3.8415, 6.6349],
    [12.2971, 14.2639, 18.5200],
    [18.8928, 21.1314, 25.8650],
    [25.1236, 27.5858, 32.7172],
    [31.2379, 33.8777, 39.3693],
    [37.2786, 40.0763, 45.8662],
    [43.2947, 46.2299, 52.3069],
    [49.2855, 52.3622, 58.6634],
    [55.2412, 58.4332, 64.9960],
    [61.2041, 64.5040, 71.2525],
    [67.1307, 70.5392, 77.4877],
    [73.0563, 76.5734, 83.7105],
];

/// 표 조회. `n_minus_r` 은 1-based (= n − r). 표 밖이면 None.
fn crit(table: &[[f64; 3]; CRIT_MAX_DIM], n_minus_r: usize, col: usize) -> Option<f64> {
    if n_minus_r == 0 || n_minus_r > CRIT_MAX_DIM {
        return None;
    }
    Some(table[n_minus_r - 1][col])
}

// ---------------------------------------------------------------------------
// 수치 가드 상수
// ---------------------------------------------------------------------------

/// 유효표본(T − p) 절대 하한.
const MIN_OBS: usize = 30;
/// 변수당 유효표본 하한 — 공분산 행렬(n×n) 이 표본을 지배하지 않게 하는 최소 비율.
/// M:N 은 leg 합 ≤ 10, 일봉 3년(~726봉)이라 실무상 항상 여유롭다.
const MIN_OBS_PER_VAR: usize = 10;
/// Cholesky 대각 min/max 비 하한 — 조건수 대용 `cond ≈ (max/min)²`.
/// 1e-7 = cond 1e14 (f64 유효자릿수 1e16 대비 2자리 여유). `Cholesky::new` 는 완전 특이만
/// 잡으므로(sscore.rs `FactorDesign::new` 주석 참조) 준특이 leg 조합(같은 지수 복제 ETF 2종
/// 등)을 여기서 거른다. 상관 0.999999 조합도 diag 비 ~7e-4 라 오탐 여지 없음.
const MIN_DIAG_RATIO: f64 = 1e-7;
/// λ 상한 가드 — λ→1 이면 ln(1−λ) 가 발산.
const MAX_EIGENVALUE: f64 = 1.0 - 1e-12;

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

/// Johansen 검정 결과. 벡터는 전부 길이 `n_vars`, 인덱스 = 검정 단계 r (0-based).
#[derive(Debug, Clone, Serialize)]
pub struct JohansenResult {
    /// 변수(=leg) 수 n.
    pub n_vars: usize,
    /// 유효 표본 수 T = 입력 길이 − lags.
    pub n_obs: usize,
    /// 사용한 시차 p. 1 이면 `ΔY_{t-i}` 항 없음 (상수만).
    pub lags: usize,
    /// 일반화 고유값 λ 내림차순. [0,1) 범위.
    pub eigenvalues: Vec<f64>,
    /// r = 0,1,… 각 단계 trace 통계량 `−T Σ_{i>r} ln(1−λ_i)`.
    pub trace_stats: Vec<f64>,
    /// 같은 순서의 95% 임계값 (표 범위 밖이면 None).
    pub trace_crit_95: Vec<Option<f64>>,
    /// 같은 순서의 99% 임계값.
    pub trace_crit_99: Vec<Option<f64>>,
    /// r 단계 max-eigenvalue 통계량 `−T ln(1−λ_r)`. 참고 지표.
    pub max_eig_stats: Vec<f64>,
    /// max-eigenvalue 95% 임계값.
    pub max_eig_crit_95: Vec<Option<f64>>,
    /// 추정 공적분 rank (trace, 95%). 표 범위 밖이면 None(미판정).
    pub rank_95: Option<usize>,
    /// 추정 공적분 rank (trace, 99%).
    pub rank_99: Option<usize>,
    /// 최대 고유값에 대응하는 공적분 벡터. 입력 순서와 같은 인덱스.
    ///
    /// **정규화: L2 = 1, 첫 번째 비영 성분이 양수**가 되도록 부호 고정.
    /// (고유벡터 부호는 원래 임의 — 재기동마다 뒤집히지 않게 결정론적으로 고정한다.
    /// L2=1 은 Sparse CCA 가중치와 같은 척도라 방향 비교가 바로 된다.)
    pub coint_vector: Vec<f64>,
}

impl JohansenResult {
    /// r=0 trace 통계량 (= "공적분 관계가 하나도 없다" 귀무가설 검정량).
    pub fn trace0(&self) -> f64 {
        self.trace_stats.first().copied().unwrap_or(f64::NAN)
    }

    /// r=0 의 95% 임계값.
    pub fn crit0_95(&self) -> Option<f64> {
        self.trace_crit_95.first().copied().flatten()
    }

    /// 최대 고유값 λ₁.
    pub fn eigen1(&self) -> f64 {
        self.eigenvalues.first().copied().unwrap_or(f64::NAN)
    }
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

/// `y[i]` = i번째 변수의 시계열(전부 동일 길이, 시간 오름차순). M:N 은 leg 별 `ln(close)`.
/// `lags` = VECM 시차 p (≥1). 1 이면 `ΔY_{t-i}` 항 없이 상수만.
///
/// 표본 부족·비유한값·특이/준특이 행렬·λ 범위 이탈이면 None (부가 지표라 실패는 조용히 무시).
/// 실패 사유가 필요하면 `johansen_checked`.
pub fn johansen(y: &[Vec<f64>], lags: usize) -> Option<JohansenResult> {
    johansen_checked(y, lags).ok()
}

/// `johansen` 의 사유 반환판. 진단 집계용 — 사유는 고정 집합(`&'static str`)이라 그대로 카운트 키.
pub fn johansen_checked(y: &[Vec<f64>], lags: usize) -> Result<JohansenResult, &'static str> {
    let n = y.len();
    if n < 2 {
        return Err("johansen: 변수<2");
    }
    if lags < 1 {
        return Err("johansen: lags<1");
    }
    let t = y[0].len();
    if y.iter().any(|s| s.len() != t) {
        return Err("johansen: 길이 불일치");
    }
    if t <= lags {
        return Err("johansen: 표본<=lags");
    }
    let t_eff = t - lags;
    if t_eff < MIN_OBS {
        return Err("johansen: 유효표본<30");
    }
    if t_eff < MIN_OBS_PER_VAR * n {
        return Err("johansen: 유효표본<10×변수");
    }
    // Z2 회귀자 수 (상수 + 시차 차분). 자유도 여유 확인.
    let n_z2 = 1 + n * (lags - 1);
    if t_eff <= n_z2 + 2 * n {
        return Err("johansen: 자유도 부족");
    }
    if y.iter().any(|s| s.iter().any(|v| !v.is_finite())) {
        return Err("johansen: 비유한값");
    }

    // 행 i (0..t_eff) ↔ 시점 t = lags + i.
    //   Z0[i] = ΔY_t = Y[t] − Y[t-1]
    //   Z1[i] = Y_{t-1}
    //   Z2[i] = [1, ΔY_{t-1}, …, ΔY_{t-lags+1}]
    let mut z0 = DMatrix::<f64>::zeros(t_eff, n);
    let mut z1 = DMatrix::<f64>::zeros(t_eff, n);
    let mut z2 = DMatrix::<f64>::zeros(t_eff, n_z2);
    for i in 0..t_eff {
        let tt = lags + i;
        for c in 0..n {
            z0[(i, c)] = y[c][tt] - y[c][tt - 1];
            z1[(i, c)] = y[c][tt - 1];
        }
        z2[(i, 0)] = 1.0;
        for j in 1..lags {
            // ΔY_{t-j} = Y[t-j] − Y[t-j-1]. tt ≥ lags ≥ j+1 이라 인덱스 안전.
            let src = tt - j;
            for c in 0..n {
                z2[(i, 1 + (j - 1) * n + c)] = y[c][src] - y[c][src - 1];
            }
        }
    }

    let r0 = residual_after(&z2, &z0).ok_or("johansen: Z2 회귀 특이")?;
    let r1 = residual_after(&z2, &z1).ok_or("johansen: Z2 회귀 특이")?;
    let tf = t_eff as f64;
    let s00 = (r0.transpose() * &r0) / tf;
    let s01 = (r0.transpose() * &r1) / tf;
    let s11 = (r1.transpose() * &r1) / tf;

    // S00 = 차분(수익률) 공분산. 특이 = 거래정지·고정가 leg 또는 완전 중복 leg.
    let chol00 = guarded_cholesky(s00).ok_or("johansen: S00 특이(ΔY 공선)")?;
    // S11 = 레벨 공분산. 특이 = leg 레벨이 거의 완전 공선 (같은 지수 복제 ETF 등).
    let chol11 = guarded_cholesky(s11).ok_or("johansen: S11 특이(레벨 공선)")?;

    // A = S10 S00⁻¹ S01 (대칭 PSD).
    let a = s01.transpose() * chol00.solve(&s01);
    // 일반화 고유값 문제를 표준 대칭형으로: M = L⁻¹ A L⁻ᵀ (S11 = LL').
    //   B  = L⁻¹A       (하삼각 해)
    //   M  = L⁻¹ Bᵀ     (A 대칭이므로 Bᵀ = A L⁻ᵀ)
    let l = chol11.l();
    let b = l.solve_lower_triangular(&a).ok_or("johansen: 삼각 해 실패")?;
    let m_raw = l
        .solve_lower_triangular(&b.transpose())
        .ok_or("johansen: 삼각 해 실패")?;
    // 수치 비대칭 제거 — SymmetricEigen 은 하삼각만 읽지만, 대칭화가 값 안정에 유리.
    let m = (&m_raw + &m_raw.transpose()) * 0.5;

    let eig = SymmetricEigen::new(m);
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| {
        eig.eigenvalues[j]
            .partial_cmp(&eig.eigenvalues[i])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut eigenvalues = Vec::with_capacity(n);
    for &idx in &order {
        let lam = eig.eigenvalues[idx];
        if !lam.is_finite() || lam > MAX_EIGENVALUE {
            return Err("johansen: λ 범위 이탈");
        }
        // 미세 음수는 수치 잡음 — 0 으로 클램프 (ln(1−λ) 는 λ=0 에서 0).
        eigenvalues.push(lam.max(0.0));
    }

    // 공적분 벡터 β = L⁻ᵀ v (최대 고유값 대응). β' S11 β = 1 (Johansen 정규화)로 나오지만,
    // 표시·비교 편의를 위해 L2=1 로 다시 정규화한다.
    let v = eig.eigenvectors.column(order[0]).into_owned();
    let beta = l
        .transpose()
        .solve_upper_triangular(&v)
        .ok_or("johansen: β 삼각 해 실패")?;
    let mut coint_vector: Vec<f64> = beta.iter().copied().collect();
    if coint_vector.iter().any(|v| !v.is_finite()) {
        return Err("johansen: β 비유한값");
    }
    normalize_l2_sign(&mut coint_vector).ok_or("johansen: β norm=0")?;

    // trace = −T Σ_{i≥r} ln(1−λ_i) — 뒤에서부터 누적하면 한 번 순회로 전부 나온다.
    let mut trace_stats = vec![0.0_f64; n];
    let mut max_eig_stats = vec![0.0_f64; n];
    let mut acc = 0.0_f64;
    for r in (0..n).rev() {
        let term = -(1.0 - eigenvalues[r]).ln();
        if !term.is_finite() {
            return Err("johansen: trace 비유한값");
        }
        acc += term;
        trace_stats[r] = tf * acc;
        max_eig_stats[r] = tf * term;
    }

    let trace_crit_95: Vec<Option<f64>> = (0..n).map(|r| crit(&TRACE_CRIT, n - r, COL_95)).collect();
    let trace_crit_99: Vec<Option<f64>> = (0..n).map(|r| crit(&TRACE_CRIT, n - r, COL_99)).collect();
    let max_eig_crit_95: Vec<Option<f64>> =
        (0..n).map(|r| crit(&MAX_EIG_CRIT, n - r, COL_95)).collect();

    // 순차 검정 — r=0 부터, 기각되면(통계량 > 임계값) r+1 로. 처음 기각 실패한 r 이 추정 rank.
    let estimate_rank = |crits: &[Option<f64>]| -> Option<usize> {
        let mut r = 0;
        while r < n {
            let c = crits[r]?; // 표 밖 → 미판정
            if trace_stats[r] > c {
                r += 1;
            } else {
                break;
            }
        }
        Some(r)
    };

    Ok(JohansenResult {
        n_vars: n,
        n_obs: t_eff,
        lags,
        rank_95: estimate_rank(&trace_crit_95),
        rank_99: estimate_rank(&trace_crit_99),
        eigenvalues,
        trace_stats,
        trace_crit_95,
        trace_crit_99,
        max_eig_stats,
        max_eig_crit_95,
        coint_vector,
    })
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

/// `target` 을 `z` 에 회귀한 잔차 `target − Z(Z'Z)⁻¹Z'target`.
fn residual_after(z: &DMatrix<f64>, target: &DMatrix<f64>) -> Option<DMatrix<f64>> {
    let zt = z.transpose();
    let chol = guarded_cholesky(&zt * z)?;
    Some(target - z * chol.solve(&(&zt * target)))
}

/// Cholesky + 준특이 가드. 완전 특이(비양정치)는 `Cholesky::new` 가, 준특이는 대각비가 잡는다.
fn guarded_cholesky(m: DMatrix<f64>) -> Option<Cholesky<f64, Dyn>> {
    let chol = Cholesky::new(m)?;
    let l = chol.l();
    let mut lo = f64::INFINITY;
    let mut hi = 0.0_f64;
    for i in 0..l.nrows() {
        let d = l[(i, i)].abs();
        if !d.is_finite() {
            return None;
        }
        lo = lo.min(d);
        hi = hi.max(d);
    }
    if !(hi > 0.0) || lo / hi < MIN_DIAG_RATIO {
        return None;
    }
    Some(chol)
}

/// 여러 계열의 close 행렬에서 **모든 계열이 양수인 최장 연속 구간** `[start, end)`.
///
/// Johansen 입력 전처리 전용이라 여기 둔다 — `ΔY_t` 를 쓰는 검정은 결측 시점을 개별로
/// 빼면 차분이 구멍을 건너뛰어 가짜 점프가 생기므로, **연속 구간**만 써야 한다.
/// (합성 스프레드를 보는 `mn_detail::build_composites` 는 레벨 회귀라 개별 제거로 충분하다.)
///
/// 왜 "마지막 결측 이후"가 아니라 최장 연속인가 — 실측(2026-07-28) Finance_Data
/// `ohlcv_daily.adj_close` 는 2024-04-23 이전 전체 NULL(로더가 0) 에 더해 **2026-06-02~09
/// 주간이 통째로 NULL 인 ETF 가 다수**다. tail 절단이면 그 ETF 를 쓴 M:N 페어가 33봉만
/// 남아 전멸한다(130 중 86). 최장 연속 구간이면 같은 페어가 ~510봉을 회복한다.
/// 대신 구간이 최신에서 끝나지 않을 수 있다 — 호출자가 필요하면 그 사실을 보고한다.
///
/// 모든 계열 길이가 같다고 가정. 양수 구간이 없으면 None.
pub fn longest_positive_run(closes: &[Vec<f64>]) -> Option<(usize, usize)> {
    let t = closes.first()?.len();
    if t == 0 || closes.iter().any(|c| c.len() != t) {
        return None;
    }
    let (mut best, mut best_len) = ((0_usize, 0_usize), 0_usize);
    let mut run_start = 0_usize;
    for i in 0..=t {
        let ok = i < t && closes.iter().all(|c| c[i] > 0.0);
        if ok {
            continue;
        }
        // i 에서 끊김 (또는 끝) → [run_start, i) 가 하나의 연속 구간.
        if i - run_start > best_len {
            best_len = i - run_start;
            best = (run_start, i);
        }
        run_start = i + 1;
    }
    if best_len == 0 {
        None
    } else {
        Some(best)
    }
}

/// L2=1 정규화 + 첫 비영 성분 양수로 부호 고정 (결정성).
fn normalize_l2_sign(v: &mut [f64]) -> Option<()> {
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if !(norm > 0.0) || !norm.is_finite() {
        return None;
    }
    for x in v.iter_mut() {
        *x /= norm;
    }
    let sign = v
        .iter()
        .find(|x| x.abs() > 1e-12)
        .map(|x| if *x < 0.0 { -1.0 } else { 1.0 })
        .unwrap_or(1.0);
    if sign < 0.0 {
        for x in v.iter_mut() {
            *x = -*x;
        }
    }
    Some(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// golden 값 출처 — 두 경로로 교차검증한 뒤 박았다:
//   (1) 독립 구현: numpy `lstsq` + 명시적 역행렬 + `eigh` (Cholesky 경로와 다른 수치 경로)
//   (2) statsmodels `coint_johansen(y, det_order=0, k_ar_diff=lags-1)` — lags=2 케이스에서
//       (1)·(2) 가 소수 10자리까지 일치함을 확인. lags=1 은 statsmodels 의 레벨 항 off-by-one
//       때문에 (1) 만 사용 (모듈 문서 주석 참조).
// 입력 계열은 고정 시드 LCG — Python 레퍼런스와 연산 순서까지 동일해 비트 재현된다.
#[cfg(test)]
mod tests {
    use super::*;

    /// numerical-recipes 계열 LCG (a=1664525, c=1013904223, m=2³²). 결정론적 테스트 입력 전용.
    struct Lcg(u32);

    impl Lcg {
        fn new(seed: u32) -> Self {
            Self(seed)
        }
        /// [0,1) 균등 — 2⁻³² 배수라 f64 로 정확히 표현된다.
        fn unit(&mut self) -> f64 {
            self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
            self.0 as f64 / 4294967296.0
        }
        /// [-0.5, 0.5) 균등 노이즈.
        fn noise(&mut self) -> f64 {
            self.unit() - 0.5
        }
    }

    /// 로그가격 공간: `y_a` = random walk, `y_b = 2·y_a + 정상노이즈`.
    /// 반환 순서 `[y_b, y_a]` → 공적분 벡터는 (1, −2) 방향이어야 한다.
    fn cointegrated(t: usize, seed: u32) -> Vec<Vec<f64>> {
        let mut rng = Lcg::new(seed);
        let mut a = Vec::with_capacity(t);
        let mut lvl = 9.2_f64;
        for _ in 0..t {
            lvl += 0.01 * rng.noise();
            a.push(lvl);
        }
        let b: Vec<f64> = a.iter().map(|v| 2.0 * v + 0.02 * rng.noise()).collect();
        vec![b, a]
    }

    /// 독립 random walk 2개 — 공적분 없음 (rank 0).
    fn independent_walks(t: usize, seed: u32) -> Vec<Vec<f64>> {
        let mut rng = Lcg::new(seed);
        let (mut la, mut lb) = (9.2_f64, 8.5_f64);
        let mut a = Vec::with_capacity(t);
        let mut b = Vec::with_capacity(t);
        for _ in 0..t {
            la += 0.01 * rng.noise();
            lb += 0.01 * rng.noise();
            a.push(la);
            b.push(lb);
        }
        vec![a, b]
    }

    /// 3변수, 공적분 관계 정확히 1개: `y3 = y1 + y2 + 정상노이즈` (y1·y2 는 독립 RW).
    fn triple_one_relation(t: usize, seed: u32) -> Vec<Vec<f64>> {
        let mut rng = Lcg::new(seed);
        let (mut l1, mut l2) = (9.0_f64, 8.0_f64);
        let (mut y1, mut y2, mut y3) = (Vec::new(), Vec::new(), Vec::new());
        for _ in 0..t {
            l1 += 0.01 * rng.noise();
            l2 += 0.01 * rng.noise();
            y1.push(l1);
            y2.push(l2);
            y3.push(l1 + l2 + 0.02 * rng.noise());
        }
        vec![y1, y2, y3]
    }

    fn close(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() <= tol * b.abs().max(1.0)
    }

    #[test]
    fn detects_rank_one_and_recovers_coint_vector() {
        let y = cointegrated(400, 20260728);
        let r = johansen(&y, 1).expect("johansen");
        assert_eq!(r.n_vars, 2);
        assert_eq!(r.n_obs, 399);
        // golden (독립 numpy 구현)
        assert!(close(r.eigenvalues[0], 0.5440306154, 1e-8), "λ1 {}", r.eigenvalues[0]);
        assert!(close(r.eigenvalues[1], 0.0001730028, 1e-6), "λ2 {}", r.eigenvalues[1]);
        assert!(close(r.trace_stats[0], 313.415549, 1e-7), "trace0 {}", r.trace_stats[0]);
        assert!(close(r.trace_stats[1], 0.069034, 1e-5), "trace1 {}", r.trace_stats[1]);
        assert!(close(r.max_eig_stats[0], 313.346515, 1e-7));
        // r=0 은 기각(313 > 15.49), r=1 은 기각 실패(0.069 < 3.84) → rank 1
        assert_eq!(r.trace_crit_95, vec![Some(15.4943), Some(3.8415)]);
        assert_eq!(r.rank_95, Some(1));
        assert_eq!(r.rank_99, Some(1));
        // 공적분 벡터 (1, −2) 방향 — L2=1·첫성분 양수 정규화라 부호까지 결정적.
        let ratio = r.coint_vector[1] / r.coint_vector[0];
        assert!((ratio + 2.0).abs() < 0.05, "coint vector ratio {ratio}");
        assert!(r.coint_vector[0] > 0.0);
        assert!(close(r.coint_vector.iter().map(|v| v * v).sum::<f64>(), 1.0, 1e-12));
    }

    #[test]
    fn matches_statsmodels_when_lagged_diffs_present() {
        // lags=2 → statsmodels `coint_johansen(y, 0, 1)` 과 완전 일치하는 케이스.
        let y = cointegrated(400, 20260728);
        let r = johansen(&y, 2).expect("johansen");
        assert_eq!(r.n_obs, 398);
        assert!(close(r.eigenvalues[0], 0.3897912959, 1e-8), "λ1 {}", r.eigenvalues[0]);
        assert!(close(r.eigenvalues[1], 0.0000530248, 1e-5), "λ2 {}", r.eigenvalues[1]);
        assert!(close(r.trace_stats[0], 196.614893, 1e-7), "trace0 {}", r.trace_stats[0]);
        assert!(close(r.trace_stats[1], 0.021104, 1e-5), "trace1 {}", r.trace_stats[1]);
        assert_eq!(r.rank_95, Some(1));

        // 3변수도 statsmodels 와 일치 확인 (표 인덱싱·정렬이 n>2 에서 어긋나지 않는지).
        let y3 = triple_one_relation(500, 999);
        let r3 = johansen(&y3, 2).expect("johansen");
        assert_eq!(r3.n_obs, 498);
        assert!(close(r3.eigenvalues[0], 0.3413657939, 1e-8));
        assert!(close(r3.eigenvalues[1], 0.0083109984, 1e-6));
        assert!(close(r3.eigenvalues[2], 0.0001447972, 1e-5));
        assert!(close(r3.trace_stats[0], 212.186599, 1e-7));
        assert!(close(r3.trace_stats[1], 4.228286, 1e-6));
        assert!(close(r3.trace_stats[2], 0.072114, 1e-5));
        assert_eq!(r3.rank_95, Some(1));
    }

    #[test]
    fn independent_random_walks_give_rank_zero() {
        let y = independent_walks(400, 31337);
        let r = johansen(&y, 1).expect("johansen");
        assert!(close(r.trace_stats[0], 3.015477, 1e-6), "trace0 {}", r.trace_stats[0]);
        assert!(close(r.trace_stats[1], 0.002996, 1e-4), "trace1 {}", r.trace_stats[1]);
        // 3.02 < 15.49 → r=0 기각 실패 → rank 0
        assert_eq!(r.rank_95, Some(0));
        assert_eq!(r.rank_99, Some(0));
    }

    #[test]
    fn three_vars_single_relation() {
        let y = triple_one_relation(500, 999);
        let r = johansen(&y, 1).expect("johansen");
        assert_eq!(r.n_vars, 3);
        assert_eq!(r.n_obs, 499);
        assert!(close(r.trace_stats[0], 380.621203, 1e-7), "trace0 {}", r.trace_stats[0]);
        assert!(close(r.trace_stats[1], 3.781295, 1e-6), "trace1 {}", r.trace_stats[1]);
        assert!(close(r.trace_stats[2], 0.094236, 1e-4), "trace2 {}", r.trace_stats[2]);
        assert_eq!(
            r.trace_crit_95,
            vec![Some(29.7961), Some(15.4943), Some(3.8415)]
        );
        assert_eq!(r.rank_95, Some(1));
        // y1 + y2 − y3 이 정상 → 계수비 (1, 1, −1).
        let v = &r.coint_vector;
        assert!((v[1] / v[0] - 1.0).abs() < 0.06, "v {v:?}");
        assert!((v[2] / v[0] + 1.0).abs() < 0.06, "v {v:?}");
    }

    #[test]
    fn numeric_guards_return_none() {
        let base = cointegrated(400, 20260728);
        // 상수열 — ΔY 가 0 벡터 → S00 특이.
        let mut constant = base.clone();
        constant[1] = vec![9.2; 400];
        assert!(johansen(&constant, 1).is_none());
        // 완전 중복 계열 — S11 특이(공선).
        let dup = vec![base[0].clone(), base[0].clone()];
        assert!(johansen(&dup, 1).is_none());
        // 표본 부족 (변수당 10 미만).
        assert!(johansen(&cointegrated(19, 20260728), 1).is_none());
        // 길이 불일치.
        let mut ragged = base.clone();
        ragged[1].truncate(390);
        assert!(johansen(&ragged, 1).is_none());
        // 비유한값.
        let mut nan = base.clone();
        nan[0][10] = f64::NAN;
        assert!(johansen(&nan, 1).is_none());
        // 변수 1개 / lags 0.
        assert!(johansen(&base[..1], 1).is_none());
        assert!(johansen(&base, 0).is_none());
    }

    #[test]
    fn longest_run_picks_biggest_contiguous_block() {
        // 두 계열 — 0(=adj_close 결측) 이 앞과 중간에 흩어져 있다.
        let a = vec![0.0, 0.0, 10.0, 11.0, 12.0, 13.0, 0.0, 14.0, 15.0];
        let b = vec![1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        assert_eq!(longest_positive_run(&[a.clone(), b.clone()]), Some((2, 6)));
        // 한 계열이 다른 위치에서 끊기면 교집합 기준.
        let c = vec![1.0, 1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        assert_eq!(longest_positive_run(&[a, c]), Some((4, 6)));
        // 끝까지 이어지는 구간.
        assert_eq!(longest_positive_run(&[vec![1.0, 2.0, 3.0]]), Some((0, 3)));
        // 양수 구간 없음 / 빈 입력 / 길이 불일치.
        assert_eq!(longest_positive_run(&[vec![0.0, 0.0]]), None);
        assert_eq!(longest_positive_run(&[]), None);
        assert_eq!(longest_positive_run(&[vec![1.0, 2.0], vec![1.0]]), None);
    }

    #[test]
    fn crit_table_bounds() {
        // n−r = 1..12 만 값이 있고, 표 밖은 None.
        assert_eq!(crit(&TRACE_CRIT, 1, COL_95), Some(3.8415));
        assert_eq!(crit(&TRACE_CRIT, 12, COL_99), Some(351.2150));
        assert_eq!(crit(&TRACE_CRIT, 13, COL_95), None);
        assert_eq!(crit(&TRACE_CRIT, 0, COL_95), None);
        assert_eq!(crit(&MAX_EIG_CRIT, 2, COL_95), Some(14.2639));
        // 임계값은 유의수준이 높을수록 커야 하고, n−r 이 클수록 커야 한다 (표 오타 방지).
        for row in TRACE_CRIT.iter().chain(MAX_EIG_CRIT.iter()) {
            assert!(row[0] < row[1] && row[1] < row[2], "row {row:?}");
        }
        for w in TRACE_CRIT.windows(2) {
            assert!(w[0][1] < w[1][1]);
        }
        for w in MAX_EIG_CRIT.windows(2) {
            assert!(w[0][1] < w[1][1]);
        }
    }

    #[test]
    fn rank_undecided_when_beyond_table() {
        // n = 13 > 표 범위 → 통계량은 나오되 rank 는 미판정.
        let t = 400;
        let mut series: Vec<Vec<f64>> = Vec::new();
        for k in 0..13u32 {
            let mut rng = Lcg::new(1000 + k);
            let mut lvl = 9.0 + k as f64 * 0.01;
            let mut v = Vec::with_capacity(t);
            for _ in 0..t {
                lvl += 0.01 * rng.noise();
                v.push(lvl);
            }
            series.push(v);
        }
        let r = johansen(&series, 1).expect("johansen");
        assert_eq!(r.n_vars, 13);
        assert_eq!(r.trace_stats.len(), 13);
        assert_eq!(r.trace_crit_95[0], None); // n−r = 13 → 표 밖
        assert_eq!(r.trace_crit_95[1], Some(334.9795)); // n−r = 12 → 표 안
        assert_eq!(r.rank_95, None);
        assert_eq!(r.rank_99, None);
    }
}
