use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, http::HeaderValue};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use std::sync::atomic::{AtomicU64, Ordering};

use crate::model::message::WsMessage;
use crate::model::tick::{EtfTick, FuturesTick, OrderbookLevel, OrderbookTick, StockTick};
use crate::Stats;

use super::{MarketFeed, SubCommand};

const WS_URL: &str = "wss://openapi.ls-sec.co.kr:9443/websocket";
const MAX_RECONNECT_DELAY_SECS: u64 = 60;
const MAX_SUBS_PER_CONNECTION: usize = 190;
/// 수신 유휴 타임아웃 (장중 한정).
/// 5개 WS 연결이 공유하는 last_data_us 기준이라 "feed 전체"가 N초 침묵해야 발동.
/// 개별 연결이 illiquid 종목만 담당해 조용해도, 다른 연결이 데이터 받으면 reset됨.
/// 장 시간 외에는 게이트 통해 완전 비활성 (밤새 재접속 spam 방지).
const IDLE_TIMEOUT_SECS: u64 = 30;

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

/// 다음 일일 새로고침 시각까지 sleep 시간 계산.
/// 트리거: 매일 08:30 KST (장 시작 전 prev_close 갱신) + 15:50 KST (당일 종가 캡처).
/// 두 시각 중 가장 가까운 미래까지의 duration 반환.
fn next_daily_refresh_delay() -> std::time::Duration {
    use chrono::{Local, Duration, TimeZone};
    let now = Local::now();
    let today = now.date_naive();
    let now_naive = now.naive_local();

    let candidates = [
        today.and_hms_opt(8, 30, 0).unwrap(),
        today.and_hms_opt(15, 50, 0).unwrap(),
        (today + Duration::days(1)).and_hms_opt(8, 30, 0).unwrap(),
    ];
    let next = *candidates.iter().find(|t| **t > now_naive).unwrap();
    let next_dt = Local
        .from_local_datetime(&next)
        .single()
        .unwrap_or_else(|| now + Duration::seconds(60));
    next_dt
        .signed_duration_since(now)
        .to_std()
        .unwrap_or(std::time::Duration::from_secs(60))
}

/// KST 평일 09:00~15:45만 true. 토/일 + 야간 시간대 + KRX 휴장일엔 idle timeout 비활성.
/// 시스템 timezone이 KST라고 가정 (서버 KST). 휴장일은 `data/krx_holidays.json` 참조 —
/// 파일 없으면 폴백으로 평일/시간만 체크.
fn is_market_hours() -> bool {
    use chrono::{Datelike, Local, Timelike, Weekday};
    let now = Local::now();
    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) { return false; }
    if crate::holidays::is_krx_holiday(now.date_naive()) { return false; }
    let mins = now.hour() * 60 + now.minute();
    (9 * 60..15 * 60 + 45).contains(&mins)
}

/// LS증권 OpenAPI WebSocket 피드.
/// 구독 수가 190개를 초과하면 여러 WebSocket 연결로 자동 분산.
///
/// 대형 map/set들은 `Arc<...>`로 저장. 연결 재생성(월물 전환·재연결)마다
/// `.clone()` 호출되는데 HashMap/HashSet 전체 복제 대신 Arc refcount만 증가.
pub struct LsApiFeed {
    pub app_key: String,
    pub app_secret: String,
    pub subscriptions: Vec<(String, String)>,
    pub names: Arc<HashMap<String, String>>,
    pub stock_codes: Arc<HashSet<String>>,
    pub futures_to_spot: Arc<HashMap<String, String>>,
    pub kosdaq_codes: Arc<HashSet<String>>,
    pub stats: Arc<Stats>,
    /// 마지막 **실제 데이터** (Text/Binary) 수신 시각 (UNIX micros). 어느 연결에서든
    /// 데이터 받으면 갱신. /debug/stats의 feed_age_sec과 뱃지 표시에 사용.
    /// subscribe 완료로는 갱신 안 됨 — 그럼 데이터 안 와도 fresh로 보이는 버그 됨.
    pub last_data_us: Arc<AtomicU64>,
    /// 마지막 subscribe 완료 시각 (UNIX micros). idle timeout grace 윈도우 anchor.
    /// 재연결 직후 30초 동안은 데이터 없어도 idle 안 발동 (LS가 stream 시작 대기 시간).
    pub last_subscribe_us: Arc<AtomicU64>,
    /// t1102 fetch 성공한 코드 캐시 — 페이지 재진입 시 풀 재fetch 회피.
    /// SubscribeStocks 핸들러가 fetched 안 보내고 처음부터 다시 도는 11분 백로그 방지.
    /// 프로세스 수명 동안 유지 (재시작 시만 비움).
    pub fetched_stocks: Arc<DashMap<String, ()>>,
}

impl LsApiFeed {
    pub fn new(
        app_key: String,
        app_secret: String,
        subscriptions: Vec<(String, String)>,
        names: HashMap<String, String>,
        stock_codes: HashSet<String>,
        futures_to_spot: HashMap<String, String>,
        kosdaq_codes: HashSet<String>,
        stats: Arc<Stats>,
        last_data_us: Arc<AtomicU64>,
    ) -> Self {
        Self {
            app_key, app_secret, subscriptions,
            names: Arc::new(names),
            stock_codes: Arc::new(stock_codes),
            futures_to_spot: Arc::new(futures_to_spot),
            kosdaq_codes: Arc::new(kosdaq_codes),
            stats,
            last_data_us,
            last_subscribe_us: Arc::new(AtomicU64::new(now_us())),
            fetched_stocks: Arc::new(DashMap::new()),
        }
    }
}

