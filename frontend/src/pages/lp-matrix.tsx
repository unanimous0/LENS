import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLpInit } from '@/hooks/useLpInit'
import { usePageOrderbookBulk } from '@/hooks/usePageOrderbookBulk'
import { useLpStore } from '@/stores/lpStore'
import { cn } from '@/lib/utils'
import { BookFourNumbers } from '@/components/lp/BookFourNumbers'
import { BasisBookPanel } from '@/components/lp/BasisBookPanel'
import { PnlPanel } from '@/components/lp/PnlPanel'
import { BasketBuilderPanel } from '@/components/lp/BasketBuilderPanel'
import { ExitComparisonPanel } from '@/components/lp/ExitComparisonPanel'
import { QuoteBoard } from '@/components/lp/QuoteBoard'
import { IndexBasisStrip } from '@/components/lp/IndexBasisStrip'
import { HedgeTicketPanel } from '@/components/lp/HedgeTicketPanel'
import { BasisRouterPanel } from '@/components/lp/BasisRouterPanel'
import { FairValueMatrix } from '@/components/lp/FairValueMatrix'
import { HedgeReconPanel } from '@/components/lp/HedgeReconPanel'
import { LedgerBoard } from '@/components/lp/LedgerBoard'
import { CostInputsPanel } from '@/components/lp/CostInputsPanel'
import { QuoteParamsPanel } from '@/components/lp/QuoteParamsPanel'
import { ResidualPanel } from '@/components/lp/ResidualPanel'
import { UnmappedPanel } from '@/components/lp/UnmappedPanel'

/**
 * /lp-matrix — LP 시그널 데스크 (v2 운영 사이클, §13).
 *
 * §13.13 화면 전/후 재구성 — 매매 사이클을 2개 서브탭으로 분리:
 *   [체결 전 — 호가·기회]: 호가 제안 보드(mid 기준가·매수차/매도차) + 지수 베이시스 z 요약 + 조작
 *   [체결 후 — 북 관리]:   헤지 정합 → 티켓·라우터 → 원장 → 베이시스 북 → P&L → 출구 → 매트릭스
 *
 * 상단 4대 숫자(§13.3)는 두 탭 공통 고정. 서브탭 상태는 URL query `?view=pre|post`에 반영해
 * 새로고침에도 유지. 두 뷰는 **display 토글**(둘 다 마운트·CSS hidden)로 전환 — 탭 전환 시
 * 재마운트로 인한 컴포넌트 상태 초기화·WS 재구독을 피한다 (lpStore/WS는 전역 단일 소스라
 * 숨겨진 뷰도 저비용 memo 렌더만).
 *
 * WS(fair_value_matrix·book_risk·quote_board·basis_book·pnl_decomp)는 App 레벨 useWebSocket
 * 단일 연결로 상시 수신 — 탭 무관. 호가(mid) 구독만 이 페이지가 관리(§13.13 Part 2):
 * 유니버스 12종 orderbook을 **페이지 레벨**에서 구독(키B WS·mock 합성)해 탭 전환에 영향받지
 * 않게 한다(장중 실측·장외 mock, 키B 윈도우 밖/내부망은 last 폴백).
 */
export function LpMatrixPage() {
  useLpInit()

  // 유니버스 12종 호가(mid) 구독 — 페이지 레벨 고정(탭 전환 무관). quoteUniverse fetch 후 발사.
  const quoteUniverse = useLpStore((s) => s.quoteUniverse)
  const universeCodes = useMemo(() => Object.keys(quoteUniverse), [quoteUniverse])
  usePageOrderbookBulk(universeCodes)

  const [params, setParams] = useSearchParams()
  const view: 'pre' | 'post' = params.get('view') === 'post' ? 'post' : 'pre'
  const setView = (v: 'pre' | 'post') => {
    const next = new URLSearchParams(params)
    next.set('view', v)
    setParams(next, { replace: true })
  }

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 4대 숫자 — 두 탭 공통 고정 (§13.3) */}
      <BookFourNumbers />

      {/* 서브탭 네비 — 상단 탭과 일관된 가로 탭 + 활성 액센트 밑줄 */}
      <div className="flex items-center gap-1 bg-bg-primary px-2">
        <SubTab label="체결 전 · 호가·기회" active={view === 'pre'} onClick={() => setView('pre')} />
        <SubTab label="체결 후 · 북 관리" active={view === 'post'} onClick={() => setView('post')} />
      </div>

      {/* ── 체결 전 — 호가·기회 ── */}
      <div className={cn('flex-col gap-1', view === 'pre' ? 'flex' : 'hidden')}>
        <QuoteBoard />
        <IndexBasisStrip />
        {/* 조작 영역 통합 (CLAUDE.md "조작 요소는 하나의 패널로 통합") — 비용 + 호가 파라미터 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
          <CostInputsPanel />
          <QuoteParamsPanel />
        </div>
      </div>

      {/* ── 체결 후 — 북 관리 ── */}
      <div className={cn('flex-col gap-1', view === 'post' ? 'flex' : 'hidden')}>
        {/* 헤지 정합 보드(§13.12) — 하루 시작 질문(PDF 대비 정합) */}
        <HedgeReconPanel />
        {/* ③ 헤지 티켓(§13.3-B) + 베이시스 라우터(§13.4) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
          <HedgeTicketPanel />
          <BasisRouterPanel />
        </div>
        {/* 원장(§13.5) */}
        <LedgerBoard />
        {/* 베이시스 북 4층 분해(§13.4) */}
        <BasisBookPanel />
        {/* P&L 5분해 + 한도(§13.3-C) */}
        <PnlPanel />
        {/* ⑤ 정리 — 넷팅 바스켓 빌더(넓게) + 출구 3개 비교(§13.3-D) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-1">
          <div className="lg:col-span-2">
            <BasketBuilderPanel />
          </div>
          <ExitComparisonPanel />
        </div>
        {/* Fair Value 매트릭스 + 잔차/미매핑 (경로별 분석) */}
        <FairValueMatrix />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
          <ResidualPanel />
          <UnmappedPanel />
        </div>
      </div>
    </div>
  )
}

function SubTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-2 text-[13px] font-medium transition-colors border-b-2',
        active
          ? 'text-t1 border-accent'
          : 'text-t3 hover:text-t2 border-transparent',
      )}
    >
      {label}
    </button>
  )
}
