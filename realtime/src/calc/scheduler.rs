//! 매트릭스 incremental 갱신 + throttle broadcast 워커.
//!
//! - 첫 빌드 단순화: 매 200ms tick에 *전체 셀 재계산*. ETF 2개 × 헤지경로 2 = 4셀이라
//!   산수 부담 거의 0. 다음 빌드에 ETF 늘어나면 reverse index 도입.
//! - 가격 입력은 bridge에서 [`MatrixState::handle_tick`]으로 동기 dispatch (lock-free DashMap).
//! - matrix-config / risk-params / positions / cost-inputs는 startup에 fetch.
//! - 포지션·cost-inputs 변경 반영은 5초 poll.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use dashmap::DashMap;
use serde::Deserialize;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{info, warn};

/// LP 매트릭스 워커 → bridge mpsc try_send 실패 누적.
/// 정상 운영 0. 누적되면 "매트릭스가 왜 안 갱신됨?" 디버깅 첫 지표.
/// `/debug/stats::matrix_tx_dropped` 노출.
pub static MATRIX_TX_DROPPED: AtomicU64 = AtomicU64::new(0);

use crate::model::lp::{
    DeskBook, EtfFairValueSnapshot, FairValueCell, FairValueMatrixSnapshot, HedgeRoute,
};
use crate::model::message::WsMessage;

use super::book_risk::{compute_book_risk, RiskParamsCache};
use super::{
    pdf_basket, stock_futures_intersect, CostInputs, EtfStaticInput, MatrixConfig, PriceMap,
    PriceWithAge,
};

/// 첫 빌드 Level 3 default cost params — backend에서 fetch 실패 시 fallback.
const DEFAULT_COST_INPUTS: CostInputs = CostInputs {
    tax_sell_bp: 20.0,
    base_rate_annual: 0.028,
    slippage_bp: 0.0,
    hold_days: 1,
};

/// LP 매트릭스 상태 컨테이너.
///
/// `prices` / `etf_prices`는 DashMap으로 lock-free concurrent. 가격 입력 핫패스 비차단.
/// `etfs` / `cost` / `book`은 RwLock — 갱신 빈도 낮음 (수초~수십초 단위).
pub struct MatrixState {
    /// matrix-config의 per_etf — startup에 1회 fetch
    pub etfs: RwLock<HashMap<String, EtfStaticInput>>,
    pub cost: RwLock<CostInputs>,
    pub book: RwLock<DeskBook>,
    pub prices: DashMap<String, PriceWithAge>,
    pub etf_prices: DashMap<String, f64>,
    pub risk_cache: Arc<RiskParamsCache>,
}

impl Default for MatrixState {
    fn default() -> Self {
        Self::new()
    }
}

impl MatrixState {
    pub fn new() -> Self {
        Self {
            etfs: RwLock::new(HashMap::new()),
            cost: RwLock::new(DEFAULT_COST_INPUTS),
            book: RwLock::new(DeskBook {
                positions: HashMap::new(),
                updated_at: "init".into(),
            }),
            prices: DashMap::new(),
            etf_prices: DashMap::new(),
            risk_cache: Arc::new(RiskParamsCache::new()),
        }
    }

    /// 메시지 한 건 처리 — 가격 dictionary 갱신. sync, lock-free.
    /// bridge 루프 안에서 직접 호출 (cheap).
    pub fn handle_tick(&self, msg: &WsMessage) {
        let now_ms = current_ms();
        match msg {
            WsMessage::StockTick(t) if t.price > 0.0 => {
                self.prices.insert(
                    t.code.clone(),
                    PriceWithAge {
                        price: t.price,
                        updated_at_ms: now_ms,
                    },
                );
            }
            WsMessage::FuturesTick(t) if t.price > 0.0 => {
                self.prices.insert(
                    t.code.clone(),
                    PriceWithAge {
                        price: t.price,
                        updated_at_ms: now_ms,
                    },
                );
            }
            WsMessage::EtfTick(t) if t.price > 0.0 => {
                self.etf_prices.insert(t.code.clone(), t.price);
            }
            _ => {}
        }
    }

