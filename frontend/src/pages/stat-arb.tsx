import { useCallback, useEffect, useState } from 'react'

type Group = {
  id: string
  name: string
  kind: string
  member_count: number
}

type Pair = {
  left_key: string
  right_key: string
  left_name: string
  right_name: string
  timeframe: string
  corr: number
  hedge_ratio: number
  alpha: number
  adf_tstat: number
  half_life: number
  r_squared: number
  z_score: number
  sample_size: number
  score: number
}

type PairsResp = {
  total: number
  filtered: number
  last_run_ms: number
  last_run_duration_ms: number
  pairs: Pair[]
}

type GroupsResp = {
  total: number
  groups: Group[]
}

const KIND_LABELS: Record<string, string> = {
  index: '지수',
  sector: '섹터',
  etf: 'ETF',
}

export function StatArbPage() {
  const [pairs, setPairs] = useState<Pair[]>([])
  const [meta, setMeta] = useState<Pick<PairsResp, 'total' | 'filtered' | 'last_run_ms'>>({
    total: 0,
    filtered: 0,
    last_run_ms: 0,
  })
  const [groups, setGroups] = useState<Group[]>([])
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [kindFilter, setKindFilter] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 그룹 1회 로딩
  useEffect(() => {
    fetch('/api/stat-arb/groups')
      .then((r) => r.json())
      .then((d: GroupsResp) => setGroups(d.groups))
      .catch((e) => setError(`groups: ${String(e)}`))
  }, [])

  // 페어 로딩
  const loadPairs = useCallback(() => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ limit: '200' })
    if (groupFilter) params.set('group', groupFilter)
    fetch(`/api/stat-arb/pairs?${params}`)
      .then((r) => r.json())
      .then((d: PairsResp) => {
        setPairs(d.pairs)
        setMeta({ total: d.total, filtered: d.filtered, last_run_ms: d.last_run_ms })
      })
      .catch((e) => setError(`pairs: ${String(e)}`))
      .finally(() => setLoading(false))
  }, [groupFilter])

  useEffect(() => {
    loadPairs()
  }, [loadPairs])

  const filteredGroups = kindFilter ? groups.filter((g) => g.kind === kindFilter) : groups
  const lastRunStr = meta.last_run_ms
    ? new Date(meta.last_run_ms).toLocaleTimeString('ko-KR', { hour12: false })
    : '—'

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 컨트롤 패널 */}
      <div className="panel flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">자산군</span>
          <select
            value={kindFilter}
            onChange={(e) => {
              setKindFilter(e.target.value)
              setGroupFilter('') // 자산군 바뀌면 그룹 reset
            }}
            className="rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 focus:outline-none"
          >
            <option value="">전체</option>
            <option value="index">지수</option>
            <option value="sector">섹터</option>
            <option value="etf">ETF</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">그룹</span>
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="min-w-[280px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 focus:outline-none"
          >
            <option value="">— 필터 없음 (시장 전체) —</option>
            {filteredGroups.map((g) => (
              <option key={g.id} value={g.id}>
                [{KIND_LABELS[g.kind] ?? g.kind}] {g.name} ({g.member_count})
              </option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-t3 tabular-nums">
          <span>
            전체 {meta.total} / 필터 <span className="text-t1">{meta.filtered}</span>
          </span>
          <span>갱신 {lastRunStr}</span>
          <button
            onClick={loadPairs}
            disabled={loading}
            className="rounded-sm bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {loading ? '...' : '새로고침'}
          </button>
        </div>
      </div>

      {/* 페어 테이블 */}
      <div className="panel overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-bg-primary">
            <tr className="border-b border-bg-surface text-left text-t3">
              <th className="px-3 py-2 font-normal">#</th>
              <th className="px-3 py-2 font-normal">페어</th>
              <th className="px-3 py-2 text-right font-normal">β</th>
              <th className="px-3 py-2 text-right font-normal">corr</th>
              <th className="px-3 py-2 text-right font-normal">R²</th>
              <th className="px-3 py-2 text-right font-normal">ADF</th>
              <th className="px-3 py-2 text-right font-normal">half-life</th>
              <th className="px-3 py-2 text-right font-normal">z</th>
              <th className="px-3 py-2 text-right font-normal">score</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => {
              const z = p.z_score
              const zClass =
                Math.abs(z) >= 2.5 ? 'text-warning font-semibold' : Math.abs(z) >= 1.5 ? 'text-t1' : 'text-t3'
              return (
                <tr
                  key={`${p.left_key}-${p.right_key}`}
                  className="border-b border-bg-surface/50 hover:bg-bg-surface/40"
                >
                  <td className="px-3 py-2 text-t4">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div>
                      <span className="text-t1">{p.left_name}</span>
                      <span className="mx-1 text-t3">↔</span>
                      <span className="text-t1">{p.right_name}</span>
                    </div>
                    <div className="text-[10px] text-t4">
                      {p.left_key} / {p.right_key}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-t1">{p.hedge_ratio.toFixed(3)}</td>
                  <td className="px-3 py-2 text-right text-t2">{p.corr.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-t2">{p.r_squared.toFixed(3)}</td>
                  <td className="px-3 py-2 text-right text-t2">{p.adf_tstat.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-t2">{p.half_life.toFixed(1)}d</td>
                  <td className={`px-3 py-2 text-right ${zClass}`}>
                    {z >= 0 ? '+' : ''}
                    {z.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right text-t1">{p.score.toFixed(2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {error && <div className="p-3 text-xs text-down">{error}</div>}
        {!error && pairs.length === 0 && !loading && (
          <div className="p-3 text-xs text-t3">결과 없음 — 필터 조건 확인 또는 stat-arb-engine 미기동</div>
        )}
      </div>
    </div>
  )
}
