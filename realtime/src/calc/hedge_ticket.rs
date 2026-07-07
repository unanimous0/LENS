//! 헤지 티켓 (§13.3-B) — 북 순 델타를 지수선물로 0 만드는 데 필요한 상시 계약.
//!
//! 개별 체결별 티켓이 아니라 **북 단위 상시 티켓**. 반대 재고/기존 선물이 넷팅하면
//! residual이 작아져 자연히 "헤지 불필요"가 된다.
//!
//! 델타 분해 규칙 (가족 = KOSPI200 / KOSDAQ150):
//!   - 지수형 ETF: 노출(qty×price) × L → 그 가족 델타. (예: 252670 인버스2X 1억 롱 = K200 −2억)
//!   - 섹터형 ETF: 노출 × β → K200 가족 (risk_estimator KOSPI200 회귀).
//!   - 현물 주식:  노출 × β → K200 가족.
//!   - 원장의 기존 지수선물 포지션: 코드 prefix로 가족·승수 판정 → existing_futures_delta에
//!     합산 (부호 有, 숏이면 음수). residual = net + existing → 이미 헤지된 분이 상쇄됨.
//!   - 주식선물 포지션: base 종목 β로 K200 가족 델타 포함 (Phase 4 M3 — 원장이 주수 단위로
//!     기장하므로 노출 = 주수 × 선물가(폴백 현물가) × β). 미포함 시 델타중립 베이시스 페어
//!     (현물 롱 + 주식선물 숏)의 현물 leg 델타만 잡혀 **중복 지수 헤지 티켓**이 나옴.
//!
//! 계약 환산: 계약 델타 = 선물가 × 승수. K200은 본계약(정수) 라운딩 후 잔차를 미니(1/5)로
//! 추가 라운딩해 라운딩 잔차 최소화. KQ150은 미니 없음(단일 라운딩).
#![allow(dead_code)]

use std::collections::HashMap;

use crate::model::lp::{DeskBook, HedgeLeg, HedgeTicket};

use super::book_risk::RiskParams;
use super::quote_board::{IndexFuturesState, QuoteUniverseEtf, INDEX_FUT_STALE_MS};
use super::PriceMap;

/// KRX 지수선물 거래승수 (원 / 지수포인트).
/// - KOSPI200선물: 250,000 — 2017-03-27 50만→25만 인하. ls_api_full.md t8455(KRX야간파생마스터)
///   A01 계약 `tradeunit`=250000.00 실측 확인.
/// - 미니 KOSPI200선물: 50,000 — 2017-03-27 10만→5만 인하 (KOSPI200의 1/5).
/// - KOSDAQ150선물: 10,000 — KRX 표준 계약명세.
const MULT_KOSPI200: f64 = 250_000.0;
const MULT_MINI_K200: f64 = 50_000.0;
const MULT_KOSDAQ150: f64 = 10_000.0;

/// 지수선물 코드(A + 상품2 + 연1 + 월1 + 000) → (가족, index_futures 맵 키, 승수).
/// 지수선물이 아니면 None (주식선물·주식·ETF 등).
pub(crate) fn classify_index_future(code: &str) -> Option<(&'static str, &'static str, f64)> {
    if code.len() != 8 || !code.starts_with('A') {
        return None;
    }
    match &code[1..3] {
        "01" => Some(("k200", "kospi200", MULT_KOSPI200)),
        "05" => Some(("k200", "mini_k200", MULT_MINI_K200)),
        "06" => Some(("kq150", "kosdaq150", MULT_KOSDAQ150)),
        _ => None,
    }
}

/// index_family 문자열을 &'static 버킷 키로 정규화.
fn family_static(f: &str) -> Option<&'static str> {
    match f {
        "k200" => Some("k200"),
        "kq150" => Some("kq150"),
        _ => None,
    }
}

