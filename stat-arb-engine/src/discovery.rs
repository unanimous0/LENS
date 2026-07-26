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

use crate::data::bars::{AssetSeries, Bar, SeriesCache, Timeframe};
use crate::stats;

// 필터 임계값. 일봉 기준. 기본 3년치(2026-06-30, 영업일 ~730 — `warmup_days_daily()`).
// 임계는 1년 가정으로 튜닝됐으나 3년에서도 더 견고하게 작동(측정: ADF median −5.01).
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
// corr 사전필터 임계 — env `STATARB_MIN_CORR`(기본 0.3, 2026-07-01 0.5→0.3).
// corr는 cointegration의 필수조건이 아니라(Pearson −0.48로 부분예측만) 효율성 휴리스틱.
// 4관점 에이전트 측정: elbow(0.35→0.30 ADF median 최대낙차 후 평탄)·ETF본업(0.5는 ETF-주식
// 72% 탈락, 금·CD금리 ETF 소멸)이 0.3에 수렴. score=−adf×(1/hl)×|corr|가 corr를 이미
// 반영해 상위 노출은 완화해도 불변(top200 corr median 0.9) — 완화 이득은 꼬리 페어(본업)에만.
fn min_corr() -> f64 {
    use std::sync::OnceLock;
    static CELL: OnceLock<f64> = OnceLock::new();
    *CELL.get_or_init(|| {
        std::env::var("STATARB_MIN_CORR")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.3)
    })
}
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
// 그룹 시리즈 정렬 시 *보존 목표* 멤버 비율 (`choose_target_len`).
// 길이가 제각각인 그룹을 "가장 짧은 멤버"에 맞추면 표본이 붕괴한다 — 실측(2026-07-26)
// index:KOSPI200 은 캐시에 727봉이 있는데도 길이 200 미만 4개·400 미만 10개 때문에
// min_len 정렬로 T=162 까지 잘렸고, T(162) < N(200) 이라 상관행렬이 rank-deficient
// (PCA 자체가 부실). 같은 그룹을 상위 90% 보존 기준으로 잡으면 T=726 (멤버 192) 로 회복된다.
// 0.9 = "짧은 소수는 버리고 표본 깊이를 산다" — 신규상장 종목이 그룹의 통계를 지배하지
// 못하게 하는 컷. 임계(MIN_SAMPLES 등)와 무관한 *정렬 정책* 상수.
const RETAIN_RATIO: f64 = 0.9;
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
    /// 잔차 평균 μ — z 계산에 쓰인 그 잔차(= alpha/hedge_ratio와 짝) 기준.
    /// 프론트 라이브 z: `z = (right − alpha − hedge_ratio×left − resid_mean) / resid_std`.
    #[serde(default)]
    pub resid_mean: f64,
    /// 잔차 모집단 σ. `z_score`와 동일 척도 (stats::resid_stats 단일 진입점).
    #[serde(default)]
    pub resid_std: f64,
    pub sample_size: usize,
    pub score: f64,
    // --- 분류 태깅 (발굴 후 엔리치 패스에서 채움. 발굴 게이팅과 무관한 부가 메타) ---
    /// 좌변 leg 분류. 주식=`"stock"`, 지수=`"index"`, ETF=카테고리 태그(broad_index 등).
    #[serde(default)]
    pub left_class: String,
    /// 우변 leg 분류. 규칙은 left_class와 동일.
    #[serde(default)]
    pub right_class: String,
    /// 베이시스형 여부 — 양 leg 모두 ETF이고 기초지수가 같고 비어있지 않으면 true.
    /// 같은 지수 복제 페어(KODEX200↔TIGER200)는 자명 공적분이라 통계차익 리스트에서 기본 제외.
    #[serde(default)]
    pub same_underlying: bool,
    // --- 관계 안정성 (Kalman 시변 β). 엔리치 패스에서 detail::compute_stability로 채움 ---
    /// `"stable"`|`"caution"`|`"drift"`. 표본<30 등 계산 실패 시 빈 문자열.
    /// 판정은 상세 패널(KalmanStat)과 동일 함수 — 목록/상세가 다른 값을 낼 수 없음.
    #[serde(default)]
    pub stability: String,
    /// |β_current − β_static| / |β_static| (0.15 = 15%). 계산 실패 시 0.
    #[serde(default)]
    pub beta_drift_pct: f64,
    /// |z_static − z_adaptive|. 계산 실패 시 0.
    #[serde(default)]
    pub z_gap: f64,
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

