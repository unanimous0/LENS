//! FV_futures 호가 앵커 + 호가 제안 계산 (lp-system-design.md §13.3-A, PR-B).
//!
//! 데이터 경로: 지수선물 3종(FC9) + ETF 틱 12종 → FV_futures → 요구 엣지(재고 skew 포함)
//! → 제안 bid/ask/size. **자동 제출 없음** — 출력은 "제안" 데이터.
//!
//! FV 산식 (일일 리셋 상품이라 prev_NAV 기준 당일 산식이 정확):
//!   S_impl   = F / (1 + r × d/365)            (지수선물 → 캐리 역산 함축 현물지수)
//!   r_impl   = (S_impl − prev_index_close) / prev_index_close
//!   지수형   FV = prev_nav × (1 + L × r_impl)   (레버리지·인버스는 L 부호·배수로 자연 처리)
//!   섹터형   FV = prev_nav × (1 + β × r_impl)   (지수 베타 + 잔차 프리미엄)
//!
//! 배당은 v1 무시 (S_impl 캐리에 금리만) — 4월 배당 시즌엔 S_impl이 소폭 과대평가되어
//! r_impl·FV가 미세 bias. 인포맥스 배당 인입은 향후.
#![allow(dead_code)]

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::Deserialize;

use crate::feed::ls_rest::{parse_index_fut_ym, second_thursday};
use crate::model::lp::{QuoteComponents, QuoteRow};

/// 지수선물 stale 임계 (ms). 이보다 오래되면 no_quote — feed 끊김 신호.
/// 장중 FC9는 초당 여러 틱. mock은 ~5초 간격이라 15초 여유.
pub const INDEX_FUT_STALE_MS: u64 = 15_000;

/// r_implied 극단 컷 — 이 이상이면 서킷/데이터오류 의심 (soft flag: FV는 계산·표시하되 usable=false).
/// KRX 서킷브레이커: 1단계 −8% / 2단계 −15% / 3단계 −20%. 목적은 *데이터 오류*(스케일
/// 불일치 → 30%+, 지수 결측 → 거대값) 차단이지 정상적 대변동일(−8% CB-1) 봉쇄가 아님.
/// CB-2(15%)를 컷으로 두면 스케일 오류는 잡되 합법적 대변동일엔 FV를 계속 보인다.
/// (2026-07-07 실측: KOSPI200 당일 −8.2% 하락일 — 5% 컷은 이런 정상일을 오차단.)
const R_IMPLIED_EXTREME: f64 = 0.15; // ±15%

/// 섹터형 잔차 charge 계수 — residual_sigma_%(일) × K. K=6 → 잔차 0.8%/일이면 ~4.8bp.
/// 헤지 불가한 종목 고유위험에 대한 v1 휴리스틱 프리미엄 (튜닝 상수).
const RESIDUAL_CHARGE_K: f64 = 6.0;

// =============================================================================
// matrix-config 입력 모델
// =============================================================================

/// matrix-config `quote_universe[]` 항목 — FV_futures 정적 입력 (§13.3-A).
#[derive(Debug, Clone, Deserialize)]
pub struct QuoteUniverseEtf {
    pub code: String,
    #[serde(default)]
    pub name: Option<String>,
    /// "k200" | "kq150" — r_implied 소스 지수 가족.
    #[serde(default)]
    pub index_family: Option<String>,
    /// 부호 있는 일일 배수 (+1/+2/-1/-2). 섹터형은 None.
    #[serde(default)]
    pub leverage: Option<f64>,
    /// "index" | "beta"
    pub fv_mode: String,
    /// 섹터형 베타 (KOSPI200 60일 OLS). 지수형도 참고용으로 채워질 수 있음.
    #[serde(default)]
    pub beta: Option<f64>,
    /// 잔차 σ (일, 소수). 섹터형 residual charge + skew σ_day 계산용.
    #[serde(default)]
    pub residual_sigma_daily: Option<f64>,
    /// 소속 지수 일변동성 (소수). skew σ_day 계산용.
    #[serde(default)]
    pub index_sigma_daily: Option<f64>,
    /// 직전 NAV (ETF 직전 종가 프록시).
    #[serde(default)]
    pub prev_nav: Option<f64>,
    #[serde(default)]
    pub prev_close: Option<f64>,
    /// 소속 지수 직전 종가 (r_implied 앵커).
    #[serde(default)]
    pub prev_index_close: Option<f64>,
    /// 기초지수가 **선물지수**(F-K200/F-KQ150)인 ETF (114800·252670·251340 — DB
    /// underlying_index 실측). 두 leg 모두 선물 연동이라 현물-선물 베이시스 노출 ≈ 0
    /// → 베이시스 북의 지수 베이시스 etf_leg에서만 제외. 가족 델타·헤지 티켓에는
    /// 그대로 포함 (델타는 실재함).
    #[serde(default)]
    pub futures_based: bool,
}

