//! 베이시스 북 (§13.4 Phase 4) — 북 4층 분해 + 종목/지수 베이시스 명시 추적.
//!
//! 북에 존재하는 모든 베이시스 포지션을 분리 추적하고, 북 전체를 4층으로 분해:
//!   ① 방향 델타   = 선물 오버레이 후 잔여 방향 (hedge_ticket residual 합 — 동일 소스)
//!   ② 지수 베이시스 = 지수형 ETF 롱 vs 지수선물 숏, 가족별 notional + 10bp 민감도
//!   ③ 종목 베이시스 = 현물 vs 주식선물 페어 (진입→현재·수렴손익·만기 D-day)
//!   ④ 잔차위험     = book_risk #3 그대로
//!
//! "지금 내 북 = K200 베이시스 42억 롱" 이 한 줄로 보이게 하는 게 목적.
//!
//! 모든 계산은 pure — 원장 집계(aggs) + 가격/유니버스/지수선물/헤지티켓만으로 결정.
#![allow(dead_code)]

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::model::lp::{
    BasisBookSnapshot, HedgeTicket, IndexBasisExposure, StockBasisPair,
};

use super::basis_route::{parse_expiry_days, StockFuture};
use super::hedge_ticket::classify_index_future;
use super::quote_board::{days_to_expiry as index_days_to_expiry, IndexFuturesState, QuoteUniverseEtf};
use super::{LedgerAgg, PriceMap};

/// 주식선물가/현물가 stale 임계 (ms) — basis_route와 동일 철학(선물 체결 빈도 낮아 관대).
const BASIS_STALE_MS: u64 = 60_000;

/// 종목 베이시스 만기 액션 임계 (일) — D-5 이내면 현물 leg 처리 필요 플래그.
const STOCK_EXPIRY_ACTION_DAYS: i64 = 5;

/// 지수선물 오버레이 롤 임계 (일) — front month D-2 이내면 롤 필요 (§13.8 만기 D-2 롤).
const INDEX_ROLL_DAYS: i64 = 2;

/// family("k200"|"kq150") → 우선 front 지수선물 state (풀 우선, 없으면 미니). 만기 산정용.
fn resolve_index_state<'a>(
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

