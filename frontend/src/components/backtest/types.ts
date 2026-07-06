/**
 * 백테스팅 탭 — API 계약 타입 (정본: backend/services/backtest/schema.py · engine.py).
 * 프론트는 이 shape를 포맷팅만 한다 (지표 재계산 금지 — 부검 원칙).
 */

// ── 카탈로그 (GET /api/backtest/catalog) ────────────────────────────────────
export type Op =
  | '>'
  | '>='
  | '<'
  | '<='
  | '=='
  | 'is_true'
  | 'is_false'
  | 'rank_pct_top'
  | 'rank_pct_bottom'

export type Benchmark = 'universe_avg' | 'kospi' | 'kosdaq' | 'none'
export type PortfolioMode = 'event_study' | 'portfolio'

export type CatalogMetric = {
  key: string // 예: "price.ret_20d" / "flow.tag.장기동시"
  column: string
  label: string
  unit: string // "원" | "억" | "%" | "bp" | "bool"
  desc: string
  available_from: string // "YYYY-MM-DD"
}

export type PanelMeta = {
  period: { start: string; end: string }
  n_stocks: number
  n_rows: number
  built_at: string
  build_secs: number
}

export type Catalog = {
  namespaces: string[]
  metrics: CatalogMetric[]
  operators: Op[]
  panel_meta: PanelMeta | null
  notes: {
    cost_bps_default: number
    portfolio_modes: string[]
    benchmarks: string[]
    max_positions_default?: number
  }
}

// ── 전략 JSON (POST /api/backtest/run) ──────────────────────────────────────
export type Condition = {
  field: string
  op: Op
  value?: number
  ref?: string
  mult?: number
}

// 1-depth 중첩: 그룹 안의 원소는 Condition 또는 (리프만 가진) 하위 그룹.
export type Group = { all?: Array<Condition | Group>; any?: Array<Condition | Group> }

export type ExitRule =
  | { type: 'fixed_holding'; days: number }
  | { type: 'stop_loss_pct'; value: number }
  | { type: 'take_profit_pct'; value: number }
  | { type: 'condition'; all?: Condition[]; any?: Condition[] }

export type Market = 'KOSPI' | 'KOSDAQ' | 'ETF'

export type Strategy = {
  name: string
  universe: {
    markets: Market[]
    min_adv_eok: number
    min_mcap_eok: number
  }
  entry: Group
  execution: {
    entry_fill: 'next_open' | 'next_close' | 'same_close'
    exit_fill: 'next_open' | 'next_close' | 'same_close'
    cost_bps: number
  }
  exit: { rules: ExitRule[] }
  portfolio: {
    mode: PortfolioMode
    max_positions?: number
    weighting?: 'equal'
    rank_by?: string | null
    // ADV 체결 가능량 캡 (portfolio 전용) — 둘 다 있어야 활성 (한쪽만이면 백엔드 422).
    capital_eok?: number | null
    adv_cap_pct?: number | null
  }
  benchmark: Benchmark
  period: { start: string | null; end: string | null }
}

// ── 결과 (GET /api/backtest/jobs/{id}) ──────────────────────────────────────
export type Episode = {
  stock: string
  onset_date: string
  entry_date: string
  exit_date: string
  exit_reason: string
  holding_days: number
  ret_pct: number
  excess_pct: number | null
  ongoing: boolean
}

export type Summary = {
  n_episodes: number
  n_with_excess: number
  avg_excess_pct: number | null
  median_excess_pct: number | null
  avg_return_pct: number | null
  win_rate: number | null
  t_value: number | null
  avg_holding_days: number | null
  exit_reason_breakdown: Record<string, number>
  by_year_avg_excess: Record<string, number | null>
  by_month_avg_excess: Record<string, number | null>
}

// ── holdout 잠금 (meta.holdout — engine._attach_holdout) ─────────────────────
// 구간별 이벤트 스터디 스탯 (개봉 시 train/holdout 분리).
export type HoldoutEventStat = {
  n_episodes: number
  n_with_excess: number
  avg_excess_pct: number | null
  median_excess_pct: number | null
  t_value: number | null
}
// 구간별 포트폴리오 수익 (개봉 시, portfolio 모드에서만).
export type HoldoutPortfolioSeg = { return_pct: number | null; days: number }

