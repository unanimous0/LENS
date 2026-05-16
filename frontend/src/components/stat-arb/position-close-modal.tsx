import { useEffect, useState } from 'react'

import type { Position } from '@/types/positions'

/**
 * 포지션 청산 모달. 양쪽 leg exit_price를 실시간 가격 prefill로 입력.
 * 저장 시 POST /api/positions/:id/close → status='closed', closed_at 박힘.
 */
export function PositionCloseModal({
  open,
  onClose,
  position,
  livePriceByLegId,
  onClosed,
}: {
  open: boolean
  onClose: () => void
  position: Position
  /** leg.id → 실시간 가격 (없으면 0). prefill용 */
  livePriceByLegId: Record<number, number>
  onClosed: (updated: Position) => void
}) {
  const legs = position.legs ?? []
  const [exitPrices, setExitPrices] = useState<Record<number, number>>({})
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const init: Record<number, number> = {}
    for (const l of legs) {
      const live = livePriceByLegId[l.id] ?? 0
      init[l.id] = live > 0 ? live : l.entry_price
    }
    setExitPrices(init)
    setNote(position.note ?? '')
    setError(null)
  }, [open, position, legs, livePriceByLegId])

  if (!open) return null

  // 미리보기 PnL
  let previewMark = 0
  for (const l of legs) {
    const exit = exitPrices[l.id] ?? 0
    if (exit > 0) previewMark += (exit - l.entry_price) * l.side * l.qty
  }

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    const body = {
      legs: legs.map((l) => ({ leg_id: l.id, exit_price: exitPrices[l.id] ?? 0 })),
      note: note.trim() || undefined,
    }
    try {
      const r = await fetch(`/api/positions/${position.id}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        // FastAPI 에러 응답 {"detail": "..."} 파싱 (가독성)
        let msg = `HTTP ${r.status}`
        try {
          const body = (await r.json()) as { detail?: string }
          if (body.detail) msg = body.detail
        } catch {
          msg = `HTTP ${r.status}: ${await r.text()}`
        }
        throw new Error(msg)
      }
      const updated = (await r.json()) as Position
      onClosed(updated)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const allValid = legs.every((l) => (exitPrices[l.id] ?? 0) > 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded bg-bg-primary p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-t1">포지션 청산</span>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-t3 hover:text-t1"
          >
            ✕
          </button>
        </div>

        <div className="mb-3 grid grid-cols-1 gap-2">
          {legs.map((l) => {
            const live = livePriceByLegId[l.id] ?? 0
            const exit = exitPrices[l.id] ?? 0
            const legPnL = exit > 0 ? (exit - l.entry_price) * l.side * l.qty : 0
            return (
              <div key={l.id} className="rounded-sm bg-bg-surface px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-t1">
                    {l.code}{' '}
                    <span className={l.side > 0 ? 'text-up' : 'text-down'}>
                      ({l.side > 0 ? '매수' : '매도'} {l.qty.toLocaleString()})
                    </span>
                  </span>
                  <span className="text-[10px] text-t4">
                    진입 {l.entry_price.toLocaleString()}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-t3">청산가</span>
                  <input
                    type="number"
                    value={exit || ''}
                    onChange={(e) =>
                      setExitPrices((p) => ({
                        ...p,
                        [l.id]: Math.max(0, parseInt(e.target.value) || 0),
                      }))
                    }
                    className="flex-1 rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none tabular-nums"
                  />
                  {live > 0 && live !== exit && (
                    <button
                      type="button"
                      onClick={() => setExitPrices((p) => ({ ...p, [l.id]: live }))}
                      className="text-[10px] text-accent hover:underline"
                    >
                      현재가 {live.toLocaleString()}
                    </button>
                  )}
                </div>
                <div className="mt-1 text-right text-[11px] tabular-nums">
                  Leg PnL:{' '}
                  <span
                    className={
                      legPnL > 0 ? 'text-up' : legPnL < 0 ? 'text-down' : 'text-t3'
                    }
                  >
                    {legPnL >= 0 ? '+' : ''}
                    {Math.round(legPnL).toLocaleString('ko-KR')}원
                  </span>
                </div>
              </div>
            )
          })}
        </div>

        <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs tabular-nums">
          <div className="flex items-center justify-between">
            <span className="text-t3">확정 평가손익 (대여 별도)</span>
            <span
              className={`font-semibold ${
                previewMark > 0 ? 'text-up' : previewMark < 0 ? 'text-down' : 'text-t3'
              }`}
            >
              {previewMark >= 0 ? '+' : ''}
              {Math.round(previewMark).toLocaleString('ko-KR')}원
            </span>
          </div>
          {position.loans && position.loans.length > 0 && (
            <div className="mt-1 text-[10px] text-t4">
              대여 송출 {position.loans.length}건 — 청산 시 자동 종료 (ended_at)
            </div>
          )}
        </div>

        <label className="mb-3 flex flex-col gap-0.5 text-xs">
          <span className="text-t3">청산 메모 (선택, 기존 노트를 덮어씀)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="청산 사유 등"
            className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
          />
        </label>

        {error && (
          <div className="mb-3 rounded-sm bg-down/10 px-3 py-2 text-xs text-down">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-sm bg-bg-surface px-3 py-1.5 text-xs text-t2 hover:text-t1 disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !allValid}
            className="rounded-sm bg-down/20 px-3 py-1.5 text-xs text-down hover:bg-down/30 disabled:opacity-50"
          >
            {submitting ? '청산 중…' : '청산 기록'}
          </button>
        </div>
      </div>
    </div>
  )
}
