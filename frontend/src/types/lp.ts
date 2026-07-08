// LP 매트릭스 / 북리스크 / 포지션 / 비용 인풋 타입.
// Rust realtime.src/model/lp.rs · backend/routers/lp.py 와 1:1 대응.

export interface HedgeRoute {
  kind:
    | 'pdf_basket'
    | 'stock_futures_intersect'
    | 'index_futures'
    | 'correlated_etf'
    | 'beta_hedge'
  // struct variant 필드들 — 첫 빌드 wire 2종(pdf_basket, stock_futures_intersect)에는 추가 필드 없음
  code?: string
  peer_code?: string
  hedge_code?: string
}

export interface FairValueCell {
  etf_code: string
  route: HedgeRoute
  fair_value: number
  net_fv_buy: number
  net_fv_sell: number
  edge_buy_bp: number
  edge_sell_bp: number
  inputs_age_ms: number
  inputs_covered_pct: number
  missing_components: string[]
  usable: boolean
  computed_at_ms: number
}

export interface EtfFairValueSnapshot {
  etf_code: string
  etf_price: number
  cells: FairValueCell[]
  best_route_buy: number | null
  best_route_sell: number | null
  timestamp: string
}

export interface FairValueMatrixSnapshot {
  snapshots: EtfFairValueSnapshot[]
  timestamp: string
}

export interface PnLBreakdown {
  spread: number
  inventory: number
  hedge_cost: number
  basis: number
}

// ---- 헤지 티켓 (§13.3-B) — realtime/src/model/lp.rs HedgeTicket 과 1:1 ----

export interface HedgeLeg {
  /** 실제 front-month 지수선물 코드 (A+8자리). */
  code: string
  /** 표시용 이름 ("KOSPI200 선물" / "KOSPI200 미니선물" / "KOSDAQ150 선물"). */
  name: string
  side: 'buy' | 'sell'
  /** 계약 수 (양수). */
  contracts: number
}

export interface HedgeTicket {
  family: string // "k200" | "kq150"
  /** ETF·현물 재고에서 나온 가족 델타 (원). */
  net_delta_krw: number
  /** 기존 지수선물이 이미 제공하는 델타 (원, 부호 有). */
  existing_futures_delta_krw: number
  /** 티켓 전 총 잔여 델타 = net + existing. */
  residual_delta_krw: number
  /** 잔여를 상쇄하는 계약 지시. 비어 있으면 "헤지 불필요". */
  ticket: HedgeLeg[]
  /** 티켓 후 남는 델타 (원, 미니 라운딩 잔차). */
  rounding_residual_krw: number
  futures_price_age_ms: number
  usable: boolean
  reason: string
}

// ---- 베이시스 북 (§13.4 Phase 4) — realtime/src/model/lp.rs 와 1:1 ----

export interface StockBasisPair {
  base_code: string
  name: string
  /** 현물 순 수량 (부호 有, 주). */
  spot_qty: number
  fut_code: string
  /** 주식선물 순 수량 (부호 有, 주환산). */
  fut_qty: number
  /** 겹침 주수 (양수). */
  matched_shares: number
  /** 부호 적용 겹침 (= sign(spot)×matched). convergence_pnl 부호원. */
  matched_signed_shares: number
  spot_price: number
  fut_price: number
  /** 진입 베이시스 (주당 원). 없으면 null. */
  entry_basis: number | null
  /** 실측 베이시스 = 선물가 − 현물가. */
  basis_now: number
  basis_theory: number
  excess_now: number
  /** 수렴 손익 (원) = (entry − now) × matched_signed. 진입 없으면 null. */
  convergence_pnl: number | null
  /** 겹침 명목 (원) = matched_shares × spot_price. */
  matched_notional_krw: number
  /** 실보유 계약(front/back)의 만기 D-day. expiry_known=false면 무의미(0). */
  days_to_expiry: number
  /** 만기 확인 여부 — futures_master에 계약 코드 없으면 false (만기 미상). */
  expiry_known: boolean
  /** 현재 베이시스의 연환산 bp. */
  annualized_bp: number
  /** 만기 D-5 이내 (현금결제 — 현물 leg 처리 필요). 만기 미상이면 false. */
  expiry_action_needed: boolean
  usable: boolean
  reason: string
}

