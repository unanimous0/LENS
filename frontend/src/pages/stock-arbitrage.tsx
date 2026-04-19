import { useEffect, useMemo, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'

// ── 마스터 데이터 타입 ──

interface FuturesMasterItem {
  base_code: string
  base_name: string
  front: {
    code: string
    name: string
    expiry: string
    days_left: number
    multiplier: number
  }
  back?: {
    code: string
    name: string
    expiry: string
    days_left: number
    multiplier: number
  }
}

interface FuturesMaster {
  updated: string
  front_month: string
  back_month: string
  count: number
  items: FuturesMasterItem[]
}

// ── 테이블 행 데이터 (마스터 + 실시간 조인) ──

interface ArbitrageRow {
  baseCode: string
  baseName: string
  frontCode: string
  backCode: string
  multiplier: number
  expiry: string
  daysLeft: number
  // 실시간 (stock_tick)
  spotPrice: number
  spotVolume: number
  spotCumVolume: number
  // 실시간 (futures_tick)
  futuresPrice: number
  futuresVolume: number
  // 계산
  marketBasis: number
  marketBasisBp: number
  // 스프레드 (원월-근월)
  backPrice: number
  spread: number
}

type SortKey = 'baseName' | 'spotPrice' | 'futuresPrice' | 'marketBasis' | 'marketBasisBp' | 'spotCumVolume' | 'futuresVolume' | 'spread' | 'daysLeft'

export function StockArbitragePage() {
  const [master, setMaster] = useState<FuturesMaster | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('marketBasisBp')
  const [sortAsc, setSortAsc] = useState(false)

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)

  // 마스터 데이터 로드
  useEffect(() => {
    fetch('/api/arbitrage/master')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        setMaster(data)
        setLoading(false)
      })
      .catch((e) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  // 마스터 + 실시간 데이터 조인
  const rows: ArbitrageRow[] = useMemo(() => {
    if (!master) return []
    return master.items.map((item) => {
      const spot = stockTicks[item.base_code]
      const front = futuresTicks[item.front.code]
      const back = item.back ? futuresTicks[item.back.code] : undefined

      const spotPrice = spot?.price ?? 0
      const futuresPrice = front?.price ?? 0
      const marketBasis = front?.basis ?? 0
      const marketBasisBp = spotPrice > 0 ? (marketBasis / spotPrice) * 10000 : 0
      const backPrice = back?.price ?? 0
      const spread = backPrice > 0 && futuresPrice > 0 ? backPrice - futuresPrice : 0

      return {
        baseCode: item.base_code,
        baseName: item.base_name,
        frontCode: item.front.code,
        backCode: item.back?.code ?? '',
        multiplier: item.front.multiplier,
        expiry: item.front.expiry,
        daysLeft: item.front.days_left,
        spotPrice,
        spotVolume: spot?.volume ?? 0,
        spotCumVolume: spot?.cum_volume ?? 0,
        futuresPrice,
        futuresVolume: front?.volume ?? 0,
        marketBasis,
        marketBasisBp,
        backPrice,
        spread,
      }
    })
  }, [master, stockTicks, futuresTicks])

  // 필터 + 정렬
  const filtered = useMemo(() => {
    let list = rows
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(
        (r) =>
          r.baseName.toLowerCase().includes(q) ||
          r.baseCode.includes(q) ||
          r.frontCode.toLowerCase().includes(q)
      )
    }
    list.sort((a, b) => {
      const av = a[sortKey] ?? 0
      const bv = b[sortKey] ?? 0
      if (sortKey === 'baseName') {
        return sortAsc
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av))
      }
      // 숫자: 절대값 기반 정렬 (베이시스 관련)
      if (sortKey === 'marketBasis' || sortKey === 'marketBasisBp') {
        return sortAsc
          ? Math.abs(Number(av)) - Math.abs(Number(bv))
          : Math.abs(Number(bv)) - Math.abs(Number(av))
      }
      return sortAsc ? Number(av) - Number(bv) : Number(bv) - Number(av)
    })
    return list
  }, [rows, search, sortKey, sortAsc])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-t3">마스터 데이터 로딩 중...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-down">마스터 데이터 로드 실패: {error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-bg-base">
      {/* 상단 바 */}
      <div className="panel px-4 py-2.5 flex items-center gap-4 shrink-0">
        <span className="text-sm font-semibold text-t1">종목차익</span>
        <span className="text-[11px] text-t4">
          {master?.count ?? 0}종목 · 근월 {master?.front_month} · 갱신 {master?.updated}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <input
            type="text"
            placeholder="종목명 / 코드 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48 rounded bg-bg-input px-3 py-1.5 text-xs text-t1 placeholder:text-t4 outline-none border border-border-light focus:border-accent transition-colors"
          />
          <span className="text-[11px] text-t4 font-mono">{filtered.length}건</span>
        </div>
      </div>

      {/* 테이블 */}
      <div className="flex-1 overflow-x-auto overflow-y-auto min-h-0">
        <table className="w-max min-w-full text-[12px]">
          {/* 그룹 헤더 */}
          <thead className="sticky top-0 z-20">
            <tr className="bg-bg-surface text-[10px] text-t4 border-b border-border">
              <th colSpan={3} className="px-3 py-1 text-left font-normal sticky left-0 bg-bg-surface z-30">종목</th>
              <th colSpan={2} className="px-3 py-1 text-center font-normal border-l border-border-light">가격</th>
              <th colSpan={2} className="px-3 py-1 text-center font-normal border-l border-border-light">베이시스</th>
              <th colSpan={3} className="px-3 py-1 text-center font-normal border-l border-border-light">거래</th>
              <th colSpan={2} className="px-3 py-1 text-center font-normal border-l border-border-light">스프레드</th>
              <th colSpan={1} className="px-3 py-1 text-center font-normal border-l border-border-light">만기</th>
            </tr>
            {/* 컬럼 헤더 */}
            <tr className="bg-bg-surface text-[11px] text-t3 border-b border-border-light">
              {/* 종목 (고정) */}
              <SortTh sortKey="baseName" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="sticky left-0 bg-bg-surface z-30 min-w-[120px] text-left">종목명</SortTh>
              <th className="px-2 py-1.5 font-medium text-right sticky left-[120px] bg-bg-surface z-30 min-w-[64px]">현물코드</th>
              <th className="px-2 py-1.5 font-medium text-right sticky left-[184px] bg-bg-surface z-30 min-w-[72px]">선물코드</th>
              {/* 가격 */}
              <SortTh sortKey="spotPrice" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[88px]">현물가</SortTh>
              <SortTh sortKey="futuresPrice" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[88px]">선물가</SortTh>
              {/* 베이시스 */}
              <SortTh sortKey="marketBasis" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[80px]">시장B</SortTh>
              <SortTh sortKey="marketBasisBp" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[72px]">B(bp)</SortTh>
              {/* 거래 */}
              <SortTh sortKey="spotCumVolume" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[96px]">현물거래대금</SortTh>
              <SortTh sortKey="futuresVolume" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[80px]">선물거래량</SortTh>
              <th className="px-2 py-1.5 font-medium text-right min-w-[48px]">승수</th>
              {/* 스프레드 */}
              <SortTh sortKey="spread" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[80px]">스프레드</SortTh>
              <th className="px-2 py-1.5 font-medium text-right min-w-[80px]">원월가</th>
              {/* 만기 */}
              <SortTh sortKey="daysLeft" currentKey={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[56px]">잔존</SortTh>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.baseCode}
                className="border-b border-border hover:bg-bg-hover transition-colors"
              >
                {/* 종목 (고정) */}
                <td className="px-2 py-1.5 sticky left-0 bg-bg-primary z-10 font-medium text-t1 truncate max-w-[120px]">
                  {row.baseName}
                </td>
                <td className="px-2 py-1.5 sticky left-[120px] bg-bg-primary z-10 font-mono text-[11px] text-t4 text-right">
                  {row.baseCode}
                </td>
                <td className="px-2 py-1.5 sticky left-[184px] bg-bg-primary z-10 font-mono text-[11px] text-t4 text-right">
                  {row.frontCode}
                </td>
                {/* 가격 */}
                <td className="px-2 py-1.5 font-mono text-right text-t1 border-l border-border-light">
                  {row.spotPrice ? row.spotPrice.toLocaleString() : '-'}
                </td>
                <td className="px-2 py-1.5 font-mono text-right text-t1">
                  {row.futuresPrice ? row.futuresPrice.toLocaleString() : '-'}
                </td>
                {/* 베이시스 */}
                <td className={cn(
                  'px-2 py-1.5 font-mono text-right border-l border-border-light',
                  basisColor(row.marketBasis)
                )}>
                  {row.spotPrice ? formatBasis(row.marketBasis) : '-'}
                </td>
                <td className={cn(
                  'px-2 py-1.5 font-mono text-right',
                  basisColor(row.marketBasisBp)
                )}>
                  {row.spotPrice ? formatBp(row.marketBasisBp) : '-'}
                </td>
                {/* 거래 */}
                <td className="px-2 py-1.5 font-mono text-right text-t3 border-l border-border-light">
                  {row.spotCumVolume ? formatVolume(row.spotCumVolume) : '-'}
                </td>
                <td className="px-2 py-1.5 font-mono text-right text-t3">
                  {row.futuresVolume ? row.futuresVolume.toLocaleString() : '-'}
                </td>
                <td className="px-2 py-1.5 font-mono text-right text-t4">
                  {row.multiplier}
                </td>
                {/* 스프레드 */}
                <td className={cn(
                  'px-2 py-1.5 font-mono text-right border-l border-border-light',
                  basisColor(row.spread)
                )}>
                  {row.spread ? formatBasis(row.spread) : '-'}
                </td>
                <td className="px-2 py-1.5 font-mono text-right text-t3">
                  {row.backPrice ? row.backPrice.toLocaleString() : '-'}
                </td>
                {/* 만기 */}
                <td className="px-2 py-1.5 font-mono text-right text-t4 border-l border-border-light">
                  {row.daysLeft > 0 ? `${row.daysLeft}일` : row.expiry || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 정렬 가능한 테이블 헤더 ──

function SortTh({
  sortKey,
  currentKey,
  asc,
  onClick,
  className,
  children,
}: {
  sortKey: SortKey
  currentKey: SortKey
  asc: boolean
  onClick: (key: SortKey) => void
  className?: string
  children: React.ReactNode
}) {
  const isActive = currentKey === sortKey
  return (
    <th
      className={cn(
        'px-2 py-1.5 font-medium text-right cursor-pointer select-none hover:text-t1 transition-colors',
        isActive ? 'text-accent' : '',
        className
      )}
      onClick={() => onClick(sortKey)}
    >
      {children}
      {isActive && (
        <span className="ml-0.5 text-[9px]">{asc ? '▲' : '▼'}</span>
      )}
    </th>
  )
}

// ── 유틸리티 ──

function basisColor(value: number): string {
  if (!value) return 'text-t3'
  if (value > 0) return 'text-up'
  if (value < 0) return 'text-down'
  return 'text-t3'
}

function formatBasis(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}`
}

function formatBp(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}`
}

function formatVolume(value: number): string {
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)}조`
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(0)}억`
  if (value >= 10_000) return `${(value / 10_000).toFixed(0)}만`
  return value.toLocaleString()
}
