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
use tracing::{debug, info, warn};

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
use super::pnl::compute_pnl;
use super::quote_board::{
    compute_fv_futures, compute_quote_row, FvFutures, IndexFuturesState, QuoteParams,
    QuoteUniverseEtf, MID_FRESH_MS,
};
use super::{
    apply_level3_costs, pdf_basket, stock_futures_intersect, CostInputs, EtfStaticInput,
    FillMark, LedgerAgg, LedgerEntry, MatrixConfig, PriceMap, PriceWithAge,
};

/// markout POST 유예 (ms) — due 시각으로부터 이 안에 처리해야 기록. poll(5s) 지터는
/// 흡수하되, Rust가 window 통과 중 죽었다 뒤늦게 뜬 경우는 초과 → 미기록(§13.3-C 정직).
const MARK_GRACE_MS: u64 = 180_000;

/// markout horizon 정의 — (라벨, fill 후 경과 ms).
const MARK_HORIZONS: [(&str, u64); 2] = [("5m", 300_000), ("30m", 1_800_000)];

/// markout 스냅샷 가격 신선도 한도 (ms) — 마크 시점 가격이 이보다 오래되면 기록 skip.
/// 장 마감 직전 fill의 30m due가 마감 후 도래하면 정지된 종가가 markout으로 무경고
/// 기록되는 문제 차단. skip된 마크는 유예(MARK_GRACE_MS) 내 재시도, 초과 시 미기록(정직).
const MARK_PRICE_MAX_AGE_MS: u64 = 60_000;

/// 코드별 "당일 첫 관측가" — 비유니버스 포지션 MTM 전일종가 프록시 (§13.3-C).
/// 날짜가 바뀌면 첫 틱으로 리셋 (handle_tick).
#[derive(Debug, Clone, Copy)]
pub struct DayOpen {
    pub date: chrono::NaiveDate,
    pub price: f64,
}

/// ETF 최우선 호가 스냅샷 (§13.13 MID 기반) — OrderbookTick에서 갱신. mid = (bid+ask)/2.
/// 갱신 나이(MID_FRESH_MS)로 quote_board가 mid/last 소스를 결정.
#[derive(Debug, Clone, Copy)]
pub struct OrderbookQuote {
    pub best_bid: f64,
    pub best_ask: f64,
    pub updated_at_ms: u64,
}

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
    /// 원장 엔트리 (§13.3-C P&L 스프레드·markout 소스). 5초 poll이 채움.
    pub ledger_entries: RwLock<Vec<LedgerEntry>>,
    /// 당일 fill 마크 (markout 통계·dedup). 5초 poll이 채움.
    pub fill_marks: RwLock<Vec<FillMark>>,
    /// 코드별 당일 첫 관측가 (비유니버스 MTM 프록시). handle_tick이 lock-free 갱신.
    pub day_open: DashMap<String, DayOpen>,
    /// ETF 코드 → 최신 FV_futures (markout 스냅샷 시 FV 첨부용). flush가 갱신.
    pub last_fv: DashMap<String, f64>,
    /// basis_book broadcast 마지막 시각 (ms) — flush는 200ms지만 베이시스 북은 1초 주기.
    pub last_basis_book_ms: AtomicU64,
    pub prices: DashMap<String, PriceWithAge>,
    /// ETF 현재가 (EtfTick). PriceWithAge — markout 신선도 가드가 age를 봐야 함.
    /// 호가 보드 표시 나이는 기존 철학(마지막 체결가 유효 → 0) 유지 (etf_price_age 참조).
    pub etf_prices: DashMap<String, PriceWithAge>,
    /// markout POST 등 재사용 HTTP 클라이언트 (poll마다 재생성 방지 — 커넥션 풀 유지).
    pub http: reqwest::Client,
    /// 프로세스가 장중(평일 09:00~15:45 KST)에 시작됐는지 — day_open이 재시작 후 첫
    /// 관측가가 되어 폴백 MTM이 왜곡될 수 있음 (caveat 표기용).
    pub started_mid_session: bool,
    pub risk_cache: Arc<RiskParamsCache>,
    /// FV_futures 호가 유니버스 12종 (§13.3-A). matrix-config에서 로드.
    pub quote_universe: RwLock<Vec<QuoteUniverseEtf>>,
    /// 호가 파라미터. matrix-config 로드 + 5초 poll로 갱신.
    pub quote_params: RwLock<QuoteParams>,
    /// 지수선물 최신 상태 — product("kospi200"|"mini_k200"|"kosdaq150") → state. lock-free.
    pub index_futures: DashMap<String, IndexFuturesState>,
    /// ETF 최우선 호가 (§13.13 MID) — code → (best_bid, best_ask, age). H1_/HA_ OrderbookTick으로
    /// 갱신. quote_board가 fresh mid면 갭 기준가로 last 대신 사용. lock-free. 구독 코드만 채워짐.
    pub etf_orderbooks: DashMap<String, OrderbookQuote>,
}

