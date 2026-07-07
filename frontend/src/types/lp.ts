// LP 매트릭스 / 북리스크 / 포지션 / 비용 인풋 타입.
// Rust realtime.src/model/lp.rs · backend/routers/lp.py 와 1:1 대응.

export interface HedgeRoute {
  kind:
    | 'pdf_basket'
    | 'stock_futures_intersect'
    | 'index_futures'
    | 'correlated_etf'
    | 'beta_hedge'
  // struct variant 필드들 — 첫 빌드 wire 2종(pdf_basket, stock_futures_intersect)에는 추가 필드 없음
  code?: string
  peer_code?: string
  hedge_code?: string
}

export interface FairValueCell {
  etf_code: string
  route: HedgeRoute
  fair_value: number
  net_fv_buy: number
  net_fv_sell: number
  edge_buy_bp: number
  edge_sell_bp: number
  inputs_age_ms: number
  inputs_covered_pct: number
  missing_components: string[]
  usable: boolean
  computed_at_ms: number
}

export interface EtfFairValueSnapshot {
  etf_code: string
  etf_price: number
  cells: FairValueCell[]
  best_route_buy: number | null
  best_route_sell: number | null
  timestamp: string
}

export interface FairValueMatrixSnapshot {
  snapshots: EtfFairValueSnapshot[]
  timestamp: string
}

export interface PnLBreakdown {
  spread: number
  inventory: number
  hedge_cost: number
  basis: number
}

// ---- 헤지 티켓 (§13.3-B) — realtime/src/model/lp.rs HedgeTicket 과 1:1 ----

export interface HedgeLeg {
  /** 실제 front-month 지수선물 코드 (A+8자리). */
  code: string
  /** 표시용 이름 ("KOSPI200 선물" / "KOSPI200 미니선물" / "KOSDAQ150 선물"). */
  name: string
  side: 'buy' | 'sell'
  /** 계약 수 (양수). */
  contracts: number
}

export interface HedgeTicket {
  family: string // "k200" | "kq150"
  /** ETF·현물 재고에서 나온 가족 델타 (원). */
  net_delta_krw: number
  /** 기존 지수선물이 이미 제공하는 델타 (원, 부호 有). */
  existing_futures_delta_krw: number
  /** 티켓 전 총 잔여 델타 = net + existing. */
  residual_delta_krw: number
  /** 잔여를 상쇄하는 계약 지시. 비어 있으면 "헤지 불필요". */
  ticket: HedgeLeg[]
  /** 티켓 후 남는 델타 (원, 미니 라운딩 잔차). */
  rounding_residual_krw: number
  futures_price_age_ms: number
  usable: boolean
  reason: string
}

// ---- 베이시스 북 (§13.4 Phase 4) — realtime/src/model/lp.rs 와 1:1 ----

export interface StockBasisPair {
  base_code: string
  name: string
  /** 현물 순 수량 (부호 有, 주). */
  spot_qty: number
  fut_code: string
  /** 주식선물 순 수량 (부호 有, 주환산). */
  fut_qty: number
  /** 겹침 주수 (양수). */
  matched_shares: number
  /** 부호 적용 겹침 (= sign(spot)×matched). convergence_pnl 부호원. */
  matched_signed_shares: number
  spot_price: number
  fut_price: number
  /** 진입 베이시스 (주당 원). 없으면 null. */
  entry_basis: number | null
  /** 실측 베이시스 = 선물가 − 현물가. */
  basis_now: number
  basis_theory: number
  excess_now: number
  /** 수렴 손익 (원) = (entry − now) × matched_signed. 진입 없으면 null. */
  convergence_pnl: number | null
  /** 겹침 명목 (원) = matched_shares × spot_price. */
  matched_notional_krw: number
  /** 실보유 계약(front/back)의 만기 D-day. expiry_known=false면 무의미(0). */
  days_to_expiry: number
  /** 만기 확인 여부 — futures_master에 계약 코드 없으면 false (만기 미상). */
  expiry_known: boolean
  /** 현재 베이시스의 연환산 bp. */
  annualized_bp: number
  /** 만기 D-5 이내 (현금결제 — 현물 leg 처리 필요). 만기 미상이면 false. */
  expiry_action_needed: boolean
  usable: boolean
  reason: string
}

