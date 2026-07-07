//! LP 시그널 데스크 데이터 모델.
//!
//! 핵심: ETF × 헤지 경로 매트릭스의 셀(`FairValueCell`)이 매 틱 갱신되어
//! `FairValueMatrixSnapshot`으로 프론트에 broadcast됨. 별도 `BookRiskSnapshot`은
//! 사용자 수동 포지션 기반 #2 베타조정 델타 + #3 잔차위험 산출 결과.
//!
//! 첫 빌드는 5종 enum 중 `PdfBasket` / `StockFuturesIntersect` 만 채움.
//! 나머지(`IndexFutures`/`CorrelatedEtf`/`BetaHedge`)는 자리 정의만 — 다음 빌드 wire.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::Serialize;

/// 헤지 경로 식별자.
///
/// JSON 직렬화: `{"kind": "pdf_basket"}` / `{"kind": "index_futures", "code": "..."}` 식의 internally tagged.
/// 베타값 같은 *연속 파라미터*는 enum에 두지 않고 `FairValueCell`의 별도 필드로 — Hash/Eq 보존.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HedgeRoute {
    /// ① PDF 전종목 바스켓 — Σ(qty × current_price) + cash.
    PdfBasket,
    /// ② PDF ∩ 주식선물 마스터 교집합 — 교집합 종목은 주식선물가, 잔여는 PDF 현물가.
    StockFuturesIntersect,
    /// ③ 지수선물 (KQ150 / KOSPI200F 등). 다음 빌드 wire.
    IndexFutures { code: String },
    /// ④ 상관 ETF (같은 지수 또는 같은 섹터의 다른 ETF). 다음 빌드 wire.
    CorrelatedEtf { peer_code: String },
    /// ⑤ 베타 헤지 (지수선물 + 베타 회귀). 다음 빌드 wire. 실제 베타값은 `FairValueCell.beta` 등 별도 필드.
    BetaHedge { hedge_code: String },
}

/// ETF × 헤지 경로 매트릭스의 한 셀.
///
/// Level 2 (raw fair value) + Level 3 (헤지비용 차감 net) 모두 포함.
/// 데이터 품질 지표(`inputs_age_ms`, `inputs_covered_pct`, `missing_components`)는
/// UI 신선도 배지 + 신뢰도 측정의 핵심 입력.
#[derive(Debug, Clone, Serialize)]
pub struct FairValueCell {
    pub etf_code: String,
    pub route: HedgeRoute,

    /// Level 2 — raw fair value (헤지비용 차감 전)
    pub fair_value: f64,

    /// Level 3 매수 진입 net = fair_value − slippage_bp − carry_cost
    pub net_fv_buy: f64,
    /// Level 3 매도 진입 net = fair_value + carry_income − slippage_bp − 거래세(20bp, 매도 측)
    pub net_fv_sell: f64,

    /// 매수 edge = (current_price − net_fv_buy) / current_price × 10000
    /// 양수면 현재가가 net_fv보다 비쌈 → 매도 유리. (의사결정 부호는 프론트가 결정)
    pub edge_buy_bp: f64,
    /// 매도 edge = (net_fv_sell − current_price) / current_price × 10000
    pub edge_sell_bp: f64,

    /// 가장 오래된 입력의 나이 (ms). 신선도 배지 표시용.
    pub inputs_age_ms: u32,
    /// PDF 비중 중 실제 가격 잡힌 비율 (0.0 ~ 1.0). 1.0이면 모든 종목 가격 확보.
    pub inputs_covered_pct: f64,
    /// 가격 못 잡은 종목 코드 (디버깅용). 비어있는 게 정상.
    pub missing_components: Vec<String>,

    /// 거래 가능 여부 — halted/VI/usable=false 등 게이트 통과 여부.
    pub usable: bool,

    pub computed_at_ms: u64,
}

/// 한 ETF의 fair value 스냅샷 — 그 시점 가용한 모든 셀.
#[derive(Debug, Clone, Serialize)]
pub struct EtfFairValueSnapshot {
    pub etf_code: String,
    pub etf_price: f64,
    pub cells: Vec<FairValueCell>,
    /// edge_buy_bp가 가장 작은 (= 매수 가장 유리) 셀의 cells 인덱스. 가용 셀 없으면 None.
    pub best_route_buy: Option<usize>,
    /// edge_sell_bp가 가장 큰 (= 매도 가장 유리) 셀의 cells 인덱스.
    pub best_route_sell: Option<usize>,
    pub timestamp: String,
}