/// matrix-config `quote_params` — 호가 파라미터 (UI 조정 대상).
#[derive(Debug, Clone, Deserialize)]
pub struct QuoteParams {
    pub base_spread_bp: f64,
    pub gamma: f64,
    pub adverse_buffer_bp: f64,
    pub hedge_cost_bp: f64,
    pub per_etf_inventory_limit_krw: f64,
    #[serde(default)]
    pub inventory_limit_overrides: HashMap<String, f64>,
    pub max_futures_contracts: i64,
    /// 베이시스 실행 라우터(§13.4) 임계 (bp). |excess_basis| 가 이 이상이면 선물 대체.
    /// 구버전 backend 대비 default.
    #[serde(default = "default_basis_threshold_bp")]
    pub basis_threshold_bp: f64,

    // ── §13.3-C P&L·리스크 한도 (Phase 4 PR-E) — 구버전 backend 대비 serde default ──
    /// 선물 체결 수수료 (bp × 명목) — 헤지비용 분해 v1.
    #[serde(default = "default_futures_fee_bp")]
    pub futures_fee_bp: f64,
    /// 베이시스 일변동성 근사 (bp) — 베이시스 VaR 조잡 상수.
    #[serde(default = "default_basis_vol_bp_daily")]
    pub basis_vol_bp_daily: f64,
    /// 북 순 베타델타 한도 (오버레이 후, 원).
    #[serde(default = "default_limit_net_delta_krw")]
    pub limit_net_delta_krw: f64,
    /// 잔차위험 1σ 총량 한도 (원).
    #[serde(default = "default_limit_residual_krw")]
    pub limit_residual_krw: f64,
    /// 베이시스 VaR 한도 (원).
    #[serde(default = "default_limit_basis_var_krw")]
    pub limit_basis_var_krw: f64,
}

fn default_basis_threshold_bp() -> f64 {
    5.0
}
fn default_futures_fee_bp() -> f64 {
    0.3
}
fn default_basis_vol_bp_daily() -> f64 {
    15.0
}
fn default_limit_net_delta_krw() -> f64 {
    2_000_000_000.0
}
fn default_limit_residual_krw() -> f64 {
    100_000_000.0
}
fn default_limit_basis_var_krw() -> f64 {
    200_000_000.0
}

impl Default for QuoteParams {
    fn default() -> Self {
        Self {
            base_spread_bp: 5.0,
            gamma: 1.0,
            adverse_buffer_bp: 3.0,
            hedge_cost_bp: 2.0,
            per_etf_inventory_limit_krw: 1_000_000_000.0,
            inventory_limit_overrides: HashMap::new(),
            max_futures_contracts: 100,
            basis_threshold_bp: 5.0,
            futures_fee_bp: 0.3,
            basis_vol_bp_daily: 15.0,
            limit_net_delta_krw: 2_000_000_000.0,
            limit_residual_krw: 100_000_000.0,
            limit_basis_var_krw: 200_000_000.0,
        }
    }
}

// =============================================================================
// 런타임 지수선물 상태 (family별 최신)
// =============================================================================

/// IndexFuturesTick 수신 시 product("kospi200"|"mini_k200"|"kosdaq150")별로 보관.
#[derive(Debug, Clone)]
pub struct IndexFuturesState {
    pub code: String,
    pub price: f64,
    pub underlying_index: f64,
    pub theory_price: Option<f64>,
    pub updated_at_ms: u64,
}

// =============================================================================
// FV_futures 계산 결과 (매트릭스 ③열 셀과 호가 보드가 공유)
// =============================================================================

#[derive(Debug, Clone)]
pub struct FvFutures {
    pub fair_value: f64,
    pub r_implied: f64,
    pub implied_index_spot: f64,
    pub futures_code: String,
    pub futures_theory_price: Option<f64>,
    pub index_family: String,
    /// 지수선물 입력 나이 (ms). ETF 틱 나이는 호가 row에서 별도.
    pub inputs_age_ms: u32,
    /// "" 이면 FV 유효. 아니면 사유.
    pub no_quote_reason: String,
}

