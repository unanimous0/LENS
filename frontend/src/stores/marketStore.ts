import { create } from 'zustand'
import type { ETFTick, StockTick, FuturesTick, OrderbookTick, NetworkMode } from '../types/market'

export type FeedState = 'fresh' | 'quiet' | 'stale' | 'closed' | 'mock' | 'internal' | 'unknown'

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
      const merged = tick.cum_volume === 0
        ? { ...tick, cum_volume: prev?.cum_volume ?? 0 }
        : tick
      return { stockTicks: { ...state.stockTicks, [tick.code]: merged } }
    }),
  batchUpdateStocks: (ticks) =>
    set((state) => {
      const next = { ...state.stockTicks }
      let changed = false
      for (const [code, tick] of Object.entries(ticks)) {
        const prev = next[code]
        if (shouldSkip(tick, prev)) continue
        changed = true
        next[code] = tick.cum_volume === 0
          ? { ...tick, cum_volume: prev?.cum_volume ?? 0 }
          : tick
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
  connected: false,
  setConnected: (v) => set({ connected: v }),
  feedState: 'unknown',
  feedAgeSec: 0,
  setFeedHealth: (feedState, feedAgeSec) => set({ feedState, feedAgeSec }),
}))
