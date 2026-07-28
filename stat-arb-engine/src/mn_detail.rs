//! M:N 페어 상세 — 합성 로그가격 스프레드 시계열 + 통계 + 히스토그램 + Kalman 안정성.
//!
//! `/mn-pairs/detail?group=&component=` 응답 빌더.
//!
//! ## 1:1 상세(`detail.rs`)와의 차이
//!
//! | | 1:1 | M:N |
//! |---|---|---|
//! | 공간 | raw 가격 레벨(원) | **합성 로그가격** `X=Σwᵢ·ln Pᵢ` (발굴 `discovery.rs` 와 동일) |
//! | timeframe | 인트라데이(30초 stitch) + 일봉 | **일봉 전용** |
//! | Kalman δ | 절대(원 단위 경험값) | **스케일 상대**(표준화 공간) — `KalmanDelta::Relative` |
//!
//! **일봉 전용인 이유**: 1:1 상세는 leg 당 30초봉 60일치 + 당일 t8412 stitch(TPS 1, 순차)라
//! leg 수에 레이턴시가 선형 증가한다. M:N 은 leg 이 3~10개라 최대 10회 순차 = 실용 불가.
//! M:N 의 판단 지평(half-life 수일~수십일 스윙)도 일봉과 정합한다. 인트라데이는 향후 과제.

use std::collections::HashMap;

use serde::Serialize;

use crate::data::bars::Bar;
use crate::detail::{build_headline, build_kalman_stat_with, HistBin, KalmanDelta, KalmanStat, SpreadPoint};
use crate::discovery::{MLeg, MPairResult};
use crate::stats;

/// Kalman 상대 δ (표준화 공간). `KALMAN_DELTA`(1:1 절대 δ) 와 **다른 축의 상수**다.
///
/// 튜닝 근거 — 표준화 공간에서 β_t 한 스텝 이동폭 ≈ √δ (β' 자체는 O(1)) 이므로
/// δ=1e-4 는 "일봉 하루 β 1% 이동" 규모다. 실측(2026-07-27, 108 페어 중 표본):
///   · 1e-6 → β_t 가 정적 OLS 에 사실상 고정 (드리프트 0.0x%, 관계 변화 감지 불가)
///   · 1e-4 → 스텝당 |Δβ|/β 중앙값 0.1~1%, std(β)/β 2~20% — 1:1 경로(raw δ=1e-4)의
///            실측 분포(0.07~1.6% / 1.9~25%)와 같은 대역
///   · 1e-2 → β_t 가 관측 노이즈를 그대로 좇아 요동 (스텝당 수십 %)
/// → 1:1 과 "같은 체감 적응속도"를 주는 1e-4 채택. 스케일 불변이라 leg 수·가격대와 무관.
pub const MN_KALMAN_DELTA_REL: f64 = 1e-4;

/// 상세 산출 최소 표본 (일봉). `build_headline`/`kalman_hedge` 의 하한과 동일.
const MIN_BARS: usize = 30;

#[derive(Debug, Clone, Serialize)]
pub struct MnPairDetail {
    // --- 식별 ---
    pub group_id: String,
    pub group_name: String,
    /// 그룹 내 성분 순번 (1-based, deflation).
    pub component_idx: usize,
    /// 양변 분할에 쓰인 PCA factor (1-based). 0 = ETF 자연분할.
    pub split_factor: usize,
    /// 항상 "1d" — M:N 상세는 일봉 전용.
    pub timeframe: String,

    // --- 바스켓 구성 (가중치 그대로) ---
    pub x_legs: Vec<MLeg>,
    pub y_legs: Vec<MLeg>,

