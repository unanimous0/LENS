import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { TopNav } from './components/layout/top-nav'
import { useWebSocket } from './hooks/useWebSocket'
import { useMarketStore } from './stores/marketStore'
import { DashboardPage } from './pages/dashboard'
import { MarketPage } from './pages/market'
import { LendingPage } from './pages/lending'
import { StockArbitragePage } from './pages/stock-arbitrage'
import type { NetworkMode } from './types/market'

function AppLayout() {
  useWebSocket()

  // Rust 서비스에서 현재 피드 모드 조회
  useEffect(() => {
    fetch('/realtime/mode')
      .then((r) => r.text())
      .then((mode) => {
        const mapped: Record<string, NetworkMode> = {
          'ls_api': 'external',
          'internal': 'internal',
          'mock': 'mock',
        }
        useMarketStore.getState().setNetworkMode(mapped[mode] ?? 'mock')
      })
      .catch(() => {})
  }, [])
  return (
    <div className="flex h-screen flex-col bg-bg-base">
      <TopNav />
      <main className="flex-1 overflow-y-auto">
        <div className="animate-in">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/lending" element={<LendingPage />} />
            <Route path="/backtest" element={<StubPage label="백테스팅" />} />
            <Route path="/signals" element={<StubPage label="시그널" />} />
            <Route path="/position" element={<StubPage label="포지션" />} />
            <Route path="/supply-demand" element={<StubPage label="수급" />} />
            <Route path="/stock-arbitrage" element={<StockArbitragePage />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

function StubPage({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-t3">{label} -- 준비 중</p>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  )
}
