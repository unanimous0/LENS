// 포지션 API 응답 타입 — backend routers/positions.py 와 동기.

export type PositionStatus = 'open' | 'closed'

export type PositionLeg = {
  id: number
  position_id: string
  asset_type: 'S' | 'E' | 'I' | 'F'
  code: string
  side: 1 | -1
  weight: number
  qty: number
  entry_price: number
  exit_price: number | null
}

export type PositionLoan = {
  id: number
  position_id: string
  leg_id: number
  qty: number
  rate_pct: number
  started_at: number
  ended_at: number | null
}

/** 진입 시점 통계량 freeze. alpha/beta/center/scale 4개가 고정 z(§24)의 좌표계다. */
export type PositionEntryStats = {
  alpha?: number
  beta?: number
  /** 잔차 중심 μ₀ (원). 2026-08-27 이후 기록에만 존재. */
  center?: number
  /** 잔차 σ₀ (원). 2026-08-27 이후 기록에만 존재 — 없으면 고정 z 계산 불가. */
  scale?: number
  /** α·β·μ·σ를 뜬 기준 timeframe ('1d' | '10m'). */
  basis?: string
  /** 'refit' = 진입일 기준으로 일봉을 다시 회귀해 되살린 밴드 (§24.8). 없으면 진입 시 스냅샷. */
  source?: string
  /** refit 밴드가 쓴 마지막 일봉 날짜 / 표본 수 (추적용). */
  asof?: string
  window_bars?: number
  half_life?: number
  adf?: number
  r2?: number
  // 향후 추가 필드
  [key: string]: number | string | undefined
}

export type Position = {
  id: string
  label: string | null
  status: PositionStatus
  opened_at: number
  closed_at: number | null
  left_key: string
  right_key: string
  entry_z: number | null
  entry_stats: PositionEntryStats | null
  note: string | null
  legs?: PositionLeg[]   // 상세 조회 시만
  loans?: PositionLoan[] // 상세 조회 시만
}

export type PositionListResp = {
  count: number
  items: Position[]
}

/** PUT 수정 시 서버가 알려주는 entry_z 처리 결과 (§24.7).
 *
 *  - refit      : 진입일 기준 재계산 밴드로 갈아끼우고 z도 그 자로 다시 계산 (§24.8)
 *  - recomputed : 저장 밴드 + 새 진입가로 서버 재계산 (밴드는 스냅샷이라 불변)
 *  - manual     : 밴드 미저장(구) 기록 — 사용자가 입력한 값 그대로
 *  - ignored    : 밴드가 있어 수동 입력값을 버림
 *  - unchanged  : 손대지 않음
 */
export type EntryZUpdate = {
  mode: 'refit' | 'recomputed' | 'manual' | 'ignored' | 'unchanged'
  previous: number | null
  value: number | null
  /** 정책·한계 설명 (밴드 소급 조회 불가 등). 화면에 그대로 노출 가능. */
  note: string | null
}

/** PUT 응답 = 갱신된 상세 + entry_z 처리 결과. */
export type PositionUpdateResp = Position & { entry_z_update?: EntryZUpdate }

/** `POST /api/positions/estimate-entry-band` 응답 — 진입일 기준으로 되살린 밴드 (§24.8).
 *
 *  엔진은 최신 사이클 통계만 들고 있지만 재료(일봉)는 남아 있어, 진입일 *이전* 창만으로
 *  같은 자(레벨 OLS)를 다시 세우면 그날의 α·β·μ·σ가 복원된다. `sigma`가 밴드의 `scale`. */
export type EntryBandEstimate = {
  left_key: string
  right_key: string
  entry_date: string
  alpha: number
  beta: number
  center: number
  sigma: number
  /** 보낸 진입가를 이 밴드로 잰 값 = 추정 진입 z. */
  entry_z: number
  spread: number
  r2: number | null
  adf: number | null
  half_life: number | null
  /** 회귀에 쓴 공통 일봉 수 / 창 길이(캘린더일). */
  window_bars: number
  window_days: number
  first_date: string
  /** 창의 마지막 일봉 날짜 (진입일 당일은 미포함 — 진입 시점엔 없던 봉). */
  asof: string
  basis: string
  source: 'refit'
}

/** PUT에 실어 보내는 재계산 밴드. 보내면 서버가 entry_stats를 갈아끼우고 entry_z도 재계산. */
export type EntryBandPayload = {
  alpha: number
  beta: number
  center: number
  scale: number
  basis: string
  source: 'refit'
  asof: string
  window_bars: number
  r2: number | null
  adf: number | null
  half_life: number | null
}

// 수정 요청 body — 보낸 필드만 반영 (명시적 null = 지움).
export type PositionUpdatePayload = {
  opened_at?: number
  label?: string | null
  note?: string | null
  /** 밴드 미저장 기록 전용 — 저장 밴드나 entry_band가 있으면 서버가 무시한다. */
  entry_z?: number | null
  /** 진입일 기준 재계산 밴드 (§24.8). entry_z보다 우선. */
  entry_band?: EntryBandPayload
  legs?: Array<{ leg_id: number; qty?: number; entry_price?: number }>
}

// 등록 요청 body
export type PositionCreatePayload = {
  label?: string
  note?: string
  left_key: string
  right_key: string
  entry_z?: number
  entry_stats?: PositionEntryStats
  legs: Array<{
    asset_type: 'S' | 'E' | 'I' | 'F'
    code: string
    side: 1 | -1
    weight: number
    qty: number
    entry_price: number
    loan?: { qty: number; rate_pct: number }
  }>
}
