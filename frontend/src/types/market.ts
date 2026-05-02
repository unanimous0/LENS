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
  /** 당일 고가 — 백엔드(S3_/K3_/t1102)가 보내거나, marketStore가 running max로 보강 */
  high?: number
  /** 당일 저가 */
  low?: number
  /** 전일 종가 — 변화율 계산용. 초기값에서 한 번 발행되고 store에서 sticky로 보존. */
  prev_close?: number
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
  /** 미결제약정수량 (LS JC0 openyak / t8402 mgjv) */
  open_interest?: number
  /** 미결제약정 전일대비 증감 (LS JC0 openyakcha / t8402 mgjvdiff) */
  open_interest_change?: number
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
