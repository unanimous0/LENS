//! 지수선물 총잔량(FH9) **당일 히스토리** — 서버측 상시 수집.
//!
//! "선물" 탭은 개장~현재의 매수/매도 총잔량 비율 추이를 본다. 브라우저를 닫았다 다시 열어도
//! 개장 시점부터 보여야 하므로 프론트 세션이 아니라 이 프로세스가 상시 샘플링해서 보관한다.
//! (WS는 최신값만 밀어주고, 과거 구간은 `GET /futures/depth-history`가 준다.)
//!
//! 설계:
//!   - **샘플 10초** — FH9는 초당 수십 틱이라 그대로 쌓으면 하루 수십만 포인트. 정규장 6.5h를
//!     10초로 끊으면 product당 ~2,340점으로 차트에 딱 맞는다.
//!   - price/cum_volume은 같은 시각의 FC9 최신값을 붙인다 (같은 상품의 체결 스트림).
//!     구간 거래량은 인접 포인트의 cum_volume diff로 프론트가 계산.
//!   - **파일 스냅샷** (`volume_cache.rs`와 동일한 OnceLock+Mutex+incremental flush 패턴).
//!     realtime을 장중에 재기동해도 오전 구간이 살아남는다. 파일의 `date`가 오늘(KST)이
//!     아니면 폐기하고 새 거래일로 시작.
//!   - **source 태깅 (mock / live)** — mock 피드는 장 phase 게이트를 무시하고 합성 잔량을
//!     뿜으므로, 태깅이 없으면 "낮에 실데이터 수집 → 저녁에 mock 기동" 시 같은 date 키에
//!     mock 샘플이 실데이터 뒤에 이어붙고 재기동 시 복원까지 된다. `set_source()`가
//!     기동·모드전환 시점에 소스를 확정하고, 다르면 메모리·파일을 통째로 버린다.
//!
//! ratio를 포인트에 담지 않는 이유: `b/a`로 무손실 복원 가능해서 저장·전송 페이로드만 늘린다
//! (2,400점 × 2상품 기준 ~15% 절감). 실시간 WS 틱(`IndexFuturesDepthTick`)은 소비처가 많아
//! 편의상 ratio를 포함한다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::model::message::WsMessage;
use crate::model::tick::IndexFuturesDepthTick;

const PATH: &str = "../data/futures_depth_intraday.json";
/// 샘플 간격(초). 마지막 샘플로부터 이 시간이 지난 첫 틱에서만 append.
const SAMPLE_INTERVAL_SEC: i64 = 10;
/// 디스크 flush 주기 (전 상품 합산 샘플 수). 6 = 2상품 기준 약 30초.
const FLUSH_EVERY: usize = 6;
/// 소스 전환 직후 격리 시간(ms). 모드 전환 시 이전 피드가 mpsc에 남겨둔 in-flight 틱이
/// 새 소스 시계열에 섞이지 않도록 이 시간 동안 append를 막는다 (bridge drain은 ms 단위).
const SOURCE_SWITCH_QUARANTINE_MS: i64 = 1_500;
/// product당 보관 상한. 10초 × 3,000 = 8.3시간 — 정규장(6.5h) + 시간외 여유.
const MAX_POINTS: usize = 3_000;
/// 히스토리 보관 대상. 미니(mini_k200)는 KOSPI200과 같은 기초지수라 화면·저장 모두 제외.
const TRACKED: [&str; 2] = ["kospi200", "kosdaq150"];