export interface IndexBasisExposure {
  family: string // "k200" | "kq150"
  /** 지수형 ETF 지수 환산 델타 합 (부호 有, 원) = Σ 노출 × L. */
  etf_leg_krw: number
  /** 지수선물 오버레이 델타 (부호 有, 원). */
  fut_leg_krw: number
  /** 매칭된 베이시스 크기 (부호 有 — 양수=베이시스 롱). */
  net_basis_notional_krw: number
  /** 베이시스 10bp당 손익 (원). */
  sensitivity_per_10bp_krw: number
  days_to_expiry: number
  /** front month D-2 이내 → 롤 필요. */
  roll_needed: boolean
  futures_code: string
}

export interface BasisBookSnapshot {
  /** ① 방향 델타 (원) — 오버레이 후 잔여. */
  directional_delta_krw: number
  /** ② 지수 베이시스 (가족별). */
  index_basis: IndexBasisExposure[]
  /** ③ 종목 베이시스 페어. */
  stock_basis: StockBasisPair[]
  /** ③ 종목 베이시스 총 명목 (원). */
  stock_basis_total_krw: number
  /** ④ 잔차위험 1σ (원). */
  residual_risk_krw: number
  /** 만기 액션 필요 (종목 D-5 또는 지수 D-2). */
  any_expiry_action: boolean
  timestamp: string
}

// ---- P&L 5분해 + markout + 한도 (§13.3-C Phase 4 PR-E) — realtime/src/model/lp.rs 와 1:1 ----

export interface Unattributed {
  /** 스프레드 미귀속 fill 건수 (fv_at_fill 없음). */
  n: number
  /** 미귀속 fill 명목 합 (원, 크기). */
  notional_krw: number
}

export interface MarkoutStats {
  n_5m: number
  /** 5분 markout 평균 (bp). 음수 = 역선택. */
  avg_5m_bp: number
  n_30m: number
  avg_30m_bp: number
}

export interface LimitGauge {
  name: string
  /** 현재값 (원, 크기). */
  current: number
  /** 한도 (원). 0이면 미설정. */
  limit: number
  /** 사용률 = current/limit. */
  ratio: number
  /** 부연 (최대 재고 ETF 코드 등). */
  detail: string
}

export interface PnlDecompSnapshot {
  as_of: string
  /** 당일 북 MTM 총변화 (원, 전일 종가 대비). */
  total_mtm: number
  /** 스프레드 수익 (원) = Σ (fv_at_fill − fill_price) × signed_qty. */
  spread: number
  /** 베이시스 손익 — 종목 수렴손익 합 (원). */
  basis_stock: number
  /** 지수 베이시스 손익 상태 (v1 산출 불가 — 정직 표기). */
  basis_index_status: string
  /** 잔차/방향 손익 (원) — total − 나머지 역산 (완전 분해). */
  residual_directional: number
  /** 캐리 (원, 음수=비용). */
  carry: number
  /** 헤지 비용 (원, 음수). */
  hedge_cost: number
  unattributed: Unattributed
  markout: MarkoutStats
  /** 리스크 한도 4개 (§13.3-C). */
  limits: LimitGauge[]
  usable: boolean
  caveats: string[]
}

export interface BookRiskSnapshot {
  beta_adj_delta_krw: number
  gross_delta_krw: number
  residual_risk_krw: number
  delta_by_index: Record<string, number>
  sector_exposures: Record<string, number>
  top_residual_contributors: Array<[string, number]>
  pnl_today: PnLBreakdown | null
  unmapped_positions: Array<[string, number]>
  /** 가족별 헤지 티켓 (§13.3-B). */
  hedge_tickets: HedgeTicket[]
  timestamp: string
}

// ---- 베이시스 실행 라우터 (§13.4) — realtime/src/calc/basis_route.rs 와 1:1 ----

export interface BasisFuturesInfo {
  code: string
  name: string
  price: number
  expiry: string // YYYYMMDD
  days_left: number
  multiplier: number
}

