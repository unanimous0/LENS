//! 종목별 거래대금 캐시 — t1102 응답에서 받은 value를 디스크에 저장.
//!
//! 다음 launch 시 큐 정렬에 사용. 추가 LS API 호출 0 — 어차피 받는 값을 piggyback.
//!
//! 저장 주기: t1102 sweep 진행 중 매 1000건마다 incremental save
//!   (도중 강제 종료해도 점진적 누적, 코드 자주 재시작하는 환경에서도 효과).
//!
//! 형식: data/stock_volumes.json
//!   { "exported_at": "...", "volumes": { "005930": 1234567, ... } }
//!   value 단위는 t1102 응답의 백만원 단위 그대로 (정렬에만 사용하므로 단위 무관).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

const PATH: &str = "../data/stock_volumes.json";
const SAVE_EVERY: usize = 1000;

#[derive(Serialize, Deserialize)]
struct VolumeFile {
    exported_at: String,
    volumes: HashMap<String, u64>,
}

static VOLUMES: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
/// record 호출 횟수 카운터 — SAVE_EVERY 주기 판정용. Mutex 내부에 안 두는 이유는
/// snapshot() 등 다른 read 경로와 격리해 락 경합 줄이기 위함.
static RECORD_COUNT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn store() -> &'static Mutex<HashMap<String, u64>> {
    VOLUMES.get_or_init(|| Mutex::new(load_from_disk()))
}

fn load_from_disk() -> HashMap<String, u64> {
    let raw = match std::fs::read_to_string(PATH) {
        Ok(s) => s,
        Err(_) => {
            info!("stock_volumes.json not found — first run, will use master code order");
            return HashMap::new();
        }
    };
    match serde_json::from_str::<VolumeFile>(&raw) {
        Ok(f) => {
            info!("loaded {} stock volumes (cached at {})", f.volumes.len(), f.exported_at);
            f.volumes
        }
        Err(e) => {
            warn!("stock_volumes.json parse failed: {e} — ignoring");
            HashMap::new()
        }
    }
}

fn save_to_disk(volumes: &HashMap<String, u64>) {
    let exported_at = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let f = VolumeFile { exported_at, volumes: volumes.clone() };
    let json = match serde_json::to_string(&f) {
        Ok(s) => s,
        Err(e) => { warn!("stock_volumes serialize failed: {e}"); return; }
    };
    if let Err(e) = std::fs::write(PATH, json) {
        warn!("stock_volumes write failed: {e}");
    }
}

/// 한 종목의 거래대금 기록. 매 SAVE_EVERY 호출마다 디스크 자동 flush.
/// 0 값은 무시 (체결 없는 잡주 등).
pub fn record(code: &str, value: u64) {
    if value == 0 { return; }
    let mut snap_for_save = None;
    if let Ok(mut m) = store().lock() {
        m.insert(code.to_string(), value);
        let n = RECORD_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if n % SAVE_EVERY == 0 {
            snap_for_save = Some(m.clone());
        }
    }
    if let Some(snap) = snap_for_save {
        save_to_disk(&snap);
        info!("stock_volumes flushed: {} entries", snap.len());
    }
}

/// 현재까지 누적된 거래대금 캐시 snapshot. 마스터 로더가 정렬 키로 사용.
pub fn snapshot() -> HashMap<String, u64> {
    store().lock().map(|m| m.clone()).unwrap_or_default()
}

/// 강제 flush — sweep 끝/SIGTERM 등에서 호출.
pub fn flush() {
    let snap = match store().lock() {
        Ok(m) => m.clone(),
        Err(_) => return,
    };
    save_to_disk(&snap);
    info!("stock_volumes flushed (final): {} entries", snap.len());
}