impl FvFutures {
    fn invalid(family: &str, reason: String) -> Self {
        Self {
            fair_value: 0.0,
            r_implied: 0.0,
            implied_index_spot: 0.0,
            futures_code: String::new(),
            futures_theory_price: None,
            index_family: family.to_string(),
            inputs_age_ms: u32::MAX,
            no_quote_reason: reason,
        }
    }
}

/// family("k200"|"kq150") → 우선 product. k200은 kospi200(풀) 우선, 없으면 mini.
fn resolve_state<'a>(
    family: &str,
    index_futures: &'a HashMap<String, IndexFuturesState>,
) -> Option<&'a IndexFuturesState> {
    match family {
        "k200" => index_futures
            .get("kospi200")
            .or_else(|| index_futures.get("mini_k200")),
        "kq150" => index_futures.get("kosdaq150"),
        _ => None,
    }
}

/// 지수선물 코드에서 만기(2번째 목요일)까지 잔존일. 파싱 실패 시 0 (캐리 무시).
pub(crate) fn days_to_expiry(code: &str, today: NaiveDate) -> i64 {
    use chrono::Datelike;
    match parse_index_fut_ym(code, today.year()) {
        Some((y, m)) => second_thursday(y, m)
            .map(|exp| (exp - today).num_days().max(0))
            .unwrap_or(0),
        None => 0,
    }
}

/// 한 ETF의 FV_futures 계산 (pure). 실시간 지수선물 상태 + 정적 입력만으로 결정.
pub fn compute_fv_futures(
    etf: &QuoteUniverseEtf,
    index_futures: &HashMap<String, IndexFuturesState>,
    base_rate_annual: f64,
    now_ms: u64,
    today: NaiveDate,
) -> FvFutures {
    let family = etf.index_family.as_deref().unwrap_or("");
    if family.is_empty() {
        return FvFutures::invalid(family, "index_family 결측".into());
    }
    let Some(state) = resolve_state(family, index_futures) else {
        return FvFutures::invalid(family, format!("지수선물 미수신 ({family})"));
    };
    let age_ms = now_ms.saturating_sub(state.updated_at_ms).min(u32::MAX as u64) as u32;
    if state.price <= 0.0 {
        return FvFutures::invalid(family, "지수선물가 0".into());
    }
    if (age_ms as u64) > INDEX_FUT_STALE_MS {
        let mut fv = FvFutures::invalid(family, "지수선물 stale".into());
        fv.inputs_age_ms = age_ms;
        fv.futures_code = state.code.clone();
        return fv;
    }

    let prev_index_close = match etf.prev_index_close {
        Some(v) if v > 0.0 => v,
        _ => return FvFutures::invalid(family, "prev_index_close 결측".into()),
    };
    let prev_nav = match etf.prev_nav {
        Some(v) if v > 0.0 => v,
        _ => return FvFutures::invalid(family, "prev_nav 결측".into()),
    };

    // 배수/베타 선택 (r_implied 계산 전에 결측 검증 — 결측이면 하드 invalid).
    let mult = match etf.fv_mode.as_str() {
        "index" => match etf.leverage {
            Some(l) => l,
            None => return FvFutures::invalid(family, "leverage 결측 (index mode)".into()),
        },
        "beta" => match etf.beta {
            Some(b) => b,
            None => return FvFutures::invalid(family, "beta 결측 (beta mode)".into()),
        },
        other => return FvFutures::invalid(family, format!("알 수 없는 fv_mode: {other}")),
    };

    // S_impl = F / (1 + r × d/365). 배당 무시 (v1 — 금리만).
    let d = days_to_expiry(&state.code, today);
    let carry = base_rate_annual * (d as f64) / 365.0;
    let s_impl = state.price / (1.0 + carry);
    let r_implied = (s_impl - prev_index_close) / prev_index_close;
    let fair_value = prev_nav * (1.0 + mult * r_implied);

    // r_implied 극단 = soft flag: FV는 그대로 계산·표시하되 usable=false (자동 호가 억제).
    let reason = if r_implied.abs() > R_IMPLIED_EXTREME {
        "r_implied 극단 (서킷/데이터 의심)".to_string()
    } else {
        String::new()
    };

    FvFutures {
        fair_value,
        r_implied,
        implied_index_spot: s_impl,
        futures_code: state.code.clone(),
        futures_theory_price: state.theory_price,
        index_family: family.to_string(),
        inputs_age_ms: age_ms,
        no_quote_reason: reason,
    }
}

