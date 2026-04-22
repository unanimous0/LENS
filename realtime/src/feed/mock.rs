use chrono::Utc;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick, OrderbookLevel, OrderbookTick, StockTick};

use super::{MarketFeed, SubCommand};

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
        // 호가 구독 중인 코드: (code, base_price, levels)
        let mut ob_subs: Vec<(String, f64, usize)> = Vec::new();

        loop {
            // ETF 틱
            for etf in MOCK_ETFS {
                let price = etf.base_price * (1.0 + gauss(&mut rng, 0.001));
                let nav = etf.base_price * (1.0 + gauss(&mut rng, 0.0005));
                let bid = nav * (1.0 - 0.0002);
                let ask = nav * (1.0 + 0.0002);
                let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();

                let msg = WsMessage::EtfTick(EtfTick {
                    code: etf.code.to_string(),
                    name: etf.name.to_string(),
                    price: price.round(),
                    nav: round2(nav),
                    spread_bp: round2((price - nav) / nav * 10000.0),
                    spread_bid_bp: round2((bid - nav) / nav * 10000.0),
                    spread_ask_bp: round2((ask - nav) / nav * 10000.0),
                    volume: rng.random_range(1000..50000),
                    timestamp: now,
                });

                if tx.send(msg).await.is_err() { return; }
            }

            // 주식 틱
            for stock in MOCK_STOCKS {
                let price = stock.base_price * (1.0 + gauss(&mut rng, 0.001));
                let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();

                let msg = WsMessage::StockTick(StockTick {
                    code: stock.code.to_string(),
                    name: stock.name.to_string(),
                    price: price.round(),
                    volume: rng.random_range(100..10000),
                    cum_volume: rng.random_range(100000..5000000),
                    timestamp: now,
                    is_initial: false,
                });

                if tx.send(msg).await.is_err() { return; }
            }

            // 선물 틱
            for fut in MOCK_FUTURES {
                let price = fut.base_price * (1.0 + gauss(&mut rng, 0.0008));
                let underlying = fut.base_price * (1.0 + gauss(&mut rng, 0.0005));
                let basis = price - underlying;
                let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();

                let msg = WsMessage::FuturesTick(FuturesTick {
                    code: fut.code.to_string(),
                    name: fut.name.to_string(),
                    price: round2(price),
                    underlying_price: round2(underlying),
                    basis: round2(basis),
                    volume: rng.random_range(100..5000),
                    is_initial: false,
                    timestamp: now,
                });

                if tx.send(msg).await.is_err() { return; }
            }

            // 호가 틱 (구독 중인 종목만)
            for (code, base, levels) in &ob_subs {
                let mid = base * (1.0 + gauss(&mut rng, 0.001));
                let tick_size = if mid > 100000.0 { 500.0 } else if mid > 50000.0 { 100.0 } else if mid > 10000.0 { 50.0 } else { 10.0 };
                let mut asks = Vec::with_capacity(*levels);
                let mut bids = Vec::with_capacity(*levels);
                let mut total_ask = 0u64;
                let mut total_bid = 0u64;
                for i in 0..*levels {
                    let aq = rng.random_range(100..5000);
                    let bq = rng.random_range(100..5000);
                    asks.push(OrderbookLevel {
                        price: round2(mid + tick_size * (i as f64 + 1.0)),
                        quantity: aq,
                    });
                    bids.push(OrderbookLevel {
                        price: round2(mid - tick_size * (i as f64)),
                        quantity: bq,
                    });
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

            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
                cmd = sub_rx.recv() => {
                    if let Some(cmd) = cmd {
                        match cmd {
                            SubCommand::SubscribeOrderbook { codes } => {
                                ob_subs.clear();
                                for (tr, code) in &codes {
                                    let base = mock_base_price(code);
                                    let levels = if tr == "JH0" { 5 } else { 10 };
                                    ob_subs.push((code.clone(), base, levels));
                                }
                            }
                            SubCommand::UnsubscribeOrderbook => ob_subs.clear(),
                            _ => {}
                        }
                    }
                }
                _ = cancel.cancelled() => { return; }
            }
        }
    }
}

/// Mock 호가용 기본 가격 추정
fn mock_base_price(code: &str) -> f64 {
    match code {
        "005930" => 58000.0,
        "000660" => 135000.0,
        "035420" => 210000.0,
        _ => 50000.0,
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
