// timeframe별 half-life 단위 환산 → 거래일(trading days).
//
// stat-arb-engine은 각 timeframe의 *봉 개수* 로 half_life 반환 — 예:
//   10m timeframe / hl=104 → 104개 10분봉.
// 인트라데이 봉은 장 열린 시간(거래시간)에만 존재하므로, 단순히 ×시간 하면
// "거래시간"이 나와 달력시간으로 오해하기 쉽다. → 거래일로 환산해 표시.
//   예) 10m hl=104 → 104×10분 = 1040 거래분 ≈ 2.7 거래일 (달력으론 ~1주).

const TF_TO_SECONDS: Record<string, number> = {
  '30s': 30,
  '1m': 60,
  '5m': 300,
  '10m': 600,
  '30m': 1800,
  '1h': 3600,
  '1d': 86400,
  '1w': 86400 * 5, // 영업주 5일 기준
  '1mo': 86400 * 21, // 영업월 21일 기준
}

// 한국장 연속세션 거래시간/일 ≈ 6.33h (09:01~15:19, 시·종가 단일가 제외).
// 인트라데이 봉을 거래일로 환산할 때의 분모. (10분봉이면 22800/600 = 38봉/거래일)
const TRADING_SEC_PER_DAY = 22800

/** half_life(봉 개수)를 거래일로 환산. 인트라데이는 거래시간 기준, 1d+ 는 달력일 기준. */
function toTradingDays(timeframe: string, half_life: number): number | null {
  const unitSec = TF_TO_SECONDS[timeframe]
  if (!unitSec) return null
  return unitSec >= 86400
    ? half_life * (unitSec / 86400) // 1d/1w/1mo: half_life가 이미 달력일 단위
    : (half_life * unitSec) / TRADING_SEC_PER_DAY // 인트라데이: 거래시간 → 거래일
}

function fmtDays(d: number): string {
  return d >= 1 ? `${d.toFixed(1)}거래일` : `${d.toFixed(2)}거래일`
}

/**
 * half_life를 *봉 개수 + 거래일 환산* 으로. 예: ('10m', 104) → '104봉 (≈2.7거래일)'
 */
export function humanHalfLife(timeframe: string, half_life: number): string {
  if (!isFinite(half_life) || half_life <= 0) return '—'
  const d = toTradingDays(timeframe, half_life)
  if (d == null) return half_life.toFixed(1)
  return `${half_life.toFixed(1)}봉 (≈${fmtDays(d)})`
}

/** 짧은 표기 (테이블 셀·KPI용) — 거래일 단위. 예: '2.7거래일', '0.40거래일'. */
export function humanHalfLifeShort(timeframe: string, half_life: number): string {
  if (!isFinite(half_life) || half_life <= 0) return '—'
  const d = toTradingDays(timeframe, half_life)
  if (d == null) return half_life.toFixed(1)
  return fmtDays(d)
}