impl Default for MatrixState {
    fn default() -> Self {
        Self::new()
    }
}

impl MatrixState {
    pub fn new() -> Self {
        // 장중 재시작 감지 (평일 09:00~15:45 KST) — day_open 폴백 MTM 왜곡 caveat용.
        let started_mid_session = {
            use chrono::{Datelike, Timelike, Weekday};
            let now = chrono::Local::now();
            let mins = now.hour() * 60 + now.minute();
            !matches!(now.weekday(), Weekday::Sat | Weekday::Sun) && (540..=945).contains(&mins)
        };
        Self {
            etfs: RwLock::new(HashMap::new()),
            cost: RwLock::new(DEFAULT_COST_INPUTS),
            book: RwLock::new(DeskBook {
                positions: HashMap::new(),
                updated_at: "init".into(),
            }),
            ledger: RwLock::new(Vec::new()),
            ledger_entries: RwLock::new(Vec::new()),
            fill_marks: RwLock::new(Vec::new()),
            day_open: DashMap::new(),
            last_fv: DashMap::new(),
            last_basis_book_ms: AtomicU64::new(0),
            prices: DashMap::new(),
            etf_prices: DashMap::new(),
            http: reqwest::Client::new(),
            started_mid_session,
            risk_cache: Arc::new(RiskParamsCache::new()),
            quote_universe: RwLock::new(Vec::new()),
            quote_params: RwLock::new(QuoteParams::default()),
            index_futures: DashMap::new(),
            etf_orderbooks: DashMap::new(),
        }
    }

    /// 메시지 한 건 처리 — 가격 dictionary 갱신. sync, lock-free.
    /// bridge 루프 안에서 직접 호출 (cheap).
    pub fn handle_tick(&self, msg: &WsMessage) {
        let now_ms = current_ms();
        let today = chrono::Local::now().date_naive();
        match msg {
            WsMessage::StockTick(t) if t.price > 0.0 => {
                self.prices.insert(
                    t.code.clone(),
                    PriceWithAge {
                        price: t.price,
                        updated_at_ms: now_ms,
                    },
                );
                self.record_day_open(&t.code, t.price, today);
            }
            WsMessage::FuturesTick(t) if t.price > 0.0 => {
                self.prices.insert(
                    t.code.clone(),
                    PriceWithAge {
                        price: t.price,
                        updated_at_ms: now_ms,
                    },
                );
                self.record_day_open(&t.code, t.price, today);
            }
            WsMessage::EtfTick(t) if t.price > 0.0 => {
                self.etf_prices.insert(
                    t.code.clone(),
                    PriceWithAge {
                        price: t.price,
                        updated_at_ms: now_ms,
                    },
                );
                self.record_day_open(&t.code, t.price, today);
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
                // 지수선물 포지션 MTM 프록시 — 코드별 첫 관측가 (전일종가 대체 없음).
                self.record_day_open(&t.code, t.price, today);
            }
            // ETF 호가 (H1_/HA_) — 최우선 bid/ask 저장 (§13.13 MID 기준가). 구독된 코드만
            // OrderbookTick이 오므로 map은 구독 범위로 자연 제한. 나이로 mid/last 소스 결정.
            WsMessage::OrderbookTick(t) => {
                let best_bid = t.bids.first().map(|l| l.price).unwrap_or(0.0);
                let best_ask = t.asks.first().map(|l| l.price).unwrap_or(0.0);
                if best_bid > 0.0 || best_ask > 0.0 {
                    self.etf_orderbooks.insert(
                        t.code.clone(),
                        OrderbookQuote {
                            best_bid,
                            best_ask,
                            updated_at_ms: now_ms,
                        },
                    );
                }
            }
            _ => {}
        }
    }

    /// 코드별 당일 첫 관측가 기록 — 이미 오늘 값이 있으면 no-op, 날짜가 바뀌면 리셋.
    fn record_day_open(&self, code: &str, price: f64, today: chrono::NaiveDate) {
        match self.day_open.get(code) {
            Some(d) if d.date == today => {} // 이미 오늘 첫 값 있음
            _ => {
                self.day_open
                    .insert(code.to_string(), DayOpen { date: today, price });
            }
        }
    }

