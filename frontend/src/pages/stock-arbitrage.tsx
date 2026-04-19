import { useEffect, useMemo, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'

// ── 타입 ──

interface MasterItem {
  base_code: string
  base_name: string
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

type SK = keyof Pick<Row,
  'baseName' | 'spotPrice' | 'futuresPrice' | 'marketBasis' | 'basisGapBp' |
  'spotCumVolume' | 'futuresVolume' | 'spread' | 'daysLeft' | 'theoreticalBasis' | 'basisGap'
>

const ABS_KEYS: SK[] = ['marketBasis', 'basisGapBp', 'basisGap', 'theoreticalBasis']

export function StockArbitragePage() {
  const [master, setMaster] = useState<Master | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sk, setSk] = useState<SK>('basisGapBp')
  const [asc, setAsc] = useState(false)

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
      const seed = parseInt(item.base_code.slice(-4), 10) || (idx + 1) * 137
      const mock = !spot && !front
      const bp = mock ? 10000 + (seed % 50) * 5000 : 0
      const sp = spot?.price ?? (mock ? bp : 0)
      const fp = front?.price ?? (mock ? bp + (seed % 200 - 100) : 0)
      const mb = front?.basis ?? (mock ? fp - sp : 0)
      const tp = mock ? bp + (seed % 80 - 30) : 0
      const tb = mock ? tp - sp : 0
      const g = mock ? mb - tb : 0
      const gbp = sp > 0 ? (g / sp) * 10000 : 0
      const bkp = back?.price ?? (mock ? fp + (seed % 60 - 20) : 0)
      return {
        baseCode: item.base_code, baseName: item.base_name,
        frontCode: item.front.code, backCode: item.back?.code ?? '',
        multiplier: item.front.multiplier, expiry: item.front.expiry, daysLeft: item.front.days_left || 28,
        spotPrice: sp, spotCumVolume: spot?.cum_volume ?? (mock ? (seed % 300 + 50) * 1e8 : 0),
        futuresPrice: fp, futuresVolume: front?.volume ?? (mock ? seed % 2000 + 100 : 0),
        theoreticalPrice: tp, theoreticalBasis: tb, marketBasis: mb, basisGap: g, basisGapBp: gbp,
        backPrice: bkp, spread: bkp > 0 && fp > 0 ? bkp - fp : 0,
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
      list = list.filter((r) => r.baseName.toLowerCase().includes(q) || r.baseCode.includes(q) || r.frontCode.toLowerCase().includes(q))
    }
    list.sort((a, b) => {
      const av = a[sk] ?? 0, bv = b[sk] ?? 0
      if (sk === 'baseName') return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
      if (ABS_KEYS.includes(sk)) return asc ? Math.abs(+av) - Math.abs(+bv) : Math.abs(+bv) - Math.abs(+av)
      return asc ? +av - +bv : +bv - +av
    })
    return list
  }, [rows, search, sk, asc])

  const doSort = (k: SK) => { if (sk === k) setAsc(!asc); else { setSk(k); setAsc(false) } }

  if (loading) return <Center>마스터 데이터 로딩 중...</Center>
  if (error) return <Center className="text-down">로드 실패: {error}</Center>

  return (
    <div className="flex flex-col h-full bg-black">
      {/* 헤더 */}
      <div className="px-6 py-4 flex items-center gap-5 shrink-0">
        <h1 className="text-[14px] text-white">종목차익</h1>
        <span className="text-[10px] text-[#8b8b8e]">{master?.count}종목 · 근월 {master?.front_month} · {master?.updated}</span>
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

      {/* 테이블 */}
      <div className="flex-1 overflow-auto min-h-0 px-2">
        <table className="w-max min-w-full border-collapse">
          <thead className="sticky top-0 z-20">
            <tr className="text-[10px] text-[#8b8b8e] bg-black">
              {/* 종목 */}
              <Th sort={() => doSort('baseName')} active={sk === 'baseName'} asc={asc} left sticky className="pl-4 min-w-[120px]">종목</Th>
              {/* 가격 */}
              <Th sort={() => doSort('spotPrice')} active={sk === 'spotPrice'} asc={asc} className="min-w-[90px]">현물가</Th>
              <Th sort={() => doSort('futuresPrice')} active={sk === 'futuresPrice'} asc={asc} className="min-w-[90px]">선물가</Th>
              <Th className="min-w-[90px]">이론가</Th>
              {/* 베이시스 */}
              <Th sort={() => doSort('theoreticalBasis')} active={sk === 'theoreticalBasis'} asc={asc} className="min-w-[76px]">이론B</Th>
              <Th sort={() => doSort('marketBasis')} active={sk === 'marketBasis'} asc={asc} className="min-w-[76px]">시장B</Th>
              <Th sort={() => doSort('basisGap')} active={sk === 'basisGap'} asc={asc} className="min-w-[76px]">갭</Th>
              <Th sort={() => doSort('basisGapBp')} active={sk === 'basisGapBp'} asc={asc} className="min-w-[68px]">갭(bp)</Th>
              {/* 거래 */}
              <Th sort={() => doSort('spotCumVolume')} active={sk === 'spotCumVolume'} asc={asc} className="min-w-[90px]">현물대금</Th>
              <Th sort={() => doSort('futuresVolume')} active={sk === 'futuresVolume'} asc={asc} className="min-w-[76px]">선물량</Th>
              <Th className="min-w-[44px]">승수</Th>
              {/* 스프레드 */}
              <Th sort={() => doSort('spread')} active={sk === 'spread'} asc={asc} className="min-w-[76px]">스프레드</Th>
              <Th className="min-w-[64px]">스프량</Th>
              {/* 배당 */}
              <Th className="min-w-[64px]">배당금</Th>
              <Th className="min-w-[72px]">기준일</Th>
              <Th className="min-w-[40px]">적용</Th>
              {/* 만기 */}
              <Th sort={() => doSort('daysLeft')} active={sk === 'daysLeft'} asc={asc} className="min-w-[52px]">잔존</Th>
              {/* 액션 */}
              <Th className="min-w-[44px]">호가</Th>
              <Th className="min-w-[44px]">스프</Th>
              {/* 보유 */}
              <Th className="min-w-[56px]">031</Th>
              <Th className="min-w-[56px]">052</Th>
              <Th className="min-w-[40px]">펀드</Th>
              <Th className="min-w-[56px] pr-4">선물</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.baseCode} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors">
                {/* 종목 */}
                <td className="pl-4 pr-3 py-[5px] sticky left-0 bg-black z-10">
                  <div className="text-[11px] text-white leading-none">{r.baseName}</div>
                  <div className="text-[9px] text-[#5a5a5e] leading-none mt-[2px] tabular-nums">
                    {r.baseCode} / {r.frontCode}
                  </div>
                </td>
                {/* 가격 */}
                <C>{fP(r.spotPrice)}</C>
                <C>{fP(r.futuresPrice)}</C>
                <C sub>{fP(r.theoreticalPrice)}</C>
                {/* 베이시스 */}
                <C c={cV(r.theoreticalBasis)}>{fB(r.theoreticalBasis)}</C>
                <C c={cV(r.marketBasis)}>{fB(r.marketBasis)}</C>
                <C c={cV(r.basisGap)}>{fB(r.basisGap)}</C>
                <C c={cV(r.basisGapBp)}>{fBp(r.basisGapBp)}</C>
                {/* 거래 */}
                <C sub>{r.spotCumVolume ? fVol(r.spotCumVolume) : '-'}</C>
                <C sub>{r.futuresVolume ? r.futuresVolume.toLocaleString() : '-'}</C>
                <C mute>{r.multiplier}</C>
                {/* 스프레드 */}
                <C c={cV(r.spread)}>{r.spread ? fB(r.spread) : '-'}</C>
                <C sub>{r.spreadVolume ? r.spreadVolume.toLocaleString() : '-'}</C>
                {/* 배당 */}
                <C sub>{r.dividend ? r.dividend.toLocaleString() : '-'}</C>
                <C mute>{r.dividendDate ? r.dividendDate.slice(5) : '-'}</C>
                <C mute>{r.dividendApplied ? 'Y' : '-'}</C>
                {/* 만기 */}
                <C mute>{r.daysLeft > 0 ? `${r.daysLeft}` : '-'}</C>
                {/* 액션 */}
                <td className="px-2 py-[5px] text-center">
                  <button className="text-[10px] text-[#5a5a5e] hover:text-white transition-colors">호가</button>
                </td>
                <td className="px-2 py-[5px] text-center">
                  <button className="text-[10px] text-[#5a5a5e] hover:text-white transition-colors">스프</button>
                </td>
                {/* 보유 */}
                <C sub>{r.holding031 || '-'}</C>
                <C sub>{r.holding052 || '-'}</C>
                <td className="px-2 py-[5px] text-center">
                  <button className="text-[10px] text-[#5a5a5e] hover:text-white transition-colors">조회</button>
                </td>
                <C sub className="pr-4">{r.futuresHolding || '-'}</C>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
        'px-2 py-[5px] font-normal whitespace-nowrap border-b border-white/[0.06]',
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
      'px-2 py-[5px] text-right text-[11px] tabular-nums whitespace-nowrap',
      c || (mute ? 'text-[#5a5a5e]' : sub ? 'text-[#8b8b8e]' : 'text-[#e0e0e3]'),
      className,
    )}>
      {children}
    </td>
  )
}

// ── 포맷 ──

function cV(v: number) { return !v ? 'text-[#5a5a5e]' : v > 0 ? 'text-[#00b26b]' : 'text-[#f6465d]' }
function fP(v: number) { return v ? v.toLocaleString() : '-' }
function fB(v: number) { return !v ? '-' : `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}` }
function fBp(v: number) { return !v ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(1)}` }
function fVol(v: number) {
  if (v >= 1e12) return `${(v / 1e12).toFixed(1)}조`
  if (v >= 1e8) return `${(v / 1e8).toFixed(0)}억`
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}만`
  return v.toLocaleString()
}
