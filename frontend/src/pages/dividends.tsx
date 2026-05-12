import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn, todayKst, kstDateOffset } from '@/lib/utils'
import {
  Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis, Cell,
} from 'recharts'

interface Revision {
  version: number
  amount: number
  record_date: string | null
  ex_date: string | null
  announced_at: string | null
  raw_text_url?: string | null
  confirmed?: boolean
  source?: string
}

interface Dividend {
  id: number | string  // 추정치는 'est-CODE-PERIOD-YEAR' 형태의 문자열 ID
  code: string
  name: string
  fiscal_year: number
  period: string
  board_resolution_date: string | null
  announced_at: string | null
  record_date: string | null
  ex_date: string | null
  pay_date: string | null
  amount: number
  yield_pct: number | null
  dividend_type: string
  confirmed: boolean
  estimation_basis: string | null
  charter_group: string | null
  source: string
  version: number
  is_latest: boolean
  raw_text_url: string | null
  revisions: Revision[]
}

interface DividendsResp {
  exported_at: string | null
  source: 'mock' | 'export'
  count: number
  items: Dividend[]
}

// 종목별로 묶은 한 줄 — 다가오는 예상 + 최근 확정 + 종목 메타 + 전체 이력
interface StockRow {
  code: string
  name: string
  charterGroup: string | null
  upcoming: Dividend | null      // ex_date >= today, 가장 가까운 미래
  lastConfirmed: Dividend | null // ex_date < today, 가장 최근 과거
  history: Dividend[]            // 전체 이력 (desc)
  fyYield: number | null         // 올해 fiscal year (calendar year) yield_pct 합산. 확정+추정 포함.
  fyConfirmedCount: number       // 올해 합산에 포함된 확정 배당 건수 (라벨용)
  fyEstimateCount: number        // 올해 합산에 포함된 추정 배당 건수
}

type SK = 'name' | 'charter'
  | 'upcomingDate' | 'upcomingAmount' | 'upcomingStatus' | 'upcomingPeriod' | 'upcomingRev'
  | 'lastDate' | 'lastAmount' | 'lastStatus' | 'lastPeriod' | 'lastRev'
  | 'fyYield'

