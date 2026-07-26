//! 팩터중립 s-score 트랙 — Avellaneda & Lee (2010), *Statistical Arbitrage in the U.S.
//! Equities Market*.
//!
//! 1:1 / M:N 발굴과 **완전히 독립된 별도 트랙**이다. 여기서는 "A vs B"가 아니라
//! "A vs A 자신의 팩터 노출"을 본다. 종목 수익률에서 공통 팩터(시장·섹터)를 회귀로 걷어낸
//! **고유(idiosyncratic) 잔차**의 평균회귀만 남기므로, 시장 대용 바스켓 ETF가 허브가 되는
//! 1:1 전조합 발굴의 구조적 편향(코리아TOP10·ESG 같은 종목이 leg-slot 상위 독식)이 원리상
//! 발생하지 않는다. 헤지는 페어 상대가 아니라 지수선물/팩터 ETF로 한다 (ETF LP 본업과 일치).
//!
//! ## 절차 (AL 2010 §3~§4)
//!
//! 1. **팩터 추출** — 최근 `corr_window`(252영업일) 로그수익률의 **상관행렬** PCA.
//!    상위 `n_factors`(15) 고유벡터 v^(k).
//! 2. **eigenportfolio 수익률** — 가중치 `Q_i^(k) = v_i^(k) / σ_i` (고유벡터 성분 ÷ 종목
//!    변동성). 본 구현은 추가로 `Σ_i |Q_i| = 1` 로 정규화해 **총노출 1의 포트폴리오 수익률**로
//!    만든다 (AL 원문의 스케일 자유도. β 해석이 "그 포트폴리오에 대한 베타"가 되고,
//!    정규방정식의 열 스케일이 팩터 간 균질해져 수치 안정성도 좋아짐).
//!    `F_k(t) = Σ_i Q_i^(k) R_i(t)`.
//! 3. **잔차 회귀** — 최근 `reg_window`(60영업일)에서 종목마다
//!    `R_i(t) = β_i0 + Σ_k β_ik F_k(t) + ε_i(t)` 다중 OLS.
//!    설계행렬이 전 종목 공통이라 `X'X` Cholesky 분해는 **사이클당 1회**만 한다.
//! 4. **OU 적합** — 잔차 누적 `X_i(t) = Σ_{s<=t} ε_i(s)` 에 AR(1) `X(t) = a + b·X(t-1) + ζ`.
//!    `0 < b < 1` 이 아니면 평균회귀 없음 → 제외.
//! 5. **s-score** — `s_i = (X_i(last) − m_i) / σ_eq,i`.
//!
//! ## 시간 단위 (혼동 주의)
//!
//! AR(1) 한 스텝 = **1영업일**이다. 따라서
//!   - `κ_daily = −ln(b)`            [1/일]
//!   - `half_life = ln2 / κ_daily`    [일]  ← 화면/게이트는 전부 이 **일 단위**
//!   - `kappa = κ_daily × 252`        [1/년] ← AL 논문 표기(연율)와 맞추기 위한 노출값
//!
//! AL은 "회귀 시간 1/κ 가 회귀창의 절반보다 빨라야"(60일 창 → 30일, κ > 252/30 = 8.4) 라고
//! 요구한다. 본 구현은 같은 취지를 **half-life 상한**(기본 30일 = reg_window/2)으로 건다.
//! (half_life = ln2/κ_daily 이므로 hl ≤ 30일은 1/κ ≤ 43일 — AL보다 약간 느슨한 쪽.)
//!
//! ## X(last) ≈ 0 인 이유 (버그 아님)
//!
//! 회귀에 절편이 있으면 OLS 잔차 합은 정확히 0이라, 창 전체를 누적한 `X(last)` 는 0이 된다.
//! 즉 실질적으로 `s = −m/σ_eq` 다 — "누적잔차 경로의 평형 수준 m 대비 지금(=0) 어디인가".
//! m > 0 이면 지금이 평형보다 아래 → 싸다 → s < 0 (매수 후보). AL의 정의 그대로이며,
//! 공식은 일반형 `(X_last − m)/σ_eq` 로 두어 절편 없는 변형에도 그대로 성립하게 한다.

use std::sync::OnceLock;
use std::time::Instant;

use nalgebra::{Cholesky, DMatrix, DVector, Dyn};
use serde::Serialize;

use crate::data::bars::{SeriesCache, Timeframe};
use crate::stats;

/// 연 영업일 수 — κ 연율화 계수 (AL 논문 표기와 일치).
const TRADING_DAYS_PER_YEAR: f64 = 252.0;