    /// 코드 현재가 — etf_prices(EtfTick) → prices(StockTick/선물) → index_futures(코드 매칭) 순.
    /// MTM cur_price 통합 조회 (신선도 무관 — 마지막 체결가 유효 철학). 없으면 0.
    fn current_price_of(&self, code: &str, idx_by_code: &HashMap<String, f64>) -> f64 {
        if let Some(p) = self.etf_prices.get(code) {
            if p.price > 0.0 {
                return p.price;
            }
        }
        if let Some(p) = self.prices.get(code) {
            if p.price > 0.0 {
                return p.price;
            }
        }
        idx_by_code.get(code).copied().unwrap_or(0.0)
    }

    /// markout용 **신선 가격** — age ≤ max_age인 소스만 채택 (없으면 None → 마크 skip).
    /// MTM용 current_price_of와 달리 신선도를 강제 — 장 마감 후 due 마크가 정지 종가를
    /// 무경고 기록하는 것 차단. idx_by_code는 (price, updated_at_ms).
    fn fresh_price_of(
        &self,
        code: &str,
        idx_by_code: &HashMap<String, (f64, u64)>,
        now_ms: u64,
        max_age_ms: u64,
    ) -> Option<f64> {
        if let Some(p) = self.etf_prices.get(code) {
            if p.price > 0.0 && now_ms.saturating_sub(p.updated_at_ms) <= max_age_ms {
                return Some(p.price);
            }
        }
        if let Some(p) = self.prices.get(code) {
            if p.price > 0.0 && now_ms.saturating_sub(p.updated_at_ms) <= max_age_ms {
                return Some(p.price);
            }
        }
        if let Some(&(p, ts)) = idx_by_code.get(code) {
            if p > 0.0 && now_ms.saturating_sub(ts) <= max_age_ms {
                return Some(p);
            }
        }
        None
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
            // markout FV 스냅샷용 최신 FV 보관 (유효할 때만 — stale/결측이면 이전값 유지).
            if fv.no_quote_reason.is_empty() && fv.fair_value > 0.0 {
                self.last_fv.insert(etf.code.clone(), fv.fair_value);
            }
            fv_map.insert(etf.code.clone(), fv);
        }

