use std::collections::{HashMap, HashSet};

use chrono::Utc;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick, OrderbookLevel, OrderbookTick, StockTick};

use super::{MarketFeed, SubCommand};

#[derive(Deserialize, Clone)]
struct PdfStock { code: String, #[allow(dead_code)] name: String, qty: i64 }

#[derive(Deserialize, Clone)]
struct PdfEtf {
    #[allow(dead_code)] code: String,
    #[allow(dead_code)] name: Option<String>,
    cu_unit: Option<i64>,
    cash: i64,
    stocks: Vec<PdfStock>,
}

#[derive(Deserialize)]
struct PdfAllResponse {
    items: HashMap<String, PdfEtf>,
}

/// 백엔드 /api/etfs/pdf-all 가져오기. mock이 ETF NAV를 PDF basket 기반으로 계산하기 위함.
async fn fetch_pdf_map() -> HashMap<String, PdfEtf> {
    let url = "http://localhost:8100/api/etfs/pdf-all";
    let res = match reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(3))
        .send().await {
        Ok(r) => r,
        Err(e) => { warn!("Mock PDF fetch failed: {e}"); return HashMap::new(); }
    };
    match res.json::<PdfAllResponse>().await {
        Ok(p) => {
            info!("Mock PDF loaded: {} ETFs", p.items.len());
            p.items
        }
        Err(e) => { warn!("Mock PDF parse failed: {e}"); HashMap::new() }
    }
}