/// 북의 가족별 헤지 티켓 산출 (pure).
///
/// - `prices`: 주식/주식선물 가격 (나이 有).
/// - `etf_prices`: ETF 현재가 (나이 無 — 지수형/섹터형 노출 산정).
/// - `risk`: 베타/섹터 (섹터 ETF·현물의 K200 베타).
/// - `universe`: 12종 호가 유니버스 메타 (family·leverage·beta·fv_mode).
/// - `index_futures`: product별 지수선물 최신 상태 (front 코드·가격·나이).
/// - `stock_fut_bases`: 주식선물 코드 → base 6자리 (원장 집계 base_code). 주식선물 델타를
///   base β로 가족 분해에 포함 — 델타중립 페어의 중복 헤지 차단 (M3).
#[allow(clippy::too_many_arguments)]
pub fn compute_hedge_tickets(
    book: &DeskBook,
    prices: &PriceMap,
    etf_prices: &HashMap<String, f64>,
    risk: Option<&RiskParams>,
    universe: &[QuoteUniverseEtf],
    index_futures: &HashMap<String, IndexFuturesState>,
    stock_fut_bases: &HashMap<String, String>,
    now_ms: u64,
) -> Vec<HedgeTicket> {
    let uni: HashMap<&str, &QuoteUniverseEtf> =
        universe.iter().map(|e| (e.code.as_str(), e)).collect();

    // 가족 → (재고 델타, 기존 선물 델타)
    let mut fam_net: HashMap<&'static str, f64> = HashMap::new();
    let mut fam_fut: HashMap<&'static str, f64> = HashMap::new();
    // 기존 지수선물 valuation 실패 가족 → 문제 코드. existing이 과소되면 이미 헤지된 북에
    // **중복 헤지 티켓**이 나오므로, 조용히 skip하지 않고 해당 가족 티켓을 unusable로 강등.
    let mut fam_broken: HashMap<&'static str, String> = HashMap::new();

    for (code, &qty) in &book.positions {
        if qty == 0 {
            continue;
        }
        // 1) 원장의 기존 지수선물 포지션 → 그 가족의 현재 front state 가격으로 valuation.
        //    티켓 leg와 동일한 신선도 기준(fresh_state, INDEX_FUT_STALE_MS) 적용 — 비대칭 제거.
        if let Some((family, product, mult)) = classify_index_future(code) {
            match fresh_state(index_futures, product, now_ms) {
                Some((state, _)) => {
                    *fam_fut.entry(family).or_insert(0.0) += qty as f64 * state.price * mult;
                }
                None => {
                    fam_broken.entry(family).or_insert_with(|| code.clone());
                }
            }
            continue;
        }
        // 1.5) 주식선물 → base 종목 β로 K200 가족 델타 (M3 — 원장 주수 단위 기장).
        //      가격은 선물가 우선, 미수신이면 현물가 폴백 (베이시스 수백원 차이 ≪ 델타 오차 허용).
        //      base β 미상이면 기존과 동일하게 분해 제외 (unmapped — book_risk에 표시됨).
        if let Some(base) = stock_fut_bases.get(code) {
            if let Some(r) = risk {
                if let Some(&b) = r.betas.get(base) {
                    let price = prices
                        .get(code)
                        .map(|p| p.price)
                        .filter(|p| *p > 0.0)
                        .or_else(|| prices.get(base).map(|p| p.price).filter(|p| *p > 0.0))
                        .or_else(|| {
                            prices
                                .get(&format!("A{base}"))
                                .map(|p| p.price)
                                .filter(|p| *p > 0.0)
                        })
                        .unwrap_or(0.0);
                    if price > 0.0 {
                        *fam_net.entry("k200").or_insert(0.0) += qty as f64 * price * b;
                    }
                }
            }
            continue;
        }
        // 2) 호가 유니버스 ETF (지수형·섹터형).
        //    가격은 etf_prices(EtfTick) 우선, 없으면 prices(StockTick) 폴백 — 내부망 피드는
        //    첫 NAV 수신 전 ETF를 StockTick으로 송신(feed/internal.rs)해서 etf_prices만 보면
        //    그 구간 델타가 소리 없이 0 → 과소 헤지. (scheduler.rs etf_price_age와 동일 폴백.)
        if let Some(etf) = uni.get(code.as_str()) {
            let price = etf_prices
                .get(code)
                .copied()
                .filter(|p| *p > 0.0)
                .or_else(|| prices.get(code).map(|p| p.price).filter(|p| *p > 0.0))
                .unwrap_or(0.0);
            if price <= 0.0 {
                continue;
            }
            let exposure = qty as f64 * price;
            match etf.fv_mode.as_str() {
                "index" => {
                    if let Some(fam) = family_static(etf.index_family.as_deref().unwrap_or("")) {
                        let l = etf.leverage.unwrap_or(0.0);
                        *fam_net.entry(fam).or_insert(0.0) += exposure * l;
                    }
                }
                "beta" => {
                    // 섹터형 → K200 베타 경유 (유니버스 β 우선, 없으면 risk-params β).
                    let b = etf
                        .beta
                        .or_else(|| risk.and_then(|r| r.betas.get(code).copied()))
                        .unwrap_or(0.0);
                    *fam_net.entry("k200").or_insert(0.0) += exposure * b;
                }
                _ => {}
            }
            continue;
        }
        // 3) 현물 주식 (risk.betas 매핑) → K200 베타 경유
        if let Some(r) = risk {
            if let Some(&b) = r.betas.get(code) {
                let price = prices.get(code).map(|p| p.price).unwrap_or(0.0);
                if price > 0.0 {
                    *fam_net.entry("k200").or_insert(0.0) += qty as f64 * price * b;
                }
            }
        }
        // 4) 미매핑 (base 미상 주식선물 포함) — 델타 분해 제외 (book_risk unmapped에 표시).
    }

    let mut tickets = Vec::new();
    for &family in &["k200", "kq150"] {
        let net = fam_net.get(family).copied().unwrap_or(0.0);
        let fut = fam_fut.get(family).copied().unwrap_or(0.0);
        let broken = fam_broken.get(family);
        if net == 0.0 && fut == 0.0 && broken.is_none() {
            continue;
        }
        let mut t = build_ticket(family, net, fut, index_futures, now_ms);
        // 기존 선물 valuation 실패 → existing 과소 = residual 부풀림 → 중복 헤지 위험.
        // 조용히 틀리느니 명시적으로 죽인다: 티켓 강등 (분해 수치는 참고용으로 유지).
        if let Some(code) = broken {
            t.usable = false;
            t.ticket.clear();
            t.reason = format!("기존 선물 포지션 평가 불가: {code} 시세 없음/stale");
        }
        tickets.push(t);
    }
    tickets
}

