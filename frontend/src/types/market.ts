export interface ETFTick {
  code: string
  name: string
  price: number
  nav: number
  spread_bp: number
  spread_bid_bp: number
  spread_ask_bp: number
  volume: number
  timestamp: string
}

export interface StockTick {
  code: string
  name: string
  price: number
  volume: number
  cum_volume: number
  timestamp: string
}

export interface FuturesTick {
  code: string
  name: string
  price: number
  underlying_price: number
  /** 시장 베이시스 = 선물가 - 현물가 (순수 가격 차이) */
  basis: number
  volume: number
  timestamp: string
}

export interface OrderbookLevel {
  price: number
  quantity: number
}

export interface OrderbookTick {
  code: string
  name: string
  asks: OrderbookLevel[]
  bids: OrderbookLevel[]
  total_ask_qty: number
  total_bid_qty: number
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