// =============================================================================
// 호가 제안 (요구 엣지 + skew + 제안 bid/ask/size)
// =============================================================================

/// ETF/ETN KRX 호가단위. 2,000원 미만 1원, 이상 5원.
fn etf_tick_size(price: f64) -> f64 {
    if price < 2_000.0 {
        1.0
    } else {
        5.0
    }
}

fn round_down(price: f64, ts: f64) -> f64 {
    (price / ts).floor() * ts
}
fn round_up(price: f64, ts: f64) -> f64 {
    (price / ts).ceil() * ts
}

/// bid 스냅 (내림). tick은 *FV가 아니라 raw 가격 자신의 구간*으로 결정하고, 스냅 결과가
/// 다른 tick 구간으로 넘어가면 그 구간 tick으로 한 번 더 내림 — 경계(2,000원) 교차 시에도
/// 항상 해당 구간에서 유효한 호가. (예: raw 2,001.2 → ts 5 → 2,000 ✓. FV 기준 ts를 쓰면
/// FV=2,001·raw 1,999.4 케이스에서 5원 내림 1,995로 불필요하게 보수적이 됨.)
fn snap_bid(price: f64) -> f64 {
    let s1 = round_down(price, etf_tick_size(price));
    round_down(s1, etf_tick_size(s1)) // 구간 교차 시 재스냅 (동일 구간이면 no-op)
}

/// ask 스냅 (올림). snap_bid와 대칭 — raw 가격 구간의 tick으로 올림 + 교차 시 재올림.
/// (예: raw 2,000.6 → ts 5 → 2,005 ✓. FV=1,999 기준 ts 1을 쓰면 2,001(무효 호가)이 나옴.)
fn snap_ask(price: f64) -> f64 {
    let s1 = round_up(price, etf_tick_size(price));
    round_up(s1, etf_tick_size(s1))
}