/// product state가 신선(가격>0 + 나이≤STALE)하면 (state, age_ms) 반환.
fn fresh_state<'a>(
    index_futures: &'a HashMap<String, IndexFuturesState>,
    product: &str,
    now_ms: u64,
) -> Option<(&'a IndexFuturesState, u32)> {
    index_futures.get(product).and_then(|s| {
        if s.price <= 0.0 {
            return None;
        }
        let age = now_ms.saturating_sub(s.updated_at_ms).min(u32::MAX as u64) as u32;
        if (age as u64) > INDEX_FUT_STALE_MS {
            None
        } else {
            Some((s, age))
        }
    })
}

/// stale/미수신 시 표시용 나이 (없으면 u32::MAX).
fn stale_age(index_futures: &HashMap<String, IndexFuturesState>, product: &str, now_ms: u64) -> u32 {
    index_futures
        .get(product)
        .map(|s| now_ms.saturating_sub(s.updated_at_ms).min(u32::MAX as u64) as u32)
        .unwrap_or(u32::MAX)
}

fn build_ticket(
    family: &str,
    net_delta_krw: f64,
    existing_futures_delta_krw: f64,
    index_futures: &HashMap<String, IndexFuturesState>,
    now_ms: u64,
) -> HedgeTicket {
    let residual = net_delta_krw + existing_futures_delta_krw;
    let mut t = HedgeTicket {
        family: family.to_string(),
        net_delta_krw,
        existing_futures_delta_krw,
        residual_delta_krw: residual,
        ticket: Vec::new(),
        rounding_residual_krw: residual,
        futures_price_age_ms: u32::MAX,
        usable: false,
        reason: String::new(),
    };

    // 티켓이 추가해야 하는 델타 = -residual (잔여를 0으로).
    let target = -residual;

    match family {
        "k200" => {
            let full = fresh_state(index_futures, "kospi200", now_ms);
            let mini = fresh_state(index_futures, "mini_k200", now_ms);
            match (full, mini) {
                (Some((fs, fage)), mopt) => {
                    let full_delta = fs.price * MULT_KOSPI200;
                    let mini_delta = mopt.map(|(ms, _)| ms.price * MULT_MINI_K200);
                    let (n_full, n_mini, ticket_delta) =
                        round_full_mini(target, full_delta, mini_delta);
                    push_leg(&mut t.ticket, &fs.code, "KOSPI200 선물", n_full);
                    if let Some((ms, _)) = mopt {
                        push_leg(&mut t.ticket, &ms.code, "KOSPI200 미니선물", n_mini);
                    }
                    t.rounding_residual_krw = residual + ticket_delta;
                    t.futures_price_age_ms = fage.max(mopt.map(|(_, a)| a).unwrap_or(0));
                    t.usable = true;
                }
                (None, Some((ms, mage))) => {
                    // 본계약 미수신 → 미니로만 (nearest) 라운딩.
                    let mini_delta = ms.price * MULT_MINI_K200;
                    let (n_mini, _, ticket_delta) = round_full_mini(target, mini_delta, None);
                    push_leg(&mut t.ticket, &ms.code, "KOSPI200 미니선물", n_mini);
                    t.rounding_residual_krw = residual + ticket_delta;
                    t.futures_price_age_ms = mage;
                    t.usable = true;
                }
                (None, None) => {
                    t.reason = "지수선물 미수신/stale (K200)".into();
                    t.futures_price_age_ms = stale_age(index_futures, "kospi200", now_ms);
                }
            }
        }
        "kq150" => match fresh_state(index_futures, "kosdaq150", now_ms) {
            Some((s, age)) => {
                let contract_delta = s.price * MULT_KOSDAQ150;
                let (n, _, ticket_delta) = round_full_mini(target, contract_delta, None);
                push_leg(&mut t.ticket, &s.code, "KOSDAQ150 선물", n);
                t.rounding_residual_krw = residual + ticket_delta;
                t.futures_price_age_ms = age;
                t.usable = true;
            }
            None => {
                t.reason = "지수선물 미수신/stale (KQ150)".into();
                t.futures_price_age_ms = stale_age(index_futures, "kosdaq150", now_ms);
            }
        },
        _ => {
            t.reason = format!("알 수 없는 가족: {family}");
        }
    }

    t
}

