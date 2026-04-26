import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'
import { OrderbookModal, SpreadOrderbookModal } from '@/components/OrderbookModal'

// ── 타입 ──

interface MasterItem {
  base_code: string
  base_name: string
  spread_code?: string
  front: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
  back?: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
}

interface Master {
  updated: string
  front_month: string
  back_month: string
  count: number
  items: MasterItem[]
}

interface Dividend {
  code: string
  ex_date: string | null
  record_date: string
  amount: number
  period: string
  confirmed: boolean
}

interface Row {
  baseCode: string
  baseName: string
  frontCode: string
  backCode: string
  multiplier: number
  expiry: string
  daysLeft: number
  spotPrice: number
  spotCumVolume: number
  futuresPrice: number
  futuresVolume: number
  theoreticalPrice: number
  theoreticalBasis: number
  marketBasis: number
  basisGap: number
  basisGapBp: number
  backPrice: number
  spread: number
  spreadVolume: number
  spreadHasTick: boolean
  dividend: number
  dividendDate: string
  dividendApplied: boolean
  spreadCode: string
  holding031: number
  holding052: number
  futuresHolding: number
}

type SK = keyof Pick<Row,
  'baseName' | 'spotPrice' | 'futuresPrice' | 'theoreticalPrice' | 'marketBasis' | 'basisGapBp' |
  'theoreticalBasis' | 'basisGap' | 'spotCumVolume' | 'futuresVolume' | 'multiplier' |
  'spread' | 'spreadVolume' | 'dividend'
>