impl MarketFeed for LsApiFeed {
    async fn run(&self, tx: mpsc::Sender<WsMessage>, mut sub_rx: mpsc::UnboundedReceiver<SubCommand>, cancel: CancellationToken) {
        // 고정 그룹 (현물 S3_/K3_ + 스프레드 D코드): 변경 없음
        let fixed: Vec<(String, String)> = self.subscriptions.iter()
            .filter(|(_, key)| !key.starts_with('A') || key.len() != 8)  // A+7자리 선물코드가 아닌 것
            .cloned().collect();

        // 전환 그룹 (선물 JC0 A코드): 월물 전환 대상
        let initial_futures: Vec<(String, String)> = self.subscriptions.iter()
            .filter(|(tr, key)| tr == "JC0" && key.starts_with('A') && key.len() == 8)
            .cloned().collect();

        info!("LS API: fixed={} (spot+spread), switchable={} (futures)",
            fixed.len(), initial_futures.len());

        // 초기값 fetch (t8402) — WebSocket과 동시 실행, is_initial=true
        {
            let all_subs = self.subscriptions.clone();
            let tx2 = tx.clone();
            let cancel2 = cancel.clone();
            let ak = self.app_key.clone();
            let as_ = self.app_secret.clone();
            let n = self.names.clone();
            let sc = self.stock_codes.clone();
            let f2s = self.futures_to_spot.clone();
            let stats = self.stats.clone();
            let fetched = self.fetched_stocks.clone();
            tokio::spawn(async move {
                super::ls_rest::fetch_initial_prices(
                    &ak, &as_, &all_subs, &n, &sc, &f2s, &tx2, &cancel2, &stats, Some(&fetched),
                ).await;
            });
        }

        // 일일 자동 새로고침 — 영업일 08:30 KST(장 시작 전 prev_close 갱신) +
        // 15:50 KST(당일 종가 캡처). start_dev이 며칠 돌아도 prev_close가 항상
        // 직전 영업일 종가 유지. 휴장일/주말은 skip → 마지막 fetch 데이터 그대로 유효.
        // 캐시 clear 후 재fetch — 어제 데이터는 stale이라 강제 갱신.
        {
            let all_subs = self.subscriptions.clone();
            let tx2 = tx.clone();
            let cancel2 = cancel.clone();
            let ak = self.app_key.clone();
            let as_ = self.app_secret.clone();
            let n = self.names.clone();
            let sc = self.stock_codes.clone();
            let f2s = self.futures_to_spot.clone();
            let stats = self.stats.clone();
            let fetched = self.fetched_stocks.clone();
            tokio::spawn(async move {
                loop {
                    let delay = next_daily_refresh_delay();
                    tokio::select! {
                        _ = cancel2.cancelled() => return,
                        _ = tokio::time::sleep(delay) => {}
                    }
                    use chrono::{Datelike, Local, Weekday};
                    let now = Local::now();
                    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) { continue; }
                    if crate::holidays::is_krx_holiday(now.date_naive()) { continue; }
                    info!("Daily refresh trigger ({}): fetch_initial_prices 재호출", now.format("%H:%M"));
                    fetched.clear();  // 어제 캐시 stale → 비우고 처음부터
                    super::ls_rest::fetch_initial_prices(
                        &ak, &as_, &all_subs, &n, &sc, &f2s, &tx2, &cancel2, &stats, Some(&fetched),
                    ).await;
                }
            });
        }

        // 고정 그룹 연결 시작
        let fixed_chunks: Vec<Vec<(String, String)>> = fixed
            .chunks(MAX_SUBS_PER_CONNECTION).map(|c| c.to_vec()).collect();

        for (i, chunk) in fixed_chunks.into_iter().enumerate() {
            let tx = tx.clone();
            let cancel = cancel.clone();
            let app_key = self.app_key.clone();
            let app_secret = self.app_secret.clone();
            let names = self.names.clone();
            let stock_codes = self.stock_codes.clone();
            let futures_to_spot = self.futures_to_spot.clone();
            let stats = self.stats.clone();
            let last_data_us = self.last_data_us.clone();
            let last_subscribe_us = self.last_subscribe_us.clone();

            tokio::spawn(async move {
                let mut attempt = 0u32;
                let mut silent_count = 0u32;
                loop {
                    if cancel.is_cancelled() { return; }
                    let ticks_before = stats.tick_count.load(Ordering::Relaxed);
                    match run_single_connection(
                        i, &app_key, &app_secret, &chunk, &names, &stock_codes, &futures_to_spot, &tx, &cancel, &last_data_us, &last_subscribe_us,
                    ).await {
                        Ok(()) => return,
                        Err(e) => {
                            let ticks_after = stats.tick_count.load(Ordering::Relaxed);
                            if ticks_after > ticks_before { silent_count = 0; } else { silent_count += 1; }
                            attempt += 1;
                            stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                            let delay = if silent_count >= 5 { 300 }
                                else { (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS) };
                            if silent_count >= 5 {
                                warn!("fixed[{i}] silent {silent_count} cycles — LS likely blocking, extended backoff {delay}s");
                            } else {
                                warn!("fixed[{i}] disconnected: {e} — reconnecting in {delay}s");
                            }
                            tokio::select! {
                                _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                                _ = cancel.cancelled() => { return; }
                            }
                        }
                    }
                }
            });
        }

        // 전환 그룹: 선물 연결 관리
        let app_key = self.app_key.clone();
        let app_secret = self.app_secret.clone();
        let names = self.names.clone();
        let stock_codes = self.stock_codes.clone();
        let futures_to_spot = self.futures_to_spot.clone();

