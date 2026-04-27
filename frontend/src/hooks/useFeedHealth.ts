import { useEffect } from 'react'
import { useMarketStore } from '../stores/marketStore'
import type { FeedState } from '../stores/marketStore'

/**
 * /realtime/debug/stats를 5초 간격 폴링해서 feed health 갱신.
 * Rust 서비스가 LS API에서 마지막으로 데이터 받은 시각으로 산출됨.
 * 모드별 다른 의미: ls_api는 fresh/quiet/stale/closed, mock/internal은 고정 라벨.
 */
export function useFeedHealth(intervalMs = 5000) {
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll() {
      if (stopped) return
      try {
        const res = await fetch('/realtime/debug/stats')
        if (res.ok) {
          const data = await res.json()
          useMarketStore.getState().setFeedHealth(
            (data.feed_state as FeedState) ?? 'unknown',
            data.feed_age_sec ?? 0,
          )
        }
      } catch { /* ignore — 일시적 네트워크 오류는 무시, 다음 폴링이 따라잡음 */ }
      if (!stopped) timer = setTimeout(poll, intervalMs)
    }

    poll()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs])
}