export interface IndexBasisExposure {
  family: string // "k200" | "kq150"
  /** 지수형 ETF 지수 환산 델타 합 (부호 有, 원) = Σ 노출 × L. */
  etf_leg_krw: number
  /** 지수선물 오버레이 델타 (부호 有, 원). */
  fut_leg_krw: number
  /** 매칭된 베이시스 크기 (부호 有 — 양수=베이시스 롱). */
  net_basis_notional_krw: number
  /** 베이시스 10bp당 손익 (원). */
  sensitivity_per_10bp_krw: number
  days_to_expiry: number
  /** front month D-2 이내 → 롤 필요. */
  roll_needed: boolean
  futures_code: string
}

export interface BasisBookSnapshot {
  /** ① 방향 델타 (원) — 오버레이 후 잔여. */
  directional_delta_krw: number
  /** ② 지수 베이시스 (가족별). */
  index_basis: IndexBasisExposure[]
  /** ③ 종목 베이시스 페어. */
  stock_basis: StockBasisPair[]
  /** ③ 종목 베이시스 총 명목 (원). */
  stock_basis_total_krw: number
  /** ④ 잔차위험 1σ (원). */
  residual_risk_krw: number
  /** 만기 액션 필요 (종목 D-5 또는 지수 D-2). */
  any_expiry_action: boolean
  timestamp: string
}

// ---- P&L 5분해 + markout + 한도 (§13.3-C Phase 4 PR-E) — realtime/src/model/lp.rs 와 1:1 ----

export interface Unattributed {
  /** 스프레드 미귀속 fill 건수 (fv_at_fill 없음). */
  n: number
  /** 미귀속 fill 명목 합 (원, 크기). */
  notional_krw: number
}

export interface MarkoutStats {
  n_5m: number
  /** 5분 markout 평균 (bp). 음수 = 역선택. */
  avg_5m_bp: number
  n_30m: number
  avg_30m_bp: number
}

export interface LimitGauge {
  name: string
  /** 현재값 (원, 크기). */
  current: number
  /** 한도 (원). 0이면 미설정. */
  limit: number
  /** 사용률 = current/limit. */
  ratio: number
  /** 부연 (최대 재고 ETF 코드 등). */
  detail: string
}

export interface PnlDecompSnapshot {
  as_of: string
  /** 당일 북 MTM 총변화 (원, 전일 종가 대비). */
  total_mtm: number
  /** 스프레드 수익 (원) = Σ (fv_at_fill − fill_price) × signed_qty. */
  spread: number
  /** 베이시스 손익 — 종목 수렴손익 합 (원). */
  basis_stock: number
  /** 지수 베이시스 손익 상태 (v1 산출 불가 — 정직 표기). */
  basis_index_status: string
  /** 잔차/방향 손익 (원) — total − 나머지 역산 (완전 분해). */
  residual_directional: number
  /** 캐리 (원, 음수=비용). */
  carry: number
  /** 헤지 비용 (원, 음수). */
  hedge_cost: number
  unattributed: Unattributed
  markout: MarkoutStats
  /** 리스크 한도 4개 (§13.3-C). */
  limits: LimitGauge[]
  usable: boolean
  caveats: string[]
}

export interface BookRiskSnapshot {
  beta_adj_delta_krw: number
  gross_delta_krw: number
  residual_risk_krw: number
  delta_by_index: Record<string, number>
  sector_exposures: Record<string, number>
  top_residual_contributors: Array<[string, number]>
  pnl_today: PnLBreakdown | null
  unmapped_positions: Array<[string, number]>
  /** 가족별 헤지 티켓 (§13.3-B). */
  hedge_tickets: HedgeTicket[]
  timestamp: string
}

// ---- 베이시스 실행 라우터 (§13.4) — realtime/src/calc/basis_route.rs 와 1:1 ----

export interface BasisFuturesInfo {
  code: string
  name: string
  price: number
  expiry: string // YYYYMMDD
  days_left: number
  multiplier: number
}

