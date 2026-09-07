/**
 * LP 데스크 (`/lp-desk`) API 타입 — lp-system-design.md §14.9 계약 (`/api/lp-desk`).
 *
 * lp-matrix(§13, `types/lp.ts`)와 완전 별개. 여기 타입은 이 화면 전용이며,
 * 서버가 아직 안 떠 있어도 화면이 죽지 않도록 통계 필드는 전부 nullable로 둔다
 * (표본부족 ETF는 서버가 null 또는 insufficient=true로 내려줌).
 */

/** 헤지 계약 — v1 집행 수단 2종. K200F(승수 25만)는 참고 표기만 하고 집행 대상 아님. */
export type HedgeContract = 'MK200' | 'KQ150F'

/** 계약 승수 (§14.4). 미니K200 5만 / KQ150F 1만. */
export const CONTRACT_MULTIPLIER: Record<HedgeContract, number> = {
  MK200: 50_000,
  KQ150F: 10_000,
}

export const CONTRACT_LABEL: Record<HedgeContract, string> = {
  MK200: '미니K200',
  KQ150F: 'KQ150F',
}

/**
 * 분위수 키 (§14.5 캘리브 층). 상방 3종 = 매도측, 하방 3종 = 매수측.
 * **호가 x는 더 이상 분위수가 아니다** (4차 보완 — μ±zσ). 분위수는 분포 참고 표시에만 쓴다.
 */
export type LpDeskQuantileKey = 'p05' | 'p10' | 'p25' | 'p75' | 'p90' | 'p95'

/**
 * s(선물 대비 스큐) 분포를 참고로 보여줄 때 쓰는 **고정** 분위수. 호가 노브가 z로 바뀌면서
 * 분위수 선택 튜너가 사라졌고, s는 잔차 감각용 표시라 양끝 p10/p90으로 고정한다.
 */
export const S_REF_BID: LpDeskQuantileKey = 'p10'
export const S_REF_ASK: LpDeskQuantileKey = 'p90'

/** 분위수 → bp 레벨 / 도달 일수. 표본 부족이면 서버가 블록 자체를 null로 준다. */
export type LpDeskQuantileMap = Partial<Record<LpDeskQuantileKey, number | null>> | null
export type LpDeskTouchMap = Partial<Record<LpDeskQuantileKey, number | null>> | null

/**
 * 인트라데이 캘리브레이션 (§14.5 배치 층). 최근 10거래일 30초봉 분포.
 *
 * **호가 x = `g_mean_bp` ± z·√(`g_sigma_level_bp`² + σ_r²)** (4차 보완 2026-08-21),
 * σ_r = `s_diff_sigma_bp[T]` — 지평 T(초)에서 **직접 측정**한 s 변화 σ (5차 보완, √T 환산 폐기).
 * g = (현재가 − 장중 재구성 NAV)/NAV [bp],
 * s = 선물 대비 스큐. 즉 **NAV 괴리 분포와 선물 괴리 분포를 결합한 폭**이다.
 * 분위수(`*_quantiles`)는 호가에서 빠지고 분포 참고 표시용으로만 남는다.
 *
 * `*_touch_days`는 분위수별 **도달 일수** — 창 일수 중 그 레벨이 한 번이라도 열린 날 수
 * (구 `touches`(클러스터 수/일)는 비단조라 폐기 — 2026-08-20, §14.11).
 * x는 분위수가 아니므로 서버가 미리 셀 수 없다 → `g_day_max`/`g_day_min`(일별 극값)을 받아
 * 프론트가 그 x 레벨의 도달 일수를 같은 정의로 센다.
 * 두 축의 표본 창이 다르므로 일수/봉수도 따로다: g = `g_days`/`g_bars`(09:10~15:20),
 * s = `days`/`bars`(11:26~15:20, 선물 봉 제약).
 * 둘 다 표본 부족이면 서버가 `calib: null`을 내려준다.
 */
