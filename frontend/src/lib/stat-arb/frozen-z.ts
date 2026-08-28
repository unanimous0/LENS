// 고정 z (frozen z) — 진입 시점 파라미터로 얼린 좌표계. stat-arb-engine.md §24.
//
// 목록·상세의 "오늘 z"는 엔진이 사이클마다 다시 추정하는 회귀(α·β)와 정규화(μ·σ) 위에서
// 계산된다. 밴드가 움직이면 진입 z와 오늘 z는 *다른 자*가 되어 손익과 어긋난다
// (실사례: 한화에어로 ↔ KODEX 방산TOP10 — 화면 z 2.9 → 2.3 "수렴"으로 보였지만 진입 자
// 기준으론 역행, 손익 마이너스).
//
// 고정 z는 진입 스냅샷(α₀·β₀·μ₀·σ₀)을 그대로 두고 *가격만* 현재 것으로 바꾼다:
//   frozen_z = (P_right − (β₀·P_left + α₀) − μ₀) / σ₀
// → 진입 시점엔 정의상 entry_z와 같고, 이후 변화분은 스프레드 손익과 1:1이다:
//   ΔPnL ≈ −side_right × Δfrozen_z × σ₀ × (right leg 수량)   (β-정합 헤지 기준)
// 청산 판단(회귀 %·라벨·산점도)은 전부 이 자로 한다. 오늘 z는 "밴드가 얼마나 움직였나"를
// 보는 보조 지표로만 쓴다.

import { keyToCode } from '@/lib/stat-arb-keys'
import type { EntryZUpdate, Position, PositionEntryStats } from '@/types/positions'

/** z 좌표계 1벌 — 회귀(α·β) + 정규화(μ·σ). 고정이든 롤링이든 산식은 같다. */
export type ZBand = {
  /** 절편 α (원). */
  alpha: number
  /** 헤지비율 β. */
  beta: number
  /** 잔차 중심 μ (원). */
  center: number
  /** 잔차 σ (원) — 항상 > 0. */
  scale: number
}

/** 밴드가 어디서 왔는가.
 *
 *  - `stored`        진입 기록 모달이 그때 얼린 스냅샷 (정본)
 *  - `refit`         진입일 기준 일봉으로 다시 회귀해 되살린 밴드 (§24.8). 엔진과 같은 자라
 *                    실측상 스냅샷과 소수점까지 일치하지만, 엔진 창 시작이 프로세스 기동일에
 *                    걸려 있어 완전 항등은 아니다
 *  - `reconstructed` 진입 z에서 σ₀만 역산 (μ₀=0 가정) — α·β는 있는데 μ·σ가 없던 구 기록
 */
export type BandSource = 'stored' | 'refit' | 'reconstructed'

/** 진입 시 얼려둔 좌표계. */
export type FrozenBand = ZBand & {
  /** 스냅샷을 뜬 기준 timeframe ('1d' | '10m'). 구 스냅샷엔 없을 수 있음. */
  basis: string | null
  source: BandSource
}

/** 밴드도 역산도 못 할 때 화면에 붙일 사유. */
export const NO_BAND_REASON =
  '진입 밴드(μ·σ) 미저장 + 역산 불가 — 고정 z 도입 이전 기록 (수정 모달에서 재계산 가능)'

/** 역산 밴드임을 알리는 사유 문구. */
export const RECONSTRUCTED_NOTE = '진입 z에서 σ₀ 역산 (μ₀=0 가정) — 저장된 밴드 아님'

/** 밴드 출처 마커 (숫자 옆 작은 라벨). 저장 밴드는 정본이라 마커 없음. */
export const BAND_SOURCE_MARK: Record<BandSource, string | null> = {
  stored: null,
  refit: '재계산',
  reconstructed: '역산',
}

/** 밴드 출처 툴팁 1벌 — 목록·상세가 같은 문구를 쓴다. */
export const BAND_SOURCE_NOTE: Record<BandSource, string> = {
  stored: '진입 밴드 고정 기준',
  refit: '진입일 이전 일봉으로 밴드 재계산 (엔진과 같은 자) — 진입 z도 이 자로 잰 값',
  reconstructed: RECONSTRUCTED_NOTE,
}

/** KPI/통계표 라벨용 — '진입 밴드' / '재계산 밴드' / '역산 밴드'. */
export function bandSourceLabel(source: BandSource): string {
  return source === 'stored' ? '진입 밴드' : `${BAND_SOURCE_MARK[source]} 밴드`
}

/** σ₀ 역산 하한 — 진입 z가 0 근처면 σ₀ = spread/z 가 폭발한다. */
const MIN_Z_FOR_RECON = 0.2

/** |고정 z − 오늘 z| 가 이 값 이상이면 밴드가 크게 이동한 것으로 보고 주의 표시.
 *
 *  0.5σ 기준 — 이 기능을 만들게 한 실사례(한화에어로 ↔ KODEX 방산TOP10)의 괴리가 **0.69σ**라
 *  0.7로 잡으면 정작 그 케이스를 못 잡는다. 진입 임계가 2σ인 화면에서 0.5σ 차이는 이미
 *  "청산이냐 유지냐"를 뒤집는 크기다. */
export const BAND_SHIFT_WARN = 0.5

export const BAND_SHIFT_TOOLTIP =
  '밴드 이동 — 관계 재추정됨, 안정성 확인 (청산 판단은 고정 z 기준)'

