import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { TopNav } from './components/layout/top-nav'
import { useWebSocket } from './hooks/useWebSocket'
import { useFeedHealth } from './hooks/useFeedHealth'
import { useMarketStore } from './stores/marketStore'
import { DashboardPage } from './pages/dashboard'
import { MarketPage } from './pages/market'
import { LendingPage } from './pages/lending'
import { StockArbitragePage } from './pages/stock-arbitrage'
import { EtfArbitragePage } from './pages/etf-arbitrage'
import { StatArbPage } from './pages/stat-arb'
import { StatArbDetailPage } from './pages/stat-arb-detail'
import { StatArbLayout } from './pages/stat-arb-layout'
import { LoanRatesPage } from './pages/loan-rates'
import type { NetworkMode } from './types/market'

// dividends는 recharts/react-virtual 의존성이 무거워 lazy-load.
// 내부망 등 일부 환경에서 패키지 없을 때 다른 페이지가 함께 transform 실패하지 않도록 격리.
const DividendsPage = lazy(() => import('./pages/dividends').then((m) => ({ default: m.DividendsPage })))

function AppLayout() {
  useWebSocket()
  useFeedHealth()

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
      <main className="flex-1 overflow-y-scroll [scrollbar-gutter:stable]">
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
            <Route path="/etf-arbitrage" element={<EtfArbitragePage />} />
            {/* 통계차익: nested sub-tab (페어 발굴 / 대여요율). 페어 상세는 layout 밖. */}
            <Route path="/stat-arb" element={<StatArbLayout />}>
              <Route index element={<StatArbPage />} />
              <Route path="loan-rates" element={<LoanRatesPage />} />
            </Route>
            <Route path="/stat-arb/pair/:left/:right" element={<StatArbDetailPage />} />
            <Route path="/dividends" element={<Suspense fallback={<div className="p-4 text-sm text-t3">로드 중…</div>}><DividendsPage /></Suspense>} />
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
