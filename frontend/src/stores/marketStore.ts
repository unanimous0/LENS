import { create } from 'zustand'
import type { ETFTick, StockTick, FuturesTick, OrderbookTick, NetworkMode } from '../types/market'

export type FeedState = 'fresh' | 'quiet' | 'stale' | 'pre_open' | 'post_close' | 'closed' | 'mock' | 'internal' | 'unknown'

/** ETF 시계열 한 포인트 — 시간 + 차익bp + 가격/NAV/괴리bp 종합 */
export type EtfHistoryPoint = {
  t: number
  diffBp: number
  price: number       // ETF 현재가 (없으면 0)
  nav: number         // 라이브 iNAV (없으면 0)
  priceNavBp: number  // (price - nav) / nav · 10000
}
/** 한 push 사이클의 ETF별 metric snapshot */
export type EtfHistoryEntry = {
  diffBp: number
  price: number
  nav: number
  priceNavBp: number
}

/** 한 체결 entry — 호가창 패널에 최근 N개 stack. */
export type TradeEntry = {
  t: number          // 수신 시각 (ms)
  price: number
  volume: number     // 그 체결의 수량 (cvolume)
  side: 1 | -1       // +1 매수 / -1 매도
}

interface MarketState {
  networkMode: NetworkMode
  setNetworkMode: (mode: NetworkMode) => void
  etfTicks: Record<string, ETFTick>
  updateETFTick: (tick: ETFTick) => void
  batchUpdateETFs: (ticks: Record<string, ETFTick>) => void
  stockTicks: Record<string, StockTick>
  updateStockTick: (tick: StockTick) => void
  batchUpdateStocks: (ticks: Record<string, StockTick>) => void
  futuresTicks: Record<string, FuturesTick>
  updateFuturesTick: (tick: FuturesTick) => void
  batchUpdateFutures: (ticks: Record<string, FuturesTick>) => void
  orderbookTicks: Record<string, OrderbookTick>
  updateOrderbookTick: (tick: OrderbookTick) => void
  batchUpdateOrderbooks: (ticks: Record<string, OrderbookTick>) => void
  clearOrderbook: (code: string) => void
  clearOrderbooks: () => void
  /** ETF 메트릭 시계열 history. ETF 코드 → 최근 N개 포인트.
   *  - diffBp: PDF 매도차-매수차 (signed). 양수=매도차 우세, 음수=매수차 우세
   *  - price/nav/priceNavBp: ETF 가격 / 라이브 iNAV / 괴리bp — 가격·NAV 차트용
   *  페이지 mount 동안 5초 간격으로 push. unmount해도 유지. */
  etfHistory: Record<string, EtfHistoryPoint[]>
  pushEtfHistoryBatch: (entries: Record<string, EtfHistoryEntry>, max: number) => void
  /** ETF별 최근 체결 (호가창 하단의 실시간 체결내역).
   *  ETFTick 들어올 때 trade_side가 있으면 push (Mock도 +1/-1 채워줌).
   *  ETF당 최근 TRADES_MAX개만 보존 (메모리 600 ETF × 10 × ~40B = 240KB). */
  etfTrades: Record<string, TradeEntry[]>
  pushEtfTrade: (code: string, entry: TradeEntry) => void
  connected: boolean
  setConnected: (v: boolean) => void
  feedState: FeedState
  feedAgeSec: number
  setFeedHealth: (state: FeedState, ageSec: number) => void
  /** realtime이 발급한 client_id. WS 연결 시 hello 메시지로 받아 저장.
   *  /realtime/subscribe-stocks 호출 시 X-LENS-Client-Id 헤더로 첨부 →
   *  WS disconnect 시 서버가 ref-count 자동 cleanup (탭 강제 종료 leak 방지). */
  clientId: number | null
  setClientId: (id: number) => void
}

/** is_initial 틱은 이미 실시간 데이터가 있으면 무시 */
function shouldSkip(tick: any, prev: any): boolean {
  return tick.is_initial && prev != null
}

/**
 * 주식 틱 병합:
 *  - cum_volume: 0이면 prev 값 유지 (초기 fetch 호환)
 *  - high/low: 백엔드가 보낸 값 우선, 없으면 prev와 현재가로 running max/min 계산
 *  - prev_close: 한번이라도 들어오면 sticky 유지 (실시간 틱엔 보통 누락)
 */