        // 초기 선물 연결 시작
        let mut futures_cancel = CancellationToken::new();
        let stats = self.stats.clone();
        let last_data_us = self.last_data_us.clone();
        let last_subscribe_us = self.last_subscribe_us.clone();
        spawn_futures_connections(
            &initial_futures, &app_key, &app_secret, &names, &stock_codes,
            &futures_to_spot, &tx, &cancel, &futures_cancel, &stats, &last_data_us, &last_subscribe_us,
        );

        // 호가 전용 연결 (온디맨드)
        let mut ob_cancel = CancellationToken::new();

        // 동적 주식/ETF 그룹 (S3_/K3_) — 선물(replace 시맨틱)과 분리된 add/remove 시맨틱.
        // ETF 페이지처럼 다수 페이지가 각자 필요 코드 추가/제거 가능. 셋 변경 시 connection 재생성.
        let mut stocks_cancel = CancellationToken::new();
        let mut current_stocks: HashSet<String> = HashSet::new();
        let kosdaq_codes = self.kosdaq_codes.clone();

        // 동적 ETF iNAV 그룹 (I5_) — 거래소 발행 NAV.
        let mut inav_cancel = CancellationToken::new();

        // SubscribeStocks 핸들러용 fetched 캐시 (페이지 재진입 시 풀 재fetch 회피).
        let fetched_stocks = self.fetched_stocks.clone();
        let mut current_inav: HashSet<String> = HashSet::new();

        // 현재 활성화된 선물 코드 셋 (정렬된 키) — 같은 셋 재구독 요청 시 skip.
        // 프론트 dedupe 1차 방어선이 뚫려도 (예: 다른 클라이언트가 보냄)
        // LS에 또 token+WS+subscribe 폭격하지 않게 백엔드도 가드.
        let mut current_futures_key: String = {
            let mut keys: Vec<&str> = initial_futures.iter().map(|(_, c)| c.as_str()).collect();
            keys.sort();
            keys.join(",")
        };