export interface BasisRouteResponse {
  code: string
  input_code: string
  side: string
  qty: number
  spot_price: number
  futures: BasisFuturesInfo | null
  basis_now: number
  basis_theory: number
  excess_basis: number
  excess_bp: number
  verdict: 'futures' | 'spot' | 'no_futures' | 'stale' | 'no_data'
  verdict_reason: string
  qty_futures_contracts: number
  qty_futures_residual_shares: number
  inputs_age_ms: number
}

export interface LpCostInputs {
  tax_sell_bp: number
  base_rate_annual: number
  slippage_bp: number
  hold_days: number
}

export interface LpPositionsPayload {
  positions: Record<string, number>
  updated_at?: string | null
}

// ---- 북 원장 (§13.5 Phase 1) — backend/services/lp_ledger.py 와 1:1 ----

export type LedgerInstrument = 'etf' | 'stock' | 'index_fut' | 'stock_fut'
export type LedgerKind = 'carryover' | 'fill'
export type LedgerSide = 'buy' | 'sell'

export interface LedgerEntry {
  id: string
  ts: string
  code: string
  instrument: LedgerInstrument
  kind: LedgerKind
  side: LedgerSide
  qty: number
  price: number | null
  note: string | null
  /** 진입 베이시스 (선물가 − 현물가, 주당 원). §13.4 베이시스 대체 기장 leg에만. */
  entry_basis?: number | null
  /** 체결 시점 FV_futures 스냅샷 (§13.3-C 스프레드 귀속). ETF 유니버스 fill만. */
  fv_at_fill?: number | null
  /** 체결 시점 현재가(mid) 스냅샷. */
  mid_at_fill?: number | null
  name?: string | null
}

export interface LedgerAggregate {
  code: string
  name: string | null
  instrument: LedgerInstrument
  carryover_qty: number
  fills_qty: number
  fills_qty_today: number
  net_qty: number
  avg_price: number | null
  /** 진입 베이시스 qty 가중 평균 (주당 원). 없으면 null. */
  entry_basis?: number | null
  /** 주식선물 → 기초 종목 6자리 (베이시스 페어 태그용). 그 외 null/미제공. */
  base_code?: string | null
}

export interface LedgerSnapshot {
  entries: LedgerEntry[]
  aggregates: LedgerAggregate[]
  updated_at: string | null
}

/** 자산유형 그룹 표시 순서/라벨 */
export const LEDGER_GROUPS: Array<{ instrument: LedgerInstrument; label: string }> = [
  { instrument: 'etf', label: 'ETF 재고' },
  { instrument: 'index_fut', label: '지수선물 오버레이' },
  { instrument: 'stock_fut', label: '주식선물' },
  { instrument: 'stock', label: '현물' },
]

// ---- 호가 보드 (§13.3-A Phase 2 PR-B/PR-C) — realtime/src/model/lp.rs QuoteRow 와 1:1 ----

export interface QuoteComponents {
  /** 기본 반스프레드 (bp) */
  base: number
  /** 역선택 버퍼 (bp) */
  buffer: number
  /** 잔차위험 charge (bp, 섹터형만 >0) */
  residual: number
  /** 재고 skew (bp, 부호 有: 롱 재고 → 음수 → 예약가격 하향) */
  skew: number
  /** 헤지 비용 (bp, 정보용 — 호가 가격엔 미반영) */
  hedge_cost: number
}

