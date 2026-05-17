import { useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import { useMarketStore } from '@/stores/marketStore'

/**
 * 포지션 수동 입력 패널.
 * 종목 코드(6자리) + 부호있는 수량 입력 → 추가/삭제 → 저장 버튼으로 POST.
 * 첫 빌드는 가상 북도 OK — #2 #3 산출 검증 목적.
 */
export function PositionEntry() {
  const positions = useLpStore((s) => s.positions)
  const setPositions = useLpStore((s) => s.setPositions)
  const updatedAt = useLpStore((s) => s.positionsUpdatedAt)

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const etfTicks = useMarketStore((s) => s.etfTicks)

  const [code, setCode] = useState('')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)

  const add = () => {
    const c = code.trim()
    const q = parseInt(qty, 10)
    if (!c || !Number.isFinite(q) || q === 0) return
    const next = { ...positions, [c]: (positions[c] || 0) + q }
    if (next[c] === 0) delete next[c]
    setPositions(next, updatedAt)
    setCode('')
    setQty('')
  }
  const remove = (c: string) => {
    const next = { ...positions }
    delete next[c]
    setPositions(next, updatedAt)
  }
  const save = async () => {
    setBusy(true)
    try {
      const r = await fetch('/api/lp/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions }),
      })
      const d = await r.json()
      setPositions(d.positions || {}, d.updated_at)
    } finally {
      setBusy(false)
    }
  }

  const getPrice = (c: string): number => {
    return stockTicks[c]?.price || etfTicks[c]?.price || 0
  }
  const fmt = (n: number) => {
    const abs = Math.abs(n)
    if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}억`
    if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`
    return Math.round(n).toLocaleString('ko-KR')
  }

  const entries = Object.entries(positions)

  return (
    <div className="bg-bg-primary p-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[13px] text-t2 font-medium">포지션 (수동)</div>
          <div className="text-[10px] text-t4">
            {updatedAt ? `최종 저장: ${updatedAt}` : '저장 안 됨 (가상 북)'}
          </div>
        </div>
        <button
          onClick={save}
          disabled={busy}
          className="text-xs px-3 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '저장 중' : '저장'}
        </button>
      </div>

      <div className="flex gap-1 mb-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="코드 (6자리)"
          className="flex-1 bg-bg-base px-2 py-1 text-xs tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
        />
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="수량 (음수=숏)"
          type="text"
          className="w-32 bg-bg-base px-2 py-1 text-xs tabular-nums text-right text-t1 outline-none focus:border-accent border border-transparent"
        />
        <button
          onClick={add}
          className="text-xs px-3 py-1 bg-bg-surface text-t2 hover:text-t1"
        >+</button>
      </div>

      <table className="w-full text-[11px]">
        <thead className="text-t4 text-[10px]">
          <tr>
            <th className="text-left py-1">코드</th>
            <th className="text-right py-1">수량</th>
            <th className="text-right py-1">현재가</th>
            <th className="text-right py-1">노출</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center text-t4 py-2 text-xs">
                포지션 없음
              </td>
            </tr>
          )}
          {entries.map(([c, q]) => {
            const p = getPrice(c)
            const exp = q * p
            return (
              <tr key={c} className="border-t border-bg-base/40">
                <td className="py-1 text-t2">{c}</td>
                <td className="py-1 text-right" style={{ color: q > 0 ? '' : 'var(--color-down)' }}>{q.toLocaleString('ko-KR')}</td>
                <td className="py-1 text-right text-t3">{p > 0 ? p.toLocaleString('ko-KR') : '-'}</td>
                <td className="py-1 text-right" style={{ color: exp > 0 ? '' : 'var(--color-down)' }}>{p > 0 ? fmt(exp) : '-'}</td>
                <td className="py-1 text-right">
                  <button
                    onClick={() => remove(c)}
                    className="text-[10px] text-t4 hover:text-down px-1"
                  >×</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
