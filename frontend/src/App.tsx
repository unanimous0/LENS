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
import { StockFlowPage } from './pages/stock-flow'
import { BacktestPage } from './pages/backtest'
import { EtfLayout } from './pages/etf-layout'
import { EtfDashboardPage } from './pages/etf-dashboard'
import { EtfArbitragePage } from './pages/etf-arbitrage'
import { StatArbPage } from './pages/stat-arb'
import { StatArbMnPage } from './pages/stat-arb-mn'
import { StatArbSScorePage } from './pages/stat-arb-sscore'
import { StatArbDetailPage } from './pages/stat-arb-detail'
import { StatArbMnDetailPage } from './pages/stat-arb-mn-detail'
import { StatArbLayout } from './pages/stat-arb-layout'
import { LoanRatesPage } from './pages/loan-rates'
import { StatArbPositionsPage } from './pages/stat-arb-positions'
import { StatArbPositionDetailPage } from './pages/stat-arb-position-detail'
import { LpMatrixPage } from './pages/lp-matrix'
import { LpDeskPage } from './pages/lp-desk'
import type { NetworkMode } from './types/market'

// dividends는 recharts/react-virtual 의존성이 무거워 lazy-load.
// 내부망 등 일부 환경에서 패키지 없을 때 다른 페이지가 함께 transform 실패하지 않도록 격리.
const DividendsPage = lazy(() => import('./pages/dividends').then((m) => ({ default: m.DividendsPage })))
// 선물 탭도 lazy — lightweight-charts 번들이 무겁고 진입 빈도가 낮다.
const FuturesPage = lazy(() => import('./pages/futures').then((m) => ({ default: m.FuturesPage })))

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
            <Route path="/backtest" element={<BacktestPage />} />
            <Route path="/signals" element={<StubPage label="시그널" />} />
            <Route path="/position" element={<StubPage label="포지션" />} />
            <Route path="/supply-demand" element={<StockFlowPage />} />
            <Route path="/stock-arbitrage" element={<StockArbitragePage />} />
            {/* ETF: nested sub-tab (대시보드 / 차익거래) */}
            <Route path="/etf" element={<EtfLayout />}>
              <Route index element={<EtfDashboardPage />} />
              <Route path="arbitrage" element={<EtfArbitragePage />} />
            </Route>
            {/* 구 경로 호환 — /etf-arbitrage → /etf/arbitrage */}
            <Route path="/etf-arbitrage" element={<Navigate to="/etf/arbitrage" replace />} />
            {/* 통계차익: nested sub-tab (페어 발굴 / 대여요율). 페어 상세는 layout 밖. */}
            <Route path="/stat-arb" element={<StatArbLayout />}>
              <Route index element={<StatArbPage />} />
              <Route path="mn" element={<StatArbMnPage />} />
              <Route path="s-score" element={<StatArbSScorePage />} />
              <Route path="positions" element={<StatArbPositionsPage />} />
              <Route path="loan-rates" element={<LoanRatesPage />} />
            </Route>
            <Route path="/stat-arb/pair/:left/:right" element={<StatArbDetailPage />} />
            {/* M:N 페어 상세 — :group은 'etf:278540'처럼 콜론 포함(링크는 encodeURIComponent). */}
            <Route path="/stat-arb/mn/:group/:component" element={<StatArbMnDetailPage />} />
            <Route path="/stat-arb/positions/:id" element={<StatArbPositionDetailPage />} />
            <Route path="/lp-matrix" element={<LpMatrixPage />} />
            {/* LP 데스크(§14) — lp-matrix와 완전 독립 화면. 서로 링크하지 않는다. */}
            <Route path="/lp-desk" element={<LpDeskPage />} />
            <Route path="/dividends" element={<Suspense fallback={<div className="p-4 text-sm text-t3">로드 중…</div>}><DividendsPage /></Suspense>} />
            <Route path="/futures" element={<Suspense fallback={<div className="p-4 text-sm text-t3">로드 중…</div>}><FuturesPage /></Suspense>} />
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
