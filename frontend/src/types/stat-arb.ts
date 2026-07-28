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

// ---------------------------------------------------------------------------
// M:N (Sparse CCA) — /mn-pairs/detail 응답. **일봉 전용**.
// ---------------------------------------------------------------------------

/** 합성 바스켓의 leg 1개. weight = CCA 가중치(로그가격 계수)이지 주수가 아니다. */
export type MnLeg = {
  key: string
  name: string
  weight: number
  /** leg 분류 태그 (stock/index/ETF 카테고리). 구버전 응답엔 없을 수 있음. */
  class?: string
}

/** Johansen 공적분 검정 결과 (PR-D) — leg 로그가격 **레벨** 시스템 전체의 대칭 검정.
 *
 *  배열은 전부 길이 n(=leg 수)이고 인덱스 = 검정 단계 r (0-based).
 *  `coint_vector` 인덱스 순서는 `x_legs` → `y_legs` 연결 순, 정규화는 L2=1 + 첫 비영 성분 양수.
 *  임계값은 MacKinnon-Haug-Michelis(1999) 비제약 상수 케이스. n−r > 12는 표 밖 → null(미판정). */
export type Johansen = {
  n_vars: number
  /** 유효 표본 T (= 입력 길이 − lags). */
  n_obs: number
  lags: number
  /** 일반화 고유값 λ 내림차순. */
  eigenvalues: number[]
  /** r별 trace 통계량 −T·Σ_{i>r} ln(1−λᵢ). */
  trace_stats: number[]
  trace_crit_95: (number | null)[]
  trace_crit_99: (number | null)[]
  max_eig_stats: number[]
  max_eig_crit_95: (number | null)[]
  /** trace·95% 기준 추정 공적분 rank. 표 범위 밖이면 null. */
  rank_95: number | null
  rank_99: number | null
  /** 최대 고유값에 대응하는 공적분 벡터 (leg 순서 = x_legs → y_legs). */
  coint_vector: number[]
}

/** M:N 페어 상세.
 *
 *  1:1(`PairDetail`)과 달리 공간이 **합성 로그가격**이다:
 *    X(t) = Σ wᵢ·ln Pᵢ(t),  Y(t) = Σ vⱼ·ln Pⱼ(t),  잔차 = Y − α − β·X.
 *  → spread_series의 left/right는 원 단위 가격이 아니라 합성 X/Y (로그). spread도 로그 스케일
 *    (×100 ≈ 균형 대비 % 편차). timeframe은 항상 '1d'. */
export type MnPairDetail = {
  group_id: string
  group_name: string
  /** 그룹 내 성분 순번 (1-based, deflation). */
  component_idx: number
  /** 양변 분할에 쓰인 PCA factor (1-based). 0 = ETF 자연분할(ETF↔보유주식). */
  split_factor: number
  /** 항상 '1d'. */
  timeframe: string
  x_legs: MnLeg[]
  y_legs: MnLeg[]
  alpha: number
  hedge_ratio: number
  r_squared: number
  adf_tstat: number
  /** 반감기 (거래일). */
  half_life: number
  z_score: number
  /** 합성 시리즈 로그수익률 Pearson corr (상세 재계산값). */
  corr: number
  /** 발굴 시점 CCA canonical correlation. */
  cca_correlation: number
  sample_size: number
  /** 공통 거래일 중 가격 결측(close ≤ 0)으로 제외된 봉 수. */
  skipped_bars: number
  /** z_live = (Y_live − α − β·X_live − resid_mean) / resid_std. */
  resid_mean: number
  resid_std: number
  spread_series: SpreadPoint[]
  histogram: HistBin[]
  /** 잔차 정규화 기준 (M:N은 일봉 1벌뿐이라 resid_mean/resid_std와 동일). */
  spread_center: number
  spread_scale: number
  /** 표본<30·필터 실패 시 없음. */
  kalman?: KalmanStat | null
  /** Johansen 공적분 검정. 표본 부족·수치 실패·구버전 응답 시 없음. */
  johansen?: Johansen | null
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
