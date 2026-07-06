/** 백테스트 결과 표시용 포맷 헬퍼 (컴포넌트 아님 — fast-refresh 격리). */

export function signCls(v: number | null | undefined): string {
  if (v == null) return 'text-t3'
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3'
}

/** +3.6 / −2.1 (부호 명시). */
export function fmtSigned(v: number | null | undefined, digits = 2): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`
}

export function fmtPct(v: number | null | undefined, digits = 2): string {
  if (v == null) return '—'
  return `${fmtSigned(v, digits)}%`
}

export function fmtEok(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Math.round(v).toLocaleString()}억`
}