    /// 200ms throttle 워커가 호출 — 전체 셀 재계산 + 매트릭스/북리스크 broadcast.
    /// 메시지는 bridge mpsc::Sender로 보내서 bridge가 batch envelope에 묶음.
    pub async fn flush(&self, tx: &mpsc::Sender<WsMessage>) {
        let etfs = self.etfs.read().await;
        if etfs.is_empty() {
            return; // matrix-config 미로드 시점
        }
        let cost = *self.cost.read().await;
        let now_ms = current_ms();
        let now_iso = chrono::Utc::now().to_rfc3339();
        let prices_snapshot = self.snapshot_prices();

        // ─── Fair value 매트릭스 ─────────────────────────────────────────
        let mut etf_snaps: Vec<EtfFairValueSnapshot> = Vec::with_capacity(etfs.len());
        for (etf_code, etf) in etfs.iter() {
            let etf_price = self.etf_prices.get(etf_code).map(|v| *v).unwrap_or(0.0);
            let mut cells: Vec<FairValueCell> = Vec::with_capacity(2);
            cells.push(pdf_basket::compute_pdf_basket(
                etf,
                etf_price,
                &prices_snapshot,
                &cost,
                now_ms,
            ));
            cells.push(stock_futures_intersect::compute_stock_futures_intersect(
                etf,
                etf_price,
                &prices_snapshot,
                &cost,
                now_ms,
            ));
            let best_route_buy = pick_best(&cells, |c| c.edge_buy_bp, true);
            let best_route_sell = pick_best(&cells, |c| c.edge_sell_bp, false);
            etf_snaps.push(EtfFairValueSnapshot {
                etf_code: etf_code.clone(),
                etf_price,
                cells,
                best_route_buy,
                best_route_sell,
                timestamp: now_iso.clone(),
            });
        }
        drop(etfs);

        let matrix_snap = FairValueMatrixSnapshot {
            snapshots: etf_snaps,
            timestamp: now_iso.clone(),
        };
        if tx.try_send(WsMessage::FairValueMatrix(matrix_snap)).is_err() {
            MATRIX_TX_DROPPED.fetch_add(1, Ordering::Relaxed);
        }

        // ─── Book risk ──────────────────────────────────────────────────
        let risk = self.risk_cache.get().await;
        let book = self.book.read().await.clone();
        let book_risk_snap =
            compute_book_risk(&book, &prices_snapshot, risk.as_deref(), &now_iso);
        if tx.try_send(WsMessage::BookRisk(book_risk_snap)).is_err() {
            MATRIX_TX_DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn snapshot_prices(&self) -> PriceMap {
        self.prices
            .iter()
            .map(|r| (r.key().clone(), *r.value()))
            .collect()
    }

    /// startup에 backend에서 matrix-config + risk-params + book + cost fetch.
    pub async fn bootstrap(&self, fastapi_base: &str) {
        if let Err(e) = self.refresh_matrix_config(fastapi_base).await {
            warn!("lp matrix-config 초기 fetch 실패: {} (재시도는 다음 poll)", e);
        } else {
            let n = self.etfs.read().await.len();
            info!("lp matrix-config 로드: {} ETF", n);
        }
        if let Err(e) = self.risk_cache.refresh(fastapi_base).await {
            warn!("lp risk-params 초기 fetch 실패: {}", e);
        } else if let Some(rp) = self.risk_cache.get().await {
            info!(
                "lp risk-params 로드: market={} window={}d coverage={}/{} shrinkage={:.3}",
                rp.market_code,
                rp.window_days,
                rp.coverage.fit_ok,
                rp.coverage.target_stocks,
                rp.shrinkage_intensity
            );
        }
        self.poll_book_and_cost(fastapi_base).await;
    }

    pub async fn refresh_matrix_config(&self, fastapi_base: &str) -> Result<(), String> {
        let url = format!("{}/api/lp/matrix-config", fastapi_base.trim_end_matches('/'));
        let resp = reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("GET {}: {}", url, e))?;
        if !resp.status().is_success() {
            return Err(format!("http {}", resp.status()));
        }
        let cfg: MatrixConfig = resp
            .json()
            .await
            .map_err(|e| format!("parse: {}", e))?;
        *self.etfs.write().await = cfg.per_etf;
        *self.cost.write().await = cfg.book.cost_inputs;
        Ok(())
    }

    pub async fn poll_book_and_cost(&self, fastapi_base: &str) {
        let base = fastapi_base.trim_end_matches('/');
        let client = reqwest::Client::new();

        // positions
        let url = format!("{}/api/lp/positions", base);
        match client.get(&url).timeout(Duration::from_secs(10)).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(payload) = resp.json::<PositionsPayload>().await {
                    *self.book.write().await = DeskBook {
                        positions: payload.positions,
                        updated_at: payload.updated_at.unwrap_or_default(),
                    };
                }
            }
            Ok(resp) => warn!("positions http {}", resp.status()),
            Err(e) => warn!("positions fetch: {}", e),
        }

