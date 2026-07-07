import { useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import type { QuoteParams } from '@/types/lp'

/**
 * 호가 제안 파라미터 입력 (§13.3-A) — GET/POST /api/lp/quote-params.
 *   base_spread / γ / 역선택 버퍼 / 헤지비용 / 재고 한도(억) / 선물 여력.
 * 저장 → Rust scheduler가 5초 poll로 반영 (즉시 아님).
 *
 * 전 필드 backend에서 ge=0 검증 — 음수는 bid>ask 역전을 만들어 무의미. 입력 단계에서 0 클램프.
 */
export function QuoteParamsPanel() {
  const params = useLpStore((s) => s.quoteParams)
  const setParams = useLpStore((s) => s.setQuoteParams)
  const universe = useLpStore((s) => s.quoteUniverse)
  const [busy, setBusy] = useState(false)
  const [showOverrides, setShowOverrides] = useState(false)

  const update = (patch: Partial<QuoteParams>) => setParams({ ...params, ...patch })

  const save = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/lp/quote-params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (r.ok) setParams(await r.json())
    } finally {
      setBusy(false)
    }
  }

  const codes = Object.keys(universe)
  const overrideCount = Object.keys(params.inventory_limit_overrides).length

  return (
    <div className="bg-bg-primary p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[13px] text-t2 font-medium">호가 파라미터 (§13.3-A)</div>
        <button
          onClick={save}
          disabled={busy}
          className="text-xs px-3 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '저장 중' : '저장'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <NumField
          label="기본 반스프레드 (bp)"
          value={params.base_spread_bp}
          step={0.5}
          onChange={(v) => update({ base_spread_bp: v })}
        />
        <NumField
          label="재고 skew 강도 γ"
          value={params.gamma}
          step={0.1}
          onChange={(v) => update({ gamma: v })}
        />
        <NumField
          label="역선택 버퍼 (bp)"
          value={params.adverse_buffer_bp}
          step={0.5}
          onChange={(v) => update({ adverse_buffer_bp: v })}
        />
        <NumField
          label="헤지 비용 (bp)"
          value={params.hedge_cost_bp}
          step={0.5}
          onChange={(v) => update({ hedge_cost_bp: v })}
        />
        <NumField
          label="ETF별 재고 한도 (억)"
          value={params.per_etf_inventory_limit_krw / 1e8}
          step={1}
          onChange={(v) => update({ per_etf_inventory_limit_krw: v * 1e8 })}
        />
        <NumField
          label="선물 헤지 여력 (계약)"
          value={params.max_futures_contracts}
          step={1}
          integer
          onChange={(v) => update({ max_futures_contracts: v })}
        />
        <NumField
          label="베이시스 임계 (bp, §13.4)"
          value={params.basis_threshold_bp}
          step={0.5}
          onChange={(v) => update({ basis_threshold_bp: v })}
        />
      </div>

      {codes.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowOverrides((s) => !s)}
            className="text-[11px] text-t3 hover:text-t2"
          >
            {showOverrides ? '▾' : '▸'} ETF별 한도 override
            {overrideCount > 0 && (
              <span className="text-blue ml-1">({overrideCount})</span>
            )}
          </button>
          {showOverrides && (
            <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
              {codes.map((code) => {
                const meta = universe[code]
                const ovKrw = params.inventory_limit_overrides[code]
                return (
                  <div key={code} className="flex items-center gap-2 text-[11px]">
                    <span className="text-t3 tabular-nums w-14 shrink-0">{code}</span>
                    <span className="text-t4 truncate flex-1 min-w-0">
                      {meta?.name ?? ''}
                    </span>
                    <input
                      type="number"
                      step={1}
                      min={0}
                      placeholder="기본"
                      value={ovKrw != null ? ovKrw / 1e8 : ''}
                      onChange={(e) => {
                        const next = { ...params.inventory_limit_overrides }
                        const raw = e.target.value
                        if (raw === '') delete next[code]
                        else next[code] = Math.max(0, parseFloat(raw) || 0) * 1e8
                        update({ inventory_limit_overrides: next })
                      }}
                      className="w-16 bg-bg-base px-1.5 py-0.5 text-right tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
                    />
                    <span className="text-t4 w-4">억</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 text-[10px] text-t4">
        요구엣지 = 기본 + 버퍼 + 잔차 charge ∓ skew(−γ·q억·σ%²·h). 헤지비용은 가격 미반영(수익성용).
        <br />
        저장 시 Rust 스케줄러가 <span className="text-t3">5초 내</span> poll로 반영. 전 값 0 이상.
      </div>
    </div>
  )
}

function NumField({
  label,
  value,
  step,
  integer,
  onChange,
}: {
  label: string
  value: number
  step: number
  integer?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div>
      <label className="text-[11px] text-t3 block mb-1">{label}</label>
      <input
        type="number"
        step={step}
        min={0}
        value={value}
        onChange={(e) => {
          const raw = integer ? parseInt(e.target.value) : parseFloat(e.target.value)
          onChange(Math.max(0, raw || 0))
        }}
        className="w-full bg-bg-base px-2 py-1 text-right tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
      />
    </div>
  )
}