export function StockArbitragePage() {
  const [master, setMaster] = useState<Master | null>(null)
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sk, setSk] = useState<SK>('basisGapBp')
  const [asc, setAsc] = useState(false)
  const [month, setMonth] = useState<'front' | 'back'>('front')
  const [rate, setRate] = useState<number>(() => {
    const saved = localStorage.getItem('arbitrage.rate')
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) ? n : 2.8
  })
  const [rateDraft, setRateDraft] = useState<string>(() => String(rate))
  useEffect(() => { localStorage.setItem('arbitrage.rate', String(rate)) }, [rate])
  const commitRate = () => {
    const n = parseFloat(rateDraft)
    if (Number.isFinite(n) && n >= 0) setRate(n)
    else setRateDraft(String(rate))
  }
  const [obTarget, setObTarget] = useState<{ spotCode: string; futuresCode: string; spotName: string } | null>(null)
  const [spreadTarget, setSpreadTarget] = useState<{ spreadCode: string; spotName: string } | null>(null)
  const closeOb = useCallback(() => setObTarget(null), [])
  const closeSpread = useCallback(() => setSpreadTarget(null), [])

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)

  useEffect(() => {
    fetch('/api/arbitrage/master')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setMaster(d); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  useEffect(() => {
    fetch('/api/dividends')
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((d) => setDividends(d.items ?? []))
      .catch(() => {})  // 배당 API 실패는 치명적이지 않음 — dividend 0으로 떨어짐
  }, [])

  // 종목코드별 배당 인덱스 — 행 매칭 시 O(1) 조회
  const divByCode = useMemo(() => {
    const m: Record<string, Dividend[]> = {}
    for (const d of dividends) {
      if (!d.ex_date) continue
      ;(m[d.code] ??= []).push(d)
    }
    return m
  }, [dividends])

  // 월물 전환 시 선물 구독 전환 (현물/스프레드는 고정)
  // 실시간 JC0 체결이 오면 즉시 갱신됨. 체결 전에는 마스터 초기값 표시.
  useEffect(() => {
    if (!master) return
    const futuresCodes = master.items
      .map((i) => (i as any)[month]?.code)
      .filter(Boolean) as string[]
    if (futuresCodes.length > 0) {
      fetch('/realtime/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: futuresCodes }),
      }).catch(() => {})
    }
  }, [master, month])

  const rows = useMemo(() => {
    if (!master) return [] as Row[]
    const today = new Date().toISOString().slice(0, 10)
    return master.items.map((item, idx): Row => {
      const spot = stockTicks[item.base_code]
      // 선택된 월물에 따라 선물 데이터 참조
      const sel = month === 'back' && item.back ? item.back : item.front
      const other = month === 'back' ? item.front : item.back
      const fut = futuresTicks[sel.code]
      const otherFut = other ? futuresTicks[other.code] : undefined

      const sp = spot?.price ?? 0  // 실시간 S3_/K3_만
      const fp = fut?.price ?? 0  // 실시간 JC0 체결만 표시
      const mb = fp > 0 && sp > 0 ? fp - sp : (fut?.basis ?? 0)

      // 배당 매칭: 오늘 ~ 선택 월물 만기일 사이에 배당락이 있으면 합산.
      // 만기일은 master.expiry (YYYYMMDD or YYYYMM)에서 직접 파싱 — days_left는 마스터
      // 갱신일 기준이라 며칠 stale될 수 있음.
      const cutoff = expiryToCutoffDate(sel.expiry)
      const applicable = (divByCode[item.base_code] ?? [])
        .filter((d) => d.ex_date && d.ex_date >= today && d.ex_date <= cutoff)
      const totalDividend = applicable.reduce((s, d) => s + d.amount, 0)
      const earliestExDate = applicable.length > 0
        ? applicable.reduce((min, d) => d.ex_date! < min ? d.ex_date! : min, applicable[0].ex_date!)
        : ''

      // 이론가 = 현물 × (1 + r × d/365) - 배당
      const dLeft = sel.days_left || 0
      const tp = sp > 0 ? sp * (1 + (rate / 100) * dLeft / 365) - totalDividend : 0
      const tb = tp > 0 ? tp - sp : 0
      const gap = mb - tb
      const ofp = otherFut?.price ?? other?.price ?? 0
      // 스프레드: 항상 원월 - 근월
      const frontP = month === 'front' ? fp : ofp
      const backP = month === 'front' ? ofp : fp
      return {
        baseCode: item.base_code, baseName: item.base_name,
        frontCode: sel.code, backCode: other?.code ?? '',
        multiplier: sel.multiplier, expiry: sel.expiry, daysLeft: sel.days_left || 0,
        spotPrice: sp, spotCumVolume: spot?.cum_volume ?? 0,
        futuresPrice: fp, futuresVolume: fut?.volume ?? 0,  // 실시간만
        theoreticalPrice: tp, theoreticalBasis: tb,
        marketBasis: mb, basisGap: gap, basisGapBp: sp > 0 ? (gap / sp) * 10000 : 0,
        backPrice: backP,
        spread: item.spread_code ? (futuresTicks[item.spread_code]?.price ?? 0) : 0,
        spreadVolume: item.spread_code ? (futuresTicks[item.spread_code]?.volume ?? 0) : 0,
        // tick 존재 여부는 price 값과 독립. 스프레드는 근월=원월이면 price=0이 정상이므로
        // falsy 판정으로 "-" 처리하면 안 됨.
        spreadHasTick: !!(item.spread_code && futuresTicks[item.spread_code]),
        spreadCode: item.spread_code ?? '',
        dividend: totalDividend,
        dividendDate: earliestExDate,
        dividendApplied: applicable.length > 0,
        holding031: 0, holding052: 0, futuresHolding: 0,
      }
    })
  }, [master, stockTicks, futuresTicks, month, rate, divByCode])

  const filtered = useMemo(() => {
    let list = rows
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((r) => r.baseName.toLowerCase().includes(q) || r.baseCode.includes(q) || r.frontCode.toLowerCase().includes(q))
    }
    list.sort((a, b) => {
      const av = a[sk] ?? 0, bv = b[sk] ?? 0
      if (sk === 'baseName') {
        const as = String(av), bs = String(bv)
        // 영문 시작이면 한글보다 우선. 같은 언어 내에선 알파벳/가나다 순.
        const aEng = /^[A-Za-z]/.test(as)
        const bEng = /^[A-Za-z]/.test(bs)
        if (aEng !== bEng) return asc ? (aEng ? -1 : 1) : (aEng ? 1 : -1)
        return asc ? as.localeCompare(bs) : bs.localeCompare(as)
      }
      return asc ? +av - +bv : +bv - +av
    })
    return list
  }, [rows, search, sk, asc])

  const doSort = (k: SK) => { if (sk === k) setAsc(!asc); else { setSk(k); setAsc(false) } }

  if (loading) return <Center>마스터 데이터 로딩 중...</Center>
  if (error) return <Center className="text-down">로드 실패: {error}</Center>

  const selInfo = master?.items[0]?.[month]
  const selExpiry = selInfo?.expiry ?? ''
  const selDaysLeft = selInfo?.days_left ?? 0
  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex flex-col bg-black">
      {/* 헤더 — main 스크롤 시 상단에 sticky */}
      <div className="px-6 py-4 flex items-center gap-5 shrink-0 sticky top-0 z-30 bg-black">
        <h1 className="text-[14px] text-white">종목차익</h1>
        <div className="flex items-center gap-1 rounded-md bg-[#1e1e22] p-0.5">
          <button
            onClick={() => setMonth('front')}
            className={cn('px-3 py-1 rounded text-[11px] transition-colors', month === 'front' ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white')}
          >
            근월물
          </button>
          <button
            onClick={() => setMonth('back')}
            className={cn('px-3 py-1 rounded text-[11px] transition-colors', month === 'back' ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white')}
          >
            원월물
          </button>
        </div>
        {/* 금리 입력 */}
        <div className="flex items-center gap-1.5 rounded-md bg-[#1e1e22] h-[28px] px-2.5">
          <span className="text-[10px] text-[#8b8b8e]">금리</span>
          <input
            type="number"
            step="0.1"
            value={rateDraft}
            onChange={(e) => setRateDraft(e.target.value)}
            onBlur={commitRate}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="w-10 bg-transparent text-[11px] text-white tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
          />
          <span className="text-[10px] text-[#8b8b8e]">%</span>
        </div>
        {/* 날짜 / 잔존 */}
        <div className="flex items-center gap-3 text-[10px] text-[#8b8b8e] tabular-nums">
          <span>오늘 <span className="text-white">{fmtDate(todayStr)}</span></span>
          <span>만기 <span className="text-white">{fmtExpiry(selExpiry)}</span></span>
          <span>잔존 <span className="text-white">{selDaysLeft}</span>일</span>
        </div>
        <span className="text-[10px] text-[#8b8b8e]">마스터 갱신일 <span className="text-[#d1d1d6] tabular-nums">{master?.updated ?? '-'}</span></span>
        <div className="ml-auto">
          <input
            type="text"
            placeholder="종목 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-lg bg-[#1e1e22] px-4 py-2 text-[13px] text-white placeholder:text-[#5a5a5e] outline-none focus:ring-1 focus:ring-white/20"
          />
        </div>
      </div>

      {/* 테이블 — main 스크롤에 thead가 페이지 헤더 바로 아래에 sticky */}
      <div className="px-2">
        <table className="w-max min-w-full border-collapse">
          <thead className="sticky top-[60px] z-20">
            <tr className="text-[10px] text-[#8b8b8e] bg-black">
              {/* 종목 */}
              <Th sort={() => doSort('baseName')} active={sk === 'baseName'} asc={asc} left sticky className="pl-4 min-w-[110px]">종목</Th>
              {/* 가격 */}
              <Th sort={() => doSort('spotPrice')} active={sk === 'spotPrice'} asc={asc} className="min-w-[74px]">현물가</Th>
              <Th sort={() => doSort('futuresPrice')} active={sk === 'futuresPrice'} asc={asc} className="min-w-[74px]">선물가</Th>
              <Th sort={() => doSort('theoreticalPrice')} active={sk === 'theoreticalPrice'} asc={asc} className="min-w-[74px]">이론가</Th>
              {/* 베이시스 */}
              <Th sort={() => doSort('theoreticalBasis')} active={sk === 'theoreticalBasis'} asc={asc} className="min-w-[62px]">이론B</Th>
              <Th sort={() => doSort('marketBasis')} active={sk === 'marketBasis'} asc={asc} className="min-w-[62px]">시장B</Th>
              <Th sort={() => doSort('basisGap')} active={sk === 'basisGap'} asc={asc} className="min-w-[62px]">갭</Th>
              <Th sort={() => doSort('basisGapBp')} active={sk === 'basisGapBp'} asc={asc} className="min-w-[56px]">갭bp</Th>
              {/* 거래 */}
              <Th sort={() => doSort('spotCumVolume')} active={sk === 'spotCumVolume'} asc={asc} className="min-w-[76px]">현물대금</Th>
              <Th sort={() => doSort('futuresVolume')} active={sk === 'futuresVolume'} asc={asc} className="min-w-[64px]">선물량</Th>
              <Th sort={() => doSort('multiplier')} active={sk === 'multiplier'} asc={asc} className="min-w-[42px]">승수</Th>
              {/* 스프레드 */}
              <Th sort={() => doSort('spread')} active={sk === 'spread'} asc={asc} className="min-w-[64px]">스프레드</Th>
              <Th sort={() => doSort('spreadVolume')} active={sk === 'spreadVolume'} asc={asc} className="min-w-[52px]">스프량</Th>
              {/* 배당 */}
              <Th sort={() => doSort('dividend')} active={sk === 'dividend'} asc={asc} className="min-w-[56px]">배당금</Th>
              <Th className="min-w-[62px]">기준일</Th>
              <Th className="min-w-[34px]">적용</Th>
              {/* 액션 */}
              <Th className="min-w-[38px]">호가</Th>
              <Th className="min-w-[38px]">스프</Th>
              {/* 보유 */}
              <Th className="min-w-[48px]">031</Th>
              <Th className="min-w-[48px]">052</Th>
              <Th className="min-w-[34px]">펀드</Th>
              <Th className="min-w-[48px] pr-4">선물</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.baseCode} className="border-b border-white/[0.04] bg-black hover:bg-[#1d1d1d] transition-colors">
                {/* 종목 */}
                <td className="pl-4 pr-3 py-[11px] sticky left-0 z-10" style={{ backgroundColor: 'inherit' }}>
                  <div className="text-[11px] text-white leading-none">{r.baseName}</div>
                  <div className="text-[9px] text-[#5a5a5e] leading-none mt-[2px] tabular-nums">
                    {r.baseCode} / {r.frontCode}
                  </div>
                </td>
                {/* 가격 */}
                <PriceCell value={r.spotPrice} formatted={fP(r.spotPrice)} />
                <PriceCell value={r.futuresPrice} formatted={fP(r.futuresPrice)} />
                <C sub>{r.theoreticalPrice ? Math.round(r.theoreticalPrice).toLocaleString() : '-'}</C>
                {/* 베이시스 */}
                <C c={cV(r.theoreticalBasis)}>{fBi(r.theoreticalBasis)}</C>
                <C c={cV(r.marketBasis)}>{fB(r.marketBasis)}</C>
                <C c={cV(r.basisGap)}>{fBi(r.basisGap)}</C>
                <C c={cV(r.basisGapBp)}>{fBp(r.basisGapBp)}</C>
                {/* 거래 */}
                <C sub>{r.spotCumVolume ? fVol(r.spotCumVolume) : '-'}</C>
                <C sub>{r.futuresVolume ? r.futuresVolume.toLocaleString() : '-'}</C>
                <C mute>{r.multiplier % 1 === 0 ? r.multiplier : r.multiplier.toFixed(2)}</C>
                {/* 스프레드 */}
                <C c={cV(r.spread)}>{r.spreadHasTick ? fB(r.spread) : '-'}</C>
                <C sub>{r.spreadVolume ? r.spreadVolume.toLocaleString() : '-'}</C>
                {/* 배당 */}
                <C sub>{r.dividend ? r.dividend.toLocaleString() : '-'}</C>
                <C mute>{r.dividendDate ? r.dividendDate.slice(5) : '-'}</C>
                <C mute>{r.dividendApplied ? 'Y' : '-'}</C>
                {/* 액션 */}
                <td className="px-1 py-[11px] text-center align-middle">
                  <button
                    onClick={() => setObTarget({ spotCode: r.baseCode, futuresCode: r.frontCode, spotName: r.baseName })}
                    className="text-[10px] text-white/90 bg-[#2a2a2e] border border-white/10 rounded px-2.5 py-[3px] hover:bg-[#444448] transition-colors"
                  >호가</button>
                </td>
                <td className="px-1 py-[11px] text-center align-middle">
                  <button
                    onClick={() => r.spreadCode && setSpreadTarget({ spreadCode: r.spreadCode, spotName: r.baseName })}
                    className={cn('text-[10px] rounded px-2.5 py-[3px] border transition-colors', r.spreadCode ? 'text-white/90 bg-[#2a2a2e] border-white/10 hover:bg-[#444448]' : 'text-[#3a3a3e] border-transparent cursor-default')}
                  >스프</button>
                </td>
                {/* 보유 */}
                <C>{r.holding031 ? r.holding031.toLocaleString() : '-'}</C>
                <C>{r.holding052 ? r.holding052.toLocaleString() : '-'}</C>
                <td className="px-1 py-[11px] text-center align-middle">
                  <button className="text-[10px] text-white/90 bg-[#2a2a2e] border border-white/10 rounded px-2.5 py-[3px] hover:bg-[#444448] transition-colors">조회</button>
                </td>
                <C sub className="pr-4">{r.futuresHolding ? r.futuresHolding.toLocaleString() : '-'}</C>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 호가창 모달 */}
      {obTarget && (
        <OrderbookModal
          spotCode={obTarget.spotCode}
          futuresCode={obTarget.futuresCode}
          spotName={obTarget.spotName}
          onClose={closeOb}
        />
      )}

      {/* 스프레드 호가창 모달 */}
      {spreadTarget && (
        <SpreadOrderbookModal
          spreadCode={spreadTarget.spreadCode}
          spotName={spreadTarget.spotName}
          onClose={closeSpread}
        />
      )}
    </div>
  )
}