        // ETF 현재가 + 나이 조회 (EtfTick은 etf_prices, StockTick으로 온 ETF는 prices).
        // etf_prices 나이는 표시용으로 0(fresh) 유지 — 한국 시장 마지막 체결가는 미체결이어도
        // 유효 (기존 철학). 실제 age는 markout 신선도 가드(fresh_price_of)만 사용.
        let etf_price_age = |code: &str| -> (f64, u32) {
            if let Some(p) = self.etf_prices.get(code) {
                return (p.price, 0);
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
            let etf_price = self.etf_prices.get(etf_code).map(|v| v.price).unwrap_or(0.0);
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
                    // 호가 mid — 최근(MID_FRESH_MS 내) 갱신이면 fresh. best_bid/ask는 나이 무관
                    // 표시용으로 항상 전달 (stale이면 source=last지만 참고값은 노출).
                    let (best_bid, best_ask, mid_fresh) = match self.etf_orderbooks.get(&etf.code) {
                        Some(ob) => {
                            let fresh = now_ms.saturating_sub(ob.updated_at_ms) <= MID_FRESH_MS
                                && ob.best_bid > 0.0
                                && ob.best_ask > 0.0;
                            (ob.best_bid, ob.best_ask, fresh)
                        }
                        None => (0.0, 0.0, false),
                    };
                    compute_quote_row(
                        etf,
                        fv,
                        &quote_params,
                        price,
                        age,
                        best_bid,
                        best_ask,
                        mid_fresh,
                        qty,
                        cost.hold_days,
                    )
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
            .map(|r| (r.key().clone(), r.value().price))
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

            // ─── P&L 5분해 (§13.3-C) — basis_snap·book_risk 소비, 같은 1초 주기 ────
            // cur_price/prev_close/etf_notionals를 book 포지션 기준으로 통합 구성.
            let idx_by_code: HashMap<String, f64> = idx_snapshot
                .values()
                .map(|s| (s.code.clone(), s.price))
                .collect();
            let universe_prev: HashMap<&str, f64> = universe
                .iter()
                .filter_map(|e| e.prev_close.map(|pc| (e.code.as_str(), pc)))
                .collect();
            let universe_codes: std::collections::HashSet<&str> =
                universe.iter().map(|e| e.code.as_str()).collect();
            let entries = self.ledger_entries.read().await;
            let mut cur_price: HashMap<String, f64> = HashMap::new();
            let mut prev_close: HashMap<String, (f64, bool)> = HashMap::new();
            let mut etf_notionals: HashMap<String, f64> = HashMap::new();
            // baseline 단일 소스 헬퍼 — 포지션 항과 fill 항이 같은 기준가를 써야
            // 왕복/신규진입에서 정확히 소거됨 (C1). 유니버스 EOD → day_open 폴백 순.
            let put_baseline = |code: &str, prev_close: &mut HashMap<String, (f64, bool)>| {
                if prev_close.contains_key(code) {
                    return;
                }
                if let Some(&pc) = universe_prev.get(code) {
                    prev_close.insert(code.to_string(), (pc, false));
                } else if let Some(d) = self.day_open.get(code) {
                    if d.date == today && d.price > 0.0 {
                        prev_close.insert(code.to_string(), (d.price, true));
                    }
                }
            };
            for (code, &qty) in &book.positions {
                if qty == 0 {
                    continue;
                }
                let p = self.current_price_of(code, &idx_by_code);
                if p > 0.0 {
                    cur_price.insert(code.clone(), p);
                    if universe_codes.contains(code.as_str()) {
                        etf_notionals.insert(code.clone(), (qty as f64 * p).abs());
                    }
                }
                put_baseline(code, &mut prev_close);
            }
            // 당일 fill 코드도 기준가 필요 (C1) — 왕복(포지션 0)·청산 fill의 실현손익 항.
            let today_prefix = today.format("%Y-%m-%d").to_string();
            for e in entries.iter() {
                if e.kind == "fill" && e.ts.get(0..10) == Some(today_prefix.as_str()) {
                    put_baseline(&e.code, &mut prev_close);
                }
            }
            // 코드 → instrument (캐리 선물 제외 판정 — M1).
            let instruments: HashMap<String, String> = ledger
                .iter()
                .map(|a| (a.code.clone(), a.instrument.clone()))
                .collect();
            let marks = self.fill_marks.read().await;
            let day_fraction = {
                use chrono::Timelike;
                chrono::Local::now().num_seconds_from_midnight() as f64 / 86_400.0
            };
            let pnl_snap = compute_pnl(
                &entries,
                &marks,
                today,
                &book,
                &cur_price,
                &prev_close,
                &etf_notionals,
                &instruments,
                &basis_snap,
                &book_risk_snap,
                &quote_params,
                cost.base_rate_annual,
                day_fraction,
                self.started_mid_session,
                &now_iso,
            );
            drop(entries);
            drop(marks);

            if tx.try_send(WsMessage::BasisBook(basis_snap)).is_err() {
                MATRIX_TX_DROPPED.fetch_add(1, Ordering::Relaxed);
            }
            if tx.try_send(WsMessage::PnlDecomp(pnl_snap)).is_err() {
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
        let client = &self.http; // 재사용 (poll마다 재생성 방지)

        // ledger (§13.4 단일 소스) — aggregates에서 book(positions map) 파생 + 원장 캐시.
        // 기존 /api/lp/positions(flat dict)의 상위 집합: instrument·base_code·entry_basis 포함
        // → book_risk·hedge_ticket은 파생 positions로 무변경, 베이시스 북은 aggregates 소비.
        // entries는 §13.3-C P&L(스프레드·markout) 소스.
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
                    *self.ledger_entries.write().await = payload.entries;
                }
            }
            Ok(resp) => warn!("ledger http {}", resp.status()),
            Err(e) => warn!("ledger fetch: {}", e),
        }

