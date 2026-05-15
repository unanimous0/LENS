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

export type PositionEntryStats = {
  alpha?: number
  beta?: number
  half_life?: number
  adf?: number
  r2?: number
  // 향후 추가 필드
  [key: string]: number | undefined
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