        // sub_rx에서 전환 명령 대기
        loop {
            tokio::select! {
                cmd = sub_rx.recv() => {
                    match cmd {
                        Some(SubCommand::Subscribe(codes)) => {
                            // 같은 코드 셋이면 no-op
                            let mut sorted: Vec<&str> = codes.iter().map(|s| s.as_str()).collect();
                            sorted.sort();
                            let new_key = sorted.join(",");
                            if new_key == current_futures_key {
                                info!("Subscribe: same {} codes — skip (already active)", codes.len());
                                continue;
                            }
                            current_futures_key = new_key;

                            // 기존 선물 연결 종료
                            futures_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            // 새 선물 코드로 연결
                            let new_futures: Vec<(String, String)> = codes.iter()
                                .map(|c| ("JC0".to_string(), c.clone()))
                                .collect();
                            info!("Switching futures: {} codes", new_futures.len());

                            futures_cancel = CancellationToken::new();
                            spawn_futures_connections(
                                &new_futures, &app_key, &app_secret, &names, &stock_codes,
                                &futures_to_spot, &tx, &cancel, &futures_cancel, &stats, &last_data_us, &last_subscribe_us,
                            );
                        }
                        Some(SubCommand::Unsubscribe(_)) => {
                            futures_cancel.cancel();
                        }
                        Some(SubCommand::SubscribeStocks(codes)) => {
                            let added: Vec<String> = codes.into_iter()
                                .filter(|c| !current_stocks.contains(c))
                                .collect();
                            if added.is_empty() {
                                info!("SubscribeStocks: no new codes");
                                continue;
                            }
                            for c in &added { current_stocks.insert(c.clone()); }

                            stocks_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            let stocks_subs: Vec<(String, String)> = current_stocks.iter()
                                .map(|code| {
                                    let tr = if kosdaq_codes.contains(code) { "K3_" } else { "S3_" };
                                    (tr.to_string(), code.clone())
                                })
                                .collect();
                            info!("SubscribeStocks: +{} new (total {})", added.len(), current_stocks.len());

                            stocks_cancel = CancellationToken::new();
                            spawn_stocks_connections(
                                &stocks_subs, &app_key, &app_secret, &names, &stock_codes,
                                &futures_to_spot, &tx, &cancel, &stocks_cancel, &stats, &last_data_us, &last_subscribe_us,
                            );

                            // 새로 추가된 코드들에 대해 t1102 초기 fetch (현재가 + 전일종가).
                            // 장 외 시간이거나 realtime 재시작 후에도 즉시 가격 표시 가능.
                            // fetched_stocks 캐시로 이미 받은 코드는 스킵 → 페이지 재진입 시 즉시 완료.
                            {
                                let ak = app_key.clone();
                                let as_ = app_secret.clone();
                                let n = (*names).clone();
                                let tx2 = tx.clone();
                                let cancel2 = cancel.clone();
                                let stats2 = stats.clone();
                                let fetched = fetched_stocks.clone();
                                tokio::spawn(async move {
                                    let token = match super::ls_rest::get_or_fetch_token(&ak, &as_).await {
                                        Ok(t) => t,
                                        Err(e) => { warn!("SubscribeStocks t1102 token fail: {e}"); return; }
                                    };
                                    info!("SubscribeStocks t1102 fetch: {} codes (캐시 스킵 적용)", added.len());
                                    super::ls_rest::fetch_stocks_initial(&token, &added, &n, &tx2, &cancel2, &stats2, Some(&fetched)).await;
                                });
                            }
                        }
                        Some(SubCommand::UnsubscribeStocks(codes)) => {
                            let mut changed = false;
                            for c in &codes {
                                if current_stocks.remove(c) { changed = true; }
                            }
                            if !changed {
                                continue;
                            }

                            stocks_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            if current_stocks.is_empty() {
                                info!("UnsubscribeStocks: -{}, set empty (no respawn)", codes.len());
                                stocks_cancel = CancellationToken::new();
                            } else {
                                let stocks_subs: Vec<(String, String)> = current_stocks.iter()
                                    .map(|code| {
                                        let tr = if kosdaq_codes.contains(code) { "K3_" } else { "S3_" };
                                        (tr.to_string(), code.clone())
                                    })
                                    .collect();
                                info!("UnsubscribeStocks: -{} (total {})", codes.len(), current_stocks.len());
                                stocks_cancel = CancellationToken::new();
                                spawn_stocks_connections(
                                    &stocks_subs, &app_key, &app_secret, &names, &stock_codes,
                                    &futures_to_spot, &tx, &cancel, &stocks_cancel, &stats, &last_data_us, &last_subscribe_us,
                                );
                            }
                        }
                        Some(SubCommand::SubscribeInav(codes)) => {
                            let added: Vec<String> = codes.into_iter()
                                .filter(|c| !current_inav.contains(c))
                                .collect();
                            if added.is_empty() {
                                info!("SubscribeInav: no new codes");
                                continue;
                            }
                            for c in &added { current_inav.insert(c.clone()); }

                            inav_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            let inav_subs: Vec<(String, String)> = current_inav.iter()
                                .map(|code| ("I5_".to_string(), code.clone()))
                                .collect();
                            info!("SubscribeInav: +{} new (total {})", added.len(), current_inav.len());

                            inav_cancel = CancellationToken::new();
                            spawn_inav_connections(
                                &inav_subs, &app_key, &app_secret, &names, &stock_codes,
                                &futures_to_spot, &tx, &cancel, &inav_cancel, &stats, &last_data_us, &last_subscribe_us,
                            );
                        }
                        Some(SubCommand::UnsubscribeInav(codes)) => {
                            let mut changed = false;
                            for c in &codes {
                                if current_inav.remove(c) { changed = true; }
                            }
                            if !changed { continue; }

                            inav_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

                            if current_inav.is_empty() {
                                info!("UnsubscribeInav: -{}, set empty (no respawn)", codes.len());
                                inav_cancel = CancellationToken::new();
                            } else {
                                let inav_subs: Vec<(String, String)> = current_inav.iter()
                                    .map(|code| ("I5_".to_string(), code.clone()))
                                    .collect();
                                info!("UnsubscribeInav: -{} (total {})", codes.len(), current_inav.len());
                                inav_cancel = CancellationToken::new();
                                spawn_inav_connections(
                                    &inav_subs, &app_key, &app_secret, &names, &stock_codes,
                                    &futures_to_spot, &tx, &cancel, &inav_cancel, &stats, &last_data_us, &last_subscribe_us,
                                );
                            }
                        }
                        Some(SubCommand::SubscribeOrderbook { codes }) => {
                            // 기존 호가 연결 종료
                            ob_cancel.cancel();
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;

                            let n_chunks = codes.len().div_ceil(MAX_SUBS_PER_CONNECTION);
                            info!("Orderbook subscribe: {} codes ({} conns)", codes.len(), n_chunks);
                            ob_cancel = CancellationToken::new();
                            spawn_orderbook_connection(
                                &codes, &app_key, &app_secret, &names,
                                &stock_codes, &futures_to_spot, &tx, &cancel, &ob_cancel, &stats, &last_data_us, &last_subscribe_us,
                            );
                        }
                        Some(SubCommand::UnsubscribeOrderbook) => {
                            info!("Orderbook unsubscribe");
                            ob_cancel.cancel();
                        }
                        None => break,
                    }
                }
                _ = cancel.cancelled() => {
                    futures_cancel.cancel();
                    ob_cancel.cancel();
                    stocks_cancel.cancel();
                    inav_cancel.cancel();
                    return;
                }
            }
        }
    }
}

