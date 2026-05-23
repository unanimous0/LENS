/// 공유 수신 상태.
///
/// ls_ws 태스크가 WsEvent를 mpsc로 보내면, state_updater 태스크가 받아서
/// SharedState를 갱신하고, 브로드캐스트 채널로 JSON 스냅샷을 push한다.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use serde::Serialize;
use serde_json::Value;

// ─────────────────────────────────────────────────────────────────────────────
// 이벤트: ls_ws → state_updater
// ─────────────────────────────────────────────────────────────────────────────

pub enum WsEvent {
    /// WS 연결 성공
    Connected,
    /// WS 연결 끊김 (재연결 예정)
    Disconnected(String),
    /// 실시간 틱 수신 (WS)
    Tick {
        tr_cd:   String,
        tr_key:  String,
        recv_us: u64,
        body:    Value,
    },
    /// REST t1102 초기값 (종가 포함)
    InitialPrice {
        code:       String,
        name:       String,
        price:      f64,
        volume:     u64,
        high:       f64,
        low:        f64,
        open:       f64,
        prev_close: f64,       // 전일종가 (recprice)
        raw_block:  Value,     // 원본 응답 전체
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// 그룹 분류
// ─────────────────────────────────────────────────────────────────────────────

/// ETF 종목코드 목록 (S3_ + I5_ 쌍으로 구독)
const ETF_CODES: &[&str] = &[
    "069500", "122630", "233740", "102110", "091160", "229200",
    "396500", "114800", "252670", "251340", "364980", "0117V0",
];

/// TR + 코드로 표시 그룹 결정.
/// 프론트엔드 그룹 헤더 및 정렬에 사용.
pub fn determine_group(tr_cd: &str, code: &str) -> String {
    match tr_cd {
        "IJ_"       => "지수",
        "FC9"|"FH9" => "지수선물",
        "JH0"       => "주식선물",
        "JC0"       => {
            // A01... = KOSPI200, A06... = KOSDAQ150 → 지수선물
            if code.starts_with("A01") || code.starts_with("A06") {
                "지수선물"
            } else {
                "주식선물"
            }
        }
        "I5_"       => "ETF",
        "K3_"|"HA_" => "KOSDAQ주식",
        "S3_"|"H1_" => {
            if ETF_CODES.contains(&code) { "ETF" } else { "KOSPI주식" }
        }
        _           => "기타",
    }.to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// 공유 상태 (Arc<RwLock<...>>)
// ─────────────────────────────────────────────────────────────────────────────

/// 구독 1개 (tr_cd + code) 의 현재 데이터
#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub tr_cd:      String,
    pub code:       String,
    pub name:       String,       // 종목명 (t1102에서 채움)
    pub group:      String,       // 표시 그룹 (프론트엔드 섹션 구분)
    pub recv_count: u64,
    pub last_recv_us: u64,

    // 1초 평균 메시지 수 (rolling window)
    pub msg_per_sec: f64,

    // 가격 데이터 — t1102(초기) 또는 실시간 WS 틱으로 채워짐
    pub price:      Option<f64>,
    pub volume:     Option<u64>,
    pub high:       Option<f64>,
    pub low:        Option<f64>,
    pub open:       Option<f64>,
    pub prev_close: Option<f64>,  // 전일종가 (t1102 recprice)
    pub chetime:    Option<String>, // 체결 시각 (S3_/K3_ chetime)
    pub nav:        Option<f64>,    // I5_ ETF iNAV

    // 소스 구분 — "t1102" | "ws" | ""
    pub price_source: String,

    // raw body 전체 — 프론트에서 펼쳐 볼 수 있음
    pub body: Value,
}

/// WS 연결 상태
#[derive(Debug, Clone, Serialize)]
pub struct ConnInfo {
    pub status:       String,      // "connected" / "connecting" / "disconnected: <reason>"
    pub total_msgs:   u64,
    pub total_errors: u64,
    pub connected_at: Option<u64>, // UNIX micros
}

/// 브로드캐스트되는 전체 스냅샷
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub ts:      u64,            // 스냅샷 시각 (UNIX micros)
    pub conn:    ConnInfo,
    pub entries: Vec<Entry>,
}

// ─────────────────────────────────────────────────────────────────────────────
// SharedState 내부 구조
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Inner {
    pub conn: ConnInfo,
    // key: (tr_cd, code) — 삽입 순서 유지를 위해 Vec<Entry>로 저장
    pub entries: Vec<Entry>,
    /// recv_count 시계열 (간이 rate 계산용): (tr_cd+code) → 최근 10s 버킷
    pub rate_buckets: HashMap<String, VecDeque<(u64, u64)>>,
}

pub type SharedState = Arc<RwLock<Inner>>;

/// Entry key: "TR_CD:code"
fn entry_key(tr_cd: &str, code: &str) -> String {
    format!("{tr_cd}:{code}")
}

pub fn new_state() -> SharedState {
    Arc::new(RwLock::new(Inner {
        conn: ConnInfo {
            status:       "connecting".into(),
            total_msgs:   0,
            total_errors: 0,
            connected_at: None,
        },
        entries:      Vec::new(),
        rate_buckets: HashMap::new(),
    }))
}

/// 구독 목록 전체를 빈 Entry로 미리 채워넣기.
/// WS 연결 전에 호출해야 장외 시간에도 모든 구독 항목이 화면에 표시됨.
pub async fn prefill_subscriptions(state: SharedState, subs: &[(&str, &str)]) {
    let mut g = state.write().await;
    for &(tr_cd, code) in subs {
        // 이미 있으면 스킵
        if g.entries.iter().any(|e| e.tr_cd == tr_cd && e.code == code) {
            continue;
        }
        g.entries.push(Entry {
            tr_cd:        tr_cd.to_string(),
            code:         code.to_string(),
            name:         String::new(),
            group:        determine_group(tr_cd, code),
            recv_count:   0,
            last_recv_us: 0,
            msg_per_sec:  0.0,
            price:        None,
            volume:       None,
            high:         None,
            low:          None,
            open:         None,
            prev_close:   None,
            chetime:      None,
            nav:          None,
            price_source: String::new(),
            body:         Value::Null,
        });
    }
}

pub fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// state_updater — WsEvent를 받아 Inner 갱신
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::VecDeque;
use tokio::sync::{broadcast, mpsc};

/// 메시지 루프. `event_rx`에서 WsEvent를 받아 state 갱신 후 snapshot을 broadcast.
pub async fn run_updater(
    state: SharedState,
    mut event_rx: mpsc::Receiver<WsEvent>,
    snapshot_tx: broadcast::Sender<String>,
) {
    while let Some(event) = event_rx.recv().await {
        {
            let mut g = state.write().await;
            match event {
                WsEvent::Connected => {
                    g.conn.status = "connected".into();
                    g.conn.connected_at = Some(now_us());
                    tracing::info!("LS WS connected");
                }
                WsEvent::Disconnected(reason) => {
                    g.conn.status = format!("disconnected: {reason}");
                    g.conn.total_errors += 1;
                    tracing::warn!("LS WS disconnected: {reason}");
                }
                WsEvent::InitialPrice { code, name, price, volume, high, low, open, prev_close, raw_block } => {
                    let now = now_us();

                    // S3_ 또는 K3_ entry에 가격 채우기 (중복 방지: None일 때만)
                    if let Some(e) = g.entries.iter_mut().find(|e| {
                        e.code == code && matches!(e.tr_cd.as_str(), "S3_" | "K3_")
                    }) {
                        if e.price.is_none()      { e.price      = Some(price);      }
                        if e.volume.is_none()      { e.volume     = Some(volume);     }
                        if e.high.is_none()        { e.high       = Some(high);       }
                        if e.low.is_none()         { e.low        = Some(low);        }
                        if e.open.is_none()        { e.open       = Some(open);       }
                        if e.prev_close.is_none()  { e.prev_close = Some(prev_close); }
                        if e.body == Value::Null   { e.body       = raw_block;        }
                        e.price_source = "t1102".into();
                        e.last_recv_us = now; // lastRenderedUs 체크 트리거
                        tracing::info!("t1102 {code} ({name}) price={price} prev={prev_close}");
                    }

                    // 같은 code를 가진 모든 entry에 name 전파 (H1_/HA_/I5_ 등)
                    for e in g.entries.iter_mut() {
                        if e.code == code && e.name.is_empty() {
                            e.name = name.clone();
                        }
                    }
                }
                WsEvent::Tick { tr_cd, tr_key, recv_us, body } => {
                    g.conn.total_msgs += 1;

                    // 필드 파싱
                    // IJ_ 지수는 price 대신 jisu 필드 사용
                    let price   = parse_f64(&body["price"])
                        .or_else(|| parse_f64(&body["jisu"]));
                    let volume  = parse_u64(&body["volume"]);
                    let nav     = parse_f64(&body["nav"]);
                    let high    = parse_f64(&body["high"]);
                    let low     = parse_f64(&body["low"]);
                    let open    = parse_f64(&body["open"]);
                    let chetime = body["chetime"].as_str().map(|s| {
                        // "090851" → "09:08:51"
                        if s.len() == 6 {
                            format!("{}:{}:{}", &s[0..2], &s[2..4], &s[4..6])
                        } else {
                            s.to_string()
                        }
                    });

                    // rate 계산 (10초 슬라이딩 윈도우)
                    let key = entry_key(&tr_cd, &tr_key);
                    let bucket = g.rate_buckets.entry(key.clone()).or_default();
                    bucket.push_back((recv_us, 1));
                    let cutoff = recv_us.saturating_sub(10_000_000); // 10s
                    while bucket.front().map(|(t, _)| *t < cutoff).unwrap_or(false) {
                        bucket.pop_front();
                    }
                    let msg_per_sec = bucket.len() as f64 / 10.0;

                    // entry 찾기 또는 생성
                    if let Some(e) = g.entries.iter_mut().find(|e| e.tr_cd == tr_cd && e.code == tr_key) {
                        e.recv_count   += 1;
                        e.last_recv_us  = recv_us;
                        e.msg_per_sec   = msg_per_sec;
                        e.price_source  = "ws".into();
                        e.price         = price.filter(|&v| v > 0.0).or(e.price);
                        e.volume        = volume.filter(|&v| v > 0).or(e.volume);
                        e.high          = high.filter(|&v| v > 0.0).or(e.high);
                        e.low           = low.filter(|&v| v > 0.0).or(e.low);
                        e.open          = open.filter(|&v| v > 0.0).or(e.open);
                        e.nav           = nav.filter(|&v| v > 0.0).or(e.nav);
                        if chetime.is_some() { e.chetime = chetime; }
                        e.body          = body;
                    } else {
                        // 구독 외 스트림 (예외 케이스)
                        tracing::info!("new stream (not prefilled): {tr_cd} {tr_key}");
                        g.entries.push(Entry {
                            tr_cd:        tr_cd.clone(),
                            code:         tr_key.clone(),
                            name:         String::new(),
                            group:        determine_group(&tr_cd, &tr_key),
                            recv_count:   1,
                            last_recv_us: recv_us,
                            msg_per_sec,
                            price:        price.filter(|&v| v > 0.0),
                            volume:       volume.filter(|&v| v > 0),
                            high:         high.filter(|&v| v > 0.0),
                            low:          low.filter(|&v| v > 0.0),
                            open:         open.filter(|&v| v > 0.0),
                            prev_close:   None,
                            nav:          nav.filter(|&v| v > 0.0),
                            chetime,
                            price_source: "ws".into(),
                            body,
                        });
                    }
                }
            }
        }

        // 스냅샷 직렬화 후 broadcast (receiver 없어도 무시)
        let snap = build_snapshot(&state).await;
        if let Ok(json) = serde_json::to_string(&snap) {
            let _ = snapshot_tx.send(json);
        }
    }
}

async fn build_snapshot(state: &SharedState) -> Snapshot {
    let g = state.read().await;
    Snapshot {
        ts:      now_us(),
        conn:    g.conn.clone(),
        entries: g.entries.clone(),
    }
}

fn parse_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn parse_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}