export interface LpDeskCalib {
  /** g 분포 분위수 (raw 레벨) — 참고 표시용. */
  g_quantiles: LpDeskQuantileMap
  g_touch_days: LpDeskTouchMap
  g_days: number
  g_bars: number
  /**
   * 재구성 바스켓에서 **뺀 레그 수** (창 내 최대, §14.3). 창 전체에 30초봉이 없는 구성
   * (커버드콜 ETF의 옵션·선물 레그 등)은 제외하고 주식+현금만으로 g를 잰다 — 0이면 다른
   * ETF와 완전히 같은 정의고, >0이면 그 레그의 가치만큼 μ_g에 레벨 편차가 실린다.
   */
  excluded_legs?: number | null
  /** 호가 중심 μ_g — g의 pooled raw 평균 (bp). 표본 부족이면 null = 호가 없음. */
  g_mean_bp?: number | null
  /** σ_g — g의 pooled **레벨** σ (일중 demean 아님 — 날짜 간 레벨 이동 포함). */
  g_sigma_level_bp?: number | null
  /**
   * **σ_r 정본** — 지평(초) → 그 지평에서 직접 잰 s 변화의 pooled σ (bp). 키는 `"60"|"120"|"300"`
   * (서버 `calib_params.s_diff_horizons`). 비중첩 차분 표본이 300쌍 미만인 지평은 null.
   * ⚠️ 30초 σ에 √T를 곱하지 **않는다** — 실측 분산비 0.47(5분)/0.77(1분)로 랜덤워크가 기각됐다.
   */
  s_diff_sigma_bp?: Record<string, number | null> | null
  /** s의 **연속 30초봉 증분** σ (bp/30초). 호가에는 미사용 — √T 부풀림 대비 표시용 참고값. */
  s_inc_sigma_bp?: number | null
  /** 일별 g 극값 (len = g_days) — 임의 x 레벨의 도달 일수 산출용. */
  g_day_max?: (number | null)[] | null
  g_day_min?: (number | null)[] | null
  /** 선물 대비 스큐 s 분포 — 참고(잔차 리스크 감각). 레벨은 호가에 미사용. */
  s_quantiles: LpDeskQuantileMap
  touch_days: LpDeskTouchMap
  /** 장중 재구성 NAV 대비 괴리의 **일중**(일별 demean 후) 표준편차 — 흔들림 표시용. */
  g_sigma_bp: number | null
  days: number
  bars: number
}

export interface LpDeskCalibParams {
  calib_days: number
  bar_seconds: number
  session: string
  /** g(호가 x) 표본의 **실측** 시각 범위 (`"09:10~15:20"`). 선물이 필요 없어 하루 전체. */
  g_window?: string | null
  /** s 표본의 **실측** 시각 범위 (`"11:26~15:20"`). 선물 30초봉 적재 구간 제약 (§14.11). */
  s_window?: string | null
  /** σ_r을 직접 측정한 지평 목록(초) — 프론트 지평 선택지의 정본 (`[60,120,300]`). */
  s_diff_horizons?: number[] | null
  as_of: string
  built_at: string
  elapsed_ms: number
}

