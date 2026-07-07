import { useEffect, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import type { BasisZscoreResponse } from '@/types/lp'

/**
 * 지수 베이시스 z-score 모니터 (§13.3-D Phase 5).
 *
 * marketStore.indexFuturesTicks에서 실시간 베이시스(선물가 − 기초지수)와 기초지수 레벨을
 * 뽑아 GET /api/lp/basis-zscore로 넘기면 backend가 **만기 정규화 excess**(베이시스 −
 * spot×r×잔존일/365)의 60거래일 분포 대비 z-score를 붙여 준다 (raw 베이시스는 월물 혼합 시
 * 이봉 분포 → z 부호 반전 실측, F1). 분포 raw 행은 backend 1h 캐시라 폴링은 저렴 —
 * 15초 주기(베이시스는 천천히 움직여 per-tick 불필요).
 *
 * product → family: kospi200 → k200 (mini는 동일 지수라 생략), kosdaq150 → kq150.
 */
export function useBasisZscore(intervalMs = 15000): BasisZscoreResponse | null {
  const [data, setData] = useState<BasisZscoreResponse | null>(null)

  useEffect(() => {
    let active = true

    const fetchOnce = async () => {
      const ticks = useMarketStore.getState().indexFuturesTicks
      let k200: number | null = null
      let kq150: number | null = null
      let k200Spot: number | null = null
      let kq150Spot: number | null = null
      for (const t of Object.values(ticks)) {
        if (t.product === 'kospi200') {
          k200 = t.basis
          if (t.underlying_index > 0) k200Spot = t.underlying_index
        } else if (t.product === 'kosdaq150') {
          kq150 = t.basis
          if (t.underlying_index > 0) kq150Spot = t.underlying_index
        }
      }
      const params = new URLSearchParams()
      if (k200 != null) params.set('k200', String(k200))
      if (kq150 != null) params.set('kq150', String(kq150))
      // 이론 베이시스(excess) 계산용 기초지수 — 미제공 시 backend가 직전 종가 폴백.
      if (k200Spot != null) params.set('k200_spot', String(k200Spot))
      if (kq150Spot != null) params.set('kq150_spot', String(kq150Spot))
      try {
        const r = await fetch(`/api/lp/basis-zscore?${params.toString()}`)
        if (r.ok && active) setData((await r.json()) as BasisZscoreResponse)
      } catch {
        /* 무시 — 다음 폴링에서 복구 */
      }
    }

    void fetchOnce()
    const id = setInterval(fetchOnce, intervalMs)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [intervalMs])

  return data
}
