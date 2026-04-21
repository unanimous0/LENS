import { create } from 'zustand'
import type { ETFTick, StockTick, FuturesTick, NetworkMode } from '../types/market'

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
  connected: boolean
  setConnected: (v: boolean) => void
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
      const merged = tick.cum_volume === 0
        ? { ...tick, cum_volume: prev?.cum_volume ?? 0 }
        : tick
      return { stockTicks: { ...state.stockTicks, [tick.code]: merged } }
    }),
  batchUpdateStocks: (ticks) =>
    set((state) => {
      const next = { ...state.stockTicks }
      for (const [code, tick] of Object.entries(ticks)) {
        const prev = next[code]
        next[code] = tick.cum_volume === 0
          ? { ...tick, cum_volume: prev?.cum_volume ?? 0 }
          : tick
      }
      return { stockTicks: next }
    }),
  futuresTicks: {},
  updateFuturesTick: (tick) =>
    set((state) => ({ futuresTicks: { ...state.futuresTicks, [tick.code]: tick } })),
  batchUpdateFutures: (ticks) =>
    set((state) => ({ futuresTicks: { ...state.futuresTicks, ...ticks } })),
  connected: false,
  setConnected: (v) => set({ connected: v }),
}))