export function DividendsPage() {
  const [resp, setResp] = useState<DividendsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sk, setSk] = useState<SK>('upcomingDate')
  const [asc, setAsc] = useState(true)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/dividends')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setResp(d); setLoading(false) })
      .catch((e) => { setError(String(e.message ?? e)); setLoading(false) })
  }, [])

  const today = todayKst()

  // 종목별 집계 — 1,246 events → ~250 stocks
  const stockRows = useMemo<StockRow[]>(() => {
    if (!resp) return []
    const byCode = new Map<string, Dividend[]>()
    for (const d of resp.items) {
      if (!d.ex_date) continue
      const arr = byCode.get(d.code)
      if (arr) arr.push(d); else byCode.set(d.code, [d])
    }
    // 올해 (calendar year) 윈도우 — fyYield 계산용
    const yearStart = `${today.slice(0, 4)}-01-01`
    const yearEnd = `${today.slice(0, 4)}-12-31`
    const out: StockRow[] = []
    for (const [code, divs] of byCode) {
      const sorted = [...divs].sort((a, b) => (b.ex_date ?? '').localeCompare(a.ex_date ?? ''))
      const future = sorted.filter((d) => d.ex_date! >= today)
      const upcoming = future.length > 0 ? future[future.length - 1] : null
      const lastConfirmed = sorted.find((d) => d.ex_date! < today) ?? null
      const latest = sorted[0]

      // 올해(calendar year) 배당 yield 합산 — 확정 + 추정 모두 포함.
      // sum of yield_pct ≈ TTM yield 근사 (Finance_Data가 일관된 기준가로 yield_pct 계산해뒀음).
      const inFY = sorted.filter((d) => d.ex_date! >= yearStart && d.ex_date! <= yearEnd)
      const fyYields = inFY.map((d) => d.yield_pct).filter((v): v is number => v != null && v > 0)
      const fyYield = fyYields.length > 0 ? fyYields.reduce((s, v) => s + v, 0) : null
      const fyConfirmedCount = inFY.filter((d) => d.confirmed).length
      const fyEstimateCount = inFY.filter((d) => !d.confirmed).length

      out.push({
        code,
        name: latest.name || code,
        charterGroup: latest.charter_group,
        upcoming,
        lastConfirmed,
        history: sorted,
        fyYield,
        fyConfirmedCount,
        fyEstimateCount,
      })
    }
    return out
  }, [resp, today])

  // 다가오는 30/90일 — 종목 단위로 합산
  const { upcoming30, upcoming90, avgYield } = useMemo(() => {
    if (!stockRows.length) return { upcoming30: 0, upcoming90: 0, avgYield: 0 }
    const e30 = kstDateOffset(30)
    const e90 = kstDateOffset(90)
    const u30 = stockRows.filter((s) => s.upcoming && s.upcoming.ex_date! <= e30).length
    const u90 = stockRows.filter((s) => s.upcoming && s.upcoming.ex_date! <= e90).length
    const yields = stockRows
      .map((s) => s.upcoming?.yield_pct)
      .filter((v): v is number => v != null)
    const avg = yields.length > 0 ? yields.reduce((sum, v) => sum + v, 0) / yields.length : 0
    return { upcoming30: u30, upcoming90: u90, avgYield: avg }
  }, [stockRows])

  // Scatter: 다가오는 90일 (종목별 한 점). 모든 점 표시 (데이터 이슈 가시화 위해 필터 없음).
  const scatterData = useMemo(() => {
    const e90 = kstDateOffset(90)
    return stockRows
      .filter((s) => s.upcoming && s.upcoming.ex_date! <= e90)
      .map((s) => {
        const u = s.upcoming!
        const days = Math.round((new Date(u.ex_date!).getTime() - new Date(today).getTime()) / 86400000)
        return {
          code: s.code, name: s.name, days,
          ex_date: u.ex_date,
          yield: u.yield_pct ?? 0, amount: u.amount,
          period: u.period, confirmed: u.confirmed,
        }
      })
  }, [stockRows, today])

  // 정렬 + 검색
  const rows = useMemo(() => {
    if (!stockRows.length) return []
    let list = stockRows
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((s) => s.name.toLowerCase().includes(q) || s.code.includes(q))
    }
    const sortVal = (s: StockRow): string | number | null => {
      switch (sk) {
        case 'name': return s.name
        case 'charter': return s.charterGroup
        case 'upcomingDate': return s.upcoming?.ex_date ?? null
        case 'upcomingAmount': return s.upcoming?.amount ?? null
        case 'upcomingStatus': return s.upcoming ? (s.upcoming.confirmed ? 'A' : 'B') : null
        case 'upcomingPeriod': return s.upcoming?.period ?? null
        case 'upcomingRev': return s.upcoming?.revisions.length ?? null
        case 'lastDate': return s.lastConfirmed?.ex_date ?? null
        case 'lastAmount': return s.lastConfirmed?.amount ?? null
        case 'lastStatus': return s.lastConfirmed ? (s.lastConfirmed.confirmed ? 'A' : 'B') : null
        case 'lastPeriod': return s.lastConfirmed?.period ?? null
        case 'lastRev': return s.lastConfirmed?.revisions.length ?? null
        case 'fyYield': return s.fyYield
      }
    }
    return [...list].sort((a, b) => {
      const av = sortVal(a), bv = sortVal(b)
      // 빈 값(null)은 정렬 방향과 무관하게 항상 맨 아래
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }, [stockRows, search, sk, asc])

  const doSort = (k: SK) => { if (sk === k) setAsc(!asc); else { setSk(k); setAsc(true) } }
  const selectCode = useCallback((code: string) =>
    setSelectedCode((prev) => prev === code ? null : code),
  [])

  // 차트용: 명시 선택 없으면 현재 정렬/검색 기준 rows[0]으로 폴백
  const chartStock = useMemo(() => {
    const fromCode = selectedCode ? stockRows.find((s) => s.code === selectedCode) : null
    return fromCode ?? rows[0] ?? null
  }, [selectedCode, stockRows, rows])
  // 우측 패널용: 명시 클릭한 종목만. 폴백 없음 (없으면 패널 안 뜸)
  const selectedStock = useMemo(
    () => selectedCode ? stockRows.find((s) => s.code === selectedCode) ?? null : null,
    [selectedCode, stockRows],
  )
  const selected = chartStock  // 기존 호환 (history useMemo 등)

  // 선택 종목 BarChart 데이터 (최근 10건, 시간순)
  const history = useMemo(() => {
    if (!selected) return []
    return [...selected.history]
      .reverse()
      .slice(-10)
      .map((d) => {
        // ex_date에서 월 추출 (YYYY-MM-DD 가정). 없으면 분기에서 추정 (Q1=3, Q2=6, Q3=9, Q4=12)
        const m = d.ex_date?.slice(5, 7) ?? quarterMonth(d.period)
        const monthSuffix = m ? ` (${parseInt(m, 10)}월)` : ''
        return {
          label: `${periodShort(d.period)} ${String(d.fiscal_year).slice(2)}${monthSuffix}`,
          amount: d.amount,
          confirmed: d.confirmed,
        }
      })
  }, [selected])

  // 가상화 (main 단일 스크롤 — CLAUDE.md)
  const tableContainerRef = useRef<HTMLDivElement>(null)
  const mainScrollRef = useRef<HTMLElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  // useLayoutEffect로 매 렌더 후 위치 재측정 — 차트/패널 등 위쪽 레이아웃 shift 반영
  useLayoutEffect(() => {
    if (!mainScrollRef.current) mainScrollRef.current = document.querySelector('main')
    const main = mainScrollRef.current
    const tbl = tableContainerRef.current
    if (!main || !tbl) return
    const top = tbl.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top)
  })

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => mainScrollRef.current,
    estimateSize: () => 56,  // 두 줄 셀 (날짜 + 금액·구분)
    overscan: 8,
    scrollMargin,
  })
  const vItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()
  const padTop = vItems[0] ? vItems[0].start - scrollMargin : 0
  const padBottom = vItems.length > 0 ? totalSize - vItems[vItems.length - 1].end : totalSize

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <p className="text-t3 text-sm">배당 데이터 로딩 중...</p>
    </div>
  )
  if (error) return (
    <div className="flex items-center justify-center py-20">
      <p className="text-down text-sm">로드 실패: {error}</p>
    </div>
  )

  const stockCount = stockRows.length
  const eventCount = resp?.count ?? 0

  return (
    <div className="flex flex-col gap-1 bg-bg-base">
      {/* Controls */}
      <div className="panel">
        <div className="px-4 py-3 flex items-center gap-3">
          <span className="text-sm font-semibold text-t1">배당</span>
          {resp?.source === 'mock' && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning">
              Mock 데이터
            </span>
          )}
          <span className="text-xs text-t3">
            {stockCount}종목 · {eventCount}건
            {resp?.exported_at && ` · 갱신 ${resp.exported_at.slice(0, 10)}`}
          </span>
          <input
            type="text"
            placeholder="종목 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto h-[30px] w-64 bg-bg-input rounded px-3 text-xs text-t1 outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="panel p-4">
        <div className="grid grid-cols-4 gap-3">
          <div className="panel-inner rounded p-4">
            <p className="text-xs text-t3 mb-1">전체 종목</p>
            <p className="font-mono text-2xl font-semibold text-t1">{stockCount}</p>
          </div>
          <div className="panel-inner rounded p-4">
            <p className="text-xs text-t3 mb-1">다가오는 30일</p>
            <p className="font-mono text-2xl font-semibold text-up">{upcoming30}</p>
          </div>
          <div className="panel-inner rounded p-4">
            <p className="text-xs text-t3 mb-1">다가오는 90일</p>
            <p className="font-mono text-2xl font-semibold text-up">{upcoming90}</p>
          </div>
          <div className="panel-inner rounded p-4">
            <p className="text-xs text-t3 mb-1">평균 수익률 (예정)</p>
            <p className="font-mono text-2xl font-semibold text-t1">
              {avgYield > 0 ? `${avgYield.toFixed(2)}%` : '-'}
            </p>
          </div>
        </div>
      </div>

      {/* Charts — 두 패널로 분리 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-1">
        <div className="panel p-4">
          <div>
            <div className="text-xs text-t2 mb-2 font-medium">다가오는 배당 (90일 내)</div>
            <div style={{ width: '100%', height: 300 }}>
              {scatterData.length > 0 ? (
                <ResponsiveContainer>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis type="number" dataKey="days"
                      tick={{ fill: 'var(--color-t3)', fontSize: 10 }}
                      label={{ value: '오늘로부터 (일)', position: 'insideBottom', offset: -10, fill: 'var(--color-t4)', fontSize: 10 }}
                      domain={[0, 90]} ticks={[0, 30, 60, 90]} />
                    <YAxis type="number" dataKey="yield"
                      tick={{ fill: 'var(--color-t3)', fontSize: 10 }}
                      label={{ value: '배당수익률 (%)', angle: -90, position: 'insideLeft', fill: 'var(--color-t4)', fontSize: 10 }}
                      tickFormatter={(v) => v.toFixed(1)} />
                    <ZAxis type="number" dataKey="amount" range={[80, 80]} />
                    <Tooltip
                      cursor={{ strokeDasharray: '3 3', stroke: 'var(--color-t4)' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const d = payload[0].payload
                        return (
                          <div className="bg-bg-surface-2 border border-border rounded px-3 py-2 text-[11px] min-w-[180px]">
                            <div className="font-medium text-t1 mb-1.5 pb-1.5 border-b border-border">
                              {d.name} <span className="text-t3 font-mono ml-1">{d.code}</span>
                            </div>
                            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                              <span className="text-t3">배당락일</span>
                              <span className="text-t1 text-right font-mono tabular-nums">{d.ex_date}</span>
                              <span className="text-t3">D-day</span>
                              <span className="text-t1 text-right font-mono tabular-nums">D+{d.days}</span>
                              <span className="text-t3">배당금</span>
                              <span className="text-t1 text-right font-mono tabular-nums">{d.amount.toLocaleString()}원</span>
                              <span className="text-t3">수익률</span>
                              <span className="text-t1 text-right font-mono tabular-nums">{d.yield.toFixed(2)}%</span>
                              <span className="text-t3">구분</span>
                              <span className="text-t1 text-right font-mono">{periodShort(d.period)}</span>
                              <span className="text-t3">상태</span>
                              <span className={cn('text-right', d.confirmed ? 'text-up' : 'text-warning')}>
                                {d.confirmed ? '확정' : '예상'}
                              </span>
                            </div>
                          </div>
                        )
                      }} />
                    <Scatter data={scatterData} fill="var(--color-up)" onClick={(d: any) => setSelectedCode(d.code)}>
                      {scatterData.map((_, i) => (
                        <Cell key={i} cursor="pointer" />
                      ))}
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-t4">
                  90일 내 배당 예정 종목이 없습니다
                </div>
              )}
            </div>
            <div className="text-[10px] text-t4 mt-1">
              <span className="inline-block w-2 h-2 rounded-full bg-up mr-1 align-middle" /> 다가오는 배당
            </div>
          </div>
        </div>

        <div className="panel p-4">
          <div>
            <div className="text-xs text-t2 mb-2 font-medium">
              {selected ? `${selected.name} 배당 추이 (최근 10건)` : '종목 선택 시 추이 표시'}
            </div>
            <div style={{ width: '100%', height: 300 }}>
              {history.length > 0 ? (
                <ResponsiveContainer>
                  <BarChart data={history} margin={{ top: 24, right: 20, bottom: 10, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--color-t3)', fontSize: 10 }} />
                    <YAxis tick={{ fill: 'var(--color-t3)', fontSize: 10 }} tickFormatter={(v) => v.toLocaleString()} />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                      contentStyle={{ background: 'var(--color-bg-surface-2)', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 11 }}
                      itemStyle={{ color: 'var(--color-t2)' }}
                      formatter={(v: any) => [`${(v as number).toLocaleString()}원`, '배당금']} />
                    <Bar dataKey="amount" isAnimationActive={false}>
                      {history.map((h, i) => (
                        <Cell key={i} fill={h.confirmed ? 'var(--color-up)' : 'var(--color-warning)'} />
                      ))}
                      <LabelList dataKey="amount" position="top"
                        formatter={(v: number) => v.toLocaleString()}
                        style={{
                          fill: 'var(--color-t2)',
                          fontSize: 10,
                          fontFamily: 'var(--font-mono)',
                          fontVariantNumeric: 'tabular-nums',
                        }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-t4">
                  {selected ? '이력 없음' : '아래 표 또는 좌측 차트의 점을 클릭'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main grid: Table + Detail Panel — 패널은 명시 선택 시에만 노출 */}
      <div className={cn('grid gap-1', selectedStock ? 'grid-cols-1 xl:grid-cols-[1fr_400px]' : 'grid-cols-1')}>
        {/* Stock Table */}
        <div className="panel" ref={tableContainerRef}>
          <table className="w-full text-[12px]" style={{ tableLayout: 'fixed', borderCollapse: 'collapse' }}>
            {/* 컬럼: No / 종목 / 정관 / 예상[배당락일·배당금·구분·정정·원문] / 확정[배당락일·배당금·구분·정정·원문] / 수익률 */}
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 48 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 76 }} />
              <col style={{ width: 59 }} />
              <col style={{ width: 50 }} />
              <col style={{ width: 50 }} />
              <col style={{ width: 40 }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 76 }} />
              <col style={{ width: 59 }} />
              <col style={{ width: 50 }} />
              <col style={{ width: 50 }} />
              <col style={{ width: 40 }} />
              <col style={{ width: 64 }} />
            </colgroup>
            <thead className="sticky top-0 z-10">
              <tr className="text-[11px] text-t3 bg-bg-primary">
                <th rowSpan={2} className="text-center px-2 py-2 font-medium align-middle bg-bg-primary">No</th>
                <th rowSpan={2} className="text-left px-2 py-2 font-medium align-middle cursor-pointer select-none hover:text-t1 transition-colors bg-bg-primary"
                  onClick={() => doSort('name')}>
                  종목 <span className="ml-0.5">{sk === 'name' ? (asc ? '▲' : '▼') : ''}</span>
                </th>
                <th rowSpan={2} className="text-center px-2 py-2 font-medium align-middle cursor-pointer select-none hover:text-t1 transition-colors bg-bg-primary"
                  onClick={() => doSort('charter')}>
                  정관 <span className="ml-0.5">{sk === 'charter' ? (asc ? '▲' : '▼') : ''}</span>
                </th>
                <th colSpan={6} className="text-center px-2 py-1.5 font-semibold text-t2 border-x border-border-light/30 bg-bg-primary">다가오는 배당</th>
                <th colSpan={6} className="text-center px-2 py-1.5 font-semibold text-t2 border-x border-border-light/30 bg-bg-primary">최근 배당</th>
                <th rowSpan={2} className="text-right px-2 py-2 font-medium align-middle cursor-pointer select-none hover:text-t1 transition-colors bg-bg-primary"
                  onClick={() => doSort('fyYield')}
                  title={`올해(${today.slice(0, 4)}) 배당 수익률 합산. 확정 + 추정 포함.`}>
                  <div className="leading-tight">
                    <div>수익률 <span className="ml-0.5">{sk === 'fyYield' ? (asc ? '▲' : '▼') : ''}</span></div>
                    <div className="text-[9px] text-t4 font-normal">{today.slice(0, 4)} 예상</div>
                  </div>
                </th>
              </tr>
              <tr className="text-[11px] text-t3 bg-bg-primary border-b border-border-light">
                <SortTh sortKey="upcomingDate" label="배당락일" align="center" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="upcomingAmount" label="배당금" align="right" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="upcomingStatus" label="상태" align="center" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="upcomingPeriod" label="구분" align="center" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="upcomingRev" label="정정" align="center" current={sk} asc={asc} onSort={doSort} />
                <th className="text-center px-2 py-1.5 font-medium border-r border-border-light/30 bg-bg-primary">원문</th>
                <SortTh sortKey="lastDate" label="배당락일" align="center" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="lastAmount" label="배당금" align="right" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="lastStatus" label="상태" align="center" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="lastPeriod" label="구분" align="center" current={sk} asc={asc} onSort={doSort} />
                <SortTh sortKey="lastRev" label="정정" align="center" current={sk} asc={asc} onSort={doSort} />
                <th className="text-center px-2 py-1.5 font-medium border-r border-border-light/30 bg-bg-primary">원문</th>
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
              {vItems.map((vr) => {
                const s = rows[vr.index]
                if (!s) return null
                return (
                  <StockTableRow
                    key={s.code}
                    s={s}
                    i={vr.index}
                    isSelected={s.code === selectedCode}
                    onSelect={selectCode}
                    innerRef={rowVirtualizer.measureElement}
                    dataIndex={vr.index}
                  />
                )
              })}
              {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={16} className="text-center py-12 text-t4 text-sm">
                    {search ? '검색 결과 없음' : '배당 데이터 없음'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Right Detail Panel — 명시 클릭한 종목만 노출 */}
        {selectedStock && (
          <DetailPanel
            s={selectedStock}
            today={today}
            onClose={() => setSelectedCode(null)}
          />
        )}
      </div>
    </div>
  )
}

