import { useEffect } from 'react'
import { useLpStore } from '../stores/lpStore'
import type { QuoteUniverseMeta } from '../types/lp'

/**
 * /lp-matrix 페이지 mount 시 1회 초기 fetch.
 * - /api/lp/positions: 저장된 포지션 (없으면 빈 dict)
 * - /api/lp/cost-inputs: 거래세/금리/슬리피지/hold_days
 * - /api/lp/quote-params: 호가 제안 파라미터 (§13.3-A)
 * - /api/lp/matrix-config: quote_universe(배수/β/family) — 호가 모드 뱃지·override용
 *
 * matrix · book_risk · quote_board는 WS로 자동 수신.
 */
export function useLpInit() {
  useEffect(() => {
    fetch('/api/lp/positions')
      .then((r) => r.json())
      .then((d) =>
        useLpStore.getState().setPositions(d.positions || {}, d.updated_at)
      )
      .catch(() => {})
    // 북 원장(§13.5): 엔트리 + 집계
    fetch('/api/lp/ledger')
      .then((r) => r.json())
      .then((d) => useLpStore.getState().setLedger(d))
      .catch(() => {})
    fetch('/api/lp/cost-inputs')
      .then((r) => r.json())
      .then((c) => useLpStore.getState().setCostInputs(c))
      .catch(() => {})
    fetch('/api/lp/quote-params')
      .then((r) => r.json())
      .then((p) => useLpStore.getState().setQuoteParams(p))
      .catch(() => {})
    // 호가 모드 뱃지(배수/β)·재고한도 override 편집은 quote_universe 메타가 필요.
    // QuoteRow엔 leverage/beta가 없으므로 matrix-config에서 code→meta 맵을 1회 로드.
    fetch('/api/lp/matrix-config')
      .then((r) => r.json())
      .then((cfg) => {
        const list: QuoteUniverseMeta[] = cfg?.quote_universe ?? []
        const map: Record<string, QuoteUniverseMeta> = {}
        for (const u of list) map[u.code] = u
        useLpStore.getState().setQuoteUniverse(map)
      })
      .catch(() => {})
    fetch('/api/lp/corporate-actions-today')
      .then((r) => r.json())
      .then((d) =>
        useLpStore.getState().setCorporateActionsToday(d.items || [])
      )
      .catch(() => {})
  }, [])
}
