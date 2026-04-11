export interface ETFTick {
  code: string
  name: string
  price: number
  nav: number
  spread_bp: number
  volume: number
  timestamp: string
}

export interface FuturesTick {
  code: string
  name: string
  price: number
  underlying_price: number
  basis_bp: number
  volume: number
  timestamp: string
}

export interface PortfolioGreeks {
  total_delta: number
  total_gamma: number
  total_vega: number
  total_theta: number
  delta_by_index: Record<string, number>
  delta_by_sector: Record<string, number>
  risk_usage_pct: number
  timestamp: string
}

export interface ScenarioPnL {
  scenario: string
  expected_pnl: number
}

export type NetworkMode = 'internal' | 'external' | 'mock'
