// 주식선물 대체 캐리 — 페어의 **매수 종목**을 주식선물로 바꿨을 때의 이득 (원/주 → bp).
//
// 백엔드가 273개 상장 종목을 한 번에 계산해 맵으로 준다 (`/api/stat-arb/futures-carry`,
// 산식·한계는 stat-arb-engine.md §23). 일봉 종가 스냅샷이라 실시간이 아니다.
// 목록(stat-arb.tsx)·상세(stat-arb-detail.tsx)가 같은 타입·헬퍼를 쓴다.

import { keyToCode, keyType } from '@/lib/stat-arb-keys'

/** 확정 현금배당 1건. `ex_date`는 'YYYY-MM-DD', `amount`는 원/주. */
export type Dividend = {
  ex_date: string
  amount: number
}

export type FuturesCarry = {
  name: string
  market: string
  futures_code: string
  /** 'front' | 'back' — 근월 잔존일 < 2면 back(차월물)으로 롤한 것 */
  contract: string
  /** YYYYMMDD */
  expiry: string
  days_left: number
  /** 1계약 = 이 주식 수 (통상 10) */
  multiplier: number
  spot: number
  futures_close: number
  /** 실측 = 선물 종가 − 현물가 */
  basis_now: number
  /** 이론 = spot × r×(1−margin) × d/365 − 배당합 */
  basis_theory: number
  /** 만기까지의 확정 배당 합 — **이론가에 반영되는 유일한 배당 항** */
  div_sum: number
  /**
   * 오늘 < ex_date ≤ +1년 확정 배당 (만기 내·후 모두). 만기 후 분은 캐리 숫자에 **안 들어간다**
   * — 그 구간은 롤 이후 월물 가격에 이미 프라이싱돼 있어 여기서 또 빼면 이중 반영이다.
   * 롤하며 길게 들고 갈 때 배당락을 미리 보라고 내려주는 가시화용.
   */
  upcoming_dividends: Dividend[]
  /** 오늘 −1년 ≤ ex_date ≤ 오늘. 미공시 정기배당의 **힌트일 뿐 확정 예정이 아니다** */
  past_dividends: Dividend[]
  /** 원/주. 양수 = 선물 매수가 유리 */
  carry_advantage: number
  carry_bp: number
  carry_bp_per_day: number
  /** 근월물 30거래일 평균 거래대금 (원) */
  avg_value_30d: number
  /** 일봉 기준일 */
  data_date: string
}

export type FuturesCarryMap = {
  asof: string
  rate: number
  margin: number
  items: Map<string, FuturesCarry>
}

export const EMPTY_CARRY_MAP: FuturesCarryMap = {
  asof: '',
  rate: 0,
  margin: 0,
  items: new Map(),
}

type CarryResp = {
  asof: string
  rate: number
  margin: number
  items: Record<string, FuturesCarry>
}

/** 전 종목 캐리 맵 1회 로드. 실패하면 빈 맵 (캐리 컬럼만 '—'로 비고 화면은 정상). */
export async function loadFuturesCarry(): Promise<FuturesCarryMap> {
  const res = await fetch('/api/stat-arb/futures-carry')
  if (!res.ok) throw new Error(`futures-carry HTTP ${res.status}`)
  const d: CarryResp = await res.json()
  return {
    asof: d.asof,
    rate: d.rate,
    margin: d.margin,
    items: new Map(Object.entries(d.items ?? {})),
  }
}

/**
 * 진입 방향의 **매수 종목** key 목록 (0~2개). spread = right − α − β·left 라서 z > 0 = right
 * 비쌈 → right 매도 + 헤지는 β·left 매수 포지션.
 *
 * ⚠️ **β 부호가 매매 방향을 뒤집는다.** β < 0이면 "β·left 매수" = left 매도라서
 * z ≥ 0에서는 **두 종목 모두 매도**(매수 종목 없음), z < 0에서는 **두 종목 모두 매수**가 된다.
 */
export function buyLegKeys(z: number, beta: number, leftKey: string, rightKey: string): string[] {
  if (beta < 0) return z >= 0 ? [] : [leftKey, rightKey]
  return z >= 0 ? [leftKey] : [rightKey]
}

/** 주식(S:) 종목만 주식선물 대체 대상 — ETF·지수는 개별주식선물이 없다. */
export function carryOf(map: FuturesCarryMap, key: string): FuturesCarry | undefined {
  if (keyType(key) !== 'S') return undefined
  return map.items.get(keyToCode(key))
}

/**
 * 진입 방향의 매수 종목 중 주식선물로 대체 가능한 것들의 캐리. 후보가 둘이면(β<0 & z<0)
 * **값이 큰(더 유리한) 쪽** — 절댓값이 아니다. 대체할 종목이 없으면 undefined.
 */