/// FNV-1a 해시 (deterministic per code).
fn fnv(code: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in code.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// 코드별 결정적 base price. 1,000 ~ 200,000원 분포. tick size에 정렬.
fn deterministic_base(code: &str) -> f64 {
    let r = (fnv(code) % 199_000) as f64 + 1_000.0;
    let ts = tick_size(r);
    (r / ts).round() * ts
}

/// KRX 호가 단위.
fn tick_size(price: f64) -> f64 {
    if price < 2_000.0 { 1.0 }
    else if price < 5_000.0 { 5.0 }
    else if price < 20_000.0 { 10.0 }
    else if price < 50_000.0 { 50.0 }
    else if price < 200_000.0 { 100.0 }
    else if price < 500_000.0 { 500.0 }
    else { 1_000.0 }
}

/// 가격 random walk — 매우 작은 gauss noise + base로 mean revert + tick 단위 snap.
/// std 0.5bp라 대부분 1틱 미만 움직임 → snap 결과 prev 그대로 유지되는 경우 많음.
/// 검증 시 ETF/NAV 안정 → derived 컬럼도 안정.
fn walk_price(prev: f64, base: f64, rng: &mut impl Rng) -> f64 {
    let noise = gauss(rng, 0.00005) * prev;      // ±0.5bp 가우시안
    let revert = (base - prev) * 0.005;          // 0.5% 평균 회귀
    let raw = prev + noise + revert;
    let lo = base * 0.95;
    let hi = base * 1.05;
    let bounded = raw.clamp(lo, hi);
    snap(bounded)
}

/// 호가 단위에 맞춰 가격 정렬.
fn snap(price: f64) -> f64 {
    let ts = tick_size(price);
    (price / ts).round() * ts
}

fn make_etf_tick(code: &str, price: f64, nav: f64, rng: &mut impl Rng) -> EtfTick {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    EtfTick {
        code: code.to_string(), name: code.to_string(),
        price: snap(price),
        nav: round2(nav),
        spread_bp: round2((price - nav) / nav * 10000.0),
        spread_bid_bp: 0.0, spread_ask_bp: 0.0,
        volume: rng.random_range(1_000..50_000),
        timestamp: now,
    }
}

fn make_stock_tick(code: &str, price: f64, base: f64, rng: &mut impl Rng) -> StockTick {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    StockTick {
        code: code.to_string(), name: code.to_string(),
        price: snap(price),
        volume: rng.random_range(100..10_000),
        cum_volume: (base * (rng.random_range(1_000..50_000) as f64)) as u64,
        timestamp: now,
        is_initial: false,
        high: Some(snap(base * 1.012)),
        low: Some(snap(base * 0.988)),
        prev_close: Some(snap(base * 0.995)),
    }
}

fn make_futures_tick(code: &str, fut_price: f64, underlying: f64, base: f64, rng: &mut impl Rng) -> FuturesTick {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    FuturesTick {
        code: code.to_string(), name: code.to_string(),
        price: round2(fut_price),
        underlying_price: round2(underlying),
        basis: round2(fut_price - underlying),
        volume: rng.random_range(100..5_000),
        is_initial: false,
        timestamp: now,
        open_interest: Some((base * 50.0) as i64),
        open_interest_change: Some(0),
    }
}

/// 선물 base 베이시스 결정 (콘탱고/백워데이션/근사 zero) — 코드별 고정.
fn futures_basis_bias(code: &str) -> f64 {
    match fnv(code) % 3 {
        0 => 0.003,    // 콘탱고 ~30bp
        1 => -0.003,   // 백워데이션 ~-30bp
        _ => 0.0,
    }
}

struct MockEtf {
    code: &'static str,
    name: &'static str,
    base_price: f64,
}

struct MockStock {
    code: &'static str,
    name: &'static str,
    base_price: f64,
}

struct MockFuture {
    code: &'static str,
    name: &'static str,
    base_price: f64,
}

static MOCK_ETFS: &[MockEtf] = &[
    MockEtf { code: "069500", name: "KODEX 200", base_price: 35000.0 },
    MockEtf { code: "102110", name: "TIGER 200", base_price: 35200.0 },
    MockEtf { code: "229200", name: "KODEX 코스닥150", base_price: 12500.0 },
    MockEtf { code: "251340", name: "KODEX 코스닥150레버리지", base_price: 8900.0 },
    MockEtf { code: "114800", name: "KODEX 인버스", base_price: 5200.0 },
    MockEtf { code: "252670", name: "KODEX 200선물인버스2X", base_price: 2800.0 },
    MockEtf { code: "091160", name: "KODEX 반도체", base_price: 42000.0 },
    MockEtf { code: "091170", name: "KODEX 은행", base_price: 9500.0 },
];

static MOCK_STOCKS: &[MockStock] = &[
    MockStock { code: "005930", name: "삼성전자", base_price: 58000.0 },
    MockStock { code: "000660", name: "SK하이닉스", base_price: 135000.0 },
    MockStock { code: "035420", name: "NAVER", base_price: 210000.0 },
];

static MOCK_FUTURES: &[MockFuture] = &[
    MockFuture { code: "101S6", name: "KOSPI200 근월물", base_price: 350.0 },
    MockFuture { code: "101S9", name: "KOSPI200 원월물", base_price: 351.5 },
    MockFuture { code: "106S6", name: "KOSDAQ150 근월물", base_price: 1250.0 },
];

pub struct MockFeed;

impl MarketFeed for MockFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, mut sub_rx: mpsc::UnboundedReceiver<SubCommand>, cancel: CancellationToken) {
        let mut rng = StdRng::from_os_rng();
        // 백엔드에서 PDF 가져옴 (NAV를 basket 합으로 계산하기 위해).
        let pdf_map = fetch_pdf_map().await;
        // 호가 구독: (code, base, levels) — base_price는 첫 구독 시 결정
        let mut ob_subs: Vec<(String, f64, usize)> = Vec::new();
        // 동적 구독 코드 셋 + 코드별 현재 가격 상태 (random walk 누적)
        let mut subscribed_stocks: HashSet<String> = HashSet::new();
        let mut subscribed_inav: HashSet<String> = HashSet::new();
        let mut subscribed_futures: HashSet<String> = HashSet::new();
        let mut stock_prices: HashMap<String, f64> = HashMap::new();   // 현재가
        let mut etf_navs: HashMap<String, f64> = HashMap::new();        // NAV (basket 기반)
        let mut futures_prices: HashMap<String, f64> = HashMap::new();  // 선물가

        // PDF 기반 NAV 계산: ETF 코드 → 현재 stock_prices로 basket 합 / cu_unit.
        let compute_basket_nav = |code: &str, stock_prices: &HashMap<String, f64>| -> Option<f64> {
            let pdf = pdf_map.get(code)?;
            let cu_unit = pdf.cu_unit? as f64;
            if cu_unit <= 0.0 { return None; }
            let mut sum = pdf.cash as f64;
            for s in &pdf.stocks {
                if s.qty <= 0 { continue; }
                let p = stock_prices.get(&s.code).copied().unwrap_or_else(|| deterministic_base(&s.code));
                sum += p * s.qty as f64;
            }
            Some(sum / cu_unit)
        };