export interface LpDeskMasterItem {
  etf_code: string
  name: string
  /** 2-팩터 OLS β (§14.3). 표본부족이면 null. */
  beta_k200: number | null
  beta_kq150: number | null
  r2: number | null
  /** 잔차 변동성 (bp/일) — 헤더 잔차 한도 계산용 (호가 산출에는 미사용, §14.5 폐기). */
  resid_vol_bp: number | null
  /** 최근 잔차 z (창 내 표준화). */
  resid_z: number | null
  /**
   * 오버나이트 상한 (₩, §14.12) = 50만 ÷ (1.645 × 잔차σ) — 1박 5% 꼬리손실 기준, 백만 내림.
   * 금지 종목은 0, 회귀 표본 부족이면 null(= 산출 불가 — 금지와 다른 상태).
   */
  overnight_cap_won?: number | null
  /** 잔차σ > 250bp 또는 회귀 표본 60 미만 — 오버나이트 금지. */
  overnight_banned?: boolean
  /** 과거 괴리 분포 (§14.3, PDF 재구성 NAV 기준) — 상세 패널 참고용 (호가에는 미사용). */
  gap_mean_bp: number | null
  gap_sigma_bp: number | null
  /** 필터 통과 유효 표본수 (null 판정 근거 표시용). */
  gap_obs?: number | null
  creation_unit: number | null
  /** 회귀에 실제로 쓰인 수익률 개수 — O/N 금지 사유(표본 부족 vs σ 초과) 구분용. */
  obs?: number
  /** 서버가 표본부족을 명시할 때. 미제공이면 beta_k200 == null로 판정. */
  insufficient?: boolean
  /** ETF 전일종가 — 등락률·오늘 s의 기준가. 실시간 틱의 prev_close가 우선. (호가 앵커는 iNAV) */
  prev_close?: number | null
  /** 위 종가의 거래일 (`YYYY-MM-DD`). */
  prev_close_date?: string | null
  /** 종가가 **직전 거래일보다 오래됨** = FD 일봉 적재 지연. 등락률·s가 2거래일 이상 수익률이 된다. */
  prev_close_stale?: boolean
  /** 인트라데이 캘리브 (§14.5). 없으면 제안 호가 없음. */
  calib?: LpDeskCalib | null
}

export interface LpDeskMaster {
  stats_date: string
  /** 통계 파라미터 + 오버나이트 상한 룰(§14.12) — 룰 숫자의 단일 진실원은 서버다. */
  params: {
    window: number
    gap_window?: number
    gap_min_obs?: number
    /** 1박 5% 꼬리에서 허용하는 손실 (₩). */
    on_tail_loss_won?: number
    /** 5% 단측 정규분위수 (1.645). */
    on_tail_z?: number
    /** 이 위의 잔차σ(bp)는 오버나이트 금지. */
    on_max_resid_vol_bp?: number
    /** 회귀 표본이 이 미만이면 금지. */
    on_min_obs?: number
    /** 상한 표시 단위 (₩, 백만). */
    on_cap_unit_won?: number
  }
  calib_params?: LpDeskCalibParams | null
  items: LpDeskMasterItem[]
}

export interface LpDeskRollingBeta {
  date: string
  bk: number
  bq: number
}

export interface LpDeskResidPoint {
  date: string
  bp: number
}

/** 히스토그램(잔차·괴리 공통). bins 길이가 counts+1이면 경계, 같으면 중심값으로 해석. */
export interface LpDeskHist {
  bins: number[]
  counts: number[]
}

/** 괴리 시계열 한 점 (bp). */
export interface LpDeskGapPoint {
  date: string
  bp: number
}

export interface LpDeskPdfTop {
  code: string
  name: string
  /** 총액 0 등으로 비중 산출 불가 시 null. */
  weight_pct: number | null
  market: string | null
}

/** s 경로 한 점 — t는 `"MM-DD HH:MM"` (일자 경계 판정용으로 날짜를 포함한다). */
export interface LpDeskSPoint {
  t: string
  bp: number | null
}

export interface LpDeskDetail {
  rolling_beta: LpDeskRollingBeta[]
  resid: LpDeskResidPoint[]
  hist: LpDeskHist
  /** 과거 괴리 시계열·분포 (§14.3). 유효표본 부족이면 빈 배열. */
  gap: LpDeskGapPoint[]
  gap_hist: LpDeskHist
  /** 인트라데이 캘리브 (§14.5) — s 분포 / 최근 s 경로 / NAV 괴리 g 분포. */
  s_hist: LpDeskHist
  s_recent: LpDeskSPoint[]
  g_hist: LpDeskHist
  g_sigma_bp?: number | null
  pdf_top: LpDeskPdfTop[]
}

