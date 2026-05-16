import { useEffect, useRef } from 'react'

import { useMarketStore } from '@/stores/marketStore'

/**
 * 페이지별 주식/ETF 코드 구독. `/realtime/subscribe-stocks` 사용.
 *
 * 선물 월물 토글용 `/realtime/subscribe`(replace 시맨틱)와 별개의 그룹.
 * Rust 측은 코드별 ref-count + warm-down(60s) 시맨틱 (PR-a). 같은 코드를 여러 페이지가
 * 보면 마지막 unsubscribe까지 데이터 유지.
 *
 * X-LENS-Client-Id 헤더 (PR-b): WS 연결 시 realtime이 발급한 client_id를 첨부 →
 * 탭 강제 종료(F5/X 버튼)로 unsubscribe 호출이 빠져도 서버가 WS disconnect 감지해서
 * 그 client의 sub 자동 cleanup (ref-count leak 방지).
 *
 * 동작:
 * - hello 메시지 도착 전에는 sub 호출하지 않음 (clientId null이면 useEffect noop).
 *   그래서 서버 client_subs 추적이 항상 보장됨.
 * - WS 재연결로 clientId 변경 시 lastSet reset → 모든 코드를 새 id로 재구독.
 *   이전 client의 ref-count는 서버측 disconnect cleanup이 정리 → warm-down으로
 *   LS 연결 유지된 채 새 sub가 warm_resumed.
 */
function buildHeaders(clientId: number | null): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (clientId != null) headers['X-LENS-Client-Id'] = String(clientId)
  return headers
}

export function usePageStockSubscriptions(codes: string[]): void {
  const clientId = useMarketStore((s) => s.clientId)
  const lastSet = useRef<Set<string>>(new Set())
  const lastClientId = useRef<number | null>(null)

  useEffect(() => {
    // hello 메시지 받기 전엔 sub 호출 안 함 — clientId가 도착하면 다시 발화.
    if (clientId == null) return

    // WS 재연결로 clientId가 바뀌었으면 lastSet reset → 모든 코드 새 id로 재구독.
    if (lastClientId.current !== clientId) {
      lastSet.current = new Set()
      lastClientId.current = clientId
    }

    const next = new Set(codes.filter(Boolean))
    const prev = lastSet.current

    const added: string[] = []
    next.forEach((c) => { if (!prev.has(c)) added.push(c) })
    const removed: string[] = []
    prev.forEach((c) => { if (!next.has(c)) removed.push(c) })

    if (added.length > 0) {
      fetch('/realtime/subscribe-stocks', {
        method: 'POST',
        headers: buildHeaders(clientId),
        body: JSON.stringify({ codes: added }),
      }).catch(() => {})
    }
    if (removed.length > 0) {
      fetch('/realtime/unsubscribe-stocks', {
        method: 'POST',
        headers: buildHeaders(clientId),
        body: JSON.stringify({ codes: removed }),
      }).catch(() => {})
    }
    lastSet.current = next
  }, [codes, clientId])

  useEffect(() => {
    return () => {
      // unmount — 마지막 clientId 헤더로 명시적 unsubscribe.
      // (서버측 disconnect cleanup은 *WS 연결이 끊긴* 경우만. 페이지 unmount는 WS 유지)
      const all = Array.from(lastSet.current)
      if (all.length > 0) {
        fetch('/realtime/unsubscribe-stocks', {
          method: 'POST',
          headers: buildHeaders(lastClientId.current),
          body: JSON.stringify({ codes: all }),
        }).catch(() => {})
      }
      lastSet.current = new Set()
    }
  }, [])
}