        // I5_ NAV 발행 주기 (실제 거래소 ~10초). tick 카운트로 측정 (500ms × 20 = 10초).
        let mut iter_count: u32 = 0;

        loop {
            iter_count = iter_count.wrapping_add(1);
            let do_inav = iter_count % 20 == 0;

            // 매 iter마다 5%만 update (~150 코드/3000)
            let update_one = |set: &HashSet<String>, rng: &mut StdRng| -> Vec<String> {
                if set.is_empty() { return Vec::new(); }
                let n = (set.len() / 20).max(1).min(500);
                set.iter().filter(|_| rng.random::<f64>() < 0.05)
                    .take(n).cloned().collect()
            };

            // ── 주식/ETF 가격 walk (subscribed_stocks 기준) ──
            // ETF의 경우: 가격은 basket-derived NAV ± 작은 noise. 일반 주식은 base ± walk.
            let stocks_to_update = update_one(&subscribed_stocks, &mut rng);
            for code in &stocks_to_update {
                let base = deterministic_base(code);
                let prev = *stock_prices.get(code).unwrap_or(&base);
                let next = walk_price(prev, base, &mut rng);
                stock_prices.insert(code.clone(), next);

                // ETF인지 (inav 셋에 있는지)로 분기. ETF면 NAV는 basket 기반.
                let msg = if subscribed_inav.contains(code) {
                    let nav = compute_basket_nav(code, &stock_prices)
                        .unwrap_or_else(|| *etf_navs.get(code).unwrap_or(&base));
                    etf_navs.insert(code.clone(), nav);
                    // ETF 가격은 NAV ± 1bp 이내 (premium/discount)
                    let price = snap(nav * (1.0 + gauss(&mut rng, 0.00005)));
                    stock_prices.insert(code.clone(), price);
                    WsMessage::EtfTick(make_etf_tick(code, price, nav, &mut rng))
                } else {
                    WsMessage::StockTick(make_stock_tick(code, next, base, &mut rng))
                };
                if tx.send(msg).await.is_err() { return; }
            }

            // ── ETF NAV 갱신 (~10초마다) — basket 합 / cu_unit ──
            if do_inav {
                for code in subscribed_inav.iter().cloned().collect::<Vec<_>>() {
                    let nav = match compute_basket_nav(&code, &stock_prices) {
                        Some(v) => v,
                        None => continue,  // PDF 미발견 (mock 시작 전 backend 미준비 등) → 패스
                    };
                    etf_navs.insert(code.clone(), nav);
                    let price = stock_prices.get(&code).copied().unwrap_or(nav);
                    let msg = WsMessage::EtfTick(make_etf_tick(&code, price, nav, &mut rng));
                    if tx.send(msg).await.is_err() { return; }
                }
            }

            // ── 선물 가격 walk ──
            let futures_to_update = update_one(&subscribed_futures, &mut rng);
            for code in &futures_to_update {
                // 선물 base = 기초자산 base의 ±0.3% (콘탱고/백워데이션) ※ 선물 코드는 6자리 stock과 별개로 base 결정
                let base_underlying = deterministic_base(code);
                let bias = futures_basis_bias(code);
                let base_fut = base_underlying * (1.0 + bias);
                let prev = *futures_prices.get(code).unwrap_or(&base_fut);
                let next_fut = walk_price(prev, base_fut, &mut rng);
                futures_prices.insert(code.clone(), next_fut);
                // underlying은 별도 walk (현물은 stocks 셋에서 따로 push)
                let underlying = *stock_prices.get(code).unwrap_or(&base_underlying);
                let msg = WsMessage::FuturesTick(make_futures_tick(code, next_fut, underlying, base_underlying, &mut rng));
                if tx.send(msg).await.is_err() { return; }
            }

            // ── 호가 (ob_subs) — 5% 샘플 ──
            let ob_sample: Vec<(String, f64, usize)> = ob_subs.iter()
                .filter(|_| rng.random::<f64>() < 0.05)
                .cloned()
                .collect();
            for (code, base, levels) in &ob_sample {
                let mid_seed = *stock_prices.get(code).unwrap_or(base);
                let mid = walk_price(mid_seed, *base, &mut rng);
                let ts = tick_size(mid);
                let mut asks = Vec::with_capacity(*levels);
                let mut bids = Vec::with_capacity(*levels);
                let mut total_ask = 0u64;
                let mut total_bid = 0u64;
                for i in 0..*levels {
                    let aq = rng.random_range(100..5_000);
                    let bq = rng.random_range(100..5_000);
                    asks.push(OrderbookLevel { price: snap(mid + ts * (i as f64 + 1.0)), quantity: aq });
                    bids.push(OrderbookLevel { price: snap(mid - ts * (i as f64)), quantity: bq });
                    total_ask += aq;
                    total_bid += bq;
                }
                let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
                let msg = WsMessage::OrderbookTick(OrderbookTick {
                    code: code.clone(), name: code.clone(),
                    asks, bids, total_ask_qty: total_ask, total_bid_qty: total_bid,
                    timestamp: now,
                });
                if tx.send(msg).await.is_err() { return; }
            }

            // ── 하드코딩 종목들 (이전 호환 유지) ──
            // stock-arbitrage / dashboard 등 다른 페이지가 이걸 참조할 수 있어서 그대로 유지.
            // 단 매 iter마다 보내지 않고 ~10% 확률로만.
            if rng.random::<f64>() < 0.1 {
                for etf in MOCK_ETFS {
                    let prev = *stock_prices.get(etf.code).unwrap_or(&etf.base_price);
                    let next = walk_price(prev, etf.base_price, &mut rng);
                    stock_prices.insert(etf.code.to_string(), next);
                    let nav = *etf_navs.get(etf.code).unwrap_or(&etf.base_price);
                    if tx.send(WsMessage::EtfTick(make_etf_tick(etf.code, next, nav, &mut rng))).await.is_err() { return; }
                }
                for s in MOCK_STOCKS {
                    let prev = *stock_prices.get(s.code).unwrap_or(&s.base_price);
                    let next = walk_price(prev, s.base_price, &mut rng);
                    stock_prices.insert(s.code.to_string(), next);
                    if tx.send(WsMessage::StockTick(make_stock_tick(s.code, next, s.base_price, &mut rng))).await.is_err() { return; }
                }
                for f in MOCK_FUTURES {
                    let prev = *futures_prices.get(f.code).unwrap_or(&f.base_price);
                    let next = walk_price(prev, f.base_price, &mut rng);
                    futures_prices.insert(f.code.to_string(), next);
                    if tx.send(WsMessage::FuturesTick(make_futures_tick(f.code, next, f.base_price, f.base_price, &mut rng))).await.is_err() { return; }
                }
            }

            // ── select: sleep 또는 SubCommand 수신 ──
            // 신규 코드 추가 시 한 방 base 가격 초기 tick 발행 → 페이지에 즉시 데이터.
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
                cmd = sub_rx.recv() => {
                    if let Some(cmd) = cmd {
                        match cmd {
                            SubCommand::SubscribeOrderbook { codes } => {
                                ob_subs.clear();
                                for (tr, code) in &codes {
                                    let base = deterministic_base(code);
                                    let levels = if tr == "JH0" { 5 } else { 10 };
                                    ob_subs.push((code.clone(), base, levels));
                                }
                            }
                            SubCommand::UnsubscribeOrderbook => ob_subs.clear(),
                            SubCommand::SubscribeStocks(codes) => {
                                let mut new_stock = Vec::new();
                                let mut new_fut = Vec::new();
                                for c in codes {
                                    // A로 시작하는 8자리 = 선물 코드 → futures 그룹
                                    if c.len() == 8 && c.starts_with('A') {
                                        if subscribed_futures.insert(c.clone()) { new_fut.push(c); }
                                    } else {
                                        if subscribed_stocks.insert(c.clone()) { new_stock.push(c); }
                                    }
                                }
                                // 초기 burst를 점진적으로 emit (50개씩 → 50ms sleep).
                                // 일반 주식은 base에서 시작. ETF는 basket NAV 계산 가능하면 그걸로.
                                for batch in new_stock.chunks(50) {
                                    for code in batch {
                                        let base = deterministic_base(code);
                                        let msg = if subscribed_inav.contains(code) {
                                            let nav = compute_basket_nav(code, &stock_prices).unwrap_or(base);
                                            etf_navs.insert(code.clone(), nav);
                                            stock_prices.insert(code.clone(), nav);
                                            WsMessage::EtfTick(make_etf_tick(code, nav, nav, &mut rng))
                                        } else {
                                            stock_prices.insert(code.clone(), base);
                                            WsMessage::StockTick(make_stock_tick(code, base, base, &mut rng))
                                        };
                                        if tx.send(msg).await.is_err() { return; }
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                }
                                for batch in new_fut.chunks(50) {
                                    for code in batch {
                                        let base_underlying = deterministic_base(code);
                                        let bias = futures_basis_bias(code);
                                        let base_fut = base_underlying * (1.0 + bias);
                                        futures_prices.insert(code.clone(), base_fut);
                                        let underlying = *stock_prices.get(code).unwrap_or(&base_underlying);
                                        let msg = WsMessage::FuturesTick(make_futures_tick(code, base_fut, underlying, base_underlying, &mut rng));
                                        if tx.send(msg).await.is_err() { return; }
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                }
                            }
                            SubCommand::UnsubscribeStocks(codes) => {
                                for c in codes {
                                    subscribed_stocks.remove(&c); stock_prices.remove(&c);
                                    subscribed_futures.remove(&c); futures_prices.remove(&c);
                                }
                            }
                            SubCommand::SubscribeInav(codes) => {
                                let mut new_codes = Vec::new();
                                for c in codes {
                                    if subscribed_inav.insert(c.clone()) { new_codes.push(c); }
                                }
                                for batch in new_codes.chunks(50) {
                                    for code in batch {
                                        let base = deterministic_base(code);
                                        let nav = compute_basket_nav(code, &stock_prices).unwrap_or(base);
                                        etf_navs.insert(code.clone(), nav);
                                        // ETF 가격이 stock_prices에 아직 없거나 base인 경우 nav로 셋팅
                                        let price = stock_prices.get(code).copied().unwrap_or(nav);
                                        if !stock_prices.contains_key(code) {
                                            stock_prices.insert(code.clone(), nav);
                                        }
                                        let msg = WsMessage::EtfTick(make_etf_tick(code, price, nav, &mut rng));
                                        if tx.send(msg).await.is_err() { return; }
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                }
                            }
                            SubCommand::UnsubscribeInav(codes) => {
                                for c in codes { subscribed_inav.remove(&c); etf_navs.remove(&c); }
                            }
                            SubCommand::Subscribe(codes) => {
                                // 선물 월물 전환 — replace 시맨틱
                                subscribed_futures.clear();
                                futures_prices.clear();
                                for c in codes {
                                    let base_underlying = deterministic_base(&c);
                                    let bias = futures_basis_bias(&c);
                                    let base_fut = base_underlying * (1.0 + bias);
                                    futures_prices.insert(c.clone(), base_fut);
                                    subscribed_futures.insert(c.clone());
                                    let underlying = *stock_prices.get(&c).unwrap_or(&base_underlying);
                                    let msg = WsMessage::FuturesTick(make_futures_tick(&c, base_fut, underlying, base_underlying, &mut rng));
                                    if tx.send(msg).await.is_err() { return; }
                                }
                            }
                            SubCommand::Unsubscribe(_) => {
                                subscribed_futures.clear();
                                futures_prices.clear();
                            }
                            SubCommand::PrioritizeStocks(_) => {
                                // mock은 즉시 데이터 생성 — 우선화 의미 없음.
                            }
                        }
                    }
                }
                _ = cancel.cancelled() => { return; }
            }
        }
    }
}

fn gauss(rng: &mut impl Rng, std_dev: f64) -> f64 {
    let u1: f64 = rng.random();
    let u2: f64 = rng.random();
    let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
    z * std_dev
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
