import { useState } from 'react'
import { useLpStore } from '@/stores/lpStore'

/**
 * Level 3 cost params 입력 패널.
 *   - 슬리피지(bp) / hold_days: 사용자가 자주 조정
 *   - 거래세(20bp) / 회사금리(2.8%): 회사 표준 — 표시만, 거의 안 바꿈
 */
export function CostInputsPanel() {
  const cost = useLpStore((s) => s.costInputs)
  const setCost = useLpStore((s) => s.setCostInputs)
  const [busy, setBusy] = useState(false)

  const update = (patch: Partial<typeof cost>) => setCost({ ...cost, ...patch })

  const save = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/lp/cost-inputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cost),
      })
      const c = await r.json()
      setCost(c)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-bg-primary p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[13px] text-t2 font-medium">Level 3 비용 입력</div>
        <button
          onClick={save}
          disabled={busy}
          className="text-xs px-3 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '저장 중' : '저장'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <label className="text-[11px] text-t3 block mb-1">슬리피지 (bp)</label>
          <input
            type="number"
            step="0.5"
            value={cost.slippage_bp}
            onChange={(e) => update({ slippage_bp: parseFloat(e.target.value) || 0 })}
            className="w-full bg-bg-base px-2 py-1 text-right tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
          />
        </div>
        <div>
          <label className="text-[11px] text-t3 block mb-1">보유 일수 (days)</label>
          <input
            type="number"
            step="1"
            value={cost.hold_days}
            onChange={(e) => update({ hold_days: parseInt(e.target.value) || 1 })}
            className="w-full bg-bg-base px-2 py-1 text-right tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
          />
        </div>
        <div>
          <label className="text-[11px] text-t3 block mb-1">이론가 금리 (연 %)</label>
          <input
            type="number"
            step="0.1"
            value={cost.base_rate_annual * 100}
            onChange={(e) =>
              update({ base_rate_annual: (parseFloat(e.target.value) || 0) / 100 })
            }
            className="w-full bg-bg-base px-2 py-1 text-right tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
          />
        </div>
        <div>
          <label className="text-[11px] text-t4 block mb-1">거래세 (회사 표준)</label>
          <div className="text-t3 tabular-nums px-2 py-1">{cost.tax_sell_bp.toFixed(2)} bp (매도)</div>
        </div>
      </div>

      <div className="mt-2 text-[10px] text-t4">
        매수 net = FV × (1 − slip − carry) · 매도 net = FV × (1 + carry − slip − 거래세)
        <br />
        carry = 이론가 금리 × hold_days / 365. 인포맥스 theoretical_basis의 내부 금리와는 별개.
      </div>
    </div>
  )
}