export interface QuoteRow {
  code: string
  name: string
  /** ETF 현재가 (틱). 0이면 결측. */
  price: number
  /** FV_futures 호가 앵커. no_quote면 0 가능. */
  fv_futures: number
  fv_mode: 'index' | 'beta'
  /** 소속 지수 가족: "k200" | "kq150" */
  index_family: string
  /** 함축 지수 수익률 (직전 지수 종가 대비, 소수) */
  r_implied: number
  /** 지수선물에서 캐리 역산한 함축 현물지수 */
  implied_index_spot: number
  futures_code: string
  futures_theory_price?: number | null
  /** 매수 호가까지 요구 엣지 (bp) = base+buffer+residual − skew */
  edge_bid_bp: number
  /** 매도 호가까지 요구 엣지 (bp) = base+buffer+residual + skew */
  edge_ask_bp: number
  /** 재고 skew (bp, 부호 有) — components.skew와 동일, 상단 요약용 */
  skew_bp: number
  components: QuoteComponents
  /** 제안 매수/매도 호가 (호가단위 rounding). no_quote면 0. */
  suggested_bid: number
  suggested_ask: number
  /** 제안 수량 (주) — v1은 재고 한도 잔여 기준 */
  suggested_size: number
  size_basis: string
  /** 재고 한도 잔여 (원) */
  inventory_remaining_krw: number
  /** 입력(지수선물/ETF틱) 중 가장 오래된 나이 (ms) */
  inputs_age_ms: number
  usable: boolean
  /** 불가 사유 (usable=false일 때). 빈 문자열이면 usable. */
  no_quote_reason: string
}

export interface QuoteBoardSnapshot {
  rows: QuoteRow[]
  timestamp: string
}

/** 호가 제안 파라미터 (§13.3-A) — backend GET/POST /api/lp/quote-params 와 1:1. 전 필드 ge=0. */
export interface QuoteParams {
  base_spread_bp: number
  gamma: number
  adverse_buffer_bp: number
  hedge_cost_bp: number
  per_etf_inventory_limit_krw: number
  inventory_limit_overrides: Record<string, number>
  max_futures_contracts: number
  /** 베이시스 라우터(§13.4) 선물 대체 임계 (bp). */
  basis_threshold_bp: number
  // ── §13.3-C P&L·리스크 한도 (Phase 4 PR-E) ──
  /** 선물 체결 수수료 (bp × 명목) — 헤지비용 분해 v1. */
  futures_fee_bp: number
  /** 베이시스 일변동성 근사 (bp) — 베이시스 VaR 조잡 상수. */
  basis_vol_bp_daily: number
  /** 북 순 베타델타 한도 (오버레이 후, 원). */
  limit_net_delta_krw: number
  /** 잔차위험 1σ 총량 한도 (원). */
  limit_residual_krw: number
  /** 베이시스 VaR 한도 (원). */
  limit_basis_var_krw: number
}

export const DEFAULT_QUOTE_PARAMS: QuoteParams = {
  base_spread_bp: 5,
  gamma: 1,
  adverse_buffer_bp: 3,
  hedge_cost_bp: 2,
  per_etf_inventory_limit_krw: 1_000_000_000,
  inventory_limit_overrides: {},
  max_futures_contracts: 100,
  basis_threshold_bp: 5,
  futures_fee_bp: 0.3,
  basis_vol_bp_daily: 15,
  limit_net_delta_krw: 2_000_000_000,
  limit_residual_krw: 100_000_000,
  limit_basis_var_krw: 200_000_000,
}

/** matrix-config quote_universe 항목 — 모드 뱃지(배수/β)·override 편집용 메타. QuoteRow엔 없는 정적 입력. */
export interface QuoteUniverseMeta {
  code: string
  name: string | null
  index_family: string | null
  /** 부호 있는 일일 배수 (+1/+2/-1/-2). 섹터형은 null. */
  leverage: number | null
  fv_mode: 'index' | 'beta'
  /** 섹터형 베타 (KOSPI200 60일 OLS). */
  beta: number | null
}

/** UI에 표시할 5개 헤지 경로 컬럼 순서. ③은 PR-B(FV_futures)에서 wire됨. ④⑤는 빈 셀(placeholder). */
export const HEDGE_ROUTE_COLUMNS: Array<{
  kind: HedgeRoute['kind']
  label: string
  wiredInFirstBuild: boolean
}> = [
  { kind: 'pdf_basket', label: 'PDF 바스켓', wiredInFirstBuild: true },
  { kind: 'stock_futures_intersect', label: '∩ 주식선물', wiredInFirstBuild: true },
  { kind: 'index_futures', label: '지수선물', wiredInFirstBuild: true },
  { kind: 'correlated_etf', label: '상관 ETF', wiredInFirstBuild: false },
  { kind: 'beta_hedge', label: '베타 헤지', wiredInFirstBuild: false },
]