/// 매트릭스 전체 스냅샷 — 매 throttle 윈도우(50~200ms)마다 broadcast.
#[derive(Debug, Clone, Serialize)]
pub struct FairValueMatrixSnapshot {
    pub snapshots: Vec<EtfFairValueSnapshot>,
    pub timestamp: String,
}

/// 데스크 보유 포지션 (수동 입력 기반, 가상 북도 OK).
/// 코드 → 부호있는 수량 (양수=롱, 음수=숏). ETF / 주식 / 선물 모두 한 맵에.
#[derive(Debug, Clone, Serialize)]
pub struct DeskBook {
    pub positions: HashMap<String, i64>,
    pub updated_at: String,
}

/// PDF 4숫자의 #4 — 첫 빌드 시점에는 None(스텁). 다음 빌드에서 체결 데이터 인입 후 채움.
#[derive(Debug, Clone, Serialize)]
pub struct PnLBreakdown {
    pub spread: f64,
    pub inventory: f64,
    pub hedge_cost: f64,
    pub basis: f64,
}

// =============================================================================
// 호가 보드 (§13.3-A FV_futures) — PR-B
// =============================================================================

/// 호가 요구 엣지 분해 (bp). skew는 부호 있음(롱 재고 → 음수), hedge_cost는 정보용 별도.
#[derive(Debug, Clone, Serialize)]
pub struct QuoteComponents {
    /// 기본 반스프레드
    pub base: f64,
    /// 역선택 버퍼
    pub buffer: f64,
    /// 잔차위험 charge (섹터형만 >0)
    pub residual: f64,
    /// 재고 skew (부호 有: 롱 재고 → 음수 → 예약가격 하향)
    pub skew: f64,
    /// 헤지 비용 (정보용 — 호가 가격엔 미반영, 수익성 판단용 별도 차감)
    pub hedge_cost: f64,
}

/// 한 ETF의 호가 제안 (§13.3-A). 자동 제출 X — "제안" 데이터.
#[derive(Debug, Clone, Serialize)]
pub struct QuoteRow {
    pub code: String,
    pub name: String,
    /// ETF 현재가 (틱). 0이면 결측.
    pub price: f64,
    /// FV_futures 호가 앵커. no_quote면 0 가능.
    pub fv_futures: f64,
    /// 'index' | 'beta'
    pub fv_mode: String,
    /// 소속 지수 가족: "k200" | "kq150"
    pub index_family: String,
    /// 함축 지수 수익률 (직전 지수 종가 대비, 소수).
    pub r_implied: f64,
    /// 지수선물에서 캐리 역산한 함축 현물지수.
    pub implied_index_spot: f64,
    /// 호가에 쓰인 지수선물 코드.
    pub futures_code: String,
    /// LS 이론가 (FC9 theoryprice) — 참고 필드(§9.7). 자체 금리 기준 S_impl과 별개.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub futures_theory_price: Option<f64>,

    /// 매수 호가까지 요구 엣지 (bp, FV 하단 거리) = base+buffer+residual − skew
    pub edge_bid_bp: f64,
    /// 매도 호가까지 요구 엣지 (bp, FV 상단 거리) = base+buffer+residual + skew
    pub edge_ask_bp: f64,
    /// 재고 skew (bp, 부호 有). QuoteComponents.skew와 동일 — 상단 요약용.
    pub skew_bp: f64,
    pub components: QuoteComponents,

    /// 제안 매수/매도 호가 (호가단위 rounding 적용). no_quote면 0.
    pub suggested_bid: f64,
    pub suggested_ask: f64,
    /// 제안 수량 (주) — v1은 재고 한도 잔여 기준.
    pub suggested_size: i64,
    /// 제안 수량 근거 문자열.
    pub size_basis: String,
    /// 재고 한도 잔여 (원).
    pub inventory_remaining_krw: f64,

    /// 입력(지수선물/ETF틱) 중 가장 오래된 나이 (ms).
    pub inputs_age_ms: u32,
    /// 호가 가능 여부 (no_quote_reason 없음).
    pub usable: bool,
    /// 불가 사유 (usable=false일 때). 빈 문자열이면 usable.
    pub no_quote_reason: String,
}

/// 호가 보드 스냅샷 — 200ms throttle broadcast (매트릭스와 함께).
#[derive(Debug, Clone, Serialize)]
pub struct QuoteBoardSnapshot {
    pub rows: Vec<QuoteRow>,
    pub timestamp: String,
}