interface StockTableRowProps {
  s: StockRow
  i: number
  isSelected: boolean
  onSelect: (code: string) => void
  innerRef?: (el: HTMLTableRowElement | null) => void
  dataIndex?: number
}

const StockTableRow = memo(function StockTableRow({
  s, i, isSelected, onSelect, innerRef, dataIndex,
}: StockTableRowProps) {
  return (
    <tr
      ref={innerRef}
      data-index={dataIndex}
      onClick={() => onSelect(s.code)}
      className={cn(
        'border-b border-border hover:bg-bg-hover transition-colors cursor-pointer',
        isSelected && 'bg-bg-hover',
      )}
    >
      <td className="text-center px-2 py-2.5 font-mono text-[11px] text-t4">{i + 1}</td>
      <td className="px-2 py-2.5 truncate">
        {s.name !== s.code && <span className="text-t1">{s.name}</span>}
        <span className={cn('font-mono text-[11px] text-t4', s.name !== s.code && 'ml-1.5')}>{s.code}</span>
      </td>
      <CharterCell group={s.charterGroup} />
      <DateCell d={s.upcoming} kind="upcoming" />
      <AmountCell d={s.upcoming} kind="upcoming" />
      <StatusCell d={s.upcoming} kind="upcoming" />
      <PeriodCell d={s.upcoming} kind="upcoming" />
      <RevisionCell d={s.upcoming} kind="upcoming" />
      <SourceCell d={s.upcoming} kind="upcoming" />
      <DateCell d={s.lastConfirmed} kind="last" />
      <AmountCell d={s.lastConfirmed} kind="last" />
      <StatusCell d={s.lastConfirmed} kind="last" />
      <PeriodCell d={s.lastConfirmed} kind="last" />
      <RevisionCell d={s.lastConfirmed} kind="last" />
      <SourceCell d={s.lastConfirmed} kind="last" />
      <td className={cn('px-2 py-2.5 text-right font-mono text-[12px]',
        s.fyYield != null ? 'text-t1' : 'text-t4')}
        title={s.fyYield != null
          ? `올해 합산: 확정 ${s.fyConfirmedCount}건 + 추정 ${s.fyEstimateCount}건`
          : '올해 배당 데이터 없음'}>
        {s.fyYield != null ? `${s.fyYield.toFixed(2)}%` : '-'}
      </td>
    </tr>
  )
})