/// 선물 전용 연결 그룹 스폰 (전환 가능)
fn spawn_futures_connections(
    futures: &[(String, String)],
    app_key: &str, app_secret: &str,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    global_cancel: &CancellationToken,
    futures_cancel: &CancellationToken,
    stats: &Arc<Stats>,
    last_data_us: &Arc<AtomicU64>,
    last_subscribe_us: &Arc<AtomicU64>,
) {
    let chunks: Vec<Vec<(String, String)>> = futures
        .chunks(MAX_SUBS_PER_CONNECTION).map(|c| c.to_vec()).collect();

    for (i, chunk) in chunks.into_iter().enumerate() {
        let tx = tx.clone();
        let gc = global_cancel.clone();
        let fc = futures_cancel.clone();
        let ak = app_key.to_string();
        let as_ = app_secret.to_string();
        let n = names.clone();
        let sc = stock_codes.clone();
        let f2s = futures_to_spot.clone();
        let stats = stats.clone();
        let last_data_us = last_data_us.clone();
        let last_subscribe_us = last_subscribe_us.clone();

        tokio::spawn(async move {
            let combined_cancel = CancellationToken::new();
            let gc2 = gc.clone();
            let fc2 = fc.clone();
            let cc = combined_cancel.clone();
            // global 또는 futures cancel 어느 쪽이든 이 연결 종료
            tokio::spawn(async move {
                tokio::select! {
                    _ = gc2.cancelled() => cc.cancel(),
                    _ = fc2.cancelled() => cc.cancel(),
                }
            });

            let mut attempt = 0u32;
            let mut silent_count = 0u32;
            loop {
                if combined_cancel.is_cancelled() { return; }
                let conn_id = 100 + i; // 고정 그룹과 구분
                let ticks_before = stats.tick_count.load(Ordering::Relaxed);
                match run_single_connection(
                    conn_id, &ak, &as_, &chunk, &n, &sc, &f2s, &tx, &combined_cancel, &last_data_us, &last_subscribe_us,
                ).await {
                    Ok(()) => return,
                    Err(e) => {
                        if combined_cancel.is_cancelled() { return; }
                        let ticks_after = stats.tick_count.load(Ordering::Relaxed);
                        if ticks_after > ticks_before { silent_count = 0; } else { silent_count += 1; }
                        attempt += 1;
                        stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                        let delay = if silent_count >= 5 { 300 }
                            else { (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS) };
                        if silent_count >= 5 {
                            warn!("futures[{i}] silent {silent_count} cycles — LS likely blocking, extended backoff {delay}s");
                        } else {
                            warn!("futures[{i}] disconnected: {e} — reconnecting in {delay}s");
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                            _ = combined_cancel.cancelled() => { return; }
                        }
                    }
                }
            }
        });
    }
}

/// 동적 주식/ETF 그룹 연결 스폰 (S3_/K3_). 선물 그룹과 동일 패턴이지만 conn_id 200+ 범위.
fn spawn_stocks_connections(
    subs: &[(String, String)],
    app_key: &str, app_secret: &str,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    global_cancel: &CancellationToken,
    stocks_cancel: &CancellationToken,
    stats: &Arc<Stats>,
    last_data_us: &Arc<AtomicU64>,
    last_subscribe_us: &Arc<AtomicU64>,
) {
    let chunks: Vec<Vec<(String, String)>> = subs
        .chunks(MAX_SUBS_PER_CONNECTION).map(|c| c.to_vec()).collect();

    for (i, chunk) in chunks.into_iter().enumerate() {
        let tx = tx.clone();
        let gc = global_cancel.clone();
        let sc_token = stocks_cancel.clone();
        let ak = app_key.to_string();
        let as_ = app_secret.to_string();
        let n = names.clone();
        let sc = stock_codes.clone();
        let f2s = futures_to_spot.clone();
        let stats = stats.clone();
        let last_data_us = last_data_us.clone();
        let last_subscribe_us = last_subscribe_us.clone();

        tokio::spawn(async move {
            let combined_cancel = CancellationToken::new();
            let gc2 = gc.clone();
            let sct2 = sc_token.clone();
            let cc = combined_cancel.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = gc2.cancelled() => cc.cancel(),
                    _ = sct2.cancelled() => cc.cancel(),
                }
            });

            let mut attempt = 0u32;
            let mut silent_count = 0u32;
            loop {
                if combined_cancel.is_cancelled() { return; }
                let conn_id = 200 + i;
                let ticks_before = stats.tick_count.load(Ordering::Relaxed);
                match run_single_connection(
                    conn_id, &ak, &as_, &chunk, &n, &sc, &f2s, &tx, &combined_cancel, &last_data_us, &last_subscribe_us,
                ).await {
                    Ok(()) => return,
                    Err(e) => {
                        if combined_cancel.is_cancelled() { return; }
                        let ticks_after = stats.tick_count.load(Ordering::Relaxed);
                        if ticks_after > ticks_before { silent_count = 0; } else { silent_count += 1; }
                        attempt += 1;
                        stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                        let delay = if silent_count >= 5 { 300 }
                            else { (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS) };
                        if silent_count >= 5 {
                            warn!("stocks[{i}] silent {silent_count} cycles — LS likely blocking, extended backoff {delay}s");
                        } else {
                            warn!("stocks[{i}] disconnected: {e} — reconnecting in {delay}s");
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                            _ = combined_cancel.cancelled() => { return; }
                        }
                    }
                }
            }
        });
    }
}

/// 동적 ETF iNAV 그룹 연결 스폰 (I5_). conn_id 300+ 범위.
fn spawn_inav_connections(
    subs: &[(String, String)],
    app_key: &str, app_secret: &str,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    global_cancel: &CancellationToken,
    inav_cancel: &CancellationToken,
    stats: &Arc<Stats>,
    last_data_us: &Arc<AtomicU64>,
    last_subscribe_us: &Arc<AtomicU64>,
) {
    let chunks: Vec<Vec<(String, String)>> = subs
        .chunks(MAX_SUBS_PER_CONNECTION).map(|c| c.to_vec()).collect();

    for (i, chunk) in chunks.into_iter().enumerate() {
        let tx = tx.clone();
        let gc = global_cancel.clone();
        let ic_token = inav_cancel.clone();
        let ak = app_key.to_string();
        let as_ = app_secret.to_string();
        let n = names.clone();
        let sc = stock_codes.clone();
        let f2s = futures_to_spot.clone();
        let stats = stats.clone();
        let last_data_us = last_data_us.clone();
        let last_subscribe_us = last_subscribe_us.clone();

        tokio::spawn(async move {
            let combined_cancel = CancellationToken::new();
            let gc2 = gc.clone();
            let ict2 = ic_token.clone();
            let cc = combined_cancel.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = gc2.cancelled() => cc.cancel(),
                    _ = ict2.cancelled() => cc.cancel(),
                }
            });

            let mut attempt = 0u32;
            let mut silent_count = 0u32;
            loop {
                if combined_cancel.is_cancelled() { return; }
                let conn_id = 300 + i;
                let ticks_before = stats.tick_count.load(Ordering::Relaxed);
                match run_single_connection(
                    conn_id, &ak, &as_, &chunk, &n, &sc, &f2s, &tx, &combined_cancel, &last_data_us, &last_subscribe_us,
                ).await {
                    Ok(()) => return,
                    Err(e) => {
                        if combined_cancel.is_cancelled() { return; }
                        let ticks_after = stats.tick_count.load(Ordering::Relaxed);
                        if ticks_after > ticks_before { silent_count = 0; } else { silent_count += 1; }
                        attempt += 1;
                        stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                        let delay = if silent_count >= 5 { 300 }
                            else { (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS) };
                        if silent_count >= 5 {
                            warn!("inav[{i}] silent {silent_count} cycles — LS likely blocking, extended backoff {delay}s");
                        } else {
                            warn!("inav[{i}] disconnected: {e} — reconnecting in {delay}s");
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                            _ = combined_cancel.cancelled() => { return; }
                        }
                    }
                }
            }
        });
    }
}

