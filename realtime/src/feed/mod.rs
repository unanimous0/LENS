pub mod internal;
pub mod ls_api;
pub mod ls_rest;
pub mod mock;

use tokio::sync::mpsc;

use crate::model::message::WsMessage;

/// 런타임 구독 변경 명령.
#[derive(Debug, Clone)]
pub enum SubCommand {
    /// 선물 코드 셋 교체 (월물 전환용 — 이전 셋 무효화하고 새 셋만 유지).
    /// stock-arbitrage 페이지의 월물 토글이 사용. JC0 TR 전용.
    Subscribe(Vec<String>),
    /// 선물 셋 비우기 (월물 전환용).
    Unsubscribe(Vec<String>),
    /// 주식/ETF 코드 누적 구독 (S3_/K3_). 기존 셋에 더함.
    /// 다수 페이지가 각자 필요한 코드 추가/제거 가능 (replace 아닌 add/remove 시맨틱).
    SubscribeStocks(Vec<String>),
    /// 주식/ETF 코드 누적 구독 해제 — 셋에서만 빠짐.
    UnsubscribeStocks(Vec<String>),
    /// ETF iNAV 구독 (I5_) — 거래소 발행 실시간 NAV. ETF 코드만 의미 있음.
    SubscribeInav(Vec<String>),
    /// ETF iNAV 구독 해제.
    UnsubscribeInav(Vec<String>),
    /// 호가 온디맨드 구독. codes = (TR코드, 종목코드) 쌍.
    SubscribeOrderbook { codes: Vec<(String, String)> },
    /// 호가 구독 해제
    UnsubscribeOrderbook,
}

/// 시장 데이터 피드 trait.
/// 각 어댑터(Mock, LS API, Internal)가 구현.
pub trait MarketFeed: Send + Sync + 'static {
    /// 피드 시작. 수신된 틱을 tx로 전송.
    /// sub_rx로 런타임 구독 변경 수신.
    /// 취소 시 CancellationToken으로 정지.
    fn run(
        &self,
        tx: mpsc::Sender<WsMessage>,
        sub_rx: mpsc::UnboundedReceiver<SubCommand>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> impl std::future::Future<Output = ()> + Send;
}