// ---------------------------------------------------------------------------
// 파라미터 — 전부 env 튜닝 가능 (`STATARB_SSCORE_*`). 근거는 각 필드 주석.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize)]
pub struct SScoreParams {
    /// 상관행렬 PCA 창 (영업일). AL 기본 252(1년) — 섹터 구조가 안정적으로 잡히는 최소 길이.
    pub corr_window: usize,
    /// 유지할 팩터 수. AL 기본 15 (미국 주식 ~1000종목에서 설명력 ~55%).
    /// 한국 시장 유니버스(~650)에서도 15면 PC1 시장 + 섹터/스타일 축을 덮는다.
    pub n_factors: usize,
    /// 잔차 회귀 창 (영업일). AL 기본 60 — 팩터 노출의 시변성과 표본 크기의 절충.
    /// 반드시 `n_factors + 3` 초과여야 회귀 자유도가 남는다.
    pub reg_window: usize,
    /// half-life 하한 (일). 0.5일 미만은 표본 끝점 우연/미시구조 노이즈로 본다
    /// (1:1 발굴 `MIN_HALF_LIFE` 와 같은 취지·같은 값).
    pub min_half_life: f64,
    /// half-life 상한 (일). 기본 30 = reg_window/2 — AL의 "회귀창 절반보다 빨라야" 요구.
    /// 이보다 느리면 60일 창으로 추정한 κ 자체를 신뢰할 수 없다.
    pub max_half_life: f64,
    /// 팩터 회귀 R² 상한. 잔차가 사실상 수치 노이즈(설명력 99% 초과)면 OU 적합이 무의미하다.
    /// 실질적으로 "지수 완전복제 ETF"처럼 팩터의 선형결합으로 재현되는 시리즈를 걸러낸다.
    pub max_r_squared: f64,
}

pub fn params() -> &'static SScoreParams {
    static CELL: OnceLock<SScoreParams> = OnceLock::new();
    CELL.get_or_init(|| {
        let corr_window = env_usize("STATARB_SSCORE_CORR_WINDOW", 252);
        let n_factors = env_usize("STATARB_SSCORE_N_FACTORS", 15);
        let reg_window = env_usize("STATARB_SSCORE_REG_WINDOW", 60);
        // 정합성 클램프 — 잘못된 env로 무한/발산 대신 안전한 값으로 수렴시킨다.
        let n_factors = n_factors.clamp(1, 50);
        let reg_window = reg_window.max(n_factors + 5);
        let corr_window = corr_window.max(reg_window);
        SScoreParams {
            corr_window,
            n_factors,
            reg_window,
            min_half_life: env_f64("STATARB_SSCORE_MIN_HL", 0.5),
            max_half_life: env_f64("STATARB_SSCORE_MAX_HL", 30.0),
            max_r_squared: env_f64("STATARB_SSCORE_MAX_R2", 0.99),
        }
    })
}

fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .unwrap_or(default)
}

// ---------------------------------------------------------------------------
// 산출 타입
// ---------------------------------------------------------------------------

/// 종목의 팩터 노출 한 건.
///
/// **β 와 contrib 을 왜 둘 다 주는가** — eigenportfolio 는 `Σ|Q| = 1`(총노출 1) 로 정규화한
/// 실제 포트폴리오라, β 는 "그 포트폴리오 대비 헤지비율"이라는 매매 가능한 의미를 갖는다
/// (F1 은 시장 팩터 포트폴리오. 단 역변동성 성격의 분산 포트폴리오라 개별 종목 β_1 은
/// 통상 1보다 크다 — CAPM 시장베타와 같은 값이 아니다). 다만 상위 PC 로 갈수록 long-short
/// 분산 포트폴리오라 변동성이 작아 β 절댓값만 커진다 — **|β| 로 정렬하면 항상 저변동
/// 팩터가 뽑히는 착시**가 생긴다. 그래서 정렬·표시 우선순위는 표준화 기여도
/// `contrib = β × σ_F` (팩터 1σ 이동당 종목 일간수익률 기여)로 잡는다.
#[derive(Debug, Clone, Serialize)]
pub struct FactorBeta {
    /// PCA factor 인덱스 (0-based — `GroupPcaFactor.factor_idx` 와 같은 규약).
    pub factor_idx: usize,
    /// 회귀계수 (총노출 1 eigenportfolio 대비).
    pub beta: f64,
    /// β × σ_F — 팩터 1σ 이동당 종목 일간수익률 기여 (수익률 단위).
    pub contrib: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SScoreResult {
    /// series_key (`S:005930` / `E:069500`).
    pub key: String,
    /// 6자리 종목코드.
    pub code: String,
    /// 표시명. 발굴 후 엔리치 패스(main.rs)에서 채움.
    pub name: String,
    /// 분류 태그 (`stock` / ETF 카테고리). 엔리치 패스에서 채움.
    pub asset_class: String,
    /// s-score. 음수 = 팩터 대비 저평가(매수 후보), 양수 = 고평가(매도 후보).
    pub s_score: f64,
    /// 평균회귀 half-life (**영업일**).
    pub half_life: f64,
    /// OU 평균회귀 속도 κ (**연율, 1/년**). AL 논문 표기와 동일 단위.
    pub kappa: f64,
    /// 팩터 회귀 R² — 이 종목이 공통 팩터로 얼마나 설명되나.
    pub r_squared: f64,
    /// 잔차 일간 변동성 σ_ε (수익률 단위, 예: 0.012 = 1.2%).
    pub resid_vol: f64,
    /// |β| 상위 팩터 (최대 3개).
    pub top_factors: Vec<FactorBeta>,
    /// 회귀에 쓰인 표본 수 (= reg_window).
    pub sample_size: usize,
    pub updated_ms: i64,
}

/// 팩터 요약 — 응답 헤더에 그대로 실린다.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SScoreFactorInfo {
    pub n_factors: usize,
    /// 유지 factor 각각의 설명력 비율 (상관행렬 고유값 / 총합).
    pub explained_variance_ratio: Vec<f64>,
    /// 유지 factor 각각의 **회귀창 기준 일간 변동성** σ_F (총노출 1 정규화 기준).
    /// F1(시장) ~1%/일, 상위 PC 는 long-short 라 훨씬 작다. β 해석의 스케일 기준.
    pub factor_vol: Vec<f64>,
    pub corr_window: usize,
    pub reg_window: usize,
    /// PCA에 실제 들어간 시리즈 수.
    pub universe_size: usize,
}

