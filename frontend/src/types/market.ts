export interface ETFTick {
  code: string
  name: string
  price: number
  nav: number
  spread_bp: number
  spread_bid_bp: number
  spread_ask_bp: number
  volume: number
  /** 당일 누적 거래량 (S3_의 value × 백만 또는 t1102 value). ETF 페이지 거래대금 표시용. */
  cum_volume: number
  timestamp: string
  /** 전일 종가 — 변화율 계산용. t1102 초기에서만 발행, bridge가 sticky 보존. */
  prev_close?: number
  /** 그 체결의 단일 수량 (LS S3_/K3_의 cvolume). 누적 volume과 별개. 초기 fetch / I5_(NAV-only)는 미발행. */
  last_trade_volume?: number
  /** 매수/매도 구분 (+1 매수, -1 매도). LS cgubun. 모르는 케이스 미발행. */
  trade_side?: 1 | -1
  /** 매매정지 (t1405). ETF도 정지 가능. */
  halted?: boolean
  /** VI 발동 상태 (VI_ stream). ETF도 VI 발동 가능. */
  vi_active?: boolean
}

export interface StockTick {
  code: string
  name: string
  price: number
  volume: number
  cum_volume: number
  timestamp: string
  /** true = t8402/t1102 초기 스냅샷. 이미 실시간 값 있으면 무시. */
  is_initial?: boolean
  /** 당일 고가 — 백엔드(S3_/K3_/t1102)가 보내거나, marketStore가 running max로 보강 */
  high?: number
  /** 당일 저가 */
  low?: number
  /** 전일 종가 — 변화율 계산용. 초기값에서 한 번 발행되고 store에서 sticky로 보존. */
  prev_close?: number
  /** 그 체결의 단일 수량 (LS S3_/K3_의 cvolume). t1102/초기 fetch는 미발행. */
  last_trade_volume?: number
  /** 매수/매도 구분 (+1 매수, -1 매도). */
  trade_side?: 1 | -1
  /** 매매정지 상태 (t1405 jongchk=2). true면 가격/거래량 무의미 — UI는 "거래정지" 표시, 차익 계산은 null. */
  halted?: boolean
  /** 상한가 (t1102 uplmtprice). 당일 거의 안 변함 — t1102 초기 fetch 시 한 번 박힘. */
  upper_limit?: number
  /** 하한가 (t1102 dnlmtprice). */
  lower_limit?: number
  /** VI(변동성완화장치) 발동 상태 (VI_ stream). true면 2분 단일가 매매 중 — 즉각 거래 불가. */
  vi_active?: boolean
  /** 투자경고 종목 (t1405 jongchk=1). 거래 가능, 위험 종목 표시. */
  warning?: boolean
  /** 정리매매 종목 (t1405 jongchk=3). 상장폐지 직전. */
  liquidation?: boolean
  /** 이상급등 (t1102 abnormal_rise_gu). */
  abnormal_rise?: boolean
  /** 저유동성 (t1102 low_lqdt_gu). 호가 깊이 얕음. */
  low_liquidity?: boolean
  /** 관리종목 (t1404). 재무 부실 등 위험. */
  under_management?: boolean
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

/** 지수선물 (KOSPI200/미니/KOSDAQ150, LS FC9). 주식선물 FuturesTick과 별도 스트림.
 *  LP FV_futures 앵커(lp-system-design.md §13.3-A)용 이론가·기초지수 포함. */
/** 지수선물 상품 구분 (LS 코드 A+상품2: 01 KOSPI200 / 05 미니 / 06 KOSDAQ150) */
export type IndexFuturesProduct = 'kospi200' | 'mini_k200' | 'kosdaq150'

export interface IndexFuturesTick {
  code: string
  name: string
  product: IndexFuturesProduct
  price: number
  /** 전일대비 */
  change: number
  /** 등락률 % */
  change_rate: number
  /** 기초지수 레벨 (FC9 k200jisu). 없으면 0. */
  underlying_index: number
  /** 시장 베이시스 = 선물가 - 기초지수. */
  basis: number
  /** 이론가 (FC9 theoryprice). LP FV_futures 앵커. */
  theory_price?: number
  volume: number
  open_interest?: number
  open_interest_change?: number
  timestamp: string
  is_initial?: boolean
}

/** 지수선물 총잔량 (LS FH9). "선물" 탭 — 호가 레벨 없이 매도/매수 총잔량 + 비율만.
 *  서버(Rust 8200)가 상시 구독하며 product별 500ms throttle로 발행. */
export interface IndexFuturesDepthTick {
  code: string
  product: IndexFuturesProduct
  /** 총 매도잔량 */
  total_ask_qty: number
  /** 총 매수잔량 */
  total_bid_qty: number
  /** 매수÷매도. >1이면 매수우위. 매도잔량 0이면 미발행. */
  ratio?: number
  /** 수신 시각 (epoch ms) */
  time_ms: number
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

/** 거래대금 틱 — 외부망 ETF 거래대금 30초 폴링(t8407 REST) 전용. 순위 매기기용. */
export interface VolumeTick {
  code: string
  cum_volume: number
}

export type NetworkMode = 'internal' | 'external' | 'mock'