export interface BasisRouteResponse {
  code: string
  input_code: string
  side: string
  qty: number
  spot_price: number
  futures: BasisFuturesInfo | null
  basis_now: number
  basis_theory: number
  excess_basis: number
  excess_bp: number
  verdict: 'futures' | 'spot' | 'no_futures' | 'stale' | 'no_data'
  verdict_reason: string
  qty_futures_contracts: number
  qty_futures_residual_shares: number
  inputs_age_ms: number
}

export interface LpCostInputs {
  tax_sell_bp: number
  base_rate_annual: number
  slippage_bp: number
  hold_days: number
}

export interface LpPositionsPayload {
  positions: Record<string, number>
  updated_at?: string | null
}

// ---- 북 원장 (§13.5 Phase 1) — backend/services/lp_ledger.py 와 1:1 ----

export type LedgerInstrument = 'etf' | 'stock' | 'index_fut' | 'stock_fut'
export type LedgerKind = 'carryover' | 'fill'
export type LedgerSide = 'buy' | 'sell'

export interface LedgerEntry {
  id: string
  ts: string
  code: string
  instrument: LedgerInstrument
  kind: LedgerKind
  side: LedgerSide
  qty: number
  price: number | null
  note: string | null
  /** 진입 베이시스 (선물가 − 현물가, 주당 원). §13.4 베이시스 대체 기장 leg에만. */
  entry_basis?: number | null
  /** 체결 시점 FV_futures 스냅샷 (§13.3-C 스프레드 귀속). ETF 유니버스 fill만. */
  fv_at_fill?: number | null
  /** 체결 시점 현재가(mid) 스냅샷. */
  mid_at_fill?: number | null
  name?: string | null
}

export interface LedgerAggregate {
  code: string
  name: string | null
  instrument: LedgerInstrument
  carryover_qty: number
  fills_qty: number
  fills_qty_today: number
  net_qty: number
  avg_price: number | null
  /** 진입 베이시스 qty 가중 평균 (주당 원). 없으면 null. */
  entry_basis?: number | null
  /** 주식선물 → 기초 종목 6자리 (베이시스 페어 태그용). 그 외 null/미제공. */
  base_code?: string | null
}

export interface LedgerSnapshot {
  entries: LedgerEntry[]
  aggregates: LedgerAggregate[]
  updated_at: string | null
}

/** 자산유형 그룹 표시 순서/라벨 */
export const LEDGER_GROUPS: Array<{ instrument: LedgerInstrument; label: string }> = [
  { instrument: 'etf', label: 'ETF 재고' },
  { instrument: 'index_fut', label: '지수선물 오버레이' },
  { instrument: 'stock_fut', label: '주식선물' },
  { instrument: 'stock', label: '현물' },
]

// ---- 원장 엑셀 업로드 (회사 원장 → 반영) — backend/services/ledger_import.py 와 1:1 ----

export interface ImportFill {
  side: LedgerSide
  qty: number
  price: number | null
  source: string
}

export interface ImportPosition {
  code: string
  name: string | null
  instrument: LedgerInstrument
  /** 이월 수량 (부호). */
  carryover_qty: number
  prev_book_signed: number
  /** 반영 후 원장 보드와 동일 산식(blended VWAP)으로 시뮬레이션한 평단. */
  avg_price: number | null
  /** 이월 행에 기록될 평단 (이월 가중 평균). */
  carryover_avg_price: number | null
  fills: ImportFill[]
  /** 당일 체결 부호합. */
  fills_qty_today: number
  /** 반영될 순 수량 (= 경제적 당일 장부). */
  net_qty: number
  sources: string[]
  reconciled: boolean
  recon_detail: string | null
  /** 선물 계약→주수 환산 명세 ("A1167000: 3,000계약 → 30,000주"). */
  conversion_note: string | null
}

export interface ImportFileInfo {
  filename: string
  screen: string // '3454' | '2514' | '5264' | 'duplicate' | 'unknown' | 'error'
  fund_types: string[]
  parsed_rows: number
  error?: string
  /** 정보성 비고 (중복 파일 무시 등 — 에러 아님). */
  note?: string
}

export interface ImportExcluded {
  code: string
  name: string | null
  source: string
  reason: string
}

