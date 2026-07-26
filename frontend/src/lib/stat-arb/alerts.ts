// 목표 z 도달 알림 (워치리스트) — 타입 · API · 판정 헬퍼.
//
// 발굴(discovery)은 일봉 OLS라 PairRow.alpha/hedge_ratio가 곧 일봉 α·β다.
// 장중 라이브 z는 그 회귀식에 실시간 가격을 넣어 같은 μ·σ로 정규화한 값:
//   live_resid = right − alpha − hedge_ratio × left
//   live_z     = (live_resid − resid_mean) / resid_std
// resid_mean/resid_std는 엔진이 z_score와 *같은 잔차*에서 뽑아 내려준다
// (stat-arb-engine `stats::resid_stats`) → 목록 z와 라이브 z의 척도가 항상 동일.
//
// 감시·발화는 프론트(탭이 열려 있는 동안)가 하고, 서버(SQLite)는 워치 항목 저장만 한다.

import type { PairRow } from '@/types/stat-arb'

export type AlertDirection = 'abs' | 'above' | 'below'

export type StatArbAlert = {
  id: number
  left_key: string
  right_key: string
  left_name: string | null
  right_name: string | null
  /** 항상 양수 임계. 부호 해석은 direction이 결정. */
  target_z: number
  direction: AlertDirection
  enabled: boolean
  note: string | null
  created_at: string
  last_triggered_at: string | null
}

export const DIRECTION_LABELS: Record<AlertDirection, string> = {
  abs: '|z| 양방향',
  above: 'z ≥ 목표',
  below: 'z ≤ −목표',
}

/** 재무장 비율 — 한 번 울리면 |z|가 목표의 이 배수 아래로 되돌아와야 다시 울린다(경계 연타 방지). */
export const REARM_RATIO = 0.8

/** 기본 목표 z — 표준 진입 임계(2σ). */
export const DEFAULT_TARGET_Z = 2.0

/** 알림/페어 조인 키. stat-arb-positions.tsx와 동일 규칙. */
export function pairKey(left: string, right: string): string {
  return `${left}|${right}`
}

/** 일봉 회귀(α·β)와 정규화 기준(μ·σ)으로 라이브 z 계산. 입력 부족·σ 0이면 null. */
export function liveZ(stat: PairRow | undefined, leftPrice: number, rightPrice: number): number | null {
  if (!stat || !(leftPrice > 0) || !(rightPrice > 0)) return null
  const std = stat.resid_std
  if (std == null || !(std > 0) || stat.resid_mean == null) return null
  const resid = rightPrice - stat.alpha - stat.hedge_ratio * leftPrice
  return (resid - stat.resid_mean) / std
}

/** 목표 도달 여부. */
export function isHit(z: number, target: number, dir: AlertDirection): boolean {
  if (dir === 'above') return z >= target
  if (dir === 'below') return z <= -target
  return Math.abs(z) >= target
}

/** 재무장(다시 울릴 준비) 여부 — 목표 × REARM_RATIO 안쪽으로 되돌아왔나. */
export function isRearmed(z: number, target: number, dir: AlertDirection): boolean {
  const t = target * REARM_RATIO
  if (dir === 'above') return z < t
  if (dir === 'below') return z > -t
  return Math.abs(z) < t
}

/** 목표까지 남은 거리 (0 이하면 이미 도달). */
export function distanceToTarget(z: number, target: number, dir: AlertDirection): number {
  if (dir === 'above') return target - z
  if (dir === 'below') return z + target
  return target - Math.abs(z)
}

// ---------------------------------------------------------------------------
// API (backend 로컬 SQLite — 엔진 프록시 아님)
// ---------------------------------------------------------------------------

const BASE = '/api/stat-arb/alerts'

async function asJson<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
}

export async function fetchAlerts(): Promise<StatArbAlert[]> {
  const d = await fetch(BASE).then((r) => asJson<{ items: StatArbAlert[] }>(r))
  return d.items
}

export type AlertCreateInput = {
  left_key: string
  right_key: string
  left_name?: string
  right_name?: string
  target_z: number
  direction?: AlertDirection
  note?: string
}

/** 등록. 같은 (left,right,direction)이 이미 있으면 목표 갱신 + 재활성화(서버 UPSERT). */
export async function createAlert(input: AlertCreateInput): Promise<StatArbAlert> {
  return fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction: 'abs', ...input }),
  }).then((r) => asJson<StatArbAlert>(r))
}

export async function patchAlert(
  id: number,
  fields: { target_z?: number; enabled?: boolean; note?: string }
): Promise<StatArbAlert> {
  return fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then((r) => asJson<StatArbAlert>(r))
}

export async function deleteAlert(id: number): Promise<void> {
  const r = await fetch(`${BASE}/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
}

/** 발화 시각 기록. 실패해도 알림 자체는 이미 울렸으므로 치명적이지 않음. */
export async function markTriggered(id: number): Promise<StatArbAlert> {
  return fetch(`${BASE}/${id}/triggered`, { method: 'POST' }).then((r) => asJson<StatArbAlert>(r))
}