/// 사이클당 1회 계산해 보관하는 상태. 요청마다 재계산하지 않는다.
#[derive(Debug, Clone, Default)]
pub struct SScoreState {
    /// 품질 게이트 통과 종목. **|s_score| 내림차순** 정렬 보관.
    pub items: Vec<SScoreResult>,
    pub factors: SScoreFactorInfo,
    pub last_run_ms: i64,
    pub duration_ms: u64,
    /// 진단 — 후보/탈락 집계. 로깅 전용.
    pub diag: SScoreDiag,
}

/// 탈락 사유 집계 (진단 로깅 전용 — 게이팅에 영향 없음).
#[derive(Debug, Clone, Copy, Default)]
pub struct SScoreDiag {
    /// 캐시에서 뽑힌 주식/ETF 시리즈 수.
    pub cache_series: usize,
    /// 표본 부족(일봉 < corr_window+1)으로 탈락.
    pub short_sample: usize,
    /// 거래일 달력 불일치로 탈락.
    pub calendar_mismatch: usize,
    /// 수익률 분산 0(거래정지·고정가)으로 탈락.
    pub zero_var: usize,
    /// 다중 회귀 실패(수치).
    pub regression_fail: usize,
    /// OU 적합 실패 (b ≤ 0 또는 b ≥ 1 = 평균회귀 없음 포함).
    pub ou_fail: usize,
    /// half-life 게이트 탈락.
    pub half_life_gate: usize,
    /// R² 상한 게이트 탈락.
    pub r_squared_gate: usize,
    /// 통과 종목의 β_1(= F1 노출) 중앙값.
    /// 주의 — **1 근처를 기대하면 안 된다**. F1 은 `Q = v/σ` 가중(역변동성 성격)의 분산
    /// 포트폴리오라 개별 종목보다 변동성이 낮고(실측 σ_F1 ≈ 1.1%/일 vs 개별주 2~4%/일),
    /// 게다가 여기 β_1 은 15팩터 다변량 계수다 → 개별주 β_1 이 1보다 큰 게 정상.
    /// 감시 포인트는 "값 자체가 1이냐"가 아니라 **부호가 양수이고 사이클 간 안정적이냐**.
    pub market_beta_median: f64,
    /// F1 의 일간 변동성 (회귀창 기준). 시장 지수 일간 변동성 수준(0.5~1.5%)이면 정상 —
    /// 여기가 벗어나면 eigenportfolio 가중치 구성(v/σ 정규화)이 깨진 것이다.
    pub factor1_vol: f64,
}

// ---------------------------------------------------------------------------
// 다중 OLS — 정규방정식 + Cholesky
// ---------------------------------------------------------------------------

/// 전 종목 공통 설계행렬 `X = [1, F_1, …, F_K]` (T×(K+1)).
/// `X'X` 분해를 한 번만 하고 종목마다 `X'y` 만 새로 만들어 푼다.
pub struct FactorDesign {
    /// T×(K+1). 0열 = 절편.
    x: DMatrix<f64>,
    /// Xᵀ (K+1)×T — fit 마다 transpose 재할당하지 않으려고 보관.
    xt: DMatrix<f64>,
    chol: Cholesky<f64, Dyn>,
    t: usize,
    /// 팩터 수 K (절편 제외). `n_factors()` 접근자 전용.
    #[allow(dead_code)]
    k: usize,
    /// Cholesky 대각의 min/max 비 — 설계행렬 조건수 대용(cond(X'X) ≈ (max/min)²).
    /// 1에 가까울수록 팩터가 서로 잘 분리돼 있다. 진단 로깅용.
    diag_ratio: f64,
}

/// 다중 OLS 적합 결과.
#[derive(Debug, Clone)]
pub struct MultiOlsFit {
    /// [절편, β_1, …, β_K].
    pub coeffs: Vec<f64>,
    pub residuals: Vec<f64>,
    pub r_squared: f64,
}

impl FactorDesign {
    /// `factors[k]` = 팩터 k의 시계열 (모두 길이 T). 특이/준특이 설계행렬이면 None.
    pub fn new(factors: &[Vec<f64>]) -> Option<Self> {
        let k = factors.len();
        if k == 0 {
            return None;
        }
        let t = factors[0].len();
        // 자유도 최소 3 확보 (T > K+1).
        if t < k + 4 || factors.iter().any(|f| f.len() != t) {
            return None;
        }
        let mut x = DMatrix::<f64>::zeros(t, k + 1);
        for r in 0..t {
            x[(r, 0)] = 1.0;
        }
        for (j, f) in factors.iter().enumerate() {
            for r in 0..t {
                if !f[r].is_finite() {
                    return None;
                }
                x[(r, j + 1)] = f[r];
            }
        }
        let xt = x.transpose();
        let xtx = &xt * &x;
        let chol = Cholesky::new(xtx)?; // 양정치 아니면 None = 특이행렬 가드
        // 준특이 가드 — Cholesky 대각의 동적 범위가 극단이면 해가 신뢰 불가.
        // `Cholesky::new` 는 완전 특이만 잡는다: 절편과 완전 공선인 상수열을 넣어도
        // 마지막 pivot 이 1e-8 수준의 *양수* 로 나와 통과한다(실측). 조건수 cond(X'X) ≈
        // (max/min)² 이므로 1e-6 컷 = cond 1e12 — f64 유효자릿수(≈1e16) 대비 4자리 여유.
        // 정상 eigenportfolio 설계행렬은 1e-2~1e-3 수준이라 오탐 여지 없음.
        let l = chol.l();
        let mut min_d = f64::INFINITY;
        let mut max_d = 0.0_f64;
        for i in 0..=k {
            let d = l[(i, i)].abs();
            if !d.is_finite() {
                return None;
            }
            min_d = min_d.min(d);
            max_d = max_d.max(d);
        }
        if !(max_d > 0.0) {
            return None;
        }
        let diag_ratio = min_d / max_d;
        if diag_ratio < 1e-6 {
            return None;
        }
        Some(Self { x, xt, chol, t, k, diag_ratio })
    }

