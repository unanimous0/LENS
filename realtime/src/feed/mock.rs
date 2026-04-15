use chrono::Utc;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick};

use super::MarketFeed;

struct MockEtf {
    code: &'static str,
    name: &'static str,
    base_price: f64,
}

struct MockFuture {
    code: &'static str,
    name: &'static str,
    base_price: f64,
}

// Python MockAdapter와 동일한 종목
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

static MOCK_FUTURES: &[MockFuture] = &[
    MockFuture { code: "101S6", name: "KOSPI200 근월물", base_price: 350.0 },
    MockFuture { code: "101S9", name: "KOSPI200 원월물", base_price: 351.5 },
    MockFuture { code: "106S6", name: "KOSDAQ150 근월물", base_price: 1250.0 },
];

pub struct MockFeed;

impl MarketFeed for MockFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, cancel: CancellationToken) {
        let mut rng = StdRng::from_os_rng();

        loop {
            // ETF 틱 생성
            for etf in MOCK_ETFS {
                let price = etf.base_price * (1.0 + gauss(&mut rng, 0.001));
                let nav = etf.base_price * (1.0 + gauss(&mut rng, 0.0005));
                let spread_bp = (price - nav) / nav * 10000.0;
                let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();

                let msg = WsMessage::EtfTick(EtfTick {
                    code: etf.code.to_string(),
                    name: etf.name.to_string(),
                    price: (price).round(),
                    nav: round2(nav),
                    spread_bp: round2(spread_bp),
                    volume: rng.random_range(1000..50000),
                    timestamp: now,
                });

                if tx.send(msg).await.is_err() {
                    return;
                }
            }

            // 선물 틱 생성
            for fut in MOCK_FUTURES {
                let price = fut.base_price * (1.0 + gauss(&mut rng, 0.0008));
                let underlying = fut.base_price * (1.0 + gauss(&mut rng, 0.0005));
                let basis_bp = (price - underlying) / underlying * 10000.0;
                let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();

                let msg = WsMessage::FuturesTick(FuturesTick {
                    code: fut.code.to_string(),
                    name: fut.name.to_string(),
                    price: round2(price),
                    underlying_price: round2(underlying),
                    basis_bp: round2(basis_bp),
                    volume: rng.random_range(100..5000),
                    timestamp: now,
                });

                if tx.send(msg).await.is_err() {
                    return;
                }
            }

            // 1초 대기 또는 취소
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                _ = cancel.cancelled() => { return; }
            }
        }
    }
}

/// Box-Muller transform으로 정규분포 난수 생성
fn gauss(rng: &mut impl Rng, std_dev: f64) -> f64 {
    let u1: f64 = rng.random();
    let u2: f64 = rng.random();
    let z = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
    z * std_dev
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
