import { useEffect, useRef } from 'react'

/**
 * 페이지별 주식/ETF 코드 구독. `/realtime/subscribe-stocks` 사용.
 *
 * 선물 월물 토글용 `/realtime/subscribe`(replace 시맨틱)와 별개의 그룹.
 * Rust 측은 add/remove 시맨틱 — 다수 페이지가 각자 필요한 코드를 누적해서 추가/제거 가능.
 *
 * - 마운트 / codes 변경 시: 새 코드만 골라 subscribe-stocks. 빠진 건 unsubscribe-stocks.
 * - 언마운트 시: 자기가 마지막에 보유하던 코드 모두 unsubscribe-stocks.
 *
 * 한계: 같은 코드를 두 페이지가 동시에 보면, 한쪽이 unmount 시 unsubscribe하면 다른 페이지에서도
 * 끊김. ref-count가 필요하면 추후 Rust 측에 도입.
 */
export function usePageStockSubscriptions(codes: string[]): void {
  const lastSet = useRef<Set<string>>(new Set())

  useEffect(() => {
    const next = new Set(codes.filter(Boolean))
    const prev = lastSet.current

    const added: string[] = []
    next.forEach((c) => { if (!prev.has(c)) added.push(c) })
    const removed: string[] = []
    prev.forEach((c) => { if (!next.has(c)) removed.push(c) })

    if (added.length > 0) {
      fetch('/realtime/subscribe-stocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: added }),
      }).catch(() => {})
    }
    if (removed.length > 0) {
      fetch('/realtime/unsubscribe-stocks', {
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
        fetch('/realtime/unsubscribe-stocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: all }),
        }).catch(() => {})
      }
      lastSet.current = new Set()
    }
  }, [])
}