/// 총잔량 시계열 한 포인트. 필드명이 짧은 이유는 하루치 전량을 한 번에 내려주는 REST
/// 페이로드이기 때문 (product당 최대 3,000점).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthPoint {
    /// epoch 초 (UTC). KST 표기는 프론트 몫.
    pub t: i64,
    /// 총 매도잔량
    pub a: u64,
    /// 총 매수잔량
    pub b: u64,
    /// 샘플 시점 선물 현재가 (FC9 최신). 아직 체결 틱이 없으면 0.
    pub p: f64,
    /// 샘플 시점 누적 거래량 (FC9 `volume`). 구간 거래량은 인접 diff.
    pub v: u64,
    /// 미결제약정 (FC9 `openyak`). 0 = 미상.
    #[serde(default)]
    pub oi: i64,
    /// 기초지수 (FC9 `k200jisu`). 0 = 미상. 시장 베이시스 = p − u.
    #[serde(default)]
    pub u: f64,
    /// 이론가 (FC9 `theoryprice`). 0 = 미상. 이론 베이시스 = th − u.
    #[serde(default)]
    pub th: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProductSeries {
    /// 해당 상품의 현재 월물 코드 (A + 상품2 + 연1 + 월1 + 000).
    pub code: String,
    pub points: Vec<DepthPoint>,
    /// 마지막 샘플 시각(epoch 초). 파일엔 안 담고 복원 시 points 끝에서 회복.
    #[serde(skip)]
    last_sample_t: i64,
    /// FC9 최신 현재가/누적거래량/미결제약정/기초지수/이론가 — 다음 샘플에 붙일 값.
    #[serde(skip)]
    last_price: f64,
    #[serde(skip)]
    last_volume: u64,
    #[serde(skip)]
    last_oi: i64,
    #[serde(skip)]
    last_underlying: f64,
    #[serde(skip)]
    last_theory: f64,
}

/// 파일 포맷 = REST 응답 포맷.
/// `date`가 오늘(KST YYYYMMDD)이 아니거나 `source`가 현재 피드와 다르면 전량 폐기.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthHistory {
    pub date: String,
    /// "mock" | "live". mock 합성 데이터와 실데이터가 한 시계열에 섞이는 것을 막는 태그.
    /// 구버전 파일(필드 없음)은 빈 문자열 → 어떤 소스와도 불일치 → 폐기.
    #[serde(default)]
    pub source: String,
    pub products: HashMap<String, ProductSeries>,
}

impl DepthHistory {
    fn empty(date: String, source: String) -> Self {
        Self { date, source, products: HashMap::new() }
    }
}

/// 피드 모드 → 시계열 소스 태그.
fn source_label(mode: &str) -> &'static str {
    if mode == "mock" { "mock" } else { "live" }
}

static STORE: OnceLock<Mutex<DepthHistory>> = OnceLock::new();
/// 누적 샘플 수 — FLUSH_EVERY 주기 판정용 (volume_cache와 동일하게 락 밖 카운터).
static SAMPLE_COUNT: AtomicUsize = AtomicUsize::new(0);
/// 장 phase 게이트 무시 여부. mock 피드에서만 true — 장 외에도 오프라인 개발·검증 가능하게.
static IGNORE_PHASE: AtomicBool = AtomicBool::new(false);
/// 소스 전환 격리 해제 시각 (epoch ms). 이전보다 크면 append 금지.
static QUARANTINE_UNTIL_MS: AtomicI64 = AtomicI64::new(0);

/// 디스크 스냅샷 쓰기 허용 여부 (기본 true = 운영 인스턴스).
///
/// **기본 포트(8200)가 아닌 검증용 옆 인스턴스는 false**. `set_source`가 소스 전환 시
/// 스냅샷 파일을 지우는 설계라, 같은 data 디렉터리에서 mock 인스턴스를 잠깐 띄우면
/// **운영 인스턴스의 당일 라이브 히스토리 파일이 삭제된다** (2026-08-13 실제 발생 —
/// 운영 프로세스가 메모리 스토어를 30초 뒤 다시 flush해서 복구됐지만, 그 창에서
/// 운영 인스턴스를 재기동했으면 오전 구간이 통째로 날아갔다).
static PERSIST: AtomicBool = AtomicBool::new(true);

/// 기동 시 1회 — 포트가 기본값이 아니면 false로 꺼서 운영 파일을 건드리지 않게 한다.
/// 읽기(복원)는 그대로 허용 (쓰기·삭제만 차단).
pub fn set_persistence(enabled: bool) {
    PERSIST.store(enabled, Ordering::Relaxed);
    if !enabled {
        info!("지수선물 총잔량 — 디스크 스냅샷 비활성 (검증 인스턴스: 파일 쓰기·삭제 안 함)");
    }
}

fn persist_enabled() -> bool {
    PERSIST.load(Ordering::Relaxed)
}

fn store() -> &'static Mutex<DepthHistory> {
    STORE.get_or_init(|| Mutex::new(load_from_disk()))
}

fn today_kst() -> String {
    chrono::Local::now().format("%Y%m%d").to_string()
}

