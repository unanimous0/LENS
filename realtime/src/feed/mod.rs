pub mod internal;
pub mod ls_api;
pub mod mock;

use tokio::sync::mpsc;

use crate::model::message::WsMessage;

/// 런타임 구독 변경 명령.
#[derive(Debug, Clone)]
pub enum SubCommand {
    /// 종목 코드 추가 구독
    Subscribe(Vec<String>),
    /// 종목 코드 구독 해제
    Unsubscribe(Vec<String>),
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
