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
    QuoteBoardSnapshot,
};
use crate::model::message::WsMessage;

use super::basis_book::compute_basis_book;
use super::book_risk::{compute_book_risk, RiskParamsCache};
use super::hedge_ticket::compute_hedge_tickets;
use super::quote_board::{
    compute_fv_futures, compute_quote_row, FvFutures, IndexFuturesState, QuoteParams,
    QuoteUniverseEtf,
};
use super::{
    apply_level3_costs, pdf_basket, stock_futures_intersect, CostInputs, EtfStaticInput,
    LedgerAgg, MatrixConfig, PriceMap, PriceWithAge,
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
    /// 원장 집계 (§13.4 베이시스 북·book_risk·hedge_ticket의 단일 소스). 5초 poll이 채움.
    /// `book`(positions map)은 여기서 파생 — 아래 poll_book_and_cost 참조.
    pub ledger: RwLock<Vec<LedgerAgg>>,
    /// basis_book broadcast 마지막 시각 (ms) — flush는 200ms지만 베이시스 북은 1초 주기.
    pub last_basis_book_ms: AtomicU64,
    pub prices: DashMap<String, PriceWithAge>,
    pub etf_prices: DashMap<String, f64>,
    pub risk_cache: Arc<RiskParamsCache>,
    /// FV_futures 호가 유니버스 12종 (§13.3-A). matrix-config에서 로드.
    pub quote_universe: RwLock<Vec<QuoteUniverseEtf>>,
    /// 호가 파라미터. matrix-config 로드 + 5초 poll로 갱신.
    pub quote_params: RwLock<QuoteParams>,
    /// 지수선물 최신 상태 — product("kospi200"|"mini_k200"|"kosdaq150") → state. lock-free.
    pub index_futures: DashMap<String, IndexFuturesState>,
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
            ledger: RwLock::new(Vec::new()),
            last_basis_book_ms: AtomicU64::new(0),
            prices: DashMap::new(),
            etf_prices: DashMap::new(),
            risk_cache: Arc::new(RiskParamsCache::new()),
            quote_universe: RwLock::new(Vec::new()),
            quote_params: RwLock::new(QuoteParams::default()),
            index_futures: DashMap::new(),
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
            // 지수선물 (FC9) — product별 최신 상태 보관. FV_futures 앵커(§13.3-A).
            // product는 &'static str ("kospi200"|"mini_k200"|"kosdaq150").
            WsMessage::IndexFuturesTick(t) if t.price > 0.0 => {
                self.index_futures.insert(
                    t.product.to_string(),
                    IndexFuturesState {
                        code: t.code.clone(),
                        price: t.price,
                        underlying_index: t.underlying_index,
                        theory_price: t.theory_price,
                        updated_at_ms: now_ms,
                    },
                );
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

        // ─── FV_futures (호가 앵커, §13.3-A) — 유니버스 전체 1회 계산 ─────
        // 매트릭스 ③열(index_futures 셀)과 호가 보드가 이 결과를 공유.
        let universe = self.quote_universe.read().await;
        let quote_params = self.quote_params.read().await.clone();
        let today = chrono::Local::now().date_naive();
        let idx_snapshot: HashMap<String, IndexFuturesState> = self
            .index_futures
            .iter()
            .map(|r| (r.key().clone(), r.value().clone()))
            .collect();
        let mut fv_map: HashMap<String, FvFutures> = HashMap::with_capacity(universe.len());
        for etf in universe.iter() {
            let fv = compute_fv_futures(etf, &idx_snapshot, cost.base_rate_annual, now_ms, today);
            fv_map.insert(etf.code.clone(), fv);
        }

        // ETF 현재가 + 나이 조회 (EtfTick은 etf_prices, StockTick으로 온 ETF는 prices).
        // etf_prices는 나이 미보관 → 0(fresh). 한국 시장 마지막 체결가는 미체결이어도 유효.
        let etf_price_age = |code: &str| -> (f64, u32) {
            if let Some(p) = self.etf_prices.get(code) {
                return (*p, 0);
            }
            if let Some(p) = prices_snapshot.get(code) {
                let age = now_ms.saturating_sub(p.updated_at_ms).min(u32::MAX as u64) as u32;
                return (p.price, age);
            }
            (0.0, u32::MAX)
        };

        // ─── Fair value 매트릭스 ─────────────────────────────────────────
        let mut etf_snaps: Vec<EtfFairValueSnapshot> = Vec::with_capacity(etfs.len());
        for (etf_code, etf) in etfs.iter() {
            let etf_price = self.etf_prices.get(etf_code).map(|v| *v).unwrap_or(0.0);
            let mut cells: Vec<FairValueCell> = Vec::with_capacity(3);
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
            // 경로 ③ 지수선물 — 유니버스에 있고 FV 유효하면 셀 추가 (드디어 usable).
            if let Some(fv) = fv_map.get(etf_code) {
                if fv.no_quote_reason.is_empty() && fv.fair_value > 0.0 {
                    cells.push(index_futures_cell(etf_code, fv, etf_price, &cost, now_ms));
                }
            }
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

        // ─── 호가 보드 (§13.3-A) ─────────────────────────────────────────
        if !universe.is_empty() {
            let book = self.book.read().await;
            let rows: Vec<_> = universe
                .iter()
                .map(|etf| {
                    let fv = &fv_map[&etf.code];
                    let (price, age) = etf_price_age(&etf.code);
                    let qty = book.positions.get(&etf.code).copied().unwrap_or(0);
                    compute_quote_row(etf, fv, &quote_params, price, age, qty, cost.hold_days)
                })
                .collect();
            drop(book);
            let quote_snap = QuoteBoardSnapshot {
                rows,
                timestamp: now_iso.clone(),
            };
            if tx.try_send(WsMessage::QuoteBoard(quote_snap)).is_err() {
                MATRIX_TX_DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        }
        drop(universe);

        // ─── Book risk + 헤지 티켓 (§13.3-B) ────────────────────────────
        let risk = self.risk_cache.get().await;
        let book = self.book.read().await.clone();
        let mut book_risk_snap =
            compute_book_risk(&book, &prices_snapshot, risk.as_deref(), &now_iso);
        // 헤지 티켓 — 가족별 순 델타를 지수선물로 0 만드는 상시 계약. ETF 현재가는 etf_prices
        // (나이 無) 스냅샷, 기존 지수선물 델타는 idx_snapshot 가격으로 valuation.
        let etf_prices_snapshot: HashMap<String, f64> = self
            .etf_prices
            .iter()
            .map(|r| (r.key().clone(), *r.value()))
            .collect();
        let universe = self.quote_universe.read().await;
        // 주식선물 코드 → base 6자리 (원장 집계 base_code). M3 — 주식선물 델타를 base β로
        // 가족 분해에 포함해 델타중립 베이시스 페어의 중복 지수 헤지 티켓 차단.
        let ledger = self.ledger.read().await;
        let stock_fut_bases: HashMap<String, String> = ledger
            .iter()
            .filter(|a| a.instrument == "stock_fut")
            .filter_map(|a| a.base_code.clone().map(|b| (a.code.clone(), b)))
            .collect();
        book_risk_snap.hedge_tickets = compute_hedge_tickets(
            &book,
            &prices_snapshot,
            &etf_prices_snapshot,
            risk.as_deref(),
            &universe,
            &idx_snapshot,
            &stock_fut_bases,
            now_ms,
        );

        // ─── 베이시스 북 (§13.4) — 1초 주기 broadcast (200ms 불필요) ────────
        // book_risk의 헤지티켓(residual·existing) + 잔차위험을 그대로 소비 → 단일 소스.
        // basis_book 계산은 원장 aggregates(instrument·base_code·entry_basis)가 필요.
        let last_bb = self.last_basis_book_ms.load(Ordering::Relaxed);
        if now_ms.saturating_sub(last_bb) >= 1_000 {
            // 실보유 계약(front/back) 만기 매칭 소스 — mtime 캐시 Arc clone (cheap).
            let fut_by_code = super::basis_route::master_by_code();
            let basis_snap = compute_basis_book(
                &ledger,
                &prices_snapshot,
                &etf_prices_snapshot,
                &universe,
                &idx_snapshot,
                &book_risk_snap.hedge_tickets,
                book_risk_snap.residual_risk_krw,
                cost.base_rate_annual,
                &fut_by_code,
                now_ms,
                today,
                &now_iso,
            );
            self.last_basis_book_ms.store(now_ms, Ordering::Relaxed);
            if tx.try_send(WsMessage::BasisBook(basis_snap)).is_err() {
                MATRIX_TX_DROPPED.fetch_add(1, Ordering::Relaxed);
            }
        }
        drop(ledger);
        drop(universe);
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
        *self.quote_universe.write().await = cfg.quote_universe;
        *self.quote_params.write().await = cfg.quote_params;
        Ok(())
    }

    pub async fn poll_book_and_cost(&self, fastapi_base: &str) {
        let base = fastapi_base.trim_end_matches('/');
        let client = reqwest::Client::new();

        // ledger (§13.4 단일 소스) — aggregates에서 book(positions map) 파생 + 원장 캐시.
        // 기존 /api/lp/positions(flat dict)의 상위 집합: instrument·base_code·entry_basis 포함
        // → book_risk·hedge_ticket은 파생 positions로 무변경, 베이시스 북은 aggregates 소비.
        let url = format!("{}/api/lp/ledger", base);
        match client.get(&url).timeout(Duration::from_secs(10)).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(payload) = resp.json::<LedgerPayload>().await {
                    let positions: HashMap<String, i64> = payload
                        .aggregates
                        .iter()
                        .filter(|a| a.net_qty != 0)
                        .map(|a| (a.code.clone(), a.net_qty))
                        .collect();
                    let updated_at = payload.updated_at.clone().unwrap_or_default();
                    *self.book.write().await = DeskBook {
                        positions,
                        updated_at,
                    };
                    *self.ledger.write().await = payload.aggregates;
                }
            }
            Ok(resp) => warn!("ledger http {}", resp.status()),
            Err(e) => warn!("ledger fetch: {}", e),
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

        // quote-params (호가 파라미터 — UI 조정 즉시 반영)
        let url = format!("{}/api/lp/quote-params", base);
        match client.get(&url).timeout(Duration::from_secs(10)).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<QuoteParams>().await {
                    Ok(qp) => *self.quote_params.write().await = qp,
                    // 파싱 실패(스키마 어긋난 lp_quote_params.json 등) — 이전 값 유지 + 경고.
                    Err(e) => warn!("quote-params parse 실패 (이전 값 유지): {}", e),
                }
            }
            Ok(resp) => warn!("quote-params http {}", resp.status()),
            Err(e) => warn!("quote-params fetch: {}", e),
        }
    }
}

