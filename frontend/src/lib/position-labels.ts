// 포지션 자동 라벨링 + PnL 단순 계산 util.
// stat-arb-engine.md §9.4 분류 기준 그대로.

import type { Position } from '@/types/positions'

export type PositionLabel = 'exit_suggest' | 'converge' | 'diverge' | 'stale' | 'progress'

export const LABEL_META: Record<PositionLabel, { ko: string; cls: string }> = {
  exit_suggest: { ko: '청산권장', cls: 'bg-warning/15 text-warning' },
  converge: { ko: '수렴', cls: 'bg-up/15 text-up' },
  diverge: { ko: '발산', cls: 'bg-down/15 text-down' },
  stale: { ko: 'stale', cls: 'bg-t4/15 text-t3' },
  progress: { ko: '진행중', cls: 'bg-bg-surface text-t2' },
}

const MS_PER_DAY = 86400000

/** 페어 통계 + 포지션 정보로부터 자동 라벨 도출.
 *  우선순위: 청산권장 > 수렴 > 발산 > stale > 진행중
 */
export function deriveLabel(
  pos: Position,
  currentZ: number | null,
  halfLifeDays: number | null,
  nowMs: number = Date.now()
): PositionLabel {
  if (currentZ == null) return 'progress'
  if (Math.abs(currentZ) < 0.3) return 'exit_suggest'

  const entryZ = pos.entry_z
  if (entryZ != null && Math.abs(entryZ) > 1e-6) {
    // 부호가 반대로 뒤집힘 = 회귀를 넘어 반대편 진출 → 청산권장 (실현 시점)
    if (entryZ * currentZ < 0) return 'exit_suggest'
    if (Math.abs(currentZ) < Math.abs(entryZ) * 0.5) return 'converge'
    if (Math.abs(currentZ) > Math.abs(entryZ) * 1.1) return 'diverge'
  }

  const holdDays = (nowMs - pos.opened_at) / MS_PER_DAY
  if (halfLifeDays && halfLifeDays > 0 && holdDays > halfLifeDays * 2) {
    const regression =
      entryZ != null && Math.abs(entryZ) > 1e-6
        ? 1 - Math.abs(currentZ) / Math.abs(entryZ)
        : 0
    if (regression < 0.5) return 'stale'
  }
  return 'progress'
}

/** 회귀 % — 진입 z 대비 현재 z 절댓값 축소율. 진입z 0이면 null. */
export function regressionPct(entryZ: number | null, currentZ: number | null): number | null {
  if (entryZ == null || currentZ == null || Math.abs(entryZ) < 1e-6) return null
  return (1 - Math.abs(currentZ) / Math.abs(entryZ)) * 100
}

/** 보유일 (정수 반올림). */
export function holdDays(openedAtMs: number, nowMs: number = Date.now()): number {
  return Math.max(0, Math.round((nowMs - openedAtMs) / MS_PER_DAY))
}

/** 평가손익 단순 추정 — 통계차익 부분 회귀 모델.
 *
 *  진입 시 spread = right_entry - α - β × left_entry
 *  완전 회귀 시 PnL = |entry_spread| × right_qty
 *  부분 회귀 시 PnL = |entry_spread| × right_qty × regression_ratio
 *
 *  PR18에서 실시간 가격 기반 정밀 계산으로 교체 예정.
 */
export function estimateMarkPnL(
  pos: Position,
  pair: { alpha: number; hedge_ratio: number; z_score: number } | null
): number | null {
  if (!pos.legs || pos.legs.length < 2 || !pair) return null
  // left_key 의 leg 찾기 — left/right 매칭
  const leftCode = pos.left_key.slice(pos.left_key.indexOf(':') + 1)
  const rightCode = pos.right_key.slice(pos.right_key.indexOf(':') + 1)
  const leftLeg = pos.legs.find((l) => l.code === leftCode)
  const rightLeg = pos.legs.find((l) => l.code === rightCode)
  if (!leftLeg || !rightLeg) return null

  const entrySpread = rightLeg.entry_price - pair.alpha - pair.hedge_ratio * leftLeg.entry_price
  const entryZ = pos.entry_z
  if (entryZ == null || Math.abs(entryZ) < 1e-6) return null
  const regression = 1 - pair.z_score / entryZ // z 절댓값이 줄어드는 게 회귀
  const rightQty = rightLeg.qty
  return Math.abs(entrySpread) * rightQty * regression
}

/** 대여수익 누적 — leg.entry_price × loan.qty × rate × 보유일/365. 종료된 loan은 ended_at 기준. */
export function estimateLoanPnL(pos: Position, nowMs: number = Date.now()): number {
  if (!pos.loans || pos.loans.length === 0 || !pos.legs) return 0
  let total = 0
  for (const loan of pos.loans) {
    const leg = pos.legs.find((l) => l.id === loan.leg_id)
    if (!leg) continue
    const end = loan.ended_at ?? nowMs
    const days = Math.max(0, (end - loan.started_at) / MS_PER_DAY)
    const notional = leg.entry_price * loan.qty
    total += notional * (loan.rate_pct / 100) * (days / 365)
  }
  return total
}
