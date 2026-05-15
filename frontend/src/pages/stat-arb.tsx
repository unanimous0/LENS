import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { keyToCode } from '@/lib/stat-arb-keys'

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

// 정렬 가능한 컬럼
type SortKey = 'score' | 'z' | 'hl' | 'r2' | 'adf' | 'corr' | 'beta' | 'loanrate'

// 컬럼별 hover 설명
const COL_TOOLTIPS: Record<SortKey | 'pair', string> = {
  pair: '좌변 ↔ 우변 자산 (right = α + β·left + ε)',
  beta: 'Hedge ratio β (right/left 비율) — 음수면 short pair',
  corr: '로그수익률 Pearson correlation — 사전 필터 (|r|>0.5)',
  r2: 'OLS 결정계수 — 잔차가 얼마나 작은지 (≥0.9 강한 cointegration)',
  adf: 'Augmented Dickey-Fuller t-stat — 잔차 stationarity (<-3 cointegration 통과)',
  hl: 'Mean-reversion half-life (그 timeframe 단위, 1d 기준 일)',
  z: '현재 잔차 z-score — |z|≥2 진입 시그널',
  score: '발굴 점수 = -ADF × (1/hl) × |corr|',
  loanrate: '대여요율 (left / right). ≥15% 강조 — 고요율 매수+송출 기회',
}