export interface ImportWarning {
  type: 'reconcile' | 'collateral_negative' | 'duplicate_file' | 'set_mix'
  code: string
  name: string | null
  source: string
  detail: string
}

export interface ImportRemoved {
  code: string
  name: string | null
  instrument: LedgerInstrument
  net_qty: number
}

export interface ImportSummary {
  n_positions: number
  n_fills: number
  n_excluded: number
  n_warnings: number
  n_reconcile_warnings: number
  n_collateral_warnings: number
  n_conversions: number
  n_files_ok: number
  n_files_error: number
  /** 내용 동일(SHA-256)로 무시된 중복 파일 수. */
  n_files_duplicate: number
}

export interface LedgerImportResult {
  dry_run: boolean
  futures_unit: 'contracts' | 'shares'
  replace_all: boolean
  files: ImportFileInfo[]
  positions: ImportPosition[]
  excluded: ImportExcluded[]
  warnings: ImportWarning[]
  summary: ImportSummary
  removed: ImportRemoved[]
  applied?: { carryover: number; fills: number; codes: number }
  updated_at?: string | null
}

// ---- 호가 보드 (§13.3-A Phase 2 PR-B/PR-C) — realtime/src/model/lp.rs QuoteRow 와 1:1 ----

export interface QuoteComponents {
  /** 기본 반스프레드 (bp) */
  base: number
  /** 역선택 버퍼 (bp) */
  buffer: number
  /** 잔차위험 charge (bp, 섹터형만 >0) */
  residual: number
  /** 재고 skew (bp, 부호 有: 롱 재고 → 음수 → 예약가격 하향) */
  skew: number
  /** 헤지 비용 (bp, 정보용 — 호가 가격엔 미반영) */
  hedge_cost: number
}

export interface QuoteRow {
  code: string
  name: string
  /** ETF 현재가 (틱). 0이면 결측. */
  price: number
  /** FV_futures 호가 앵커. no_quote면 0 가능. */
  fv_futures: number
  fv_mode: 'index' | 'beta'
  /** 소속 지수 가족: "k200" | "kq150" */
  index_family: string
  /** 함축 지수 수익률 (직전 지수 종가 대비, 소수) */
  r_implied: number
  /** 지수선물에서 캐리 역산한 함축 현물지수 */
  implied_index_spot: number
  futures_code: string
  futures_theory_price?: number | null
  /** 매수 호가까지 요구 엣지 (bp) = base+buffer+residual − skew */
  edge_bid_bp: number
  /** 매도 호가까지 요구 엣지 (bp) = base+buffer+residual + skew */
  edge_ask_bp: number
  /** 재고 skew (bp, 부호 有) — components.skew와 동일, 상단 요약용 */
  skew_bp: number
  components: QuoteComponents
  /** 제안 매수/매도 호가 (호가단위 rounding). no_quote면 0. */
  suggested_bid: number
  suggested_ask: number
  /** 제안 수량 (주) — v1은 재고 한도 잔여 기준 */
  suggested_size: number
  size_basis: string
  /** 재고 한도 잔여 (원) */
  inventory_remaining_krw: number
  /** 입력(지수선물/ETF틱) 중 가장 오래된 나이 (ms) */
  inputs_age_ms: number
  usable: boolean
  /** 불가 사유 (usable=false일 때). 빈 문자열이면 usable. */
  no_quote_reason: string

  // ── MID 기반 보강 + 차익 프레이밍 (§13.13). 구 Rust 호환 위해 전부 optional. ──
  /** 갭·차익 기준가 (mid fresh면 mid, 아니면 last). 0이면 결측. */
  ref_price?: number
  /** 기준가 소스 배지. */
  price_source?: 'mid' | 'last' | 'none'
  /** 최우선 매수호가 (0=미수신). */
  best_bid?: number
  /** 최우선 매도호가 (0=미수신). */
  best_ask?: number
  /** 갭 (bp) = (ref_price − FV)/FV × 1e4. 음수=저평가(매수차). 서버 산출(mid 반영). */
  gap_bp?: number
  /** 차익 방향: buy(매수차·저평가) | sell(매도차·고평가) | none. */
  arb_side?: 'buy' | 'sell' | 'none'
  /** 그 방향 요구 엣지 (bp) — buy=edge_bid_bp, sell=edge_ask_bp. */
  arb_edge_bp?: number
  /** 진입선 도달률 (%) = |gap_bp| / arb_edge_bp × 100. */
  reach_pct?: number
  /** 진입선 도달 (reach_pct ≥ 100) — 행 하이라이트. */
  at_entry?: boolean
}

