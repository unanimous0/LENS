import { useEffect } from 'react'

/**
 * 외부망 ETF 거래대금 폴링 구독 (`/realtime/subscribe-volumes`).
 *
 * realtime이 받은 코드 셋을 t8407(키B REST)로 30초마다 폴링 → VolumeTick(거래대금)을
 * WS로 broadcast → marketStore.pollVolumes에 누적 → 전체 ETF 순위 매기기.
 *
 * 핵심: REST 폴링이라 키A WS 연결을 안 먹는다 → 표시 50개만 WS 실시간 구독해도,
 *   거래대금만큼은 전체(185)를 받아 순위가 장중 변동을 따라간다.
 *
 * replace 시맨틱 — 받은 codes로 폴링 대상을 통째 교체. WS 0연결이라 client_id 추적 불필요.
 * unmount 시 빈 셋을 보내 폴링 중지.
 */
export function usePageVolumePolling(codes: string[]): void {
  const key = codes.join(',')
  useEffect(() => {
    const list = codes.filter(Boolean)
    fetch('/realtime/subscribe-volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: list }),
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    return () => {
      fetch('/realtime/subscribe-volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: [] }),
      }).catch(() => {})
    }
  }, [])
}
