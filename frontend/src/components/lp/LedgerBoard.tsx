import { useMemo, useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import { useMarketStore } from '@/stores/marketStore'
import { LEDGER_GROUPS, type LedgerAggregate, type LedgerInstrument } from '@/types/lp'

/**
 * 북 원장 보드 (§13.5 Phase 1).
 *
 * 이월(carryover) + 당일 체결(fill)을 자산유형별로 한눈에. GET /api/lp/ledger 집계를
 * 그룹핑해서 표시하고, 하단에 당일 체결 로그 + 체결 입력 폼.
 * 현재가는 marketStore(etf/stock/futures)에서, 선물은 시세 없으면 '-'.
 */

const fmtQty = (n: number) => n.toLocaleString('ko-KR')
const fmtPx = (n: number | null) =>
  n == null ? '-' : n.toLocaleString('ko-KR', { maximumFractionDigits: 2 })

function fmtNotional(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}만`
  return Math.round(n).toLocaleString('ko-KR')
}

async function refreshLedger() {
  try {
    const r = await fetch('/api/lp/ledger')
    const d = await r.json()
    useLpStore.getState().setLedger(d)
  } catch {
    /* noop */
  }
}

export function LedgerBoard() {
  const aggregates = useLpStore((s) => s.ledgerAggregates)
  const entries = useLpStore((s) => s.ledgerEntries)
  const updatedAt = useLpStore((s) => s.ledgerUpdatedAt)

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const etfTicks = useMarketStore((s) => s.etfTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)

  const priceOf = (code: string, instrument: LedgerInstrument): number => {
    if (instrument === 'etf') return etfTicks[code]?.price || 0
    if (instrument === 'stock') return stockTicks[code]?.price || 0
    // index_fut / stock_fut
    return futuresTicks[code]?.price || 0
  }

  // 자산유형별 그룹 + 노출 합계
  const grouped = useMemo(() => {
    const byInst: Record<string, LedgerAggregate[]> = {}
    for (const a of aggregates) (byInst[a.instrument] ??= []).push(a)
    let longExp = 0
    let shortExp = 0
    for (const a of aggregates) {
      const p = priceOf(a.code, a.instrument)
      if (p > 0) {
        const exp = a.net_qty * p
        if (exp > 0) longExp += exp
        else shortExp += exp
      }
    }
    return { byInst, longExp, shortExp }
    // priceOf는 tick 참조 — ticks 변경 시 재계산 필요
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aggregates, stockTicks, etfTicks, futuresTicks])

  return (
    <div className="flex flex-col gap-1">
      {/* 상단 요약 스트립 */}
      <div className="bg-bg-primary p-3 flex items-center gap-6">
        <div>
          <div className="text-[13px] text-t2 font-medium">북 원장</div>
          <div className="text-[10px] text-t4">
            {updatedAt ? `최종 갱신: ${updatedAt.replace('T', ' ')}` : '엔트리 없음'}
          </div>
        </div>
        <div className="flex-1 grid grid-cols-3 gap-3 font-mono tabular-nums">
          <Summary label="총 롱 노출" value={grouped.longExp} tone="up" />
          <Summary label="총 숏 노출" value={grouped.shortExp} tone="down" />
          <Summary label="순 노출" value={grouped.longExp + grouped.shortExp} tone="net" />
        </div>
      </div>

      {/* 자산유형별 그룹 테이블 */}
      <div className="bg-bg-primary p-3">
        <table className="w-full text-[11px]">
          <thead className="text-t4 text-[10px]">
            <tr>
              <th className="text-left py-1 font-normal">코드 / 이름</th>
              <th className="text-right py-1 font-normal">이월</th>
              <th className="text-right py-1 font-normal">당일 체결</th>
              <th className="text-right py-1 font-normal">순 수량</th>
              <th className="text-right py-1 font-normal">평단</th>
              <th className="text-right py-1 font-normal">현재가</th>
              <th className="text-right py-1 font-normal">평가 노출</th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {aggregates.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-t4 py-3 text-xs">
                  원장 비어 있음 — 아래에서 체결/이월 입력
                </td>
              </tr>
            )}
            {LEDGER_GROUPS.map((g) => {
              const rows = grouped.byInst[g.instrument]
              if (!rows || rows.length === 0) return null
              return (
                <GroupSection
                  key={g.instrument}
                  label={g.label}
                  rows={rows}
                  priceOf={priceOf}
                  onDelete={refreshLedger}
                />
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 체결 입력 폼 + 당일 체결 로그 */}
      <div className="grid grid-cols-2 gap-1">
        <EntryForm />
        <FillLog entries={entries} />
      </div>
    </div>
  )
}

function Summary({ label, value, tone }: { label: string; value: number; tone: 'up' | 'down' | 'net' }) {
  const color =
    tone === 'up'
      ? 'var(--color-up)'
      : tone === 'down'
        ? 'var(--color-down)'
        : value >= 0
          ? 'var(--color-up)'
          : 'var(--color-down)'
  return (
    <div>
      <div className="text-[10px] text-t4">{label}</div>
      <div className="text-[15px]" style={{ color }}>
        {fmtNotional(value)}
      </div>
    </div>
  )
}

function GroupSection({
  label,
  rows,
  priceOf,
  onDelete,
}: {
  label: string
  rows: LedgerAggregate[]
  priceOf: (code: string, instrument: LedgerInstrument) => number
  onDelete: () => void
}) {
  const del = async (agg: LedgerAggregate) => {
    if (!confirm(`${agg.code} 이월(carryover) 삭제? (당일 체결은 유지)`)) return
    await fetch('/api/lp/ledger/carryover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: agg.code, qty: 0, instrument: agg.instrument }),
    })
    onDelete()
  }
  return (
    <>
      <tr>
        <td colSpan={8} className="pt-2 pb-1 text-[10px] text-t3 uppercase tracking-wide">
          {label}
        </td>
      </tr>
      {rows.map((a) => {
        const p = priceOf(a.code, a.instrument)
        const exp = a.net_qty * p
        const qtyColor = (q: number) =>
          q > 0 ? '' : q < 0 ? 'var(--color-down)' : 'var(--color-t4)'
        return (
          <tr key={a.code} className="border-t border-bg-base/40">
            <td className="py-1 text-t2">
              <span className="text-t1">{a.code}</span>
              {a.name && <span className="text-t4 ml-1 text-[10px]">{a.name}</span>}
            </td>
            <td className="py-1 text-right text-t3">{fmtQty(a.carryover_qty)}</td>
            <td className="py-1 text-right" style={{ color: qtyColor(a.fills_qty_today) }}>
              {a.fills_qty_today > 0 ? `+${fmtQty(a.fills_qty_today)}` : fmtQty(a.fills_qty_today)}
            </td>
            <td className="py-1 text-right font-medium" style={{ color: qtyColor(a.net_qty) }}>
              {fmtQty(a.net_qty)}
            </td>
            <td className="py-1 text-right text-t3">{fmtPx(a.avg_price)}</td>
            <td className="py-1 text-right text-t3">{p > 0 ? p.toLocaleString('ko-KR') : '-'}</td>
            <td className="py-1 text-right" style={{ color: exp === 0 ? 'var(--color-t4)' : exp > 0 ? '' : 'var(--color-down)' }}>
              {p > 0 ? fmtNotional(exp) : '-'}
            </td>
            <td className="py-1 text-right">
              <button
                onClick={() => del(a)}
                title="이월 삭제"
                className="text-[10px] text-t4 hover:text-down px-1"
              >
                ×
              </button>
            </td>
          </tr>
        )
      })}
    </>
  )
}

function EntryForm() {
  const [code, setCode] = useState('')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [kind, setKind] = useState<'fill' | 'carryover'>('fill')
  const [qty, setQty] = useState('')
  const [price, setPrice] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    const c = code.trim()
    const q = parseInt(qty, 10)
    const p = price.trim() ? parseFloat(price) : null
    if (!c || !Number.isFinite(q) || q <= 0) {
      setErr('코드·수량(양수) 필수')
      return
    }
    setBusy(true)
    setErr('')
    try {
      let r: Response
      if (kind === 'carryover') {
        // 이월: 부호있는 수량으로 일괄 세팅 (기존 이월 교체)
        const signed = side === 'buy' ? q : -q
        r = await fetch('/api/lp/ledger/carryover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: c, qty: signed, price: p, note: note || null }),
        })
      } else {
        r = await fetch('/api/lp/ledger/entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: c, side, qty: q, price: p, note: note || null, kind: 'fill' }),
        })
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setErr(typeof d.detail === 'string' ? d.detail : '입력 실패')
        return
      }
      await refreshLedger()
      setCode('')
      setQty('')
      setPrice('')
      setNote('')
    } finally {
      setBusy(false)
    }
  }

  const tabBtn = (active: boolean, extra = '') =>
    `text-[11px] px-3 py-1 ${active ? 'bg-bg-surface text-t1' : 'bg-bg-base text-t4 hover:text-t2'} ${extra}`

  return (
    <div className="bg-bg-primary p-3">
      <div className="text-[12px] text-t2 font-medium mb-2">체결 / 이월 입력</div>

      <div className="flex gap-1 mb-2">
        <button
          onClick={() => setSide('buy')}
          className={tabBtn(side === 'buy')}
          style={side === 'buy' ? { color: 'var(--color-up)' } : {}}
        >
          매수
        </button>
        <button
          onClick={() => setSide('sell')}
          className={tabBtn(side === 'sell')}
          style={side === 'sell' ? { color: 'var(--color-down)' } : {}}
        >
          매도
        </button>
        <div className="w-2" />
        <button onClick={() => setKind('fill')} className={tabBtn(kind === 'fill')}>
          체결
        </button>
        <button onClick={() => setKind('carryover')} className={tabBtn(kind === 'carryover')}>
          이월
        </button>
      </div>

      <div className="flex gap-1 mb-1">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="코드 (자유 입력)"
          className="flex-1 bg-bg-base px-2 py-1 text-[11px] tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
        />
        <input
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="수량"
          className="w-24 bg-bg-base px-2 py-1 text-[11px] tabular-nums text-right text-t1 outline-none focus:border-accent border border-transparent"
        />
        <input
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="가격"
          className="w-24 bg-bg-base px-2 py-1 text-[11px] tabular-nums text-right text-t1 outline-none focus:border-accent border border-transparent"
        />
      </div>

      <div className="flex gap-1">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="메모 (선택)"
          className="flex-1 bg-bg-base px-2 py-1 text-[11px] text-t2 outline-none focus:border-accent border border-transparent"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="text-[11px] px-4 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
        >
          {busy ? '...' : '추가'}
        </button>
      </div>
      {err && <div className="text-[10px] text-down mt-1">{err}</div>}
      <div className="text-[10px] text-t4 mt-1">
        {kind === 'carryover'
          ? '이월: 해당 코드 기존 이월을 이 수량으로 교체 (당일 체결 보존)'
          : '체결: 당일 체결 로그에 누적'}
      </div>
    </div>
  )
}

function FillLog({ entries }: { entries: import('@/types/lp').LedgerEntry[] }) {
  const del = async (id: string) => {
    await fetch(`/api/lp/ledger/entry/${id}`, { method: 'DELETE' })
    await refreshLedger()
  }
  return (
    <div className="bg-bg-primary p-3">
      <div className="text-[12px] text-t2 font-medium mb-2">체결 로그 (최신순)</div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead className="text-t4 text-[10px] sticky top-0 bg-bg-primary">
            <tr>
              <th className="text-left py-1 font-normal">시각</th>
              <th className="text-left py-1 font-normal">코드</th>
              <th className="text-center py-1 font-normal">방향</th>
              <th className="text-right py-1 font-normal">수량</th>
              <th className="text-right py-1 font-normal">가격</th>
              <th className="text-left py-1 font-normal pl-2">메모</th>
              <th className="w-6"></th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {entries.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-t4 py-3 text-xs">
                  엔트리 없음
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-bg-base/40">
                <td className="py-1 text-t4 text-[10px]">{e.ts.slice(5, 16).replace('T', ' ')}</td>
                <td className="py-1 text-t2">
                  {e.code}
                  {e.kind === 'carryover' && (
                    <span className="text-t4 ml-1 text-[9px]">이월</span>
                  )}
                </td>
                <td
                  className="py-1 text-center"
                  style={{ color: e.side === 'buy' ? 'var(--color-up)' : 'var(--color-down)' }}
                >
                  {e.side === 'buy' ? '매수' : '매도'}
                </td>
                <td className="py-1 text-right text-t2">{e.qty.toLocaleString('ko-KR')}</td>
                <td className="py-1 text-right text-t3">{e.price == null ? '-' : e.price.toLocaleString('ko-KR')}</td>
                <td className="py-1 text-left text-t4 text-[10px] pl-2 truncate max-w-[120px]">{e.note ?? ''}</td>
                <td className="py-1 text-right">
                  <button
                    onClick={() => del(e.id)}
                    className="text-[10px] text-t4 hover:text-down px-1"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