    /// 팩터 수 K (절편 제외). 테스트·진단용 접근자.
    #[allow(dead_code)]
    pub fn n_factors(&self) -> usize {
        self.k
    }

    /// Cholesky 대각 min/max 비 (조건수 대용). 진단 로깅용.
    pub fn diag_ratio(&self) -> f64 {
        self.diag_ratio
    }

    /// 종속변수 y(길이 T) 적합. 분산 0이거나 수치 실패 시 None.
    pub fn fit(&self, y: &[f64]) -> Option<MultiOlsFit> {
        if y.len() != self.t {
            return None;
        }
        let yv = DVector::from_row_slice(y);
        let xty = &self.xt * &yv;
        let beta = self.chol.solve(&xty);
        if beta.iter().any(|v| !v.is_finite()) {
            return None;
        }
        let fitted = &self.x * &beta;
        let mut rss = 0.0;
        let mut residuals = Vec::with_capacity(self.t);
        for i in 0..self.t {
            let e = y[i] - fitted[i];
            residuals.push(e);
            rss += e * e;
        }
        let mean = y.iter().sum::<f64>() / self.t as f64;
        let tss: f64 = y.iter().map(|v| (v - mean).powi(2)).sum();
        if !(tss > 0.0) {
            return None;
        }
        let r_squared = 1.0 - rss / tss;
        if !r_squared.is_finite() {
            return None;
        }
        Some(MultiOlsFit {
            coeffs: beta.iter().copied().collect(),
            residuals,
            r_squared,
        })
    }
}

// ---------------------------------------------------------------------------
// OU 적합
// ---------------------------------------------------------------------------

/// 누적잔차 `X(t) = a + b·X(t-1) + ζ` 적합 결과. 단위 규약은 파일 헤더 참조.
#[derive(Debug, Clone, Copy)]
// a/b/σ_ζ 는 적합의 1차 파라미터라 구조체에 남긴다 (단위 테스트가 직접 검증하고,
// 파생값 κ·m·σ_eq 의 이상을 추적할 때 필요). 산출 경로에서는 파생값만 쓴다.
#[allow(dead_code)]
pub struct OuFit {
    pub a: f64,
    pub b: f64,
    /// 평균회귀 속도 (연율, 1/년).
    pub kappa: f64,
    /// half-life (영업일).
    pub half_life: f64,
    /// 평형 수준 m = a/(1−b).
    pub m: f64,
    /// 평형 표준편차 σ_eq = σ_ζ / sqrt(1−b²).
    pub sigma_eq: f64,
    /// AR(1) 잔차 표준편차 σ_ζ.
    pub sigma_zeta: f64,
}

/// AR(1) OU 적합. `0 < b < 1` (평균회귀) 아니면 None.
pub fn fit_ou(x: &[f64]) -> Option<OuFit> {
    let n = x.len();
    if n < 5 {
        return None;
    }
    let lag = &x[..n - 1];
    let cur = &x[1..];
    let r = stats::ols(lag, cur)?;
    let b = r.beta;
    // b ≤ 0: 진동/무관계, b ≥ 1: 단위근·발산 → 평균회귀 없음.
    if !(b > 0.0 && b < 1.0) {
        return None;
    }
    let dof = (n - 1) as f64 - 2.0;
    if dof <= 0.0 {
        return None;
    }
    let rss: f64 = r.residuals.iter().map(|v| v * v).sum();
    let var_zeta = rss / dof;
    if !(var_zeta > 0.0) {
        return None;
    }
    let kappa_daily = -b.ln();
    if !(kappa_daily > 0.0) {
        return None;
    }
    let half_life = std::f64::consts::LN_2 / kappa_daily;
    let m = r.alpha / (1.0 - b);
    let sigma_eq = (var_zeta / (1.0 - b * b)).sqrt();
    if !half_life.is_finite() || !m.is_finite() || !(sigma_eq > 0.0) {
        return None;
    }
    Some(OuFit {
        a: r.alpha,
        b,
        kappa: kappa_daily * TRADING_DAYS_PER_YEAR,
        half_life,
        m,
        sigma_eq,
        sigma_zeta: var_zeta.sqrt(),
    })
}

// ---------------------------------------------------------------------------
// 유니버스 수집
// ---------------------------------------------------------------------------

/// 가격 → 로그수익률.
/// (discovery.rs `log_returns` 와 동일 구현 — s-score 트랙을 기존 발굴에서 완전히 분리해
/// 두기 위해 의도적으로 복제한다. 로직 수정 시 양쪽 다 봐야 함.)
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