export function buyLegCarry(
  map: FuturesCarryMap,
  z: number,
  beta: number,
  leftKey: string,
  rightKey: string
): FuturesCarry | undefined {
  let best: FuturesCarry | undefined
  for (const key of buyLegKeys(z, beta, leftKey, rightKey)) {
    const c = carryOf(map, key)
    if (c && (best === undefined || c.carry_bp_per_day > best.carry_bp_per_day)) best = c
  }
  return best
}

/** 'YYYYMMDD' → 'YYYY-MM-DD'. 파싱 실패 시 원본. */
export function fmtExpiry(expiry: string): string {
  return /^\d{8}$/.test(expiry)
    ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}`
    : expiry
}

/** 'YYYY-MM-DD' 또는 'YYYYMMDD' → 'M/D' (좁은 셀·툴팁용). 파싱 실패 시 원본. */
export function fmtMonthDay(d: string): string {
  const iso = fmtExpiry(d)
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${Number(m[1])}/${Number(m[2])}` : d
}

/**
 * 확정 배당을 **선택 월물 만기 기준**으로 쪼갠다.
 * - `within` = 이론 베이시스에서 이미 차감된 분 (합 = `div_sum`)
 * - `after`  = 롤 이후 월물 구간의 배당락. **캐리 숫자에는 없다** — 다음 월물 가격에 이미
 *   프라이싱돼 있어 여기서 또 빼면 이중 반영이라, 표시만 하고 계산엔 넣지 않는다.
 */
export function splitDivsByExpiry(c: FuturesCarry): { within: Dividend[]; after: Dividend[] } {
  const exp = fmtExpiry(c.expiry) // ISO끼리는 문자열 비교 = 날짜 비교
  const within: Dividend[] = []
  const after: Dividend[] = []
  for (const d of c.upcoming_dividends ?? []) (d.ex_date > exp ? after : within).push(d)
  return { within, after }
}

/** 만기 이후 확정 배당락 (롤하고 계속 들고 갈 때 맞게 되는 것). 없으면 빈 배열. */
export function divsAfterExpiry(c: FuturesCarry): Dividend[] {
  return splitDivsByExpiry(c).after
}

/** 원클릭 판정 — 매수 종목을 선물로 대체할지 말지. 화면은 이 셋 중 하나만 읽으면 끝난다. */
export type CarryVerdict = 'futures' | 'neutral' | 'spot'

/** 판정 쿠션 (총 bp) — 왕복 슬리피지·베이시스 노이즈 감안. 이 이하 양수는 "굳이"로 분류. */
export const CARRY_CUSHION_BP = 5

/**
 * 캐리 3구간 판정. 기준은 **만기까지 총 bp**(`carry_bp`)다 — bp/일은 잔존일이 짧을수록 부풀어서
 * 쿠션(고정 비용)과 비교할 축이 못 된다. 총 bp가 왕복 비용을 넘어야 실익이 있다.
 */
export function carryVerdict(c: FuturesCarry): CarryVerdict {
  if (c.carry_bp >= CARRY_CUSHION_BP) return 'futures'
  return c.carry_bp >= 0 ? 'neutral' : 'spot'
}

/** 판정 배지 라벨 — 목록·상세 공용 1벌. */
export const CARRY_VERDICT_LABEL: Record<CarryVerdict, string> = {
  futures: '선물 매수',
  neutral: '중립',
  spot: '현물 매수',
}

/** 판정 배지 배경+글자색. */
export const CARRY_VERDICT_BADGE_CLS: Record<CarryVerdict, string> = {
  futures: 'bg-up/15 text-up',
  neutral: 'bg-bg-base text-t3',
  spot: 'bg-bg-surface text-t3',
}

/** 판정과 같은 숫자 색 (목록 셀·상세 큰 숫자) — 배지 없이 숫자만 있는 자리에서 판정을 읽히게. */
export const CARRY_VERDICT_TEXT_CLS: Record<CarryVerdict, string> = {
  futures: 'text-up',
  neutral: 'text-t3',
  spot: 'text-t4',
}

/** 판정 한 줄 설명 (배지·셀 툴팁 공용). 숫자는 만기까지 총 bp. */
export function carryVerdictTitle(c: FuturesCarry): string {
  const bp = `${fmtBp(c.carry_bp)}bp`
  switch (carryVerdict(c)) {
    case 'futures':
      return `선물 매수 — 캐리 ${bp} (만기까지, 쿠션 ${CARRY_CUSHION_BP}bp 초과). 이론 대비 백워데이션이라 현물 대신 주식선물 매수가 유리하다.`
    case 'neutral':
      return `중립 — 캐리 ${bp}. 쿠션(${CARRY_CUSHION_BP}bp) 미만이라 실익 미미. 단기 청산 예정이면 현물 유지 권장.`
    case 'spot':
      return `현물 매수 — 캐리 ${bp}. 콘탱고가 이자 수익보다 큼(선물로 바꾸면 오히려 손해).`
  }
}

