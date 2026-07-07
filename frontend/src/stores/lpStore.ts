import { create } from 'zustand'
import type {
  BookRiskSnapshot,
  FairValueMatrixSnapshot,
  LedgerAggregate,
  LedgerEntry,
  LedgerSnapshot,
  LpCostInputs,
  QuoteBoardSnapshot,
  QuoteParams,
  QuoteUniverseMeta,
} from '../types/lp'
import { DEFAULT_QUOTE_PARAMS } from '../types/lp'

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
  /** 북 원장(§13.5): 전체 엔트리 + 코드별 집계. */
  ledgerEntries: LedgerEntry[]
  ledgerAggregates: LedgerAggregate[]
  ledgerUpdatedAt: string | null
  /** 호가 보드(§13.3-A) — Rust 200ms throttle quote_board WS. */
  quoteBoard: QuoteBoardSnapshot | null
  /** 호가 제안 파라미터 (base_spread/γ/buffer/hedge_cost/재고한도). GET/POST /api/lp/quote-params. */
  quoteParams: QuoteParams
  /** matrix-config quote_universe: code → 배수/β/family 메타 (모드 뱃지·override 편집용). */
  quoteUniverse: Record<string, QuoteUniverseMeta>
  setMatrix: (m: FairValueMatrixSnapshot) => void
  setBookRisk: (b: BookRiskSnapshot) => void
  setPositions: (p: Record<string, number>, updatedAt?: string | null) => void
  setCostInputs: (c: LpCostInputs) => void
  setCorporateActionsToday: (items: CorporateActionToday[]) => void
  setLedger: (snap: LedgerSnapshot) => void
  setQuoteBoard: (b: QuoteBoardSnapshot) => void
  setQuoteParams: (p: QuoteParams) => void
  setQuoteUniverse: (u: Record<string, QuoteUniverseMeta>) => void
}

export const useLpStore = create<LpState>((set) => ({
  matrix: null,
  bookRisk: null,
  positions: {},
  positionsUpdatedAt: null,
  costInputs: DEFAULT_COST,
  corporateActionsToday: [],
  ledgerEntries: [],
  ledgerAggregates: [],
  ledgerUpdatedAt: null,
  quoteBoard: null,
  quoteParams: DEFAULT_QUOTE_PARAMS,
  quoteUniverse: {},
  setMatrix: (m) => set({ matrix: m }),
  setBookRisk: (b) => set({ bookRisk: b }),
  setPositions: (p, updatedAt) =>
    set({ positions: p, positionsUpdatedAt: updatedAt ?? null }),
  setCostInputs: (c) => set({ costInputs: c }),
  setCorporateActionsToday: (items) => set({ corporateActionsToday: items }),
  setLedger: (snap) =>
    set({
      ledgerEntries: snap.entries,
      ledgerAggregates: snap.aggregates,
      ledgerUpdatedAt: snap.updated_at ?? null,
    }),
  setQuoteBoard: (b) => set({ quoteBoard: b }),
  setQuoteParams: (p) => set({ quoteParams: p }),
  setQuoteUniverse: (u) => set({ quoteUniverse: u }),
}))
