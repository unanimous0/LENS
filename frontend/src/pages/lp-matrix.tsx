import { useLpInit } from '@/hooks/useLpInit'
import { BookFourNumbers } from '@/components/lp/BookFourNumbers'
import { QuoteBoard } from '@/components/lp/QuoteBoard'
import { FairValueMatrix } from '@/components/lp/FairValueMatrix'
import { LedgerBoard } from '@/components/lp/LedgerBoard'
import { CostInputsPanel } from '@/components/lp/CostInputsPanel'
import { QuoteParamsPanel } from '@/components/lp/QuoteParamsPanel'
import { ResidualPanel } from '@/components/lp/ResidualPanel'
import { UnmappedPanel } from '@/components/lp/UnmappedPanel'

/**
 * /lp-matrix — LP 시그널 데스크 (v2 운영 사이클, §13).
 *
 * Rust 8200이 200ms throttle로 보내는 fair_value_matrix · book_risk · quote_board를 WS로 수신.
 * 포지션 / cost-inputs / quote-params / quote_universe는 페이지 mount 시 fetch + UI에서 POST.
 *
 * 레이아웃 순서 = §13 운영 사이클:
 *   ① 북 4숫자 → ② 호가 제안 보드(메인, §13.3-A) → ③ 원장(Phase 1, §13.5)
 *   → ④ Fair Value 매트릭스 + 잔차/미매핑 → ⑤ 조작(비용·호가 파라미터, 한 영역).
 */
export function LpMatrixPage() {
  useLpInit()

  return (
    <div className="flex flex-col gap-1 p-1">
      <BookFourNumbers />
      <QuoteBoard />
      <LedgerBoard />
      <FairValueMatrix />
      <div className="grid grid-cols-2 gap-1">
        <ResidualPanel />
        <UnmappedPanel />
      </div>
      {/* 조작 영역 통합 (CLAUDE.md "조작 요소는 하나의 패널로 통합") — 비용 + 호가 파라미터 */}
      <div className="grid grid-cols-2 gap-1">
        <CostInputsPanel />
        <QuoteParamsPanel />
      </div>
    </div>
  )
}
