//! 사내 서버(ws://10.21.1.208:41001) 네이티브 메시지 타입.
//! 모든 숫자 값이 문자열로 전달되며, 시각은 epoch 마이크로초(i64).
//! 메시지는 항상 JSON 배열로 수신: `[{tick1}, {tick2}, ...]`

use serde::Deserialize;

/// 사내 서버 메시지 (ty 필드로 분기)
#[derive(Debug, Deserialize)]
#[serde(tag = "ty")]
pub enum InternalMsg {
    Trade(Trade),
    LpBookSnapshot(LpBookSnapshot),
    Index(Index),
    Auction(Auction),
    Status(Status),
}

/// 체결 메시지
#[derive(Debug, Deserialize)]
pub struct Trade {
    /// ISIN 종목코드 (e.g. "KR7005930003")
    pub s: String,
    /// 체결 가격 (문자열)
    pub tp: String,
    /// 체결 수량 (문자열)
    pub ts: String,
    /// 누적 체결 수량 (문자열)
    pub cs: String,
    /// 체결 플래그 (비트마스크: 1=BUY, 2=SELL, 4=OPEN_AUCTION, ...)
    pub fl: u32,
    /// 거래소 시각 (epoch 마이크로초)
    pub et: i64,
    /// 서버 수신 시각 (epoch 마이크로초)
    pub rt: i64,
    /// 거래소 코드 ("XKRX", "XKRF")
    pub ex: String,
}

/// 호가 스냅샷
#[derive(Debug, Deserialize)]
pub struct LpBookSnapshot {
    pub s: String,
    /// 매도호가: [[가격, 잔량, LP잔량], ...]
    pub a: Vec<[String; 3]>,
    /// 매수호가: [[가격, 잔량, LP잔량], ...]
    pub b: Vec<[String; 3]>,
    /// 중간가
    pub mp: String,
    pub ma: String,
    pub mb: String,
    pub fl: u32,
    pub et: i64,
    pub rt: i64,
    pub ex: String,
}

/// iNAV / rNAV / 선물이론가
#[derive(Debug, Deserialize)]
pub struct Index {
    pub s: String,
    /// 값1 (fl에 따라 의미 다름)
    pub i1: String,
    /// 값2 (fl에 따라 의미 다름, 빈 문자열일 수 있음)
    pub i2: String,
    /// IndexFlags 비트마스크
    pub fl: u32,
    pub et: i64,
    pub rt: i64,
    pub ex: String,
}

/// 단일가 예상 체결
#[derive(Debug, Deserialize)]
pub struct Auction {
    pub s: String,
    /// 예상 체결가
    pub ip: String,
    /// 예상 체결 수량
    pub is: String,
    /// 총 매도호가 잔량
    #[serde(rename = "as")]
    pub ask_size: String,
    /// 총 매수호가 잔량
    pub bs: String,
    pub fl: u32,
    pub et: i64,
    pub rt: i64,
    pub ex: String,
}

/// 매매정지/재개
#[derive(Debug, Deserialize)]
pub struct Status {
    pub s: String,
    pub fl: u32,
    pub et: i64,
    pub rt: i64,
    pub ex: String,
}

// ── IndexFlags 비트 상수 ──

pub const INDEX_EXCHANGE_NAV: u32 = 1;
pub const INDEX_REAL_NAV: u32 = 2;
pub const INDEX_FUTURES_IDEAL: u32 = 4;
pub const INDEX_TRADE: u32 = 8;
pub const INDEX_QUOTE: u32 = 16;

// ── ISIN ↔ 단축코드 변환 ──

/// ISIN(12자리)에서 핵심 코드를 추출.
/// - 주식/ETF: "KR7005930003" → "005930"
/// - 선물: "KR4A11650004" → "A1165000"
pub fn isin_to_short(isin: &str) -> Option<String> {
    if isin.len() != 12 {
        return None;
    }
    if isin.starts_with("KR7") {
        // 주식/ETF: [3..9]
        Some(isin[3..9].to_string())
    } else if isin.starts_with("KR4A") {
        // 선물: "KR4A" + 7자리 + 체크1자리 → "A" + 7자리
        Some(format!("A{}", &isin[4..11]))
    } else {
        None
    }
}

/// 단축코드에서 내부망 구독 코드로 변환.
/// - "005930" → "A005930"
/// - "A1165000" → "KA1165000"
pub fn short_to_subscribe(code: &str) -> String {
    if code.starts_with('A') && code.len() == 8 {
        // 선물: A + 7자리 → KA + 7자리
        format!("K{code}")
    } else if code.len() == 6 && code.chars().all(|c| c.is_ascii_digit()) {
        // 주식/ETF: 6자리 → A + 6자리
        format!("A{code}")
    } else {
        // 이미 적절한 형식이거나 알 수 없는 형식 → 그대로
        code.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_isin_to_short() {
        assert_eq!(isin_to_short("KR7005930003"), Some("005930".into()));
        assert_eq!(isin_to_short("KR7364980003"), Some("364980".into()));
        assert_eq!(isin_to_short("KR4A11650004"), Some("A1165000".into()));
        assert_eq!(isin_to_short("KR4A01660005"), Some("A0166000".into()));
        assert_eq!(isin_to_short("short"), None);
    }

    #[test]
    fn test_short_to_subscribe() {
        assert_eq!(short_to_subscribe("005930"), "A005930");
        assert_eq!(short_to_subscribe("A1165000"), "KA1165000");
        assert_eq!(short_to_subscribe("KA1165000"), "KA1165000");
    }
}
