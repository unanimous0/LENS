import type { HedgeContract, LpDeskCalib } from '@/types/lp-desk'
import type { IndexFuturesProduct, IndexFuturesTick } from '@/types/market'

/**
 * LP 데스크(§14) 전용 순수 헬퍼 — 체결 원라인 파서 + 원화 축약.
 * 컴포넌트 파일에서 분리해 둔다 (react-refresh: 컴포넌트 파일은 컴포넌트만 export).
 */

export type ParsedFill =
  | { kind: 'etf'; code: string; qty: number; price: number }
  | { kind: 'hedge'; contract: HedgeContract; qty: number; price: number }
  | { kind: 'error'; message: string }

const HEDGE_ALIAS: Record<string, HedgeContract> = {
  MK200: 'MK200', MINI: 'MK200', MINIK200: 'MK200', K200M: 'MK200', 미니: 'MK200', '미니K200': 'MK200',
  KQ: 'KQ150F', KQ150: 'KQ150F', KQ150F: 'KQ150F', KOSDAQ150: 'KQ150F', 코스닥150: 'KQ150F', 코스닥: 'KQ150F',
}

const FORMAT_HINT = '형식: 코드 ±수량 @가격 (예: 396500 +5000 @35565)'
const SYMBOL_RE = /^[A-Z0-9가-힣]{2,12}$/
const QTY_RE = /^[+-]?\d+$/
const PRICE_RE = /^\d+(\.\d+)?$/
const ISIN_RE = /^KR[A-Z0-9]{10}$/
const A_PREFIX_RE = /^A[0-9][A-Z0-9]{5}$/

/**
 * 종목코드 자유 입력 수용 (memory `feedback_symbol_input`, backend `stock_code.py`와 같은 규약).
 * `A396500` → `396500`, `KR7396500008` → `396500`. 이미 대문자화된 심볼이 들어온다.
 * 헤지 별칭(MK200 등)과 겹치지 않게 **ETF 코드 꼴일 때만** 벗겨낸다.
 */
function normalizeSymbol(symbol: string): string {
  if (ISIN_RE.test(symbol)) return symbol.slice(3, 9)
  if (A_PREFIX_RE.test(symbol)) return symbol.slice(1)
  return symbol
}

/**
 * 체결 원라인 파싱. `396500 +5000 @35565` / `MK200 -12 @452.35`.
 * 코드는 자유 형식 — `A396500` / `KR7396500008` / 소문자(`0117v0`) 모두 수용.
 *
 * 정규식 한 방 대신 토큰화 — 공백·@·쉼표를 지운 뒤 3토큰을 요구해야 `396500 @35565`처럼
 * 필드가 빠진 입력을 "형식 오류"로 정확히 되돌려줄 수 있다(한 방 정규식은 코드/수량 경계를
 * 멋대로 쪼개서 엉뚱한 에러가 난다).
 *
 * @param universe 대문자 심볼 → 정식 ETF 코드 (0117V0처럼 영숫자 혼합 코드가 있어 숫자 판정 불가).
 */
export function parseFillInput(raw: string, universe: Map<string, string>): ParsedFill {
  if (!raw.trim()) return { kind: 'error', message: '입력 없음' }
  const parts = raw
    .toUpperCase()
    .replace(/,/g, '')
    .replace(/@/g, ' ')
    .replace(/([+-])/g, ' $1') // 부호는 항상 수량 토큰의 시작
    .trim()
    .split(/\s+/)
  if (parts.length !== 3) return { kind: 'error', message: FORMAT_HINT }
  const [symbol, qtyTok, priceTok] = parts
  if (!SYMBOL_RE.test(symbol) || !QTY_RE.test(qtyTok) || !PRICE_RE.test(priceTok))
    return { kind: 'error', message: FORMAT_HINT }
  const qty = parseInt(qtyTok, 10)
  const price = parseFloat(priceTok)
  if (!Number.isFinite(qty) || qty === 0) return { kind: 'error', message: '수량이 0' }
  if (!Number.isFinite(price) || price <= 0) return { kind: 'error', message: '가격 오류' }

  const etfCode = universe.get(normalizeSymbol(symbol))
  if (etfCode) return { kind: 'etf', code: etfCode, qty, price }
  const contract = HEDGE_ALIAS[symbol]
  if (contract) return { kind: 'hedge', contract, qty, price }
  if (symbol === 'K200' || symbol === 'K200F')
    return { kind: 'error', message: 'K200F(승수 25만)는 v1 미지원 — 미니K200(MK200)으로 입력' }
  return { kind: 'error', message: `모르는 코드: ${symbol} (유니버스 ETF / MK200 / KQ150F)` }
}