fn is_tracked(product: &str) -> bool {
    TRACKED.contains(&product)
}

/// 피드 소스 확정 — **기동 시 1회 + 런타임 모드 전환 시** 호출.
/// 소스가 바뀌면 메모리 시계열과 디스크 스냅샷을 통째로 버린다 (mock↔live 혼입 차단).
/// 호출 시점 규약: *이전 피드가 완전히 정지한 뒤*. 그래도 mpsc에 남은 in-flight 틱이 있을 수
/// 있어 짧은 격리 창을 둔다.
pub fn set_source(mode: &str) {
    let src = source_label(mode);
    IGNORE_PHASE.store(src == "mock", Ordering::Relaxed);
    QUARANTINE_UNTIL_MS.store(now_ms() + SOURCE_SWITCH_QUARANTINE_MS, Ordering::Relaxed);
    let Ok(mut h) = store().lock() else { return };
    if h.source == src {
        return;
    }
    let had = h.products.values().map(|s| s.points.len()).sum::<usize>();
    if had > 0 {
        info!(
            "지수선물 총잔량 소스 전환 ({} → {src}) — 당일 시계열 {had}점 폐기 (혼입 방지)",
            if h.source.is_empty() { "none" } else { &h.source }
        );
    }
    h.source = src.to_string();
    h.date = today_kst();
    h.products.clear();
    drop(h);
    // 파일도 함께 폐기 — 안 지우면 재기동 시 이전 소스 데이터가 되살아난다.
    // 단 검증 인스턴스(PERSIST=false)는 운영 스냅샷을 지우면 안 된다.
    if !persist_enabled() {
        return;
    }
    if let Err(e) = std::fs::remove_file(PATH) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!("futures_depth 스냅샷 삭제 실패: {e}");
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 지금 샘플을 쌓아도 되는 시간대인가. 장 외에는 append 안 함 (조회·복원은 항상 가능).
/// 소스 전환 격리 중에도 막는다.
fn sampling_enabled() -> bool {
    if now_ms() < QUARANTINE_UNTIL_MS.load(Ordering::Relaxed) {
        return false;
    }
    IGNORE_PHASE.load(Ordering::Relaxed) || crate::phase::is_active()
}

fn load_from_disk() -> DepthHistory {
    let today = today_kst();
    let raw = match std::fs::read_to_string(PATH) {
        Ok(s) => s,
        Err(_) => return DepthHistory::empty(today, String::new()),
    };
    let mut f: DepthHistory = match serde_json::from_str(&raw) {
        Ok(f) => f,
        Err(e) => {
            warn!("futures_depth_intraday.json parse failed: {e} — 무시하고 새로 시작");
            return DepthHistory::empty(today, String::new());
        }
    };
    if f.date != today {
        info!("지수선물 총잔량 스냅샷 날짜 불일치 ({} != {today}) — 폐기하고 새 거래일 시작", f.date);
        return DepthHistory::empty(today, f.source);
    }
    // 복원 후 중복 append 방지 — 마지막 포인트 시각을 sample 커서로 회복.
    let mut total = 0usize;
    for s in f.products.values_mut() {
        // 구 포맷 스냅샷(oi/u/th 없음)은 serde default로 0 → "미상"으로 복원되고,
        // 다음 샘플부터 실값이 채워진다 (프론트가 0을 갭으로 처리).
        if let Some(p) = s.points.last() {
            s.last_sample_t = p.t;
            s.last_price = p.p;
            s.last_volume = p.v;
            s.last_oi = p.oi;
            s.last_underlying = p.u;
            s.last_theory = p.th;
        }
        total += s.points.len();
    }
    info!("지수선물 총잔량 당일 히스토리 복원: {} products / {total} points ({today})", f.products.len());
    f
}

fn save_to_disk(snapshot: &DepthHistory) {
    if !persist_enabled() {
        return;
    }
    let json = match serde_json::to_string(snapshot) {
        Ok(s) => s,
        Err(e) => {
            warn!("futures_depth serialize failed: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(PATH, json) {
        warn!("futures_depth write failed: {e}");
    }
}

/// 날짜가 바뀌었으면(새 거래일 첫 샘플) 버퍼 리셋.
fn roll_date_if_needed(h: &mut DepthHistory) {
    let today = today_kst();
    if h.date == today {
        return;
    }
    info!("지수선물 총잔량 — 새 거래일 {today} 시작 (이전 {})", h.date);
    h.date = today;
    h.products.clear();
}

/// bridge에서 모든 WsMessage 1건마다 호출 (sync, 비용 거의 0).
///  - `IndexFuturesTick`(FC9): 다음 샘플에 붙일 price/cum_volume 갱신
///  - `IndexFuturesDepth`(FH9): 10초 간격 샘플 append
pub fn observe(msg: &WsMessage) {
    match msg {
        WsMessage::IndexFuturesTick(t) => {
            // 격리 창 안(모드 전환 직후)이면 이전 피드의 in-flight 틱일 수 있어 무시.
            if !is_tracked(t.product) || !sampling_enabled() {
                return;
            }
            let Ok(mut h) = store().lock() else { return };
            roll_date_if_needed(&mut h);
            let s = h.products.entry(t.product.to_string()).or_default();
            if s.code != t.code {
                s.code = t.code.clone();
            }
            if t.price > 0.0 {
                s.last_price = t.price;
            }
            if t.volume > 0 {
                s.last_volume = t.volume;
            }
            // OI/기초지수/이론가 — 미제공(None·0)이면 직전 값 유지 (sticky).
            if let Some(oi) = t.open_interest.filter(|v| *v > 0) {
                s.last_oi = oi;
            }
            if t.underlying_index > 0.0 {
                s.last_underlying = t.underlying_index;
            }
            if let Some(th) = t.theory_price.filter(|v| *v > 0.0) {
                s.last_theory = th;
            }
        }
        WsMessage::IndexFuturesDepth(d) => record_depth(d),
        _ => {}
    }
}

fn record_depth(d: &IndexFuturesDepthTick) {
    if !is_tracked(d.product) || !sampling_enabled() {
        return;
    }
    let now_sec = d.time_ms / 1000;
    let mut pending_save: Option<DepthHistory> = None;
    {
        let Ok(mut h) = store().lock() else { return };
        roll_date_if_needed(&mut h);
        let s = h.products.entry(d.product.to_string()).or_default();
        if s.code != d.code {
            s.code = d.code.clone();
        }
        if now_sec - s.last_sample_t < SAMPLE_INTERVAL_SEC {
            return;
        }
        s.last_sample_t = now_sec;
        s.points.push(DepthPoint {
            t: now_sec,
            a: d.total_ask_qty,
            b: d.total_bid_qty,
            p: s.last_price,
            v: s.last_volume,
            oi: s.last_oi,
            u: s.last_underlying,
            th: s.last_theory,
        });
        if s.points.len() > MAX_POINTS {
            let excess = s.points.len() - MAX_POINTS;
            s.points.drain(..excess);
        }
        if SAMPLE_COUNT.fetch_add(1, Ordering::Relaxed) % FLUSH_EVERY == FLUSH_EVERY - 1 {
            pending_save = Some(h.clone());
        }
    }
    // 직렬화 + 파일 쓰기는 bridge task(핫 경로)에서 빼서 blocking 풀로 (커밋 eb3cbc5 관례).
    if let Some(snap) = pending_save {
        spawn_save(snap);
    }
}

/// 스냅샷 저장을 blocking 풀로. 런타임 밖(테스트 등)에서 호출되면 동기 폴백.
fn spawn_save(snap: DepthHistory) {
    match tokio::runtime::Handle::try_current() {
        Ok(_) => {
            tokio::task::spawn_blocking(move || {
                save_to_disk(&snap);
                debug!("futures_depth flushed: {} products", snap.products.len());
            });
        }
        Err(_) => save_to_disk(&snap),
    }
}

/// REST `GET /futures/depth-history` 응답. 날짜가 넘어갔으면 빈 오늘치를 준다.
pub fn snapshot() -> DepthHistory {
    let Ok(mut h) = store().lock() else {
        return DepthHistory::empty(today_kst(), String::new());
    };
    roll_date_if_needed(&mut h);
    h.clone()
}

/// 강제 flush — graceful shutdown에서 호출.
pub fn flush() {
    let snap = match store().lock() {
        Ok(h) => h.clone(),
        Err(_) => return,
    };
    if snap.products.is_empty() {
        return;
    }
    save_to_disk(&snap);
    debug!("futures_depth flushed (final): {} products", snap.products.len());
}