    // --- 통계 (합성 로그가격 OLS: Y = α + β·X + ε) ---
    pub alpha: f64,
    pub hedge_ratio: f64,
    pub r_squared: f64,
    pub adf_tstat: f64,
    /// 반감기 (거래일).
    pub half_life: f64,
    /// 현재 z (마지막 잔차 표준화).
    pub z_score: f64,
    /// 합성 시리즈 로그수익률(=ΔX, ΔY) Pearson corr — 상세 재계산값.
    pub corr: f64,
    /// 발굴 시점 CCA canonical correlation (`MPairResult` 그대로 전달).
    pub cca_correlation: f64,
    /// 실제 회귀에 쓰인 봉 수 (= 공통 거래일 − `skipped_bars`).
    pub sample_size: usize,
    /// 공통 거래일 중 **가격 결측(close ≤ 0)으로 제외**된 봉 수.
    ///
    /// 2026-07-28 오염 수정 이후로는 **항상 0 이어야 한다** — 로더(`data::bars`)가
    /// `adj_close` 결측 봉을 아예 버려서 캐시에 비양수 종가가 존재하지 않기 때문이다.
    /// 0 이 아니면 로더 회귀(캐시 불변식 위반)를 의심할 것. 필드는 그 감시 창구로 남긴다.
    pub skipped_bars: usize,

    // --- 라이브 z 계약 (1:1 `PairResult` 와 동일 이름·의미) ---
    /// z_live = (Y_live − α − β·X_live − resid_mean) / resid_std,
    /// X_live = Σwᵢ·ln(Pᵢ), Y_live = Σvⱼ·ln(Pⱼ) (실시간 가격).
    pub resid_mean: f64,
    pub resid_std: f64,

    // --- 시계열 ---
    /// 일봉 잔차 시계열. `left`/`right` 는 **합성 X/Y 값(로그가격)** — 원 단위 가격이 아니다.
    pub spread_series: Vec<SpreadPoint>,
    pub histogram: Vec<HistBin>,
    /// 잔차 정규화 기준. z = (spread − spread_center) / spread_scale.
    /// (M:N 은 일봉 1벌뿐이라 `resid_mean`/`resid_std` 와 같은 값.)
    pub spread_center: f64,
    pub spread_scale: f64,

    /// Kalman 시변 β 요약 (관계 안정성). 표본<30·필터 실패 시 None.
    pub kalman: Option<KalmanStat>,

    /// PR-D Johansen 공적분 검정 — leg 로그가격 **레벨** 시스템 전체에 대한 대칭 검정.
    /// 벡터 인덱스 순서는 `x_legs` → `y_legs` 연결 순이다 (`coint_vector` 해석의 기준).
    /// 표본 부족·수치 실패 시 None. **발굴 게이팅과 무관한 부가 지표**.
    pub johansen: Option<crate::johansen::JohansenResult>,
}

// ---------------------------------------------------------------------------
// N-way align + 합성
// ---------------------------------------------------------------------------

/// 여러 일봉 시리즈(ts ASC 가정)의 **공통 ts 교집합**. 다중 포인터 병합 — O(Σ len).
///
/// 반환 `(공통 ts, 시리즈별 그 ts 의 close)`. `closes[i]` 는 `series[i]` 순서·길이 = ts 길이.
/// 시리즈가 없거나 하나라도 비면 빈 결과. `detail::intersect_by_ts` 의 N-way 일반화.
fn intersect_ts_nway(series: &[&[Bar]]) -> (Vec<i64>, Vec<Vec<f64>>) {
    let k = series.len();
    if k == 0 || series.iter().any(|s| s.is_empty()) {
        return (Vec::new(), Vec::new());
    }
    // 가장 짧은 시리즈가 교집합 상한.
    let cap = series.iter().map(|s| s.len()).min().unwrap_or(0);
    let mut idx = vec![0usize; k];
    let mut ts_out: Vec<i64> = Vec::with_capacity(cap);
    let mut closes: Vec<Vec<f64>> = (0..k).map(|_| Vec::with_capacity(cap)).collect();

    'outer: loop {
        // 현재 head 중 최대 ts — 그보다 이른 head 는 전부 전진(구멍 skip).
        let mut max_ts = i64::MIN;
        for i in 0..k {
            let Some(b) = series[i].get(idx[i]) else { break 'outer };
            if b.ts > max_ts {
                max_ts = b.ts;
            }
        }
        let mut all_match = true;
        for i in 0..k {
            while series[i].get(idx[i]).is_some_and(|b| b.ts < max_ts) {
                idx[i] += 1;
            }
            match series[i].get(idx[i]) {
                Some(b) if b.ts == max_ts => {}
                Some(_) => all_match = false, // 이 시리즈엔 max_ts 가 없다 (구멍) → 다음 루프에서 재정렬
                None => break 'outer,
            }
        }
        if all_match {
            ts_out.push(max_ts);
            for i in 0..k {
                closes[i].push(series[i][idx[i]].close);
                idx[i] += 1;
            }
        }
    }
    (ts_out, closes)
}

