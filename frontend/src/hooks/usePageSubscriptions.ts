import { useEffect, useRef } from 'react'

/**
 * 선물(JC0) 월물 구독 — **replace 시맨틱** 전용 훅.
 *
 * 백엔드 `/realtime/subscribe`(`SubCommand::Subscribe`)는 받은 코드 셋으로 선물 연결을
 * **통째 교체**한다(현재 연결 cancel → 새 셋으로 재연결). 같은 셋이면 서버가 no-op 처리.
 *
 * 그래서 여기서는 add/remove diff를 하지 않고 **항상 전체 codes를 그대로 /subscribe로** 보낸다.
 * 과거엔 stocks용 ref-count(add/remove) 패턴을 그대로 썼는데, 월물 전환 시
 *   added(원월물) → /subscribe (원월물 연결 spawn)
 *   removed(근월물) → /unsubscribe → futures_cancel.cancel() → 방금 띄운 원월물까지 kill
 * 이 되어 "원월물 데이터 안 들어옴" 버그가 났다. /unsubscribe는 페이지 이탈 시에만 보낸다.
 *
 * 동일 코드 셋은 join(',') 키로 effect 재실행을 막아 중복 전환을 피한다(서버 no-op과 이중 방어).
 */
export function usePageSubscriptions(codes: string[]): void {
  const key = codes.filter(Boolean).slice().sort().join(',')
  const sentRef = useRef(false)

  useEffect(() => {
    const list = codes.filter(Boolean)
    if (list.length === 0) return
    fetch('/realtime/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: list }),
    }).catch(() => {})
    sentRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // 언마운트: 선물 연결 해제 (장 외 누적 방지)
  useEffect(() => {
    return () => {
      if (!sentRef.current) return
      fetch('/realtime/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: [] }),
      }).catch(() => {})
    }
  }, [])
}