// =============================================================================
// 헤지 티켓 (§13.3-B) — 북 순 델타를 지수선물로 0 만드는 상시 티켓
// =============================================================================

/// 헤지 티켓 leg 1건 — 지수선물 한 계약 종류의 매매 지시.
#[derive(Debug, Clone, Serialize)]
pub struct HedgeLeg {
    /// 실제 front-month 지수선물 코드 (A + 8자리). 원장 기장/주문에 그대로 사용.
    pub code: String,
    /// 표시용 이름 ("KOSPI200 선물" / "KOSPI200 미니선물" / "KOSDAQ150 선물").
    pub name: String,
    /// "buy" | "sell".
    pub side: String,
    /// 계약 수 (양수). 부호는 side로.
    pub contracts: i64,
}

/// 한 지수 가족의 헤지 티켓 (§13.3-B). 개별 체결별이 아니라 **북 단위 상시 티켓** —
/// 반대 재고가 있으면 residual이 작아져 자연히 "헤지 불필요"(넷팅)가 된다.
#[derive(Debug, Clone, Serialize)]
pub struct HedgeTicket {
    /// "k200" | "kq150".
    pub family: String,
    /// ETF·현물 재고에서 나온 가족 델타 (원). 지수형 ETF는 노출×L, 섹터형·현물은 노출×β.
    pub net_delta_krw: f64,
    /// 원장의 기존 지수선물 포지션이 이미 제공하는 델타 (원, 부호 有 — 숏이면 음수).
    pub existing_futures_delta_krw: f64,
    /// 티켓 실행 전 총 잔여 델타 (원) = net_delta + existing_futures (부호 有).
    /// 반대 재고/기존 선물이 넷팅하면 0에 가까워진다.
    pub residual_delta_krw: f64,
    /// 잔여 델타를 상쇄하는 계약 지시. 비어 있으면 "헤지 불필요" (넷팅/라운딩 내).
    pub ticket: Vec<HedgeLeg>,
    /// 티켓 실행 후 남는 델타 (원, 부호 有). 미니 라운딩 잔차 — 본계약+미니로 못 잡는 KRW.
    pub rounding_residual_krw: f64,
    /// 티켓에 쓰인 지수선물 시세 나이 (ms). stale 판정 입력.
    pub futures_price_age_ms: u32,
    /// 티켓 산출 가능 여부 — 지수선물 미수신/stale이면 false.
    pub usable: bool,
    /// usable=false 사유 (빈 문자열이면 usable).
    pub reason: String,
}

/// 북 단위 리스크 스냅샷 — #2 베타조정 델타 + #3 잔차위험.
/// #1 자체 기준가는 매트릭스 셀에서 자연스럽게 보이므로 여기 두지 않음.
/// #4 손익 분해는 `pnl_today: None` 스텁 (TODO 빈 박스).
#[derive(Debug, Clone, Serialize)]
pub struct BookRiskSnapshot {
    /// #2 베타조정 델타 (원화) = Σ(포지션가치 × 베타)
    pub beta_adj_delta_krw: f64,
    /// 총 델타 (베타 미적용, 원화) — 비교용
    pub gross_delta_krw: f64,
    /// #3 잔차위험 1σ 일변동 예상 (원화). 팩터 헤지 후 종목 고유 분산 합.
    pub residual_risk_krw: f64,
    /// 지수별 델타 분해 (예: "K200" → 1.2e9, "KQ150" → -0.3e9)
    pub delta_by_index: HashMap<String, f64>,
    /// 섹터별 노출 분해 (예: "반도체" → 5e8)
    pub sector_exposures: HashMap<String, f64>,
    /// 잔차 기여도 상위 종목 (코드, 기여 원화). 디버깅/투명성.
    pub top_residual_contributors: Vec<(String, f64)>,
    /// #4 손익 분해 — 첫 빌드는 None.
    pub pnl_today: Option<PnLBreakdown>,
    /// 베타·잔차 매핑이 없어 *베타조정 델타/잔차위험에 반영되지 않은* 포지션 (선물 등).
    /// 첫 빌드에서 주식선물/지수선물 포지션이 여기로 들어감. 다음 빌드에 base_stock 매핑으로 환산.
    /// (code, qty) — qty는 부호 있음.
    pub unmapped_positions: Vec<(String, i64)>,
    /// 가족별 헤지 티켓 (§13.3-B). compute_book_risk는 빈 Vec, scheduler가 채움.
    #[serde(default)]
    pub hedge_tickets: Vec<HedgeTicket>,
    pub timestamp: String,
}