/** entry_stats에 저장된 밴드. 필드 부족·σ₀ ≤ 0이면 null (고정 z 도입 이전 기록). */
export function storedBand(entry: PositionEntryStats | null | undefined): FrozenBand | null {
  if (!entry) return null
  const alpha = num(entry.alpha)
  const beta = num(entry.beta)
  const center = num(entry.center)
  const scale = num(entry.scale)
  if (alpha == null || beta == null || center == null || scale == null || !(scale > 0)) return null
  return {
    alpha,
    beta,
    center,
    scale,
    basis: typeof entry.basis === 'string' ? entry.basis : null,
    // 재계산 밴드는 저장 경로가 같고 (entry_stats) source 마커로만 갈린다.
    source: entry.source === 'refit' ? 'refit' : 'stored',
  }
}

/** 구 기록 구제 — 저장된 α₀·β₀ + 진입가 + 진입 z로 σ₀를 역산한다.
 *
 *  entry_z = (P_r0 − β₀·P_l0 − α₀ − μ₀) / σ₀ 에서 **μ₀ = 0**을 쓴다. 엔진 잔차는 절편 포함
 *  OLS라 평균이 정의상 0이고 실측도 |μ| < 1e-10 (`stats::resid_stats`) — 근사가 아니라 항등에
 *  가깝다. 남는 가정은 "진입가 = 진입 z를 만든 그 가격"뿐이고, 진입 기록 모달이 실시간가를
 *  prefill하므로 보통 성립한다. 부호가 어긋나면(σ₀ ≤ 0) α·β와 z가 다른 자에서 온 것이므로 포기.
 */
export function reconstructBand(pos: Position): FrozenBand | null {
  const entry = pos.entry_stats
  const alpha = num(entry?.alpha)
  const beta = num(entry?.beta)
  const entryZ = num(pos.entry_z)
  if (alpha == null || beta == null || entryZ == null || Math.abs(entryZ) < MIN_Z_FOR_RECON) {
    return null
  }
  const legs = pos.legs
  if (!legs) return null
  const leftLeg = legs.find((l) => l.code === keyToCode(pos.left_key))
  const rightLeg = legs.find((l) => l.code === keyToCode(pos.right_key))
  if (!leftLeg || !rightLeg) return null
  const spread0 = rightLeg.entry_price - alpha - beta * leftLeg.entry_price
  const scale = spread0 / entryZ
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  return {
    alpha,
    beta,
    center: 0,
    scale,
    basis: typeof entry?.basis === 'string' ? entry.basis : null,
    source: 'reconstructed',
  }
}

/** 화면에서 쓸 밴드 1벌 — 저장 밴드 우선, 없으면 역산. 둘 다 안 되면 null. */
export function frozenBand(pos: Position): FrozenBand | null {
  return storedBand(pos.entry_stats) ?? reconstructBand(pos)
}

/** 밴드 기준 스프레드 (원) — right − (β·left + α). */
export function frozenSpread(band: ZBand, leftPrice: number, rightPrice: number): number | null {
  if (!(leftPrice > 0) || !(rightPrice > 0)) return null
  return rightPrice - band.alpha - band.beta * leftPrice
}

/** 밴드 기준 z. 가격이 없거나 밴드가 없으면 null. (고정 밴드에 넣으면 고정 z) */
export function frozenZ(
  band: ZBand | null,
  leftPrice: number,
  rightPrice: number
): number | null {
  if (!band) return null
  const spread = frozenSpread(band, leftPrice, rightPrice)
  if (spread == null) return null
  return (spread - band.center) / band.scale
}

/** 고정 z ↔ 오늘 z 괴리 (σ₀ 단위). 둘 중 하나라도 없으면 null. */
export function bandShift(frozenZValue: number | null, rollingZ: number | null): number | null {
  if (frozenZValue == null || rollingZ == null) return null
  return frozenZValue - rollingZ
}

/** 괴리 경고 여부 — 기준이 다른 timeframe끼리는 비교 자체가 무의미하므로 제외. */
export function isBandShiftWarn(
  shift: number | null,
  band: FrozenBand | null,
  rollingBasis: string = '1d'
): boolean {
  if (shift == null || band == null) return false
  if (band.basis != null && band.basis !== rollingBasis) return false
  return Math.abs(shift) >= BAND_SHIFT_WARN
}

/** 기록 수정(PUT) 후 서버가 entry_z를 어떻게 처리했는지 한 줄 안내. 손댄 게 없으면 null.
 *
 *  밴드가 저장된 기록은 진입가를 고치면 서버가 `(spread₀ − μ₀)/σ₀`로 다시 계산한다 —
 *  화면이 조용히 바뀌면 사용자가 "왜 진입 z가 달라졌지"가 되므로 명시적으로 알린다. */
export function entryZNotice(u?: EntryZUpdate): string | null {
  if (!u) return null
  const f = (v: number | null) =>
    v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
  switch (u.mode) {
    case 'refit':
    case 'recomputed':
      return `진입 z 재계산 ${f(u.previous)} → ${f(u.value)}${u.note ? ` · ${u.note}` : ''}`
    case 'manual':
      return `진입 z ${f(u.previous)} → ${f(u.value)} (직접 입력)`
    case 'ignored':
      return u.note
    default:
      return null
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
