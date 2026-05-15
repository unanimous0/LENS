// 통계차익 페어 series_key 유틸.
// 포맷: 'S:005930'(주식), 'E:069500'(ETF), 'I:K2G01P'(지수 구성 주식), 'F:ABK65000'(선물, 향후).

export type SeriesType = 'S' | 'E' | 'I' | 'F' | 'unknown'

/** 'S:005930' → '005930'. prefix 없으면 원본 그대로. */
export function keyToCode(key: string): string {
  const i = key.indexOf(':')
  return i >= 0 ? key.slice(i + 1) : key
}

/** 'S:005930' → 'S'. 알 수 없으면 'unknown'. */
export function keyType(key: string): SeriesType {
  const i = key.indexOf(':')
  if (i < 0) return 'unknown'
  const t = key.slice(0, i)
  return t === 'S' || t === 'E' || t === 'I' || t === 'F' ? t : 'unknown'
}
