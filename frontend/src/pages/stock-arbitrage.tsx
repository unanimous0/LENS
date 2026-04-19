import { useEffect, useMemo, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'

// ── 타입 ──

interface FuturesMasterItem {
  base_code: string
  base_name: string
  front: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
  back?: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
}

interface FuturesMaster {
  updated: string
  front_month: string
  back_month: string
  count: number
  items: FuturesMasterItem[]
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
  dividend: number
  dividendDate: string
  dividendApplied: boolean
  holding031: number
  holding052: number
  futuresHolding: number
}

type SortKey = keyof Pick<Row,
  'baseName' | 'spotPrice' | 'futuresPrice' | 'marketBasis' | 'basisGapBp' |
  'spotCumVolume' | 'futuresVolume' | 'spread' | 'daysLeft' | 'theoreticalBasis' | 'basisGap'
>

const BASIS_SORT_KEYS: SortKey[] = ['marketBasis', 'basisGapBp', 'basisGap', 'theoreticalBasis']

export function StockArbitragePage() {
  const [master, setMaster] = useState<FuturesMaster | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('basisGapBp')
  const [sortAsc, setSortAsc] = useState(false)

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)

  useEffect(() => {
    fetch('/api/arbitrage/master')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setMaster(d); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  const rows = useMemo(() => {
    if (!master) return [] as Row[]
    return master.items.map((item, idx): Row => {
      const spot = stockTicks[item.base_code]
      const front = futuresTicks[item.front.code]
      const back = item.back ? futuresTicks[item.back.code] : undefined

      // Mock 데이터 (실시간 데이터 없을 때 디자인 확인용)
      const seed = parseInt(item.base_code.slice(-4), 10) || (idx + 1) * 137
      const mock = !spot && !front
      const bp = mock ? 10000 + (seed % 50) * 5000 : 0

      const spotPrice = spot?.price ?? (mock ? bp : 0)
      const futuresPrice = front?.price ?? (mock ? bp + (seed % 200 - 100) : 0)
      const marketBasis = front?.basis ?? (mock ? futuresPrice - spotPrice : 0)
      const tp = mock ? bp + (seed % 80 - 30) : 0
      const tb = mock ? tp - spotPrice : 0
      const gap = mock ? marketBasis - tb : 0
      const gapBp = spotPrice > 0 ? (gap / spotPrice) * 10000 : 0
      const backPrice = back?.price ?? (mock ? futuresPrice + (seed % 60 - 20) : 0)

      return {
        baseCode: item.base_code,
        baseName: item.base_name,
        frontCode: item.front.code,
        backCode: item.back?.code ?? '',
        multiplier: item.front.multiplier,
        expiry: item.front.expiry,
        daysLeft: item.front.days_left || 28,
        spotPrice,
        spotCumVolume: spot?.cum_volume ?? (mock ? (seed % 300 + 50) * 1e8 : 0),
        futuresPrice,
        futuresVolume: front?.volume ?? (mock ? seed % 2000 + 100 : 0),
        theoreticalPrice: tp,
        theoreticalBasis: tb,
        marketBasis,
        basisGap: gap,
        basisGapBp: gapBp,
        backPrice,
        spread: backPrice > 0 && futuresPrice > 0 ? backPrice - futuresPrice : 0,
        spreadVolume: mock ? seed % 500 : 0,
        dividend: mock && seed % 3 === 0 ? (seed % 10 + 1) * 100 : 0,
        dividendDate: mock && seed % 3 === 0 ? '2026-06-28' : '',
        dividendApplied: mock && seed % 3 === 0,
        holding031: mock && seed % 4 === 0 ? seed % 50000 + 1000 : 0,
        holding052: mock && seed % 5 === 0 ? seed % 30000 + 500 : 0,
        futuresHolding: mock && seed % 6 === 0 ? seed % 200 + 10 : 0,
      }
    })
  }, [master, stockTicks, futuresTicks])

  const filtered = useMemo(() => {
    let list = rows
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((r) =>
        r.baseName.toLowerCase().includes(q) || r.baseCode.includes(q) || r.frontCode.toLowerCase().includes(q)
      )
    }
    list.sort((a, b) => {
      const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0
      if (sortKey === 'baseName') return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
      if (BASIS_SORT_KEYS.includes(sortKey)) return sortAsc ? Math.abs(+av) - Math.abs(+bv) : Math.abs(+bv) - Math.abs(+av)
      return sortAsc ? +av - +bv : +bv - +av
    })
    return list
  }, [rows, search, sortKey, sortAsc])

  const sort = (k: SortKey) => { if (sortKey === k) setSortAsc(!sortAsc); else { setSortKey(k); setSortAsc(false) } }

  if (loading) return <div className="flex h-full items-center justify-center"><p className="text-sm text-t3">마스터 데이터 로딩 중...</p></div>
  if (error) return <div className="flex h-full items-center justify-center"><p className="text-sm text-down">로드 실패: {error}</p></div>

  return (
    <div className="flex flex-col h-full bg-bg-base">
      {/* 상단 */}
      <div className="px-5 py-3 flex items-center gap-4 bg-bg-primary shrink-0">
        <span className="text-[15px] font-semibold text-t1">종목차익</span>
        <span className="text-[11px] text-t4">{master?.count}종목 · 근월 {master?.front_month} · 갱신 {master?.updated}</span>
        <div className="ml-auto flex items-center gap-3">
          <input
            type="text"
            placeholder="종목명 / 코드 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-52 rounded-md bg-bg-surface px-3 py-1.5 text-xs text-t1 placeholder:text-t4 outline-none focus:ring-1 focus:ring-accent/50 transition-all"
          />
          <span className="text-[11px] text-t4 font-mono">{filtered.length}건</span>
        </div>
      </div>

      {/* 테이블 */}
      <div className="flex-1 overflow-auto min-h-0">
        <table className="w-max min-w-full">
          <thead className="sticky top-0 z-20 bg-bg-primary">
            {/* 그룹 라벨 */}
            <tr className="text-[10px] text-t4 tracking-wide uppercase">
              <th colSpan={3} className="pl-5 pr-6 py-1.5 text-left font-normal sticky left-0 bg-bg-primary z-30">종목</th>
              <th colSpan={3} className="px-2 py-1.5 text-center font-normal">가격</th>
              <th colSpan={4} className="px-2 py-1.5 text-center font-normal">베이시스</th>
              <th colSpan={3} className="px-2 py-1.5 text-center font-normal">거래</th>
              <th colSpan={2} className="px-2 py-1.5 text-center font-normal">스프레드</th>
              <th colSpan={3} className="px-2 py-1.5 text-center font-normal">배당</th>
              <th colSpan={1} className="px-2 py-1.5 text-center font-normal">만기</th>
              <th colSpan={2} className="px-2 py-1.5 text-center font-normal">액션</th>
              <th colSpan={4} className="px-2 py-1.5 text-center font-normal">보유</th>
            </tr>
            {/* 컬럼 헤더 */}
            <tr className="text-[11px] text-t3 border-b border-border-light">
              <Col k="baseName" s={sortKey} a={sortAsc} sort={sort} left sticky className="pl-5 min-w-[110px]">종목명</Col>
              <ColH sticky style={{ left: 110 }} className="min-w-[58px]">현물</ColH>
              <ColH sticky style={{ left: 168 }} className="min-w-[66px] pr-6">선물</ColH>
              <Col k="spotPrice" s={sortKey} a={sortAsc} sort={sort} className="min-w-[78px]">현물가</Col>
              <Col k="futuresPrice" s={sortKey} a={sortAsc} sort={sort} className="min-w-[78px]">선물가</Col>
              <ColH className="min-w-[78px]">이론가</ColH>
              <Col k="theoreticalBasis" s={sortKey} a={sortAsc} sort={sort} className="min-w-[64px]">이론B</Col>
              <Col k="marketBasis" s={sortKey} a={sortAsc} sort={sort} className="min-w-[64px]">시장B</Col>
              <Col k="basisGap" s={sortKey} a={sortAsc} sort={sort} className="min-w-[64px]">갭</Col>
              <Col k="basisGapBp" s={sortKey} a={sortAsc} sort={sort} className="min-w-[58px]">갭bp</Col>
              <Col k="spotCumVolume" s={sortKey} a={sortAsc} sort={sort} className="min-w-[82px]">현물대금</Col>
              <Col k="futuresVolume" s={sortKey} a={sortAsc} sort={sort} className="min-w-[68px]">선물량</Col>
              <ColH className="min-w-[38px]">승수</ColH>
              <Col k="spread" s={sortKey} a={sortAsc} sort={sort} className="min-w-[68px]">스프레드</Col>
              <ColH className="min-w-[56px]">스프량</ColH>
              <ColH className="min-w-[58px]">배당금</ColH>
              <ColH className="min-w-[68px]">기준일</ColH>
              <ColH className="min-w-[36px]">적용</ColH>
              <Col k="daysLeft" s={sortKey} a={sortAsc} sort={sort} className="min-w-[44px]">잔존</Col>
              <ColH className="min-w-[40px]">호가</ColH>
              <ColH className="min-w-[40px]">스프</ColH>
              <ColH className="min-w-[52px]">031</ColH>
              <ColH className="min-w-[52px]">052</ColH>
              <ColH className="min-w-[36px]">펀드</ColH>
              <ColH className="min-w-[52px]">선물</ColH>
            </tr>
          </thead>
          <tbody className="text-[12px]">
            {filtered.map((r) => (
              <tr key={r.baseCode} className="hover:bg-bg-surface/50 transition-colors">
                {/* 종목 — 고정 */}
                <td className="pl-5 pr-2 py-[7px] sticky left-0 bg-bg-base z-10 text-t1 font-medium truncate max-w-[110px] group-hover:bg-bg-surface">
                  {r.baseName}
                </td>
                <td className="px-1 py-[7px] sticky bg-bg-base z-10 tabular-nums text-[10px] text-t4 text-right" style={{ left: 110 }}>
                  {r.baseCode}
                </td>
                <td className="pl-1 pr-6 py-[7px] sticky bg-bg-base z-10 tabular-nums text-[10px] text-t4 text-right" style={{ left: 168 }}>
                  {r.frontCode}
                </td>
                {/* 가격 */}
                <V>{fP(r.spotPrice)}</V>
                <V>{fP(r.futuresPrice)}</V>
                <V dim>{fP(r.theoreticalPrice)}</V>
                {/* 베이시스 */}
                <V c={cB(r.theoreticalBasis)}>{fB(r.theoreticalBasis)}</V>
                <V c={cB(r.marketBasis)}>{fB(r.marketBasis)}</V>
                <V c={cB(r.basisGap)} bold>{fB(r.basisGap)}</V>
                <V c={cB(r.basisGapBp)} bold>{fBp(r.basisGapBp)}</V>
                {/* 거래 */}
                <V dim>{r.spotCumVolume ? fVol(r.spotCumVolume) : '-'}</V>
                <V dim>{r.futuresVolume ? r.futuresVolume.toLocaleString() : '-'}</V>
                <V vdim>{r.multiplier}</V>
                {/* 스프레드 */}
                <V c={cB(r.spread)}>{r.spread ? fB(r.spread) : '-'}</V>
                <V dim>{r.spreadVolume ? r.spreadVolume.toLocaleString() : '-'}</V>
                {/* 배당 */}
                <V dim>{r.dividend ? r.dividend.toLocaleString() : '-'}</V>
                <V vdim>{r.dividendDate ? r.dividendDate.slice(5) : '-'}</V>
                <V vdim>{r.dividendApplied ? 'Y' : '-'}</V>
                {/* 만기 */}
                <V vdim>{r.daysLeft > 0 ? `${r.daysLeft}일` : '-'}</V>
                {/* 액션 */}
                <td className="px-1 py-[7px] text-center">
                  <Btn>호가</Btn>
                </td>
                <td className="px-1 py-[7px] text-center">
                  <Btn>스프</Btn>
                </td>
                {/* 보유 */}
                <V dim>{r.holding031 || '-'}</V>
                <V dim>{r.holding052 || '-'}</V>
                <td className="px-1 py-[7px] text-center">
                  <Btn>조회</Btn>
                </td>
                <V dim>{r.futuresHolding || '-'}</V>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 헤더 셀 ──

function ColH({ children, className, sticky, style }: {
  children: React.ReactNode; className?: string; sticky?: boolean; style?: React.CSSProperties
}) {
  return (
    <th className={cn('px-2 py-1.5 font-medium text-right', sticky && 'sticky bg-bg-primary z-30', className)} style={style}>
      {children}
    </th>
  )
}

function Col({ k, s, a, sort, children, className, left, sticky, style }: {
  k: SortKey; s: SortKey; a: boolean; sort: (k: SortKey) => void
  children: React.ReactNode; className?: string; left?: boolean; sticky?: boolean; style?: React.CSSProperties
}) {
  const active = s === k
  return (
    <th
      className={cn(
        'px-2 py-1.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors',
        left ? 'text-left' : 'text-right',
        active ? 'text-accent' : '',
        sticky && 'sticky bg-bg-primary z-30',
        className,
      )}
      style={style}
      onClick={() => sort(k)}
    >
      {children}{active && <span className="ml-0.5 text-[9px] opacity-60">{a ? '▲' : '▼'}</span>}
    </th>
  )
}

// ── 값 셀 ──

function V({ children, c, dim, vdim, bold }: {
  children: React.ReactNode; c?: string; dim?: boolean; vdim?: boolean; bold?: boolean
}) {
  return (
    <td className={cn(
      'px-2 py-[7px] tabular-nums text-right',
      c || (dim ? 'text-t3' : vdim ? 'text-t4' : 'text-t1'),
      bold && 'font-semibold',
    )}>
      {children}
    </td>
  )
}

function Btn({ children }: { children: React.ReactNode }) {
  return (
    <button className="px-2 py-0.5 rounded text-[10px] text-t4 hover:text-t1 hover:bg-bg-surface-2 transition-colors">
      {children}
    </button>
  )
}

// ── 포맷 ──

function cB(v: number) { return !v ? 'text-t4' : v > 0 ? 'text-up' : 'text-down' }
function fP(v: number) { return v ? v.toLocaleString() : '-' }
function fB(v: number) { return !v ? '-' : `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}` }
function fBp(v: number) { return !v ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(1)}` }
function fVol(v: number) {
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}조`
  if (v >= 1e8) return `${(v / 1e8).toFixed(0)}억`
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}만`
  return v.toLocaleString()
}
