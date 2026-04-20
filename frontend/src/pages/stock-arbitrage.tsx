import { useEffect, useMemo, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'

// ── 타입 ──

interface MasterItem {
  base_code: string
  base_name: string
  spot_price?: number
  spot_value?: number
  front: { code: string; name: string; expiry: string; days_left: number; multiplier: number; price?: number; volume?: number }
  back?: { code: string; name: string; expiry: string; days_left: number; multiplier: number; price?: number; volume?: number }
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
  const [month, setMonth] = useState<'front' | 'back'>('front')

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)

  useEffect(() => {
    fetch('/api/arbitrage/master')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setMaster(d); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  // 구독: Rust가 시작 시 마스터 기반으로 전체 자동 구독.
  // 프론트에서는 별도 구독 관리 불필요.

  const rows = useMemo(() => {
    if (!master) return [] as Row[]
    return master.items.map((item, idx): Row => {
      const spot = stockTicks[item.base_code]
      // 선택된 월물에 따라 선물 데이터 참조
      const sel = month === 'back' && item.back ? item.back : item.front
      const other = month === 'back' ? item.front : item.back
      const fut = futuresTicks[sel.code]
      const otherFut = other ? futuresTicks[other.code] : undefined

      const sp = spot?.price ?? item.spot_price ?? 0
      const fp = fut?.price ?? sel.price ?? 0
      const mb = fp > 0 && sp > 0 ? fp - sp : (fut?.basis ?? 0)
      const tb = 0 // 이론베이시스 (Phase B에서 구현)
      const gap = mb - tb
      const ofp = otherFut?.price ?? other?.price ?? 0
      // 스프레드: 항상 원월 - 근월
      const frontP = month === 'front' ? fp : ofp
      const backP = month === 'front' ? ofp : fp
      return {
        baseCode: item.base_code, baseName: item.base_name,
        frontCode: sel.code, backCode: other?.code ?? '',
        multiplier: sel.multiplier, expiry: sel.expiry, daysLeft: sel.days_left || 0,
        spotPrice: sp, spotCumVolume: (spot?.cum_volume || 0) > 0 ? spot!.cum_volume : (item.spot_value ?? 0),
        futuresPrice: fp, futuresVolume: fut?.volume ?? sel.volume ?? 0,
        theoreticalPrice: 0, theoreticalBasis: tb,
        marketBasis: mb, basisGap: gap, basisGapBp: sp > 0 ? (gap / sp) * 10000 : 0,
        backPrice: backP, spread: backP > 0 && frontP > 0 ? backP - frontP : 0,
        spreadVolume: 0,
        dividend: 0, dividendDate: '', dividendApplied: false,
        holding031: 0, holding052: 0, futuresHolding: 0,
      }
    })
  }, [master, stockTicks, futuresTicks, month])

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
        <span className="text-[10px] text-[#8b8b8e]">{master?.count}종목 · {master?.updated}</span>
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
              <Th sort={() => doSort('baseName')} active={sk === 'baseName'} asc={asc} left sticky className="pl-4 min-w-[110px]">종목</Th>
              {/* 가격 */}
              <Th sort={() => doSort('spotPrice')} active={sk === 'spotPrice'} asc={asc} className="min-w-[74px]">현물가</Th>
              <Th sort={() => doSort('futuresPrice')} active={sk === 'futuresPrice'} asc={asc} className="min-w-[74px]">선물가</Th>
              <Th className="min-w-[74px]">이론가</Th>
              {/* 베이시스 */}
              <Th sort={() => doSort('theoreticalBasis')} active={sk === 'theoreticalBasis'} asc={asc} className="min-w-[62px]">이론B</Th>
              <Th sort={() => doSort('marketBasis')} active={sk === 'marketBasis'} asc={asc} className="min-w-[62px]">시장B</Th>
              <Th sort={() => doSort('basisGap')} active={sk === 'basisGap'} asc={asc} className="min-w-[62px]">갭</Th>
              <Th sort={() => doSort('basisGapBp')} active={sk === 'basisGapBp'} asc={asc} className="min-w-[56px]">갭bp</Th>
              {/* 거래 */}
              <Th sort={() => doSort('spotCumVolume')} active={sk === 'spotCumVolume'} asc={asc} className="min-w-[76px]">현물대금</Th>
              <Th sort={() => doSort('futuresVolume')} active={sk === 'futuresVolume'} asc={asc} className="min-w-[64px]">선물량</Th>
              <Th className="min-w-[42px]">승수</Th>
              {/* 스프레드 */}
              <Th sort={() => doSort('spread')} active={sk === 'spread'} asc={asc} className="min-w-[64px]">스프레드</Th>
              <Th className="min-w-[52px]">스프량</Th>
              {/* 배당 */}
              <Th className="min-w-[56px]">배당금</Th>
              <Th className="min-w-[62px]">기준일</Th>
              <Th className="min-w-[34px]">적용</Th>
              {/* 만기 */}
              <Th sort={() => doSort('daysLeft')} active={sk === 'daysLeft'} asc={asc} className="min-w-[44px]">잔존</Th>
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
                <C mute>{r.multiplier % 1 === 0 ? r.multiplier : r.multiplier.toFixed(2)}</C>
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
                <td className="px-2 py-[11px] text-center">
                  <button className="text-[10px] text-[#5a5a5e] hover:text-white transition-colors">호가</button>
                </td>
                <td className="px-2 py-[11px] text-center">
                  <button className="text-[10px] text-[#5a5a5e] hover:text-white transition-colors">스프</button>
                </td>
                {/* 보유 */}
                <C>{r.holding031 ? r.holding031.toLocaleString() : '-'}</C>
                <C>{r.holding052 ? r.holding052.toLocaleString() : '-'}</C>
                <td className="px-2 py-[11px] text-center">
                  <button className="text-[10px] text-[#5a5a5e] hover:text-white transition-colors">조회</button>
                </td>
                <C sub className="pr-4">{r.futuresHolding ? r.futuresHolding.toLocaleString() : '-'}</C>
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
      c || (mute ? 'text-[#5a5a5e]' : sub ? 'text-[#8b8b8e]' : 'text-[#e0e0e3]'),
      className,
    )}>
      {children}
    </td>
  )
}

// ── 포맷 ──

function cV(v: number) { return v === 0 ? 'text-[#e0e0e3]' : v > 0 ? 'text-[#00b26b]' : 'text-[#bb4a65]' }
function fP(v: number) { return v ? v.toLocaleString() : '-' }
function fB(v: number) { return `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}` }
function fBp(v: number) { return `${v > 0 ? '+' : ''}${v.toFixed(1)}` }
function fVol(v: number) {
  if (v >= 1e12) return `${(v / 1e12).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}조`
  if (v >= 1e8) return `${Math.round(v / 1e8).toLocaleString()}억`
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`
  return v.toLocaleString()
}