export type Holdout =
  | { start: string; locked: true } // 기본 — train-only 캡, 최근 구간 잠김
  | {
      start: string
      locked: false // 개봉됨 — 전체 기간 + 구간 분리 스탯
      event_study: { train: HoldoutEventStat; holdout: HoldoutEventStat }
      portfolio?: { train: HoldoutPortfolioSeg | null; holdout: HoldoutPortfolioSeg | null }
    }

export type ResultMeta = {
  panel_versions: Record<string, string>
  panel_meta: PanelMeta
  period: { start: string; end: string }
  universe: {
    markets: string[]
    min_adv_eok: number
    min_mcap_eok: number
    n_stocks: number
  }
  benchmark: string
  lookahead_warning: boolean
  stock_names?: Record<string, string>
  holdout?: Holdout
}

// 다중검정 카운터 (jobs.py가 결과에 주입).
export type Attempts = { same_spec: number; total_runs: number }

// 포트폴리오 에쿼티 커브 1점 (lightweight-charts용). benchmark=none이면 benchmark 없음.
export type EquityPoint = { date: string; equity: number; benchmark?: number | null }

// 연도별 수익 (전략/벤치마크/초과).
export type PortfolioYear = {
  year: string
  strategy_pct: number
  benchmark_pct?: number | null
  excess_pct?: number | null
}

// ADV 체결 가능량 캡 결과 (활성 시에만 — engine_portfolio._simulate).
export type AdvCap = {
  capital_eok: number
  adv_cap_pct: number
  capped_entries: number
  avg_fill_ratio: number | null // %
}

// portfolio 모드 결과 블록 (engine_portfolio._simulate).
export type PortfolioResult = {
  n_slots: number
  n_candidate_signals: number
  n_entered: number
  missed_signals: number
  dup_skipped: number
  rank_by: string | null
  start_date: string | null
  end_date: string | null
  n_days: number
  final_equity: number
  total_return_pct: number
  cagr_pct: number | null
  mdd_pct: number
  mdd_peak_date: string | null
  mdd_trough_date: string | null
  sharpe: number | null
  annual_turnover: number | null
  avg_positions: number
  by_year: PortfolioYear[]
  equity_curve: EquityPoint[]
  adv_cap?: AdvCap
}

export type BacktestResult = {
  summary: Summary
  episodes: Episode[]
  warnings: string[]
  meta: ResultMeta
  mode?: PortfolioMode
  attempts?: Attempts
  portfolio?: PortfolioResult
}

// ── 저장 전략 (GET /api/backtest/strategies) ────────────────────────────────
export type StrategyRecord = {
  id: string
  name: string
  spec: Strategy | null
  created_at: number
  updated_at: number
  // holdout 개봉 상태 (store.py) — 개봉 시각(ms)·개봉 시점 spec 해시. null=미개봉.
  holdout_unlocked_at?: number | null
  holdout_spec_hash?: string | null
}

// ── 실행 이력 (GET /api/backtest/runs) ──────────────────────────────────────
export type RunSummaryHead = {
  n_episodes: number | null
  avg_excess_pct: number | null
  t_value: number | null
  cagr_pct: number | null
  mdd_pct: number | null
  mode: PortfolioMode | null
} | null

export type RunRecord = {
  id: string
  strategy_id: string | null
  spec_hash: string
  panel_version: string | null
  started_at: number
  finished_at: number | null
  status: string
  summary_head: RunSummaryHead
}

export type JobStatus = {
  job_id: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  result?: BacktestResult
  error?: string
}

// POST /run 422 필드 에러 (pydantic errors 또는 커스텀 필드 에러)
export type FieldError = { loc?: (string | number)[]; field?: string; msg: string }

// ── 청산 사유 라벨 ──────────────────────────────────────────────────────────
export const REASON_LABEL: Record<string, string> = {
  fixed_holding: '고정 만기',
  condition: '조건 청산',
  stop_loss_pct: '손절',
  take_profit_pct: '익절',
  ongoing: '보유중',
}
