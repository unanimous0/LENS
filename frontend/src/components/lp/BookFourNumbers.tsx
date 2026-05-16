import { useLpStore } from '@/stores/lpStore'
import { cn } from '@/lib/utils'

/**
 * PDF 4개 핵심 숫자 카드 패널 (데스크 전체 차원).
 *   #1 자체 기준가 ↔ 현재가  — 매트릭스 셀이 ETF별로 표시 (여기 카드 X)
 *   #2 베타조정 델타 (베타 시장 노출, 원화)
 *   #3 잔차위험 1σ (팩터 헤지 후 종목 고유 1일 변동 예상, 원화)
 *   #4 손익 분해 — 첫 빌드 스텁 (TODO 빈 박스)
 */
export function BookFourNumbers() {
  const bookRisk = useLpStore((s) => s.bookRisk)

  const fmt = (krw: number) => {
    const abs = Math.abs(krw)
    if (abs >= 1e8) return `${(krw / 1e8).toFixed(2)}억`
    if (abs >= 1e4) return `${(krw / 1e4).toFixed(1)}만`
    return Math.round(krw).toLocaleString('ko-KR')
  }
  const signColor = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t2')

  return (
    <div className="grid grid-cols-4 gap-1">
      <Card label="베타조정 델타 (#2)" hint="베타 적용 시장 노출">
        {bookRisk ? (
          <>
            <div className={cn('text-2xl font-mono tabular-nums', signColor(bookRisk.beta_adj_delta_krw))}>
              {bookRisk.beta_adj_delta_krw > 0 ? '+' : ''}{fmt(bookRisk.beta_adj_delta_krw)}
            </div>
            <div className="text-[11px] text-t3 tabular-nums">
              gross: {bookRisk.gross_delta_krw > 0 ? '+' : ''}{fmt(bookRisk.gross_delta_krw)}
            </div>
          </>
        ) : <Placeholder />}
      </Card>

      <Card label="잔차위험 1σ (#3)" hint="시장 헤지 후 일변동 예상">
        {bookRisk ? (
          <>
            <div className="text-2xl font-mono tabular-nums text-warning">
              ±{fmt(bookRisk.residual_risk_krw)}
            </div>
            <div className="text-[11px] text-t3">
              top 기여: {bookRisk.top_residual_contributors[0]?.[0] || '-'}
            </div>
          </>
        ) : <Placeholder />}
      </Card>

      <Card label="시장 노출 (#1 데스크)" hint="단일 팩터 KOSPI200 기준">
        {bookRisk ? (
          <div className="font-mono tabular-nums text-sm space-y-0.5">
            {Object.entries(bookRisk.delta_by_index).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-t3">{k}</span>
                <span className={signColor(v)}>{v > 0 ? '+' : ''}{fmt(v)}</span>
              </div>
            ))}
            {Object.keys(bookRisk.delta_by_index).length === 0 && (
              <span className="text-t3 text-xs">포지션 없음</span>
            )}
          </div>
        ) : <Placeholder />}
      </Card>

      <Card label="손익 분해 (#4)" hint="다음 빌드 — 체결 데이터 인입 후">
        <div className="flex items-center justify-center h-full text-t4 text-xs">
          TODO
        </div>
      </Card>
    </div>
  )
}

function Card({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-primary px-3 py-2">
      <div className="text-[11px] text-t3 mb-1">{label}</div>
      <div className="min-h-[44px]">{children}</div>
      <div className="text-[10px] text-t4 mt-1">{hint}</div>
    </div>
  )
}

function Placeholder() {
  return <span className="text-t4 text-xs">대기 중...</span>
}
