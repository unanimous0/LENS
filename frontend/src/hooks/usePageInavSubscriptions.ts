import { useEffect, useRef } from 'react'

/**
 * ETF iNAV 구독 hook (`/realtime/subscribe-inav`).
 *
 * I5_ TR로 거래소 발행 실시간 NAV를 받아 EtfTick.nav에 채움. PDF 자체계산 NAV
 * 인프라 대신 거래소 공식값 그대로 사용. ETF 코드만 의미 있음 (일반 주식 코드는
 * I5_ 응답이 없음).
 */
export function usePageInavSubscriptions(codes: string[]): void {
  const lastSet = useRef<Set<string>>(new Set())

  useEffect(() => {
    const next = new Set(codes.filter(Boolean))
    const prev = lastSet.current

    const added: string[] = []
    next.forEach((c) => { if (!prev.has(c)) added.push(c) })
    const removed: string[] = []
    prev.forEach((c) => { if (!next.has(c)) removed.push(c) })

    if (added.length > 0) {
      fetch('/realtime/subscribe-inav', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: added }),
      }).catch(() => {})
    }
    if (removed.length > 0) {
      fetch('/realtime/unsubscribe-inav', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: removed }),
      }).catch(() => {})
    }
    lastSet.current = next
  }, [codes])

  useEffect(() => {
    return () => {
      const all = Array.from(lastSet.current)
      if (all.length > 0) {
        fetch('/realtime/unsubscribe-inav', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: all }),
        }).catch(() => {})
      }
      lastSet.current = new Set()
    }
  }, [])
}
