/** 좌 빌더의 편집 상태 ↔ 전략 JSON. 프리셋 정의 포함. */
import {
  type CatalogIndex,
  type EditCond,
  blankCond,
  fromCondition,
  toCondition,
} from './catalog'
import type { Benchmark, Condition, ExitRule, Group, PortfolioMode, Strategy } from './types'

export type BuilderState = {
  name: string
  markets: { KOSPI: boolean; KOSDAQ: boolean; ETF: boolean }
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
  // 모드·자본 (portfolio 전용 필드는 event_study에선 무시)
  mode: PortfolioMode
  maxPositions: string
  rankBy: string // '' = 없음(선착순)
  // ADV 체결 캡 (portfolio 전용) — 둘 다 채워야 활성, 한쪽만이면 클라 검증 에러(백엔드 422 정합)
  capitalEok: string // '' = 비활성
  advCapPct: string // '' = 비활성
  // 기간·벤치마크
  start: string
  end: string
  benchmark: Benchmark
}

export function defaultState(idx: CatalogIndex): BuilderState {
  return {
    name: 'untitled',
    markets: { KOSPI: true, KOSDAQ: true, ETF: false },
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
    mode: 'event_study',
    maxPositions: '20',
    rankBy: '',
    capitalEok: '',
    advCapPct: '',
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
  const markets = (['KOSPI', 'KOSDAQ', 'ETF'] as const).filter((m) => s.markets[m])
  if (!markets.length) errors.push('시장(KOSPI/KOSDAQ/ETF)을 최소 1개 선택하세요.')

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

  // 포트폴리오 파라미터
  let maxPos = 20
  let capitalEok: number | null = null
  let advCapPct: number | null = null
  if (s.mode === 'portfolio') {
    const mp = parseInt(s.maxPositions, 10)
    if (!Number.isFinite(mp) || mp < 1) errors.push('최대 보유 종목수는 1 이상이어야 합니다.')
    else maxPos = mp

    // ADV 체결 캡 — 자본(억)과 캡 %는 둘 다 채우거나 둘 다 비우거나 (백엔드 422 both-or-neither).
    const capRaw = s.capitalEok.trim()
    const pctRaw = s.advCapPct.trim()
    if (capRaw !== '' || pctRaw !== '') {
      if (capRaw === '' || pctRaw === '') {
        errors.push('ADV 체결 캡은 자본(억)과 캡 %를 함께 입력하세요 (한쪽만 입력 불가).')
      } else {
        const cap = Number(capRaw)
        const pct = Number(pctRaw)
        if (!Number.isFinite(cap) || cap <= 0) errors.push('자본(억)은 양수여야 합니다.')
        else if (!Number.isFinite(pct) || pct <= 0 || pct > 100)
          errors.push('ADV 캡 %는 0 초과 100 이하여야 합니다.')
        else {
          capitalEok = cap
          advCapPct = pct
        }
      }
    }
  }

  if (errors.length || !entry) return { strategy: null, errors }

  const minAdv = Number(s.minAdv)
  const minMcap = Number(s.minMcap)
  const cost = Number(s.costBps)

  const portfolio: Strategy['portfolio'] =
    s.mode === 'portfolio'
      ? {
          mode: 'portfolio',
          max_positions: maxPos,
          weighting: 'equal',
          rank_by: s.rankBy || null,
          // 둘 다 유효할 때만 캡 필드 전송 (비활성이면 필드 자체를 넣지 않음 = 기존 경로 불변).
          ...(capitalEok != null && advCapPct != null
            ? { capital_eok: capitalEok, adv_cap_pct: advCapPct }
            : {}),
        }
      : { mode: 'event_study' }

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
    portfolio,
    benchmark: s.benchmark,
    period: { start: s.start || null, end: s.end || null },
  }
  return { strategy, errors: [] }
}

