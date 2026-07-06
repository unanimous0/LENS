/** 좌 빌더의 편집 상태 ↔ 전략 JSON. 프리셋 정의 포함. */
import {
  type CatalogIndex,
  type EditCond,
  blankCond,
  fromCondition,
  toCondition,
} from './catalog'
import type { Condition, ExitRule, Group, Strategy } from './types'

export type BuilderState = {
  name: string
  markets: { KOSPI: boolean; KOSDAQ: boolean }
  minAdv: string
  minMcap: string
  // 진입: 기본 all 리스트 + OR 그룹 1개 (스키마 1-depth 중첩 대응)
  andConds: EditCond[]
  orEnabled: boolean
  orConds: EditCond[]
  // 체결
  entryFill: 'next_open' | 'next_close' | 'same_close'
  exitFill: 'next_open' | 'next_close' | 'same_close'
  costBps: string
  // 청산 규칙 (whichever-first)
  fixedEnabled: boolean
  fixedDays: string
  stopEnabled: boolean
  stopPct: string // 양수 크기 입력 → 전송 시 음수
  takeEnabled: boolean
  takePct: string
  condExitEnabled: boolean
  condExitMode: 'all' | 'any'
  condExitRows: EditCond[]
  // 기간·벤치마크
  start: string
  end: string
  benchmark: 'universe_avg' | 'none'
}

export function defaultState(idx: CatalogIndex): BuilderState {
  return {
    name: 'untitled',
    markets: { KOSPI: true, KOSDAQ: true },
    minAdv: '10',
    minMcap: '500',
    andConds: [blankCond(idx)],
    orEnabled: false,
    orConds: [blankCond(idx)],
    entryFill: 'next_open',
    exitFill: 'next_open',
    costBps: '25',
    fixedEnabled: true,
    fixedDays: '120',
    stopEnabled: false,
    stopPct: '15',
    takeEnabled: false,
    takePct: '30',
    condExitEnabled: false,
    condExitMode: 'any',
    condExitRows: [blankCond(idx)],
    start: '',
    end: '',
    benchmark: 'universe_avg',
  }
}

export type SerializeResult = { strategy: Strategy | null; errors: string[] }

/** 편집 상태 → 전략 JSON + 클라이언트 검증 에러. */
export function serialize(idx: CatalogIndex, s: BuilderState): SerializeResult {
  const errors: string[] = []

  // 진입 조건
  const andLeaves = s.andConds.map((c) => toCondition(idx, c)).filter((c): c is Condition => c != null)
  const orLeaves = s.orEnabled
    ? s.orConds.map((c) => toCondition(idx, c)).filter((c): c is Condition => c != null)
    : []

  if (s.andConds.length !== andLeaves.length || (s.orEnabled && s.orConds.length !== orLeaves.length)) {
    errors.push('진입 조건에 값이 비었거나 잘못된 행이 있습니다.')
  }

  let entry: Group | null = null
  if (andLeaves.length && orLeaves.length) {
    entry = { all: [...andLeaves, { any: orLeaves }] }
  } else if (andLeaves.length) {
    entry = { all: andLeaves }
  } else if (orLeaves.length) {
    entry = { any: orLeaves }
  } else {
    errors.push('진입 조건이 최소 1개 필요합니다.')
  }

  // 유니버스
  const markets = (['KOSPI', 'KOSDAQ'] as const).filter((m) => s.markets[m])
  if (!markets.length) errors.push('시장(KOSPI/KOSDAQ)을 최소 1개 선택하세요.')

  // 청산 규칙
  const rules: ExitRule[] = []
  if (s.fixedEnabled) {
    const d = parseInt(s.fixedDays, 10)
    if (!Number.isFinite(d) || d < 1) errors.push('고정 보유일은 1 이상이어야 합니다.')
    else rules.push({ type: 'fixed_holding', days: d })
  }
  if (s.stopEnabled) {
    const v = Number(s.stopPct)
    if (!Number.isFinite(v) || v <= 0) errors.push('손절 %는 양수 크기로 입력하세요 (예: 15).')
    else rules.push({ type: 'stop_loss_pct', value: -Math.abs(v) })
  }
  if (s.takeEnabled) {
    const v = Number(s.takePct)
    if (!Number.isFinite(v) || v <= 0) errors.push('익절 %는 양수로 입력하세요 (예: 30).')
    else rules.push({ type: 'take_profit_pct', value: Math.abs(v) })
  }
  if (s.condExitEnabled) {
    const leaves = s.condExitRows.map((c) => toCondition(idx, c)).filter((c): c is Condition => c != null)
    if (!leaves.length) errors.push('조건 청산을 켰으면 조건이 최소 1개 필요합니다.')
    else rules.push(s.condExitMode === 'all' ? { type: 'condition', all: leaves } : { type: 'condition', any: leaves })
  }
  if (!rules.length) errors.push('청산 규칙이 최소 1개 필요합니다.')

  if (errors.length || !entry) return { strategy: null, errors }

  const minAdv = Number(s.minAdv)
  const minMcap = Number(s.minMcap)
  const cost = Number(s.costBps)

  const strategy: Strategy = {
    name: s.name.trim() || 'untitled',
    universe: {
      markets,
      min_adv_eok: Number.isFinite(minAdv) ? minAdv : 10,
      min_mcap_eok: Number.isFinite(minMcap) ? minMcap : 500,
    },
    entry,
    execution: {
      entry_fill: s.entryFill,
      exit_fill: s.exitFill,
      cost_bps: Number.isFinite(cost) ? cost : 25,
    },
    exit: { rules },
    portfolio: { mode: 'event_study' },
    benchmark: s.benchmark,
    period: { start: s.start || null, end: s.end || null },
  }
  return { strategy, errors: [] }
}

// ── 프리셋 (검증된 조합만 — backtest.md §검증) ────────────────────────────────
export type Preset = { key: string; label: string; desc: string; make: (idx: CatalogIndex) => BuilderState }

function withEntry(idx: CatalogIndex, field: string, extraExit?: Partial<BuilderState>): BuilderState {
  return {
    ...defaultState(idx),
    andConds: [fromCondition({ field, op: 'is_true' })],
    ...extraExit,
  }
}

export const PRESETS: Preset[] = [
  {
    key: 'longterm120',
    label: '장기동시 · 120일 보유',
    desc: '외인·기관 20D·120D 동반 순매수 진입 → 120거래일 고정 보유. 게이트 재현 헤드라인(전 구간 +1.58%, t 2.37).',
    make: (idx) => withEntry(idx, 'flow.tag.장기동시'),
  },
  {
    key: 'standard-guard',
    label: '정석 · 손절15·익절30',
    desc: '정석(동시+진입권) 진입 → 120일 만기 + 손절 15% + 익절 30% whichever-first.',
    make: (idx) =>
      withEntry(idx, 'flow.tag.정석(동시+진입권)', {
        stopEnabled: true,
        stopPct: '15',
        takeEnabled: true,
        takePct: '30',
      }),
  },
]