/// `GET /api/lp/ledger` 응답 — aggregates만 소비 (entries·names는 프론트 전용).
#[derive(Debug, Deserialize)]
struct LedgerPayload {
    #[serde(default)]
    aggregates: Vec<LedgerAgg>,
    updated_at: Option<String>,
}

/// 경로 ③ 지수선물 FairValueCell — FV_futures 재사용.
///
/// Level 3 비용: **tax_sell_bp = 0** — 이 경로의 매도 출구는 *ETF 매도(증권거래세 면제)* +
/// 선물 청산이라 20bp를 부과하면 매도 edge 과소평가. pdf_basket 경로는 출구가 바스켓
/// *주식* 매도(거래세 부과 대상)라 20bp 유지가 맞음 — 경로별 세제 차이가 곧 edge 차이.
fn index_futures_cell(
    etf_code: &str,
    fv: &FvFutures,
    etf_price: f64,
    cost: &CostInputs,
    now_ms: u64,
) -> FairValueCell {
    let cost_no_tax = CostInputs {
        tax_sell_bp: 0.0,
        ..*cost
    };
    let (net_fv_buy, net_fv_sell) = apply_level3_costs(fv.fair_value, &cost_no_tax);
    let (edge_buy_bp, edge_sell_bp) = if etf_price > 0.0 {
        (
            (etf_price - net_fv_buy) / etf_price * 10_000.0,
            (net_fv_sell - etf_price) / etf_price * 10_000.0,
        )
    } else {
        (0.0, 0.0)
    };
    FairValueCell {
        etf_code: etf_code.to_string(),
        route: HedgeRoute::IndexFutures {
            code: fv.futures_code.clone(),
        },
        fair_value: fv.fair_value,
        net_fv_buy,
        net_fv_sell,
        edge_buy_bp,
        edge_sell_bp,
        inputs_age_ms: fv.inputs_age_ms,
        inputs_covered_pct: 1.0,
        missing_components: Vec::new(),
        // ETF 틱 결측이면 edge 산출 불가 — pdf_basket과 대칭으로 usable=false
        // (pick_best가 이 셀을 best route로 뽑지 않게).
        usable: etf_price > 0.0,
        computed_at_ms: now_ms,
    }
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
        // usable + 유한 metric만 후보. NaN이 첫 인자면 reduce가 그대로 best로 굳을 수 있어
        // 사전에 차단 (Equal로 fallback해도 max 못 갱신해서 결과는 같지만 코드 의도 명확).
        .filter(|(_, c)| c.usable && metric(c).is_finite())
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
            // Skip: HTTP fetch가 5초보다 오래 걸리면 backlog 누적 안 되게 다음 cycle은 skip.
            tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                // quote_universe도 복구 조건 — backend bootstrap 시점 build_quote_universe()가
                // 일시 실패(risk 회귀/DB)해 빈 배열이면, etfs만 봐선 영영 재fetch 안 됨.
                if st.etfs.read().await.is_empty()
                    || st.quote_universe.read().await.is_empty()
                {
                    match st.refresh_matrix_config(&fb).await {
                        Ok(()) => info!(
                            "lp matrix-config 복구: {} ETF / quote_universe {}",
                            st.etfs.read().await.len(),
                            st.quote_universe.read().await.len()
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

