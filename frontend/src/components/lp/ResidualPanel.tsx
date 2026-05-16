import { useLpStore } from '@/stores/lpStore'
import { cn } from '@/lib/utils'

/**
 * 잔차 기여도 상위 + 섹터별 노출 패널.
 *   - top_residual_contributors: 단독 위험 (|n| × σ) 정렬 top 10. 어떤 종목이 잔차 위험을
 *     가장 많이 끌어올리는지 — 의사결정 시 *그 종목을 줄이면 잔차 줄어듦*.
 *   - sector_exposures: fics_sector 기준 노출 합. *섹터 집중도* 확인용.
 */
export function ResidualPanel() {
  const bookRisk = useLpStore((s) => s.bookRisk)

  const fmt = (n: number) => {
    const abs = Math.abs(n)
    if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}억`
    if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`
    return Math.round(n).toLocaleString('ko-KR')
  }

  return (
    <div className="bg-bg-primary p-3">
      <div className="text-[13px] text-t2 font-medium mb-2">잔차 기여 / 섹터 노출</div>

      <div className="grid grid-cols-2 gap-3 text-[11px]">
        <div>
          <div className="text-[10px] text-t4 mb-1">잔차 기여 top 10 (|노출| × σ)</div>
          {bookRisk?.top_residual_contributors.length ? (
            <table className="w-full font-mono tabular-nums">
              <tbody>
                {bookRisk.top_residual_contributors.map(([code, v]) => (
                  <tr key={code} className="border-t border-bg-base/40">
                    <td className="py-1 text-t2">{code}</td>
                    <td className="py-1 text-right text-warning">{fmt(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-t4 text-xs py-2">대기 중...</div>
          )}
        </div>

        <div>
          <div className="text-[10px] text-t4 mb-1">섹터별 노출 (원화)</div>
          {bookRisk && Object.keys(bookRisk.sector_exposures).length > 0 ? (
            <table className="w-full font-mono tabular-nums">
              <tbody>
                {Object.entries(bookRisk.sector_exposures)
                  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                  .slice(0, 10)
                  .map(([sec, v]) => (
                    <tr key={sec} className="border-t border-bg-base/40">
                      <td className="py-1 text-t2 truncate max-w-[120px]">{sec}</td>
                      <td className={cn('py-1 text-right', v > 0 ? 'text-up' : 'text-down')}>
                        {v > 0 ? '+' : ''}{fmt(v)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <div className="text-t4 text-xs py-2">포지션 없음</div>
          )}
        </div>
      </div>
    </div>
  )
}
