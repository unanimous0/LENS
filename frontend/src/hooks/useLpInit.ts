import { useEffect } from 'react'
import { useLpStore } from '../stores/lpStore'

/**
 * /lp-matrix 페이지 mount 시 1회 초기 fetch.
 * - /api/lp/positions: 저장된 포지션 (없으면 빈 dict)
 * - /api/lp/cost-inputs: 거래세/금리/슬리피지/hold_days
 *
 * matrix · book_risk는 WS로 자동 수신.
 */
export function useLpInit() {
  useEffect(() => {
    fetch('/api/lp/positions')
      .then((r) => r.json())
      .then((d) =>
        useLpStore.getState().setPositions(d.positions || {}, d.updated_at)
      )
      .catch(() => {})
    fetch('/api/lp/cost-inputs')
      .then((r) => r.json())
      .then((c) => useLpStore.getState().setCostInputs(c))
      .catch(() => {})
  }, [])
}
