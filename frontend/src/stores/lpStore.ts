import { create } from 'zustand'
import type {
  BookRiskSnapshot,
  FairValueMatrixSnapshot,
  LpCostInputs,
} from '../types/lp'

const DEFAULT_COST: LpCostInputs = {
  tax_sell_bp: 20,
  base_rate_annual: 0.028,
  slippage_bp: 0,
  hold_days: 1,
}

export interface CorporateActionToday {
  stock_code: string
  event_type: string
  price_factor: number
  description: string | null
}

interface LpState {
  matrix: FairValueMatrixSnapshot | null
  bookRisk: BookRiskSnapshot | null
  positions: Record<string, number>
  positionsUpdatedAt: string | null
  costInputs: LpCostInputs
  /** 오늘 corporate action 발생 종목. 분할 당일 PDF qty 갱신 latency로 NAV 일시 왜곡 가능 — 사용자 인지용. */
  corporateActionsToday: CorporateActionToday[]
  setMatrix: (m: FairValueMatrixSnapshot) => void
  setBookRisk: (b: BookRiskSnapshot) => void
  setPositions: (p: Record<string, number>, updatedAt?: string | null) => void
  setCostInputs: (c: LpCostInputs) => void
  setCorporateActionsToday: (items: CorporateActionToday[]) => void
}

export const useLpStore = create<LpState>((set) => ({
  matrix: null,
  bookRisk: null,
  positions: {},
  positionsUpdatedAt: null,
  costInputs: DEFAULT_COST,
  corporateActionsToday: [],
  setMatrix: (m) => set({ matrix: m }),
  setBookRisk: (b) => set({ bookRisk: b }),
  setPositions: (p, updatedAt) =>
    set({ positions: p, positionsUpdatedAt: updatedAt ?? null }),
  setCostInputs: (c) => set({ costInputs: c }),
  setCorporateActionsToday: (items) => set({ corporateActionsToday: items }),
}))
