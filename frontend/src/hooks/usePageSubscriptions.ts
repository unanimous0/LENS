import { useEffect, useRef } from 'react'

/**
 * 페이지별 종목 구독 관리.
 *
 * - 마운트/codes 변경 시: 새 코드 subscribe, 이전 사용한 코드 중 빠진 건 unsubscribe
 * - 언마운트 시: 자기가 마지막에 잡고 있던 코드 unsubscribe (페이지 떠나면 갱신 중단)
 *
 * Rust 측은 코드 레벨 ref-count 없이 단순 add/remove. 한 페이지만 active한 것이
 * 일반적이라 충분 — 같은 코드를 두 페이지가 동시에 보면 마지막에 unsubscribe하는
 * 페이지가 풀어버린다는 한계는 있음. 그 케이스 생기면 그때 ref-count 도입.
 */
export function usePageSubscriptions(codes: string[]): void {
  const lastSet = useRef<Set<string>>(new Set())

  useEffect(() => {
    const next = new Set(codes.filter(Boolean))
    const prev = lastSet.current

    const added: string[] = []
    next.forEach((c) => { if (!prev.has(c)) added.push(c) })
    const removed: string[] = []
    prev.forEach((c) => { if (!next.has(c)) removed.push(c) })

    if (added.length > 0) {
      fetch('/realtime/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: added }),
      }).catch(() => {})
    }
    if (removed.length > 0) {
      fetch('/realtime/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: removed }),
      }).catch(() => {})
    }
    lastSet.current = next
    // Note: codes 배열 자체는 매 렌더 새로 생기지만, 위 diff 로직이 idempotent라
    // 실 변경 없으면 added/removed 모두 빈 배열 → fetch 안 일어남.
  }, [codes])

  // 언마운트: 마지막 보유 코드 모두 unsubscribe
  useEffect(() => {
    return () => {
      const all = Array.from(lastSet.current)
      if (all.length > 0) {
        fetch('/realtime/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: all }),
        }).catch(() => {})
      }
      lastSet.current = new Set()
    }
  }, [])
}
