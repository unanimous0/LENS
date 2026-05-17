import { useEffect, useRef } from 'react'

import { useMarketStore } from '@/stores/marketStore'

/**
 * ETF iNAV 구독 hook (`/realtime/subscribe-inav`).
 *
 * I5_ TR로 거래소 발행 실시간 NAV를 받아 EtfTick.nav에 채움. PDF 자체계산 NAV
 * 인프라 대신 거래소 공식값 그대로 사용. ETF 코드만 의미 있음 (일반 주식 코드는
 * I5_ 응답이 없음).
 *
 * X-LENS-Client-Id 헤더 (PR-10): subscribe-stocks와 동일 정책. realtime이 발급한
 * client_id를 헤더로 첨부 → 탭 강제 종료(F5/X 버튼)로 unsubscribe 호출이 빠져도
 * 서버가 WS disconnect 감지해서 그 client의 inav sub 자동 cleanup.
 */
function buildHeaders(clientId: number | null): HeadersInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (clientId != null) headers['X-LENS-Client-Id'] = String(clientId)
  return headers
}

export function usePageInavSubscriptions(codes: string[]): void {
  const clientId = useMarketStore((s) => s.clientId)
  const lastSet = useRef<Set<string>>(new Set())
  const lastClientId = useRef<number | null>(null)

  useEffect(() => {
    if (clientId == null) return
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
      fetch('/realtime/subscribe-inav', {
        method: 'POST',
        headers: buildHeaders(clientId),
        body: JSON.stringify({ codes: added }),
      }).catch(() => {})
    }
    if (removed.length > 0) {
      fetch('/realtime/unsubscribe-inav', {
        method: 'POST',
        headers: buildHeaders(clientId),
        body: JSON.stringify({ codes: removed }),
      }).catch(() => {})
    }
    lastSet.current = next
  }, [codes, clientId])

  useEffect(() => {
    return () => {
      const all = Array.from(lastSet.current)
      if (all.length > 0) {
        fetch('/realtime/unsubscribe-inav', {
          method: 'POST',
          headers: buildHeaders(lastClientId.current),
          body: JSON.stringify({ codes: all }),
        }).catch(() => {})
      }
      lastSet.current = new Set()
    }
  }, [])
}
