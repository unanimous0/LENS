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

    // ── MID 기반 보강 (2026-07-09, §13.13) — 갭·차익 프레이밍 기준가 ──
    /// 갭·차익 프레이밍의 기준가. 호가 mid((best_bid+best_ask)/2)가 fresh면 mid,
    /// stale/결측이면 last(체결가) 폴백. 둘 다 없으면 0.
    pub ref_price: f64,
    /// 기준가 소스: "mid" | "last" | "none". UI 소형 배지.
    pub price_source: String,
    /// 최우선 매수호가 (0이면 호가 미수신). fresh 여부와 무관하게 마지막 관측값.
    pub best_bid: f64,
    /// 최우선 매도호가 (0이면 호가 미수신).
    pub best_ask: f64,
    /// 갭 (bp) = (ref_price − FV)/FV × 1e4. 음수=저평가(매수차 기회). 결측 시 0.
    /// 프론트가 row.price로 재계산하던 것을 mid 반영 기준가로 서버 산출 (단일 소스).
    pub gap_bp: f64,

    // ── 차익거래 프레이밍 (§13.13, 지수 차익 데스크 언어) ──
    /// 차익 방향: "buy"(저평가→ETF 매수+선물 매도=매수차) | "sell"(고평가=매도차) | "none".
    pub arb_side: String,
    /// 그 방향의 요구 엣지 (bp) — buy면 edge_bid_bp, sell이면 edge_ask_bp (skew 비대칭 반영).
    pub arb_edge_bp: f64,
    /// 진입선 도달률 (%) = |gap_bp| / arb_edge_bp × 100. 100% 이상이면 진입선 도달.
    /// arb_edge_bp ≤ 0 이거나 미usable이면 0.
    pub reach_pct: f64,
    /// 진입선 도달 여부 (arb_side ≠ none 이고 reach_pct ≥ 100) — 행 하이라이트 트리거.
    pub at_entry: bool,
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

// =============================================================================
// 베이시스 북 (§13.4 Phase 4) — 북 4층 분해 + 종목/지수 베이시스 명시 추적
// =============================================================================

/// 종목 베이시스 페어 (현물 ±q vs 주식선물 ∓q'). 수량 불일치 시 겹침(min)만 페어,
/// 잔여는 일반 포지션으로 남아 여기 안 잡힘.
///
/// 다월물: 같은 base의 선물 leg가 여러 개(근월+차월, 롤 주간)면 **만기 순으로 현물 잔량을
/// 순차 배분** (근월 우선) — 현물 전량이 월물마다 중복 페어링되는 이중계상 방지 (H1).
///
/// 부호 규약: `matched_signed_shares` = sign(현물 수량) × 겹침주수.
///   - 현물 롱 + 선물 숏 (매도 대체) → matched_signed > 0, **베이시스 축소 시 이익**.
///   - 현물 숏 + 선물 롱 (매수 대체) → matched_signed < 0, 베이시스 확대 시 이익.
/// `convergence_pnl = (entry_basis − basis_now) × matched_signed_shares` 로 4방향 일관.
#[derive(Debug, Clone, Serialize)]
pub struct StockBasisPair {
    pub base_code: String,
    pub name: String,
    /// 현물 순 수량 (부호 有, 주).
    pub spot_qty: i64,
    pub fut_code: String,
    /// 주식선물 순 수량 (부호 有, 주환산 — 원장이 계약×승수=주수로 기장).
    pub fut_qty: i64,
    /// 겹침 주수 (양수) = min(|spot_qty|, |fut_qty|).
    pub matched_shares: i64,
    /// 페어 부호가 적용된 겹침 (= sign(spot_qty) × matched_shares). convergence_pnl 부호원.
    pub matched_signed_shares: i64,
    pub spot_price: f64,
    pub fut_price: f64,
    /// 원장 진입 베이시스 (주당 원). 없으면 None → convergence_pnl None.
    pub entry_basis: Option<f64>,
    /// 실측 베이시스 = 선물가 − 현물가 (주당 원).
    pub basis_now: f64,
    /// 이론 베이시스 = spot × r × d/365 (배당 무시 v1).
    pub basis_theory: f64,
    /// excess = 실측 − 이론.
    pub excess_now: f64,
    /// 수렴 손익 (원) = (entry_basis − basis_now) × matched_signed_shares. 진입 없으면 None.
    pub convergence_pnl: Option<f64>,
    /// 겹침 명목 (원, 크기) = matched_shares × spot_price.
    pub matched_notional_krw: f64,
    /// 실보유 계약(front/back)의 만기까지 잔존일. expiry_known=false면 0 (의미 없음).
    pub days_to_expiry: i64,
    /// 만기 확인 여부 — futures_master(front/back)에 계약 코드가 없으면 false
    /// (만기 미상: D-day·이론 베이시스·연환산 무의미, 액션 플래그도 억제).
    pub expiry_known: bool,
    /// 현재 베이시스의 연환산 bp (만기 수렴 가정 캐리 수익률).
    pub annualized_bp: f64,
    /// 만기 D-5 이내 — 현금결제라 만기일 현물 leg 처리 액션 필수. 만기 미상이면 false.
    pub expiry_action_needed: bool,
    /// 가격 확보 여부 (현물·선물 틱 모두 있어야 베이시스 산출).
    pub usable: bool,
    /// 미산출 사유 (usable=false일 때).
    pub reason: String,
}