/// 베이시스 북 산출 (pure).
///
/// - `aggs`: 원장 집계 (instrument·net_qty·base_code·entry_basis).
/// - `prices`: 현물·주식선물 tick 캐시 (나이 有).
/// - `etf_prices`: ETF 현재가 (나이 無 — 지수 ETF 노출용).
/// - `universe`: 12종 호가 유니버스 (지수형 판정·leverage).
/// - `index_futures`: product별 최신 지수선물 (만기/롤 산정).
/// - `hedge_tickets`: 방향 델타(residual) + 가족별 기존 선물 델타(existing) 동일 소스.
/// - `residual_risk_krw`: book_risk #3.
/// - `fut_by_code`: 주식선물 계약 코드(front/back) → 마스터 항목. **실보유 계약**의
///   만기·이름을 정확히 잡는 소스 (base→front만 보면 차월물 만기 오귀속 — M1).
#[allow(clippy::too_many_arguments)]
pub fn compute_basis_book(
    aggs: &[LedgerAgg],
    prices: &PriceMap,
    etf_prices: &HashMap<String, f64>,
    universe: &[QuoteUniverseEtf],
    index_futures: &HashMap<String, IndexFuturesState>,
    hedge_tickets: &[HedgeTicket],
    residual_risk_krw: f64,
    base_rate_annual: f64,
    fut_by_code: &HashMap<String, StockFuture>,
    now_ms: u64,
    today: NaiveDate,
    now_iso: &str,
) -> BasisBookSnapshot {
    let uni: HashMap<&str, &QuoteUniverseEtf> =
        universe.iter().map(|e| (e.code.as_str(), e)).collect();

    // ── ① 방향 델타 = Σ 헤지티켓 residual (오버레이 후 잔여 방향, 동일 소스) ──
    let directional_delta_krw: f64 = hedge_tickets.iter().map(|t| t.residual_delta_krw).sum();

    // ── ② 지수 베이시스 (가족별) ──
    // etf_leg = Σ 지수형 ETF 노출 × L (지수 환산 델타). fut_leg = 헤지티켓 existing (동일 소스).
    let mut etf_leg: HashMap<&'static str, f64> = HashMap::new();
    for agg in aggs {
        if agg.net_qty == 0 {
            continue;
        }
        // 지수선물은 fut_leg(헤지티켓 existing)로 이미 잡히므로 여기선 skip.
        if classify_index_future(&agg.code).is_some() {
            continue;
        }
        let Some(etf) = uni.get(agg.code.as_str()) else {
            continue;
        };
        if etf.fv_mode != "index" {
            continue; // 섹터형(beta)은 지수 베이시스 아님 — 방향/잔차로 흡수.
        }
        // 선물지수 추종 ETF (114800·252670·251340) — 두 leg 모두 선물 연동이라 현물-선물
        // 베이시스 노출 ≈ 0. etf_leg에 넣으면 유령 베이시스가 생김 (M2). 가족 델타·헤지
        // 티켓에는 그대로 포함 (델타는 실재) — 여기 지수 베이시스에서만 제외.
        if etf.futures_based {
            continue;
        }
        let Some(fam) = family_static(etf.index_family.as_deref().unwrap_or("")) else {
            continue;
        };
        let price = etf_price_of(&agg.code, etf_prices, prices);
        if price <= 0.0 {
            continue;
        }
        let l = etf.leverage.unwrap_or(0.0);
        *etf_leg.entry(fam).or_insert(0.0) += agg.net_qty as f64 * price * l;
    }

    let fut_leg_of = |family: &str| -> f64 {
        hedge_tickets
            .iter()
            .find(|t| t.family == family)
            .map(|t| t.existing_futures_delta_krw)
            .unwrap_or(0.0)
    };

    let mut index_basis: Vec<IndexBasisExposure> = Vec::new();
    for &family in &["k200", "kq150"] {
        let etf_l = etf_leg.get(family).copied().unwrap_or(0.0);
        let fut_l = fut_leg_of(family);
        if etf_l == 0.0 && fut_l == 0.0 {
            continue;
        }
        // 매칭: ETF·선물 반대 부호일 때만 베이시스 포지션. min(|·|) × sign(etf) (양수=베이시스 롱).
        let net_basis = if etf_l * fut_l < 0.0 {
            etf_l.abs().min(fut_l.abs()) * etf_l.signum()
        } else {
            0.0
        };
        let (days, fut_code) = match resolve_index_state(family, index_futures) {
            Some(s) => (index_days_to_expiry(&s.code, today), s.code.clone()),
            None => (0, String::new()),
        };
        index_basis.push(IndexBasisExposure {
            family: family.to_string(),
            etf_leg_krw: etf_l,
            fut_leg_krw: fut_l,
            net_basis_notional_krw: net_basis,
            sensitivity_per_10bp_krw: net_basis * 10.0 / 10_000.0,
            days_to_expiry: days,
            roll_needed: !fut_code.is_empty() && days <= INDEX_ROLL_DAYS,
            futures_code: fut_code,
        });
    }

    // ── ③ 종목 베이시스 (현물 vs 주식선물 페어) ──
    // 현물 6자리 → net_qty. 주식선물은 base_code로 그룹핑 후 **만기 순 순차 배분** (H1):
    // 롤 주간엔 같은 base의 근월+차월이 동시 보유되는데, 각 월물이 현물 전량과 페어링되면
    // matched 합 > 현물 보유량 (이중계상). 근월 우선으로 현물 잔량을 나눠 배분하고,
    // 잔여 선물 leg는 페어 아님(일반 포지션).
    let mut spot_qty: HashMap<&str, i64> = HashMap::new();
    for agg in aggs {
        if agg.instrument == "stock" && agg.net_qty != 0 {
            spot_qty.insert(agg.code.as_str(), agg.net_qty);
        }
    }
    // base → 주식선물 leg들 (반대 부호만 후보).
    let mut futs_by_base: HashMap<&str, Vec<&LedgerAgg>> = HashMap::new();
    for agg in aggs {
        if agg.instrument != "stock_fut" || agg.net_qty == 0 {
            continue;
        }
        let Some(base) = agg.base_code.as_deref() else {
            continue;
        };
        futs_by_base.entry(base).or_default().push(agg);
    }

    let mut stock_basis: Vec<StockBasisPair> = Vec::new();
    let mut stock_basis_total_krw = 0.0;
    for (base, futs) in futs_by_base.iter_mut() {
        let Some(&sq) = spot_qty.get(base) else {
            continue; // 대응 현물 없음 → 페어 아님.
        };
        // 만기 오름차순 (마스터 미상은 마지막), 동만기는 코드 순 — 근월 우선 배분.
        futs.sort_by(|a, b| {
            let ea = fut_by_code.get(&a.code).map(|s| s.expiry.as_str()).filter(|e| !e.is_empty()).unwrap_or("99999999");
            let eb = fut_by_code.get(&b.code).map(|s| s.expiry.as_str()).filter(|e| !e.is_empty()).unwrap_or("99999999");
            ea.cmp(eb).then_with(|| a.code.cmp(&b.code))
        });

        let mut spot_remaining = sq; // 부호 有 — 배분마다 0 방향으로 축소.
        for agg in futs.iter() {
            if spot_remaining == 0 {
                break; // 현물 소진 — 잔여 선물 leg는 페어 아님.
            }
            // 반대 부호만 페어 (같은 방향 = 베이시스 포지션 아님).
            if agg.net_qty.signum() == spot_remaining.signum() {
                continue;
            }
            let fq = agg.net_qty;
            let matched = spot_remaining.unsigned_abs().min(fq.unsigned_abs()) as i64;
            if matched == 0 {
                continue;
            }
            let matched_signed = matched * spot_remaining.signum();
            spot_remaining -= matched_signed;

            // 가격: 현물(6자리 또는 A+6), 선물(보유 계약 코드).
            let (spot_price, spot_age) = spot_price_of(base, prices, now_ms);
            let (fut_price, fut_age) = prices
                .get(&agg.code)
                .map(|p| (p.price, age_of(p.updated_at_ms, now_ms)))
                .unwrap_or((0.0, u32::MAX));

            // 만기 — **실보유 계약 코드**(front/back)로 매칭 (M1). 마스터 미상이면 만기 미상:
            // days=0을 D-0으로 오독해 만기 액션 오경보가 나가지 않게 expiry_known=false.
            let sf = fut_by_code.get(&agg.code);
            let expiry_known = sf.map(|s| s.expiry.len() == 8).unwrap_or(false);
            let days = sf
                .filter(|_| expiry_known)
                .map(|s| parse_expiry_days(&s.expiry, today))
                .unwrap_or(0);
            let name = sf
                .map(|s| s.name.clone())
                .filter(|n| !n.is_empty())
                .or_else(|| agg.name.clone())
                .unwrap_or_else(|| base.to_string());

            let matched_notional = matched as f64 * spot_price.max(0.0);

            let mut pair = StockBasisPair {
                base_code: base.to_string(),
                name,
                spot_qty: sq,
                fut_code: agg.code.clone(),
                fut_qty: fq,
                matched_shares: matched,
                matched_signed_shares: matched_signed,
                spot_price,
                fut_price,
                entry_basis: agg.entry_basis,
                basis_now: 0.0,
                basis_theory: 0.0,
                excess_now: 0.0,
                convergence_pnl: None,
                matched_notional_krw: matched_notional,
                days_to_expiry: days,
                expiry_known,
                annualized_bp: 0.0,
                expiry_action_needed: expiry_known && days <= STOCK_EXPIRY_ACTION_DAYS,
                usable: false,
                reason: String::new(),
            };

            if spot_price <= 0.0 {
                pair.reason = "현물 시세 미수신".into();
            } else if fut_price <= 0.0 {
                pair.reason = "주식선물 시세 미수신".into();
            } else if (spot_age.max(fut_age) as u64) > BASIS_STALE_MS {
                // 베이시스는 계산해 보여주되 stale 경고 (라운딩·수렴 판단 신뢰 낮음).
                fill_basis_metrics(&mut pair, base_rate_annual, days);
                pair.usable = false;
                pair.reason = format!("시세 stale ({:.0}s)", spot_age.max(fut_age) as f64 / 1000.0);
            } else {
                fill_basis_metrics(&mut pair, base_rate_annual, days);
                pair.usable = true;
            }

            stock_basis_total_krw += pair.matched_notional_krw;
            stock_basis.push(pair);
        }
    }

    // 안정적 표시 순서 — 명목 큰 페어 우선.
    stock_basis.sort_by(|a, b| {
        b.matched_notional_krw
            .partial_cmp(&a.matched_notional_krw)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let any_expiry_action = stock_basis.iter().any(|p| p.expiry_action_needed)
        || index_basis.iter().any(|e| e.roll_needed);

    BasisBookSnapshot {
        directional_delta_krw,
        index_basis,
        stock_basis,
        stock_basis_total_krw,
        residual_risk_krw,
        any_expiry_action,
        timestamp: now_iso.to_string(),
    }
}

/// basis_now / theory / excess / convergence_pnl / annualized_bp 채움 (가격 유효 전제).
fn fill_basis_metrics(pair: &mut StockBasisPair, base_rate_annual: f64, days: i64) {
    let basis_now = pair.fut_price - pair.spot_price;
    let basis_theory = pair.spot_price * base_rate_annual * (days as f64) / 365.0;
    pair.basis_now = basis_now;
    pair.basis_theory = basis_theory;
    pair.excess_now = basis_now - basis_theory;
    // 수렴 손익: (진입 − 현재) × 부호있는 겹침주수.
    //   현물롱+선물숏(matched_signed>0): 베이시스 축소(현재<진입) → +이익.
    //   현물숏+선물롱(matched_signed<0): 베이시스 확대(현재>진입) → +이익.
    pair.convergence_pnl = pair
        .entry_basis
        .map(|eb| (eb - basis_now) * pair.matched_signed_shares as f64);
    // 연환산 bp: 현재 베이시스가 만기까지 수렴한다고 볼 때의 캐리 수익률.
    pair.annualized_bp = if days > 0 && pair.spot_price > 0.0 {
        basis_now / pair.spot_price * (365.0 / days as f64) * 10_000.0
    } else {
        0.0
    };
}

/// index_family 문자열 → &'static 버킷 키.
fn family_static(f: &str) -> Option<&'static str> {
    match f {
        "k200" => Some("k200"),
        "kq150" => Some("kq150"),
        _ => None,
    }
}

/// ETF 가격 — etf_prices(EtfTick) 우선, 없으면 prices(StockTick 폴백; 내부망 첫 NAV 전).
fn etf_price_of(code: &str, etf_prices: &HashMap<String, f64>, prices: &PriceMap) -> f64 {
    etf_prices
        .get(code)
        .copied()
        .filter(|p| *p > 0.0)
        .or_else(|| prices.get(code).map(|p| p.price).filter(|p| *p > 0.0))
        .unwrap_or(0.0)
}

/// 현물 가격 — 6자리(LS) 또는 A+6(내부망) 키 변형 시도.
fn spot_price_of(base: &str, prices: &PriceMap, now_ms: u64) -> (f64, u32) {
    if let Some(p) = prices.get(base) {
        return (p.price, age_of(p.updated_at_ms, now_ms));
    }
    if let Some(p) = prices.get(&format!("A{base}")) {
        return (p.price, age_of(p.updated_at_ms, now_ms));
    }
    (0.0, u32::MAX)
}

fn age_of(updated_at_ms: u64, now_ms: u64) -> u32 {
    now_ms.saturating_sub(updated_at_ms).min(u32::MAX as u64) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc::PriceWithAge;
    use crate::model::lp::HedgeTicket;

    fn agg(code: &str, instrument: &str, net_qty: i64) -> LedgerAgg {
        LedgerAgg {
            code: code.into(),
            instrument: instrument.into(),
            net_qty,
            base_code: None,
            entry_basis: None,
            name: None,
        }
    }

    fn stock_fut_agg(code: &str, net_qty: i64, base: &str, entry_basis: Option<f64>) -> LedgerAgg {
        LedgerAgg {
            code: code.into(),
            instrument: "stock_fut".into(),
            net_qty,
            base_code: Some(base.into()),
            entry_basis,
            name: Some("삼성전자F".into()),
        }
    }

    fn etf_uni(code: &str, family: &str, leverage: f64) -> QuoteUniverseEtf {
        QuoteUniverseEtf {
            code: code.into(),
            name: Some(code.into()),
            index_family: Some(family.into()),
            leverage: Some(leverage),
            fv_mode: "index".into(),
            beta: None,
            residual_sigma_daily: None,
            index_sigma_daily: None,
            prev_nav: None,
            prev_close: None,
            prev_index_close: None,
            futures_based: false,
        }
    }

    fn idx_state(code: &str, price: f64, now: u64) -> IndexFuturesState {
        IndexFuturesState {
            code: code.into(),
            price,
            underlying_index: price,
            theory_price: None,
            updated_at_ms: now,
        }
    }

    fn ticket(family: &str, net: f64, existing: f64) -> HedgeTicket {
        HedgeTicket {
            family: family.into(),
            net_delta_krw: net,
            existing_futures_delta_krw: existing,
            residual_delta_krw: net + existing,
            ticket: Vec::new(),
            rounding_residual_krw: net + existing,
            futures_price_age_ms: 0,
            usable: true,
            reason: String::new(),
        }
    }

    fn prices(items: &[(&str, f64)], now: u64) -> PriceMap {
        items
            .iter()
            .map(|(c, p)| {
                (
                    c.to_string(),
                    PriceWithAge {
                        price: *p,
                        updated_at_ms: now,
                    },
                )
            })
            .collect()
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 7, 7).unwrap()
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    // ─── 지수 베이시스 매칭 ───

    /// 229200(KQ150 1X) 롱 + KQ150F 숏 → 베이시스 롱, notional·부호 매칭.
    #[test]
    fn index_basis_matches_etf_long_vs_fut_short() {
        let now = now_ms();
        // 229200 1억 롱 (etf_leg = +1억 × L=1). 헤지티켓 existing = KQ150F 숏 −1.2억.
        let aggs = vec![agg("229200", "etf", 10_000)];
        let etf_prices: HashMap<String, f64> = [("229200".to_string(), 10_000.0)].into();
        let universe = vec![etf_uni("229200", "kq150", 1.0)];
        let index = [(
            "kosdaq150".to_string(),
            idx_state("A0669000", 1200.0, now),
        )]
        .into();
        // existing −1.2억 → 매칭 min(1억, 1.2억)=1억, sign(etf)=+ → 베이시스 롱 +1억.
        let tickets = vec![ticket("kq150", 100_000_000.0, -120_000_000.0)];
        let bb = compute_basis_book(
            &aggs, &PriceMap::new(), &etf_prices, &universe, &index,
            &tickets, 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        assert_eq!(bb.index_basis.len(), 1);
        let e = &bb.index_basis[0];
        assert_eq!(e.family, "kq150");
        assert!((e.etf_leg_krw - 100_000_000.0).abs() < 1.0, "etf_leg={}", e.etf_leg_krw);
        assert!((e.fut_leg_krw - (-120_000_000.0)).abs() < 1.0);
        // 매칭 = min(1억, 1.2억) × sign(+) = +1억 (베이시스 롱).
        assert!((e.net_basis_notional_krw - 100_000_000.0).abs() < 1.0, "net={}", e.net_basis_notional_krw);
        // 10bp당 = 1억 × 10bp = 10만.
        assert!((e.sensitivity_per_10bp_krw - 100_000.0).abs() < 1.0, "sens={}", e.sensitivity_per_10bp_krw);
    }

    /// ETF·선물 같은 부호(둘 다 롱) → 베이시스 아님, notional 0.
    #[test]
    fn index_basis_same_sign_no_position() {
        let now = now_ms();
        let aggs = vec![agg("229200", "etf", 10_000)];
        let etf_prices: HashMap<String, f64> = [("229200".to_string(), 10_000.0)].into();
        let universe = vec![etf_uni("229200", "kq150", 1.0)];
        let index = [(
            "kosdaq150".to_string(),
            idx_state("A0669000", 1200.0, now),
        )]
        .into();
        // existing +0.5억 (선물도 롱) → 같은 부호 → notional 0.
        let tickets = vec![ticket("kq150", 100_000_000.0, 50_000_000.0)];
        let bb = compute_basis_book(
            &aggs, &PriceMap::new(), &etf_prices, &universe, &index,
            &tickets, 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let e = &bb.index_basis[0];
        assert_eq!(e.net_basis_notional_krw, 0.0);
        assert_eq!(e.sensitivity_per_10bp_krw, 0.0);
    }

    // ─── 종목 베이시스 페어 인식 + 수렴손익 4방향 ───

    /// 현물 롱 + 주식선물 숏 (매도 대체), 베이시스 축소 → 이익.
    #[test]
    fn stock_basis_long_spot_short_fut_narrowing_profits() {
        let now = now_ms();
        // 현물 70,000, 선물 70,300 → basis_now = 300. 진입 500 → 축소.
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1AA6000", -10_000, "005930", Some(500.0)),
        ];
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 70_300.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        assert_eq!(bb.stock_basis.len(), 1);
        let p = &bb.stock_basis[0];
        assert_eq!(p.matched_shares, 10_000);
        assert_eq!(p.matched_signed_shares, 10_000); // 현물 롱 → +
        assert!((p.basis_now - 300.0).abs() < 1e-6);
        // 수렴손익 = (500 − 300) × +10000 = +200만 (이익).
        assert!((p.convergence_pnl.unwrap() - 2_000_000.0).abs() < 1.0, "pnl={:?}", p.convergence_pnl);
        assert!(p.usable);
    }

    /// 현물 롱 + 선물 숏, 베이시스 확대(현재>진입) → 손실.
    #[test]
    fn stock_basis_long_spot_short_fut_widening_loses() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1AA6000", -10_000, "005930", Some(200.0)),
        ];
        // basis_now = 500 > 진입 200 → 확대.
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 70_500.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let p = &bb.stock_basis[0];
        // (200 − 500) × +10000 = −300만 (손실).
        assert!((p.convergence_pnl.unwrap() - (-3_000_000.0)).abs() < 1.0, "pnl={:?}", p.convergence_pnl);
    }

    /// 현물 숏 + 선물 롱 (매수 대체), 베이시스가 진입보다 더 cheap(심화) → 손실.
    /// (4방향 중 매수 대체의 손실 케이스. 부호규약이 손실도 정확히 잡는지 검산.)
    #[test]
    fn stock_basis_short_spot_long_fut_deepening_loses() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", -10_000),
            stock_fut_agg("A1AA6000", 10_000, "005930", Some(-200.0)),
        ];
        // 진입 −200 (cheap), basis_now = fut−spot = −500 → 더 음수(cheap 심화).
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 69_500.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let p = &bb.stock_basis[0];
        assert_eq!(p.matched_signed_shares, -10_000); // 현물 숏 → −
        assert!((p.basis_now - (-500.0)).abs() < 1e-6);
        // (entry − now) × signed = (−200 − (−500)) × (−10000) = 300 × −10000 = −300만 (손실).
        // 숏spot+롱fut는 basis 확대(더 음수)가 손해 — 부호 정확.
        assert!((p.convergence_pnl.unwrap() - (-3_000_000.0)).abs() < 1.0, "pnl={:?}", p.convergence_pnl);
    }

    /// 현물 숏 + 선물 롱, 베이시스 수렴(−200→0) → 이익 (매수 대체의 정상 수익 경로).
    #[test]
    fn stock_basis_short_spot_long_fut_converging_profits() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", -10_000),
            stock_fut_agg("A1AA6000", 10_000, "005930", Some(-200.0)),
        ];
        // 진입 −200, basis_now = 0 (수렴).
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 70_000.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let p = &bb.stock_basis[0];
        // (−200 − 0) × −10000 = +200만 (이익).
        assert!((p.convergence_pnl.unwrap() - 2_000_000.0).abs() < 1.0, "pnl={:?}", p.convergence_pnl);
    }

    /// 수량 불일치 페어 — 겹침(min)만 페어, 잔여는 안 잡힘.
    #[test]
    fn stock_basis_qty_mismatch_overlaps_only() {
        let now = now_ms();
        // 현물 롱 10,000 vs 선물 숏 6,000 → 겹침 6,000.
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1AA6000", -6_000, "005930", Some(400.0)),
        ];
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 70_300.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let p = &bb.stock_basis[0];
        assert_eq!(p.matched_shares, 6_000);
        assert_eq!(p.matched_signed_shares, 6_000);
        // 명목 = 6000 × 70000 = 4.2억.
        assert!((p.matched_notional_krw - 420_000_000.0).abs() < 1.0);
        // 수렴손익은 겹침 기준: (400 − 300) × 6000 = +60만.
        assert!((p.convergence_pnl.unwrap() - 600_000.0).abs() < 1.0, "pnl={:?}", p.convergence_pnl);
    }

    /// 같은 방향(현물 롱 + 선물 롱) → 페어 아님.
    #[test]
    fn stock_basis_same_direction_not_paired() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1AA6000", 5_000, "005930", None),
        ];
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 70_300.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        assert!(bb.stock_basis.is_empty());
    }

    /// 진입 베이시스 없으면 convergence_pnl None.
    #[test]
    fn stock_basis_no_entry_no_pnl() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1AA6000", -10_000, "005930", None),
        ];
        let px = prices(&[("005930", 70_000.0), ("A1AA6000", 70_300.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        assert!(bb.stock_basis[0].convergence_pnl.is_none());
        assert!(bb.stock_basis[0].usable);
    }

    /// 가격 결측 → usable=false, 사유. matched는 여전히 산출(페어 존재 표시).
    #[test]
    fn stock_basis_missing_price_unusable() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1AA6000", -10_000, "005930", Some(300.0)),
        ];
        // 선물가 없음.
        let px = prices(&[("005930", 70_000.0)], now);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let p = &bb.stock_basis[0];
        assert!(!p.usable);
        assert!(p.reason.contains("주식선물"));
        assert_eq!(p.matched_shares, 10_000);
    }

    /// 방향 델타 = Σ 헤지티켓 residual.
    #[test]
    fn directional_delta_sums_ticket_residuals() {
        let now = now_ms();
        let tickets = vec![
            ticket("k200", 200_000_000.0, -150_000_000.0), // residual +5천만
            ticket("kq150", 100_000_000.0, -100_000_000.0), // residual 0
        ];
        let bb = compute_basis_book(
            &[], &PriceMap::new(), &HashMap::new(), &[], &HashMap::new(),
            &tickets, 12_345.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        assert!((bb.directional_delta_krw - 50_000_000.0).abs() < 1.0, "dir={}", bb.directional_delta_krw);
        assert!((bb.residual_risk_krw - 12_345.0).abs() < 1e-6);
    }

    // ─── H1 다월물 / M1 만기 by-code / M2 선물지수 ETF / 만기 미상 ───

    fn sf_map(items: &[(&str, &str)]) -> HashMap<String, StockFuture> {
        items
            .iter()
            .map(|(code, expiry)| {
                (
                    code.to_string(),
                    StockFuture {
                        base_code: "005930".into(),
                        front_code: code.to_string(),
                        name: format!("{code} F"),
                        expiry: expiry.to_string(),
                        multiplier: 10.0,
                    },
                )
            })
            .collect()
    }

    /// H1: 롤 주간 다월물 — 현물 +10,000 vs 근월 −10,000 + 차월 −6,000.
    /// 근월이 현물 전량 소진 → 차월은 unpaired. matched 합 = 현물 보유량 (이중계상 금지).
    #[test]
    fn multi_month_near_first_no_double_count() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            // aggs 순서를 역만기로 넣어 정렬 검증 (차월 먼저).
            stock_fut_agg("A1168000", -6_000, "005930", Some(600.0)),
            stock_fut_agg("A1167000", -10_000, "005930", Some(400.0)),
        ];
        let px = prices(
            &[("005930", 70_000.0), ("A1167000", 70_300.0), ("A1168000", 70_600.0)],
            now,
        );
        let master = sf_map(&[("A1167000", "20260709"), ("A1168000", "20260813")]);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &master, now, today(), "t",
        );
        assert_eq!(bb.stock_basis.len(), 1, "차월 unpaired여야 함: {:?}",
            bb.stock_basis.iter().map(|p| (&p.fut_code, p.matched_shares)).collect::<Vec<_>>());
        let p = &bb.stock_basis[0];
        assert_eq!(p.fut_code, "A1167000"); // 근월 우선
        assert_eq!(p.matched_shares, 10_000);
        let total: i64 = bb.stock_basis.iter().map(|p| p.matched_shares).sum();
        assert!(total <= 10_000, "matched 합({total}) > 현물 보유량");
        // 명목 = 10,000 × 70,000 = 7억 (이중계상이면 11.2억).
        assert!((bb.stock_basis_total_krw - 700_000_000.0).abs() < 1.0, "total={}", bb.stock_basis_total_krw);
        // M1: 근월 만기 = 20260709 → D-2 → 액션 필요.
        assert!(p.expiry_known);
        assert_eq!(p.days_to_expiry, 2);
        assert!(p.expiry_action_needed);
    }

    /// H1 부분 배분: 현물 +10,000 vs 근월 −6,000 + 차월 −6,000 → 근월 6,000 + 차월 4,000.
    #[test]
    fn multi_month_partial_allocation() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1167000", -6_000, "005930", Some(400.0)),
            stock_fut_agg("A1168000", -6_000, "005930", Some(600.0)),
        ];
        let px = prices(
            &[("005930", 70_000.0), ("A1167000", 70_300.0), ("A1168000", 70_600.0)],
            now,
        );
        let master = sf_map(&[("A1167000", "20260709"), ("A1168000", "20260813")]);
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &master, now, today(), "t",
        );
        assert_eq!(bb.stock_basis.len(), 2);
        let near = bb.stock_basis.iter().find(|p| p.fut_code == "A1167000").unwrap();
        let back = bb.stock_basis.iter().find(|p| p.fut_code == "A1168000").unwrap();
        assert_eq!(near.matched_shares, 6_000);
        assert_eq!(back.matched_shares, 4_000, "차월은 현물 잔량만");
        // M1: 차월 만기는 자기 계약(20260813 → D-37) — 근월 D-2로 오귀속 금지.
        assert!(back.expiry_known);
        assert_eq!(back.days_to_expiry, 37);
        assert!(!back.expiry_action_needed);
        // 수렴손익도 배분 수량 기준: 근월 (400−300)×6,000 = +60만, 차월 (600−600)×4,000 = 0.
        assert!((near.convergence_pnl.unwrap() - 600_000.0).abs() < 1.0);
        assert!((back.convergence_pnl.unwrap() - 0.0).abs() < 1.0);
    }

    /// M2: 선물지수 추종 ETF(252670 등)는 지수 베이시스 etf_leg에서 제외 — 유령 베이시스 금지.
    #[test]
    fn futures_based_etf_excluded_from_index_basis() {
        let now = now_ms();
        // 252670 (K200 −2X, 선물 기반) 2억 롱 + 기존 K200F 롱 existing +4억
        // (인버스 −2X 롱의 헤지는 선물 매수). futures_based 미제외 시 etf_leg −4억 vs
        // fut_leg +4억 → 유령 베이시스 숏 4억.
        let aggs = vec![agg("252670", "etf", 2_600_000)];
        let etf_prices: HashMap<String, f64> = [("252670".to_string(), 76.0)].into();
        let mut u = etf_uni("252670", "k200", -2.0);
        u.futures_based = true;
        let universe = vec![u];
        let index = [("kospi200".to_string(), idx_state("A0169000", 1295.0, now))].into();
        let tickets = vec![ticket("k200", -395_200_000.0, 395_200_000.0)];
        let bb = compute_basis_book(
            &aggs, &PriceMap::new(), &etf_prices, &universe, &index,
            &tickets, 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let k200 = bb.index_basis.iter().find(|e| e.family == "k200").unwrap();
        assert_eq!(k200.etf_leg_krw, 0.0, "선물 기반 ETF가 etf_leg에 들어감 (유령 베이시스)");
        assert_eq!(k200.net_basis_notional_krw, 0.0);
        // 방향 델타(헤지 티켓)는 그대로 — 델타는 실재.
        assert!((bb.directional_delta_krw - 0.0).abs() < 1.0);
    }

    /// 만기 미상 (마스터 miss) — D-0 오독으로 만기 액션 오경보가 나가면 안 됨.
    #[test]
    fn unknown_expiry_no_false_alarm() {
        let now = now_ms();
        let aggs = vec![
            agg("005930", "stock", 10_000),
            stock_fut_agg("A1167000", -10_000, "005930", Some(300.0)),
        ];
        let px = prices(&[("005930", 70_000.0), ("A1167000", 70_300.0)], now);
        // 마스터에 없는 코드 (빈 맵).
        let bb = compute_basis_book(
            &aggs, &px, &HashMap::new(), &[], &HashMap::new(),
            &[], 0.0, 0.028, &HashMap::new(), now, today(), "t",
        );
        let p = &bb.stock_basis[0];
        assert!(!p.expiry_known);
        assert!(!p.expiry_action_needed, "만기 미상인데 액션 오경보");
        assert!(!bb.any_expiry_action);
    }
}
