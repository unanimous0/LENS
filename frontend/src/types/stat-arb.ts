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
  /** 그 시점 left(x)/right(y) 종가 — % 등락 비교 차트용 (구버전 응답엔 없을 수 있음). */
  left?: number
  right?: number
}

export type HistBin = {
  center: number
  count: number
}

/** Kalman β_t 스파크라인 한 점. */
export type BetaPoint = {
  ts: number
  beta: number
}

/** Kalman 시변 헤지비율 요약 — 관계 안정성(β 드리프트) 감지. 일봉 기준. */
export type KalmanStat = {
  /** 적응 β 마지막값. */
  beta_current: number
  /** 전체표본 OLS β (정적). */
  beta_static: number
  /** |β_current − β_static| / |β_static| (0.15 = 15%). */
  beta_drift_pct: number
  /** 정적 z (OLS 잔차) = timeframes[1d].z_score 와 동일. */
  z_static: number
  /** 적응모델(Kalman) 기준 z (1-step std_innov). */
  z_adaptive: number
  /** |z_static − z_adaptive|. */
  z_gap: number
  stability: 'stable' | 'caution' | 'drift'
  /** (ts, β) 스파크라인 — 최대 200점 균등 다운샘플. */
  beta_series: BetaPoint[]
}

export type PairDetail = {
  left_key: string
  right_key: string
  left_name: string
  right_name: string
  timeframes: TimeframeStat[]
  spread_series: SpreadPoint[]
  histogram: HistBin[]
  /** 헤드라인(10분) 잔차 정규화 기준. 실시간 z = (liveSpread − spread_center) / spread_scale. */
  spread_center?: number
  spread_scale?: number
  /** 일봉(1d) 헤드라인 — 스윙 판단 기준 토글용. 구버전 응답엔 없을 수 있음. */
  spread_series_daily?: SpreadPoint[]
  histogram_daily?: HistBin[]
  daily_center?: number
  daily_scale?: number
  /** Kalman 시변 β 관계 안정성 (일봉 기준). 표본 부족·구버전 응답 시 없음. */
  kalman?: KalmanStat
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
  /** 최근 ~6개월 잔차(같은 β) ADF — 최근에도 평균회귀 유지하나 (안정성 게이트 겸 지표). */
  recent_adf_tstat: number
  half_life: number
  r_squared: number
  z_score: number
  sample_size: number
  score: number
  /** 잔차 정규화 기준 μ·σ — 라이브 z 재계산용. 구버전 엔진 응답엔 없음.
   *  z_live = (right − alpha − hedge_ratio×left − resid_mean) / resid_std. */
  resid_mean?: number
  resid_std?: number
  /** 관계 안정성 등급 (Kalman 시변 β). 미산출이면 빈 문자열. */
  stability?: string
}

type i64 = number