/// 지수 베이시스 노출 (지수형 ETF vs 지수선물), 가족 단위.
///
/// ETF 롱 + 선물 숏 매칭이 **베이시스 롱** (notional·sensitivity 양수).
#[derive(Debug, Clone, Serialize)]
pub struct IndexBasisExposure {
    /// "k200" | "kq150".
    pub family: String,
    /// 지수형 ETF의 지수 환산 델타 합 (부호 有, 원) = Σ 노출 × L.
    pub etf_leg_krw: f64,
    /// 원장 지수선물 오버레이 델타 (부호 有, 원) = Σ 계약 × 선물가 × 승수. hedge_ticket과 동일 소스.
    pub fut_leg_krw: f64,
    /// 매칭된 베이시스 포지션 크기 (부호 有 — 양수=베이시스 롱). 반대 부호일 때만 min(|·|), 아니면 0.
    pub net_basis_notional_krw: f64,
    /// 베이시스 10bp당 손익 (원) = net_basis_notional × 10bp. 부호는 notional과 동일.
    pub sensitivity_per_10bp_krw: f64,
    /// front-month 지수선물 만기까지 잔존일 (오버레이 롤 스케줄).
    pub days_to_expiry: i64,
    /// front month D-2 이내 → 롤 필요.
    pub roll_needed: bool,
    /// 만기 산정에 쓴 front 지수선물 코드 (없으면 빈 문자열).
    pub futures_code: String,
}

/// 베이시스 북 스냅샷 — 북 4층 분해 + 페어별 상세 (§13.4). 1초 주기 broadcast.
///
/// 4층: `방향 델타 + 지수 베이시스(가족별) + 종목 베이시스 + 잔차`.
#[derive(Debug, Clone, Serialize)]
pub struct BasisBookSnapshot {
    /// ① 방향 델타 (원) — 선물 오버레이 후 잔여 방향. hedge_ticket residual 합 (동일 소스).
    pub directional_delta_krw: f64,
    /// ② 지수 베이시스 (가족별).
    pub index_basis: Vec<IndexBasisExposure>,
    /// ③ 종목 베이시스 페어 목록.
    pub stock_basis: Vec<StockBasisPair>,
    /// ③ 종목 베이시스 총 명목 (원, 크기 합) = Σ matched_notional_krw.
    pub stock_basis_total_krw: f64,
    /// ④ 잔차위험 1σ (원) — book_risk #3 그대로.
    pub residual_risk_krw: f64,
    /// 만기 액션 필요 (종목 페어 D-5 또는 지수 오버레이 D-2) — UI 경고 배지 편의 플래그.
    pub any_expiry_action: bool,
    pub timestamp: String,
}