/// 한 ETF의 호가 row 계산.
///
/// - `fv`: 위 [`compute_fv_futures`] 결과.
/// - `price`: ETF 현재가 (0이면 결측). `price_age_ms`: 알 수 없으면 0 (한국 시장 마지막
///   체결가는 미체결이어도 유효 — 코드베이스 STALE 철학과 동일. 신선도 주신호는 지수선물).
/// - `qty`: 원장 순 수량 (부호 有). `hold_days`: 캐리 회전 가정.
#[allow(clippy::too_many_arguments)]
pub fn compute_quote_row(
    etf: &QuoteUniverseEtf,
    fv: &FvFutures,
    params: &QuoteParams,
    price: f64,
    price_age_ms: u32,
    qty: i64,
    hold_days: i32,
) -> QuoteRow {
    let name = etf.name.clone().unwrap_or_else(|| etf.code.clone());
    let hold = (hold_days.max(1)) as f64;

    // no_quote 사유 결정 — FV 단계 사유 + ETF 틱 결측.
    let mut reason = fv.no_quote_reason.clone();
    if reason.is_empty() && price <= 0.0 {
        reason = "ETF 틱 결측".to_string();
    }
    let usable = reason.is_empty();

    // ─── σ_day (일변동성, 소수) ───
    // 지수형: |L| × index_σ. 섹터형: √((β×index_σ)² + residual_σ²).
    let index_sigma = etf.index_sigma_daily.unwrap_or(0.0);
    let sigma_day_frac = match etf.fv_mode.as_str() {
        "index" => etf.leverage.unwrap_or(0.0).abs() * index_sigma,
        "beta" => {
            let b = etf.beta.unwrap_or(0.0);
            let resid = etf.residual_sigma_daily.unwrap_or(0.0);
            ((b * index_sigma).powi(2) + resid.powi(2)).sqrt()
        }
        _ => 0.0,
    };
    let sigma_day_pct = sigma_day_frac * 100.0;

    // ─── 재고 skew (bp, 부호 有) ───
    // skew_bp = −γ × q_억 × σ_%² × h.  롱 재고(q>0) → 음수 → 예약가격 하향(매도 공격적).
    let q_krw = qty as f64 * price;
    let q_eok = q_krw / 1e8;
    let skew_bp = -params.gamma * q_eok * sigma_day_pct.powi(2) * hold;

    // ─── residual charge (bp) ───  섹터형만 >0.
    let residual_bp = if etf.fv_mode == "beta" {
        etf.residual_sigma_daily.unwrap_or(0.0) * 100.0 * RESIDUAL_CHARGE_K
    } else {
        0.0
    };

    let base = params.base_spread_bp;
    let buffer = params.adverse_buffer_bp;
    // 반스프레드 (skew 제외). 음수 파라미터가 들어와도 half ≥ 0 클램프 —
    // ask−bid = FV×2×half/1e4 이므로 half ≥ 0 이면 bid > ask 역전이 구조적으로 불가능.
    // (backend pydantic ge=0이 1차 방어, 여기는 이중 방어.)
    let half = (base + buffer + residual_bp).max(0.0);

    // 예약가격 r = FV×(1+skew/1e4) 중심으로 ±half. 부호:
    //   edge_bid = half − skew (FV 하단 거리),  edge_ask = half + skew (FV 상단 거리).
    let edge_bid_bp = half - skew_bp;
    let edge_ask_bp = half + skew_bp;

    let fair_value = fv.fair_value;
    let (suggested_bid, suggested_ask) = if usable && fair_value > 0.0 {
        let raw_bid = fair_value * (1.0 - edge_bid_bp / 10_000.0);
        let raw_ask = fair_value * (1.0 + edge_ask_bp / 10_000.0);
        (snap_bid(raw_bid), snap_ask(raw_ask))
    } else {
        (0.0, 0.0)
    };

    // ─── 제안 수량 (v1: 재고 한도 잔여 기준) ───
    let limit_krw = params
        .inventory_limit_overrides
        .get(&etf.code)
        .copied()
        .unwrap_or(params.per_etf_inventory_limit_krw);
    let inventory_remaining_krw = (limit_krw - q_krw.abs()).max(0.0);
    let suggested_size = if usable && price > 0.0 {
        (inventory_remaining_krw / price).floor() as i64
    } else {
        0
    };

    let inputs_age_ms = fv.inputs_age_ms.max(price_age_ms);

    QuoteRow {
        code: etf.code.clone(),
        name,
        price,
        fv_futures: fair_value,
        fv_mode: etf.fv_mode.clone(),
        index_family: fv.index_family.clone(),
        r_implied: fv.r_implied,
        implied_index_spot: fv.implied_index_spot,
        futures_code: fv.futures_code.clone(),
        futures_theory_price: fv.futures_theory_price,
        edge_bid_bp,
        edge_ask_bp,
        skew_bp,
        components: QuoteComponents {
            base,
            buffer,
            residual: residual_bp,
            skew: skew_bp,
            hedge_cost: params.hedge_cost_bp,
        },
        suggested_bid,
        suggested_ask,
        suggested_size,
        size_basis: "재고 한도 잔여 / 현재가".to_string(),
        inventory_remaining_krw,
        inputs_age_ms,
        usable,
        no_quote_reason: reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k200_futures(price: f64, now_ms: u64) -> HashMap<String, IndexFuturesState> {
        let mut m = HashMap::new();
        m.insert(
            "kospi200".to_string(),
            IndexFuturesState {
                // 2026년 9월물 형식 (A + 01 + 6 + 9 + 000). d>0.
                code: "A0169000".to_string(),
                price,
                underlying_index: price - 2.0,
                theory_price: Some(price + 0.5),
                updated_at_ms: now_ms,
            },
        );
        m
    }

    fn base_etf() -> QuoteUniverseEtf {
        QuoteUniverseEtf {
            code: "069500".into(),
            name: Some("KODEX 200".into()),
            index_family: Some("k200".into()),
            leverage: Some(1.0),
            fv_mode: "index".into(),
            beta: None,
            residual_sigma_daily: None,
            index_sigma_daily: Some(0.011),
            prev_nav: Some(130_125.0),
            prev_close: Some(130_125.0),
            prev_index_close: Some(1293.13),
            futures_based: false,
        }
    }

    #[test]
    fn fv_index_direction_matches_index_move() {
        let now = 1_000_000_u64;
        // 선물 1300 (지수 상승) → r_implied > 0 → FV > prev_nav.
        let fut = k200_futures(1300.0, now);
        let etf = base_etf();
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        assert!(fv.no_quote_reason.is_empty(), "reason={}", fv.no_quote_reason);
        assert!(fv.r_implied > 0.0);
        assert!(fv.fair_value > 130_125.0, "fv={}", fv.fair_value);
    }

    #[test]
    fn inverse_2x_flips_and_doubles() {
        let now = 1_000_000_u64;
        let fut = k200_futures(1300.0, now);
        let mut etf = base_etf();
        etf.code = "252670".into();
        etf.leverage = Some(-2.0);
        etf.prev_nav = Some(76.0);
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        // 지수 상승 → 인버스2X FV < prev_nav.
        assert!(fv.fair_value < 76.0, "fv={}", fv.fair_value);
        // 배수 방향: (FV/prev - 1) ≈ -2 × r_implied.
        let etf_ret = fv.fair_value / 76.0 - 1.0;
        assert!((etf_ret - (-2.0 * fv.r_implied)).abs() < 1e-9);
    }

    #[test]
    fn stale_futures_no_quote() {
        let now = 1_000_000_u64 + INDEX_FUT_STALE_MS + 5_000;
        let fut = k200_futures(1300.0, 1_000_000); // old
        let etf = base_etf();
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        assert_eq!(fv.no_quote_reason, "지수선물 stale");
    }

    #[test]
    fn long_inventory_shifts_quotes_down() {
        let now = 1_000_000_u64;
        let fut = k200_futures(1295.0, now);
        let etf = base_etf();
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        let params = QuoteParams::default();
        // 롱 재고 10억: qty = 10억 / 130125 ≈ 7685주.
        let qty = (1_000_000_000.0_f64 / 130_125.0).floor() as i64;
        let row = compute_quote_row(&etf, &fv, &params, 130_125.0, 0, qty, 1);
        assert!(row.usable);
        // 롱 → skew 음수 → edge_ask < edge_bid (매도 공격적).
        assert!(row.skew_bp < 0.0, "skew={}", row.skew_bp);
        assert!(row.edge_ask_bp < row.edge_bid_bp);
        // 스프레드는 항상 양수.
        assert!(row.suggested_ask > row.suggested_bid);
    }

    #[test]
    fn flat_inventory_symmetric() {
        let now = 1_000_000_u64;
        let fut = k200_futures(1295.0, now);
        let etf = base_etf();
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        let params = QuoteParams::default();
        let row = compute_quote_row(&etf, &fv, &params, 130_125.0, 0, 0, 1);
        assert!((row.skew_bp).abs() < 1e-9);
        assert!((row.edge_bid_bp - row.edge_ask_bp).abs() < 1e-9);
        assert_eq!(row.components.hedge_cost, params.hedge_cost_bp);
    }

    /// 호가단위 2,000원 경계 교차 — 스냅 결과가 항상 자기 구간에서 유효해야 함.
    #[test]
    fn tick_snap_across_2000_boundary() {
        // ask: 1,999.x → 올림이 2,000 도달 시 5원 배수(2,000)로 유효.
        assert_eq!(snap_ask(1_999.2), 2_000.0);
        // ask: 경계 위 raw → 5원 올림 (1원 올림 2,001은 무효 호가).
        assert_eq!(snap_ask(2_000.6), 2_005.0);
        assert_eq!(snap_ask(2_001.0), 2_005.0);
        // bid: 경계 위 raw → 5원 내림 = 2,000 (유효).
        assert_eq!(snap_bid(2_001.2), 2_000.0);
        assert_eq!(snap_bid(2_004.9), 2_000.0);
        // bid: 경계 아래 raw → 1원 내림 유지 (FV 기준 5원을 쓰면 1,995로 과보수).
        assert_eq!(snap_bid(1_999.7), 1_999.0);
        // 경계에서 먼 일반 케이스 — 구간 내 tick.
        assert_eq!(snap_bid(1_500.4), 1_500.0);
        assert_eq!(snap_ask(15_000.2), 15_005.0);
    }

    /// row 레벨: FV가 경계 바로 아래(1,999)일 때 ask가 무효 가격(2,001류)이 아니어야 함.
    #[test]
    fn quote_row_valid_ticks_near_boundary() {
        let fv = FvFutures {
            fair_value: 1_999.0,
            r_implied: 0.001,
            implied_index_spot: 1_294.0,
            futures_code: "A0169000".into(),
            futures_theory_price: None,
            index_family: "k200".into(),
            inputs_age_ms: 100,
            no_quote_reason: String::new(),
        };
        let mut etf = base_etf();
        etf.prev_nav = Some(1_997.0);
        let params = QuoteParams::default(); // half = 8bp → raw_ask = 1999×1.0008 ≈ 2000.6
        let row = compute_quote_row(&etf, &fv, &params, 1_999.0, 0, 0, 1);
        assert!(row.usable);
        // ask는 2,000 이상 구간 → 5원 배수여야 함 (2,001 같은 무효 가격 금지).
        assert_eq!(row.suggested_ask, 2_005.0, "ask={}", row.suggested_ask);
        // bid는 2,000 미만 구간 → 1원 배수 (1997.4 → 1997).
        assert_eq!(row.suggested_bid, 1_997.0, "bid={}", row.suggested_bid);
        assert!(row.suggested_ask > row.suggested_bid);
    }

    /// 섹터형(beta) FV — β 배수로 지수 수익률 반영 + residual charge 가산.
    #[test]
    fn fv_beta_mode_uses_beta_and_residual_charge() {
        let now = 1_000_000_u64;
        let fut = k200_futures(1300.0, now); // 지수 상승
        let mut etf = base_etf();
        etf.code = "396500".into();
        etf.fv_mode = "beta".into();
        etf.leverage = None;
        etf.beta = Some(1.25);
        etf.residual_sigma_daily = Some(0.008); // 0.8%/일 → residual = 0.8 × 6 = 4.8bp
        etf.prev_nav = Some(44_500.0);
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        assert!(fv.no_quote_reason.is_empty(), "reason={}", fv.no_quote_reason);
        // (FV/prev − 1) ≈ β × r_implied.
        let etf_ret = fv.fair_value / 44_500.0 - 1.0;
        assert!((etf_ret - 1.25 * fv.r_implied).abs() < 1e-9);
        // residual charge가 edge에 가산.
        let params = QuoteParams::default();
        let row = compute_quote_row(&etf, &fv, &params, 44_500.0, 0, 0, 1);
        let expected_residual = 0.008 * 100.0 * RESIDUAL_CHARGE_K;
        assert!((row.components.residual - expected_residual).abs() < 1e-9);
        assert!((row.edge_bid_bp - (5.0 + 3.0 + expected_residual)).abs() < 1e-9);
        // beta 결측이면 하드 invalid.
        etf.beta = None;
        let fv2 = compute_fv_futures(&etf, &fut, 0.028, now, today);
        assert_eq!(fv2.no_quote_reason, "beta 결측 (beta mode)");
    }

    /// r_implied 극단(±15%+) — soft flag: FV는 계산·표시되되 usable=false 사유 부여.
    #[test]
    fn r_implied_extreme_soft_flag() {
        let now = 1_000_000_u64;
        // 선물 1500 vs prev_index 1293.13 → r_impl ≈ +16% > 15% 컷.
        let fut = k200_futures(1500.0, now);
        let etf = base_etf();
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        assert_eq!(fv.no_quote_reason, "r_implied 극단 (서킷/데이터 의심)");
        // soft flag — FV·r_implied는 그대로 계산돼 표시 가능.
        assert!(fv.fair_value > 0.0);
        assert!(fv.r_implied > 0.15);
        // row는 no_quote (제안 가격 0).
        let row = compute_quote_row(&etf, &fv, &QuoteParams::default(), 130_125.0, 0, 0, 1);
        assert!(!row.usable);
        assert_eq!(row.suggested_bid, 0.0);
    }

    /// 음수 파라미터 이중 방어 — half 클램프로 bid > ask 역전 불가.
    #[test]
    fn negative_params_clamped_no_inversion() {
        let now = 1_000_000_u64;
        let fut = k200_futures(1295.0, now);
        let etf = base_etf();
        let today = NaiveDate::from_ymd_opt(2026, 7, 7).unwrap();
        let fv = compute_fv_futures(&etf, &fut, 0.028, now, today);
        let params = QuoteParams {
            base_spread_bp: -10.0, // 방어 대상 (backend ge=0이 1차, 여기는 이중)
            adverse_buffer_bp: 0.0,
            ..QuoteParams::default()
        };
        let row = compute_quote_row(&etf, &fv, &params, 130_125.0, 0, 0, 1);
        assert!(row.suggested_ask >= row.suggested_bid, "bid/ask 역전: {} > {}", row.suggested_bid, row.suggested_ask);
        assert!(row.edge_bid_bp >= 0.0);
    }
}
