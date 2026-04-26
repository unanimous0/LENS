import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis, Cell,
} from 'recharts'

interface Dividend {
  code: string
  name: string
  record_date: string
  ex_date: string | null
  pay_date: string | null
  amount: number
  yield_pct: number | null
  period: string
  confirmed: boolean
  announced_at: string | null
}

interface DividendsResp {
  exported_at: string | null
  source: 'mock' | 'export'
  count: number
  items: Dividend[]
}

type SK = 'name' | 'ex_date' | 'amount' | 'yield_pct' | 'period'

export function DividendsPage() {
  const [resp, setResp] = useState<DividendsResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sk, setSk] = useState<SK>('ex_date')
  const [asc, setAsc] = useState(true)
  const [selectedCode, setSelectedCode] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/dividends')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setResp(d); setLoading(false) })
      .catch((e) => { setError(String(e.message ?? e)); setLoading(false) })
  }, [])

  const today = new Date().toISOString().slice(0, 10)

  // 다가오는 배당 — 30일 / 90일
  const { upcoming30, upcoming90, avgYield } = useMemo(() => {
    if (!resp) return { upcoming30: [] as Dividend[], upcoming90: [] as Dividend[], avgYield: 0 }
    const t30 = new Date(); t30.setDate(t30.getDate() + 30); const e30 = t30.toISOString().slice(0, 10)
    const t90 = new Date(); t90.setDate(t90.getDate() + 90); const e90 = t90.toISOString().slice(0, 10)
    const u30 = resp.items.filter((d) => d.ex_date && d.ex_date >= today && d.ex_date <= e30)
    const u90 = resp.items.filter((d) => d.ex_date && d.ex_date >= today && d.ex_date <= e90)
    const yields = u90.map((d) => d.yield_pct).filter((v): v is number => v != null)
    const avg = yields.length > 0 ? yields.reduce((s, v) => s + v, 0) / yields.length : 0
    return { upcoming30: u30, upcoming90: u90, avgYield: avg }
  }, [resp, today])

  // 산점도 데이터
  const scatterData = useMemo(() =>
    upcoming90.map((d) => {
      const ex = new Date(d.ex_date!).getTime()
      const days = Math.round((ex - new Date(today).getTime()) / 86400000)
      return {
        code: d.code, name: d.name, days,
        yield: d.yield_pct ?? 0, amount: d.amount,
        period: d.period, confirmed: d.confirmed,
      }
    }), [upcoming90, today])

  // 종목별 배당 이력
  const history = useMemo(() => {
    if (!resp || !selectedCode) return []
    return resp.items
      .filter((d) => d.code === selectedCode)
      .sort((a, b) => (a.record_date ?? '').localeCompare(b.record_date ?? ''))
      .map((d) => ({
        label: `${d.period} ${d.record_date.slice(2, 4)}`,
        amount: d.amount,
        confirmed: d.confirmed,
      }))
  }, [resp, selectedCode])

  // 테이블 행
  const rows = useMemo(() => {
    if (!resp) return []
    let list = resp.items
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((d) => d.name.toLowerCase().includes(q) || d.code.includes(q))
    }
    return [...list].sort((a, b) => {
      const av: any = (a as any)[sk] ?? ''
      const bv: any = (b as any)[sk] ?? ''
      if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av
      return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
  }, [resp, search, sk, asc])

  const doSort = (k: SK) => { if (sk === k) setAsc(!asc); else { setSk(k); setAsc(true) } }

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

  const selectedName = selectedCode ? resp?.items.find((d) => d.code === selectedCode)?.name : null
  const totalCount = resp?.count ?? 0
  const confirmedRatio = upcoming90.length > 0
    ? Math.round((upcoming90.filter((d) => d.confirmed).length / upcoming90.length) * 100)
    : 0

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
            전체 {totalCount}건
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
            <p className="text-xs text-t3 mb-1">전체 배당</p>
            <p className="font-mono text-2xl font-semibold text-t1">{totalCount}</p>
          </div>
          <div className="panel-inner rounded p-4">
            <p className="text-xs text-t3 mb-1">다가오는 30일</p>
            <p className="font-mono text-2xl font-semibold text-up">{upcoming30.length}</p>
          </div>
          <div className="panel-inner rounded p-4">
            <div className="flex h-full">
              <div className="flex-1 flex flex-col justify-between border-r border-border pr-3">
                <p className="text-xs text-t3 mb-1">다가오는 90일</p>
                <p className="font-mono text-2xl font-semibold text-up">{upcoming90.length}</p>
              </div>
              <div className="flex-1 flex flex-col justify-between pl-3">
                <p className="text-xs text-t3 mb-1">확정</p>
                <p className="font-mono text-2xl font-semibold text-t1">{confirmedRatio}%</p>
              </div>
            </div>
          </div>
          <div className="panel-inner rounded p-4">
            <p className="text-xs text-t3 mb-1">평균 수익률 (90일)</p>
            <p className="font-mono text-2xl font-semibold text-t1">
              {avgYield > 0 ? `${avgYield.toFixed(2)}%` : '-'}
            </p>
          </div>
        </div>
      </div>

      {/* Charts */}
      <div className="panel p-4">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* 산점도 */}
          <div>
            <div className="text-xs text-t2 mb-2 font-medium">다가오는 배당 (90일 내)</div>
            <div style={{ width: '100%', height: 240 }}>
              {scatterData.length > 0 ? (
                <ResponsiveContainer>
                  <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                      type="number" dataKey="days"
                      tick={{ fill: 'var(--color-t3)', fontSize: 10 }}
                      label={{ value: '오늘로부터 (일)', position: 'insideBottom', offset: -10, fill: 'var(--color-t4)', fontSize: 10 }}
                      domain={[0, 90]} ticks={[0, 30, 60, 90]}
                    />
                    <YAxis
                      type="number" dataKey="yield"
                      tick={{ fill: 'var(--color-t3)', fontSize: 10 }}
                      label={{ value: '시가배당률 (%)', angle: -90, position: 'insideLeft', fill: 'var(--color-t4)', fontSize: 10 }}
                      tickFormatter={(v) => v.toFixed(1)}
                    />
                    <ZAxis type="number" dataKey="amount" range={[60, 220]} />
                    <Tooltip
                      cursor={{ strokeDasharray: '3 3', stroke: 'var(--color-t4)' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null
                        const d = payload[0].payload
                        return (
                          <div className="bg-bg-surface-2 border border-border rounded px-2 py-1.5 text-[11px]">
                            <div className="text-t1">{d.name} <span className="text-t3">({d.code})</span></div>
                            <div className="text-t2 tabular-nums">D+{d.days} · {d.amount.toLocaleString()}원 · {d.yield.toFixed(2)}%</div>
                            <div className="text-t3">{d.period} · {d.confirmed ? '확정' : '예상'}</div>
                          </div>
                        )
                      }}
                    />
                    <Scatter data={scatterData} onClick={(d: any) => setSelectedCode(d.code)}>
                      {scatterData.map((d, i) => (
                        <Cell key={i} fill={d.confirmed ? 'var(--color-up)' : 'var(--color-warning)'} cursor="pointer" />
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
              <span className="inline-block w-2 h-2 rounded-full bg-up mr-1 align-middle" /> 확정
              <span className="inline-block w-2 h-2 rounded-full bg-warning ml-3 mr-1 align-middle" /> 예상
              <span className="ml-3">점 크기 = 1주당 배당금</span>
            </div>
          </div>

          {/* 종목 이력 */}
          <div>
            <div className="text-xs text-t2 mb-2 font-medium">
              {selectedName ? `${selectedName} 배당 이력` : '종목 선택 시 이력 표시'}
            </div>
            <div style={{ width: '100%', height: 240 }}>
              {history.length > 0 ? (
                <ResponsiveContainer>
                  <BarChart data={history} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--color-t3)', fontSize: 10 }} />
                    <YAxis tick={{ fill: 'var(--color-t3)', fontSize: 10 }} tickFormatter={(v) => v.toLocaleString()} />
                    <Tooltip
                      contentStyle={{ background: 'var(--color-bg-surface-2)', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: 11 }}
                      itemStyle={{ color: 'var(--color-t2)' }}
                      formatter={(v: any) => [`${(v as number).toLocaleString()}원`, '1주당']}
                    />
                    <Bar dataKey="amount">
                      {history.map((h, i) => (
                        <Cell key={i} fill={h.confirmed ? 'var(--color-up)' : 'var(--color-warning)'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-t4">
                  {selectedCode ? '이력 없음' : '아래 표 또는 좌측 차트의 점을 클릭'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Results Table */}
      <div className="panel">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 bg-bg-surface z-10">
            <tr className="text-[13px] text-t2 border-b border-border-light">
              <th className="text-center px-2 py-2.5 font-medium text-t3 w-10">No</th>
              <SortTh sortKey="name" label="종목" align="left" current={sk} asc={asc} onSort={doSort} />
              <SortTh sortKey="ex_date" label="배당락일" align="right" current={sk} asc={asc} onSort={doSort} />
              <th className="text-right px-4 py-2.5 font-medium">기준일</th>
              <th className="text-right px-4 py-2.5 font-medium">지급일</th>
              <SortTh sortKey="amount" label="1주당 배당금" align="right" current={sk} asc={asc} onSort={doSort} />
              <SortTh sortKey="yield_pct" label="수익률" align="right" current={sk} asc={asc} onSort={doSort} />
              <SortTh sortKey="period" label="구분" align="center" current={sk} asc={asc} onSort={doSort} />
              <th className="text-center px-4 py-2.5 font-medium">상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const isUpcoming = !!d.ex_date && d.ex_date >= today
              const isSelected = d.code === selectedCode
              return (
                <tr
                  key={`${d.code}-${d.record_date}-${d.period}-${i}`}
                  onClick={() => setSelectedCode(d.code)}
                  className={cn(
                    'border-b border-border hover:bg-bg-hover transition-colors cursor-pointer',
                    isSelected && 'bg-bg-hover',
                  )}
                >
                  <td className="text-center px-2 py-2.5 font-mono text-xs text-t4">{i + 1}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-t1">{d.name}</span>
                    <span className="ml-2 font-mono text-[11px] text-t4">{d.code}</span>
                  </td>
                  <td className={cn('px-4 py-2.5 text-right font-mono', isUpcoming ? 'text-up' : 'text-t2')}>
                    {fmt(d.ex_date)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-t3">{fmt(d.record_date)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-t3">{fmt(d.pay_date)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-t1">{d.amount.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-t2">
                    {d.yield_pct != null ? `${d.yield_pct.toFixed(2)}%` : '-'}
                  </td>
                  <td className="px-4 py-2.5 text-center font-mono text-t2">{d.period}</td>
                  <td className="px-4 py-2.5 text-center">
                    {d.confirmed ? (
                      <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-sm bg-up-bg text-up">확정</span>
                    ) : (
                      <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-sm bg-warning/12 text-warning">예상</span>
                    )}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center py-12 text-t4 text-sm">
                  {search ? '검색 결과 없음' : '배당 데이터 없음'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
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
        'px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors',
        align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center',
        active && 'text-t1',
      )}
    >
      {label}
      <span className="ml-1 text-[10px]">{active ? (asc ? '▲' : '▼') : ''}</span>
    </th>
  )
}

function fmt(d: string | null) {
  return d ? d.slice(5) : '-'
}