/// 호가 전용 연결 스폰 (온디맨드, 최대 2-3 종목)
/// 호가창 그룹 연결 스폰 (H1_/HA_/JH0/JC0 modal). conn_id 400+ 범위.
/// 585개 ETF 호가처럼 LS 연결당 한도(~200)를 넘는 경우 자동으로 청크 분할 → 다중 연결.
fn spawn_orderbook_connection(
    codes: &[(String, String)],
    app_key: &str, app_secret: &str,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    global_cancel: &CancellationToken,
    ob_cancel: &CancellationToken,
    stats: &Arc<Stats>,
    last_data_us: &Arc<AtomicU64>,
    last_subscribe_us: &Arc<AtomicU64>,
) {
    // 청크 분할 — 연결당 LS 한도(~200) 우회.
    let chunks: Vec<Vec<(String, String)>> = codes
        .chunks(MAX_SUBS_PER_CONNECTION)
        .map(|c| c.to_vec())
        .collect();

    for (i, chunk) in chunks.into_iter().enumerate() {
        let conn_id = 400 + i; // fixed=0+, futures=100+, stocks=200+, inav=300+, orderbook=400+
        let chunk_codes = chunk;
        let tx = tx.clone();
        let gc = global_cancel.clone();
        let fc = ob_cancel.clone();
        let ak = app_key.to_string();
        let as_ = app_secret.to_string();
        let n = names.clone();
        let sc = stock_codes.clone();
        let f2s = futures_to_spot.clone();
        let stats = stats.clone();
        let last_data_us = last_data_us.clone();
        let last_subscribe_us = last_subscribe_us.clone();

        tokio::spawn(async move {
            let combined = CancellationToken::new();
            let gc2 = gc.clone();
            let fc2 = fc.clone();
            let cc = combined.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = gc2.cancelled() => cc.cancel(),
                    _ = fc2.cancelled() => cc.cancel(),
                }
            });

            let mut attempt = 0u32;
            let mut silent_count = 0u32;
            loop {
                if combined.is_cancelled() { return; }
                let ticks_before = stats.tick_count.load(Ordering::Relaxed);
                match run_single_connection(
                    conn_id, &ak, &as_, &chunk_codes, &n, &sc, &f2s, &tx, &combined, &last_data_us, &last_subscribe_us,
                ).await {
                    Ok(()) => return,
                    Err(e) => {
                        if combined.is_cancelled() { return; }
                        let ticks_after = stats.tick_count.load(Ordering::Relaxed);
                        if ticks_after > ticks_before { silent_count = 0; } else { silent_count += 1; }
                        attempt += 1;
                        stats.reconnect_count.fetch_add(1, Ordering::Relaxed);
                        let delay = if silent_count >= 5 { 300 }
                            else { (2u64.pow(attempt.min(5))).min(MAX_RECONNECT_DELAY_SECS) };
                        if silent_count >= 5 {
                            warn!("orderbook conn[{conn_id}] silent {silent_count} cycles — LS likely blocking, extended backoff {delay}s");
                        } else {
                            warn!("orderbook conn[{conn_id}] disconnected: {e} — reconnecting in {delay}s");
                        }
                        tokio::select! {
                            _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                            _ = combined.cancelled() => { return; }
                        }
                    }
                }
            }
        });
    }
}

