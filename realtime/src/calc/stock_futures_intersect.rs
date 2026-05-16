//! PDF ∩ 주식선물 교집합 fair value (헤지 경로 ②).
//!
//! 식: `fair_value = (Σ(intersect_qty × futures_price) + Σ(non_intersect_qty × stock_price) + cash) / cu_unit`
//!
//! 교집합 종목은 *주식선물가*를 사용 → 베이시스 활용. 잔여(주식선물 없는 종목)는 현물가.
//!
//! **가정 (첫 빌드, Task #8 검증 대상)**:
//! - 주식선물 가격은 *주당 환산 가격*으로 표시됨. multiplier(1계약=10주 등)는 *거래 단위*에만
//!   영향, fair value 계산엔 곱하지 않음.
//! - 선물 가격이 stale 또는 미수신이면 해당 종목 missing 처리 (현물 가격이 있어도).
//! - 만기 임박/롤오버 처리는 별도. front_month 단순 사용.

use crate::model::lp::{FairValueCell, HedgeRoute};

use super::{apply_level3_costs, CostInputs, EtfStaticInput, PriceMap, STALE_THRESHOLD_MS};

pub fn compute_stock_futures_intersect(
    etf: &EtfStaticInput,
    etf_price: f64,
    prices: &PriceMap,
    cost: &CostInputs,
    now_ms: u64,
) -> FairValueCell {
    let Some(idata) = etf.intersect.as_ref() else {
        return unusable_cell(etf, now_ms);
    };

    let mut sum_per_cu = 0.0_f64;
    let mut missing: Vec<String> = Vec::new();
    let mut oldest_update_ms: Option<u64> = None;
    let mut covered_qty: i64 = 0;
    let mut total_qty: i64 = 0;

    // 1. 교집합 종목 — 주식선물 가격
    for s in &idata.intersect {
        total_qty += s.qty;
        match prices.get(&s.futures_code) {
            Some(p) => {
                sum_per_cu += s.qty as f64 * p.price;
                covered_qty += s.qty;
                oldest_update_ms = Some(
                    oldest_update_ms.map_or(p.updated_at_ms, |o| o.min(p.updated_at_ms)),
                );
            }
            None => missing.push(s.futures_code.clone()),
        }
    }

    // 2. 잔여 종목 — 현물 가격
    for s in &idata.non_intersect_stocks {
        total_qty += s.qty;
        match prices.get(&s.code) {
            Some(p) => {
                sum_per_cu += s.qty as f64 * p.price;
                covered_qty += s.qty;
                oldest_update_ms = Some(
                    oldest_update_ms.map_or(p.updated_at_ms, |o| o.min(p.updated_at_ms)),
                );
            }
            None => missing.push(s.code.clone()),
        }
    }

    // 3. cash
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
        route: HedgeRoute::StockFuturesIntersect,
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

/// 교집합 데이터가 없을 때(드물게 PDF는 있는데 intersect 매핑 빠진 경우) usable=false 셀.
fn unusable_cell(etf: &EtfStaticInput, now_ms: u64) -> FairValueCell {
    FairValueCell {
        etf_code: etf.code.clone(),
        route: HedgeRoute::StockFuturesIntersect,
        fair_value: 0.0,
        net_fv_buy: 0.0,
        net_fv_sell: 0.0,
        edge_buy_bp: 0.0,
        edge_sell_bp: 0.0,
        inputs_age_ms: u32::MAX,
        inputs_covered_pct: 0.0,
        missing_components: vec![],
        usable: false,
        computed_at_ms: now_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CostInputs, IntersectData, IntersectStock, PdfData, PdfStock, PriceWithAge};
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
                    PdfStock { code: "AAA".into(), name: "A".into(), qty: 100 },
                    PdfStock { code: "BBB".into(), name: "B".into(), qty: 200 },
                ],
            },
            intersect: Some(IntersectData {
                etf_code: "229200".into(),
                front_month: Some("202605".into()),
                intersect: vec![IntersectStock {
                    stock_code: "AAA".into(),
                    name: "A".into(),
                    qty: 100,
                    futures_code: "FAA65000".into(),
                    multiplier: 10.0,
                    expiry: Some("20260514".into()),
                }],
                non_intersect_stocks: vec![PdfStock { code: "BBB".into(), name: "B".into(), qty: 200 }],
                intersect_weight_pct: 33.3,
            }),
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
    fn intersect_uses_futures_non_intersect_uses_stock() {
        let etf = dummy_etf();
        let now = 1_000_000_u64;
        let mut prices: PriceMap = HashMap::new();
        // AAA 현물 5000, 선물 5050 → 교집합은 선물(5050)을 사용
        prices.insert("AAA".into(), PriceWithAge { price: 5_000.0, updated_at_ms: now - 100 });
        prices.insert("FAA65000".into(), PriceWithAge { price: 5_050.0, updated_at_ms: now - 200 });
        prices.insert("BBB".into(), PriceWithAge { price: 10_000.0, updated_at_ms: now - 300 });

        let cell = compute_stock_futures_intersect(&etf, 50.0, &prices, &dummy_cost(), now);
        // sum_per_cu = 100*5050 (선물) + 200*10000 + 1_000_000 = 505_000 + 2_000_000 + 1_000_000 = 3_505_000
        // fair_value = 3_505_000 / 50_000 = 70.1
        assert!((cell.fair_value - 70.1).abs() < 0.001, "fv = {}", cell.fair_value);
        assert!(cell.usable);
        assert_eq!(cell.inputs_age_ms, 300);
    }

    #[test]
    fn missing_futures_price_marks_unusable() {
        let etf = dummy_etf();
        let mut prices: PriceMap = HashMap::new();
        // AAA 현물은 있지만 FAA65000 선물 누락 → 교집합 종목 missing
        prices.insert("AAA".into(), PriceWithAge { price: 5_000.0, updated_at_ms: 999_900 });
        prices.insert("BBB".into(), PriceWithAge { price: 10_000.0, updated_at_ms: 999_900 });

        let cell = compute_stock_futures_intersect(&etf, 50.0, &prices, &dummy_cost(), 1_000_000);
        assert_eq!(cell.missing_components, vec!["FAA65000".to_string()]);
        assert!(!cell.usable);
    }
}