/// 합성 로그가격 시계열 빌더 — 공통 ts 위에서 `X(t)=Σwᵢ·ln(closeᵢ(t))`, `Y(t)=Σvⱼ·ln(closeⱼ(t))`.
///
/// `closes` 는 `[x_legs.., y_legs..]` 순서(= `intersect_ts_nway` 입력 순서)로 들어온다.
/// close ≤ 0(ln 정의 불가)인 시점은 **양변 동시에** 버려 x·y 시간축이 어긋나지 않게 한다.
/// 반환값은 `build_headline`/`compute_stability` 가 그대로 받을 수 있는 `Vec<Bar>` 2벌.
fn build_composites(
    ts: &[i64],
    closes: &[Vec<f64>],
    x_weights: &[f64],
    y_weights: &[f64],
) -> (Vec<Bar>, Vec<Bar>) {
    let nx = x_weights.len();
    let n = ts.len();
    let mut x_bars: Vec<Bar> = Vec::with_capacity(n);
    let mut y_bars: Vec<Bar> = Vec::with_capacity(n);
    for t in 0..n {
        if closes.iter().any(|c| !(c[t] > 0.0)) {
            continue;
        }
        let mut xv = 0.0;
        for (i, w) in x_weights.iter().enumerate() {
            xv += w * closes[i][t].ln();
        }
        let mut yv = 0.0;
        for (j, w) in y_weights.iter().enumerate() {
            yv += w * closes[nx + j][t].ln();
        }
        if !xv.is_finite() || !yv.is_finite() {
            continue;
        }
        x_bars.push(synth_bar(ts[t], xv));
        y_bars.push(synth_bar(ts[t], yv));
    }
    (x_bars, y_bars)
}

/// 합성값 1점을 Bar 로 포장 — 소비자(`build_headline`·`compute_stability`)는 ts·close 만 본다.
fn synth_bar(ts: i64, v: f64) -> Bar {
    Bar { ts, open: v, high: v, low: v, close: v, volume: 0 }
}

/// leg 별 **로그가격 레벨** 행렬 — Johansen 입력. `closes` 는 `intersect_ts_nway` 산출이므로
/// leg 순서가 `x_legs` → `y_legs` 연결 순 그대로다 (`coint_vector` 인덱스 해석의 기준).
///
/// `build_composites` 와 달리 결측(close ≤ 0) 시점을 **개별로 빼지 않고** 전 leg 이 양수인
/// **최장 연속 구간**만 남긴다 (`johansen::longest_positive_run`). Johansen 은 `ΔY_t` 를 쓰므로
/// 중간을 뽑아내면 차분이 구멍을 건너뛰어 가짜 점프가 생기기 때문 — 목록 배지와 같은 규칙.
fn leg_log_levels(closes: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let Some((start, end)) = crate::johansen::longest_positive_run(closes) else {
        return Vec::new();
    };
    closes
        .iter()
        .map(|c| c[start..end].iter().map(|p| p.ln()).collect())
        .collect()
}

// ---------------------------------------------------------------------------
// 메인 빌더
// ---------------------------------------------------------------------------

