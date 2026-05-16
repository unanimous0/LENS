//! 북 단위 리스크 계산 — #2 베타조정 델타 + #3 잔차위험 (잔차 공분산 포함).
//!
//! 입력:
//!   - `DeskBook.positions`: 사용자 수동 입력 포지션 (code → 부호있는 qty)
//!   - `PriceMap`: 실시간 가격
//!   - `RiskParams`: 백엔드 `/api/lp/risk-params`에서 fetch (베타·잔차σ·공분산·섹터)
//!
//! 산출:
//!   - `gross_delta_krw` = Σ qty × price (베타 미적용 총 원화 노출, 부호 보존)
//!   - `beta_adj_delta_krw` = Σ n_i × β_i  (시장 노출도, n_i = qty × price)
//!   - `residual_risk_krw` = √(n^T Σ_resid n)  (잔차 공분산 적용 1σ 일변동 원화)
//!   - 섹터 노출 / top 잔차 기여 종목 / 미매핑 포지션 분리
//!
//! 단순화 (첫 빌드):
//!   - 선물 포지션(주식선물·지수선물)은 `unmapped_positions`로 분리. 매핑은 다음 빌드.
//!   - top_residual_contributors는 단독 위험(|n| × σ) 정렬. Euler decomposition은 다음 빌드.
//!   - 단일 팩터(KOSPI200) — `delta_by_index`는 항상 1개 키.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use tokio::sync::RwLock;

use crate::model::lp::{BookRiskSnapshot, DeskBook};

use super::PriceMap;

// =============================================================================
// risk-params JSON 모델 (FastAPI 응답)
// =============================================================================

