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
  // 베이시스
  theoreticalPrice: number   // 추후
  theoreticalBasis: number   // 추후
  marketBasis: number
  basisGap: number           // 추후
  basisGapBp: number         // 추후
  // 스프레드 (원월-근월)
  backPrice: number
  spread: number
  spreadVolume: number       // 추후
  // 배당
  dividend: number           // 추후
  dividendDate: string       // 추후
  dividendApplied: boolean   // 추후
  // 보유 (내부망)
  holding031: number         // 추후
  holding052: number         // 추후
  futuresHolding: number     // 추후
}

type SortKey = 'baseName' | 'spotPrice' | 'futuresPrice' | 'marketBasis' | 'basisGapBp' | 'spotCumVolume' | 'futuresVolume' | 'spread' | 'daysLeft' | 'theoreticalBasis' | 'basisGap'

export function StockArbitragePage() {
  const [master, setMaster] = useState<FuturesMaster | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('basisGapBp')
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
        theoreticalPrice: 0,
        theoreticalBasis: 0,
        marketBasis,
        basisGap: 0,
        basisGapBp: 0,
        backPrice,
        spread,
        spreadVolume: 0,
        dividend: 0,
        dividendDate: '',
        dividendApplied: false,
        holding031: 0,
        holding052: 0,
        futuresHolding: 0,
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
      if (sortKey === 'marketBasis' || sortKey === 'basisGapBp' || sortKey === 'basisGap' || sortKey === 'theoreticalBasis') {
        return sortAsc
          ? Math.abs(Number(av)) - Math.abs(Number(bv))
          : Math.abs(Number(bv)) - Math.abs(Number(av))
      }
      return sortAsc ? Number(av) - Number(bv) : Number(bv) - Number(av)
    })
    return list
  }, [rows, search, sortKey, sortAsc])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc)
    else { setSortKey(key); setSortAsc(false) }
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
          <thead className="sticky top-0 z-20">
            {/* 그룹 헤더 */}
            <tr className="bg-bg-surface text-[10px] text-t4 border-b border-border">
              <th colSpan={3} className="px-3 py-1 text-left font-normal sticky left-0 bg-bg-surface z-30">종목</th>
              <th colSpan={3} className="px-3 py-1 text-center font-normal border-l border-border-light">가격</th>
              <th colSpan={4} className="px-3 py-1 text-center font-normal border-l border-border-light">베이시스</th>
              <th colSpan={3} className="px-3 py-1 text-center font-normal border-l border-border-light">거래</th>
              <th colSpan={2} className="px-3 py-1 text-center font-normal border-l border-border-light">스프레드</th>
              <th colSpan={3} className="px-3 py-1 text-center font-normal border-l border-border-light">배당</th>
              <th colSpan={1} className="px-3 py-1 text-center font-normal border-l border-border-light">만기</th>
              <th colSpan={2} className="px-3 py-1 text-center font-normal border-l border-border-light">액션</th>
              <th colSpan={4} className="px-3 py-1 text-center font-normal border-l border-border-light">보유 (내부망)</th>
            </tr>
            {/* 컬럼 헤더 */}
            <tr className="bg-bg-surface text-[11px] text-t3 border-b border-border-light">
              {/* 종목 — 고정 */}
              <SortTh k="baseName" cur={sortKey} asc={sortAsc} onClick={handleSort} className="sticky left-0 bg-bg-surface z-30 min-w-[110px] text-left">종목명</SortTh>
              <Th className="sticky left-[110px] bg-bg-surface z-30 min-w-[60px]">현물코드</Th>
              <Th className="sticky left-[170px] bg-bg-surface z-30 min-w-[68px]">선물코드</Th>
              {/* 가격 */}
              <SortTh k="spotPrice" cur={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[80px]">현물가</SortTh>
              <SortTh k="futuresPrice" cur={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[80px]">선물가</SortTh>
              <Th className="min-w-[80px]">이론가</Th>
              {/* 베이시스 */}
              <SortTh k="theoreticalBasis" cur={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[68px]">이론B</SortTh>
              <SortTh k="marketBasis" cur={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[68px]">시장B</SortTh>
              <SortTh k="basisGap" cur={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[68px]">갭</SortTh>
              <SortTh k="basisGapBp" cur={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[60px]">갭bp</SortTh>
              {/* 거래 */}
              <SortTh k="spotCumVolume" cur={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[88px]">현물거래대금</SortTh>
              <SortTh k="futuresVolume" cur={sortKey} asc={sortAsc} onClick={handleSort} className="min-w-[72px]">선물거래량</SortTh>
              <Th className="min-w-[40px]">승수</Th>
              {/* 스프레드 */}
              <SortTh k="spread" cur={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[72px]">스프레드</SortTh>
              <Th className="min-w-[64px]">스프레드량</Th>
              {/* 배당 */}
              <Th className="border-l border-border-light min-w-[64px]">배당금</Th>
              <Th className="min-w-[72px]">배당기준일</Th>
              <Th className="min-w-[40px]">적용</Th>
              {/* 만기 */}
              <SortTh k="daysLeft" cur={sortKey} asc={sortAsc} onClick={handleSort} className="border-l border-border-light min-w-[48px]">잔존</SortTh>
              {/* 액션 */}
              <Th className="border-l border-border-light min-w-[48px]">호가</Th>
              <Th className="min-w-[48px]">스프호가</Th>
              {/* 보유 (내부망) */}
              <Th className="border-l border-border-light min-w-[56px]">031</Th>
              <Th className="min-w-[56px]">052</Th>
              <Th className="min-w-[40px]">펀드</Th>
              <Th className="min-w-[56px]">선물보유</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr key={row.baseCode} className="border-b border-border hover:bg-bg-hover transition-colors">
                {/* 종목 — 고정 */}
                <td className="px-2 py-1.5 sticky left-0 bg-bg-primary z-10 font-medium text-t1 truncate max-w-[110px]">{row.baseName}</td>
                <td className="px-2 py-1.5 sticky left-[110px] bg-bg-primary z-10 font-mono text-[11px] text-t4 text-right">{row.baseCode}</td>
                <td className="px-2 py-1.5 sticky left-[170px] bg-bg-primary z-10 font-mono text-[11px] text-t4 text-right">{row.frontCode}</td>
                {/* 가격 */}
                <Td border>{fmtPrice(row.spotPrice)}</Td>
                <Td>{fmtPrice(row.futuresPrice)}</Td>
                <Td dim>{fmtPrice(row.theoreticalPrice)}</Td>
                {/* 베이시스 */}
                <Td border color={basisColor(row.theoreticalBasis)}>{fmtBasis(row.theoreticalBasis)}</Td>
                <Td color={basisColor(row.marketBasis)}>{row.spotPrice ? fmtBasis(row.marketBasis) : '-'}</Td>
                <Td color={basisColor(row.basisGap)}>{fmtBasis(row.basisGap)}</Td>
                <Td color={basisColor(row.basisGapBp)}>{fmtBp(row.basisGapBp)}</Td>
                {/* 거래 */}
                <Td border dim>{row.spotCumVolume ? fmtVolume(row.spotCumVolume) : '-'}</Td>
                <Td dim>{row.futuresVolume ? row.futuresVolume.toLocaleString() : '-'}</Td>
                <Td vdim>{row.multiplier}</Td>
                {/* 스프레드 */}
                <Td border color={basisColor(row.spread)}>{row.spread ? fmtBasis(row.spread) : '-'}</Td>
                <Td dim>{row.spreadVolume ? row.spreadVolume.toLocaleString() : '-'}</Td>
                {/* 배당 */}
                <Td border dim>{row.dividend ? row.dividend.toLocaleString() : '-'}</Td>
                <Td dim>{row.dividendDate || '-'}</Td>
                <Td vdim>{row.dividendApplied ? 'Y' : '-'}</Td>
                {/* 만기 */}
                <Td border vdim>{row.daysLeft > 0 ? `${row.daysLeft}일` : row.expiry || '-'}</Td>
                {/* 액션 */}
                <td className="px-1 py-1 text-center border-l border-border-light">
                  <button className="px-1.5 py-0.5 rounded text-[10px] text-t3 bg-bg-surface-2 hover:text-t1 hover:bg-bg-surface-3 transition-colors">호가</button>
                </td>
                <td className="px-1 py-1 text-center">
                  <button className="px-1.5 py-0.5 rounded text-[10px] text-t3 bg-bg-surface-2 hover:text-t1 hover:bg-bg-surface-3 transition-colors">스프</button>
                </td>
                {/* 보유 (내부망) */}
                <Td border dim>{row.holding031 || '-'}</Td>
                <Td dim>{row.holding052 || '-'}</Td>
                <td className="px-1 py-1 text-center">
                  <button className="px-1.5 py-0.5 rounded text-[10px] text-t3 bg-bg-surface-2 hover:text-t1 hover:bg-bg-surface-3 transition-colors">조회</button>
                </td>
                <Td dim>{row.futuresHolding || '-'}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 공통 셀 컴포넌트 ──

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return <th className={cn('px-2 py-1.5 font-medium text-right', className)}>{children}</th>
}

function Td({ children, border, dim, vdim, color }: {
  children: React.ReactNode
  border?: boolean
  dim?: boolean
  vdim?: boolean
  color?: string
}) {
  return (
    <td className={cn(
      'px-2 py-1.5 font-mono text-right',
      border && 'border-l border-border-light',
      color ? color : dim ? 'text-t3' : vdim ? 'text-t4' : 'text-t1',
    )}>
      {children}
    </td>
  )
}

function SortTh({ k, cur, asc, onClick, className, children }: {
  k: SortKey; cur: SortKey; asc: boolean; onClick: (k: SortKey) => void
  className?: string; children: React.ReactNode
}) {
  const active = cur === k
  return (
    <th
      className={cn('px-2 py-1.5 font-medium text-right cursor-pointer select-none hover:text-t1 transition-colors', active ? 'text-accent' : '', className)}
      onClick={() => onClick(k)}
    >
      {children}{active && <span className="ml-0.5 text-[9px]">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}

// ── 포맷 유틸 ──

function basisColor(v: number): string {
  if (!v) return 'text-t3'
  return v > 0 ? 'text-up' : 'text-down'
}

function fmtPrice(v: number): string { return v ? v.toLocaleString() : '-' }

function fmtBasis(v: number): string {
  if (!v) return '-'
  return `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}`
}

function fmtBp(v: number): string {
  if (!v) return '-'
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

function fmtVolume(v: number): string {
  if (v >= 1_000_000_000_000) return `${(v / 1_000_000_000_000).toFixed(1)}조`
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(0)}억`
  if (v >= 10_000) return `${(v / 10_000).toFixed(0)}만`
  return v.toLocaleString()
}
