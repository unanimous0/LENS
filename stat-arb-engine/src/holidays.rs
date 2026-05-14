//! KRX 휴장일 캐시. `data/krx_holidays.json`을 시작 시 1회 로드.
//!
//! realtime/src/holidays.rs 와 동일 로직. lens-common 추출 전까지 임시 중복.
//!
//! 형식: `[{"date": "2026-05-01", "reason": "근로자의날"}, ...]`
//!
//! 파일 없거나 파싱 실패면 빈 set으로 폴백 — 휴장일 체크가 무력화될 뿐
//! 시스템은 계속 동작 (평일 09:00~15:45 룰만 적용).

use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;

use chrono::NaiveDate;
use serde::Deserialize;

#[derive(Deserialize)]
struct HolidayEntry {
    date: String,
    #[allow(dead_code)]
    reason: Option<String>,
}

static HOLIDAYS: OnceLock<HashSet<NaiveDate>> = OnceLock::new();

fn load_holidays() -> HashSet<NaiveDate> {
    let path = Path::new("../data/krx_holidays.json");
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => {
            tracing::info!("krx_holidays.json not found — holiday-aware market hours disabled");
            return HashSet::new();
        }
    };
    let entries: Vec<HolidayEntry> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("krx_holidays.json parse error: {e}");
            return HashSet::new();
        }
    };
    let set: HashSet<NaiveDate> = entries
        .iter()
        .filter_map(|e| NaiveDate::parse_from_str(&e.date, "%Y-%m-%d").ok())
        .collect();
    tracing::info!("loaded {} KRX holidays", set.len());
    set
}

pub fn is_krx_holiday(date: NaiveDate) -> bool {
    HOLIDAYS.get_or_init(load_holidays).contains(&date)
}
