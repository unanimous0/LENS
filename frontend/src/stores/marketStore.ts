// HOT FIELDS WARNING
// `etfTicks` / `stockTicks` / `futuresTicks` / `orderbookTicks`는 batch당 갱신되는 hot path.
// 페이지에서 `useMarketStore((s) => s.stockTicks)` 식으로 직접 구독 금지 — 전체 페이지 매 batch
// 재렌더 발생. 200ms `setInterval` snapshot 패턴 사용 (참고: pages/etf-arbitrage.tsx).
// 자세한 룰은 CLAUDE.md "실시간 페이지 작성/수정 규칙" 참조.
import { create } from 'zustand'
import type { ETFTick, StockTick, FuturesTick, OrderbookTick, NetworkMode } from '../types/market'

export type FeedState = 'fresh' | 'quiet' | 'stale' | 'pre_open' | 'post_close' | 'closed' | 'mock' | 'internal' | 'unknown'

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
  /** ETF 메트릭 시계열 history. ETF 코드 → 최근 N개 포인트. 단일 signed 차익bp (PDF 매도차-매수차).
   *  양수=매도차 우세, 음수=매수차 우세. 페이지 mount 동안 5초 간격으로 push. unmount해도 유지. */
  etfHistory: Record<string, { t: number; diffBp: number }[]>
  pushEtfHistoryBatch: (entries: Record<string, { diffBp: number }>, max: number) => void
  connected: boolean
  setConnected: (v: boolean) => void
  feedState: FeedState
  feedAgeSec: number
  setFeedHealth: (state: FeedState, ageSec: number) => void
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
  return { ...tick, cum_volume: cumVolume, high, low, prev_close }
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
        arr.push({ t, diffBp: m.diffBp })
        if (arr.length > max) arr.splice(0, arr.length - max)
        next[code] = arr
      }
      return { etfHistory: next }
    }),
  connected: false,
  setConnected: (v) => set({ connected: v }),
  feedState: 'unknown',
  feedAgeSec: 0,
  setFeedHealth: (feedState, feedAgeSec) => set({ feedState, feedAgeSec }),
}))
