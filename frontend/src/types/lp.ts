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

export interface BookRiskSnapshot {
  beta_adj_delta_krw: number
  gross_delta_krw: number
  residual_risk_krw: number
  delta_by_index: Record<string, number>
  sector_exposures: Record<string, number>
  top_residual_contributors: Array<[string, number]>
  pnl_today: PnLBreakdown | null
  unmapped_positions: Array<[string, number]>
  timestamp: string
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
}

export const DEFAULT_QUOTE_PARAMS: QuoteParams = {
  base_spread_bp: 5,
  gamma: 1,
  adverse_buffer_bp: 3,
  hedge_cost_bp: 2,
  per_etf_inventory_limit_krw: 1_000_000_000,
  inventory_limit_overrides: {},
  max_futures_contracts: 100,
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