        // cost-inputs
        let url = format!("{}/api/lp/cost-inputs", base);
        match client.get(&url).timeout(Duration::from_secs(10)).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(c) = resp.json::<CostInputs>().await {
                    *self.cost.write().await = c;
                }
            }
            Ok(resp) => warn!("cost-inputs http {}", resp.status()),
            Err(e) => warn!("cost-inputs fetch: {}", e),
        }
    }
}

#[derive(Debug, Deserialize)]
struct PositionsPayload {
    #[serde(default)]
    positions: HashMap<String, i64>,
    updated_at: Option<String>,
}

/// best route 인덱스 — usable 셀 중 metric 최대(`max=true`) 또는 최소.
fn pick_best<F: Fn(&FairValueCell) -> f64>(
    cells: &[FairValueCell],
    metric: F,
    pick_max: bool,
) -> Option<usize> {
    cells
        .iter()
        .enumerate()
        .filter(|(_, c)| c.usable)
        .reduce(|best, cur| {
            let cmp = metric(cur.1)
                .partial_cmp(&metric(best.1))
                .unwrap_or(std::cmp::Ordering::Equal);
            let pick_cur = if pick_max {
                matches!(cmp, std::cmp::Ordering::Greater)
            } else {
                matches!(cmp, std::cmp::Ordering::Less)
            };
            if pick_cur {
                cur
            } else {
                best
            }
        })
        .map(|(i, _)| i)
}

/// 워커 spawn — bootstrap + 200ms throttle + 5s poll.
pub fn spawn_workers(
    state: Arc<MatrixState>,
    tx_to_bridge: mpsc::Sender<WsMessage>,
    fastapi_base: String,
) {
    // bootstrap
    {
        let st = state.clone();
        let fb = fastapi_base.clone();
        tokio::spawn(async move {
            st.bootstrap(&fb).await;
        });
    }
    // throttle 200ms — 매트릭스/북리스크 broadcast
    {
        let st = state.clone();
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_millis(200));
            tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                st.flush(&tx_to_bridge).await;
            }
        });
    }
    // poll 5s — positions/cost-inputs 반영 + matrix-config/risk-params 미로드 시 재시도.
    // start_dev.sh 빌드 시간에 따라 Rust가 backend(8100)보다 먼저 뜨면 bootstrap fetch가
    // connection refused로 실패함 → 여기서 자동 복구 (etfs 비었거나 risk 캐시 없으면 재fetch).
    {
        let st = state.clone();
        let fb = fastapi_base;
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                if st.etfs.read().await.is_empty() {
                    match st.refresh_matrix_config(&fb).await {
                        Ok(()) => info!(
                            "lp matrix-config 복구: {} ETF",
                            st.etfs.read().await.len()
                        ),
                        Err(e) => warn!("lp matrix-config 재시도 실패: {}", e),
                    }
                }
                if st.risk_cache.get().await.is_none() {
                    match st.risk_cache.refresh(&fb).await {
                        Ok(()) => info!("lp risk-params 복구"),
                        Err(e) => warn!("lp risk-params 재시도 실패: {}", e),
                    }
                }
                st.poll_book_and_cost(&fb).await;
            }
        });
    }
}

fn current_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 사용 안 하지만 _ allow — HedgeRoute가 reverse index 등에 미래 사용 자리.
#[allow(unused_imports)]
use HedgeRoute as _UnusedHedgeRouteMarker;