// ── 상승/하락 색 (§14.8) ───────────────────────────────────────────────────
// 종목차익 화면(`pages/stock-arbitrage.tsx`)과 **정확히 같은 토큰**을 쓴다 (사용자 요구
// 2026-08-20). 전역 `text-up`(#34c759)/`text-down`(#ff3b30)이 아니라 종목차익이 실제로
// 쓰는 아래 두 색이 기준.

/** 상승·매수·플러스. */
export const LP_UP = 'text-[#00b26b]'
/** 하락·매도·마이너스. */
export const LP_DOWN = 'text-[#bb4a65]'
/** 0 / 방향 없음. */
export const LP_FLAT = 'text-[#e0e0e3]'

/** 부호 → 색 클래스. */
export function cV(v: number): string {
  return v === 0 ? LP_FLAT : v > 0 ? LP_UP : LP_DOWN
}

// ── 호가 제안 (§14.5) ──────────────────────────────────────────────────────

/** ETF 호가 틱 — 국내 ETF는 가격대와 무관하게 5원 고정. */
export const ETF_TICK = 5

/** 5원 틱 반올림. ask는 올림 / bid는 내림 (둘 다 보수적인 쪽). */
export function roundTick(price: number, dir: 'up' | 'down'): number {
  const f = dir === 'up' ? Math.ceil : Math.floor
  return f(price / ETF_TICK) * ETF_TICK
}

/**
 * bp 부호 표기 — `+12.3` / `-5.0`. 밴드를 음수로 잡으면 `+`를 하드코딩한 곳이 `+-5.0`을
 * 렌더하므로(2026-08-20 실측) 부호는 항상 이 함수로.
 */