#[derive(Debug, Clone, Deserialize)]
pub struct RiskParams {
    pub as_of: Option<String>,
    pub market_code: String,
    pub window_days: i32,
    pub betas: HashMap<String, f64>,
    pub residual_sigmas_daily: HashMap<String, f64>,
    pub residual_covariance: ResidualCovariance,
    pub sector_map: HashMap<String, String>,
    pub shrinkage_intensity: f64,
    pub coverage: CoverageInfo,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResidualCovariance {
    pub codes: Vec<String>,
    pub matrix: Vec<Vec<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CoverageInfo {
    pub target_stocks: usize,
    pub fit_ok: usize,
    pub fit_failed: usize,
    #[serde(default)]
    pub failed_codes_sample: Vec<String>,
}

// =============================================================================
// Rust 메모리 캐시 — startup에 1회 fetch
// =============================================================================

#[derive(Default)]
pub struct RiskParamsCache {
    inner: RwLock<Option<Arc<RiskParams>>>,
}

impl RiskParamsCache {
    pub fn new() -> Self {
        Self { inner: RwLock::new(None) }
    }

    /// FastAPI에서 fetch + 캐시 갱신. 실패 시 캐시 유지.
    pub async fn refresh(&self, fastapi_base_url: &str) -> Result<(), String> {
        let url = format!("{}/api/lp/risk-params", fastapi_base_url.trim_end_matches('/'));
        let resp = reqwest::Client::new()
            .get(&url)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("risk-params fetch error: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("risk-params http {}", resp.status()));
        }
        let params: RiskParams = resp
            .json()
            .await
            .map_err(|e| format!("risk-params parse error: {}", e))?;
        *self.inner.write().await = Some(Arc::new(params));
        Ok(())
    }

    pub async fn get(&self) -> Option<Arc<RiskParams>> {
        self.inner.read().await.clone()
    }
}

// =============================================================================
// 북 리스크 계산 (pure)
// =============================================================================

/// 북 단위 리스크 산출. risk-params 가 없으면 zero snapshot 반환 (모두 0 + unmapped 목록만 채움).
pub fn compute_book_risk(
    book: &DeskBook,
    prices: &PriceMap,
    risk: Option<&RiskParams>,
    now_iso: &str,
) -> BookRiskSnapshot {
    // 1. 포지션 → (매핑된 원화 노출 dict) + (미매핑 리스트)
    let mut mapped: HashMap<String, f64> = HashMap::new();
    let mut unmapped: Vec<(String, i64)> = Vec::new();

    for (code, &qty) in &book.positions {
        if qty == 0 {
            continue;
        }
        let price = prices.get(code).map(|p| p.price).unwrap_or(0.0);
        let in_betas = risk.map(|r| r.betas.contains_key(code)).unwrap_or(false);
        if price > 0.0 && in_betas {
            mapped.insert(code.clone(), qty as f64 * price);
        } else {
            unmapped.push((code.clone(), qty));
        }
    }

    // 2. gross_delta — 부호 보존 합 (long-short 헤지가 0 가까이)
    let gross_delta_krw: f64 = mapped.values().copied().sum();

    let Some(risk) = risk else {
        // risk-params 없으면 베타·잔차 산출 불가, gross만 의미.
        return BookRiskSnapshot {
            beta_adj_delta_krw: 0.0,
            gross_delta_krw,
            residual_risk_krw: 0.0,
            delta_by_index: HashMap::new(),
            sector_exposures: HashMap::new(),
            top_residual_contributors: Vec::new(),
            pnl_today: None,
            unmapped_positions: unmapped,
            timestamp: now_iso.to_string(),
        };
    };

    // 3. beta_adj_delta = Σ n_i × β_i
    let beta_adj_delta_krw: f64 = mapped
        .iter()
        .map(|(c, &n)| n * risk.betas.get(c).copied().unwrap_or(0.0))
        .sum();

    // 4. residual_risk = √(n^T Σ_resid n)
    //    공분산 행렬 인덱스 순서대로 노출 벡터 만들고 quadratic form.
    let cov_codes = &risk.residual_covariance.codes;
    let n_vec: Vec<f64> = cov_codes
        .iter()
        .map(|c| mapped.get(c).copied().unwrap_or(0.0))
        .collect();
    let residual_var = quadratic_form(&n_vec, &risk.residual_covariance.matrix);
    let residual_risk_krw = if residual_var > 0.0 {
        residual_var.sqrt()
    } else {
        0.0
    };

    // 5. delta_by_index — 단일 팩터
    let mut delta_by_index: HashMap<String, f64> = HashMap::new();
    delta_by_index.insert(risk.market_code.clone(), beta_adj_delta_krw);

    // 6. sector_exposures
    let mut sector_exposures: HashMap<String, f64> = HashMap::new();
    for (code, &n) in &mapped {
        if let Some(sector) = risk.sector_map.get(code) {
            *sector_exposures.entry(sector.clone()).or_insert(0.0) += n;
        }
    }

    // 7. top_residual_contributors — 단독 위험(|n| × σ_resid) 정렬 top 10
    let mut contribs: Vec<(String, f64)> = mapped
        .iter()
        .filter_map(|(c, &n)| {
            risk.residual_sigmas_daily
                .get(c)
                .map(|&sigma| (c.clone(), n.abs() * sigma))
        })
        .collect();
    contribs.sort_by(|a, b| {
        b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
    });
    contribs.truncate(10);

    BookRiskSnapshot {
        beta_adj_delta_krw,
        gross_delta_krw,
        residual_risk_krw,
        delta_by_index,
        sector_exposures,
        top_residual_contributors: contribs,
        pnl_today: None,
        unmapped_positions: unmapped,
        timestamp: now_iso.to_string(),
    }
}

/// n^T Σ n. n과 matrix의 dimension 일치 가정. 0인 n_i는 skip(sparsity).
fn quadratic_form(n: &[f64], matrix: &[Vec<f64>]) -> f64 {
    if n.len() != matrix.len() {
        return 0.0;
    }
    let mut total = 0.0;
    for i in 0..n.len() {
        if n[i] == 0.0 {
            continue;
        }
        let row = &matrix[i];
        if row.len() != n.len() {
            return 0.0;
        }
        let mut row_dot = 0.0;
        for j in 0..n.len() {
            row_dot += row[j] * n[j];
        }
        total += n[i] * row_dot;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::super::PriceWithAge;
    use super::*;

    fn make_risk(betas: &[(&str, f64)], sigmas: &[(&str, f64)], matrix: Vec<Vec<f64>>, sectors: &[(&str, &str)]) -> RiskParams {
        let cov_codes: Vec<String> = betas.iter().map(|(c, _)| c.to_string()).collect();
        RiskParams {
            as_of: Some("2026-05-12".into()),
            market_code: "K2G01P".into(),
            window_days: 60,
            betas: betas.iter().map(|(c, b)| (c.to_string(), *b)).collect(),
            residual_sigmas_daily: sigmas.iter().map(|(c, s)| (c.to_string(), *s)).collect(),
            residual_covariance: ResidualCovariance {
                codes: cov_codes,
                matrix,
            },
            sector_map: sectors.iter().map(|(c, s)| (c.to_string(), s.to_string())).collect(),
            shrinkage_intensity: 0.3,
            coverage: CoverageInfo {
                target_stocks: betas.len(),
                fit_ok: betas.len(),
                fit_failed: 0,
                failed_codes_sample: vec![],
            },
        }
    }

    fn make_prices(items: &[(&str, f64)]) -> PriceMap {
        items.iter().map(|(c, p)| (c.to_string(), PriceWithAge { price: *p, updated_at_ms: 1_000_000 })).collect()
    }

    #[test]
    fn beta_adj_delta_basic() {
        // 종목 A: β=1.2, 100주 × 10,000원 = 1,000,000원 노출
        // 종목 B: β=0.8, -200주 × 5,000원 = -1,000,000원 노출
        // gross = 0 (long-short 헤지)
        // beta_adj = 1.2 × 1,000,000 + 0.8 × (-1,000,000) = 400,000
        let risk = make_risk(
            &[("A", 1.2), ("B", 0.8)],
            &[("A", 0.02), ("B", 0.015)],
            vec![vec![4e-4, 0.0], vec![0.0, 2.25e-4]],  // 독립
            &[("A", "반도체"), ("B", "화학")],
        );
        let prices = make_prices(&[("A", 10_000.0), ("B", 5_000.0)]);
        let book = DeskBook {
            positions: vec![("A".into(), 100), ("B".into(), -200)].into_iter().collect(),
            updated_at: "2026-05-13".into(),
        };
        let snap = compute_book_risk(&book, &prices, Some(&risk), "now");
        assert!((snap.gross_delta_krw - 0.0).abs() < 0.01, "gross = {}", snap.gross_delta_krw);
        assert!((snap.beta_adj_delta_krw - 400_000.0).abs() < 0.01, "beta_adj = {}", snap.beta_adj_delta_krw);
        // delta_by_index — K2G01P 단일
        assert_eq!(snap.delta_by_index.len(), 1);
        assert!((snap.delta_by_index["K2G01P"] - 400_000.0).abs() < 0.01);
        // unmapped 없음
        assert!(snap.unmapped_positions.is_empty());
    }

    #[test]
    fn residual_risk_with_off_diagonal() {
        // 2종목 같은 노출(100만원씩), 잔차 σ 모두 1%/일 (var=1e-4)
        // 독립: σ_total² = 2 × (1e6)² × 1e-4 = 2e8, σ ≈ 14,142
        // 상관 +1: σ_total² = (1e6 + 1e6)² × 1e-4 = 4e8, σ ≈ 20,000
        let risk = make_risk(
            &[("A", 1.0), ("B", 1.0)],
            &[("A", 0.01), ("B", 0.01)],
            // 상관 0.5 → cov_off = 0.5 × σ_A × σ_B = 0.5 × 1e-4 = 5e-5
            vec![vec![1e-4, 5e-5], vec![5e-5, 1e-4]],
            &[],
        );
        let prices = make_prices(&[("A", 10_000.0), ("B", 10_000.0)]);
        let book = DeskBook {
            positions: vec![("A".into(), 100), ("B".into(), 100)].into_iter().collect(),
            updated_at: "x".into(),
        };
        let snap = compute_book_risk(&book, &prices, Some(&risk), "now");
        // n = [1e6, 1e6]. n^T Σ n = 2×1e12×1e-4 + 2×1e12×5e-5 = 2e8 + 1e8 = 3e8
        // residual_risk = sqrt(3e8) ≈ 17,320
        assert!(
            (snap.residual_risk_krw - 17_320.508).abs() < 1.0,
            "residual_risk = {}", snap.residual_risk_krw
        );
    }

    #[test]
    fn unmapped_positions_separated() {
        let risk = make_risk(
            &[("A", 1.0)],
            &[("A", 0.01)],
            vec![vec![1e-4]],
            &[],
        );
        let prices = make_prices(&[("A", 10_000.0), ("FUT_X", 5_000.0)]);
        // FUT_X는 risk.betas에 없음 → unmapped
        let book = DeskBook {
            positions: vec![("A".into(), 100), ("FUT_X".into(), -50)].into_iter().collect(),
            updated_at: "x".into(),
        };
        let snap = compute_book_risk(&book, &prices, Some(&risk), "now");
        assert_eq!(snap.unmapped_positions.len(), 1);
        assert_eq!(snap.unmapped_positions[0].0, "FUT_X");
        assert_eq!(snap.unmapped_positions[0].1, -50);
        // gross_delta에 FUT_X는 미반영 — 매핑 안 됐으니
        assert!((snap.gross_delta_krw - 1_000_000.0).abs() < 0.01);
    }

    #[test]
    fn sector_exposures_aggregate() {
        let risk = make_risk(
            &[("A", 1.0), ("B", 1.0), ("C", 1.0)],
            &[("A", 0.01), ("B", 0.01), ("C", 0.01)],
            vec![vec![1e-4, 0.0, 0.0], vec![0.0, 1e-4, 0.0], vec![0.0, 0.0, 1e-4]],
            &[("A", "반도체"), ("B", "반도체"), ("C", "화학")],
        );
        let prices = make_prices(&[("A", 10_000.0), ("B", 10_000.0), ("C", 10_000.0)]);
        let book = DeskBook {
            positions: vec![("A".into(), 100), ("B".into(), 50), ("C".into(), -30)].into_iter().collect(),
            updated_at: "x".into(),
        };
        let snap = compute_book_risk(&book, &prices, Some(&risk), "now");
        // 반도체 = 100×10000 + 50×10000 = 1,500,000
        // 화학 = -30×10000 = -300,000
        assert!((snap.sector_exposures["반도체"] - 1_500_000.0).abs() < 0.01);
        assert!((snap.sector_exposures["화학"] - (-300_000.0)).abs() < 0.01);
    }

    #[test]
    fn no_risk_params_returns_zero_snapshot_with_gross_only() {
        let prices = make_prices(&[("A", 10_000.0)]);
        let book = DeskBook {
            positions: vec![("A".into(), 100)].into_iter().collect(),
            updated_at: "x".into(),
        };
        // risk None — 모두 unmapped로 분류, gross=0 (매핑 안 됐으니)
        let snap = compute_book_risk(&book, &prices, None, "now");
        assert_eq!(snap.beta_adj_delta_krw, 0.0);
        assert_eq!(snap.residual_risk_krw, 0.0);
        assert_eq!(snap.unmapped_positions.len(), 1);
    }
}