// 셀 음영 없음. 다가오는/최근 구분은 텍스트 색깔(다가오는 초록) + 그룹 border + 좌측 accent로 표현.
type CellKind = 'upcoming' | 'last'
const cellBg = (_d: Dividend | null, _kind: CellKind) => ''

function DateCell({ d, kind }: { d: Dividend | null; kind: CellKind }) {
  // 다가오는 그룹의 첫 셀 — 다른 그룹 경계선과 동일하게 1px 보통 border
  const groupStart = kind === 'upcoming' ? 'border-l border-border-light' : ''
  if (!d || !d.ex_date) {
    return <td className={cn('px-2 py-2.5 text-center font-mono text-t4 text-[11px]', cellBg(d, kind), groupStart)}>-</td>
  }
  return (
    <td className={cn('px-2 py-2.5 text-center align-middle', cellBg(d, kind), groupStart)}>
      <span className={cn('font-mono text-[12px] tabular-nums',
        kind === 'upcoming' ? 'text-up' : 'text-t2')}>{d.ex_date}</span>
    </td>
  )
}

function AmountCell({ d, kind }: { d: Dividend | null; kind: CellKind }) {
  if (!d) return <td className={cn('px-2 py-2.5 text-right font-mono text-t4 text-[11px]', cellBg(d, kind))}>-</td>
  return (
    <td className={cn('px-2 py-2.5 text-right align-middle', cellBg(d, kind))}>
      <span className={cn('font-mono text-[12px] tabular-nums',
        kind === 'upcoming' ? 'text-up' : 'text-t1')}>{d.amount.toLocaleString()}원</span>
    </td>
  )
}

