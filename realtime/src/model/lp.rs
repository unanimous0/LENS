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
    pub timestamp: String,
}
