import { useEffect, useState } from 'react'

import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import type { PairDetail } from '@/types/stat-arb'
import type { PositionCreatePayload } from '@/types/positions'

/**
 * 페어 상세에서 호출되는 포지션 등록 모달.
 *
 * PnL 시뮬레이터의 수량/매수가/방향/대여 송출/실시간 통계량을 prefill.
 * 양쪽 leg 각각 수량·진입가를 *개별 편집* — 시뮬레이터의 단순화(qty=right기준)와 달리
 * 실거래 후 기록이라 양쪽 따로 입력해야 정확.
 */
export function PositionEntryModal({
  open,
  onClose,
  detail,
  prefill,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  detail: PairDetail
  prefill: {
    buyRight: boolean                       // true: right 매수, false: left 매수
    rightQty: number                        // 시뮬레이터의 right qty
    buyPrice: number                        // 매수 leg 진입가
    sellPrice: number                       // 매도 leg 현재가 (실시간 또는 0)
    lendOutBuy: boolean                     // 매수분 대여송출 여부
    buyLoanRate: number                     // 매수 leg 대여요율 (0이면 미등록)
    entryZ: number                          // 진입 z (실시간 또는 DB)
    entryStats: {
      alpha: number
      beta: number
      half_life: number
      adf: number
      r2: number
    }
  }
  onSaved: (id: string) => void
}) {
  const beta = prefill.entryStats.beta
  const buyKey = prefill.buyRight ? detail.right_key : detail.left_key
  const sellKey = prefill.buyRight ? detail.left_key : detail.right_key
  const buyName = prefill.buyRight ? detail.right_name : detail.left_name
  const sellName = prefill.buyRight ? detail.left_name : detail.right_name

  // 폼 상태
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  // 매수 leg 수량/가격 — buyRight면 시뮬레이터 qty 그대로, 아니면 β×qty
  const [buyQty, setBuyQty] = useState(0)
  const [buyPrice, setBuyPrice] = useState(0)
  const [sellQty, setSellQty] = useState(0)
  const [sellPrice, setSellPrice] = useState(0)
  const [lendOut, setLendOut] = useState(false)
  const [loanQty, setLoanQty] = useState(0)
  const [loanRate, setLoanRate] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 모달 열릴 때마다 prefill (다른 페어로 이동 후 다시 열 수 있으니)
  useEffect(() => {
    if (!open) return
    // 매수 leg = right이면 qty=rightQty, 매수 leg = left이면 qty=|β|×rightQty
    const bq = prefill.buyRight ? prefill.rightQty : Math.max(1, Math.round(Math.abs(beta) * prefill.rightQty))
    const sq = prefill.buyRight ? Math.max(1, Math.round(Math.abs(beta) * prefill.rightQty)) : prefill.rightQty
    setBuyQty(bq)
    setBuyPrice(prefill.buyPrice)
    setSellQty(sq)
    setSellPrice(prefill.sellPrice)
    setLendOut(prefill.lendOutBuy && prefill.buyLoanRate > 0)
    setLoanQty(bq)
    setLoanRate(prefill.buyLoanRate)
    setLabel('')
    setNote('')
    setError(null)
  }, [open, prefill, beta])

  if (!open) return null

  const submit = async () => {
    setSubmitting(true)
    setError(null)

    const buyAssetRaw = keyType(buyKey)
    const sellAssetRaw = keyType(sellKey)
    if (buyAssetRaw === 'unknown' || sellAssetRaw === 'unknown') {
      setError(`series_key 포맷 오류: ${buyKey} / ${sellKey}`)
      setSubmitting(false)
      return
    }
    const buyAsset = buyAssetRaw
    const sellAsset = sellAssetRaw
    const payload: PositionCreatePayload = {
      label: label.trim() || undefined,
      note: note.trim() || undefined,
      left_key: detail.left_key,
      right_key: detail.right_key,
      entry_z: prefill.entryZ,
      entry_stats: {
        alpha: prefill.entryStats.alpha,
        beta: prefill.entryStats.beta,
        half_life: prefill.entryStats.half_life,
        adf: prefill.entryStats.adf,
        r2: prefill.entryStats.r2,
      },
      legs: [
        {
          asset_type: buyAsset,
          code: keyToCode(buyKey),
          side: 1,
          weight: 1.0,
          qty: buyQty,
          entry_price: buyPrice,
          loan:
            lendOut && loanQty > 0 && loanRate > 0
              ? { qty: loanQty, rate_pct: loanRate }
              : undefined,
        },
        {
          asset_type: sellAsset,
          code: keyToCode(sellKey),
          side: -1,
          weight: Math.abs(beta),
          qty: sellQty,
          entry_price: sellPrice,
        },
      ],
    }

    try {
      const r = await fetch('/api/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) {
        const body = await r.text()
        throw new Error(`HTTP ${r.status}: ${body}`)
      }
      const saved = (await r.json()) as { id: string }
      onSaved(saved.id)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded bg-bg-primary p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-t1">포지션 진입 기록</span>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-t3 hover:text-t1"
          >
            ✕
          </button>
        </div>

        <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs">
          <div className="text-t3">페어</div>
          <div className="mt-0.5 text-t1">
            {detail.left_name} ↔ {detail.right_name}
          </div>
          <div className="mt-0.5 text-[10px] text-t4">
            진입 z = {prefill.entryZ.toFixed(2)} · β = {beta.toFixed(4)} ·
            half-life = {prefill.entryStats.half_life.toFixed(1)}d
          </div>
        </div>

        {/* 매수 / 매도 leg 입력 */}
        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          {/* 매수 leg */}
          <div className="rounded-sm bg-bg-surface px-3 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-up font-medium">매수 (long)</span>
              <span className="text-[10px] text-t4">{keyToCode(buyKey)}</span>
            </div>
            <div className="mb-1 text-t1">{buyName}</div>
            <label className="mb-1 flex flex-col gap-0.5">
              <span className="text-t3">수량</span>
              <input
                type="number"
                value={buyQty}
                onChange={(e) => setBuyQty(Math.max(0, parseInt(e.target.value) || 0))}
                className="rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-t3">진입가</span>
              <input
                type="number"
                value={buyPrice}
                onChange={(e) => setBuyPrice(Math.max(0, parseInt(e.target.value) || 0))}
                className="rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none"
              />
            </label>
          </div>

          {/* 매도 leg */}
          <div className="rounded-sm bg-bg-surface px-3 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-down font-medium">매도 (short)</span>
              <span className="text-[10px] text-t4">{keyToCode(sellKey)}</span>
            </div>
            <div className="mb-1 text-t1">{sellName}</div>
            <label className="mb-1 flex flex-col gap-0.5">
              <span className="text-t3">수량</span>
              <input
                type="number"
                value={sellQty}
                onChange={(e) => setSellQty(Math.max(0, parseInt(e.target.value) || 0))}
                className="rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-t3">진입가</span>
              <input
                type="number"
                value={sellPrice}
                onChange={(e) => setSellPrice(Math.max(0, parseInt(e.target.value) || 0))}
                className="rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none"
              />
            </label>
          </div>
        </div>

        {/* 대여 송출 (매수분) */}
        <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={lendOut}
              onChange={(e) => setLendOut(e.target.checked)}
              className="accent-accent"
            />
            <span className="text-t1">매수분 대여 송출</span>
          </label>
          {lendOut && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-0.5">
                <span className="text-t3">대여 수량</span>
                <input
                  type="number"
                  value={loanQty}
                  onChange={(e) => setLoanQty(Math.max(0, parseInt(e.target.value) || 0))}
                  className="rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-0.5">
                <span className="text-t3">요율 (%)</span>
                <input
                  type="number"
                  step="0.1"
                  value={loanRate}
                  onChange={(e) => setLoanRate(Math.max(0, parseFloat(e.target.value) || 0))}
                  className="rounded-sm bg-bg-primary px-2 py-1 text-t1 focus:outline-none"
                />
              </label>
            </div>
          )}
        </div>

        {/* 라벨 / 노트 */}
        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          <label className="flex flex-col gap-0.5">
            <span className="text-t3">라벨 (선택)</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="예: 반도체 페어 1차"
              className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-t3">노트 (선택)</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="진입 근거 등"
              className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
            />
          </label>
        </div>

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
            disabled={submitting || buyQty <= 0 || sellQty <= 0 || buyPrice <= 0 || sellPrice <= 0}
            className="rounded-sm bg-accent/20 px-3 py-1.5 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {submitting ? '저장 중…' : '진입 기록'}
          </button>
        </div>
      </div>
    </div>
  )
}