/// 표본 표준편차 (분모 n−1) — `stats::pca` 내부 표준화와 같은 정의를 쓴다.
/// (σ_i 는 eigenportfolio 가중치 `v_i/σ_i` 의 분모라 PCA 표준화와 정의가 어긋나면 안 된다.)
fn stddev_sample(v: &[f64]) -> Option<f64> {
    let n = v.len();
    if n < 2 {
        return None;
    }
    let mean = v.iter().sum::<f64>() / n as f64;
    let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n as f64 - 1.0);
    if !(var > 0.0) {
        return None;
    }
    Some(var.sqrt())
}

/// 캐시에서 뽑은 s-score 후보 한 건.
struct Candidate {
    key: String,
    /// 최근 `corr_window + 1` 개 종가 (우측 정렬).
    closes: Vec<f64>,
    /// 같은 구간의 거래일 ts — 달력 정합 검증용.
    ts: Vec<i64>,
    /// 전체 일봉 길이 (기준 달력 선정용).
    full_len: usize,
}

/// 주식(`S:`)·ETF(`E:`) 일봉에서 후보 추출. 지수(`I:`)·선물은 제외 (매매 단위가 아니거나
/// 팩터 회귀의 종속변수로 부적절).
///
/// 표본 정렬 정책은 1:1/M:N 의 `choose_target_len` 과 **같은 사상**이다 — 짧은 소수는 버리고
/// 나머지의 공통 길이를 쓴다. 다만 s-score 는 창 길이가 알고리즘 상수(`corr_window`)로
/// 고정돼 있어 "목표 길이 탐색"이 필요 없다: `corr_window + 1` 봉을 못 채우는 시리즈를 드롭한다.
fn collect_candidates(cache: &SeriesCache, need_closes: usize, diag: &mut SScoreDiag) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::with_capacity(cache.len());
    for entry in cache.iter() {
        let key = entry.key();
        if !(key.starts_with("S:") || key.starts_with("E:")) {
            continue;
        }
        diag.cache_series += 1;
        let bars = entry.value().bars(Timeframe::Day1);
        if bars.len() < need_closes {
            diag.short_sample += 1;
            continue;
        }
        let tail = &bars[bars.len() - need_closes..];
        out.push(Candidate {
            key: key.clone(),
            closes: tail.iter().map(|b| b.close).collect(),
            ts: tail.iter().map(|b| b.ts).collect(),
            full_len: bars.len(),
        });
    }
    // DashMap 순회 순서는 비결정적 — 키 정렬로 고정해야 동률 처리·로그가 재현 가능.
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

// ---------------------------------------------------------------------------
// 메인 계산
// ---------------------------------------------------------------------------