export interface QuoteBoardSnapshot {
  rows: QuoteRow[]
  timestamp: string
}

/** 호가 제안 파라미터 (§13.3-A) — backend GET/POST /api/lp/quote-params 와 1:1. 전 필드 ge=0. */
export interface QuoteParams {
  base_spread_bp: number
  gamma: number
  adverse_buffer_bp: number
  hedge_cost_bp: number
  per_etf_inventory_limit_krw: number
  inventory_limit_overrides: Record<string, number>
  max_futures_contracts: number
  /** 베이시스 라우터(§13.4) 선물 대체 임계 (bp). */
  basis_threshold_bp: number
  // ── §13.3-C P&L·리스크 한도 (Phase 4 PR-E) ──
  /** 선물 체결 수수료 (bp × 명목) — 헤지비용 분해 v1. */
  futures_fee_bp: number
  /** 베이시스 일변동성 근사 (bp) — 베이시스 VaR 조잡 상수. */
  basis_vol_bp_daily: number
  /** 북 순 베타델타 한도 (오버레이 후, 원). */
  limit_net_delta_krw: number
  /** 잔차위험 1σ 총량 한도 (원). */
  limit_residual_krw: number
  /** 베이시스 VaR 한도 (원). */
  limit_basis_var_krw: number
  // ── §13.3-D 출구 (Phase 5) ──
  /** 설정/환매 AP 수수료 (bp × CU 명목) — 출구 3 비교용. */
  cu_fee_bp: number
}

export const DEFAULT_QUOTE_PARAMS: QuoteParams = {
  base_spread_bp: 5,
  gamma: 1,
  adverse_buffer_bp: 3,
  hedge_cost_bp: 2,
  per_etf_inventory_limit_krw: 1_000_000_000,
  inventory_limit_overrides: {},
  max_futures_contracts: 100,
  basis_threshold_bp: 5,
  futures_fee_bp: 0.3,
  basis_vol_bp_daily: 15,
  limit_net_delta_krw: 2_000_000_000,
  limit_residual_krw: 100_000_000,
  limit_basis_var_krw: 200_000_000,
  cu_fee_bp: 2,
}

// ---- 넷팅 바스켓 빌더 (§13.3-D 출구 Phase 5) — backend/services/lp_netting.py 와 1:1 ----

export interface NettingLeg {
  code: string
  name: string | null
  side: 'buy' | 'sell'
  /** 순 주문 주수 (양수). */
  shares: number
  /** 예상 대금 (원). 가격 결측이면 null. */
  est_notional: number | null
  /** |주문주수| / ADV20(20일 평균 거래량) × 100 (%). 결측이면 null. */
  adv_ratio: number | null
  /** adv_ratio > adv_cap_pct 이면 true (실현성 경고). */
  adv_capped: boolean
  /** 거래세 (bp) — 매도 leg만 >0. */
  tax_bp: number
  /** 주식선물 상장 종목 여부 (베이시스 라우터 연계 배지). */
  has_stock_future: boolean
}

export interface NettingExcluded {
  etf_code: string
  name: string | null
  reason: string
}

export interface NettingEtfHolding {
  code: string
  name: string | null
  net_qty: number
  cu_unit: number | null
  /** net_qty / cu_unit (부호 有 실수). */
  units_exact: number | null
  /** |net_qty| // cu_unit — 완전한 CU 개수 (설정/환매 출구). */
  cu_count: number
  price: number | null
  notional: number | null
  futures_based: boolean
  /** 넷팅 바스켓 leg에 반영됐는지 (futures_based·PDF/CU 결측이면 false). */
  basket_eligible: boolean
}