        // fill-marks (§13.3-C markout) — 당일 마크. markout 통계 + due 마크 dedup 소스.
        let url = format!("{}/api/lp/fill-marks?date=today", base);
        match client.get(&url).timeout(Duration::from_secs(10)).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(payload) = resp.json::<FillMarksPayload>().await {
                    *self.fill_marks.write().await = payload.marks;
                }
            }
            Ok(resp) => warn!("fill-marks http {}", resp.status()),
            Err(e) => warn!("fill-marks fetch: {}", e),
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

    /// markout 처리 (poll 기반, §13.3-C). 당일 fill × horizon(5m/30m)에 대해 due(경과 + 유예
    /// 내)이면서 아직 기록 안 된 마크를 현재가·FV 스냅샷 → backend POST (재시도 1회).
    ///
    /// poll(5s) 주기로 due를 검사하므로 마킹은 horizon 도달 후 최대 ~5초 지연. 유예(MARK_GRACE_MS)
    /// 초과분(= Rust가 window 통과 중 죽었다 뒤늦게 기동)은 미기록 — 소급 불가를 정직 반영.
    /// dedup은 backend fill-marks (fill_id, horizon) UNIQUE + 여기 existing 셋 이중.
    async fn process_markouts(&self, fastapi_base: &str) {
        let base = fastapi_base.trim_end_matches('/');
        let today = chrono::Local::now().date_naive();
        let today_prefix = today.format("%Y-%m-%d").to_string();
        let now_ms = current_ms();

        let entries = self.ledger_entries.read().await.clone();
        let existing: std::collections::HashSet<(String, String)> = self
            .fill_marks
            .read()
            .await
            .iter()
            .map(|m| (m.fill_id.clone(), m.horizon.clone()))
            .collect();

        let mut due: Vec<(String, String, String)> = Vec::new(); // (fill_id, horizon, code)
        for e in entries.iter() {
            if e.kind != "fill" || e.ts.get(0..10) != Some(today_prefix.as_str()) {
                continue;
            }
            let Some(fill_ms) = parse_local_iso_ms(&e.ts) else {
                continue;
            };
            for (h, dur) in MARK_HORIZONS {
                if existing.contains(&(e.id.clone(), h.to_string())) {
                    continue;
                }
                let due_ms = fill_ms + dur;
                if now_ms >= due_ms && now_ms.saturating_sub(due_ms) <= MARK_GRACE_MS {
                    due.push((e.id.clone(), h.to_string(), e.code.clone()));
                }
            }
        }
        if due.is_empty() {
            return;
        }

        let idx_by_code: HashMap<String, (f64, u64)> = self
            .index_futures
            .iter()
            .map(|r| (r.value().code.clone(), (r.value().price, r.value().updated_at_ms)))
            .collect();
        for (fill_id, horizon, code) in due {
            // 신선도 가드 — 마크 시점 가격 age > 60s면 skip (유예 내 재시도, 초과 시 미기록).
            // 장 마감 후 30m due가 정지 종가를 markout으로 무경고 기록하는 것 차단.
            let Some(price) =
                self.fresh_price_of(&code, &idx_by_code, now_ms, MARK_PRICE_MAX_AGE_MS)
            else {
                debug!(
                    "markout skip — 가격 stale/결측 (>{}s): fill={} horizon={} code={}",
                    MARK_PRICE_MAX_AGE_MS / 1000,
                    fill_id,
                    horizon,
                    code
                );
                continue;
            };
            let fv = self.last_fv.get(&code).map(|v| *v);
            let mut ok =
                post_fill_mark(&self.http, base, &fill_id, &horizon, Some(price), fv).await;
            if !ok {
                ok = post_fill_mark(&self.http, base, &fill_id, &horizon, Some(price), fv).await;
            }
            if !ok {
                warn!("markout POST 실패 (재시도 후): fill={} horizon={}", fill_id, horizon);
            }
        }
    }
}

/// "YYYY-MM-DDTHH:MM:SS" (로컬 tz 없음, backend datetime.now().isoformat) → epoch ms.
fn parse_local_iso_ms(ts: &str) -> Option<u64> {
    use chrono::TimeZone;
    let naive = chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%dT%H:%M:%S").ok()?;
    let dt = chrono::Local.from_local_datetime(&naive).single()?;
    let ms = dt.timestamp_millis();
    if ms < 0 {
        None
    } else {
        Some(ms as u64)
    }
}

/// markout 1건 POST. 성공(2xx) 여부 반환. price/fv는 null 허용.
async fn post_fill_mark(
    client: &reqwest::Client,
    base: &str,
    fill_id: &str,
    horizon: &str,
    price: Option<f64>,
    fv: Option<f64>,
) -> bool {
    let url = format!("{}/api/lp/fill-marks", base);
    let body = serde_json::json!({
        "fill_id": fill_id,
        "horizon": horizon,
        "price": price,
        "fv": fv,
    });
    match client
        .post(&url)
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => true,
        Ok(r) => {
            warn!("markout POST http {}", r.status());
            false
        }
        Err(e) => {
            warn!("markout POST err: {}", e);
            false
        }
    }
}

/// `GET /api/lp/ledger` 응답 — aggregates(베이시스 북·book_risk) + entries(P&L).
#[derive(Debug, Deserialize)]
struct LedgerPayload {
    #[serde(default)]
    aggregates: Vec<LedgerAgg>,
    #[serde(default)]
    entries: Vec<LedgerEntry>,
    updated_at: Option<String>,
}

/// `GET /api/lp/fill-marks` 응답.
#[derive(Debug, Deserialize)]
struct FillMarksPayload {
    #[serde(default)]
    marks: Vec<FillMark>,
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
                // markout 처리 (§13.3-C) — poll 직후 최신 entries·marks로 due 마크 POST.
                st.process_markouts(&fb).await;
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

