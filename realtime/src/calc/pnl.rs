//! P&L 5분해 + markout 역선택 통계 + 리스크 한도 게이지 (§13.3-C Phase 4 PR-E).
//!
//! 4대 숫자 #4(손익 분해) 스텁을 처음 채우는 모듈. 당일 세션 기준(전일 종가 대비)으로
//! 북 전체 MTM을 5개 항으로 분해:
//!   - **스프레드**   Σ (fv_at_fill − fill_price) × signed_qty  (당일 fill, ETF 유니버스만 귀속)
//!   - **베이시스**   basis_book 종목 수렴손익 합 (지수는 당일 변화 미기록 → 산출 불가, 정직)
//!   - **캐리**       −r × Σ(현물성 부호 노출) × (당일 경과일/365) — 선물 제외 (M1)
//!   - **헤지 비용**  −Σ 당일 선물 fill 명목 × futures_fee_bp
//!   - **잔차/방향**  total_mtm − 위 4항  (residual attribution — 완전 분해 항등 보장)
//!
//! **total_mtm = 포지션 평가 항 + 당일 fill 현금흐름 항** (C1):
//!   포지션 항  Σ qty_now × (price_now − baseline) × mult
//!   fill 항    Σ −signed_qty × (fill_price − baseline) × mult
//! 두 항이 코드당 **동일한 baseline**(prev_close 맵: 유니버스 EOD 또는 day_open 폴백)을
//! 쓰므로 왕복·신규진입에서 baseline이 정확히 소거되고 실현손익은 체결가 기준으로 남는다.
//! (왕복 매수 1,000@136,000→매도@137,000 = 정확히 +100만, 당일 신규 = 진입가 대비 MTM.)
//!
//! markout: fill 후 5분/30분 시점 (가격변화 × 방향 부호). 음수 = 역선택. 마크 산출·POST는
//! scheduler(poll 기반)가 담당, 여기선 이미 기록된 마크로 통계만 낸다.
//!
//! 모든 계산은 pure — 호출자(scheduler)가 가격/전일종가/집계를 스냅샷으로 주입.
#![allow(dead_code)]

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::model::lp::{
    BasisBookSnapshot, BookRiskSnapshot, DeskBook, LimitGauge, MarkoutStats, PnlDecompSnapshot,
    Unattributed,
};

use super::hedge_ticket::classify_index_future;
use super::quote_board::QuoteParams;
use super::{FillMark, LedgerEntry};

/// side → 부호있는 수량 (buy=+, sell=−).
fn signed(side: &str, qty: i64) -> i64 {
    if side == "buy" {
        qty
    } else {
        -qty
    }
}

/// 코드 → 지수선물 승수 (지수선물이면 250k/50k/10k, 아니면 1). MTM·명목 환산용.
fn mult_of(code: &str) -> f64 {
    classify_index_future(code)
        .map(|(_, _, m)| m)
        .unwrap_or(1.0)
}

/// 선물성 상품 판정 — 캐리 제외 대상 (M1). 원장 instrument 우선, 미상이면 8자리
/// A-prefix(선물 관행 코드)로 보수 판정. 선물은 증거금 상품이라 자금 점유 ≈ 0
/// (캐리는 베이시스 가격에 내재) → 명목 전액 비용화하면 델타중립 북에 유령 캐리.
fn is_futures_like(code: &str, instruments: &HashMap<String, String>) -> bool {
    match instruments.get(code).map(|s| s.as_str()) {
        Some("index_fut") | Some("stock_fut") => true,
        Some(_) => false,
        None => code.len() == 8 && code.starts_with('A'),
    }
}

/// markout (bp) = (mark_price − fill_price) / fill_price × sign(signed_qty) × 10,000.
/// 음수 = 역선택 (매수 후 하락 / 매도 후 상승 — LP가 준 유동성 방향으로 시장 불리).
pub fn markout_bp(fill_price: f64, mark_price: f64, signed_qty: i64) -> f64 {
    if fill_price <= 0.0 || signed_qty == 0 {
        return 0.0;
    }
    let sign = if signed_qty > 0 { 1.0 } else { -1.0 };
    (mark_price - fill_price) / fill_price * sign * 10_000.0
}

/// limit>0이면 current/limit, 아니면 0.
fn ratio(current: f64, limit: f64) -> f64 {
    if limit > 0.0 {
        current / limit
    } else {
        0.0
    }
}