export interface NettingTotals {
  n_legs: number
  n_buy: number
  n_sell: number
  buy_notional: number
  sell_notional: number
  gross_notional: number
  /** buy − sell (+면 순매수 = 현금 유출). */
  net_notional: number
  est_tax_krw: number
  n_adv_capped: number
}

export interface NettingBasketResponse {
  legs: NettingLeg[]
  /** 현금분 순합 (원). */
  cash_residual: number
  excluded: NettingExcluded[]
  etf_holdings: NettingEtfHolding[]
  /** 재고 총 명목 (전 ETF, 원). */
  inventory_notional_krw: number
  totals: NettingTotals
  /** ADV 임팩트 캡 임계 (%). */
  adv_cap_pct: number
  caveats: string[]
  n_etfs_held: number
}

// ---- 지수 베이시스 z-score 모니터 (§13.3-D Phase 5) — GET /api/lp/basis-zscore 와 1:1 ----

export interface BasisZFamily {
  underlying: string // '01' | '06'
  n: number
  window: number
  /** 이론 베이시스 금리 (cost_inputs base_rate_annual, 소수). */
  r_annual: number
  /** 현재 front 월물 만기 잔존일. */
  days_to_expiry: number
  /** 만기 정규화 excess(베이시스 − spot×r×잔존일/365) 60일 분포의 mean. */
  mean: number | null
  std: number | null
  min: number | null
  max: number | null
  asof: string | null
  /** 프론트가 넘긴 실시간 raw 베이시스 (선물가 − 기초지수). */
  current: number | null
  /** 현재 이론 베이시스 (spot × r × 잔존일/365). */
  theory_now: number | null
  /** 현재 excess = current − theory_now. z의 대상. */
  current_excess: number | null
  /** (current_excess − mean) / std. 산출 불가 시 null. */
  z: number | null
}

export interface BasisZscoreResponse {
  /** 'k200' | 'kq150' → 분포·z. */
  families: Record<string, BasisZFamily>
  caveat: string
}

// ---- 헤지 정합 보드 (§13.12) — backend/services/hedge_recon.py 와 1:1 ----

/** macro_offset = 주문 0(net 커버)이지만 |gapδ|가 임계 초과 — 상쇄 뒤 숨은 스프레드 리스크 (H2). */
export type HedgeReconClass = 'aligned_spot' | 'alt_hedge' | 'macro' | 'macro_offset' | 'unexplained'

export interface HedgeReconStock {
  code: string
  name: string | null
  /** 요구 헤지 수량 (부호 有, 주) = −Σ units_signed×pdf_shares. 롱 ETF는 음수(숏 필요). */
  required: number
  /** 실제 헤지 = 현물 + 주식선물 (부호 有, 주). */
  actual: number
  actual_spot: number
  actual_stockfut: number
  /** gap = actual − required = 남은 순 방향 노출 (주). */
  gap: number
  /** gap × price × β (원). 가격 결측이면 null. */
  gap_delta_krw: number | null
  family: string
  tolerance: number
  price: number | null
  adv20_vol: number | null
  has_stock_future: boolean
  classification: HedgeReconClass
  /** 리밸런싱 주문 (미설명만). */
  order_side: 'buy' | 'sell' | null
  order_shares: number
  order_notional: number | null
  adv_ratio: number | null
  adv_capped: boolean
}

export interface HedgeReconIndexRouteEtf {
  code: string
  name: string | null
  net_qty: number
  family: string
  /** 부호 있는 배수 (+1/+2/−1/−2). 섹터형은 null. */
  leverage: number | null
  price: number | null
  /** 요구 델타 (원, 부호 有) = net_qty × price × L. 지수선물로만 헤지. */
  required_delta_krw: number | null
  reason: string
}

export interface HedgeReconEtfContribution {
  etf_code: string
  name: string | null
  /** 이 ETF가 해당 종목 required에 기여한 주수 (부호 有). */
  contribution: number
}

export interface HedgeReconIndexFutPosition {
  code: string
  name: string | null
  net_qty: number
  mult: number
}

