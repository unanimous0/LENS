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

/** 거래대금 축약 (억/조). 유동성 한눈에. */
export function fmtValue(won: number): string {
  if (!(won > 0)) return '—'
  if (won >= 1e12) return `${(won / 1e12).toFixed(1)}조`
  return `${Math.round(won / 1e8).toLocaleString()}억`
}