// ── 전략 JSON → 편집 상태 (저장 전략 로드용) ──────────────────────────────────
/** serialize의 역변환. 저장된 spec을 빌더에 채운다 (serialize 산출물 기준으로 견고, 그 외 degrade). */
export function stateFromStrategy(idx: CatalogIndex, spec: Strategy): BuilderState {
  const base = defaultState(idx)

  // 진입 트리: {all:[...conds, {any:[...]}?]} 또는 {any:[...]}.
  const andConds: EditCond[] = []
  const orConds: EditCond[] = []
  let orEnabled = false
  const collect = (items: Array<Condition | Group> | undefined, into: EditCond[]) => {
    for (const it of items ?? []) {
      if ('field' in it) into.push(fromCondition(it))
      else if (it.all) {
        // 중첩 AND 그룹 → 최상위 AND 리스트로 평탄화 (AND 결합법칙상 의미 동일).
        // OR 그룹으로 로드하면 재저장 시 AND→OR로 의미가 바뀐다 (손으로 쓴 중첩 spec 보호).
        collect(it.all, andConds)
      } else {
        // 중첩 OR 그룹만 OR 그룹으로 (serialize 산출물 형태)
        orEnabled = true
        collect(it.any, orConds)
      }
    }
  }
  if (spec.entry.all) collect(spec.entry.all, andConds)
  else if (spec.entry.any) {
    orEnabled = true
    collect(spec.entry.any, orConds)
  }

  // 청산 규칙 → 토글 (기본 전부 off 후 규칙별 on)
  let fixedEnabled = false
  let fixedDays = base.fixedDays
  let stopEnabled = false
  let stopPct = base.stopPct
  let takeEnabled = false
  let takePct = base.takePct
  let condExitEnabled = false
  let condExitMode: 'all' | 'any' = 'any'
  let condExitRows: EditCond[] = base.condExitRows
  for (const r of spec.exit.rules) {
    if (r.type === 'fixed_holding') {
      fixedEnabled = true
      fixedDays = String(r.days)
    } else if (r.type === 'stop_loss_pct') {
      stopEnabled = true
      stopPct = String(Math.abs(r.value))
    } else if (r.type === 'take_profit_pct') {
      takeEnabled = true
      takePct = String(Math.abs(r.value))
    } else if (r.type === 'condition') {
      condExitEnabled = true
      condExitMode = r.all ? 'all' : 'any'
      const leaves = (r.all ?? r.any ?? []).map((c) => fromCondition(c))
      condExitRows = leaves.length ? leaves : base.condExitRows
    }
  }

  const mode: PortfolioMode = spec.portfolio.mode === 'portfolio' ? 'portfolio' : 'event_study'

  return {
    ...base,
    name: spec.name || 'untitled',
    markets: {
      KOSPI: spec.universe.markets.includes('KOSPI'),
      KOSDAQ: spec.universe.markets.includes('KOSDAQ'),
      ETF: spec.universe.markets.includes('ETF'),
    },
    minAdv: String(spec.universe.min_adv_eok),
    minMcap: String(spec.universe.min_mcap_eok),
    andConds: andConds.length ? andConds : [],
    orEnabled,
    orConds: orConds.length ? orConds : base.orConds,
    entryFill: spec.execution.entry_fill,
    exitFill: spec.execution.exit_fill,
    costBps: String(spec.execution.cost_bps),
    fixedEnabled,
    fixedDays,
    stopEnabled,
    stopPct,
    takeEnabled,
    takePct,
    condExitEnabled,
    condExitMode,
    condExitRows,
    mode,
    maxPositions: String(spec.portfolio.max_positions ?? 20),
    rankBy: spec.portfolio.rank_by ?? '',
    capitalEok: spec.portfolio.capital_eok != null ? String(spec.portfolio.capital_eok) : '',
    advCapPct: spec.portfolio.adv_cap_pct != null ? String(spec.portfolio.adv_cap_pct) : '',
    start: spec.period.start ?? '',
    end: spec.period.end ?? '',
    benchmark: spec.benchmark,
  }
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
