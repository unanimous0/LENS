//! 베이시스 실행 라우터 (§13.4) — 주문 leg(종목/방향/수량)에 대해 현물 vs 주식선물 대체 판정.
//!
//! 매도 leg는 베이시스 rich(실측 > 이론)일 때, 매수 leg는 cheap일 때 선물 대체.
//! 이론 베이시스 = spot × r × d/365 (금리만, 배당 무시 v1). 실측 베이시스 = 선물가 − 현물가.
//! excess = 실측 − 이론. |excess| 가 임계(basis_threshold_bp) 이상이면 선물 대체.
//!
//! 종목차익(stock-arbitrage) 화면도 베이시스를 계산하나, LP 라우터의 핵심 차이는
//! **이론가 대비 excess 판정** — 단순 시장 베이시스가 아니라 리치/칩을 이론 대비로 본다.
//!
//! 실시간 spot·주식선물가는 이미 수신 중인 tick 캐시(MatrixState.prices)를 핸들러가 조회해
//! [`decide_basis`]에 주입한다 (이 모듈은 파일 I/O·가격 조회와 분리된 순수 판정).
#![allow(dead_code)]

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::RwLock;

use chrono::NaiveDate;
use serde::Serialize;

/// 주식선물가가 이보다 오래되면 verdict='stale' (라운딩 잔차 판단 위험). 주식선물은 현물보다
/// 체결 빈도 낮아 현물(마지막 체결가 유효 철학)보다 관대하게 60초.
const BASIS_FUT_STALE_MS: u64 = 60_000;

// =============================================================================
// futures_master.json (base_code → front 주식선물) mtime 캐시
// =============================================================================

/// 한 종목의 주식선물 계약 1건. `front_code`는 이 항목이 가리키는 계약 코드 —
/// by_base 맵에서는 front 월물, by_code 맵에서는 그 코드 자신(front 또는 back).
#[derive(Debug, Clone)]
pub struct StockFuture {
    pub base_code: String,
    pub front_code: String,
    pub name: String,
    pub expiry: String, // YYYYMMDD
    pub multiplier: f64, // 주식선물 승수 (통상 10)
}

struct MasterCache {
    mtime_secs: u64,
    by_base: std::collections::HashMap<String, StockFuture>,
    /// 계약 코드(front/back 모두) → 그 계약. 베이시스 북이 **실보유 계약**의 만기를
    /// 정확히 잡기 위함 (front 전용 by_base만 보면 차월물 만기가 근월물로 오귀속 — M1).
    by_code: Arc<std::collections::HashMap<String, StockFuture>>,
}

fn master_slot() -> &'static RwLock<Option<MasterCache>> {
    static SLOT: OnceLock<RwLock<Option<MasterCache>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

fn master_path() -> &'static std::path::Path {
    std::path::Path::new("../data/futures_master.json")
}