/// 본계약 + 미니 2단계 라운딩.
///
/// - `target_delta`: 티켓이 추가할 델타 (원). = −residual.
/// - `full_delta`: 본계약 1계약(매수) 델타 (원, 양수).
/// - `mini_delta`: 미니 1계약 델타 (원, 양수). None이면 단일 라운딩(nearest).
///
/// 반환 `(n_full, n_mini, ticket_delta)` — ticket_delta = n_full·full + n_mini·mini (실제 추가 델타).
/// 미니 有: 본계약은 toward-zero(trunc) → 잔차를 미니로 nearest. 미니 無: 본계약 nearest.
fn round_full_mini(target_delta: f64, full_delta: f64, mini_delta: Option<f64>) -> (i64, i64, f64) {
    if !(full_delta > 0.0) {
        return (0, 0, 0.0);
    }
    match mini_delta {
        Some(md) if md > 0.0 => {
            let n_full = (target_delta / full_delta).trunc() as i64;
            let rem = target_delta - n_full as f64 * full_delta;
            let n_mini = (rem / md).round() as i64;
            let ticket_delta = n_full as f64 * full_delta + n_mini as f64 * md;
            (n_full, n_mini, ticket_delta)
        }
        _ => {
            let n_full = (target_delta / full_delta).round() as i64;
            (n_full, 0, n_full as f64 * full_delta)
        }
    }
}

