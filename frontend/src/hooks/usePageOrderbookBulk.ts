import { useEffect, useRef } from 'react'

/**
 * 페이지별 일괄 호가 구독.
 *
 * 단일 모달용 `/realtime/orderbook/subscribe`와 별개로, 다수 종목 호가가
 * 필요한 ETF 스크리너 같은 화면용. mount/codes 변경 시 추가/제외 diff로
 * subscribe(추가분), 페이지 unmount 시 일괄 해제.
 *
 * 한계: unsubscribe는 현재 Rust API가 일괄 해제만 지원 → 다른 페이지에서
 * 호가 모달이 살아있다면 같이 끊김. 페이지 전환 시 모달은 보통 닫혀있어
 * 실용에 큰 문제 없음. 부분 해제가 필요해지면 Rust 측에 부분 unsubscribe
 * SubCommand 추가 필요.
 */
export function usePageOrderbookBulk(codes: string[]): void {
  const lastSet = useRef<Set<string>>(new Set())

  useEffect(() => {
    const next = new Set(codes.filter(Boolean))
    const prev = lastSet.current

    const added: string[] = []
    next.forEach((c) => { if (!prev.has(c)) added.push(c) })

    if (added.length > 0) {
      fetch('/realtime/orderbook/subscribe-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: added }),
      }).catch(() => {})
    }
    lastSet.current = next
  }, [codes])

  useEffect(() => {
    return () => {
      if (lastSet.current.size > 0) {
        fetch('/realtime/orderbook/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).catch(() => {})
      }
      lastSet.current = new Set()
    }
  }, [])
}