/// P&L 5분해 + markout + 한도 4개 산출 (pure).
///
/// - `entries`: 원장 전체 엔트리 (당일 fill은 ts prefix로 필터).
/// - `marks`: 당일 fill 마크 (markout 통계 소스).
/// - `book`: 순 포지션 (code → 부호있는 qty).
/// - `cur_price`: 포지션별 현재가 (ETF/현물/지수선물 코드 모두, scheduler가 통합 스냅샷).
/// - `prev_close`: 코드 → (전일종가, is_fallback). 유니버스 ETF는 real EOD, 그 외는 당일
///   첫 관측가 폴백(is_fallback=true). 포지션 MTM과 fill 현금흐름 **양쪽의 단일 기준가**
///   (불일치하면 폴백 종목의 왕복 소거가 깨짐 — C1). 없으면 해당 항 제외 + caveat.
/// - `etf_notionals`: 유니버스 ETF 코드 → 현재 |명목| (재고 한도 게이지용).
/// - `instruments`: 코드 → 원장 instrument (캐리 선물 제외 판정 — M1).
/// - `basis`: 베이시스 북 (종목 수렴손익·지수/종목 명목·방향 델타).
/// - `book_risk`: #2 델타·#3 잔차 (한도 게이지용).
/// - `day_open_suspect`: 장중 재시작 감지 — day_open이 재시작 후 첫 관측가라 폴백 MTM 왜곡
///   가능성 caveat (폴백 사용 시에만 표기).
#[allow(clippy::too_many_arguments)]
pub fn compute_pnl(
    entries: &[LedgerEntry],
    marks: &[FillMark],
    today: NaiveDate,
    book: &DeskBook,
    cur_price: &HashMap<String, f64>,
    prev_close: &HashMap<String, (f64, bool)>,
    etf_notionals: &HashMap<String, f64>,
    instruments: &HashMap<String, String>,
    basis: &BasisBookSnapshot,
    book_risk: &BookRiskSnapshot,
    params: &QuoteParams,
    base_rate_annual: f64,
    day_fraction: f64,
    day_open_suspect: bool,
    now_iso: &str,
) -> PnlDecompSnapshot {
    let today_prefix = today.format("%Y-%m-%d").to_string();
    let is_today_fill = |e: &LedgerEntry| -> bool {
        e.kind == "fill" && e.ts.get(0..10) == Some(today_prefix.as_str())
    };

    // ── 스프레드 + 미귀속 ──
    let mut spread = 0.0;
    let mut un_n = 0i64;
    let mut un_notional = 0.0;
    for e in entries.iter().filter(|e| is_today_fill(e)) {
        let sq = signed(&e.side, e.qty);
        match (e.fv_at_fill, e.price) {
            (Some(fv), Some(px)) if px > 0.0 => {
                // 매수(sq>0): FV보다 싸게 사면 (fv−px)>0 → +. 매도(sq<0): FV보다 비싸게 팔면
                // (fv−px)<0 ×(음수 qty) → +. 4방향 부호 일관.
                spread += (fv - px) * sq as f64;
            }
            _ => {
                un_n += 1;
                un_notional += (e.price.unwrap_or(0.0) * e.qty as f64).abs();
            }
        }
    }

    // ── 베이시스 (종목만) ──
    let basis_stock: f64 = basis
        .stock_basis
        .iter()
        .filter_map(|p| p.convergence_pnl)
        .sum();
    let has_index_basis = basis
        .index_basis
        .iter()
        .any(|e| e.net_basis_notional_krw != 0.0);
    let basis_index_status = if has_index_basis {
        "지수 베이시스 노출 있음 — 당일 손익 산출 불가 (베이시스 변화 미기록)".to_string()
    } else {
        "지수 베이시스 노출 없음".to_string()
    };

    // ── 총 MTM (전일 종가 대비) = 포지션 평가 항 + 당일 fill 현금흐름 항 (C1) ──
    // baseline 조회는 이 클로저 하나로 통일 — 포지션 항과 fill 항이 코드당 같은 기준가를
    // 써야 왕복(포지션 0)·신규진입에서 baseline이 정확히 소거된다 (불일치 시 폴백 종목에서
    // 실현손익이 다시 틀어짐).
    let baseline_of = |code: &str| -> Option<(f64, bool)> { prev_close.get(code).copied() };

    let mut total_mtm = 0.0;
    // 캐리 대상 노출 (M1): 현물·ETF만, **부호 유지** — 롱 = 자금 비용(−), 숏 = 매도대금
    // 운용 이익(+) (§9.2 net_fv_sell carry_income 정본과 정합). 선물은 is_futures_like 제외.
    let mut spot_net_exposure = 0.0;
    let mut fallback_n = 0i64;
    let mut excluded_n = 0i64;
    for (code, &qty) in &book.positions {
        if qty == 0 {
            continue;
        }
        let mult = mult_of(code);
        let Some(&price) = cur_price.get(code) else {
            excluded_n += 1;
            continue;
        };
        if price <= 0.0 {
            excluded_n += 1;
            continue;
        }
        if !is_futures_like(code, instruments) {
            spot_net_exposure += qty as f64 * price;
        }
        let Some((pc, is_fb)) = baseline_of(code) else {
            excluded_n += 1;
            continue;
        };
        if is_fb {
            fallback_n += 1;
        }
        total_mtm += qty as f64 * (price - pc) * mult;
    }
    // 당일 fill 현금흐름 항 (C1) — 포지션 항만으로는 왕복 실현손익이 증발하고(포지션 0),
    // 당일 신규 진입이 "전일종가→진입가" 유령 손익을 얻는다. −signed×(체결가−baseline)을
    // 더하면: 왕복 = 체결가 차익 그대로, 신규 = 진입가 기준 MTM, 부분청산 = 잔여 MTM + 실현.
    let mut fill_excluded_n = 0i64;
    for e in entries.iter().filter(|e| is_today_fill(e)) {
        let Some(px) = e.price.filter(|p| *p > 0.0) else {
            fill_excluded_n += 1;
            continue;
        };
        let Some((b, _)) = baseline_of(&e.code) else {
            fill_excluded_n += 1;
            continue;
        };
        let sq = signed(&e.side, e.qty) as f64;
        total_mtm += -sq * (px - b) * mult_of(&e.code);
    }

    // ── 캐리 (M1: 현물성 노출 단순 근사, 당일 fill 무시 — 경과일 짧아 무시 가능) ──
    let carry = -base_rate_annual * spot_net_exposure * (day_fraction / 365.0);

    // ── 헤지 비용 (당일 선물 fill 명시 수수료) ──
    let fee_frac = params.futures_fee_bp / 10_000.0;
    let mut hedge_cost = 0.0;
    for e in entries.iter().filter(|e| is_today_fill(e)) {
        if e.instrument != "index_fut" && e.instrument != "stock_fut" {
            continue;
        }
        let notional = e.price.unwrap_or(0.0) * e.qty as f64 * mult_of(&e.code);
        hedge_cost -= fee_frac * notional.abs();
    }

    // ── 잔차/방향 (역산 — 완전 분해 항등) ──
    let residual_directional = total_mtm - spread - basis_stock - carry - hedge_cost;

    // ── markout 통계 ──
    let fills_by_id: HashMap<&str, &LedgerEntry> = entries
        .iter()
        .filter(|e| e.kind == "fill")
        .map(|e| (e.id.as_str(), e))
        .collect();
    let (mut n5, mut sum5, mut n30, mut sum30) = (0i64, 0.0, 0i64, 0.0);
    for m in marks {
        let Some(e) = fills_by_id.get(m.fill_id.as_str()) else {
            continue;
        };
        let Some(fp) = e.price else { continue };
        let Some(mp) = m.price else { continue };
        if fp <= 0.0 {
            continue;
        }
        let bp = markout_bp(fp, mp, signed(&e.side, e.qty));
        match m.horizon.as_str() {
            "5m" => {
                n5 += 1;
                sum5 += bp;
            }
            "30m" => {
                n30 += 1;
                sum30 += bp;
            }
            _ => {}
        }
    }
    let markout = MarkoutStats {
        n_5m: n5,
        avg_5m_bp: if n5 > 0 { sum5 / n5 as f64 } else { 0.0 },
        n_30m: n30,
        avg_30m_bp: if n30 > 0 { sum30 / n30 as f64 } else { 0.0 },
    };

    // ── 리스크 한도 4개 (§13.3-C) ──
    let limits = build_limits(basis, book_risk, etf_notionals, params);

    // ── caveats (정직 표기) ──
    let mut caveats: Vec<String> = Vec::new();
    if has_index_basis {
        caveats.push("지수 베이시스 손익은 당일 변화 미기록 — 종목만 반영".into());
    }
    if fallback_n > 0 {
        caveats.push(format!(
            "{fallback_n}개 포지션 전일종가 미상 — 당일 첫 관측가로 근사 (유니버스 12종 외)"
        ));
        if day_open_suspect {
            caveats.push(
                "장중 재시작 감지 — day_open이 재시작 후 첫 관측가라 폴백 MTM 왜곡 가능".into(),
            );
        }
    }
    if excluded_n > 0 {
        caveats.push(format!("{excluded_n}개 포지션 가격/전일종가 결측 — MTM 제외"));
    }
    if fill_excluded_n > 0 {
        caveats.push(format!(
            "당일 fill {fill_excluded_n}건 가격/기준가 결측 — 실현손익 미반영"
        ));
    }
    if un_n > 0 {
        caveats.push(format!(
            "스프레드 미귀속 fill {un_n}건 (fv_at_fill 없음 — 잔차/방향에 흡수)"
        ));
    }
    caveats.push("캐리 = 현물성 노출 단순 근사 (선물 제외 · 증거금·대차비용 미반영)".into());
    caveats.push(format!(
        "베이시스 VaR = 고정 일변동성 {:.0}bp 근사 (조잡)",
        params.basis_vol_bp_daily
    ));

    let usable = !book.positions.is_empty() || entries.iter().any(is_today_fill);

    PnlDecompSnapshot {
        as_of: now_iso.to_string(),
        total_mtm,
        spread,
        basis_stock,
        basis_index_status,
        residual_directional,
        carry,
        hedge_cost,
        unattributed: Unattributed {
            n: un_n,
            notional_krw: un_notional,
        },
        markout,
        limits,
        usable,
        caveats,
    }
}

