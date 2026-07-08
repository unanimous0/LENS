import { useBasisZscore } from '@/hooks/useBasisZscore'
import type { BasisZFamily } from '@/types/lp'
import { cn } from '@/lib/utils'

/**
 * 지수 베이시스 z-score 요약 스트립 — /lp-matrix "체결 전" 탭 (호가·기회 맥락).
 *
 * BasisBookPanel(§13.4·§13.11)의 지수 베이시스 z 칼럼을 **발췌한 소형 참조 카드**.
 * 포지션 유무와 무관하게 K200·KQ150 지수 베이시스가 만기 정규화 excess 분포 대비 지금
 * rich/cheap(z)한지를 보여줘 호가를 어느 쪽으로 기울일지 판단 참고 (계산·정본은 §13.11
 * BasisBookPanel, 여기는 읽기 전용 요약). 데이터는 useBasisZscore 15초 폴링(1h 캐시).
 */
const FAMILY_LABEL: Record<string, string> = { k200: 'K200', kq150: 'KQ150' }
const ORDER = ['k200', 'kq150']

export function IndexBasisStrip() {
  const zscore = useBasisZscore()
  const families = zscore?.families ?? {}
  const rows = ORDER.filter((f) => families[f])

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base flex items-baseline justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">지수 베이시스 (진입 참고)</div>
          <div className="text-[11px] text-t4">
            만기 정규화 excess 60일 분포 대비 z — rich(+)면 매도차 우호, cheap(−)면 매수차 우호
          </div>
        </div>
      </div>
      <div className="px-3 py-2 flex flex-wrap gap-2">
        {rows.length === 0 && (
          <div className="text-[11px] text-t4 py-1">
            지수선물 시세 수신 후 z 표시 (장외/미구독이면 대기).
          </div>
        )}
        {rows.map((f) => (
          <FamilyCard key={f} label={FAMILY_LABEL[f] ?? f} zf={families[f]} />
        ))}
      </div>
    </div>
  )
}

function FamilyCard({ label, zf }: { label: string; zf: BasisZFamily }) {
  const z = zf.z
  const excess = zf.current_excess
  const extreme = z != null && Math.abs(z) >= 2
  const zColor =
    z == null
      ? 'text-t4'
      : extreme
        ? 'text-warning'
        : z > 0
          ? 'text-down'
          : z < 0
            ? 'text-up'
            : 'text-t3'
  return (
    <div className="min-w-[180px] flex-1 bg-bg-surface rounded-sm px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-t1 font-medium">{label}</span>
        <span className={cn('text-[13px] tabular-nums font-mono font-medium', zColor)}>
          {z == null ? 'z —' : `z ${z > 0 ? '+' : ''}${z.toFixed(2)}`}
          {extreme && <span className="ml-1 text-[9px]">⚠</span>}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] tabular-nums font-mono">
        <span className="text-t4">excess</span>
        <span className="text-t2 text-right">
          {excess == null ? '-' : `${excess > 0 ? '+' : ''}${excess.toFixed(2)}`}
        </span>
        <span className="text-t4">실측 / 이론</span>
        <span className="text-t2 text-right">
          {zf.current == null ? '-' : zf.current.toFixed(2)} /{' '}
          {zf.theory_now == null ? '-' : zf.theory_now.toFixed(2)}
        </span>
        <span className="text-t4">분포 μ±σ</span>
        <span className="text-t2 text-right">
          {zf.mean == null || zf.std == null
            ? '-'
            : `${zf.mean.toFixed(1)}±${zf.std.toFixed(1)}`}
        </span>
        <span className="text-t4">만기</span>
        <span className="text-t2 text-right">
          D-{zf.days_to_expiry} · n{zf.n}
        </span>
      </div>
    </div>
  )
}