/// `daily` = leg key → 일봉 Bar(ASC). 캐시에서 복사해 넘긴다.
/// `delta_rel` = Kalman 상대 δ (기본 `MN_KALMAN_DELTA_REL`).
pub fn build_mn_pair_detail(
    pair: &MPairResult,
    daily: &HashMap<String, Vec<Bar>>,
    delta_rel: f64,
) -> Result<MnPairDetail, String> {
    // leg 순서 = x_legs 그다음 y_legs. 이 순서가 closes 인덱스 공간이다.
    let mut bars: Vec<&[Bar]> = Vec::with_capacity(pair.x_legs.len() + pair.y_legs.len());
    for leg in pair.x_legs.iter().chain(pair.y_legs.iter()) {
        match daily.get(&leg.key) {
            Some(b) if b.len() >= MIN_BARS => bars.push(b.as_slice()),
            Some(_) => return Err(format!("leg 일봉 표본 부족: {} ({})", leg.name, leg.key)),
            None => return Err(format!("leg 일봉 캐시 없음: {} ({})", leg.name, leg.key)),
        }
    }

    let (ts, closes) = intersect_ts_nway(&bars);
    if ts.len() < MIN_BARS {
        return Err(format!("leg {}개 공통 거래일 {}개 (<{MIN_BARS})", bars.len(), ts.len()));
    }
    let x_w: Vec<f64> = pair.x_legs.iter().map(|l| l.weight).collect();
    let y_w: Vec<f64> = pair.y_legs.iter().map(|l| l.weight).collect();
    let (x_bars, y_bars) = build_composites(&ts, &closes, &x_w, &y_w);

    // 잔차 시계열·히스토그램·정규화 기준 — 1:1 과 동일 산식(`build_headline`).
    let (spread_series, histogram, spread_center, spread_scale) =
        build_headline(&x_bars, &y_bars).ok_or_else(|| "합성 스프레드 OLS 실패".to_string())?;

    // 통계 — 발굴(`evaluate_mn_component`)과 같은 합성 로그가격 레벨 OLS.
    // 합성값은 이미 로그 공간이라 "수익률"은 ln 비율이 아니라 **차분**이다.
    let xv: Vec<f64> = x_bars.iter().map(|b| b.close).collect();
    let yv: Vec<f64> = y_bars.iter().map(|b| b.close).collect();
    let ols = stats::ols(&xv, &yv).ok_or_else(|| "합성 스프레드 OLS 실패".to_string())?;
    let dx: Vec<f64> = xv.windows(2).map(|w| w[1] - w[0]).collect();
    let dy: Vec<f64> = yv.windows(2).map(|w| w[1] - w[0]).collect();
    let corr = stats::pearson(&dx, &dy).unwrap_or(0.0);
    let adf_tstat = stats::adf_tstat(&ols.residuals).unwrap_or(0.0);
    let half_life = stats::half_life(&ols.residuals).unwrap_or(0.0);
    let (resid_mean, resid_std) = stats::resid_stats(&ols.residuals)
        .ok_or_else(|| "잔차 σ≈0 — z 정규화 불가".to_string())?;
    let z_score = (ols.residuals[ols.residuals.len() - 1] - resid_mean) / resid_std;

    // 관계 안정성 — 합성 로그가격은 스케일이 1:1(원 단위)과 전혀 달라 상대 δ 사용.
    let kalman = build_kalman_stat_with(&x_bars, &y_bars, KalmanDelta::Relative(delta_rel));

    // PR-D Johansen — 합성 스프레드가 아니라 **leg 원계열 시스템**을 대칭 검정한다.
    // (목록 행의 값은 발굴 시 정렬 정책으로 계산되므로 표본 구간이 달라 미세하게 다를 수 있다.
    //  `skipped_bars` 와 같은 사유 — 상세 쪽이 ts 교집합 기준 실데이터다.)
    let johansen = crate::johansen::johansen(
        &leg_log_levels(&closes),
        crate::discovery::johansen_lags(),
    );

    Ok(MnPairDetail {
        group_id: pair.group_id.clone(),
        group_name: pair.group_name.clone(),
        component_idx: pair.component_idx,
        split_factor: pair.split_factor,
        timeframe: pair.timeframe.clone(),
        x_legs: pair.x_legs.clone(),
        y_legs: pair.y_legs.clone(),
        alpha: ols.alpha,
        hedge_ratio: ols.beta,
        r_squared: ols.r_squared,
        adf_tstat,
        half_life,
        z_score,
        corr,
        cca_correlation: pair.cca_correlation,
        sample_size: xv.len(),
        skipped_bars: ts.len() - xv.len(),
        resid_mean,
        resid_std,
        spread_series,
        histogram,
        spread_center,
        spread_scale,
        kalman,
        johansen,
    })
}

