// timeframe별 half-life 단위 환산.
//
// stat-arb-engine은 각 timeframe의 *그 단위* 로 half_life 반환 — 예:
//   30s timeframe / hl=89  → 89 × 30초 ≈ 44.5분
//   1m            / hl=517 → 517분    ≈ 8.6시간
//   1d            / hl=3.4 → 3.4일
// 화면 표기는 *환산값과 함께* 보여주는 게 자연스러움.

const TF_TO_SECONDS: Record<string, number> = {
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '30m': 1800,
  '1h': 3600,
  '1d': 86400,
  '1w': 86400 * 5, // 영업주 5일 기준
  '1mo': 86400 * 21, // 영업월 21일 기준
}

function humanDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(0)}초`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}분`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}시간`
  if (seconds < 86400 * 30) return `${(seconds / 86400).toFixed(1)}일`
  return `${(seconds / 86400 / 30).toFixed(1)}달`
}

/**
 * timeframe의 half_life 값을 *읽기 좋은 단위*로 환산.
 * 예: ('30s', 89) → '89 (≈44.5분)'
 *     ('1d', 3.4) → '3.4 (≈3.4일)'
 */
export function humanHalfLife(timeframe: string, half_life: number): string {
  if (!isFinite(half_life) || half_life <= 0) return '—'
  const unitSec = TF_TO_SECONDS[timeframe]
  if (!unitSec) return half_life.toFixed(1)
  const totalSec = half_life * unitSec
  return `${half_life.toFixed(1)} (≈${humanDuration(totalSec)})`
}

/** 짧은 표기 (테이블 셀용) — '44.5분', '8.6시간', '3.4일'. raw 숫자는 생략. */
export function humanHalfLifeShort(timeframe: string, half_life: number): string {
  if (!isFinite(half_life) || half_life <= 0) return '—'
  const unitSec = TF_TO_SECONDS[timeframe]
  if (!unitSec) return half_life.toFixed(1)
  return humanDuration(half_life * unitSec)
}
