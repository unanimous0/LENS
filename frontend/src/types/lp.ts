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

/** UI에 표시할 5개 헤지 경로 컬럼 순서. ③④⑤는 첫 빌드 빈 셀(placeholder). */
export const HEDGE_ROUTE_COLUMNS: Array<{
  kind: HedgeRoute['kind']
  label: string
  wiredInFirstBuild: boolean
}> = [
  { kind: 'pdf_basket', label: 'PDF 바스켓', wiredInFirstBuild: true },
  { kind: 'stock_futures_intersect', label: '∩ 주식선물', wiredInFirstBuild: true },
  { kind: 'index_futures', label: '지수선물', wiredInFirstBuild: false },
  { kind: 'correlated_etf', label: '상관 ETF', wiredInFirstBuild: false },
  { kind: 'beta_hedge', label: '베타 헤지', wiredInFirstBuild: false },
]