/// 길이가 제각각인 시리즈 집합에서 (표본 깊이 × 멤버 보존) 균형점을 고른다.
/// 짧은 소수 때문에 전체가 붕괴하지 않도록, 하위 일부를 버리고 나머지의 공통 길이를 쓴다.
///
/// 정책: 길이 내림차순으로 상위 `RETAIN_RATIO` 비율(단 `min_members` 이상)을 보존하는
/// 최대 길이. 그 길이가 `MIN_SAMPLES` 미만이면 보존 수를 하나씩 줄여(= 더 긴 공통 길이)
/// 재시도하고, `min_members` 까지 줄여도 못 채우면 None.
///
/// 반환값은 항상 `>= MIN_SAMPLES` 이고, 그 길이 이상인 멤버가 `min_members` 개 이상 존재한다.
fn choose_target_len(lens: &[usize], min_members: usize) -> Option<usize> {
    let n = lens.len();
    if min_members == 0 || n < min_members {
        return None;
    }
    let mut desc = lens.to_vec();
    desc.sort_unstable_by(|a, b| b.cmp(a));
    // 보존 목표 멤버 수 — 상위 RETAIN_RATIO 비율. min_members 하한, n 상한.
    let target_keep = ((n as f64 * RETAIN_RATIO).ceil() as usize).clamp(min_members, n);
    // desc[k-1] 은 k 가 줄수록 커지므로, 목표에서부터 내려오며 첫 통과 지점이
    // "MIN_SAMPLES 를 만족하는 최대 보존 수".
    (min_members..=target_keep)
        .rev()
        .map(|keep| desc[keep - 1])
        .find(|&len| len >= MIN_SAMPLES)
}

/// 개수 기준 right-align 후 거래일 달력이 실제로 일치하는지 확인 (뒤 `ref_tail.len()` 개 ts 비교).
///
/// 개수 정렬은 "모든 시리즈가 같은 영업일 달력을 공유한다"를 가정한다. 실측(2026-07-26,
/// PG `ohlcv_daily` 3년창): **현 universe 596 시리즈는 전부 가장 긴 시리즈 달력의 정확한
/// suffix** (신규상장으로 짧을 뿐 중간 구멍 없음) — 오정렬 0건. 지수 19종도 동일 달력.
/// 다만 DB 전체(3,755 종목)로 넓히면 82개가 어긋난다(거래정지 등으로 중간이 빈 시리즈 29개,
/// 상폐·정지로 끝이 과거인 시리즈 54개). 지금 안전한 건 universe 필터(is_active 구성종목 ·
/// 최근 30일 거래대금 10억↑ ETF)가 그것들을 걸러내기 때문이지 구조적 보장이 아니다.
/// → N-way ts 교집합(detail.rs `intersect_by_ts` 의 확장)까지 가지 않고, 정렬 결과의 ts
/// 동일성만 O(N·T) 로 검사해 어긋난 멤버를 드롭한다. 달력이 같은 평시엔 완전 무비용 no-op.
fn tail_ts_matches(ts: &[i64], ref_tail: &[i64]) -> bool {
    ts.len() >= ref_tail.len() && ts[ts.len() - ref_tail.len()..] == *ref_tail
}

/// `tail_ts_matches` 의 bar 슬라이스 버전 — ts만 뽑는 중간 Vec 할당 없이 비교.
fn bars_tail_matches(bars: &[Bar], ref_tail: &[i64]) -> bool {
    bars.len() >= ref_tail.len()
        && bars[bars.len() - ref_tail.len()..]
            .iter()
            .zip(ref_tail)
            .all(|(b, t)| b.ts == *t)
}

