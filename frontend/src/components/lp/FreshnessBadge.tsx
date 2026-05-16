import { cn } from '@/lib/utils'

/**
 * 신선도 배지 — inputs_age_ms를 색으로 분류.
 *   < 1000ms : 초록 (실시간)
 *   < 5000ms : 회색 (정상)
 *   < 60000ms: 노랑 (지연)
 *   ≥ 60000ms: 빨강 (stale — usable=false 게이트 임계)
 */
export function FreshnessBadge({ ageMs }: { ageMs: number }) {
  const label = ageMs < 1000 ? `${ageMs}ms` : ageMs < 60_000 ? `${(ageMs / 1000).toFixed(1)}s` : `${(ageMs / 60_000).toFixed(0)}m`
  const color =
    ageMs < 1000 ? 'text-up' :
    ageMs < 5000 ? 'text-t3' :
    ageMs < 60_000 ? 'text-warning' : 'text-down'
  return (
    <span className={cn('text-[10px] tabular-nums', color)} title={`입력 데이터 나이: ${ageMs}ms`}>
      {label}
    </span>
  )
}
