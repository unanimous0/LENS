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
 * §13.13 화면 재구성 — 세로 길이 축소를 위해 운영 사이클을 **5개 탭**으로 분리
 * (구 2탭 pre/post → 호가·기회 / 원장 / 헤지 / 손익·리스크 / 정리):
 *   1. 호가·기회 : 호가 제안 보드(mid 기준가·매수차/매도차) + 지수 베이시스 z + 조작(비용·호가 파라미터)
 *   2. 원장     : 북 원장(자산유형 4그룹 접기/펼치기 + 대형 테이블 내부 스크롤) + 체결 입력·로그
 *   3. 헤지     : 헤지 정합 보드 → 헤지 티켓 + 베이시스 라우터
 *   4. 손익·리스크: 베이시스 북 4층 분해 + P&L 5분해 + FV 매트릭스 + 잔차/미매핑
 *   5. 정리     : 넷팅 바스켓 빌더 + 출구 3개 비교
 *
 * 상단 **4대 숫자(§13.3) + 탭 바**는 sticky top-0 로 고정 — 어느 탭에서 얼마나 스크롤해도
 * 4대 숫자와 탭 네비가 항상 보인다. 탭 상태는 URL query `?tab=quote|ledger|hedge|pnl|exit`에
 * 반영해 새로고침에도 유지. 구 `?view=pre|post` 진입 URL은 quote/hedge 로 매핑.
 *
 * 탭 전환은 **비활성 탭 언마운트**(조건부 렌더) — 400행 원장 등 무거운 DOM을 화면 밖에서
 * 유지하지 않아 스크롤·렌더 부담을 줄인다. 로컬 draft/확장 상태는 재마운트 시 초기화되지만,
 * 실시간 구독은 **끊기지 않는다**: WS(fair_value_matrix·book_risk·quote_board·basis_book·
 * pnl_decomp)는 App 레벨 useWebSocket 단일 연결, 호가(mid) 구독은 아래 usePageOrderbookBulk 를
 * **페이지 레벨**(탭 컨테이너 밖)에서 호출하므로 탭 언마운트와 무관하게 유지된다.
 */

const TABS = [
  { id: 'quote', label: '호가·기회' },
  { id: 'ledger', label: '원장' },
  { id: 'hedge', label: '헤지' },
  { id: 'pnl', label: '손익·리스크' },
  { id: 'exit', label: '정리' },
] as const

type TabId = (typeof TABS)[number]['id']

const TAB_IDS = TABS.map((t) => t.id) as readonly string[]

/** URL `?tab=` 우선, 없으면 구 `?view=pre|post` 매핑, 그 외 기본 quote. */
function resolveTab(rawTab: string | null, legacyView: string | null): TabId {
  if (rawTab && TAB_IDS.includes(rawTab)) return rawTab as TabId
  if (legacyView === 'post') return 'hedge'
  return 'quote'
}

export function LpMatrixPage() {
  useLpInit()

  // 유니버스 12종 호가(mid) 구독 — 페이지 레벨 고정(탭 언마운트 무관). quoteUniverse fetch 후 발사.
  const quoteUniverse = useLpStore((s) => s.quoteUniverse)
  const universeCodes = useMemo(() => Object.keys(quoteUniverse), [quoteUniverse])
  usePageOrderbookBulk(universeCodes)

  const [params, setParams] = useSearchParams()
  const tab = resolveTab(params.get('tab'), params.get('view'))
  const setTab = (t: TabId) => {
    const next = new URLSearchParams(params)
    next.set('tab', t)
    next.delete('view') // 구 파라미터 정리
    setParams(next, { replace: true })
  }

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 상단 고정 — 4대 숫자(§13.3) + 탭 바. sticky top-0 로 스크롤해도 항상 노출.
          z-30: 하위 대형 테이블의 내부 sticky thead(z-10)보다 위. */}
      <div className="sticky top-0 z-30 flex flex-col gap-1 bg-bg-base pt-1 -mt-1">
        <BookFourNumbers />
        <div className="flex items-center gap-1 bg-bg-primary px-2 overflow-x-auto">
          {TABS.map((t) => (
            <SubTab key={t.id} label={t.label} active={tab === t.id} onClick={() => setTab(t.id)} />
          ))}
        </div>
      </div>

      {/* ── 1. 호가·기회 ── */}
      {tab === 'quote' && (
        <div className="flex flex-col gap-1">
          <QuoteBoard />
          <IndexBasisStrip />
          {/* 조작 영역 통합 (CLAUDE.md "조작 요소는 하나의 패널로 통합") — 비용 + 호가 파라미터 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
            <CostInputsPanel />
            <QuoteParamsPanel />
          </div>
        </div>
      )}

      {/* ── 2. 원장 (§13.5) — 대형 테이블 격리 (그룹 접기/펼치기 + 내부 스크롤) ── */}
      {tab === 'ledger' && <LedgerBoard />}

      {/* ── 3. 헤지 ── */}
      {tab === 'hedge' && (
        <div className="flex flex-col gap-1">
          {/* 헤지 정합 보드(§13.12) — 하루 시작 질문(PDF 대비 정합) */}
          <HedgeReconPanel />
          {/* 헤지 티켓(§13.3-B) + 베이시스 라우터(§13.4) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
            <HedgeTicketPanel />
            <BasisRouterPanel />
          </div>
        </div>
      )}

      {/* ── 4. 손익·리스크 ── */}
      {tab === 'pnl' && (
        <div className="flex flex-col gap-1">
          {/* 베이시스 북 4층 분해(§13.4) */}
          <BasisBookPanel />
          {/* P&L 5분해 + 한도(§13.3-C) */}
          <PnlPanel />
          {/* Fair Value 매트릭스 + 잔차/미매핑 (경로별 분석) */}
          <FairValueMatrix />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-1">
            <ResidualPanel />
            <UnmappedPanel />
          </div>
        </div>
      )}

      {/* ── 5. 정리 — 넷팅 바스켓 빌더(넓게) + 출구 3개 비교(§13.3-D) ── */}
      {tab === 'exit' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-1">
          <div className="lg:col-span-2">
            <BasketBuilderPanel />
          </div>
          <ExitComparisonPanel />
        </div>
      )}
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
        'px-3 py-2 text-[13px] font-medium transition-colors border-b-2 whitespace-nowrap',
        active
          ? 'text-t1 border-accent'
          : 'text-t3 hover:text-t2 border-transparent',
      )}
    >
      {label}
    </button>
  )
}