/// 기준 거래일 달력 tail — 후보 중 가장 긴(동률이면 가장 최근에 끝나는) 시리즈의 마지막 `need` 개 ts.
/// 가장 긴 시리즈가 곧 달력의 상위집합이라 기준으로 삼는다.
fn reference_ts_tail<'a>(
    keys: impl IntoIterator<Item = &'a String>,
    cache: &SeriesCache,
    need: usize,
) -> Option<Vec<i64>> {
    let mut best: Option<(usize, i64, Vec<i64>)> = None;
    for key in keys {
        let Some(entry) = cache.get(key) else { continue };
        let bars = entry.value().bars(Timeframe::Day1);
        if bars.len() < need {
            continue;
        }
        let rank = (bars.len(), bars[bars.len() - 1].ts);
        if best.as_ref().is_some_and(|(l, t, _)| (*l, *t) >= rank) {
            continue;
        }
        let tail = bars[bars.len() - need..].iter().map(|b| b.ts).collect();
        best = Some((rank.0, rank.1, tail));
    }
    best.map(|(_, _, tail)| tail)
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
    if corr.abs() < min_corr() {
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

    // 5. 현재 z-score — 정규화 기준(μ, σ)도 함께 노출.
    //    프론트가 장중 라이브 가격으로 같은 척도의 z를 재계산할 수 있어야 하므로
    //    z와 (μ, σ)를 *같은 잔차*에서 한 번에 뽑는다 (분기 시 척도 어긋남 방지).
    let (resid_mean, resid_std) = stats::resid_stats(&r.residuals)?;
    let z = (r.residuals[r.residuals.len() - 1] - resid_mean) / resid_std;

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
        resid_mean,
        resid_std,
        sample_size: a.len(),
        score,
        // 분류 태깅·관계 안정성은 발굴 후 엔리치 패스(main.rs)에서 채움 — 여기선 기본값.
        left_class: String::new(),
        right_class: String::new(),
        same_underlying: false,
        stability: String::new(),
        beta_drift_pct: 0.0,
        z_gap: 0.0,
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
    /// 보관 factor 전체의 loading (부호 포함, factor 순서 = `factors[i].factor_idx`).
    /// `split_by_factor`가 PC2·PC3까지 후보 분할축으로 쓸 수 있게 노출. `factor1_loading`은
    /// 이 벡터의 [0]과 동일 — 기존 필드 의미 보존을 위해 둘 다 유지.
    #[serde(default)]
    pub factor_loadings: Vec<f64>,
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
    // 1. 멤버 일봉 종가 → 로그수익률 (+ 정렬 검증용 거래일 ts)
    let mut keys: Vec<String> = Vec::new();
    let mut series: Vec<Vec<f64>> = Vec::new();
    let mut ts_list: Vec<Vec<i64>> = Vec::new();
    for key in members {
        let Some(entry) = cache.get(key) else { continue };
        let bars = entry.value().bars(Timeframe::Day1);
        if bars.len() < MIN_SAMPLES {
            continue;
        }
        let closes: Vec<f64> = bars.iter().map(|b| b.close).collect();
        series.push(log_returns(&closes));
        ts_list.push(bars.iter().map(|b| b.ts).collect());
        keys.push(key.clone());
    }
    if keys.len() < 3 {
        // PCA 의미 있으려면 변수 ≥ 3
        return None;
    }

    // 2. 시리즈 길이 통일 — 적응적 target_len 으로 right-align (가장 최근 데이터 보존).
    //    전 멤버 min_len 정렬은 신규상장 몇 개가 그룹 전체 표본을 붕괴시켜 T<N (상관행렬
    //    rank-deficient) 을 만들었다. 이제 *짧은 소수를 드롭*하고 나머지의 공통 길이를 쓴다.
    let lens: Vec<usize> = series.iter().map(|s| s.len()).collect();
    let target_len = choose_target_len(&lens, 3)?;
    // 수익률 target_len 개 = 종가 target_len+1 개 구간 (1차차분).
    let need = target_len + 1;
    let ref_tail = reference_ts_tail(keys.iter(), cache, need)?;

    let mut kept_keys: Vec<String> = Vec::with_capacity(keys.len());
    let mut kept_series: Vec<Vec<f64>> = Vec::with_capacity(series.len());
    let mut calendar_drops = 0_usize;
    for (i, mut s) in series.into_iter().enumerate() {
        if s.len() < target_len {
            continue; // 짧은 멤버는 드롭 (전체를 자르지 않는다)
        }
        if !tail_ts_matches(&ts_list[i], &ref_tail) {
            calendar_drops += 1;
            continue;
        }
        s.drain(0..s.len() - target_len);
        kept_series.push(s);
        kept_keys.push(std::mem::take(&mut keys[i]));
    }
    if calendar_drops > 0 {
        tracing::debug!(
            "[PCA] 거래일 달력 불일치로 {calendar_drops} 멤버 드롭 (남은 {}, T={target_len})",
            kept_keys.len()
        );
    }
    if kept_keys.len() < 3 {
        return None;
    }
    let (keys, series) = (kept_keys, kept_series);

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
            factor_loadings: (0..n_keep).map(|f| pca_r.loadings[f][i]).collect(),
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
    /// 그 외 (sector/index/etf_category): PCA factor 부호로 분할 (factor2 → 3 → 1 순 탐색).
    FactorSign,
}

#[derive(Debug, Clone, Serialize)]
pub struct MLeg {
    pub key: String,
    pub name: String,
    /// L2 정규화 가중치 (CCA u 또는 v entry). 절댓값 0.05 이상만 leg로 인정.
    pub weight: f64,
    /// leg 분류 태그 (stock/index/ETF 카테고리). 발굴 후 엔리치 패스에서 채움.
    #[serde(default)]
    pub class: String,
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
    /// 양변 분할에 쓰인 PCA factor 번호 (1-based). ETF 자연분할(ETF↔보유주식)이면 0.
    /// 발굴 게이팅과 무관한 계보 메타 — 어느 축이 M:N을 만들어냈는지 추적용.
    #[serde(default)]
    pub split_factor: usize,
    /// 같은 leg 집합을 산출한 그룹 수 (`/mn-pairs` 응답에서만 채움. 1 = 고유).
    /// groups.rs `underlying_to_index()`가 "코스피200*" 카테고리 전부에 KOSPI200 구성종목을
    /// 주입해 candidate pool이 사실상 동일해지는 탓에 같은 페어가 여러 그룹에서 나온다.
    #[serde(default)]
    pub dup_group_count: usize,
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

/// candidate pool을 PCA factor loading 부호로 양변 분할.
///
/// PC1은 그룹 공통 팩터(주식 그룹이면 시장 베타)라 loading 부호가 한쪽으로 쏠린다.
/// 실측(2026-07-26): 비-ETF 그룹 69개 중 **67개가 factor1 단일 부호** → 한 변이 항상 비어
/// M:N 후보가 결정론적으로 0이었다(임계 완화로 풀리지 않는 구조적 탈락).
/// PC2 이상은 PC1과 직교라 *정의상* 부호가 섞이고, 그 부호 경계가 곧 그룹 내 스프레드
/// 축이라 시장중립 M:N 페어에 맞는 분할축이다.
///
/// 시도 순서 factor2 → factor3 → factor1 (PC1은 부호가 섞이는 혼합 그룹용 폴백).
/// 반환 `(선택 factor 번호(1-based), 양수 loading side, 음수 loading side)`.
/// 세 factor 모두 한쪽이 비거나 `|x|+|y| < min_total`이면 None.
fn split_by_factor(
    pool: &[CandidateMember],
    min_total: usize,
) -> Option<(usize, Vec<String>, Vec<String>)> {
    // 0-based factor index. PC2 우선, PC1 마지막.
    const TRY_ORDER: [usize; 3] = [1, 2, 0];
    for f in TRY_ORDER {
        let mut pos = Vec::new();
        let mut neg = Vec::new();
        for m in pool {
            // factor 보관 수(PCA_N_FACTORS)보다 적게 산출된 그룹은 해당 축 건너뜀.
            let Some(&loading) = m.factor_loadings.get(f) else { continue };
            if loading > 0.0 {
                pos.push(m.key.clone());
            } else if loading < 0.0 {
                neg.push(m.key.clone());
            }
        }
        if !pos.is_empty() && !neg.is_empty() && pos.len() + neg.len() >= min_total {
            return Some((f + 1, pos, neg));
        }
    }
    None
}

/// 한 변이 표준화 단계에서 통째로 비었을 때의 사유 집계.
/// 캐시 미스(= universe 밖 종목)와 데이터 품질(표본 부족·분산 0)을 구분해야
/// ETF universe 확대 같은 입력 조치의 효과를 측정할 수 있다.
#[derive(Debug, Clone, Copy, Default)]
struct SideDropStats {
    /// 가격 cache에 아예 없는 key (universe 밖 — ETF top-N 컷 등).
    cache_miss: usize,
    /// cache엔 있으나 일봉 표본이 MIN_SAMPLES(또는 target_len) 미만.
    short_sample: usize,
    /// 수익률 분산 0 (거래정지·고정가 등).
    zero_var: usize,
    /// 우측 정렬 후 거래일 ts가 기준 달력과 불일치 (중간 구멍·과거에서 끝난 시리즈).
    calendar_mismatch: usize,
}

impl SideDropStats {
    /// 지배 사유 인덱스 — 0=cache miss, 1=samples, 2=var=0, 3=달력 불일치, 4=혼합/불명.
    fn dominant(&self) -> usize {
        match (
            self.cache_miss > 0,
            self.short_sample > 0,
            self.zero_var > 0,
            self.calendar_mismatch > 0,
        ) {
            (true, false, false, false) => 0,
            (false, true, false, false) => 1,
            (false, false, true, false) => 2,
            (false, false, false, true) => 3,
            _ => 4,
        }
    }
}

/// 빈 변의 탈락 사유 문자열 (진단 집계 키라 `&'static str` 고정 집합).
/// 길이 통일(align) 단계와 표준화(standardize) 단계가 같은 사유 집합을 공유한다 —
/// 두 단계 모두 "이 변에 쓸 시리즈가 하나도 안 남았다"의 원인을 물어보기 때문.
fn empty_side_reason(is_x: bool, d: &SideDropStats) -> &'static str {
    const X: [&str; 5] = [
        "x side empty (cache miss)",
        "x side empty (samples<target_len)",
        "x side empty (var=0)",
        "x side empty (calendar mismatch)",
        "x side empty (mixed)",
    ];
    const Y: [&str; 5] = [
        "y side empty (cache miss)",
        "y side empty (samples<target_len)",
        "y side empty (var=0)",
        "y side empty (calendar mismatch)",
        "y side empty (mixed)",
    ];
    let i = d.dominant();
    if is_x { X[i] } else { Y[i] }
}

/// 한 변의 *로그수익률* 길이 목록 (= 종가 개수 − 1) + 후보에서 빠진 사유 집계.
/// `choose_target_len` 입력용. 캐시 미스와 표본 부족을 구분해 담아, target_len 산출조차
/// 못 한 변의 탈락 사유를 `empty_side_reason` 과 같은 taxonomy 로 보고할 수 있게 한다.
fn side_return_lens(keys: &[String], cache: &SeriesCache) -> (Vec<usize>, SideDropStats) {
    let mut lens = Vec::with_capacity(keys.len());
    let mut drops = SideDropStats::default();
    for key in keys {
        let Some(entry) = cache.get(key) else {
            drops.cache_miss += 1;
            continue;
        };
        let n = entry.value().bars(Timeframe::Day1).len();
        if n < MIN_SAMPLES {
            drops.short_sample += 1;
            continue;
        }
        lens.push(n - 1);
    }
    (lens, drops)
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

/// 멤버 key 목록 → (log returns 표준화 매트릭스, 살아남은 key 목록, 탈락 사유 집계).
/// 길이 통일은 호출자에서 (모든 변수가 같은 T 길이여야 sparse_cca 호출 가능).
/// `ref_tail` 은 기준 거래일 달력의 마지막 `target_len + 1` 개 ts — 우측 정렬한 구간의
/// 거래일이 실제로 일치하는지 검사해 어긋난 멤버를 드롭한다 (`tail_ts_matches` 주석 참조).
fn build_standardized_returns(
    keys: &[String],
    cache: &SeriesCache,
    target_len: usize,
    ref_tail: &[i64],
) -> (Vec<Vec<f64>>, Vec<String>, SideDropStats) {
    let mut out_series = Vec::new();
    let mut out_keys = Vec::new();
    let mut drops = SideDropStats::default();
    // 수익률 target_len 개 = 종가 target_len+1 개. target_len >= MIN_SAMPLES 는 choose_target_len 보장.
    let need = target_len + 1;
    for key in keys {
        let Some(entry) = cache.get(key) else {
            drops.cache_miss += 1;
            continue;
        };
        let bars = entry.value().bars(Timeframe::Day1);
        if bars.len() < need {
            drops.short_sample += 1;
            continue;
        }
        if !bars_tail_matches(bars, ref_tail) {
            drops.calendar_mismatch += 1;
            continue;
        }
        let trimmed: Vec<f64> = log_returns(
            &bars[bars.len() - need..].iter().map(|b| b.close).collect::<Vec<f64>>(),
        );
        let Some(z) = standardize(&trimmed) else {
            drops.zero_var += 1;
            continue;
        };
        out_series.push(z);
        out_keys.push(key.clone());
    }
    (out_series, out_keys, drops)
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

    let (split_factor, x_keys, y_keys) = match strategy {
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
            (0, etfs, stocks)
        }
        MnSplitStrategy::FactorSign => split_by_factor(candidate_pool, MIN_TOTAL)
            .ok_or("split: no factor(2/3/1) gave both signs")?,
    };
    // ETF 그룹의 자연 분할은 m=1 (ETF 1개) vs n≥2 (보유주식)이 정상.
    // factor 부호 분할은 양변 각 2 이상 일반적 (split_by_factor가 이미 보장).
    // 통합 조건: 각 변 ≥ 1 + 합 ≥ MIN_TOTAL.
    if x_keys.is_empty() || y_keys.is_empty() || (x_keys.len() + y_keys.len()) < MIN_TOTAL {
        return Err("split: empty side or |x|+|y|<3");
    }

    // 길이 통일 — 하드코딩 MIN_SAMPLES(151 표본) 대신 적응적 target_len.
    // **x·y 는 반드시 같은 target_len** 을 쓴다: 양변이 다른 구간을 보면 합성 스프레드가
    // 서로 다른 시간축의 회귀가 돼 무의미해진다.
    // 변별로 먼저 구한 뒤 짧은 쪽으로 통일하는 이유 — `EtfNatural` 분할의 X변은 ETF 1개이고
    // 그게 페어의 필수 멤버다. 양변 합집합에 RETAIN_RATIO 컷을 걸면 신규상장 ETF가 하위
    // 10%로 잘려 그룹이 통째로 사라진다(주식 200봉+ETF 신규 = ETF만 드롭). 변 단위면
    // 그 ETF 길이가 그대로 상한이 돼 "짧지만 유효한" 페어가 살아남는다.
    let (x_lens, x_len_drops) = side_return_lens(&x_keys, cache);
    let (y_lens, y_len_drops) = side_return_lens(&y_keys, cache);
    let x_target =
        choose_target_len(&x_lens, 1).ok_or_else(|| empty_side_reason(true, &x_len_drops))?;
    let y_target =
        choose_target_len(&y_lens, 1).ok_or_else(|| empty_side_reason(false, &y_len_drops))?;
    let target_len = x_target.min(y_target);
    // 기준 거래일 달력은 양변 통틀어 1개 (같은 시간축 강제).
    let ref_tail = reference_ts_tail(x_keys.iter().chain(y_keys.iter()), cache, target_len + 1)
        .ok_or("align: 기준 거래일 달력 없음")?;
    let (x_series, x_keys_kept, x_drops) =
        build_standardized_returns(&x_keys, cache, target_len, &ref_tail);
    let (y_series, y_keys_kept, y_drops) =
        build_standardized_returns(&y_keys, cache, target_len, &ref_tail);
    // ETF Natural 분할은 X 측 1개도 정상. factor 분할은 양변 ≥ 2 권장.
    // 빈 변이 생긴 사유(캐시 미스 / 표본 부족 / 분산 0)를 구분해 반환 — universe 확대 같은
    // 입력 조치의 효과가 진단 로그에서 바로 보이게.
    if x_series.is_empty() {
        return Err(empty_side_reason(true, &x_drops));
    }
    if y_series.is_empty() {
        return Err(empty_side_reason(false, &y_drops));
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
            class: String::new(), // 엔리치 패스(main.rs)에서 채움
        })
        .collect();
    let y_legs: Vec<MLeg> = y_sel
        .iter()
        .map(|&j| MLeg {
            key: y_keys_kept[j].clone(),
            name: names.get(&y_keys_kept[j]).cloned().unwrap_or_else(|| y_keys_kept[j].clone()),
            weight: cca.v[j],
            class: String::new(), // 엔리치 패스(main.rs)에서 채움
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
        split_factor,
        dup_group_count: 0, // `/mn-pairs` 응답단 dedup에서 채움 (0 = 미집계)
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

// ---------------------------------------------------------------------------
// Tests — 표본 정렬 정책 (통계 임계는 불변이라 대상 아님)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_len_drops_short_minority() {
        // 실측 재현: KOSPI200 200멤버 중 192개가 726, 나머지 8개가 짧다.
        let mut lens = vec![726_usize; 192];
        lens.extend([681, 651, 584, 537, 481, 358, 286, 162]);
        // min_len 정렬이면 162 (T<N 붕괴), 90% 보존이면 726.
        assert_eq!(choose_target_len(&lens, 3), Some(726));
    }

    #[test]
    fn target_len_keeps_ratio_when_all_equal() {
        let lens = vec![400_usize; 10];
        assert_eq!(choose_target_len(&lens, 3), Some(400));
    }

    #[test]
    fn target_len_backs_off_until_min_samples() {
        // 상위 90%(=9번째) 길이는 100으로 MIN_SAMPLES 미달 → 보존 수를 줄여 200 채택.
        let mut lens = vec![200_usize; 5];
        lens.extend([100; 5]);
        assert_eq!(choose_target_len(&lens, 3), Some(200));
    }

    #[test]
    fn target_len_none_when_nothing_reaches_min_samples() {
        let lens = vec![100_usize, 90, 80, 70];
        assert_eq!(choose_target_len(&lens, 3), None);
        // 멤버 수 자체가 min_members 미만이어도 None.
        assert_eq!(choose_target_len(&[900, 900], 3), None);
    }

    #[test]
    fn target_len_single_mandatory_member() {
        // EtfNatural 의 X변(ETF 1개) — min_members=1 이면 그 길이가 그대로 상한.
        assert_eq!(choose_target_len(&[199], 1), Some(199));
        assert_eq!(choose_target_len(&[149], 1), None);
    }

    #[test]
    fn tail_ts_matches_detects_hole() {
        let cal: Vec<i64> = (0..10).collect();
        assert!(tail_ts_matches(&cal, &cal[5..]));
        // 신규상장(달력 suffix) 은 정상.
        assert!(tail_ts_matches(&cal[7..], &cal[7..]));
        // 중간에 구멍(거래정지) 이 있으면 개수 정렬이 날짜를 어긋나게 한다 → 불일치 검출.
        let gappy: Vec<i64> = cal.iter().copied().filter(|t| *t != 7).collect();
        assert!(!tail_ts_matches(&gappy, &cal[5..]));
        // 과거에서 끝난 시리즈(상폐·정지) 도 불일치.
        assert!(!tail_ts_matches(&cal[..8], &cal[5..]));
    }
}