// =============================================================================
// P&L 5분해 + markout + 리스크 한도 (§13.3-C Phase 4 PR-E)
// =============================================================================

/// 스프레드 미귀속 fill (fv_at_fill 없음 — 비ETF·수동 기장 등). 별도 합계로 정직 표기.
#[derive(Debug, Clone, Serialize)]
pub struct Unattributed {
    pub n: i64,
    /// 미귀속 fill 명목 합 (원, 크기).
    pub notional_krw: f64,
}

/// markout 역선택 통계 (§13.3-C). fill 후 5분/30분 시점 가격변화 × 방향 부호 평균 (bp).
/// 음수 = 역선택 (LP가 준 유동성 방향으로 시장이 불리하게 움직임).
#[derive(Debug, Clone, Serialize)]
pub struct MarkoutStats {
    pub n_5m: i64,
    pub avg_5m_bp: f64,
    pub n_30m: i64,
    pub avg_30m_bp: f64,
}

/// 리스크 한도 게이지 1개 (§13.3-C 한도 4개).
#[derive(Debug, Clone, Serialize)]
pub struct LimitGauge {
    /// 표시명 ("순 델타(오버레이 후)" 등).
    pub name: String,
    /// 현재값 (원, 크기 — abs).
    pub current: f64,
    /// 한도 (원). 0이면 미설정.
    pub limit: f64,
    /// 사용률 = current / limit (limit>0). 0이면 미설정/미사용.
    pub ratio: f64,
    /// 부연 (최대 재고 ETF 코드 등). 없으면 빈 문자열.
    pub detail: String,
}

/// P&L 5분해 스냅샷 (§13.3-C). 당일 세션 기준(전일 종가 대비). 1초 주기 broadcast.
///
/// 완전 분해 보장 — residual attribution:
///   `total_mtm = spread + basis_stock + residual_directional + carry + hedge_cost`
/// (residual_directional은 총 MTM에서 나머지 항을 뺀 잔여로 역산 → 가산성 항등).
#[derive(Debug, Clone, Serialize)]
pub struct PnlDecompSnapshot {
    pub as_of: String,
    /// 당일 북 MTM 총변화 (원) — 전일 종가(비유니버스는 당일 첫 관측가 폴백) 대비.
    pub total_mtm: f64,
    /// 스프레드 수익 (원) = Σ (fv_at_fill − fill_price) × signed_qty (당일 fill).
    pub spread: f64,
    /// 베이시스 손익 — 종목만 (basis_book 수렴손익 합). 지수는 산출 불가(status).
    pub basis_stock: f64,
    /// 지수 베이시스 손익 상태 — 당일 베이시스 변화 미기록이라 v1 산출 불가 (정직 표기).
    pub basis_index_status: String,
    /// 잔차/방향 손익 (원) = total_mtm − (spread + basis_stock + carry + hedge_cost). 역산.
    pub residual_directional: f64,
    /// 캐리 (원) = −r × Σ|노출| × (당일 경과일/365). 음수 = 비용.
    pub carry: f64,
    /// 헤지 비용 (원) = −Σ 당일 선물 fill 명목 × futures_fee_bp. 음수.
    pub hedge_cost: f64,
    pub unattributed: Unattributed,
    pub markout: MarkoutStats,
    /// 리스크 한도 4개 (§13.3-C).
    pub limits: Vec<LimitGauge>,
    /// 산출 가능 여부 (포지션·체결 아무것도 없으면 false).
    pub usable: bool,
    /// 근사·결측 경고 (정직 표기).
    pub caveats: Vec<String>,
}
