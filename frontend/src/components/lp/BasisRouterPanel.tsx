import { useEffect, useRef, useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import type { BasisRouteResponse } from '@/types/lp'
import { cn } from '@/lib/utils'

/**
 * 베이시스 실행 라우터 패널 (§13.4).
 *
 * 주문 leg(코드/방향/수량)에 대해 "현물로 할까 주식선물로 대체할까" 판정.
 * Rust 8200 GET /realtime/basis-route (Vite 프록시) — 실시간 현물·주식선물가 + 이론 베이시스.
 * 매도 leg는 rich, 매수 leg는 cheap일 때 선물 대체. 기장 버튼 2개(현물/선물 대체).
 */

const fmtPx = (n: number) =>
  n > 0 ? n.toLocaleString('ko-KR', { maximumFractionDigits: n >= 1000 ? 0 : 2 }) : '-'

const VERDICT_LABEL: Record<string, string> = {
  futures: '선물 대체',
  spot: '현물 실행',
  no_futures: '주식선물 미상장',
  stale: '시세 stale',
  no_data: '시세 미수신',
}

export function BasisRouterPanel() {
  const requestPrefill = useLpStore((s) => s.requestLedgerPrefill)
  const routePrefill = useLpStore((s) => s.basisRoutePrefill)
  const [code, setCode] = useState('')
  const [side, setSide] = useState<'buy' | 'sell'>('sell')
  const [qty, setQty] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<BasisRouteResponse | null>(null)
  const lastPrefillNonce = useRef(0)

  // 넷팅 바스켓 주식선물 배지 클릭 → 입력 프리필 + 즉시 판정 (§13.3-D).
  useEffect(() => {
    if (!routePrefill || routePrefill.nonce === lastPrefillNonce.current) return
    lastPrefillNonce.current = routePrefill.nonce
    setCode(routePrefill.code)
    setSide(routePrefill.side)
    setQty(String(routePrefill.qty))
    void run({ code: routePrefill.code, side: routePrefill.side, qty: routePrefill.qty })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePrefill])

  const run = async (over?: { code: string; side: 'buy' | 'sell'; qty: number }) => {
    const c = (over?.code ?? code).trim()
    const q = over?.qty ?? parseInt(qty, 10)
    const sd = over?.side ?? side
    if (!c || !Number.isFinite(q) || q <= 0) {
      setErr('코드·수량(양수) 필수')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const url = `/realtime/basis-route?code=${encodeURIComponent(c)}&side=${sd}&qty=${q}`
      const r = await fetch(url)
      if (!r.ok) {
        setErr(`요청 실패 (${r.status})`)
        setResult(null)
        return
      }
      setResult((await r.json()) as BasisRouteResponse)
    } catch {
      setErr('네트워크 오류')
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const bookSpot = () => {
    if (!result) return
    // §13.3-C: 현물 leg 기장에 현물가를 mid_at_fill로 첨부 (markout 기준선).
    requestPrefill({
      code: result.code,
      side: result.side as 'buy' | 'sell',
      qty: result.qty,
      mid_at_fill: result.spot_price > 0 ? result.spot_price : null,
    })
  }
  const bookFutures = () => {
    if (!result?.futures) return
    // 원장은 주수 단위 — 계약수 × 승수(=주수)로 기장. 진입 베이시스는 note(가독)와
    // entry_basis 수치 필드(§13.4 베이시스 북 1급 시민)에 병행 기록.
    // §13.3-C: 선물 leg 기장엔 선물가를 mid_at_fill로 첨부 (markout 기준선).
    const shares = result.qty_futures_contracts * result.futures.multiplier
    const sign = result.excess_bp >= 0 ? '+' : ''
    requestPrefill({
      code: result.futures.code,
      side: result.side as 'buy' | 'sell',
      qty: shares,
      note: `basis routed: excess ${sign}${result.excess_bp.toFixed(1)}bp`,
      entry_basis: result.basis_now,
      mid_at_fill: result.futures.price > 0 ? result.futures.price : null,
    })
  }

  const tabBtn = (active: boolean) =>
    `text-[11px] px-3 py-1 ${active ? 'bg-bg-surface text-t1' : 'bg-bg-base text-t4 hover:text-t2'}`

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base">
        <div className="text-[13px] text-t2 font-medium">베이시스 실행 라우터 (§13.4)</div>
        <div className="text-[11px] text-t4">
          주문 leg → 현물 vs 주식선물 대체 판정 (이론 대비 excess)
        </div>
      </div>

      {/* 입력 */}
      <div className="p-3 flex flex-col gap-2">
        <div className="flex gap-1">
          <button onClick={() => setSide('sell')} className={tabBtn(side === 'sell')} style={side === 'sell' ? { color: 'var(--color-down)' } : {}}>
            매도 leg
          </button>
          <button onClick={() => setSide('buy')} className={tabBtn(side === 'buy')} style={side === 'buy' ? { color: 'var(--color-up)' } : {}}>
            매수 leg
          </button>
        </div>
        <div className="flex gap-1">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="종목코드 (자유 입력)"
            className="flex-1 bg-bg-base px-2 py-1 text-[11px] tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="수량 (주)"
            onKeyDown={(e) => e.key === 'Enter' && run()}
            className="w-28 bg-bg-base px-2 py-1 text-[11px] tabular-nums text-right text-t1 outline-none focus:border-accent border border-transparent"
          />
          <button
            onClick={() => run()}
            disabled={busy}
            className="text-[11px] px-4 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '...' : '판정'}
          </button>
        </div>
        {err && <div className="text-[10px] text-down">{err}</div>}

        {result && <ResultCard r={result} onBookSpot={bookSpot} onBookFutures={bookFutures} />}
      </div>
    </div>
  )
}

function ResultCard({
  r,
  onBookSpot,
  onBookFutures,
}: {
  r: BasisRouteResponse
  onBookSpot: () => void
  onBookFutures: () => void
}) {
  const pickFutures = r.verdict === 'futures'
  const pickSpot = r.verdict === 'spot'
  const badgeColor =
    r.verdict === 'futures'
      ? 'bg-blue/15 text-blue'
      : r.verdict === 'spot'
        ? 'bg-accent/15 text-accent'
        : 'bg-down/15 text-down'

  return (
    <div className="bg-bg-surface p-3 flex flex-col gap-2">
      {/* verdict */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('text-[11px] px-2 py-0.5 rounded-sm font-medium', badgeColor)}>
            {VERDICT_LABEL[r.verdict] ?? r.verdict}
          </span>
          <span className="text-[10px] text-t3">{r.code}</span>
        </div>
        <span className="text-[10px] text-t4 tabular-nums">
          excess{' '}
          <span className={r.excess_bp >= 0 ? 'text-up' : 'text-down'}>
            {r.excess_bp >= 0 ? '+' : ''}
            {r.excess_bp.toFixed(1)}bp
          </span>
        </span>
      </div>

      {/* 현물 vs 선물 나란히 */}
      <div className="grid grid-cols-2 gap-1">
        <SideBox
          title="현물 실행"
          active={pickSpot}
          rows={[['현재가', fmtPx(r.spot_price)]]}
        />
        <SideBox
          title="선물 대체"
          active={pickFutures}
          rows={
            r.futures
              ? [
                  ['선물가', fmtPx(r.futures.price)],
                  ['만기', `D-${r.futures.days_left}`],
                  [
                    '계약',
                    `${r.qty_futures_contracts.toLocaleString('ko-KR')} (잔차 ${r.qty_futures_residual_shares}주)`,
                  ],
                ]
              : [['', '미상장']]
          }
        />
      </div>

      {/* 베이시스 분해 */}
      <div className="grid grid-cols-3 gap-2 text-[11px] tabular-nums font-mono">
        <Metric label="실측 베이시스" value={r.basis_now} />
        <Metric label="이론 베이시스" value={r.basis_theory} />
        <Metric label="excess" value={r.excess_basis} emphasize />
      </div>

      <div className="text-[10px] text-t4">{r.verdict_reason}</div>

      {/* 기장 버튼 2개 */}
      <div className="flex gap-1">
        <button
          onClick={onBookSpot}
          className={cn(
            'flex-1 text-[11px] py-1 border',
            pickSpot
              ? 'bg-accent/15 text-accent border-accent/40'
              : 'bg-bg-base text-t3 border-transparent hover:text-t1',
          )}
        >
          현물로 기장
        </button>
        <button
          onClick={onBookFutures}
          disabled={!r.futures}
          className={cn(
            'flex-1 text-[11px] py-1 border disabled:opacity-40',
            pickFutures
              ? 'bg-blue/15 text-blue border-blue/40'
              : 'bg-bg-base text-t3 border-transparent hover:text-t1',
          )}
        >
          선물 대체로 기장
        </button>
      </div>
    </div>
  )
}

function SideBox({
  title,
  active,
  rows,
}: {
  title: string
  active: boolean
  rows: Array<[string, string]>
}) {
  return (
    <div className={cn('px-2 py-1.5', active ? 'bg-bg-base ring-1 ring-accent/30' : 'bg-bg-base/40')}>
      <div className={cn('text-[10px] mb-1', active ? 'text-t1 font-medium' : 'text-t4')}>
        {title}
        {active && <span className="ml-1 text-accent">✓</span>}
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex justify-between text-[11px] font-mono tabular-nums">
            <span className="text-t4">{k}</span>
            <span className="text-t2">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  emphasize,
}: {
  label: string
  value: number
  emphasize?: boolean
}) {
  const color = Math.abs(value) < 0.005 ? 'text-t3' : value > 0 ? 'text-up' : 'text-down'
  return (
    <div>
      <div className="text-[9px] text-t4">{label}</div>
      <div className={cn(emphasize ? 'text-[13px]' : 'text-[12px]', color)}>
        {value >= 0 ? '+' : '−'}
        {Math.abs(value).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}
      </div>
    </div>
  )
}
