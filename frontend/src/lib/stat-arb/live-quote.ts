// 단발 현재가 스냅샷 (realtime `/quote` = t8407 1콜) + 짧은 캐시.
//
// 통계차익 목록은 페어가 수천 개라 전 종목 WS 구독이 불가능하다(LS 계정 한계 — 과거
// 호가 stall 전례). 대신 사용자가 *지금 보고 있는 한 페어*의 두 종목만 REST로 찍어
// 라이브 z를 계산한다. 구독·틱 경로(marketStore)와 완전히 별개.
//
// 지속 감시가 필요하면 워치리스트(별표)를 쓴다 — 그쪽은 WS 구독 + 목표 z 알림.

export type Quote = {
  price: number
  prev_close: number
  volume: number
  /** 당일 체결 0 — price는 전일 종가 이월값이라 라이브로 취급하면 안 됨. */
  stale: boolean
}

/** 캐시 유효 시간. 같은 셀을 오가며 hover해도 이 안에서는 재조회하지 않는다. */
const TTL_MS = 20_000

const cache = new Map<string, { q: Quote; at: number }>()
/** 같은 코드 집합에 대한 동시 요청 합류 (hover 왕복 시 중복 콜 방지). */
const inflight = new Map<string, Promise<Record<string, Quote>>>()

function fresh(code: string, now: number): Quote | null {
  const hit = cache.get(code)
  return hit && now - hit.at < TTL_MS ? hit.q : null
}

/**
 * 코드들의 현재가 조회. 캐시에 살아있는 건 그대로 쓰고 부족한 것만 1콜로 가져온다.
 * 조회 실패·무응답 코드는 결과에서 빠진다 (호출자가 없으면 없는 대로 처리).
 */
export async function fetchQuotes(codes: string[]): Promise<Record<string, Quote>> {
  const now = Date.now()
  const out: Record<string, Quote> = {}
  const missing: string[] = []
  for (const c of codes) {
    const q = fresh(c, now)
    if (q) out[c] = q
    else missing.push(c)
  }
  if (missing.length === 0) return out

  const key = [...missing].sort().join(',')
  let job = inflight.get(key)
  if (!job) {
    job = (async () => {
      const res = await fetch(`/realtime/quote?codes=${encodeURIComponent(missing.join(','))}`)
      if (!res.ok) throw new Error(`quote HTTP ${res.status}`)
      const data: { quotes?: Record<string, Quote>; error?: string } = await res.json()
      if (data.error) throw new Error(data.error)
      const at = Date.now()
      const got = data.quotes ?? {}
      for (const [code, q] of Object.entries(got)) cache.set(code, { q, at })
      return got
    })().finally(() => inflight.delete(key))
    inflight.set(key, job)
  }
  Object.assign(out, await job)
  return out
}
