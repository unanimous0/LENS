//! LP 매트릭스 fair value 계산 엔진.
//!
//! 입력: FastAPI `/api/lp/matrix-config` 응답(정적 PDF/교집합/cost params) + 실시간 가격 맵.
//! 출력: ETF × 헤지경로별 `FairValueCell` (Level 2 raw + Level 3 net + 신선도 메타).
//!
//! 첫 빌드 wire: [`pdf_basket`] + [`stock_futures_intersect`]. 두 함수 모두 pure — 입력만으로 결정,
//! 호출자(`scheduler`)가 매 throttle 윈도우(50~200ms)에 호출하여 셀 재계산.
#![allow(dead_code)]

pub mod book_risk;
pub mod pdf_basket;
pub mod scheduler;
pub mod stock_futures_intersect;

use std::collections::HashMap;

use serde::Deserialize;

/// FastAPI `/api/lp/matrix-config` 전체 응답.
/// Rust startup에 1회 fetch — `matrix_config()`에서 reqwest로 받음 (Task #5).
#[derive(Debug, Clone, Deserialize)]
pub struct MatrixConfig {
    pub book: BookConfig,
    pub per_etf: HashMap<String, EtfStaticInput>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BookConfig {
    pub etf_codes: Vec<String>,
    pub cost_inputs: CostInputs,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EtfStaticInput {
    pub code: String,
    pub name: Option<String>,
    pub cu_unit: Option<i64>,
    pub arbitrable: bool,
    pub pdf: PdfData,
    pub intersect: Option<IntersectData>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PdfData {
    pub as_of: Option<String>,
    pub cash: i64,
    pub stocks: Vec<PdfStock>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PdfStock {
    pub code: String,
    pub name: String,
    pub qty: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IntersectData {
    pub etf_code: String,
    pub front_month: Option<String>,
    pub intersect: Vec<IntersectStock>,
    pub non_intersect_stocks: Vec<PdfStock>,
    pub intersect_weight_pct: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct IntersectStock {
    pub stock_code: String,
    pub name: String,
    pub qty: i64,
    pub futures_code: String,
    pub multiplier: f64,
    pub expiry: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CostInputs {
    /// 거래세 (매도 측만, bp). 기본 20bp = 0.20%
    pub tax_sell_bp: f64,
    /// 회사금리 (연, 소수). 기본 0.028 = 2.8%
    pub base_rate_annual: f64,
    /// 슬리피지 (bp). 사용자 입력, 기본 0
    pub slippage_bp: f64,
    /// 헤지 회전 가정 (일). 캐리 일할 계산용
    pub hold_days: i32,
}

/// 가격 맵 — 코드(주식/ETF/선물 모두) → (price, last_update_ms).
/// 호출자(scheduler)가 채워서 넘김. 첫 빌드는 단순 HashMap.
pub type PriceMap = HashMap<String, PriceWithAge>;

#[derive(Debug, Clone, Copy)]
pub struct PriceWithAge {
    pub price: f64,
    pub updated_at_ms: u64,
}

/// Level 3 비용 차감 — raw fair_value에 cost params 적용해서 net 산출.
///
/// 매수 진입 (LP가 ETF 매수 호가): fair_value × (1 − slippage − carry)
///   - 매수 후 보유 → 자본비용(carry) 발생
///   - 거래세는 매도 측만 → 매수에는 미적용
///
/// 매도 진입 (LP가 ETF 매도 호가): fair_value × (1 + carry − slippage − tax_sell)
///   - 매도 후 자금 운용 수익(carry +)
///   - 거래세(tax_sell) 차감
///   - 슬리피지 차감
///
/// 가정: bp는 fair_value의 비율. 정밀화는 다음 빌드 + Task #8 검증 대상.
pub fn apply_level3_costs(fair_value: f64, cost: &CostInputs) -> (f64, f64) {
    let carry_frac = cost.base_rate_annual * (cost.hold_days as f64) / 365.0;
    let slippage_frac = cost.slippage_bp / 10_000.0;
    let tax_sell_frac = cost.tax_sell_bp / 10_000.0;

    let net_fv_buy = fair_value * (1.0 - slippage_frac - carry_frac);
    let net_fv_sell = fair_value * (1.0 + carry_frac - slippage_frac - tax_sell_frac);
    (net_fv_buy, net_fv_sell)
}

/// 신선도 임계 — 입력 데이터가 이 시간보다 오래되면 셀 usable=false.
/// 첫 빌드는 1분. 다음 빌드에서 ETF별 / 경로별 정책 분기 가능.
pub const STALE_THRESHOLD_MS: u32 = 60_000;

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_cost() -> CostInputs {
        CostInputs {
            tax_sell_bp: 20.0,
            base_rate_annual: 0.028,
            slippage_bp: 5.0,
            hold_days: 1,
        }
    }

    #[test]
    fn level3_costs_match_design_formula() {
        // fair_value = 10,000
        // carry_frac = 0.028 × 1 / 365 ≈ 7.67e-5
        // slippage_frac = 5 / 10000 = 5e-4
        // tax_sell_frac = 20 / 10000 = 2e-3
        let (buy, sell) = apply_level3_costs(10_000.0, &dummy_cost());
        // 매수 net = 10,000 × (1 - 5e-4 - 7.67e-5)
        //         ≈ 9,994.23
        assert!((buy - 9994.23).abs() < 0.5, "buy = {}", buy);
        // 매도 net = 10,000 × (1 + 7.67e-5 - 5e-4 - 2e-3)
        //         ≈ 9,975.77
        assert!((sell - 9975.77).abs() < 0.5, "sell = {}", sell);
    }
}