function StatusCell({ d, kind }: { d: Dividend | null; kind: CellKind }) {
  if (!d) return <td className={cn('px-2 py-2.5 text-center font-mono text-t4 text-[11px]', cellBg(d, kind))}>-</td>
  return (
    <td className={cn('px-2 py-2.5 text-center align-middle', cellBg(d, kind))}>
      {d.confirmed ? (
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-up/15 text-up">확정</span>
      ) : (
        <span title={d.estimation_basis ?? '추정 근거 정보 없음'}
          className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning cursor-help">예상</span>
      )}
    </td>
  )
}

function RevisionCell({ d, kind }: { d: Dividend | null; kind: CellKind }) {
  if (!d || d.revisions.length === 0) {
    return <td className={cn('px-2 py-2.5 text-center font-mono text-t4 text-[11px]', cellBg(d, kind))}>-</td>
  }
  return (
    <td className={cn('px-2 py-2.5 text-center align-middle', cellBg(d, kind))}>
      <span title={`${d.revisions.length}회 정정공시 — 우측 패널에서 이력 확인`}
        className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-blue/15 text-blue cursor-help">
        v{d.version}
      </span>
    </td>
  )
}

function PeriodCell({ d, kind }: { d: Dividend | null; kind: CellKind }) {
  if (!d) return <td className={cn('px-2 py-2.5 text-center font-mono text-t4 text-[11px]', cellBg(d, kind))}>-</td>
  return (
    <td className={cn('px-2 py-2.5 text-center align-middle', cellBg(d, kind))}>
      <span className="font-mono text-[11px] text-t2">{periodShort(d.period)}</span>
    </td>
  )
}

