// timeframe별 half-life 환산 → 달력일(주말·공휴일 포함).
//
// stat-arb-engine은 각 timeframe의 *봉 개수* 로 half_life 반환.
// 인트라데이 봉은 장 열린 시간(거래시간)에만 존재하므로:
//   1) 봉 개수 → 거래일 (장중 시간 기준)
//   2) 거래일 → 달력일 (주말·공휴일 포함, ×CAL_PER_TRADING_DAY)
// 평균회귀는 장중에만 진행하므로 달력 환산은 근사("약 N일")임.

const TF_TO_SECONDS: Record<string, number> = {
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '10m': 600,
  '30m': 1800,
  '1h': 3600,
  '1d': 86400,
  '1w': 86400 * 5,
  '1mo': 86400 * 21,
}

// 한국장 연속세션 거래시간/일 ≈ 6.33h (09:01~15:19, 단일가 제외). 봉→거래일 환산용.
const TRADING_SEC_PER_DAY = 22800
// 거래일 → 달력일 근사: 한국 연 ~245영업일 / 365일 ≈ 1.49 (주말·공휴일 포함).
export const CAL_PER_TRADING_DAY = 1.49

/** half_life(봉 개수)를 거래일로. 인트라데이는 거래시간 기준, 1d+ 는 달력일 기준. */
export function toTradingDays(timeframe: string, half_life: number): number | null {
  const unitSec = TF_TO_SECONDS[timeframe]
  if (!unitSec) return null
  return unitSec >= 86400
    ? half_life * (unitSec / 86400)
    : (half_life * unitSec) / TRADING_SEC_PER_DAY
}

/** 거래일 → 달력일(주말·공휴일 포함 근사). */
export function toCalendarDays(timeframe: string, half_life: number): number | null {
  const td = toTradingDays(timeframe, half_life)
  return td == null ? null : td * CAL_PER_TRADING_DAY
}

function fmtCalDays(d: number): string {
  return d >= 1 ? `약 ${d.toFixed(1)}일` : `약 ${d.toFixed(2)}일`
}

/** half_life를 *봉 개수 + 달력일 환산* 으로. 예: ('10m', 104) → '104봉 (≈약 4.0일)' */
export function humanHalfLife(timeframe: string, half_life: number): string {
  if (!isFinite(half_life) || half_life <= 0) return '—'
  const d = toCalendarDays(timeframe, half_life)
  if (d == null) return half_life.toFixed(1)
  return `${half_life.toFixed(1)}봉 (≈${fmtCalDays(d)})`
}

/** 짧은 표기 (테이블 셀용) — 달력일 근사. 예: '약 4.0일', '약 0.40일'. */
export function humanHalfLifeShort(timeframe: string, half_life: number): string {
  if (!isFinite(half_life) || half_life <= 0) return '—'
  const d = toCalendarDays(timeframe, half_life)
  if (d == null) return half_life.toFixed(1)
  return fmtCalDays(d)
}