// ---------------------------------------------------------------------------
// Tests — N-way align / 합성 (통계 임계는 불변이라 대상 아님)
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn bars(pairs: &[(i64, f64)]) -> Vec<Bar> {
        pairs.iter().map(|&(ts, c)| synth_bar(ts, c)).collect()
    }

    #[test]
    fn nway_intersect_takes_common_ts_only() {
        // 길이·구멍이 제각각인 3개 시리즈. 공통은 3, 5 뿐.
        let a = bars(&[(1, 10.0), (2, 11.0), (3, 12.0), (5, 14.0), (6, 15.0)]);
        let b = bars(&[(2, 20.0), (3, 21.0), (4, 22.0), (5, 23.0)]);
        let c = bars(&[(3, 30.0), (5, 31.0), (7, 32.0)]);
        let (ts, closes) = intersect_ts_nway(&[a.as_slice(), b.as_slice(), c.as_slice()]);
        assert_eq!(ts, vec![3, 5]);
        assert_eq!(closes[0], vec![12.0, 14.0]);
        assert_eq!(closes[1], vec![21.0, 23.0]);
        assert_eq!(closes[2], vec![30.0, 31.0]);
    }

    #[test]
    fn nway_intersect_edges() {
        let a = bars(&[(1, 1.0), (2, 2.0)]);
        // 빈 시리즈가 하나라도 있으면 결과 없음.
        assert_eq!(intersect_ts_nway(&[a.as_slice(), &[]]).0.len(), 0);
        // 교집합 없음.
        let b = bars(&[(3, 3.0), (4, 4.0)]);
        assert_eq!(intersect_ts_nway(&[a.as_slice(), b.as_slice()]).0.len(), 0);
        // 단일 시리즈 = 자기 자신.
        assert_eq!(intersect_ts_nway(&[a.as_slice()]).0, vec![1, 2]);
        // 시리즈 0개.
        assert_eq!(intersect_ts_nway(&[]).0.len(), 0);
    }

    #[test]
    fn nway_intersect_handles_10_legs() {
        // leg 10개 (M:N 상한). 짝수 ts 만 모든 시리즈에 존재하도록 구성.
        let mut series: Vec<Vec<Bar>> = Vec::new();
        for k in 0..10i64 {
            let v: Vec<(i64, f64)> = (0..40i64)
                .filter(|t| t % 2 == 0 || t % (k + 3) == 0)
                .map(|t| (t, 100.0 + t as f64 + k as f64))
                .collect();
            series.push(bars(&v));
        }
        let refs: Vec<&[Bar]> = series.iter().map(|s| s.as_slice()).collect();
        let (ts, closes) = intersect_ts_nway(&refs);
        assert!(ts.iter().all(|t| t % 2 == 0));
        assert_eq!(ts.len(), 20);
        assert_eq!(closes.len(), 10);
        assert_eq!(closes[3][0], 103.0);
    }

    #[test]
    fn composite_applies_weights_in_log_space() {
        // X = 1.0·ln(100) + 0.5·ln(200),  Y = 2.0·ln(50)
        let ts = vec![1i64, 2];
        let closes = vec![
            vec![100.0, 100.0],
            vec![200.0, 200.0],
            vec![50.0, 50.0],
        ];
        let (x, y) = build_composites(&ts, &closes, &[1.0, 0.5], &[2.0]);
        assert_eq!(x.len(), 2);
        let want_x = 100f64.ln() + 0.5 * 200f64.ln();
        let want_y = 2.0 * 50f64.ln();
        assert!((x[0].close - want_x).abs() < 1e-12, "{} vs {}", x[0].close, want_x);
        assert!((y[1].close - want_y).abs() < 1e-12);
        assert_eq!(x[1].ts, 2);
        // 음수 가중치도 그대로 (합성값이 음수여도 레벨 회귀는 성립).
        let (x2, _) = build_composites(&ts, &closes, &[-1.0, 0.5], &[2.0]);
        assert!((x2[0].close - (-100f64.ln() + 0.5 * 200f64.ln())).abs() < 1e-12);
    }

    #[test]
    fn composite_drops_nonpositive_rows_on_both_sides() {
        // t=2 에서 한 leg 가 0 → 양변 동시에 그 시점 제거 (시간축 동기 유지).
        let ts = vec![1i64, 2, 3];
        let closes = vec![vec![100.0, 0.0, 120.0], vec![50.0, 60.0, 70.0]];
        let (x, y) = build_composites(&ts, &closes, &[1.0], &[1.0]);
        assert_eq!(x.len(), 2);
        assert_eq!(y.len(), 2);
        assert_eq!(x.iter().map(|b| b.ts).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(y.iter().map(|b| b.ts).collect::<Vec<_>>(), vec![1, 3]);
    }
}
