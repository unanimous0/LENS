//! 시간대별 LS API 연결 게이트.
//!
//! 자정에 LS가 일일 토큰 갱신/유지보수로 모든 WS 연결을 끊는데, 우리가 즉시 재연결을
//! 폭주시키면 LS가 우리 IP를 차단할 수 있음 (silent 5 cycles → 300s backoff 신호).
//! 또 새벽엔 시세도 안 흐르므로 연결 유지 자체가 무의미.
//!
//! Phase별 동작:
//!   Sleep    : 야간/주말/공휴일 — LS 연결 시도 금지, 다음 attach 시각까지 대기
//!   WarmUp   : 장 시작 30분 전 (08:30~09:00) — attach
//!   Live     : 장중 09:00~15:30 — 정상 운영
//!   WindDown : 장 마감 후 30분 (15:30~16:00) — 잔여 틱 수신
//!   (16:00 이후 → Sleep)

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

/// 현재 phase. KST 기준.
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

/// 다음 attach 가능 시각 (다음 영업일 08:30 KST). 현재 active면 now 반환.
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

/// Sleep phase 동안 대기. Active 진입 시 true 반환. cancel 시 false.
/// label은 로그용 (어느 task가 sleeping 중인지 식별).
pub async fn wait_until_active(cancel: &CancellationToken, label: &str) -> bool {
    if is_active() {
        return true;
    }
    let next = next_attach_time();
    let now = Local::now();
    let total_secs = (next - now).num_seconds().max(60) as u64;
    info!(
        "[PHASE] {label}: sleep — next attach at {} ({}분 후)",
        next.format("%Y-%m-%d %H:%M"),
        total_secs / 60
    );
    // 5분 단위 wake-up — 캘린더 변경/시계 보정 등 ad-hoc 케이스 대비.
    let mut remaining = total_secs;
    while remaining > 0 {
        let chunk = remaining.min(300);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(chunk)) => {}
            _ = cancel.cancelled() => return false,
        }
        if is_active() {
            return true;
        }
        remaining = remaining.saturating_sub(chunk);
    }
    is_active()
}

/// Phase 변화 watchdog. 30초마다 phase polling, 변화 시 INFO 로그.
/// start_dev.sh 터미널 + logs/realtime.log 양쪽에서 시간대 전환 보임.
pub fn spawn_watchdog(cancel: CancellationToken) {
    tokio::spawn(async move {
        let mut last = current();
        info!("[PHASE] startup phase: {last}");
        if matches!(last, Phase::Sleep) {
            let next = next_attach_time();
            info!(
                "[PHASE] LS attach 예정 시각: {}",
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
