//! 시간대별 장 phase. realtime/src/phase.rs 와 동일 로직.
//! lens-common 추출 전까지 임시 중복.
//!
//! 통계 엔진은 phase에 따라 다르게 동작:
//!   Sleep    : 야간/주말/공휴일 — 후보 풀/통계량 재계산 정지 (마지막 결과 그대로 노출)
//!   WarmUp   : 장 시작 30분 전 — 후보 풀 초기 계산 (1일 1회)
//!   Live     : 장중 — 10분마다 통계량 갱신, 1시간마다 후보 풀 재발굴
//!   WindDown : 장 마감 후 30분 — 마지막 스냅샷 저장 후 sleep

use chrono::{DateTime, Datelike, Local, NaiveDateTime, NaiveTime, TimeZone, Timelike, Weekday};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tracing::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Sleep,
    WarmUp,
    Live,
    WindDown,
}

impl std::fmt::Display for Phase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Phase::Sleep => "sleep",
            Phase::WarmUp => "warm-up",
            Phase::Live => "live",
            Phase::WindDown => "wind-down",
        };
        write!(f, "{s}")
    }
}

pub fn current() -> Phase {
    let now = Local::now();
    if matches!(now.weekday(), Weekday::Sat | Weekday::Sun) {
        return Phase::Sleep;
    }
    if crate::holidays::is_krx_holiday(now.date_naive()) {
        return Phase::Sleep;
    }
    let mins = (now.hour() * 60 + now.minute()) as i32;
    if mins < 8 * 60 + 30 {
        Phase::Sleep
    } else if mins < 9 * 60 {
        Phase::WarmUp
    } else if mins <= 15 * 60 + 30 {
        Phase::Live
    } else if mins <= 16 * 60 {
        Phase::WindDown
    } else {
        Phase::Sleep
    }
}

pub fn is_active() -> bool {
    !matches!(current(), Phase::Sleep)
}

fn is_non_trading_day(d: chrono::NaiveDate) -> bool {
    matches!(d.weekday(), Weekday::Sat | Weekday::Sun) || crate::holidays::is_krx_holiday(d)
}

pub fn next_attach_time() -> DateTime<Local> {
    let now = Local::now();
    if is_active() {
        return now;
    }
    let attach = NaiveTime::from_hms_opt(8, 30, 0).unwrap();
    let mut date = now.date_naive();
    let mut candidate = NaiveDateTime::new(date, attach);
    if candidate <= now.naive_local() {
        date += chrono::Duration::days(1);
        candidate = NaiveDateTime::new(date, attach);
    }
    while is_non_trading_day(candidate.date()) {
        date += chrono::Duration::days(1);
        candidate = NaiveDateTime::new(date, attach);
    }
    Local
        .from_local_datetime(&candidate)
        .single()
        .unwrap_or_else(|| now + chrono::Duration::hours(1))
}

pub fn spawn_watchdog(cancel: CancellationToken) {
    tokio::spawn(async move {
        let mut last = current();
        info!("[PHASE] startup phase: {last}");
        if matches!(last, Phase::Sleep) {
            let next = next_attach_time();
            info!(
                "[PHASE] 다음 active 시각: {}",
                next.format("%Y-%m-%d %H:%M")
            );
        }
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                _ = cancel.cancelled() => return,
            }
            let cur = current();
            if cur != last {
                info!("[PHASE] {last} → {cur}");
                last = cur;
            }
        }
    });
}
