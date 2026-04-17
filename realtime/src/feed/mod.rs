pub mod ls_api;
pub mod mock;

use tokio::sync::mpsc;

use crate::model::message::WsMessage;

/// 시장 데이터 피드 trait.
/// 각 어댑터(Mock, LS API, Internal)가 구현.
pub trait MarketFeed: Send + Sync + 'static {
    /// 피드 시작. 수신된 틱을 tx로 전송.
    /// 취소 시 CancellationToken으로 정지.
    fn run(
        &self,
        tx: mpsc::Sender<WsMessage>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> impl std::future::Future<Output = ()> + Send;
}
