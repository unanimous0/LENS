import { create } from 'zustand'
import type { ETFTick, FuturesTick, NetworkMode } from '../types/market'

interface MarketState {
  networkMode: NetworkMode
  setNetworkMode: (mode: NetworkMode) => void
  etfTicks: Record<string, ETFTick>
  updateETFTick: (tick: ETFTick) => void
  futuresTicks: Record<string, FuturesTick>
  updateFuturesTick: (tick: FuturesTick) => void
  connected: boolean
  setConnected: (v: boolean) => void
}

export const useMarketStore = create<MarketState>((set) => ({
  networkMode: 'mock',
  setNetworkMode: (mode) => set({ networkMode: mode }),
  etfTicks: {},
  updateETFTick: (tick) =>
    set((state) => ({
      etfTicks: { ...state.etfTicks, [tick.code]: tick },
    })),
  futuresTicks: {},
  updateFuturesTick: (tick) =>
    set((state) => ({
      futuresTicks: { ...state.futuresTicks, [tick.code]: tick },
    })),
  connected: false,
  setConnected: (v) => set({ connected: v }),
}))