export interface LpDeskFill {
  id: number
  ts: string
  etf_code: string
  qty: number
  price: number
  entry_inav: number | null
  /** 체결 시점 지수선물가 (§14.6). 시세 미수신이면 null. */
  entry_k200?: number | null
  entry_kq150?: number | null
  note?: string | null
}

export interface LpDeskHedgeFill {
  id: number
  ts: string
  contract: HedgeContract
  qty: number
  price: number
}

/** per-ETF 합산 포지션. entry_* 는 평균원가 규약으로 접힌 진입 스냅샷 (§14.6). */
export interface LpDeskPosition {
  etf_code: string
  qty: number
  avg_price: number
  /** 체결 가중 진입 괴리(bp). */
  entry_gap_bp: number | null
  /** 헤지 상대성과(edge)의 기준 선물가. 하나라도 null이면 edge 산출 불가. */
  entry_k200: number | null
  entry_kq150: number | null
}

export interface LpDeskHedgePosition {
  contract: HedgeContract
  qty: number
  avg_price: number
}

export interface LpDeskPositions {
  positions: LpDeskPosition[]
  hedges: LpDeskHedgePosition[]
}

export interface LpDeskExitRow {
  code: string
  name: string
  market: string | null
  qty: number
  est_value: number
}

export interface LpDeskFuturesLeg {
  contract: string
  /** **집행할 주문 수량** — 현 보유의 반대 부호 (정리 티켓). */
  qty: number
  /** 현 보유 계약수. */
  position_qty?: number
  /** 보유 평단 (참고). */
  price?: number | null
}

/** 바스켓 분해에 쓰인 ETF 한 종. */
export interface LpDeskExitSource {
  etf_code: string
  name: string
  qty: number
  creation_unit: number
}

export interface LpDeskExitBasket {
  pdf_date: string | null
  rows: LpDeskExitRow[]
  futures_legs: LpDeskFuturesLeg[]
  /** PDF의 is_cash 제외분 (₩). */
  cash_omitted: number | null
  source_etfs?: LpDeskExitSource[]
  /** PDF 누락 등 산출 중 발생한 경고. */
  warnings?: string[]
}

// ── 응답 정규화 ────────────────────────────────────────────────────────────
// §14.9가 /positions의 필드명까지는 못 박지 않아, 흔한 별칭만 흡수한다.
// (백엔드가 계약대로 내려주면 그대로 통과 — 여기서 값을 만들어내지는 않는다.)

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export function normalizePositions(raw: unknown): LpDeskPositions {
  const r = (raw ?? {}) as Record<string, unknown>
  const rawPos = (r.positions ?? r.items ?? []) as Record<string, unknown>[]
  const rawHedge = (r.hedges ?? r.hedge_positions ?? r.hedge ?? []) as Record<string, unknown>[]
  const positions: LpDeskPosition[] = (Array.isArray(rawPos) ? rawPos : [])
    .map((p) => ({
      etf_code: String(p.etf_code ?? p.code ?? ''),
      qty: num(p.qty ?? p.net_qty),
      avg_price: num(p.avg_price ?? p.avg_cost),
      entry_gap_bp: numOrNull(p.entry_gap_bp ?? p.entry_premium_bp),
      entry_k200: numOrNull(p.entry_k200),
      entry_kq150: numOrNull(p.entry_kq150),
    }))
    .filter((p) => p.etf_code !== '' && p.qty !== 0)
  const hedges: LpDeskHedgePosition[] = (Array.isArray(rawHedge) ? rawHedge : [])
    .map((h) => ({
      contract: String(h.contract ?? h.code ?? '') as HedgeContract,
      qty: num(h.qty ?? h.net_qty),
      avg_price: num(h.avg_price ?? h.avg_cost),
    }))
    .filter((h) => h.contract === 'MK200' || h.contract === 'KQ150F')
  return { positions, hedges }
}