// ── 컴포넌트 ──

function Center({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className="flex h-full items-center justify-center"><p className={cn('text-[13px] text-[#8b8b8e]', className)}>{children}</p></div>
}

function Th({ children, className, sort, active, asc, left, sticky, style }: {
  children: React.ReactNode; className?: string; sort?: () => void; active?: boolean; asc?: boolean
  left?: boolean; sticky?: boolean; style?: React.CSSProperties
}) {
  return (
    <th
      className={cn(
        'px-2 py-[11px] font-normal whitespace-nowrap border-b border-white/[0.06]',
        left ? 'text-left' : 'text-right',
        sort ? 'cursor-pointer select-none hover:text-white transition-colors' : '',
        active ? 'text-white' : '',
        sticky && 'sticky left-0 bg-black z-30',
        className,
      )}
      style={style}
      onClick={sort}
    >
      {children}
      {active && <span className="ml-1 text-[9px] opacity-50">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}

function C({ children, c, sub, mute, className }: {
  children: React.ReactNode; c?: string; sub?: boolean; mute?: boolean; className?: string
}) {
  return (
    <td className={cn(
      'px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap',
      c || 'text-white',
      className,
    )}>
      {children}
    </td>
  )
}

/** 가격 변동 시 배경 플래시 셀 (0.3초) */
function PriceCell({ value, formatted }: { value: number; formatted: string }) {
  const ref = useRef<HTMLTableCellElement>(null)
  const prev = useRef(value)

  useEffect(() => {
    if (prev.current === value || !ref.current) { prev.current = value; return }
    const dir = value > prev.current ? 'up' : 'down'
    prev.current = value
    const el = ref.current
    el.style.backgroundColor = dir === 'up' ? 'rgba(0,178,107,0.15)' : 'rgba(187,74,101,0.15)'
    const t = setTimeout(() => { el.style.backgroundColor = '' }, 300)
    return () => clearTimeout(t)
  }, [value])

  return (
    <td
      ref={ref}
      className="px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap text-white"
      style={{ transition: 'background-color 0.3s ease-out' }}
    >
      {formatted}
    </td>
  )
}

// ── 포맷 ──

function cV(v: number) { return v === 0 ? 'text-[#e0e0e3]' : v > 0 ? 'text-[#00b26b]' : 'text-[#bb4a65]' }
function fP(v: number) { return v ? v.toLocaleString() : '-' }
function fB(v: number) { return `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}` }
function fBi(v: number) { const r = Math.round(v); return `${r > 0 ? '+' : ''}${r.toLocaleString()}` }
function fBp(v: number) { return `${v > 0 ? '+' : ''}${v.toFixed(2)}` }
function fmtDate(s: string) { return s.length >= 10 ? s.slice(5, 10) : s }
function fmtExpiry(e: string) {
  if (e.length === 8) return `${e.slice(4, 6)}-${e.slice(6, 8)}`
  if (e.length === 6) return `${e.slice(4, 6)}월`
  return e || '-'
}
/** 만기 문자열을 ISO 일자(YYYY-MM-DD)로 변환. 배당 매칭 cutoff 계산용.
 *  YYYYMMDD: 그 날짜 그대로
 *  YYYYMM (back month — 정확한 만기일 미상): 해당 월 말일 사용 */
function expiryToCutoffDate(e: string): string {
  if (e.length === 8) {
    return `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`
  }
  if (e.length === 6) {
    const year = parseInt(e.slice(0, 4), 10)
    const month = parseInt(e.slice(4, 6), 10)
    const lastDay = new Date(year, month, 0).getDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  }
  return ''
}
function fVol(v: number) {
  if (v >= 1e12) return `${(v / 1e12).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}조`
  if (v >= 1e8) return `${Math.round(v / 1e8).toLocaleString()}억`
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`
  return v.toLocaleString()
}