/// 리스크 한도 4개 게이지 (§13.3-C):
///   ① 북 순 베타델타 (오버레이 후 = basis.directional_delta)
///   ② 잔차위험 1σ (book_risk #3)
///   ③ ETF 재고 (유니버스 최대 사용률 종목)
///   ④ 베이시스 VaR (지수+종목 명목 × 고정 일변동성 — 조잡)
fn build_limits(
    basis: &BasisBookSnapshot,
    book_risk: &BookRiskSnapshot,
    etf_notionals: &HashMap<String, f64>,
    params: &QuoteParams,
) -> Vec<LimitGauge> {
    // ① 순 델타
    let net_delta = basis.directional_delta_krw.abs();
    let g_delta = LimitGauge {
        name: "순 델타 (오버레이 후)".into(),
        current: net_delta,
        limit: params.limit_net_delta_krw,
        ratio: ratio(net_delta, params.limit_net_delta_krw),
        detail: String::new(),
    };

    // ② 잔차위험
    let resid = book_risk.residual_risk_krw;
    let g_resid = LimitGauge {
        name: "잔차위험 1σ".into(),
        current: resid,
        limit: params.limit_residual_krw,
        ratio: ratio(resid, params.limit_residual_krw),
        detail: String::new(),
    };

    // ③ ETF 재고 — 사용률 최대 종목. 없으면 0/기본한도.
    let mut worst_code = String::new();
    let mut worst_notional = 0.0;
    let mut worst_limit = params.per_etf_inventory_limit_krw;
    let mut worst_ratio = 0.0;
    for (code, &notional) in etf_notionals {
        let lim = params
            .inventory_limit_overrides
            .get(code)
            .copied()
            .unwrap_or(params.per_etf_inventory_limit_krw);
        let r = ratio(notional, lim);
        if r > worst_ratio {
            worst_ratio = r;
            worst_code = code.clone();
            worst_notional = notional;
            worst_limit = lim;
        }
    }
    let g_inv = LimitGauge {
        name: "ETF 재고 (최대)".into(),
        current: worst_notional,
        limit: worst_limit,
        ratio: worst_ratio,
        detail: worst_code,
    };

    // ④ 베이시스 VaR — 지수+종목 명목 × 일변동성 (조잡).
    let index_notional: f64 = basis
        .index_basis
        .iter()
        .map(|e| e.net_basis_notional_krw.abs())
        .sum();
    let basis_notional = index_notional + basis.stock_basis_total_krw;
    let basis_var = basis_notional * params.basis_vol_bp_daily / 10_000.0;
    let g_basis = LimitGauge {
        name: "베이시스 VaR".into(),
        current: basis_var,
        limit: params.limit_basis_var_krw,
        ratio: ratio(basis_var, params.limit_basis_var_krw),
        detail: format!("명목 {:.1}억 × {:.0}bp", basis_notional / 1e8, params.basis_vol_bp_daily),
    };

    vec![g_delta, g_resid, g_inv, g_basis]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::lp::{IndexBasisExposure, StockBasisPair};

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 7, 7).unwrap()
    }

    /// 당일 fill 엔트리 (ts는 today prefix).
    fn fill(
        id: &str,
        code: &str,
        instrument: &str,
        side: &str,
        qty: i64,
        price: f64,
        fv_at_fill: Option<f64>,
    ) -> LedgerEntry {
        LedgerEntry {
            id: id.into(),
            ts: "2026-07-07T10:00:00".into(),
            code: code.into(),
            instrument: instrument.into(),
            kind: "fill".into(),
            side: side.into(),
            qty,
            price: Some(price),
            fv_at_fill,
            mid_at_fill: Some(price),
        }
    }

    fn empty_basis() -> BasisBookSnapshot {
        BasisBookSnapshot {
            directional_delta_krw: 0.0,
            index_basis: vec![],
            stock_basis: vec![],
            stock_basis_total_krw: 0.0,
            residual_risk_krw: 0.0,
            any_expiry_action: false,
            timestamp: "t".into(),
        }
    }

    fn empty_book_risk() -> BookRiskSnapshot {
        BookRiskSnapshot {
            beta_adj_delta_krw: 0.0,
            gross_delta_krw: 0.0,
            residual_risk_krw: 0.0,
            delta_by_index: HashMap::new(),
            sector_exposures: HashMap::new(),
            top_residual_contributors: vec![],
            pnl_today: None,
            unmapped_positions: vec![],
            hedge_tickets: vec![],
            timestamp: "t".into(),
        }
    }

    fn book(items: &[(&str, i64)]) -> DeskBook {
        DeskBook {
            positions: items.iter().map(|(c, q)| (c.to_string(), *q)).collect(),
            updated_at: "t".into(),
        }
    }

    fn run(
        entries: &[LedgerEntry],
        marks: &[FillMark],
        book: &DeskBook,
        cur_price: &[(&str, f64)],
        prev_close: &[(&str, f64, bool)],
        basis: &BasisBookSnapshot,
        book_risk: &BookRiskSnapshot,
        day_fraction: f64,
    ) -> PnlDecompSnapshot {
        let cp: HashMap<String, f64> = cur_price.iter().map(|(c, p)| (c.to_string(), *p)).collect();
        let pc: HashMap<String, (f64, bool)> =
            prev_close.iter().map(|(c, p, fb)| (c.to_string(), (*p, *fb))).collect();
        let etf_notionals: HashMap<String, f64> = HashMap::new();
        // instruments: 테스트 코드는 6자리 spot·8자리 선물 관행이라 빈 맵 + prefix 폴백으로 충분.
        let instruments: HashMap<String, String> = HashMap::new();
        compute_pnl(
            entries, marks, today(), book, &cp, &pc, &etf_notionals, &instruments, basis,
            book_risk, &QuoteParams::default(), 0.028, day_fraction, false, "now",
        )
    }

    // ─── 스프레드 부호 (매수/매도) ───

    /// 매수 fill을 FV보다 싸게 → 스프레드 +. (FV 10,000, 체결 9,990, 1,000주 → +10,000)
    #[test]
    fn spread_buy_below_fv_positive() {
        let entries = vec![fill("f1", "069500", "etf", "buy", 1_000, 9_990.0, Some(10_000.0))];
        let b = book(&[]);
        let snap = run(&entries, &[], &b, &[], &[], &empty_basis(), &empty_book_risk(), 0.0);
        assert!((snap.spread - 10_000.0).abs() < 1e-6, "spread={}", snap.spread);
        assert_eq!(snap.unattributed.n, 0);
    }

    /// 매도 fill을 FV보다 비싸게 → 스프레드 +. (FV 10,000, 체결 10,020, 500주 매도 → +10,000)
    #[test]
    fn spread_sell_above_fv_positive() {
        let entries = vec![fill("f1", "069500", "etf", "sell", 500, 10_020.0, Some(10_000.0))];
        let b = book(&[]);
        let snap = run(&entries, &[], &b, &[], &[], &empty_basis(), &empty_book_risk(), 0.0);
        // (10,000 − 10,020) × (−500) = +10,000.
        assert!((snap.spread - 10_000.0).abs() < 1e-6, "spread={}", snap.spread);
    }

    /// 매수 fill을 FV보다 비싸게 → 스프레드 − (역스프레드).
    #[test]
    fn spread_buy_above_fv_negative() {
        let entries = vec![fill("f1", "069500", "etf", "buy", 1_000, 10_015.0, Some(10_000.0))];
        let b = book(&[]);
        let snap = run(&entries, &[], &b, &[], &[], &empty_basis(), &empty_book_risk(), 0.0);
        assert!((snap.spread - (-15_000.0)).abs() < 1e-6, "spread={}", snap.spread);
    }

    /// fv_at_fill 없는 fill → 미귀속 (스프레드 0, unattributed 집계).
    #[test]
    fn missing_fv_goes_unattributed() {
        let entries = vec![fill("f1", "005930", "stock", "buy", 100, 70_000.0, None)];
        let b = book(&[]);
        let snap = run(&entries, &[], &b, &[], &[], &empty_basis(), &empty_book_risk(), 0.0);
        assert_eq!(snap.spread, 0.0);
        assert_eq!(snap.unattributed.n, 1);
        assert!((snap.unattributed.notional_krw - 7_000_000.0).abs() < 1e-6);
    }

    // ─── 잔여 역산 가산성 (total = Σ 항목) ───

    /// 완전 분해 항등: total_mtm == spread + basis_stock + residual_directional + carry + hedge_cost.
    #[test]
    fn decomposition_is_additive() {
        // ETF 롱 (MTM), 스프레드 fill, 종목 베이시스 수렴손익, 선물 fill(헤지비용), carry.
        let mut basis = empty_basis();
        basis.stock_basis = vec![StockBasisPair {
            base_code: "005930".into(),
            name: "삼성전자".into(),
            spot_qty: 10_000,
            fut_code: "A1167000".into(),
            fut_qty: -10_000,
            matched_shares: 10_000,
            matched_signed_shares: 10_000,
            spot_price: 70_000.0,
            fut_price: 70_300.0,
            entry_basis: Some(500.0),
            basis_now: 300.0,
            basis_theory: 10.0,
            excess_now: 290.0,
            convergence_pnl: Some(2_000_000.0),
            matched_notional_krw: 700_000_000.0,
            days_to_expiry: 2,
            expiry_known: true,
            annualized_bp: 0.0,
            expiry_action_needed: true,
            usable: true,
            reason: String::new(),
        }];
        let entries = vec![
            fill("f1", "069500", "etf", "buy", 1_000, 9_990.0, Some(10_000.0)), // 스프레드 +10,000
            fill("f2", "A0166000", "index_fut", "sell", 3, 350.0, None),        // 헤지비용
        ];
        let b = book(&[("069500", 10_000), ("005930", 10_000)]);
        let cur = &[("069500", 10_050.0), ("005930", 70_000.0)];
        let prev = &[("069500", 10_000.0, false), ("005930", 69_500.0, true)];
        let snap = run(&entries, &[], &b, cur, prev, &basis, &empty_book_risk(), 0.3);
        let sum = snap.spread + snap.basis_stock + snap.residual_directional + snap.carry + snap.hedge_cost;
        assert!(
            (snap.total_mtm - sum).abs() < 1e-3,
            "total={} sum={} (spread={} basis={} resid={} carry={} hedge={})",
            snap.total_mtm, sum, snap.spread, snap.basis_stock,
            snap.residual_directional, snap.carry, snap.hedge_cost
        );
        // 개별 항 sanity.
        assert!((snap.spread - 10_000.0).abs() < 1e-6);
        assert!((snap.basis_stock - 2_000_000.0).abs() < 1e-6);
        assert!(snap.carry < 0.0, "carry(비용) 음수여야: {}", snap.carry);
        assert!(snap.hedge_cost < 0.0, "hedge_cost 음수여야: {}", snap.hedge_cost);
    }

    /// 헤지비용: 선물 fill 명목 × fee. index_fut 3계약 × 350 × 250,000 승수 × 0.3bp.
    #[test]
    fn hedge_cost_from_futures_fill() {
        let entries = vec![fill("f1", "A0166000", "index_fut", "sell", 3, 350.0, None)];
        let b = book(&[]);
        let snap = run(&entries, &[], &b, &[], &[], &empty_basis(), &empty_book_risk(), 0.0);
        // 명목 = 3 × 350 × 250,000 = 262,500,000. fee = 0.3bp → 262.5M × 3e-5 = 7,875.
        let expected = -262_500_000.0 * 0.3 / 10_000.0;
        assert!((snap.hedge_cost - expected).abs() < 1e-3, "hedge={}", snap.hedge_cost);
    }

    // ─── MTM 폴백 플래그 ───

    /// 비유니버스 포지션은 당일 첫 관측가 폴백 → caveat + fallback 플래그.
    #[test]
    fn nonuniverse_uses_fallback_prev_close() {
        let b = book(&[("005930", 100)]);
        let cur = &[("005930", 71_000.0)];
        let prev = &[("005930", 70_000.0, true)]; // fallback
        let snap = run(&[], &[], &b, cur, prev, &empty_basis(), &empty_book_risk(), 0.0);
        // MTM = 100 × (71,000 − 70,000) = 100,000.
        assert!((snap.total_mtm - 100_000.0).abs() < 1e-6, "mtm={}", snap.total_mtm);
        assert!(snap.caveats.iter().any(|c| c.contains("첫 관측가")), "{:?}", snap.caveats);
    }

    // ─── C1: 당일 fill 현금흐름 (왕복 / 부분청산 / 당일 신규) ───

    /// 왕복 (매수 1,000@136,000 → 매도 1,000@137,000, 포지션 0) → 실현 정확히 +100만.
    /// 기존 버그: 포지션 0이라 total 0 — 실현손익 증발. baseline은 소거되어야 함
    /// (아무 값이어도 결과 동일 — 여기선 135,000).
    #[test]
    fn round_trip_fill_realizes_pnl() {
        let entries = vec![
            fill("f1", "069500", "etf", "buy", 1_000, 136_000.0, None),
            fill("f2", "069500", "etf", "sell", 1_000, 137_000.0, None),
        ];
        let b = book(&[]); // 포지션 0 (왕복 완료)
        let prev = &[("069500", 135_000.0, false)];
        let snap = run(&entries, &[], &b, &[], prev, &empty_basis(), &empty_book_risk(), 0.0);
        assert!(
            (snap.total_mtm - 1_000_000.0).abs() < 1e-3,
            "왕복 실현 +100만이어야: total={}",
            snap.total_mtm
        );
        // 가산성 유지 (spread 0 — fv 없음 → 잔차로 흡수).
        let sum = snap.spread + snap.basis_stock + snap.residual_directional + snap.carry + snap.hedge_cost;
        assert!((snap.total_mtm - sum).abs() < 1e-6);
        assert!(snap.usable);
    }

    /// 부분청산 (이월 2,000 → 1,000 매도@140,000, 잔여 1,000 현재 136,600, 전일 130,125)
    /// → 잔여 MTM 1,000×(136,600−130,125)=647.5만 + 매도 실현 1,000×(140,000−130,125)=987.5만.
    #[test]
    fn partial_liquidation_realizes_sold_leg() {
        let entries = vec![fill("f1", "069500", "etf", "sell", 1_000, 140_000.0, None)];
        let b = book(&[("069500", 1_000)]); // 이월 2,000 − 매도 1,000
        let cur = &[("069500", 136_600.0)];
        let prev = &[("069500", 130_125.0, false)];
        let snap = run(&entries, &[], &b, cur, prev, &empty_basis(), &empty_book_risk(), 0.0);
        assert!(
            (snap.total_mtm - 16_350_000.0).abs() < 1e-3,
            "잔여 MTM(647.5만)+실현(987.5만)=1,635만이어야: total={}",
            snap.total_mtm
        );
    }

    /// 당일 신규 (매수 1,000@136,000, 현재 136,600, 전일 130,125) → **진입가 기준** +60만.
    /// 기존 버그: 전일종가→진입가 구간(587.5만)이 유령 손익으로 잡힘 (+647.5만 표시).
    /// fv_at_fill 부여 → 스프레드 +10만이 분해되고 잔차에 유령이 남지 않는지도 확인.
    #[test]
    fn new_position_today_entry_price_based() {
        let entries = vec![fill("f1", "069500", "etf", "buy", 1_000, 136_000.0, Some(136_100.0))];
        let b = book(&[("069500", 1_000)]);
        let cur = &[("069500", 136_600.0)];
        let prev = &[("069500", 130_125.0, false)];
        let snap = run(&entries, &[], &b, cur, prev, &empty_basis(), &empty_book_risk(), 0.0);
        assert!(
            (snap.total_mtm - 600_000.0).abs() < 1e-3,
            "진입가 기준 +60만이어야 (유령 647.5만 아님): total={}",
            snap.total_mtm
        );
        // 스프레드 = (136,100 − 136,000) × 1,000 = +10만. 잔차 = 60만 − 10만 = 50만 (오염 소멸).
        assert!((snap.spread - 100_000.0).abs() < 1e-6, "spread={}", snap.spread);
        assert!(
            (snap.residual_directional - 500_000.0).abs() < 1e-3,
            "잔차 오염: resid={}",
            snap.residual_directional
        );
    }

    /// 폴백 baseline(day_open)에서도 fill·포지션 항이 같은 기준가 → 왕복 소거 유지.
    #[test]
    fn round_trip_with_fallback_baseline_still_exact() {
        let entries = vec![
            fill("f1", "005930", "stock", "buy", 500, 70_000.0, None),
            fill("f2", "005930", "stock", "sell", 500, 70_400.0, None),
        ];
        let b = book(&[]);
        let prev = &[("005930", 69_000.0, true)]; // day_open 폴백
        let snap = run(&entries, &[], &b, &[], prev, &empty_basis(), &empty_book_risk(), 0.0);
        // 500 × (70,400 − 70,000) = +20만 — 폴백 기준가와 무관.
        assert!((snap.total_mtm - 200_000.0).abs() < 1e-3, "total={}", snap.total_mtm);
    }

    // ─── M1: 캐리 — 선물 제외 + 부호 반영 ───

    /// 델타중립 (현물 롱 7억 + 주식선물 숏 등가) → 선물은 캐리 제외, 현물 롱만 비용.
    /// 숏 현물은 캐리 +(이익). 지수선물(A-prefix 8자리)은 instruments 미상이어도 제외.
    #[test]
    fn carry_excludes_futures_and_signs_spot() {
        // 현물 롱 10,000 × 70,000 = 7억 → 캐리 비용만. 주식선물 숏은 제외.
        let b = book(&[("005930", 10_000), ("A1167000", -10_000)]);
        let cur = &[("005930", 70_000.0), ("A1167000", 70_300.0)];
        let prev = &[("005930", 70_000.0, false), ("A1167000", 70_300.0, false)];
        let snap = run(&[], &[], &b, cur, prev, &empty_basis(), &empty_book_risk(), 0.5);
        // 캐리 = −0.028 × 7억 × 0.5/365 ≈ −26,849 (선물 명목 미포함 — 포함 시 −53,712).
        let expected = -0.028 * 700_000_000.0 * 0.5 / 365.0;
        assert!(
            (snap.carry - expected).abs() < 1.0,
            "carry={} expected={} (선물 명목 포함 의심)",
            snap.carry,
            expected
        );
        // 숏 현물 → 캐리 + (매도대금 운용 이익).
        let b2 = book(&[("005930", -10_000)]);
        let snap2 = run(&[], &[], &b2, cur, prev, &empty_basis(), &empty_book_risk(), 0.5);
        assert!(snap2.carry > 0.0, "숏 캐리는 +이어야: {}", snap2.carry);
        // caveat 명기.
        assert!(
            snap.caveats.iter().any(|c| c.contains("현물성 노출 단순 근사")),
            "{:?}",
            snap.caveats
        );
    }

    // ─── markout 부호 ───

    /// 매수 후 하락 → markout 음수 (역선택). 매수 후 상승 → 양수.
    #[test]
    fn markout_sign_adverse() {
        // 매수 100주 @ 70,000. 5분 후 69,300(하락) → 역선택 음수.
        assert!(markout_bp(70_000.0, 69_300.0, 100) < 0.0);
        // 매수 후 상승 → 양수.
        assert!(markout_bp(70_000.0, 70_700.0, 100) > 0.0);
        // 매도(부호 −) 후 상승 → 역선택 음수 (판 뒤 올라 손해).
        assert!(markout_bp(70_000.0, 70_700.0, -100) < 0.0);
        // 정확값: (69,300 − 70,000)/70,000 × 10,000 = −100bp.
        assert!((markout_bp(70_000.0, 69_300.0, 100) - (-100.0)).abs() < 1e-6);
    }

    /// markout 통계 — 5분/30분 마크 평균·건수 집계.
    #[test]
    fn markout_stats_aggregate() {
        let entries = vec![
            fill("f1", "069500", "etf", "buy", 100, 10_000.0, Some(10_000.0)),
            fill("f2", "069500", "etf", "sell", 100, 10_000.0, Some(10_000.0)),
        ];
        let marks = vec![
            FillMark { fill_id: "f1".into(), horizon: "5m".into(), price: Some(9_990.0), fv: None, marked_at: None }, // 매수 후 하락 → −10bp
            FillMark { fill_id: "f2".into(), horizon: "5m".into(), price: Some(9_990.0), fv: None, marked_at: None }, // 매도 후 하락 → +10bp
            FillMark { fill_id: "f1".into(), horizon: "30m".into(), price: Some(10_020.0), fv: None, marked_at: None }, // 매수 후 상승 → +20bp
        ];
        let b = book(&[]);
        let snap = run(&entries, &marks, &b, &[], &[], &empty_basis(), &empty_book_risk(), 0.0);
        assert_eq!(snap.markout.n_5m, 2);
        // 평균 = (−10 + 10)/2 = 0.
        assert!(snap.markout.avg_5m_bp.abs() < 1e-6, "avg5={}", snap.markout.avg_5m_bp);
        assert_eq!(snap.markout.n_30m, 1);
        assert!((snap.markout.avg_30m_bp - 20.0).abs() < 1e-6, "avg30={}", snap.markout.avg_30m_bp);
    }

    // ─── 한도 게이지 ratio ───

    /// 한도 ratio = current/limit. 순델타·잔차·베이시스VaR·ETF재고 4개.
    #[test]
    fn limits_ratio_computed() {
        let mut basis = empty_basis();
        basis.directional_delta_krw = -1_000_000_000.0; // |10억|
        basis.index_basis = vec![IndexBasisExposure {
            family: "k200".into(),
            etf_leg_krw: 4_000_000_000.0,
            fut_leg_krw: -4_000_000_000.0,
            net_basis_notional_krw: 4_000_000_000.0,
            sensitivity_per_10bp_krw: 4_000_000.0,
            days_to_expiry: 10,
            roll_needed: false,
            futures_code: "A0169000".into(),
        }];
        basis.stock_basis_total_krw = 0.0;
        let mut br = empty_book_risk();
        br.residual_risk_krw = 50_000_000.0;
        let etf_notionals: HashMap<String, f64> =
            [("069500".to_string(), 1_500_000_000.0)].into();
        let params = QuoteParams::default(); // net 20억, resid 1억, basisVaR 2억, per_etf 10억
        let limits = build_limits(&basis, &br, &etf_notionals, &params);
        let g = |name: &str| limits.iter().find(|l| l.name == name).unwrap();
        // 순 델타 = 10억 / 20억 = 0.5.
        assert!((g("순 델타 (오버레이 후)").ratio - 0.5).abs() < 1e-6);
        // 잔차 = 5천만 / 1억 = 0.5.
        assert!((g("잔차위험 1σ").ratio - 0.5).abs() < 1e-6);
        // ETF 재고 = 15억 / 10억 = 1.5 (한도 초과).
        let inv = g("ETF 재고 (최대)");
        assert!((inv.ratio - 1.5).abs() < 1e-6, "inv={}", inv.ratio);
        assert_eq!(inv.detail, "069500");
        // 베이시스 VaR = 40억 × 15bp = 600만 / 2억 = 0.03.
        let bv = g("베이시스 VaR");
        assert!((bv.current - 6_000_000.0).abs() < 1.0, "var={}", bv.current);
        assert!((bv.ratio - 0.03).abs() < 1e-6);
    }
}