/// 한 사이클분 s-score 전량 계산. `name`/`asset_class` 는 비어 있으며 호출자(main.rs)가
/// 엔리치 패스에서 채운다 (ETF 분류 메타는 이 모듈의 관심사가 아님).
pub fn compute(cache: &SeriesCache) -> SScoreState {
    let t0 = Instant::now();
    let p = params();
    let mut diag = SScoreDiag::default();
    let now_ms = chrono::Utc::now().timestamp_millis();

    let need_closes = p.corr_window + 1;
    let cands = collect_candidates(cache, need_closes, &mut diag);
    if cands.len() < p.n_factors * 2 {
        tracing::warn!(
            "[s-score] 후보 부족 — {}개 (필요 {}). 계산 생략",
            cands.len(),
            p.n_factors * 2
        );
        return SScoreState {
            duration_ms: t0.elapsed().as_millis() as u64,
            last_run_ms: now_ms,
            diag,
            ..Default::default()
        };
    }

    // 1. 거래일 달력 정합 — 가장 긴(동률이면 가장 최근에 끝나는) 시리즈의 tail 을 기준으로
    //    삼고, tail ts 가 다른 시리즈는 드롭한다 (discovery.rs `tail_ts_matches` 와 동일 취지:
    //    개수 정렬은 "모든 시리즈가 같은 영업일 달력"을 가정하는데 거래정지·상폐가 그걸 깬다).
    let ref_ts: Vec<i64> = {
        let mut best: Option<&Candidate> = None;
        for c in &cands {
            let rank = (c.full_len, *c.ts.last().unwrap_or(&i64::MIN));
            match best {
                Some(b) if (b.full_len, *b.ts.last().unwrap_or(&i64::MIN)) >= rank => {}
                _ => best = Some(c),
            }
        }
        match best {
            Some(c) => c.ts.clone(),
            None => return SScoreState { last_run_ms: now_ms, diag, ..Default::default() },
        }
    };

    // 2. 로그수익률 + σ_i. 달력 불일치·분산 0 은 여기서 드롭.
    let mut keys: Vec<String> = Vec::with_capacity(cands.len());
    let mut returns: Vec<Vec<f64>> = Vec::with_capacity(cands.len());
    let mut sigmas: Vec<f64> = Vec::with_capacity(cands.len());
    for c in &cands {
        if c.ts != ref_ts {
            diag.calendar_mismatch += 1;
            continue;
        }
        let r = log_returns(&c.closes);
        let Some(sd) = stddev_sample(&r) else {
            diag.zero_var += 1;
            continue;
        };
        keys.push(c.key.clone());
        returns.push(r);
        sigmas.push(sd);
    }
    drop(cands);
    let n_vars = keys.len();
    if n_vars < p.n_factors * 2 {
        tracing::warn!("[s-score] 정합 시리즈 부족 — {n_vars}개. 계산 생략");
        return SScoreState {
            duration_ms: t0.elapsed().as_millis() as u64,
            last_run_ms: now_ms,
            diag,
            ..Default::default()
        };
    }

    // 3. 상관행렬 PCA (stats::pca 는 컬럼 z-score 표준화 후 공분산 = 상관행렬).
    let t_pca = Instant::now();
    let Some(pca) = stats::pca(&returns) else {
        tracing::warn!("[s-score] PCA 실패 (n_vars={n_vars})");
        return SScoreState {
            duration_ms: t0.elapsed().as_millis() as u64,
            last_run_ms: now_ms,
            diag,
            ..Default::default()
        };
    };
    let k = p.n_factors.min(pca.eigenvalues.len());
    let pca_ms = t_pca.elapsed().as_millis();

    // 4. eigenportfolio 가중치 Q = v/σ, Σ|Q| = 1 정규화.
    //    고유벡터 부호는 고유해가 임의로 정한다 → 성분 합이 양수가 되도록 고정해야
    //    재기동마다 β 부호가 뒤집히지 않는다 (PC1 은 시장 팩터라 합이 양수인 게 자연스럽다).
    let mut weights: Vec<Vec<f64>> = Vec::with_capacity(k);
    for f in 0..k {
        let v = &pca.loadings[f];
        let flip = if v.iter().sum::<f64>() < 0.0 { -1.0 } else { 1.0 };
        let mut q: Vec<f64> = (0..n_vars).map(|i| flip * v[i] / sigmas[i]).collect();
        let gross: f64 = q.iter().map(|w| w.abs()).sum();
        if !(gross > 0.0) {
            // 여기서 skip 하면 이후 factor 가 앞으로 당겨져 `factor_idx` 가 PCA 순번과
            // 어긋난다 → 건너뛰지 말고 그 앞까지만 채택 (실무상 도달 불가 경로).
            break;
        }
        for w in q.iter_mut() {
            *w /= gross;
        }
        weights.push(q);
    }
    let k = weights.len();
    if k == 0 {
        tracing::warn!("[s-score] eigenportfolio 가중치 산출 실패");
        return SScoreState {
            duration_ms: t0.elapsed().as_millis() as u64,
            last_run_ms: now_ms,
            diag,
            ..Default::default()
        };
    }

    // 5. 팩터 수익률 F_k(t) — 회귀창(최근 reg_window) 구간만.
    let start = p.corr_window - p.reg_window;
    let mut factor_returns: Vec<Vec<f64>> = Vec::with_capacity(k);
    for q in &weights {
        let mut f = vec![0.0_f64; p.reg_window];
        for (i, w) in q.iter().enumerate() {
            if *w == 0.0 {
                continue;
            }
            let ri = &returns[i][start..];
            for (acc, r) in f.iter_mut().zip(ri) {
                *acc += w * r;
            }
        }
        factor_returns.push(f);
    }

    // 5.5 팩터 변동성 σ_F (회귀창 기준) — β 의 스케일 기준이자 기여도 정렬의 가중치.
    let factor_vol: Vec<f64> = factor_returns
        .iter()
        .map(|f| stddev_sample(f).unwrap_or(0.0))
        .collect();

    // 6. 설계행렬 1회 분해 → 종목별 solve.
    let Some(design) = FactorDesign::new(&factor_returns) else {
        tracing::warn!(
            "[s-score] 설계행렬 특이/준특이 — 회귀 불가 (K={k}, T={}). 팩터 수를 줄이거나 회귀창을 늘려야 함",
            p.reg_window
        );
        return SScoreState {
            duration_ms: t0.elapsed().as_millis() as u64,
            last_run_ms: now_ms,
            diag,
            ..Default::default()
        };
    };

    let mut items: Vec<SScoreResult> = Vec::with_capacity(n_vars);
    let mut market_betas: Vec<f64> = Vec::with_capacity(n_vars);
    for (i, key) in keys.iter().enumerate() {
        let y = &returns[i][start..];
        let Some(fit) = design.fit(y) else {
            diag.regression_fail += 1;
            continue;
        };
        // 잔차가 사실상 없음 = 팩터 선형결합으로 재현되는 시리즈 → OU 무의미.
        if fit.r_squared > p.max_r_squared {
            diag.r_squared_gate += 1;
            continue;
        }
        // 누적잔차 X(t).
        let mut cum = 0.0_f64;
        let x: Vec<f64> = fit
            .residuals
            .iter()
            .map(|e| {
                cum += e;
                cum
            })
            .collect();
        let Some(ou) = fit_ou(&x) else {
            diag.ou_fail += 1;
            continue;
        };
        if !(ou.half_life >= p.min_half_life && ou.half_life <= p.max_half_life) {
            diag.half_life_gate += 1;
            continue;
        }
        let s = (x[x.len() - 1] - ou.m) / ou.sigma_eq;
        if !s.is_finite() {
            diag.ou_fail += 1;
            continue;
        }
        let Some(resid_vol) = stats::stddev_pop(&fit.residuals) else {
            diag.regression_fail += 1;
            continue;
        };

        // 기여도(|β·σ_F|) 상위 3 팩터 (coeffs[0] = 절편이라 제외). 정렬 근거는 FactorBeta 주석.
        let mut betas: Vec<FactorBeta> = fit.coeffs[1..]
            .iter()
            .enumerate()
            .map(|(f, b)| FactorBeta {
                factor_idx: f,
                beta: *b,
                contrib: *b * factor_vol[f],
            })
            .collect();
        betas.sort_by(|a, b| {
            b.contrib
                .abs()
                .partial_cmp(&a.contrib.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        betas.truncate(3);
        let top_factors = betas;
        market_betas.push(fit.coeffs[1]);

        items.push(SScoreResult {
            key: key.clone(),
            code: key.split_once(':').map(|(_, c)| c.to_string()).unwrap_or_else(|| key.clone()),
            name: String::new(),
            asset_class: String::new(),
            s_score: s,
            half_life: ou.half_life,
            kappa: ou.kappa,
            r_squared: fit.r_squared,
            resid_vol,
            top_factors,
            sample_size: p.reg_window,
            updated_ms: now_ms,
        });
    }

    market_betas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    diag.market_beta_median = market_betas
        .get(market_betas.len() / 2)
        .copied()
        .unwrap_or(f64::NAN);
    diag.factor1_vol = factor_vol.first().copied().unwrap_or(f64::NAN);

    // |s| 내림차순 — 응답 기본 정렬. 동률은 key 로 결정론적 tie-break.
    items.sort_by(|a, b| {
        b.s_score
            .abs()
            .partial_cmp(&a.s_score.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });

    let factors = SScoreFactorInfo {
        n_factors: k,
        explained_variance_ratio: pca.explained_variance_ratio[..k].to_vec(),
        factor_vol,
        corr_window: p.corr_window,
        reg_window: p.reg_window,
        universe_size: n_vars,
    };
    let duration_ms = t0.elapsed().as_millis() as u64;
    tracing::info!(
        "[s-score] {}/{} 종목 산출 (PCA {}ms, 총 {:.1}초, 설계행렬 조건비 {:.1e}) — 팩터 {} · 설명력 top1 {:.1}% / top{} 누적 {:.1}%",
        items.len(),
        n_vars,
        pca_ms,
        duration_ms as f64 / 1000.0,
        design.diag_ratio(),
        k,
        factors.explained_variance_ratio.first().copied().unwrap_or(0.0) * 100.0,
        k,
        factors.explained_variance_ratio.iter().sum::<f64>() * 100.0,
    );

    SScoreState {
        items,
        factors,
        last_run_ms: now_ms,
        duration_ms,
        diag,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// 재현 가능한 의사난수 (외부 crate 없이). LCG + Box-Muller.
    struct Rng(u64);
    impl Rng {
        fn next_u64(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0
        }
        fn unit(&mut self) -> f64 {
            // (0, 1) 개구간
            ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
        }
        fn normal(&mut self) -> f64 {
            let u1 = self.unit();
            let u2 = self.unit();
            (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
        }
    }

    #[test]
    fn ou_recovers_known_ar1() {
        // X(t) = a + b·X(t-1) + ζ,  b=0.8, a=0.02 → m = 0.1, σ_ζ=0.01
        //   κ_daily = -ln(0.8) = 0.2231 → half-life = 3.106일, κ_annual = 56.2
        //   σ_eq = 0.01/sqrt(1-0.64) = 0.016667
        let (a, b, sd) = (0.02_f64, 0.8_f64, 0.01_f64);
        let mut rng = Rng(42);
        let mut x = vec![a / (1.0 - b)];
        for _ in 0..4000 {
            let last = x[x.len() - 1];
            x.push(a + b * last + sd * rng.normal());
        }
        let ou = fit_ou(&x).unwrap();
        assert!((ou.b - b).abs() < 0.02, "b={}", ou.b);
        assert!((ou.m - a / (1.0 - b)).abs() < 0.005, "m={}", ou.m);
        let hl_expected = std::f64::consts::LN_2 / -b.ln();
        assert!(
            (ou.half_life - hl_expected).abs() / hl_expected < 0.08,
            "hl={} (expected {hl_expected})",
            ou.half_life
        );
        assert!(
            (ou.kappa - (-b.ln()) * TRADING_DAYS_PER_YEAR).abs() < 5.0,
            "kappa={}",
            ou.kappa
        );
        let sigma_eq_expected = sd / (1.0 - b * b).sqrt();
        assert!(
            (ou.sigma_eq - sigma_eq_expected).abs() / sigma_eq_expected < 0.06,
            "sigma_eq={}",
            ou.sigma_eq
        );
    }

    #[test]
    fn ou_rejects_non_reverting() {
        // random walk: b̂ 가 1보다 아주 조금 작게 추정되므로(AR(1) OLS 하향 편의) 적합 자체는
        // 성립할 수 있다. 대신 half-life 가 회귀창(60일)을 훨씬 넘어 게이트에서 걸려야 한다.
        let mut rng = Rng(7);
        let mut rw = vec![0.0];
        for _ in 0..2000 {
            let last = rw[rw.len() - 1];
            rw.push(last + rng.normal());
        }
        assert!(
            fit_ou(&rw).is_none_or(|o| o.half_life > 100.0),
            "random walk 이 짧은 half-life 로 적합됨: {:?}",
            fit_ou(&rw).map(|o| o.half_life)
        );
        // b < 0 (부호 진동) → 평균회귀 아님 → None
        let osc: Vec<f64> = (0..200).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        assert!(fit_ou(&osc).is_none());
        // 완전 상수 → 분산 0 → None
        assert!(fit_ou(&[0.3_f64; 100]).is_none());
    }

    #[test]
    fn multi_ols_recovers_coeffs_on_orthogonal_design() {
        // 직교 설계행렬 (서로 다른 주기 sin/cos) → 계수 정확 복원, R²=1.
        let t = 80;
        let f1: Vec<f64> = (0..t).map(|i| (i as f64 * 0.3).sin()).collect();
        let f2: Vec<f64> = (0..t).map(|i| (i as f64 * 0.7).cos()).collect();
        let f3: Vec<f64> = (0..t).map(|i| (i as f64 * 1.1).sin()).collect();
        let (b0, b1, b2, b3) = (0.5_f64, 2.0_f64, -1.5_f64, 0.25_f64);
        let y: Vec<f64> = (0..t)
            .map(|i| b0 + b1 * f1[i] + b2 * f2[i] + b3 * f3[i])
            .collect();
        let d = FactorDesign::new(&[f1, f2, f3]).unwrap();
        assert_eq!(d.n_factors(), 3);
        let fit = d.fit(&y).unwrap();
        assert!((fit.coeffs[0] - b0).abs() < 1e-9, "{:?}", fit.coeffs);
        assert!((fit.coeffs[1] - b1).abs() < 1e-9);
        assert!((fit.coeffs[2] - b2).abs() < 1e-9);
        assert!((fit.coeffs[3] - b3).abs() < 1e-9);
        assert!((fit.r_squared - 1.0).abs() < 1e-9);
        // 절편이 있으므로 잔차 합 = 0 (누적잔차의 마지막 값이 0이 되는 근거).
        assert!(fit.residuals.iter().sum::<f64>().abs() < 1e-9);
    }

    #[test]
    fn multi_ols_rejects_collinear_design() {
        let t = 40;
        let f1: Vec<f64> = (0..t).map(|i| (i as f64 * 0.3).sin()).collect();
        let f2: Vec<f64> = f1.iter().map(|v| 2.0 * v).collect(); // 완전 공선
        assert!(FactorDesign::new(&[f1.clone(), f2]).is_none());
        // 상수열(= 절편과 공선)도 거부
        assert!(FactorDesign::new(&[f1, vec![1.0; t]]).is_none());
        // T ≤ K+3 (자유도 부족)
        let short: Vec<Vec<f64>> = (0..3).map(|k| (0..6).map(|i| ((i + k) as f64).sin()).collect()).collect();
        assert!(FactorDesign::new(&short).is_none());
    }

    /// 평형 m 주위 OU 누적잔차 경로 생성. 마지막 값은 0 (절편 포함 회귀의 필연 —
    /// 파일 헤더 "X(last) ≈ 0" 참조).
    fn ou_path_ending_at_zero(m_true: f64, seed: u64) -> Vec<f64> {
        let (b, sd) = (0.7_f64, 0.01_f64);
        let a = m_true * (1.0 - b);
        let mut rng = Rng(seed);
        let mut x = vec![m_true];
        for _ in 0..300 {
            let last = x[x.len() - 1];
            x.push(a + b * last + sd * rng.normal());
        }
        *x.last_mut().unwrap() = 0.0;
        x
    }

    #[test]
    fn s_score_sign_follows_equilibrium() {
        // 평형 m > 0 인데 지금(창 끝)은 0 → 평형보다 싸다 → s < 0 (매수 후보).
        let x = ou_path_ending_at_zero(0.05, 11);
        let ou = fit_ou(&x).unwrap();
        assert!((ou.m - 0.05).abs() < 0.01, "m={}", ou.m);
        let s = (x[x.len() - 1] - ou.m) / ou.sigma_eq;
        assert!(s < -2.0, "s={s} (m={}, σ_eq={})", ou.m, ou.sigma_eq);

        // 평형 m < 0 이면 부호 반전 → s > 0 (매도 후보).
        let x2 = ou_path_ending_at_zero(-0.05, 11);
        let ou2 = fit_ou(&x2).unwrap();
        assert!((ou2.m + 0.05).abs() < 0.01, "m={}", ou2.m);
        let s2 = (x2[x2.len() - 1] - ou2.m) / ou2.sigma_eq;
        assert!(s2 > 2.0, "s2={s2}");
    }

    #[test]
    fn residual_cumsum_ends_at_zero_with_intercept() {
        // 파이프라인 전제 검증: 절편 포함 회귀 → 잔차 합 0 → 누적잔차 마지막 값 0.
        let t = 60;
        let mut rng = Rng(3);
        let f1: Vec<f64> = (0..t).map(|_| rng.normal() * 0.01).collect();
        let f2: Vec<f64> = (0..t).map(|_| rng.normal() * 0.01).collect();
        let y: Vec<f64> = (0..t).map(|i| 0.9 * f1[i] - 0.3 * f2[i] + rng.normal() * 0.005).collect();
        let fit = FactorDesign::new(&[f1, f2]).unwrap().fit(&y).unwrap();
        let mut cum = 0.0;
        let x: Vec<f64> = fit.residuals.iter().map(|e| { cum += e; cum }).collect();
        assert!(x[x.len() - 1].abs() < 1e-12, "X(last)={}", x[x.len() - 1]);
        assert!(fit.r_squared > 0.0 && fit.r_squared < 1.0);
    }

    #[test]
    fn params_are_self_consistent() {
        let p = params();
        assert!(p.reg_window > p.n_factors + 4, "회귀 자유도 확보");
        assert!(p.corr_window >= p.reg_window);
        assert!(p.min_half_life < p.max_half_life);
    }
}