function SourceCell({ d, kind }: { d: Dividend | null; kind: CellKind }) {
  // 각 그룹 마지막 셀 — 우측 테두리로 다가오는/최근 그룹 시각 분리
  const groupBorder = 'border-r border-border-light'
  if (!d || !d.raw_text_url) {
    return <td className={cn('px-2 py-2.5 text-center font-mono text-t4 text-[11px]', cellBg(d, kind), groupBorder)}>-</td>
  }
  // 패딩을 <a> 안으로 옮겨서 셀 전체가 클릭 영역. 화살표 크기는 그대로.
  return (
    <td className={cn('p-0 text-center align-middle', cellBg(d, kind), groupBorder)}>
      <a href={d.raw_text_url} target="_blank" rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block w-full h-full px-2 py-2.5 text-accent hover:text-accent-hover hover:bg-accent/10 transition-colors text-[12px]">
        ↗
      </a>
    </td>
  )
}

interface DetailPanelProps {
  s: StockRow
  today: string
  onClose: () => void
}

function DetailPanel({ s, today, onClose }: DetailPanelProps) {
  return (
    <div className="panel sticky top-0 self-start max-h-[calc(100vh-1rem)] overflow-y-auto">
      <div className="px-4 flex items-center justify-between border-b border-border sticky top-0 bg-bg-primary z-10" style={{ height: 58.5 }}>
        <div>
          {s.name !== s.code && <span className="text-sm font-semibold text-t1">{s.name}</span>}
          <span className={cn('font-mono text-[11px] text-t4', s.name !== s.code && 'ml-2')}>{s.code}</span>
          {s.charterGroup && (
            <span className={cn('ml-2 font-mono text-[10px] px-1.5 py-0.5 rounded-sm',
              s.charterGroup === 'A' ? 'bg-warning/12 text-warning' : 'bg-blue/12 text-blue')}>
              {s.charterGroup}
            </span>
          )}
        </div>
        <button onClick={onClose}
          aria-label="닫기"
          className="text-t3 hover:text-t1 hover:bg-bg-surface-2 transition-colors text-xl leading-none w-8 h-8 rounded flex items-center justify-center">×</button>
      </div>
      <div className="px-4 py-3 text-[11px] text-t3">
        총 {s.history.length}건 배당 이력
      </div>
      <div className="flex flex-col gap-4 px-4 pb-4">
        {s.history.map((d) => (
          <DividendCard key={d.id} d={d} today={today} />
        ))}
      </div>
    </div>
  )
}