/// 단일 WebSocket 연결: 토큰 발급 → 연결 → 구독 → 수신 루프
async fn run_single_connection(
    conn_id: usize,
    app_key: &str,
    app_secret: &str,
    subscriptions: &[(String, String)],
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
    tx: &mpsc::Sender<WsMessage>,
    cancel: &CancellationToken,
    last_data_us: &Arc<AtomicU64>,
    last_subscribe_us: &Arc<AtomicU64>,
) -> Result<(), String> {
    // 토큰 발급 — 프로세스 캐시 사용 (23h TTL). 매 재연결마다 LS에 새 토큰
    // 요청 보내면 abuse heuristic 트리거 가능성 있어 캐시로 회피.
    let token = super::ls_rest::get_or_fetch_token(app_key, app_secret).await?;
    debug!("conn[{conn_id}] token ok");

    // WebSocket 연결
    let mut request = WS_URL.into_client_request().expect("bad URL");
    request.headers_mut().insert("User-Agent", HeaderValue::from_static("Mozilla/5.0 LENS/1.0"));
    request.headers_mut().insert("Accept-Language", HeaderValue::from_static("ko-KR,ko;q=0.9"));

    let connector = tokio_tungstenite::Connector::NativeTls(native_tls::TlsConnector::new().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector))
        .await.map_err(|e| format!("ws connect: {e}"))?;

    let (mut write, mut read) = ws.split();
    debug!("conn[{conn_id}] connected, subscribing {} codes", subscriptions.len());

    // 구독
    for (tr_cd, tr_key) in subscriptions {
        let msg = serde_json::json!({"header": {"token": &token, "tr_type": "3"}, "body": {"tr_cd": tr_cd, "tr_key": tr_key}});
        write.send(tungstenite::Message::Text(msg.to_string().into())).await.map_err(|e| format!("sub: {e}"))?;
    }
    debug!("conn[{conn_id}] all subscribed");

    // subscribe 완료 시각만 갱신 — last_data_us는 건들지 않음.
    // last_data_us는 "실제 Text/Binary 받은 시각" 의미를 유지해야 뱃지가 정직.
    // idle 판정은 max(last_data, last_subscribe) 기준이라 30초 grace는 보존됨.
    last_subscribe_us.store(now_us(), Ordering::Relaxed);

    // 수신 루프. idle 판정: max(last_data, last_subscribe) — 데이터 받았거나 방금
    // 재구독한 경우 grace. 장 시간 외에는 게이트로 비활성화.
    let idle_limit_us: u64 = IDLE_TIMEOUT_SECS * 1_000_000;
    // 폴링 간격 — 매 5초마다 last_data_us 확인 (정확도 vs 오버헤드 trade-off)
    let poll_interval = std::time::Duration::from_secs(5);
    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(tungstenite::Message::Text(text))) => {
                        last_data_us.store(now_us(), Ordering::Relaxed);
                        handle_tick(&text, tx, names, stock_codes, futures_to_spot).await;
                    }
                    Some(Ok(tungstenite::Message::Binary(data))) => {
                        if let Ok(text) = String::from_utf8(data.to_vec()) {
                            last_data_us.store(now_us(), Ordering::Relaxed);
                            handle_tick(&text, tx, names, stock_codes, futures_to_spot).await;
                        }
                    }
                    Some(Ok(tungstenite::Message::Close(f))) => {
                        return Err(format!("closed: {}", f.map(|f| f.reason.to_string()).unwrap_or_default()));
                    }
                    Some(Err(e)) => return Err(format!("error: {e}")),
                    None => return Err("stream ended".into()),
                    _ => {}
                }
            }
            _ = cancel.cancelled() => {
                let _ = write.send(tungstenite::Message::Close(None)).await;
                return Ok(());
            }
            _ = tokio::time::sleep(poll_interval) => {
                // 장 시간 외엔 idle 판정 안 함 (밤새 재접속 spam 방지)
                if !is_market_hours() { continue; }
                let last_data = last_data_us.load(Ordering::Relaxed);
                let last_sub = last_subscribe_us.load(Ordering::Relaxed);
                let recent = last_data.max(last_sub);
                let elapsed_us = now_us().saturating_sub(recent);
                if elapsed_us > idle_limit_us {
                    let data_age = now_us().saturating_sub(last_data) / 1_000_000;
                    return Err(format!("feed idle {}s — LS silent (data {}s old)", elapsed_us / 1_000_000, data_age));
                }
            }
        }
    }
}