fn current_mtime_secs() -> u64 {
    std::fs::metadata(master_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 캐시 최신화 후 접근자 f 실행. mtime 기준 lazy reload (기존 lookup 정책 그대로).
fn with_master<T>(f: impl FnOnce(&MasterCache) -> T) -> T {
    let disk_mtime = current_mtime_secs();
    // fast path — 캐시 유효
    {
        let guard = master_slot().read().unwrap();
        if let Some(c) = guard.as_ref() {
            if c.mtime_secs == disk_mtime {
                return f(c);
            }
        }
    }
    // reload
    let (by_base, by_code) = load_master();
    let cache = MasterCache {
        mtime_secs: disk_mtime,
        by_base,
        by_code: Arc::new(by_code),
    };
    let result = f(&cache);
    *master_slot().write().unwrap() = Some(cache);
    result
}

/// base_code(6자리) → front 주식선물. futures_master.json을 mtime 기준 lazy 캐시.
pub fn lookup_stock_future(base_code: &str) -> Option<StockFuture> {
    with_master(|c| c.by_base.get(base_code).cloned())
}

/// 계약 코드(front/back) → 그 계약 전체 맵 스냅샷. 베이시스 북이 실보유 계약별
/// 만기·이름을 정확히 얻는 데 사용 (Arc clone — cheap).
pub fn master_by_code() -> Arc<std::collections::HashMap<String, StockFuture>> {
    with_master(|c| c.by_code.clone())
}

type MasterMaps = (
    std::collections::HashMap<String, StockFuture>,
    std::collections::HashMap<String, StockFuture>,
);

fn load_master() -> MasterMaps {
    let mut by_base = std::collections::HashMap::new();
    let mut by_code = std::collections::HashMap::new();
    let data = match std::fs::read_to_string(master_path()) {
        Ok(d) => d,
        Err(_) => return (by_base, by_code),
    };
    let json: serde_json::Value = match serde_json::from_str(&data) {
        Ok(v) => v,
        Err(_) => return (by_base, by_code),
    };
    if let Some(items) = json["items"].as_array() {
        for item in items {
            let base = item["base_code"].as_str().unwrap_or("").trim().to_string();
            if base.is_empty() {
                continue;
            }
            // front + back 모두 by_code에 (실보유 계약 매칭). front만 by_base에 (라우팅용).
            for leg in ["front", "back"] {
                let Some(node) = item.get(leg) else { continue };
                let code = node["code"].as_str().unwrap_or("").trim().to_uppercase();
                if code.is_empty() {
                    continue;
                }
                let sf = StockFuture {
                    base_code: base.clone(),
                    front_code: code.clone(),
                    name: node["name"].as_str().unwrap_or("").trim().to_string(),
                    expiry: node["expiry"].as_str().unwrap_or("").trim().to_string(),
                    multiplier: node["multiplier"].as_f64().unwrap_or(10.0),
                };
                if leg == "front" {
                    by_base.insert(base.clone(), sf.clone());
                }
                by_code.insert(code, sf);
            }
        }
    }
    (by_base, by_code)
}

/// 자유 입력 코드 → base 6자리 후보. (LS 6자리 / A+6 / KR7 ISIN)
/// 완전 정규화(정확한 ISIN↔단축 매핑)는 backend stock_code.py 몫 — 여기선 흔한 형태만.
pub fn normalize_base(raw: &str) -> String {
    let s = raw.trim().to_uppercase();
    // KR7 + 6자리 issue + 체크 (12자) → 6자리 발행코드.
    if s.len() == 12 && s.starts_with("KR7") {
        return s[3..9].to_string();
    }
    // A + 6자리 (현물 단축, 내부망) → 6자리.
    if s.len() == 7 && s.starts_with('A') && s[1..].chars().all(|c| c.is_ascii_alphanumeric()) {
        return s[1..].to_string();
    }
    s
}

// =============================================================================
// 판정 결과 (Serialize → JSON 응답)
// =============================================================================

#[derive(Debug, Clone, Serialize)]
pub struct BasisFuturesInfo {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub expiry: String,
    pub days_left: i64,
    pub multiplier: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BasisRouteResponse {
    /// 정규화 base 6자리.
    pub code: String,
    /// 원 입력 코드.
    pub input_code: String,
    pub side: String,
    pub qty: i64,
    pub spot_price: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub futures: Option<BasisFuturesInfo>,
    /// 실측 베이시스 = 선물가 − 현물가.
    pub basis_now: f64,
    /// 이론 베이시스 = spot × r × d/365 (배당 무시 v1).
    pub basis_theory: f64,
    /// excess = 실측 − 이론 (양수 = rich).
    pub excess_basis: f64,
    /// excess를 스팟 대비 bp로.
    pub excess_bp: f64,
    /// 'futures' | 'spot' | 'no_futures' | 'stale' | 'no_data'.
    pub verdict: String,
    pub verdict_reason: String,
    /// qty / 승수 반올림 계약수.
    pub qty_futures_contracts: i64,
    /// 계약 환산 잔차 주수 (부호 有: 양수 = 계약이 못 담은 주수).
    pub qty_futures_residual_shares: i64,
    /// 입력(현물/선물 틱) 중 가장 오래된 나이 (ms).
    pub inputs_age_ms: u32,
}

/// 베이시스 라우팅 판정 (pure). 가격 조회는 호출자가 캐시에서 해서 주입.
///
/// - `spot`: (현물가, 나이ms). 미수신이면 None.
/// - `sf`: 주식선물 마스터. 미상장이면 None.
/// - `fut_price`: (선물가, 나이ms). 미수신이면 None.
#[allow(clippy::too_many_arguments)]
pub fn decide_basis(
    input_code: &str,
    base_code: &str,
    side: &str,
    qty: i64,
    spot: Option<(f64, u32)>,
    sf: Option<&StockFuture>,
    fut_price: Option<(f64, u32)>,
    base_rate_annual: f64,
    basis_threshold_bp: f64,
    today: NaiveDate,
) -> BasisRouteResponse {
    let mut resp = BasisRouteResponse {
        code: base_code.to_string(),
        input_code: input_code.to_string(),
        side: side.to_string(),
        qty,
        spot_price: spot.map(|(p, _)| p).unwrap_or(0.0),
        futures: None,
        basis_now: 0.0,
        basis_theory: 0.0,
        excess_basis: 0.0,
        excess_bp: 0.0,
        verdict: "no_data".to_string(),
        verdict_reason: String::new(),
        qty_futures_contracts: 0,
        qty_futures_residual_shares: qty,
        inputs_age_ms: spot.map(|(_, a)| a).unwrap_or(u32::MAX),
    };

    // 계약 환산 (선물 상장 시). 판정과 무관하게 표기.
    if let Some(sf) = sf {
        let days_left = parse_expiry_days(&sf.expiry, today);
        let fut_px = fut_price.map(|(p, _)| p).unwrap_or(0.0);
        let contracts = if sf.multiplier > 0.0 {
            (qty as f64 / sf.multiplier).round() as i64
        } else {
            0
        };
        let residual = qty - contracts * sf.multiplier as i64;
        resp.qty_futures_contracts = contracts;
        resp.qty_futures_residual_shares = residual;
        resp.futures = Some(BasisFuturesInfo {
            code: sf.front_code.clone(),
            name: sf.name.clone(),
            price: fut_px,
            expiry: sf.expiry.clone(),
            days_left,
            multiplier: sf.multiplier,
        });
    }

    // ── 판정 게이트 ──
    let Some((spot_px, spot_age)) = spot else {
        resp.verdict = "no_data".into();
        resp.verdict_reason = "현물 시세 미수신 (구독셋에 없음)".into();
        return resp;
    };
    if spot_px <= 0.0 {
        resp.verdict = "no_data".into();
        resp.verdict_reason = "현물가 0".into();
        return resp;
    }
    let Some(sf) = sf else {
        resp.verdict = "no_futures".into();
        resp.verdict_reason = "주식선물 미상장".into();
        return resp;
    };
    let Some((fut_px, fut_age)) = fut_price else {
        resp.verdict = "no_data".into();
        resp.verdict_reason = "주식선물 시세 미수신".into();
        return resp;
    };
    if fut_px <= 0.0 {
        resp.verdict = "no_data".into();
        resp.verdict_reason = "주식선물가 0".into();
        return resp;
    }

    let days_left = parse_expiry_days(&sf.expiry, today);
    let basis_now = fut_px - spot_px;
    let basis_theory = spot_px * base_rate_annual * (days_left as f64) / 365.0;
    let excess = basis_now - basis_theory;
    let excess_bp = excess / spot_px * 10_000.0;
    resp.basis_now = basis_now;
    resp.basis_theory = basis_theory;
    resp.excess_basis = excess;
    resp.excess_bp = excess_bp;
    resp.inputs_age_ms = spot_age.max(fut_age);

    // 선물가 stale → 판정 보류.
    if (fut_age as u64) > BASIS_FUT_STALE_MS {
        resp.verdict = "stale".into();
        resp.verdict_reason = format!("주식선물 시세 stale ({:.0}s)", fut_age as f64 / 1000.0);
        return resp;
    }

    // 임계 (bp → KRW).
    let threshold_krw = spot_px * basis_threshold_bp / 10_000.0;
    let (use_futures, reason) = match side {
        // 매도 leg: 베이시스 rich(excess>임계) → 선물 매도 대체. ({:+.1} — 부호 자동, "+-" 방지)
        "sell" => {
            if excess > threshold_krw {
                (true, format!("베이시스 rich (excess {:+.1}bp > 임계 {:.1}bp) → 선물 매도 대체", excess_bp, basis_threshold_bp))
            } else {
                (false, format!("excess {:+.1}bp ≤ 임계 {:.1}bp → 현물 매도", excess_bp, basis_threshold_bp))
            }
        }
        // 매수 leg: 베이시스 cheap(excess<−임계) → 선물 매수 대체.
        "buy" => {
            if excess < -threshold_krw {
                (true, format!("베이시스 cheap (excess {:+.1}bp < −임계 {:.1}bp) → 선물 매수 대체", excess_bp, basis_threshold_bp))
            } else {
                (false, format!("excess {:+.1}bp ≥ −임계 {:.1}bp → 현물 매수", excess_bp, basis_threshold_bp))
            }
        }
        other => {
            resp.verdict = "no_data".into();
            resp.verdict_reason = format!("알 수 없는 side: {other}");
            return resp;
        }
    };
    resp.verdict = if use_futures { "futures" } else { "spot" }.into();
    resp.verdict_reason = reason;
    resp
}

/// "YYYYMMDD" 만기 → 오늘까지 잔존일 (≥0). 파싱 실패 시 0.
pub(crate) fn parse_expiry_days(expiry: &str, today: NaiveDate) -> i64 {
    if expiry.len() != 8 {
        return 0;
    }
    let y = expiry[0..4].parse::<i32>().ok();
    let m = expiry[4..6].parse::<u32>().ok();
    let d = expiry[6..8].parse::<u32>().ok();
    match (y, m, d) {
        (Some(y), Some(m), Some(d)) => NaiveDate::from_ymd_opt(y, m, d)
            .map(|e| (e - today).num_days().max(0))
            .unwrap_or(0),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sf(expiry: &str) -> StockFuture {
        StockFuture {
            base_code: "005930".into(),
            front_code: "A1AA6000".into(),
            name: "삼성전자 F".into(),
            expiry: expiry.into(),
            multiplier: 10.0,
        }
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 7, 7).unwrap()
    }

    #[test]
    fn normalize_variants() {
        assert_eq!(normalize_base("005930"), "005930");
        assert_eq!(normalize_base("A005930"), "005930");
        assert_eq!(normalize_base("KR7005930003"), "005930");
        assert_eq!(normalize_base(" a005930 "), "005930");
    }

    #[test]
    fn expiry_days() {
        // 20260709 − 20260707 = 2일.
        assert_eq!(parse_expiry_days("20260709", today()), 2);
        // 과거 만기 → 0 (음수 클램프).
        assert_eq!(parse_expiry_days("20260101", today()), 0);
    }

    /// 매도 leg + rich 베이시스 → 선물 대체.
    #[test]
    fn sell_rich_picks_futures() {
        let spot = 70_000.0;
        // d=2, r=2.8% → 이론 = 70000×0.028×2/365 ≈ 10.7원. 선물가 70,300 → basis_now=300.
        // excess ≈ +289원 ≈ +41bp ≫ 임계 5bp → 선물.
        let r = decide_basis(
            "005930", "005930", "sell", 10_000,
            Some((spot, 100)), Some(&sf("20260709")), Some((70_300.0, 100)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "futures");
        assert!(r.excess_basis > 0.0);
        // 계약 환산: 10000/10 = 1000계약, 잔차 0.
        assert_eq!(r.qty_futures_contracts, 1000);
        assert_eq!(r.qty_futures_residual_shares, 0);
    }

    /// 매도 leg + 베이시스가 이론 근처(rich 아님) → 현물.
    #[test]
    fn sell_fair_picks_spot() {
        let spot = 70_000.0;
        // 선물가 = spot + 이론(≈10.7) → excess ≈ 0 → 현물.
        let r = decide_basis(
            "005930", "005930", "sell", 10_000,
            Some((spot, 100)), Some(&sf("20260709")), Some((70_010.7, 100)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "spot");
    }

    /// L2 회귀: 매도 leg + 음수 excess → 사유에 "+-" 같은 이중 부호가 없어야 함.
    #[test]
    fn sell_negative_excess_reason_sign() {
        let spot = 70_000.0;
        // 선물가 < 현물가 → excess 음수 → 현물 매도 verdict, 사유 부호 {:+.1} 단일.
        let r = decide_basis(
            "005930", "005930", "sell", 100,
            Some((spot, 100)), Some(&sf("20260709")), Some((69_700.0, 100)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "spot");
        assert!(!r.verdict_reason.contains("+-"), "reason={}", r.verdict_reason);
        assert!(r.verdict_reason.contains("-"), "음수 부호 표기: {}", r.verdict_reason);
    }

    /// 매수 leg는 부호 반대 — cheap(excess<−임계)일 때 선물.
    #[test]
    fn buy_cheap_picks_futures() {
        let spot = 70_000.0;
        // 선물가 69,700 → basis_now=−300, excess ≈ −311원 ≈ −44bp < −5bp → 선물 매수 대체.
        let r = decide_basis(
            "005930", "005930", "buy", 5_000,
            Some((spot, 100)), Some(&sf("20260709")), Some((69_700.0, 100)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "futures");
        assert!(r.excess_basis < 0.0);
        assert_eq!(r.qty_futures_contracts, 500);
    }

    /// 매수 leg + rich 베이시스 → 현물 (매도와 대칭: 같은 rich라도 매수는 선물 이점 없음).
    #[test]
    fn buy_rich_picks_spot() {
        let spot = 70_000.0;
        let r = decide_basis(
            "005930", "005930", "buy", 5_000,
            Some((spot, 100)), Some(&sf("20260709")), Some((70_300.0, 100)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "spot");
    }

    #[test]
    fn no_futures_when_unlisted() {
        let r = decide_basis(
            "005930", "005930", "sell", 100,
            Some((70_000.0, 100)), None, None,
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "no_futures");
        assert!(r.futures.is_none());
    }

    #[test]
    fn no_data_when_spot_missing() {
        let r = decide_basis(
            "005930", "005930", "sell", 100,
            None, Some(&sf("20260709")), Some((70_300.0, 100)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "no_data");
        // 선물 계약 환산은 여전히 표기됨.
        assert!(r.futures.is_some());
        assert_eq!(r.qty_futures_contracts, 10);
    }

    #[test]
    fn stale_futures_flags() {
        let r = decide_basis(
            "005930", "005930", "sell", 100,
            Some((70_000.0, 100)), Some(&sf("20260709")),
            Some((70_300.0, (BASIS_FUT_STALE_MS + 5_000) as u32)),
            0.028, 5.0, today(),
        );
        assert_eq!(r.verdict, "stale");
    }

    /// 계약 환산 잔차 — 승수 10 나눠떨어지지 않는 수량.
    #[test]
    fn contract_conversion_residual() {
        let r = decide_basis(
            "005930", "005930", "sell", 10_007,
            Some((70_000.0, 100)), Some(&sf("20260709")), Some((70_300.0, 100)),
            0.028, 5.0, today(),
        );
        // round(1000.7)=1001계약 → 잔차 10007 − 10010 = −3.
        assert_eq!(r.qty_futures_contracts, 1001);
        assert_eq!(r.qty_futures_residual_shares, -3);
    }
}
