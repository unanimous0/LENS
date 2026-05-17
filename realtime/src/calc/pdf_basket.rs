//! PDF 전종목 바스켓 fair value (헤지 경로 ①).
//!
//! 식: `fair_value = (Σ(qty × stock_price) + cash) / cu_unit`
//!
//! 1주 ETF에 대응되는 *PDF 1셀(=1 CU)* 의 자산 가치 합을 CU 단위 수로 나눠 ETF 1주 NAV 산출.
//! 가격 못 잡은 종목은 missing_components에 코드 기록 + usable=false 게이트.

use crate::model::lp::{FairValueCell, HedgeRoute};

use super::{apply_level3_costs, CostInputs, EtfStaticInput, PriceMap, STALE_THRESHOLD_MS};

/// PDF 전종목 바스켓 셀 계산.
///
/// - `etf_price`: ETF 현재가 (edge bp 산출용). 0이면 edge 계산 skip.
/// - `prices`: 코드 → 가격 + 갱신 시각 맵.
/// - `cost`: Level 3 입력값.
/// - `now_ms`: 호출 시점 (epoch ms). 신선도 계산용.
pub fn compute_pdf_basket(
    etf: &EtfStaticInput,
    etf_price: f64,
    prices: &PriceMap,
    cost: &CostInputs,
    now_ms: u64,
) -> FairValueCell {
    let mut sum_per_cu = 0.0_f64;
    let mut missing: Vec<String> = Vec::new();
    let mut oldest_update_ms: Option<u64> = None;
    let mut covered_qty: i64 = 0;
    let mut total_qty: i64 = 0;

    for stock in &etf.pdf.stocks {
        total_qty += stock.qty;
        match prices.get(&stock.code) {
            Some(p) => {
                sum_per_cu += stock.qty as f64 * p.price;
                covered_qty += stock.qty;
                oldest_update_ms = Some(
                    oldest_update_ms.map_or(p.updated_at_ms, |o| o.min(p.updated_at_ms)),
                );
            }
            None => missing.push(stock.code.clone()),
        }
    }

    sum_per_cu += etf.pdf.cash as f64;

    let cu_unit = etf.cu_unit.unwrap_or(1) as f64;
    let fair_value = if cu_unit > 0.0 {
        sum_per_cu / cu_unit
    } else {
        0.0
    };

    let (net_fv_buy, net_fv_sell) = apply_level3_costs(fair_value, cost);

    let (edge_buy_bp, edge_sell_bp) = if etf_price > 0.0 {
        (
            (etf_price - net_fv_buy) / etf_price * 10_000.0,
            (net_fv_sell - etf_price) / etf_price * 10_000.0,
        )
    } else {
        (0.0, 0.0)
    };

    let inputs_age_ms = oldest_update_ms
        .map(|t| now_ms.saturating_sub(t).min(u32::MAX as u64) as u32)
        .unwrap_or(u32::MAX);

    let inputs_covered_pct = if total_qty > 0 {
        covered_qty as f64 / total_qty as f64
    } else {
        0.0
    };

    let usable = missing.is_empty() && inputs_age_ms < STALE_THRESHOLD_MS && fair_value > 0.0;

    FairValueCell {
        etf_code: etf.code.clone(),
        route: HedgeRoute::PdfBasket,
        fair_value,
        net_fv_buy,
        net_fv_sell,
        edge_buy_bp,
        edge_sell_bp,
        inputs_age_ms,
        inputs_covered_pct,
        missing_components: missing,
        usable,
        computed_at_ms: now_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CostInputs, PdfData, PdfStock, PriceWithAge};
    use super::*;
    use std::collections::HashMap;

    fn dummy_etf() -> EtfStaticInput {
        EtfStaticInput {
            code: "229200".into(),
            name: Some("KODEX 코스닥150".into()),
            cu_unit: Some(50_000),
            arbitrable: true,
            pdf: PdfData {
                as_of: Some("2026-05-12".into()),
                cash: 1_000_000,
                stocks: vec![
                    PdfStock { code: "AAA".into(), name: "A주식".into(), qty: 100 },
                    PdfStock { code: "BBB".into(), name: "B주식".into(), qty: 200 },
                ],
            },
            intersect: None,
        }
    }

    fn dummy_cost() -> CostInputs {
        CostInputs {
            tax_sell_bp: 20.0,
            base_rate_annual: 0.028,
            slippage_bp: 0.0,
            hold_days: 1,
        }
    }

    #[test]
    fn full_coverage_computes_correctly() {
        let etf = dummy_etf();
        let now = 1_000_000_u64;
        let mut prices: PriceMap = HashMap::new();
        prices.insert("AAA".into(), PriceWithAge { price: 5_000.0, updated_at_ms: now - 100 });
        prices.insert("BBB".into(), PriceWithAge { price: 10_000.0, updated_at_ms: now - 500 });

        let cell = compute_pdf_basket(&etf, 50.0, &prices, &dummy_cost(), now);
        // sum_per_cu = 100*5000 + 200*10000 + 1_000_000 = 500_000 + 2_000_000 + 1_000_000 = 3_500_000
        // fair_value = 3_500_000 / 50_000 = 70.0
        assert!((cell.fair_value - 70.0).abs() < 0.001, "fv = {}", cell.fair_value);
        assert_eq!(cell.missing_components.len(), 0);
        assert!(cell.usable);
        assert!((cell.inputs_covered_pct - 1.0).abs() < 0.001);
        assert_eq!(cell.inputs_age_ms, 500);
    }

    #[test]
    fn missing_price_marks_unusable() {
        let etf = dummy_etf();
        let mut prices: PriceMap = HashMap::new();
        prices.insert("AAA".into(), PriceWithAge { price: 5_000.0, updated_at_ms: 999_900 });
        // BBB 누락

        let cell = compute_pdf_basket(&etf, 50.0, &prices, &dummy_cost(), 1_000_000);
        assert_eq!(cell.missing_components, vec!["BBB".to_string()]);
        assert!(!cell.usable);
    }

    #[test]
    fn stale_input_marks_unusable() {
        let etf = dummy_etf();
        let now = 1_000_000_u64;
        let mut prices: PriceMap = HashMap::new();
        // BBB가 임계(60s) 이상 stale
        prices.insert("AAA".into(), PriceWithAge { price: 5_000.0, updated_at_ms: now - 100 });
        prices.insert("BBB".into(), PriceWithAge { price: 10_000.0, updated_at_ms: now - 70_000 });

        let cell = compute_pdf_basket(&etf, 50.0, &prices, &dummy_cost(), now);
        assert!(!cell.usable);
        assert_eq!(cell.inputs_age_ms, 70_000);
    }
}