/// n(부호 有)을 leg로 추가. n==0이면 no-op (헤지 불필요 leg 생략).
fn push_leg(legs: &mut Vec<HedgeLeg>, code: &str, name: &str, n: i64) {
    if n == 0 {
        return;
    }
    legs.push(HedgeLeg {
        code: code.to_string(),
        name: name.to_string(),
        side: if n > 0 { "buy" } else { "sell" }.to_string(),
        contracts: n.abs(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calc::PriceWithAge;

    fn etf(code: &str, family: &str, leverage: Option<f64>, fv_mode: &str, beta: Option<f64>) -> QuoteUniverseEtf {
        QuoteUniverseEtf {
            code: code.into(),
            name: Some(code.into()),
            index_family: Some(family.into()),
            leverage,
            fv_mode: fv_mode.into(),
            beta,
            residual_sigma_daily: None,
            index_sigma_daily: None,
            prev_nav: None,
            prev_close: None,
            prev_index_close: None,
            futures_based: false,
        }
    }

    fn fut(code: &str, price: f64, now: u64) -> IndexFuturesState {
        IndexFuturesState {
            code: code.into(),
            price,
            underlying_index: price,
            theory_price: None,
            updated_at_ms: now,
        }
    }

    fn book(items: &[(&str, i64)]) -> DeskBook {
        DeskBook {
            positions: items.iter().map(|(c, q)| (c.to_string(), *q)).collect(),
            updated_at: "t".into(),
        }
    }

    fn idx(now: u64, items: &[(&str, &str, f64)]) -> HashMap<String, IndexFuturesState> {
        items
            .iter()
            .map(|(prod, code, px)| (prod.to_string(), fut(code, *px, now)))
            .collect()
    }

    fn find<'a>(ts: &'a [HedgeTicket], fam: &str) -> &'a HedgeTicket {
        ts.iter().find(|t| t.family == fam).expect("family present")
    }

    /// 가족 분해: 인버스2X(K200 L=−2) 롱 + KQ150(L=+1) 롱 → K200 −2배, KQ150 +1배.
    #[test]
    fn family_decomposition_and_inverse_sign() {
        let now = 1_000_000u64;
        let universe = vec![
            etf("252670", "k200", Some(-2.0), "index", None), // 인버스2X
            etf("229200", "kq150", Some(1.0), "index", None), // KQ150 1X
        ];
        // 각 1억 롱: 252670 price 5,000 × 20,000주 = 1억; 229200 price 10,000 × 10,000주 = 1억.
        let etf_prices: HashMap<String, f64> =
            [("252670".to_string(), 5_000.0), ("229200".to_string(), 10_000.0)].into();
        let b = book(&[("252670", 20_000), ("229200", 10_000)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0), ("kosdaq150", "A0666000", 1200.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);

        let k200 = find(&ts, "k200");
        // 1억 × (−2) = −2억.
        assert!((k200.net_delta_krw - (-200_000_000.0)).abs() < 1.0, "k200 net={}", k200.net_delta_krw);
        assert_eq!(k200.existing_futures_delta_krw, 0.0);
        let kq = find(&ts, "kq150");
        assert!((kq.net_delta_krw - 100_000_000.0).abs() < 1.0, "kq net={}", kq.net_delta_krw);
    }

    /// 롱 재고(양의 델타) → 선물 매도 티켓. 미니 라운딩으로 잔차 0.
    #[test]
    fn long_inventory_sells_full_plus_mini_zero_residual() {
        let now = 1_000_000u64;
        let universe = vec![etf("069500", "k200", Some(1.0), "index", None)];
        // 노출 2,800주 × 100,000 = 2.8억 = 3.2 본계약(본계약 델타 = 350×250000 = 8,750만).
        let etf_prices: HashMap<String, f64> = [("069500".to_string(), 100_000.0)].into();
        let b = book(&[("069500", 2_800)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0), ("mini_k200", "A0566000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        assert!((k200.net_delta_krw - 280_000_000.0).abs() < 1.0);
        // 본계약 매도 3 + 미니 매도 1 (0.2본계약 = 미니 1). 잔차 0.
        assert_eq!(k200.ticket.len(), 2);
        assert_eq!(k200.ticket[0].name, "KOSPI200 선물");
        assert_eq!(k200.ticket[0].side, "sell");
        assert_eq!(k200.ticket[0].contracts, 3);
        assert_eq!(k200.ticket[1].name, "KOSPI200 미니선물");
        assert_eq!(k200.ticket[1].side, "sell");
        assert_eq!(k200.ticket[1].contracts, 1);
        assert!(k200.rounding_residual_krw.abs() < 1.0, "residual={}", k200.rounding_residual_krw);
        assert!(k200.usable);
    }

    /// 기존 선물 포지션 차감 → residual 상쇄 → 헤지 불필요(넷팅).
    #[test]
    fn existing_futures_net_to_zero() {
        let now = 1_000_000u64;
        let universe = vec![etf("069500", "k200", Some(1.0), "index", None)];
        let etf_prices: HashMap<String, f64> = [("069500".to_string(), 100_000.0)].into();
        // 069500 롱 2.8억(+280M) + 본계약 숏 3(−262.5M) + 미니 숏 1(−17.5M) = 정확히 0.
        let b = book(&[("069500", 2_800), ("A0166000", -3), ("A0566000", -1)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0), ("mini_k200", "A0566000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        assert!((k200.existing_futures_delta_krw - (-280_000_000.0)).abs() < 1.0, "exist={}", k200.existing_futures_delta_krw);
        assert!(k200.residual_delta_krw.abs() < 1.0, "residual={}", k200.residual_delta_krw);
        assert!(k200.ticket.is_empty(), "헤지 불필요여야 함: {:?}", k200.ticket);
        assert!(k200.usable);
    }

    /// 숏 재고(음의 델타) → 선물 매수 티켓 (매도의 대칭).
    #[test]
    fn short_inventory_buys_futures() {
        let now = 1_000_000u64;
        let universe = vec![etf("229200", "kq150", Some(1.0), "index", None)];
        let etf_prices: HashMap<String, f64> = [("229200".to_string(), 10_000.0)].into();
        // KQ150 1X 숏 → 음의 델타. 노출 −1억. 계약 델타 = 1200×10000 = 1,200만. −1억/1200만 ≈ −8.33.
        let b = book(&[("229200", -10_000)]);
        let index = idx(now, &[("kosdaq150", "A0666000", 1200.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let kq = find(&ts, "kq150");
        assert!((kq.net_delta_krw - (-100_000_000.0)).abs() < 1.0);
        // target = +1억 → 매수. round(1억/1200만)=round(8.33)=8.
        assert_eq!(kq.ticket.len(), 1);
        assert_eq!(kq.ticket[0].side, "buy");
        assert_eq!(kq.ticket[0].contracts, 8);
        // 잔차 = residual + 8×1200만 = −1억 + 9600만 = −400만.
        assert!((kq.rounding_residual_krw - (-4_000_000.0)).abs() < 1.0, "res={}", kq.rounding_residual_krw);
    }

    /// 섹터형 ETF → K200 베타 경유.
    #[test]
    fn sector_etf_routes_via_k200_beta() {
        let now = 1_000_000u64;
        let universe = vec![etf("396500", "k200", None, "beta", Some(1.25))];
        let etf_prices: HashMap<String, f64> = [("396500".to_string(), 50_000.0)].into();
        // 노출 2,000주 × 50,000 = 1억. β1.25 → K200 델타 1.25억.
        let b = book(&[("396500", 2_000)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        assert!((k200.net_delta_krw - 125_000_000.0).abs() < 1.0, "net={}", k200.net_delta_krw);
    }

    /// M1: ETF 가격이 etf_prices에 없고 prices(StockTick 경로)에만 있어도 델타 산출.
    /// (내부망 피드는 첫 NAV 수신 전 ETF를 StockTick으로 송신 — 폴백 없으면 소리 없이 0.)
    #[test]
    fn etf_price_falls_back_to_stock_tick_prices() {
        let now = 1_000_000u64;
        let universe = vec![etf("069500", "k200", Some(1.0), "index", None)];
        let etf_prices: HashMap<String, f64> = HashMap::new(); // EtfTick 미수신
        let prices: crate::calc::PriceMap =
            [("069500".to_string(), PriceWithAge { price: 100_000.0, updated_at_ms: now })].into();
        let b = book(&[("069500", 2_800)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0), ("mini_k200", "A0566000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &prices, &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        // StockTick 경로 가격으로 2.8억 델타 → 매도 3+미니 1 (기존 테스트와 동일 결과).
        assert!((k200.net_delta_krw - 280_000_000.0).abs() < 1.0, "net={}", k200.net_delta_krw);
        assert_eq!(k200.ticket.len(), 2);
        assert!(k200.usable);
    }

    /// M2: 원장의 기존 지수선물 valuation 불가(state 부재) → 해당 가족 티켓 unusable
    /// (existing 과소 → 중복 헤지 방지). 다른 가족은 영향 없음.
    #[test]
    fn broken_existing_futures_valuation_degrades_family() {
        let now = 1_000_000u64;
        let universe = vec![
            etf("069500", "k200", Some(1.0), "index", None),
            etf("229200", "kq150", Some(1.0), "index", None),
        ];
        let etf_prices: HashMap<String, f64> =
            [("069500".to_string(), 100_000.0), ("229200".to_string(), 10_000.0)].into();
        // K200: ETF 롱 + 기존 미니 숏 — 그런데 mini_k200 state 부재 → valuation 불가.
        let b = book(&[("069500", 2_800), ("A0566000", -4), ("229200", 10_000)]);
        // kospi200/kosdaq150은 신선, mini_k200은 미수신.
        let index = idx(now, &[("kospi200", "A0166000", 350.0), ("kosdaq150", "A0666000", 1200.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        assert!(!k200.usable, "existing 평가 불가면 unusable이어야 함");
        assert!(k200.ticket.is_empty(), "강등 시 티켓 leg 없음: {:?}", k200.ticket);
        assert!(k200.reason.contains("A0566000"), "reason={}", k200.reason);
        // KQ150은 정상 산출 (매도 10, 손계산 154.7M/14.91M≈10.4→10... 여기선 1억/12M≈8.3→8).
        let kq = find(&ts, "kq150");
        assert!(kq.usable);
        assert_eq!(kq.ticket.len(), 1);
    }

    /// M2 보강: 기존 선물 valuation에도 티켓 leg와 동일한 staleness 기준 적용.
    #[test]
    fn stale_existing_futures_valuation_also_degrades() {
        let now = 1_000_000u64 + INDEX_FUT_STALE_MS + 5_000;
        let universe = vec![etf("069500", "k200", Some(1.0), "index", None)];
        let etf_prices: HashMap<String, f64> = [("069500".to_string(), 100_000.0)].into();
        let b = book(&[("069500", 2_800), ("A0166000", -3)]);
        // kospi200 state는 오래됨(1_000_000) — leg도 valuation도 stale.
        let index = idx(1_000_000, &[("kospi200", "A0166000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        assert!(!k200.usable);
        assert!(k200.reason.contains("A0166000"), "reason={}", k200.reason);
    }

    /// 지수선물 stale → usable=false + 사유.
    #[test]
    fn stale_futures_unusable() {
        let now = 1_000_000u64 + INDEX_FUT_STALE_MS + 5_000;
        let universe = vec![etf("069500", "k200", Some(1.0), "index", None)];
        let etf_prices: HashMap<String, f64> = [("069500".to_string(), 100_000.0)].into();
        let b = book(&[("069500", 2_800)]);
        // state는 1_000_000 시점 (오래됨).
        let index = idx(1_000_000, &[("kospi200", "A0166000", 350.0), ("mini_k200", "A0566000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &HashMap::new(), &etf_prices, None, &universe, &index, &HashMap::new(), now);
        let k200 = find(&ts, "k200");
        assert!(!k200.usable);
        assert!(k200.ticket.is_empty());
        assert!(k200.reason.contains("stale") || k200.reason.contains("미수신"));
    }

    fn risk_with_beta(code: &str, beta: f64) -> RiskParams {
        use super::super::book_risk::{CoverageInfo, ResidualCovariance};
        RiskParams {
            as_of: None,
            market_code: "K2G01P".into(),
            window_days: 60,
            betas: [(code.to_string(), beta)].into(),
            residual_sigmas_daily: HashMap::new(),
            residual_covariance: ResidualCovariance { codes: vec![], matrix: vec![] },
            sector_map: HashMap::new(),
            shrinkage_intensity: 0.3,
            coverage: CoverageInfo { target_stocks: 1, fit_ok: 1, fit_failed: 0, failed_codes_sample: vec![] },
        }
    }

    /// M3: 델타중립 종목 베이시스 페어 (현물 롱 + 주식선물 숏, 주수 동일) → 가족 델타가
    /// 베이시스분(수백만)만 남아 티켓 0계약 = 중복 지수 헤지 차단. 4층 분해 ① 가산성의 핵심.
    #[test]
    fn stock_futures_delta_nets_spot_in_family() {
        let now = 1_000_000u64;
        let risk = risk_with_beta("005930", 1.1);
        let prices: crate::calc::PriceMap = [
            ("005930".to_string(), PriceWithAge { price: 70_000.0, updated_at_ms: now }),
            ("A1167000".to_string(), PriceWithAge { price: 70_300.0, updated_at_ms: now }),
        ]
        .into();
        let sf_bases: HashMap<String, String> = [("A1167000".to_string(), "005930".to_string())].into();
        let b = book(&[("005930", 10_000), ("A1167000", -10_000)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0), ("mini_k200", "A0566000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &prices, &HashMap::new(), Some(&risk), &[], &index, &sf_bases, now);
        let k200 = find(&ts, "k200");
        // net = 1.1 × 10,000 × (70,000 − 70,300) = −330만 (베이시스분만 잔존).
        assert!((k200.net_delta_krw - (-3_300_000.0)).abs() < 1.0, "net={}", k200.net_delta_krw);
        // 본계약 8,750만·미니 1,750만 → 330만은 0계약 라운딩 = 헤지 불필요.
        assert!(k200.ticket.is_empty(), "델타중립 페어에 중복 헤지 티켓: {:?}", k200.ticket);
        assert!(k200.usable);
    }

    /// M3 폴백: 주식선물가 미수신 → 현물가 폴백 → 정확히 0 넷팅.
    #[test]
    fn stock_futures_price_falls_back_to_spot() {
        let now = 1_000_000u64;
        let risk = risk_with_beta("005930", 1.1);
        let prices: crate::calc::PriceMap = [
            ("005930".to_string(), PriceWithAge { price: 70_000.0, updated_at_ms: now }),
            // A1167000 시세 없음 — 현물가로 valuation.
        ]
        .into();
        let sf_bases: HashMap<String, String> = [("A1167000".to_string(), "005930".to_string())].into();
        let b = book(&[("005930", 10_000), ("A1167000", -10_000)]);
        let index = idx(now, &[("kospi200", "A0166000", 350.0)]);
        let ts = compute_hedge_tickets(&b, &prices, &HashMap::new(), Some(&risk), &[], &index, &sf_bases, now);
        // 정확히 0 → k200 티켓 자체가 생성 안 됨 (net==0 && fut==0).
        assert!(
            ts.iter().all(|t| t.family != "k200" || t.net_delta_krw.abs() < 1.0),
            "폴백 넷팅 실패: {:?}",
            ts.iter().map(|t| (t.family.clone(), t.net_delta_krw)).collect::<Vec<_>>()
        );
    }
}
