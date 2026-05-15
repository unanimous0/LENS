// stat-arb-engine /pairs/detail 응답 타입.

export type TimeframeStat = {
  timeframe: string // '30s' | '1m' | '5m' | '30m' | '1h' | '1d' | '1w' | '1mo'
  sample_size: number
  hedge_ratio: number
  alpha: number
  r_squared: number
  adf_tstat: number
  half_life: number // 그 timeframe의 단위 (30s timeframe이면 30s 개수)
  corr: number
  z_score: number
}

export type SpreadPoint = {
  ts: i64
  spread: number
  z: number
}

export type HistBin = {
  center: number
  count: number
}

export type PairDetail = {
  left_key: string
  right_key: string
  left_name: string
  right_name: string
  timeframes: TimeframeStat[]
  spread_series: SpreadPoint[]
  histogram: HistBin[]
}

// /pairs 응답의 페어 — 한 줄 요약 (메인 테이블에서 사용)
export type PairRow = {
  left_key: string
  right_key: string
  left_name: string
  right_name: string
  timeframe: string
  corr: number
  hedge_ratio: number
  alpha: number
  adf_tstat: number
  half_life: number
  r_squared: number
  z_score: number
  sample_size: number
  score: number
}

type i64 = number