/// 틱 메시지 파싱 및 WsMessage 발행
async fn handle_tick(
    text: &str,
    tx: &mpsc::Sender<WsMessage>,
    names: &Arc<HashMap<String, String>>,
    stock_codes: &Arc<HashSet<String>>,
    futures_to_spot: &Arc<HashMap<String, String>>,
) {
    let data: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let header = &data["header"];
    let body = &data["body"];
    if body.is_null() { return; }

    let tr_cd = header["tr_cd"].as_str().unwrap_or("");
    let tr_key = header["tr_key"].as_str().unwrap_or("");
    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f").to_string();
    let name = names.get(tr_key).map(|s| s.as_str()).unwrap_or(tr_key);

    match tr_cd {
        "S3_" | "K3_" => {
            let price = pf(&body["price"]);
            let volume = pu(&body["volume"]);
            let value = pu(&body["value"]);

            if stock_codes.contains(tr_key) {
                // S3_/K3_는 body에 high/low 포함 (당일 고가/저가). 누락 시 None.
                let h = pf(&body["high"]);
                let l = pf(&body["low"]);
                let _ = tx.send(WsMessage::StockTick(StockTick {
                    code: tr_key.into(), name: name.into(),
                    price, volume, cum_volume: value * 1_000_000, timestamp: now,
                    is_initial: false,
                    high: if h > 0.0 { Some(h) } else { None },
                    low: if l > 0.0 { Some(l) } else { None },
                    prev_close: None,
                })).await;
            } else {
                // ETF S3_ 체결 → price/volume만. nav는 I5_ 스트림이 채움 (bridge merge로 보존).
                let _ = tx.send(WsMessage::EtfTick(EtfTick {
                    code: tr_key.into(), name: name.into(),
                    price, nav: 0.0, spread_bp: 0.0,
                    spread_bid_bp: 0.0, spread_ask_bp: 0.0, volume, timestamp: now,
                })).await;
            }
        }
        "JC0" => {
            let price = pf(&body["price"]);
            let volume = pu(&body["volume"]);
            let underlying = pf(&body["basprice"]);
            let basis = if underlying > 0.0 { price - underlying } else { 0.0 };
            // 미결제약정: openyak(잔고), openyakcha(전일대비). 0이 와도 유효값일 수 있어
            // body에 키가 있는지로 판단 — 키가 없으면 None.
            let oi = body.get("openyak").map(pi);
            let oi_change = body.get("openyakcha").map(pi);

            let _ = tx.send(WsMessage::FuturesTick(FuturesTick {
                code: tr_key.into(), name: name.into(),
                price, underlying_price: underlying, basis: r2(basis), volume, timestamp: now,
                is_initial: false,
                open_interest: oi,
                open_interest_change: oi_change,
            })).await;
            // 주의: 기초자산(현물) StockTick은 파생해서 보내지 않음.
            // 현물은 S3_/K3_로 별도 구독 중이고, 여기서 보내면 cum_volume을 0으로 덮어써버려
            // 현물대금이 빈 칸이 되는 문제가 발생함.
        }
        // 주식 호가 (KOSPI H1_, KOSDAQ HA_): 10호가
        "H1_" | "HA_" => {
            let (asks, bids) = parse_orderbook_levels(body, 10);
            let total_ask = pu(&body["totofferrem"]);
            let total_bid = pu(&body["totbidrem"]);
            let _ = tx.send(WsMessage::OrderbookTick(OrderbookTick {
                code: tr_key.into(), name: name.into(),
                asks, bids, total_ask_qty: total_ask, total_bid_qty: total_bid,
                timestamp: now,
            })).await;
        }
        // 주식선물/스프레드 호가 (JH0): 5호가
        "JH0" => {
            let (asks, bids) = parse_orderbook_levels(body, 5);
            let total_ask = pu(&body["totofferrem"]);
            let total_bid = pu(&body["totbidrem"]);
            let _ = tx.send(WsMessage::OrderbookTick(OrderbookTick {
                code: tr_key.into(), name: name.into(),
                asks, bids, total_ask_qty: total_ask, total_bid_qty: total_bid,
                timestamp: now,
            })).await;
        }
        // ETF iNAV (거래소 발행). nav 필드만 사용 — 다른 EtfTick 필드는 S3_가 채움.
        "I5_" => {
            let nav = pf(&body["nav"]);
            // 임시 디버깅: 처음 몇개만 raw body 찍어서 필드 검증.
            static I5_LOG_COUNT: AtomicU64 = AtomicU64::new(0);
            let n = I5_LOG_COUNT.fetch_add(1, Ordering::Relaxed);
            if n < 5 {
                tracing::info!("I5_ raw body sample[{}]: code={} body={}", n, tr_key, body);
            }
            if nav > 0.0 {
                let _ = tx.send(WsMessage::EtfTick(EtfTick {
                    code: tr_key.into(), name: name.into(),
                    price: 0.0,  // S3_가 채울 거 — bridge에서 cache merge로 보존됨
                    nav: r2(nav),
                    spread_bp: 0.0, spread_bid_bp: 0.0, spread_ask_bp: 0.0,
                    volume: 0,
                    timestamp: now,
                })).await;
            }
        }
        _ => {}
    }
}

/// 호가 레벨 정적 키 (format!() 할당 제거)
static OB_KEYS: [(&str, &str, &str, &str); 10] = [
    ("offerho1", "offerrem1", "bidho1", "bidrem1"),
    ("offerho2", "offerrem2", "bidho2", "bidrem2"),
    ("offerho3", "offerrem3", "bidho3", "bidrem3"),
    ("offerho4", "offerrem4", "bidho4", "bidrem4"),
    ("offerho5", "offerrem5", "bidho5", "bidrem5"),
    ("offerho6", "offerrem6", "bidho6", "bidrem6"),
    ("offerho7", "offerrem7", "bidho7", "bidrem7"),
    ("offerho8", "offerrem8", "bidho8", "bidrem8"),
    ("offerho9", "offerrem9", "bidho9", "bidrem9"),
    ("offerho10", "offerrem10", "bidho10", "bidrem10"),
];

/// 호가 레벨 파싱: offerho1~N, bidho1~N, offerrem1~N, bidrem1~N
fn parse_orderbook_levels(body: &serde_json::Value, levels: usize) -> (Vec<OrderbookLevel>, Vec<OrderbookLevel>) {
    let mut asks = Vec::with_capacity(levels);
    let mut bids = Vec::with_capacity(levels);
    for &(ak, ark, bk, brk) in &OB_KEYS[..levels] {
        let ask_price = pf(&body[ak]);
        let ask_qty = pu(&body[ark]);
        let bid_price = pf(&body[bk]);
        let bid_qty = pu(&body[brk]);
        if ask_price > 0.0 {
            asks.push(OrderbookLevel { price: ask_price, quantity: ask_qty });
        }
        if bid_price > 0.0 {
            bids.push(OrderbookLevel { price: bid_price, quantity: bid_qty });
        }
    }
    (asks, bids)
}

fn pf(v: &serde_json::Value) -> f64 {
    match v { serde_json::Value::Number(n) => n.as_f64().unwrap_or(0.0), serde_json::Value::String(s) => s.parse().unwrap_or(0.0), _ => 0.0 }
}
fn pu(v: &serde_json::Value) -> u64 {
    match v { serde_json::Value::Number(n) => n.as_u64().unwrap_or(0), serde_json::Value::String(s) => s.parse().unwrap_or(0), _ => 0 }
}
fn pi(v: &serde_json::Value) -> i64 {
    match v { serde_json::Value::Number(n) => n.as_i64().unwrap_or(0), serde_json::Value::String(s) => s.parse().unwrap_or(0), _ => 0 }
}
fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