function DividendCard({ d, today }: { d: Dividend; today: string }) {
  const isFuture = d.ex_date != null && d.ex_date >= today
  const days = d.ex_date
    ? Math.round((new Date(d.ex_date).getTime() - new Date(today).getTime()) / 86400000)
    : null
  const dayLabel = days == null ? '' : days === 0 ? 'D' : days > 0 ? `D+${days}` : `D${days}`
  return (
    <div className={cn('panel-inner rounded p-3 border-l-[3px]',
      // 좌측 세로줄 색: 확정=초록, 예상=주황
      d.confirmed ? 'border-l-up' : 'border-l-warning',
      !d.confirmed && 'bg-warning/5',
    )}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[13px] text-t1 tabular-nums">{d.ex_date ?? '-'}</span>
          {dayLabel && <span className={cn('font-mono text-[10px] tabular-nums',
            isFuture ? 'text-up' : 'text-t4')}>{dayLabel}</span>}
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-surface-2 text-t2">
            {periodShort(d.period)} {String(d.fiscal_year).slice(2)}
          </span>
          <SourceBadge source={d.source} />
          {d.confirmed ? (
            <span className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-up-bg text-up">확정</span>
          ) : (
            <span title={d.estimation_basis ?? '추정 근거 정보 없음'}
              className="font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-warning/12 text-warning cursor-help">예상</span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono">
        <div className="flex justify-between"><span className="text-t3">배당금</span><span className="text-t1 tabular-nums">{d.amount.toLocaleString()}원</span></div>
        <div className="flex justify-between"><span className="text-t3">수익률</span><span className="text-t1 tabular-nums">{d.yield_pct != null ? `${d.yield_pct.toFixed(2)}%` : '-'}</span></div>
        <div className="flex justify-between"><span className="text-t3">기준일</span><span className="text-t2 tabular-nums">{d.record_date ?? '-'}</span></div>
        <div className="flex justify-between"><span className="text-t3">공시일</span><span className="text-t2 tabular-nums">{d.announced_at?.slice(0, 10) ?? '-'}</span></div>
      </div>
      {d.raw_text_url && (
        <div className="mt-2">
          <a href={d.raw_text_url} target="_blank" rel="noreferrer"
            className="text-accent hover:text-accent-hover text-[11px] inline-flex items-center gap-1">
            원문 ↗
          </a>
        </div>
      )}
      {d.revisions.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border">
          <div className="text-[10px] text-t3 font-medium mb-1.5">정정공시 이력 ({d.revisions.length}회)</div>
          <div className="grid grid-cols-[24px_64px_72px_72px_72px_14px] gap-x-1.5 text-[10px] font-mono items-baseline">
            <div className="text-t4">버전</div>
            <div className="text-t4 text-right">배당금</div>
            <div className="text-t4">배당락일</div>
            <div className="text-t4">기준일</div>
            <div className="text-t4">공시일</div>
            <div className="text-t4"></div>
            {d.revisions.map((rv) => (
              <Fragment key={rv.version}>
                <div className="text-t2">v{rv.version}</div>
                <div className="text-t1 tabular-nums text-right whitespace-nowrap">{rv.amount.toLocaleString()}원</div>
                <div className="text-t2 tabular-nums whitespace-nowrap">{rv.ex_date ?? '-'}</div>
                <div className="text-t2 tabular-nums whitespace-nowrap">{rv.record_date ?? '-'}</div>
                <div className="text-t3 tabular-nums whitespace-nowrap">{rv.announced_at?.slice(0, 10) ?? '-'}</div>
                <div>
                  {rv.raw_text_url && (
                    <a href={rv.raw_text_url} target="_blank" rel="noreferrer"
                      className="text-accent hover:text-accent-hover">↗</a>
                  )}
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function CharterCell({ group }: { group: string | null }) {
  if (!group) {
    return (
      <td className="px-2 py-2.5 text-center"><span className="text-t4 text-[11px]">-</span></td>
    )
  }
  return (
    <td className="px-2 py-2.5 text-center relative group/charter">
      <span className={cn('inline-block font-mono text-[10px] px-1.5 py-0.5 rounded-sm cursor-help',
        group === 'A' ? 'bg-warning/12 text-warning' : 'bg-blue/12 text-blue')}>
        {group}
      </span>
      <div className="hidden group-hover/charter:block absolute z-30 left-1/2 -translate-x-1/2 top-full mt-1 w-72 bg-bg-surface-2 border border-border rounded px-3 py-2 text-[11px] text-left pointer-events-none shadow-lg">
        <div className="flex items-baseline gap-2 pb-1.5 mb-1.5 border-b border-border">
          <span className={cn('font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded-sm',
            group === 'A' ? 'bg-warning/12 text-warning' : 'bg-blue/12 text-blue')}>{group}</span>
          <span className="text-t1 font-medium">
            {group === 'A' ? '변경기입' : '미변경기입'}
          </span>
        </div>
        {group === 'A' ? (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-t3">배당기준일</span><span className="text-t2">이사회 결의로 지정</span>
            <span className="text-t3">결산일 관계</span><span className="text-t2">결산일 ≠ 기준일 가능</span>
            <span className="text-t3">기준일 미정</span><span className="text-t2">사례 있음</span>
            <span className="text-t3">추정 신뢰도</span><span className="text-warning">낮음</span>
          </div>
        ) : (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-t3">배당기준일</span><span className="text-t2">결산일 고정</span>
            <span className="text-t3">기준 일자</span><span className="text-t2 font-mono">3/31, 6/30, 9/30, 12/31</span>
            <span className="text-t3">추정 신뢰도</span><span className="text-up">높음</span>
          </div>
        )}
      </div>
    </td>
  )
}

function SourceBadge({ source }: { source: string }) {
  const cls: Record<string, string> = {
    DART: 'bg-blue/12 text-blue',
    SEIBro: 'bg-accent/12 text-accent',
    KRX: 'bg-up/12 text-up',
    ESTIMATE: 'bg-warning/12 text-warning',
  }
  return (
    <span className={cn('font-mono text-[10px] px-1.5 py-0.5 rounded-sm', cls[source] ?? 'bg-bg-surface-2 text-t3')}>
      {source}
    </span>
  )
}

function SortTh({
  sortKey, label, align, current, asc, onSort,
}: {
  sortKey: SK; label: string; align: 'left' | 'right' | 'center'
  current: SK; asc: boolean; onSort: (k: SK) => void
}) {
  const active = current === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'px-2 py-1.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors bg-bg-primary',
        align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center',
        active && 'text-t1',
      )}
    >
      {label}
      <span className="ml-1 text-[10px]">{active ? (asc ? '▲' : '▼') : ''}</span>
    </th>
  )
}

// ANNUAL → Y, 그 외(Q1~Q4, H1~H2)는 그대로
function periodShort(period: string): string {
  if (period === 'ANNUAL') return 'Y'
  return period
}

// ex_date 없을 때 분기/반기에서 결산월 추정 — 한국 12월 결산 가정.
function quarterMonth(period: string): string | null {
  switch (period) {
    case 'Q1': return '03'
    case 'Q2': return '06'
    case 'Q3': return '09'
    case 'Q4':
    case 'ANNUAL': return '12'
    case 'H1': return '06'
    case 'H2': return '12'
    default: return null
  }
}
