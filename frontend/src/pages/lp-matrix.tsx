import { useLpInit } from '@/hooks/useLpInit'
import { BookFourNumbers } from '@/components/lp/BookFourNumbers'
import { FairValueMatrix } from '@/components/lp/FairValueMatrix'
import { PositionEntry } from '@/components/lp/PositionEntry'
import { CostInputsPanel } from '@/components/lp/CostInputsPanel'
import { ResidualPanel } from '@/components/lp/ResidualPanel'
import { UnmappedPanel } from '@/components/lp/UnmappedPanel'

/**
 * /lp-matrix — LP 시그널 데스크.
 *
 * Rust 8200이 200ms throttle로 보내는 fair_value_matrix · book_risk를 WS로 수신.
 * 포지션 / cost-inputs는 페이지 mount 시 fetch + UI에서 POST.
 *
 * 첫 빌드: 2 ETF (A229200 / A396500) × 2 헤지경로 (PDF 바스켓 / PDF∩주식선물) wire.
 * 나머지 3 경로(지수선물 / 상관 ETF / 베타 헤지)는 다음 빌드.
 */
export function LpMatrixPage() {
  useLpInit()

  return (
    <div className="flex flex-col gap-1 p-1">
      <BookFourNumbers />
      <FairValueMatrix />
      <div className="grid grid-cols-2 gap-1">
        <PositionEntry />
        <CostInputsPanel />
      </div>
      <div className="grid grid-cols-2 gap-1">
        <ResidualPanel />
        <UnmappedPanel />
      </div>
    </div>
  )
}