/** 오늘 'YYYY-MM-DD' (로컬). 캐리 값은 전일 종가지만 배당 판단 구간은 **오늘~만기**다. */
function todayIso(): string {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 'YYYY-MM-DD' → epoch day. `Date.UTC`가 넘치는 일자(2/29 투영)를 알아서 정규화한다. */
function dayNum(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000
}

/**
 * 이력 투영 중복 판정 허용 오차(일). 배당락일은 해마다 ±2주씩 흔들린다 — 작년 9/8 중간배당이
 * 올해 8/27로 확정돼 있으면 같은 배당이다. 달(月) 일치로만 보면 이런 건이 "미공시분 확인"으로
 * 잘못 뜬다. 분기배당 간격(≈90일)보다 훨씬 작아 다른 회차를 삼키지는 않는다.
 */
const DIV_HINT_TOL_DAYS = 21

/**
 * 배당 주의 — 캐리 숫자를 믿기 전에 사람이 확인해야 할 배당이 있는가.
 * - ① **만기 후 확정 배당락** (`divsAfterExpiry`): 캐리 숫자엔 없다(다음 월물에 프라이싱).
 *   롤해서 들고 가면 그대로 맞는다.
 * - ② **이력 투영**: 지난 1년 배당락의 (월,일)을 잔존 구간 연도로 옮겨 [오늘, 만기]에 들어오면
 *   *아직 공시만 안 된 정기배당*일 수 있다. 그러면 이론 베이시스가 과대 → 캐리 과대평가다
 *   (§23.4). 투영 날짜 ±`DIV_HINT_TOL_DAYS`에 **확정 배당이 이미 있으면**(예정분이든, 올해
 *   이미 배당락난 분이든) 같은 정기배당이 공시·실현된 것이므로 중복으로 세지 않는다.
 *
 * 구간이 연말을 넘으면 두 해로 투영한다. 윈도 판정은 ISO 문자열 비교라 2/29 투영도 안전하다.
 */
export function dividendCaution(
  c: FuturesCarry,
  today: string = todayIso()
): { flag: boolean; reasons: string[] } {
  const reasons: string[] = []
  const exp = fmtExpiry(c.expiry)
  for (const d of divsAfterExpiry(c)) {
    reasons.push(
      `${fmtMonthDay(d.ex_date)} 확정 배당락 ${Math.round(d.amount).toLocaleString()}원 (만기 후)`
    )
  }
  const years = new Set([today.slice(0, 4), exp.slice(0, 4)])
  const past = c.past_dividends ?? []
  const confirmed = [...(c.upcoming_dividends ?? []), ...past].map((d) => dayNum(d.ex_date))
  for (const d of past) {
    const md = d.ex_date.slice(5) // 'MM-DD'
    for (const y of years) {
      const proj = `${y}-${md}`
      if (proj < today || proj > exp) continue
      const pn = dayNum(proj)
      if (confirmed.some((n) => Math.abs(n - pn) <= DIV_HINT_TOL_DAYS)) break // 이미 공시·실현됨
      reasons.push(
        `${d.ex_date} 배당락 ${Math.round(d.amount).toLocaleString()}원 이력 → ${fmtMonthDay(
          proj
        )} 전후 미공시 정기배당 가능`
      )
      break
    }
  }
  return { flag: reasons.length > 0, reasons }
}

/**
 * 캐리 bp 표시 — 부호 + 소수 2자리 고정. 목록·상세·툴팁이 **같은 자릿수**를 쓰도록 1벌로 둔다
 * (bp/일·만기 bp 공용). 일봉 종가 스냅샷 기반이라 셋째 자리 이하는 의미 없는 정밀도다.
 */
export function fmtBp(bp: number): string {
  return `${bp >= 0 ? '+' : ''}${bp.toFixed(2)}`
}

/** 캐리 원/주 표시 — 부호 + 정수 반올림 + 천단위. 원 단위 소수는 실행에 쓸모없다. */
export function fmtWon(won: number): string {
  return `${won >= 0 ? '+' : ''}${Math.round(won).toLocaleString()}`
}

/** 거래대금 축약 (억/조). 유동성 한눈에. */
export function fmtValue(won: number): string {
  if (!(won > 0)) return '—'
  if (won >= 1e12) return `${(won / 1e12).toFixed(1)}조`
  return `${Math.round(won / 1e8).toLocaleString()}억`
}