export function StatArbPage() {
  const navigate = useNavigate()
  const [pairs, setPairs] = useState<Pair[]>([])
  const [meta, setMeta] = useState<Pick<PairsResp, 'total' | 'filtered' | 'last_run_ms'>>({
    total: 0,
    filtered: 0,
    last_run_ms: 0,
  })
  const [groups, setGroups] = useState<Group[]>([])
  const [groupFilter, setGroupFilter] = useState<string>('')
  const [kindFilter, setKindFilter] = useState<string>('')
  const [search, setSearch] = useState<string>('')
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortAsc, setSortAsc] = useState<boolean>(false) // 기본 내림차순
  const [loanRates, setLoanRates] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 대여요율 1회 로딩 (변경 시 페이지 재진입으로 갱신)
  useEffect(() => {
    fetch('/api/loan-rates')
      .then((r) => r.json())
      .then((d: { items: Array<{ code: string; rate_pct: number }> }) => {
        const m = new Map<string, number>()
        for (const r of d.items) m.set(r.code, r.rate_pct)
        setLoanRates(m)
      })
      .catch(() => {
        /* fail-safe: 빈 Map */
      })
  }, [])

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
    const params = new URLSearchParams({ limit: '500' })
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

  // 검색 + 정렬 적용
  const visiblePairs = useMemo(() => {
    let list = pairs
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(
        (p) =>
          p.left_name.toLowerCase().includes(q) ||
          p.right_name.toLowerCase().includes(q) ||
          p.left_key.toLowerCase().includes(q) ||
          p.right_key.toLowerCase().includes(q)
      )
    }
    const getter: Record<SortKey, (p: Pair) => number> = {
      score: (p) => p.score,
      z: (p) => Math.abs(p.z_score), // z는 절댓값 정렬이 직관적
      hl: (p) => p.half_life,
      r2: (p) => p.r_squared,
      adf: (p) => p.adf_tstat,
      corr: (p) => Math.abs(p.corr),
      beta: (p) => p.hedge_ratio,
      loanrate: (p) => {
        // 페어의 max(L요율, R요율) — 한쪽만 있으면 그것만, 둘 다 없으면 -1
        const l = loanRates.get(keyToCode(p.left_key))
        const r = loanRates.get(keyToCode(p.right_key))
        if (l == null && r == null) return -1
        return Math.max(l ?? 0, r ?? 0)
      },
    }
    const sorted = [...list].sort((a, b) => {
      const va = getter[sortKey](a)
      const vb = getter[sortKey](b)
      return sortAsc ? va - vb : vb - va
    })
    return sorted
  }, [pairs, search, sortKey, sortAsc, loanRates])

  const sortClick = (k: SortKey) => {
    if (sortKey === k) setSortAsc(!sortAsc)
    else {
      setSortKey(k)
      setSortAsc(false) // 새 컬럼은 내림차순 시작
    }
  }

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
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">검색</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="종목명 / 코드"
            className="w-[200px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none"
          />
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-t3 tabular-nums">
          <span>
            전체 {meta.total} / 필터 {meta.filtered} / 표시{' '}
            <span className="text-t1">{visiblePairs.length}</span>
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
              <th className="px-3 py-2 font-normal" title={COL_TOOLTIPS.pair}>
                페어
              </th>
              <SortableTh active={sortKey === 'beta'} asc={sortAsc} onClick={() => sortClick('beta')} title={COL_TOOLTIPS.beta}>
                β
              </SortableTh>
              <SortableTh active={sortKey === 'corr'} asc={sortAsc} onClick={() => sortClick('corr')} title={COL_TOOLTIPS.corr}>
                corr
              </SortableTh>
              <SortableTh active={sortKey === 'r2'} asc={sortAsc} onClick={() => sortClick('r2')} title={COL_TOOLTIPS.r2}>
                R²
              </SortableTh>
              <SortableTh active={sortKey === 'adf'} asc={sortAsc} onClick={() => sortClick('adf')} title={COL_TOOLTIPS.adf}>
                ADF
              </SortableTh>
              <SortableTh active={sortKey === 'hl'} asc={sortAsc} onClick={() => sortClick('hl')} title={COL_TOOLTIPS.hl}>
                half-life
              </SortableTh>
              <SortableTh active={sortKey === 'z'} asc={sortAsc} onClick={() => sortClick('z')} title={COL_TOOLTIPS.z}>
                z
              </SortableTh>
              <SortableTh active={sortKey === 'loanrate'} asc={sortAsc} onClick={() => sortClick('loanrate')} title={COL_TOOLTIPS.loanrate}>
                대여 L/R
              </SortableTh>
              <SortableTh active={sortKey === 'score'} asc={sortAsc} onClick={() => sortClick('score')} title={COL_TOOLTIPS.score}>
                score
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {visiblePairs.map((p, i) => {
              const z = p.z_score
              const zClass =
                Math.abs(z) >= 2.5 ? 'text-warning font-semibold' : Math.abs(z) >= 1.5 ? 'text-t1' : 'text-t3'
              const adfCls = p.adf_tstat <= -3 ? 'text-up' : 'text-t3'
              const r2Cls = p.r_squared >= 0.9 ? 'text-up' : p.r_squared >= 0.6 ? 'text-t1' : 'text-t3'
              return (
                <tr
                  key={`${p.left_key}-${p.right_key}`}
                  onClick={() =>
                    navigate(
                      `/stat-arb/pair/${encodeURIComponent(p.left_key)}/${encodeURIComponent(p.right_key)}`
                    )
                  }
                  className="cursor-pointer border-b border-bg-surface/50 hover:bg-bg-surface/40"
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
                  <td className={`px-3 py-2 text-right ${r2Cls}`}>{p.r_squared.toFixed(3)}</td>
                  <td className={`px-3 py-2 text-right ${adfCls}`}>{p.adf_tstat.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-t2">{p.half_life.toFixed(1)}d</td>
                  <td className={`px-3 py-2 text-right ${zClass}`}>
                    {z >= 0 ? '+' : ''}
                    {z.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <LoanRateCell
                      lRate={loanRates.get(keyToCode(p.left_key))}
                      rRate={loanRates.get(keyToCode(p.right_key))}
                    />
                  </td>
                  <td className="px-3 py-2 text-right text-t1">{p.score.toFixed(2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {error && <div className="p-3 text-xs text-down">{error}</div>}
        {!error && visiblePairs.length === 0 && !loading && (
          <div className="p-3 text-xs text-t3">
            {pairs.length === 0
              ? '결과 없음 — 필터 조건 확인 또는 stat-arb-engine 미기동'
              : '검색 매칭 없음'}
          </div>
        )}
      </div>
    </div>
  )
}

/** 대여요율 셀 — L / R 가로 표시. ≥15% 강조. 둘 다 없으면 '—'. */
function LoanRateCell({ lRate, rRate }: { lRate?: number; rRate?: number }) {
  if (lRate == null && rRate == null) return <span className="text-t4">—</span>
  const cls = (r?: number) =>
    r == null ? 'text-t4' : r >= 15 ? 'text-warning font-semibold' : 'text-t1'
  return (
    <span className="tabular-nums">
      <span className={cls(lRate)}>{lRate != null ? `${lRate.toFixed(1)}%` : '—'}</span>
      <span className="mx-1 text-t4">/</span>
      <span className={cls(rRate)}>{rRate != null ? `${rRate.toFixed(1)}%` : '—'}</span>
    </span>
  )
}

/** 정렬 가능한 컬럼 헤더. 활성 시 ▲/▼ 표시. */
function SortableTh({
  children,
  active,
  asc,
  onClick,
  title,
}: {
  children: React.ReactNode
  active: boolean
  asc: boolean
  onClick: () => void
  title?: string
}) {
  return (
    <th
      onClick={onClick}
      title={title}
      className={`cursor-pointer select-none px-3 py-2 text-right font-normal hover:text-t1 ${
        active ? 'text-t1' : ''
      }`}
    >
      {children}
      {active && <span className="ml-1 text-[9px]">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}