export function fmtSignedBp(v: number, digits = 1): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`
}

/**
 * 호가 폭의 지평 T (초) — "내 호가가 걸려 있는 시간". 서버가 이 지평들의 σ를 **직접 측정**해
 * 내려준다(`calib.s_diff_sigma_bp[T]`). 프론트는 고르기만 하고 환산하지 않는다.
 *
 * ⚠️ **√T 환산은 폐기됐다** (2026-08-21 5차 보완, 사용자 지적). 30초 증분 σ에 √(T/30초)를
 * 곱하던 종전 경로는 랜덤워크를 가정하는데, 실측이 그걸 기각한다 — 305540: 30초 7.84bp를
 * √10 환산하면 25.0bp지만 5분을 직접 재면 17.2bp(분산비 0.47), 1분은 9.8bp(VR 0.77).
 * s는 되돌리는 성질이 있고 30초 증분에는 호가 바운스 잡음이 섞여 있어, √T는 지평이 길수록
 * σ_r을 부풀린다. 그 부풀림이 제안 호가를 30~70bp씩 벌려 놓은 주범이었다.
 */
export const QUOTE_HORIZON_OPTIONS = [60, 120, 300] as const
/** 기본 지평 = 1분. */
export const QUOTE_HORIZON_SECONDS: number = QUOTE_HORIZON_OPTIONS[0]

/** 저장된 지평 값 검증 — 서버가 σ를 측정한 지평이 아니면 기본값으로. */
export function clampHorizon(sec: unknown): number {
  return (QUOTE_HORIZON_OPTIONS as readonly number[]).includes(sec as number)
    ? (sec as number)
    : QUOTE_HORIZON_SECONDS
}

/** 지평 라벨 — `60 → "1분"`. */
export function horizonLabel(sec: number): string {
  return `${sec / 60}분`
}

/**
 * z 튜너 (§14.5). 헤더 세그먼트 프리셋 4종이 상용 레벨이고, **그 밖의 값은 옆 입력칸에 직접**
 * 넣는다 (2026-08-28 — 프리셋에 갇히지 않게 자유 입력 복원. 스냅 없이 클램프만).
 * 기본 **1.5σ**: 2σ는 실측 8거래일에서 매도측 도달 0일 = 사실상 체결 불가였고, 1.5σ가
 * "가끔·유리한 순간만" 잡히는 빈도였다 (2026-08-21 사용자 확정).
 *
 * 범위는 프리셋보다 넓게 잡는다 — 아래는 "거의 NAV에 붙여 놓고 물량 받기"(0.25σ), 위는
 * "사실상 안 걸림"(4σ)까지. 백엔드 `/lp-desk/export.xlsx`의 z 검증 범위와 같아야 한다.
 */
export const Z_PRESETS = [1, 1.25, 1.5, 2] as const
export const Z_DEFAULT = 1.5
export const Z_MIN = 0.25
export const Z_MAX = 4

/** z 정규화 — 범위 클램프 + 소수 2자리(라벨·비교가 부동소수 꼬리에 흔들리지 않게). */
export function clampZ(z: unknown): number {
  if (typeof z !== 'number' || !Number.isFinite(z)) return Z_DEFAULT
  return Math.round(Math.min(Z_MAX, Math.max(Z_MIN, z)) * 100) / 100
}

/** z 라벨 — `1 → "1.0σ"`, `1.25 → "1.25σ"` (2자리로 반올림된 값이라 뒷자리 0만 떤다). */
export function zLabel(z: number): string {
  return `${z.toFixed(2).replace(/0$/, '')}σ`
}

/**
 * 제안 호가 (§14.5 **호가 층**, 2026-08-21 4차 보완 두 분포 결합 z·σ + **5차 지평 직접 측정**).
 *
 *   매도 = tick올림( iNAV × (1 + x_ask) )   /   매수 = tick내림( iNAV × (1 + x_bid) )
 *   x_ask = μ_g + z·σ_comb   /   x_bid = μ_g − z·σ_comb        (z 기본 1.5 — `Z_DEFAULT`)
 *   σ_comb = √(σ_g² + σ_r²)  ·  σ_r = `s_diff_sigma_bp[T]` (지평 T에서 **직접 측정**, 기본 1분)
 *
 * 앵커는 **iNAV**, 중심은 **μ_g**(가격이 장중 재구성 NAV에서 평소 얼마나 벌어져 거래되나),
 * 폭은 **두 괴리 분포의 결합**이다. 호가가 걸려 있는 몇 분 동안 나를 때리는 움직임은 두 갈래다:
 * ① 가격이 NAV 주변에서 흔들리는 폭(σ_g) ② 그 사이 ETF가 선물 대비로 밀리는 폭(σ_r).
 * 둘은 서로 다른 축이라 제곱합으로 합친다.
 *
 * s의 **레벨**은 여전히 호가에서 빠져 있다 (4차 정정) — 일중 ±100~200bp인 섹터 고유 이동을
 * 호가 위치로 쓰면 NAV에서 수백 bp 밖에 서게 된다. 여기 들어가는 건 s의 **지평 T 변화 폭**뿐이다.
 *
 * 그래서 이 함수에서 실시간으로 움직이는 건 iNAV뿐이고, x는 서버 배치가 준 정적 통계다.
 * 체결은 "가격이 NAV에서 x만큼 벌어진 순간"에 일어난다 — 표의 `괴리bp`가 곧 실시간 g이므로
 * 그게 x에 다가가는 게 체결 임박이다 (`nearSide`).
 *
 * ⚠️ 재구성 NAV와 공식 iNAV의 상수 편차(보수·배당 계상)가 μ_g에 실릴 수 있다 (§14.5 주석).
 *    운용 중 괴리 컬럼과 대조할 것.
 *
 * 캘리브·iNAV가 없으면 가격 대신 사유를 돌려준다 — 호출부는 "—" + 경고 톤으로 표시하고 절대
 * 대체값을 만들어내지 않는다. **σ_r만 없으면 차단이 아니라 degrade**다: σ_comb = σ_g로 좁혀
 * 호가를 내되 `degraded`로 사유를 표기한다 (선물 30초봉이 없는 내부망에서도 호가는 서야 한다).
 * 편측 사유 필드는 유지하지만, x 양쪽이 같은 μ·σ에서 나오므로 실제로는 항상 같이 산다/죽는다.
 */
export type QuoteSuggestion = {
  /** 호가 앵커 = iNAV. 미수신이면 null. */
  anchor: number | null
  xAskBp: number | null
  xBidBp: number | null
  bid: number | null
  ask: number | null
  /** x 분해 (툴팁 표시용) — 중심 μ_g / NAV 괴리 σ / 선물 괴리 σ(T 지평 직접 측정) / 결합 σ. */
  muBp: number | null
  sigmaGBp: number | null
  sigmaRBp: number | null
  sigmaCombBp: number | null
  /** σ_r을 가져온 지평 (초) — 라벨·툴팁이 같은 값을 쓰게 되돌려준다. */
  horizonSeconds: number
  /** σ_r 없음 → σ_comb = σ_g로 좁힌 상태. */
  degraded: boolean
  /** 창 `g_days`일 중 그 x 레벨이 열린 **날 수** — 일별 극값으로 실계산 (§14.11). */
  touchDaysAsk: number | null
  touchDaysBid: number | null
  /** 위 도달 일수의 모수 (= g_day_max 길이). */
  touchTotalDays: number | null
  /** 편측 산출 불가 사유. 빈 문자열이면 정상. */
  askReason: string
  bidReason: string
}

export function suggestQuote(args: {
  /** 실시간 iNAV (§14.5 4차 — 호가 앵커). */
  inav: number | null
  calib: LpDeskCalib | null | undefined
  /** σ_comb 배수 (프리셋 `Z_PRESETS` 또는 자유 입력 — `Z_MIN`~`Z_MAX`, 기본 1.5). */
  z: number
  /** 호가 지평 T (초) — `QUOTE_HORIZON_OPTIONS` 중 하나. 서버가 그 지평의 σ를 직접 잰다. */
  horizonSeconds?: number
}): QuoteSuggestion {
  const { inav, calib, z } = args
  const horizonSeconds = clampHorizon(args.horizonSeconds)
  const muBp = num(calib?.g_mean_bp)
  const sigmaGBp = num(calib?.g_sigma_level_bp)
  // σ_r = 그 지평에서 직접 측정한 s 변화 σ. 환산 없음 (√T 폐기 — 위 주석).
  const sigmaRBp = num(calib?.s_diff_sigma_bp?.[String(horizonSeconds)])
  const sigmaCombBp = sigmaGBp != null ? Math.hypot(sigmaGBp, sigmaRBp ?? 0) : null
  const halfBp = sigmaCombBp != null ? z * sigmaCombBp : null
  const xAskBp = muBp != null && halfBp != null ? muBp + halfBp : null
  const xBidBp = muBp != null && halfBp != null ? muBp - halfBp : null
  const dayMax = calib?.g_day_max ?? null
  const dayMin = calib?.g_day_min ?? null

  const base = {
    anchor: null, xAskBp, xBidBp, bid: null, ask: null,
    muBp, sigmaGBp, sigmaRBp, sigmaCombBp, horizonSeconds,
    degraded: sigmaGBp != null && sigmaRBp == null,
    touchDaysAsk: touchDays(dayMax, xAskBp, 'ask'),
    touchDaysBid: touchDays(dayMin, xBidBp, 'bid'),
    touchTotalDays: dayMax?.length ?? null,
  }
  /** 양쪽 공통 차단 — 앵커/통계 자체가 없는 경우. */
  const block = (reason: string): QuoteSuggestion => ({ ...base, askReason: reason, bidReason: reason })

  if (!calib) return block('캘리브 없음')
  if (muBp == null || sigmaCombBp == null) return block('g 표본 부족 — μ·σ 없음')
  if (!(inav && inav > 0)) return block('iNAV 미수신')

  return {
    ...base,
    anchor: inav,
    bid: xBidBp != null ? roundTick(inav * (1 + xBidBp / 10000), 'down') : null,
    ask: xAskBp != null ? roundTick(inav * (1 + xAskBp / 10000), 'up') : null,
    askReason: '',
    bidReason: '',
  }
}

/**
 * 임의 레벨의 **도달 일수** — 창 N일 중 장중 g가 그 레벨을 한 번이라도 넘은 날 수.
 * 서버가 분위수에 대해 쓰는 정의(`_touch_days`)와 같다: 매도는 일별 max ≥ x, 매수는 일별 min ≤ x.
 * x가 분위수가 아니게 되면서(μ±zσ) 서버가 미리 셀 수 없어 일별 극값을 받아 여기서 센다.
 */
export function touchDays(
  dayExtremes: (number | null)[] | null | undefined,
  level: number | null,
  side: 'ask' | 'bid',
): number | null {
  if (!dayExtremes || level == null || !Number.isFinite(level)) return null
  let n = 0
  for (const v of dayExtremes) {
    if (v == null || !Number.isFinite(v)) continue
    if (side === 'ask' ? v >= level : v <= level) n++
  }
  return n
}

/**
 * 제안 호가가 시장 최우선호가에서 **몇 틱 밖인지** (ETF 5원 틱).
 *   매도: (제안 − 시장최우선매도) / 틱   ·   매수: (시장최우선매수 − 제안) / 틱
 * 양수 = 시장 밖에서 대기(정상적인 LP 대기 호가), 0 = 최우선호가와 동일, 음수 = 시장 안쪽
 * (걸면 곧바로 최우선이 되거나 상대 호가를 때린다). 시장 호가 미수신이면 null.
 */
export function ticksOutside(
  price: number | null,
  side: 'bid' | 'ask',
  bid1: number,
  ask1: number,
): number | null {
  if (price == null || !Number.isFinite(price)) return null
  const mkt = side === 'ask' ? ask1 : bid1
  if (!(mkt > 0)) return null
  return Math.round((side === 'ask' ? price - mkt : mkt - price) / ETF_TICK)
}

function num(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 실시간 g가 x 레벨의 이 비율까지 오면 "체결 임박"으로 본다. */
export const NEAR_TOUCH_RATIO = 0.8
/** 임박 판정 여유폭 = |x|의 이 비율 (= 1 − NEAR_TOUCH_RATIO). */
export const NEAR_MARGIN_RATIO = 1 - NEAR_TOUCH_RATIO

/**
 * **실시간 괴리 g**(가격 vs iNAV, 표의 `괴리bp`)가 어느 쪽 제안 호가에 다가섰는지.
 * 4차 정정으로 판정 입력이 s → g로 바뀌었다 — 호가가 iNAV 기준으로 서므로, 체결에 다가가는
 * 자도 같은 iNAV 기준이어야 한다(선물이 없는 내부망에서도 동작).
 *
 * **부호와 무관하게 방향으로** 판정한다: 매도는 g가 x_ask **이상**으로 올라올 때, 매수는 g가
 * x_bid **이하**로 내려갈 때 열린다. 임박은 거기서 |x|의 20% 못 미친 지점부터.
 * (x가 양수일 때만 보던 예전 판정은 x_ask가 음수인 종목을 영원히 강조하지 않았다 — g 기준에선
 *  음수 x_ask가 더 흔하다. 재구성 NAV 대비 상시 디스카운트 종목이 다수, 2026-08-21 실측.)
 */
export function nearSide(
  gBp: number | null,
  xAskBp: number | null,
  xBidBp: number | null,
): 'ask' | 'bid' | null {
  if (gBp == null || !Number.isFinite(gBp)) return null
  if (xAskBp != null && gBp >= xAskBp - NEAR_MARGIN_RATIO * Math.abs(xAskBp)) return 'ask'
  if (xBidBp != null && gBp <= xBidBp + NEAR_MARGIN_RATIO * Math.abs(xBidBp)) return 'bid'
  return null
}

// ── 오늘 s (§14.5) ─────────────────────────────────────────────────────────

/**
 * 오늘 장중 선물 대비 스큐 s (bp) — 캘리브 s 분포의 **실시간 값**.
 *   s = [ETF 등락률% − (β_K×K200F 등락률% + β_Q×KQ150F 등락률%)] × 100
 * β가 없거나(회귀 표본 부족) 선물·ETF 등락률이 없으면 null.
 *
 * **호가와는 무관**(4차 정정) — 지수선물로 덮이지 않은 오늘의 섹터 고유 움직임, 즉 헤지하고
 * 남는 잔차 리스크의 크기를 보는 참고 컬럼이다. 체결 임박 판정은 `nearSide`(실시간 g)가 한다.
 */
export function relPerfBp(
  etfChangePct: number | null,
  betaK: number | null,
  betaQ: number | null,
  futKChangePct: number | null,
  futQChangePct: number | null,
): number | null {
  if (etfChangePct == null || !Number.isFinite(etfChangePct)) return null
  if (betaK == null || betaQ == null || !Number.isFinite(betaK) || !Number.isFinite(betaQ)) return null
  if (futKChangePct == null || futQChangePct == null) return null
  if (!Number.isFinite(futKChangePct) || !Number.isFinite(futQChangePct)) return null
  return (etfChangePct - (betaK * futKChangePct + betaQ * futQChangePct)) * 100
}

// ── 지수선물 조회 (§14.4·§14.6 공용) ────────────────────────────────────────

/** 지수선물 한 상품의 현재 상태. */
export type FutQuote = {
  code: string
  price: number
  changePct: number
  timestamp: string
}

/**
 * `marketStore.indexFuturesTicks`(**code 키 — 제거 없이 누적**)를 product별 1건으로 접는다.
 *
 * 월물 롤 경계에는 같은 product의 구·신 월물 틱이 동시에 남는다. 그래서 규칙은
 * **① 체결가 있는 틱만(price>0) ② 그중 timestamp가 가장 최신인 것**.
 * 구월물은 갱신이 끊기므로 timestamp가 자연스럽게 뒤처진다. timestamp는 서버(Rust)가 모든
 * 피드에서 UTC `%Y-%m-%dT%H:%M:%S%.6f` 고정폭으로 찍어 문자열 비교가 곧 시간 비교다.
 * 완전 동일 timestamp면 **먼저 들어온 틱 유지**(삽입 순서) — 결정적이기만 하면 되는 tie-break.
 *
 * 헤지 환산·edge·진입 스냅샷·헤더 칩이 전부 이 한 벌을 쓴다 (예전엔 "첫 매치" vs "마지막 승"
 * 두 체인이 갈려 롤 경계에서 서로 다른 월물을 집을 수 있었다).
 */
export function resolveIndexFutures(
  ticks: Record<string, IndexFuturesTick>,
): Map<IndexFuturesProduct, FutQuote> {
  const m = new Map<IndexFuturesProduct, FutQuote>()
  for (const t of Object.values(ticks)) {
    if (!(t.price > 0)) continue
    const cur = m.get(t.product)
    if (cur && cur.timestamp >= t.timestamp) continue
    m.set(t.product, { code: t.code, price: t.price, changePct: t.change_rate, timestamp: t.timestamp })
  }
  return m
}

/** 상품 우선순위대로 첫 유효 선물 (미니와 K200F는 같은 가격, 승수만 다름). */
export function pickFut(
  byProduct: Map<IndexFuturesProduct, FutQuote>,
  products: IndexFuturesProduct[],
): FutQuote | null {
  for (const p of products) {
    const f = byProduct.get(p)
    if (f) return f
  }
  return null
}

/** 원화 축약 — 억/만원. 크기만 (부호 없음). 한도·리스크처럼 방향이 없는 값에. */
export function fmtWonAbs(v: number): string {
  return fmtWon(v).replace(/^[+-]/, '')
}

/** 원화 축약 — 억/만원. 부호 유지. */
export function fmtWon(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0'
  const sign = v > 0 ? '+' : '-'
  const a = Math.abs(v)
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(a >= 1e9 ? 0 : 2)}억`
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString()}만`
  return `${sign}${Math.round(a).toLocaleString()}`
}
