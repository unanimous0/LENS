import { useEffect, useMemo, useState } from 'react'

import { keyToCode } from '@/lib/stat-arb-keys'
import { cn } from '@/lib/utils'

// PR-C2 Sparse CCA M:N 발굴 결과 화면
type MLeg = {
  key: string
  name: string
  weight: number
}

type MPair = {
  group_id: string
  group_name: string
  timeframe: string
  x_legs: MLeg[]
  y_legs: MLeg[]
  cca_correlation: number
  hedge_ratio: number
  adf_tstat: number
  half_life: number
  r_squared: number
  z_score: number
  sample_size: number
  score: number
}

type MnPairsResp = {
  total: number
  returned: number
  last_run_ms: number
  pairs: MPair[]
}

const KIND_LABEL: Record<string, string> = {
  index: '지수',
  sector: '섹터',
  etf: 'ETF',
  etf_category: 'ETF 카테고리',
}

function groupKindOf(group_id: string): string {
  const colon = group_id.indexOf(':')
  if (colon < 0) return '?'
  return group_id.slice(0, colon)
}

export function StatArbMnPage() {
  const [pairs, setPairs] = useState<MPair[]>([])
  const [meta, setMeta] = useState<{ total: number; last_run_ms: number }>({
    total: 0,
    last_run_ms: 0,
  })
  const [kindFilter, setKindFilter] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ limit: '500' })
    if (kindFilter) params.set('kind', kindFilter)
    fetch(`/api/stat-arb/mn-pairs?${params}`)
      .then((r) => r.json())
      .then((d: MnPairsResp) => {
        setPairs(d.pairs)
        setMeta({ total: d.total, last_run_ms: d.last_run_ms })
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [kindFilter])

  const visible = useMemo(() => {
    if (!search.trim()) return pairs
    const s = search.toLowerCase()
    return pairs.filter((p) => {
      if (p.group_name.toLowerCase().includes(s)) return true
      if (p.group_id.toLowerCase().includes(s)) return true
      for (const l of p.x_legs) {
        if (l.name.toLowerCase().includes(s) || keyToCode(l.key).includes(s)) return true
      }
      for (const l of p.y_legs) {
        if (l.name.toLowerCase().includes(s) || keyToCode(l.key).includes(s)) return true
      }
      return false
    })
  }, [pairs, search])

  const lastRunStr = useMemo(() => {
    if (!meta.last_run_ms) return '—'
    const d = new Date(meta.last_run_ms)
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }, [meta.last_run_ms])

  function toggle(gid: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-1">
      {/* 컨트롤 */}
      <div className="panel flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">그룹 종류</span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 focus:outline-none"
          >
            <option value="">전체</option>
            <option value="index">지수</option>
            <option value="sector">섹터</option>
            <option value="etf">ETF</option>
            <option value="etf_category">ETF 카테고리</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">검색</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="그룹명 / 종목"
            className="w-[220px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none"
          />
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-t3 tabular-nums">
          <span>
            전체 {meta.total} / 표시 <span className="text-t1">{visible.length}</span>
          </span>
          <span>갱신 {lastRunStr}</span>
          <button
            onClick={load}
            disabled={loading}
            className="rounded-sm bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {loading ? '...' : '새로고침'}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel p-3 text-xs text-down">{error}</div>
      )}

      {/* 페어 테이블 */}
      <div className="panel overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-bg-primary">
            <tr className="border-b border-bg-surface text-left text-t3">
              <th className="w-8 px-2 py-2 font-normal"></th>
              <th className="px-3 py-2 font-normal" title="발굴 그룹">그룹</th>
              <th className="px-3 py-2 font-normal" title="X측 leg 수 : Y측 leg 수">leg</th>
              <th
                className="px-3 py-2 font-normal"
                title="합성 시리즈 (X·u, Y·v) Pearson correlation"
              >
                corr
              </th>
              <th
                className="px-3 py-2 font-normal"
                title="합성 log price OLS β (Y_combined = α + β·X_combined)"
              >
                β
              </th>
              <th className="px-3 py-2 font-normal" title="OLS 결정계수 (cointegration 강도)">
                r²
              </th>
              <th
                className="px-3 py-2 font-normal"
                title="잔차 ADF t-stat. <-3 stationary 통과"
              >
                adf
              </th>
              <th className="px-3 py-2 font-normal" title="Mean-reversion half-life (일)">
                hl
              </th>
              <th className="px-3 py-2 font-normal" title="현재 잔차 z-score">
                z
              </th>
              <th
                className="px-3 py-2 font-normal"
                title="발굴 점수 = -ADF × (1/hl) × |corr|"
              >
                score
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-t4">
                  발굴된 M:N 페어 없음
                </td>
              </tr>
            )}
            {visible.map((p) => {
              const isOpen = expanded.has(p.group_id)
              const kind = groupKindOf(p.group_id)
              return (
                <RowFragment
                  key={p.group_id}
                  pair={p}
                  kind={kind}
                  isOpen={isOpen}
                  onToggle={() => toggle(p.group_id)}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RowFragment({
  pair,
  kind,
  isOpen,
  onToggle,
}: {
  pair: MPair
  kind: string
  isOpen: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-bg-surface/40 hover:bg-bg-surface/40"
        onClick={onToggle}
      >
        <td className="px-2 py-2 text-t3">{isOpen ? '▼' : '▶'}</td>
        <td className="px-3 py-2">
          <span className="mr-1 rounded-sm bg-bg-surface px-1.5 py-0.5 text-[10px] text-t3">
            {KIND_LABEL[kind] ?? kind}
          </span>
          <span className="text-t1">{pair.group_name}</span>
        </td>
        <td className="px-3 py-2 text-t1">
          {pair.x_legs.length}:{pair.y_legs.length}
        </td>
        <td className={cn('px-3 py-2', Math.abs(pair.cca_correlation) >= 0.5 ? 'text-t1' : 'text-t3')}>
          {pair.cca_correlation.toFixed(3)}
        </td>
        <td className="px-3 py-2 text-t2">{pair.hedge_ratio.toFixed(3)}</td>
        <td className={cn('px-3 py-2', pair.r_squared >= 0.7 ? 'text-accent' : 'text-t2')}>
          {pair.r_squared.toFixed(3)}
        </td>
        <td className={cn('px-3 py-2', pair.adf_tstat <= -4 ? 'text-accent' : 'text-t2')}>
          {pair.adf_tstat.toFixed(2)}
        </td>
        <td className="px-3 py-2 text-t2">{pair.half_life.toFixed(1)}d</td>
        <td
          className={cn(
            'px-3 py-2',
            Math.abs(pair.z_score) >= 2
              ? pair.z_score > 0
                ? 'text-up'
                : 'text-down'
              : 'text-t2'
          )}
        >
          {pair.z_score >= 0 ? '+' : ''}
          {pair.z_score.toFixed(2)}
        </td>
        <td className="px-3 py-2 text-t1">{pair.score.toFixed(3)}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-bg-surface/40 bg-bg-base/40">
          <td></td>
          <td colSpan={9} className="px-3 py-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <LegList title="X (롱 방향)" legs={pair.x_legs} />
              <LegList title="Y (숏 방향)" legs={pair.y_legs} />
            </div>
            <div className="mt-2 text-[11px] text-t4">
              group_id: <span className="text-t3">{pair.group_id}</span> · 샘플{' '}
              {pair.sample_size}일 · timeframe {pair.timeframe}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function LegList({ title, legs }: { title: string; legs: MLeg[] }) {
  return (
    <div className="rounded-sm bg-bg-surface/40 p-2">
      <div className="mb-1 text-[11px] text-t3">{title}</div>
      <ul className="space-y-0.5 text-xs tabular-nums">
        {legs.map((l) => (
          <li key={l.key} className="flex items-center justify-between gap-3">
            <span className="text-t1">
              <span className="text-t4">{keyToCode(l.key)}</span> {l.name}
            </span>
            <span className={l.weight >= 0 ? 'text-up' : 'text-down'}>
              {l.weight >= 0 ? '+' : ''}
              {l.weight.toFixed(3)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
