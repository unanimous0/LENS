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

interface LpState {
  matrix: FairValueMatrixSnapshot | null
  bookRisk: BookRiskSnapshot | null
  positions: Record<string, number>
  positionsUpdatedAt: string | null
  costInputs: LpCostInputs
  setMatrix: (m: FairValueMatrixSnapshot) => void
  setBookRisk: (b: BookRiskSnapshot) => void
  setPositions: (p: Record<string, number>, updatedAt?: string | null) => void
  setCostInputs: (c: LpCostInputs) => void
}

export const useLpStore = create<LpState>((set) => ({
  matrix: null,
  bookRisk: null,
  positions: {},
  positionsUpdatedAt: null,
  costInputs: DEFAULT_COST,
  setMatrix: (m) => set({ matrix: m }),
  setBookRisk: (b) => set({ bookRisk: b }),
  setPositions: (p, updatedAt) =>
    set({ positions: p, positionsUpdatedAt: updatedAt ?? null }),
  setCostInputs: (c) => set({ costInputs: c }),
}))