function mergeStockTick(tick: StockTick, prev: StockTick | undefined): StockTick {
  const cumVolume = tick.cum_volume === 0 ? (prev?.cum_volume ?? 0) : tick.cum_volume
  // high/low — 배열 alloc + spread 비용 회피. 명시적 비교로 같은 결과.
  const tHigh = tick.high, pHigh = prev?.high
  const tLow = tick.low, pLow = prev?.low
  const price = tick.price
  let high: number | undefined
  if (tHigh != null && tHigh > 0) high = tHigh
  if (pHigh != null && pHigh > 0 && (high === undefined || pHigh > high)) high = pHigh
  if (price > 0 && (high === undefined || price > high)) high = price
  let low: number | undefined
  if (tLow != null && tLow > 0) low = tLow
  if (pLow != null && pLow > 0 && (low === undefined || pLow < low)) low = pLow
  if (price > 0 && (low === undefined || price < low)) low = price
  const prev_close = tick.prev_close ?? prev?.prev_close
  // 상/하한가는 t1102 초기 fetch에서만 박힘. 실시간 stream tick이 덮어쓰지 않게 prev 값 sticky.
  const upper_limit = tick.upper_limit ?? prev?.upper_limit
  const lower_limit = tick.lower_limit ?? prev?.lower_limit
  // 이상급등/저유동성도 t1102 응답에서만 추출되고 S3_/K3_엔 없음 — sticky.
  // false도 의미 있는 값(해제)이지만 S3_/K3_는 항상 false라 정보 손실 위험 → prev OR로 보존.
  const abnormal_rise = tick.abnormal_rise || prev?.abnormal_rise
  const low_liquidity = tick.low_liquidity || prev?.low_liquidity
  return { ...tick, cum_volume: cumVolume, high, low, prev_close, upper_limit, lower_limit, abnormal_rise, low_liquidity }
}

export const useMarketStore = create<MarketState>((set) => ({
  networkMode: 'mock',
  setNetworkMode: (mode) => set({ networkMode: mode }),
  etfTicks: {},
  updateETFTick: (tick) =>
    set((state) => ({ etfTicks: { ...state.etfTicks, [tick.code]: tick } })),
  batchUpdateETFs: (ticks) =>
    set((state) => ({ etfTicks: { ...state.etfTicks, ...ticks } })),
  stockTicks: {},
  updateStockTick: (tick) =>
    set((state) => {
      const prev = state.stockTicks[tick.code]
      if (shouldSkip(tick, prev)) return state // 초기값이고 이미 실시간 있음 → 무시
      return { stockTicks: { ...state.stockTicks, [tick.code]: mergeStockTick(tick, prev) } }
    }),
  batchUpdateStocks: (ticks) =>
    set((state) => {
      const next = { ...state.stockTicks }
      let changed = false
      for (const [code, tick] of Object.entries(ticks)) {
        const prev = next[code]
        if (shouldSkip(tick, prev)) continue
        changed = true
        next[code] = mergeStockTick(tick, prev)
      }
      return changed ? { stockTicks: next } : state
    }),
  futuresTicks: {},
  updateFuturesTick: (tick) =>
    set((state) => {
      if (shouldSkip(tick, state.futuresTicks[tick.code])) return state
      return { futuresTicks: { ...state.futuresTicks, [tick.code]: tick } }
    }),
  batchUpdateFutures: (ticks) =>
    set((state) => {
      const next = { ...state.futuresTicks }
      let changed = false
      for (const [code, tick] of Object.entries(ticks)) {
        if (shouldSkip(tick, next[code])) continue
        changed = true
        next[code] = tick
      }
      return changed ? { futuresTicks: next } : state
    }),
  orderbookTicks: {},
  updateOrderbookTick: (tick) =>
    set((state) => ({ orderbookTicks: { ...state.orderbookTicks, [tick.code]: tick } })),
  batchUpdateOrderbooks: (ticks) =>
    set((state) => {
      const next = { ...state.orderbookTicks, ...ticks }
      return { orderbookTicks: next }
    }),
  clearOrderbook: (code) =>
    set((state) => {
      if (!state.orderbookTicks[code]) return state
      const next = { ...state.orderbookTicks }
      delete next[code]
      return { orderbookTicks: next }
    }),
  clearOrderbooks: () => set({ orderbookTicks: {} }),
  etfHistory: {},
  pushEtfHistoryBatch: (entries, max) =>
    set((state) => {
      const t = Date.now()
      const next = { ...state.etfHistory }
      for (const [code, m] of Object.entries(entries)) {
        const arr = next[code] ? next[code].slice() : []
        arr.push({ t, diffBp: m.diffBp, price: m.price, nav: m.nav, priceNavBp: m.priceNavBp })
        if (arr.length > max) arr.splice(0, arr.length - max)
        next[code] = arr
      }
      return { etfHistory: next }
    }),
  etfTrades: {},
  pushEtfTrade: (code, entry) =>
    set((state) => {
      const TRADES_MAX = 10  // 호가창 하단 5개 보여주려면 여유 두고 10개
      const arr = state.etfTrades[code] ? state.etfTrades[code].slice() : []
      arr.push(entry)
      if (arr.length > TRADES_MAX) arr.splice(0, arr.length - TRADES_MAX)
      return { etfTrades: { ...state.etfTrades, [code]: arr } }
    }),
  connected: false,
  setConnected: (v) => set({ connected: v }),
  feedState: 'unknown',
  feedAgeSec: 0,
  setFeedHealth: (feedState, feedAgeSec) => set({ feedState, feedAgeSec }),
  clientId: null,
  setClientId: (id) => set({ clientId: id }),
}))