export interface HedgeReconFamily {
  family: string
  /** 미정합 gap 델타(K200 풀) + 지수선물경로 ETF 델타 (부호 有 원, net). */
  needed_delta_krw: number
  /** Σ|gapδ| — 부호 넷팅 은닉 방지 병기 (H2). */
  gross_delta_krw: number
  /** 원장 지수선물 오버레이 델타 (부호 有 원). */
  index_fut_delta_krw: number
  /** 반대 방향 선물이 커버한 크기 = min(|fut|,|needed|) (원). */
  explained_delta_krw: number
  /** 종목 리밸런싱 몫 = needed×(1−cov) (부호 有 원). */
  unexplained_delta_krw: number
  /** 선물 초과/동방향 잔여 = (needed+fut) − unexplained (부호 有 원) — 헤지 티켓 몫. */
  futures_excess_krw: number
  /** min(|fut|,|needed|)/|needed| — 반대 방향 선물만, fut에 단조 (H1). */
  coverage_ratio: number
  /** gross > 3×|net| & gross > offset_warn — 종목 간 상쇄 큼 (잔차 위험 잔존). */
  offset_warning: boolean
  index_fut_positions: HedgeReconIndexFutPosition[]
}

export interface HedgeReconSummary {
  n_stocks: number
  n_aligned_spot: number
  n_alt_hedge: number
  n_macro: number
  /** 매크로(상쇄) — 주문 0이지만 |gapδ| 임계 초과 (H2). */
  n_macro_offset: number
  n_unexplained: number
  /** 가족별 미설명(종목 몫) 델타 (부호 有 원). */
  unexplained_delta_by_family: Record<string, number>
  /** Σ |가족 미설명| (원, 크기). */
  unexplained_delta_total: number
  /** 가족별 선물 초과 델타 (부호 有 원) — 티켓 몫. */
  futures_excess_by_family: Record<string, number>
  futures_excess_total: number
  n_rebalance_orders: number
  rebalance_gross_notional: number
  n_adv_capped: number
  /** 미설명 0종목 + 미설명·선물초과 δ < 100만원. */
  fully_aligned: boolean
}

export interface HedgeReconOrder {
  code: string
  name: string | null
  side: 'buy' | 'sell'
  shares: number
  est_notional: number | null
  adv_ratio: number | null
  adv_capped: boolean
  has_stock_future: boolean
}

export interface HedgeReconResponse {
  as_of: string | null
  stocks: HedgeReconStock[]
  index_route_etfs: HedgeReconIndexRouteEtf[]
  /** 종목 → 기여 ETF 목록 (롤업). */
  etf_rollup: Record<string, HedgeReconEtfContribution[]>
  families: Record<string, HedgeReconFamily>
  summary: HedgeReconSummary
  rebalance_orders: HedgeReconOrder[]
  tolerance_params: { abs_shares: number; pct: number; offset_warn_krw: number }
  adv_cap_pct: number
  n_etfs_held: number
  n_etfs_convertible: number
  n_etfs_index_route: number
  caveats: string[]
}

/** matrix-config quote_universe 항목 — 모드 뱃지(배수/β)·override 편집용 메타. QuoteRow엔 없는 정적 입력. */
export interface QuoteUniverseMeta {
  code: string
  name: string | null
  index_family: string | null
  /** 부호 있는 일일 배수 (+1/+2/-1/-2). 섹터형은 null. */
  leverage: number | null
  fv_mode: 'index' | 'beta'
  /** 섹터형 베타 (KOSPI200 60일 OLS). */
  beta: number | null
}

/** UI에 표시할 5개 헤지 경로 컬럼 순서. ③은 PR-B(FV_futures)에서 wire됨. ④⑤는 빈 셀(placeholder). */
export const HEDGE_ROUTE_COLUMNS: Array<{
  kind: HedgeRoute['kind']
  label: string
  wiredInFirstBuild: boolean
}> = [
  { kind: 'pdf_basket', label: 'PDF 바스켓', wiredInFirstBuild: true },
  { kind: 'stock_futures_intersect', label: '∩ 주식선물', wiredInFirstBuild: true },
  { kind: 'index_futures', label: '지수선물', wiredInFirstBuild: true },
  { kind: 'correlated_etf', label: '상관 ETF', wiredInFirstBuild: false },
  { kind: 'beta_hedge', label: '베타 헤지', wiredInFirstBuild: false },
]
