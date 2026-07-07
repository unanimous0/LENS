import { create } from 'zustand'
import type {
  BasisBookSnapshot,
  BookRiskSnapshot,
  FairValueMatrixSnapshot,
  LedgerAggregate,
  LedgerEntry,
  LedgerSnapshot,
  LpCostInputs,
  NettingBasketResponse,
  PnlDecompSnapshot,
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

/** 베이시스 라우터 프리필 요청 (넷팅 바스켓 주식선물 배지 → BasisRouterPanel 입력+자동판정). */
export interface BasisRoutePrefill {
  code: string
  side: 'buy' | 'sell'
  qty: number
  /** 매 클릭마다 증가 — 같은 값 재클릭도 감지. */
  nonce: number
}

/** 원장 입력 폼 프리필 요청 (헤지 티켓·베이시스 라우터 → LedgerBoard EntryForm). */
export interface LedgerPrefill {
  code: string
  side: 'buy' | 'sell'
  qty: number
  price?: number | null
  note?: string | null
  /** 진입 베이시스 (§13.4) — 선물 대체 기장 시 실측 베이시스 씨앗값. */
  entry_basis?: number | null
  /** 체결 시점 FV (§13.3-C 스프레드 귀속). 라우터/호가 프리필이 첨부. */
  fv_at_fill?: number | null
  /** 체결 시점 현재가(mid) 스냅샷. */
  mid_at_fill?: number | null
  /** 매 클릭마다 증가 — 같은 값 재클릭도 EntryForm이 감지하도록. */
  nonce: number
}

interface LpState {
  matrix: FairValueMatrixSnapshot | null
  bookRisk: BookRiskSnapshot | null
  /** 베이시스 북(§13.4) — Rust 1초 주기 basis_book WS. */
  basisBook: BasisBookSnapshot | null
  /** P&L 5분해(§13.3-C) — Rust 1초 주기 pnl_decomp WS. */
  pnlDecomp: PnlDecompSnapshot | null
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
  /** 원장 입력 폼 프리필 (헤지 티켓·베이시스 라우터 기장 바로가기). */
  ledgerPrefill: LedgerPrefill | null
  /** 넷팅 바스켓(§13.3-D) — 버튼 트리거 스냅샷. 출구 3개 비교(ExitComparisonPanel)와 공유. */
  nettingBasket: NettingBasketResponse | null
  /** 베이시스 라우터 프리필 (넷팅 바스켓 주식선물 배지 → BasisRouterPanel). */
  basisRoutePrefill: BasisRoutePrefill | null
  setMatrix: (m: FairValueMatrixSnapshot) => void
  setBookRisk: (b: BookRiskSnapshot) => void
  setBasisBook: (b: BasisBookSnapshot) => void
  setPnlDecomp: (p: PnlDecompSnapshot) => void
  setPositions: (p: Record<string, number>, updatedAt?: string | null) => void
  setCostInputs: (c: LpCostInputs) => void
  setCorporateActionsToday: (items: CorporateActionToday[]) => void
  setLedger: (snap: LedgerSnapshot) => void
  setQuoteBoard: (b: QuoteBoardSnapshot) => void
  setQuoteParams: (p: QuoteParams) => void
  setQuoteUniverse: (u: Record<string, QuoteUniverseMeta>) => void
  /** 프리필 요청 — nonce 자동 증가. code/side/qty(+선택 price/note). */
  requestLedgerPrefill: (p: Omit<LedgerPrefill, 'nonce'>) => void
  setNettingBasket: (b: NettingBasketResponse | null) => void
  /** 베이시스 라우터 프리필 요청 — nonce 자동 증가. */
  requestBasisRoutePrefill: (p: Omit<BasisRoutePrefill, 'nonce'>) => void
}

export const useLpStore = create<LpState>((set) => ({
  matrix: null,
  bookRisk: null,
  basisBook: null,
  pnlDecomp: null,
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
  ledgerPrefill: null,
  nettingBasket: null,
  basisRoutePrefill: null,
  setMatrix: (m) => set({ matrix: m }),
  setBookRisk: (b) => set({ bookRisk: b }),
  setBasisBook: (b) => set({ basisBook: b }),
  setPnlDecomp: (p) => set({ pnlDecomp: p }),
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
  requestLedgerPrefill: (p) =>
    set((s) => ({
      ledgerPrefill: { ...p, nonce: (s.ledgerPrefill?.nonce ?? 0) + 1 },
    })),
  setNettingBasket: (b) => set({ nettingBasket: b }),
  requestBasisRoutePrefill: (p) =>
    set((s) => ({
      basisRoutePrefill: { ...p, nonce: (s.basisRoutePrefill?.nonce ?? 0) + 1 },
    })),
}))
