import type { SeriesMarker, Time } from 'lightweight-charts'

/**
 * 수급 태그 에피소드 히스토리 (PR-B) — 타입 + 순수 헬퍼 (컴포넌트 분리, react-refresh 준수).
 * 표시 컴포넌트는 flow-episodes.tsx. 어떤 수치도 재계산하지 않는다(백엔드 정본 소비).
 */

export type Horizon = { stock_pct: number; excess_pct: number | null } | null
export type Episode = {
  onset: string
  duration_days: number
  entry_date: string
  entry_price: number
  h20: Horizon
  h60: Horizon
  h120: Horizon
  ongoing: boolean
  partial: { days: number; stock_pct: number; excess_pct: number | null } | null
}
export type PatternBlock = {
  episodes: Episode[]
  stats: { count: number; avg_excess_h60: number | null; win_rate_h60: number | null }
}
export type EpisodesResponse = {
  code: string
  as_of: string
  benchmark_available: boolean
  benchmark_as_of: string | null
  period: { start: string; end: string } | null
  patterns: Record<string, PatternBlock>
}

// 표시·정렬 순서 = flow_verdict 배타 체인 + 경고 계열 (백엔드와 일치).
const PATTERN_ORDER = [
  '장기동시',
  '정석(동시+진입권)',
  '진입권',
  '추세순항',
  '동시',
  '매집주 눌림',
  '하락추세 매집',
  '동반순매도',
  '분배',
  '단기반등',
]
// 기본 선택 후보 = 매수 아키타입 배타 체인 (에피소드 있는 것 중 최상위).
const BUY_CHAIN = ['장기동시', '정석(동시+진입권)', '진입권', '추세순항', '동시', '매집주 눌림']
// 약세(빨강 ▼) 계열 — 나머지는 강세(초록 ▲). 태그 색 시맨틱(v1.9)과 일관.
const BEARISH = new Set(['동반순매도', '분배', '단기반등'])

export const patternDir = (name: string): 'bull' | 'bear' => (BEARISH.has(name) ? 'bear' : 'bull')
export const DIR_COLOR = { bull: '#34c759', bear: '#ff3b30' } as const

/** 에피소드 있는 패턴을 PATTERN_ORDER로 정렬해 반환. */
export function patternsWithEpisodes(patterns: Record<string, PatternBlock>): string[] {
  const ordered = PATTERN_ORDER.filter((n) => patterns[n]?.episodes?.length)
  const extra = Object.keys(patterns).filter(
    (n) => patterns[n]?.episodes?.length && !PATTERN_ORDER.includes(n)
  )
  return [...ordered, ...extra]
}

/** 기본 선택 패턴 = 배타 체인 최상위 매수 패턴(에피소드 有), 없으면 첫 패턴. */
export function defaultPattern(patterns: Record<string, PatternBlock>): string | null {
  const has = (n: string) => !!patterns[n]?.episodes?.length
  for (const n of BUY_CHAIN) if (has(n)) return n
  return patternsWithEpisodes(patterns)[0] ?? null
}

/** 선택 패턴 onset들을 주가차트 마커로. validDates(차트 범위 내 날짜)만 — 밖은 제외. 시간 오름차순. */
export function onsetMarkers(
  block: PatternBlock | undefined,
  validDates: Set<string>,
  name: string
): SeriesMarker<Time>[] {
  if (!block) return []
  const bear = patternDir(name) === 'bear'
  return block.episodes
    .filter((e) => validDates.has(e.onset))
    .map((e) => ({
      time: e.onset as unknown as Time,
      position: (bear ? 'aboveBar' : 'belowBar') as SeriesMarker<Time>['position'],
      color: bear ? DIR_COLOR.bear : DIR_COLOR.bull,
      shape: (bear ? 'arrowDown' : 'arrowUp') as SeriesMarker<Time>['shape'],
    }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
}
