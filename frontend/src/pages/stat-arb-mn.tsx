import { useEffect, useMemo, useState } from 'react'

import { Seg } from '@/components/stat-arb/seg'
import { keyToCode } from '@/lib/stat-arb-keys'
import { groupKindOf, KIND_LABEL } from '@/lib/stat-arb/group-kind'
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
  /// 양변 분할에 쓰인 PCA factor (1-based). 0 = ETF 자연분할(ETF↔보유주식).
  split_factor?: number
  /// 같은 leg 조합을 낸 그룹 수 (1 = 고유). 그룹 정의상 KOSPI200 구성종목이 여러
  /// "코스피200*" 카테고리에 주입돼 동일 페어가 중복 산출되므로 대표 1개로 축약해 표시.
  dup_group_count?: number
  /// 그룹 내 성분 순번 (1-based). deflation 으로 한 그룹에서 여러 페어가 나오므로
  /// group_id 만으로는 행이 유일하지 않다 → 행 key/펼침 상태는 rowKey() 사용.
  component_idx?: number
  /// PR-D Johansen — trace·95% 기준 추정 공적분 rank. 미판정/구버전 응답이면 없음.
  /// **발굴 게이팅에 쓰이지 않는 부가 지표**(현 ADF 게이트가 얼마나 관대한지 재는 용도).
  johansen_rank?: number | null
  /// r=0 trace 통계량과 그 95% 임계값. `trace0 > crit95` 이면 rank ≥ 1.
  johansen_trace0?: number
  johansen_crit95?: number | null
  /// 최대 고유값 λ₁.
  johansen_eigen1?: number
}

/// 행 고유 key — 같은 그룹의 성분 여러 개가 공존하므로 group_id 단독은 충돌한다.
function rowKey(p: MPair): string {
  return `${p.group_id}#${p.component_idx ?? 1}`
}

type MnPairsResp = {
  total: number
  returned: number
  last_run_ms: number
  /// Johansen 판정별 페어 수 (`rank1`/`rank0`/`undetermined`) — johansen 필터 적용 전 모수.
  johansen_counts?: Record<string, number>
  pairs: MPair[]
}

// Johansen 필터 — 서버 param 값 그대로(전체는 미전달). 발굴 게이트가 아니라 보기 필터.
type JohansenView = 'all' | 'rank1' | 'rank0'

const JOHANSEN_HELP =
  'Johansen 대칭 공적분 검정 95% 기준 — 여러 종목이 방향 구분 없이 장기적으로 묶여 있는지. ' +
  '발굴 게이트가 아니라 보기 필터라 페어 통계·산출 자체는 바뀌지 않는다.'

export function StatArbMnPage() {
  const [pairs, setPairs] = useState<MPair[]>([])
  const [meta, setMeta] = useState<{ total: number; last_run_ms: number }>({
    total: 0,
    last_run_ms: 0,
  })
  const [kindFilter, setKindFilter] = useState<string>('')
  // Johansen 필터 — 서버 필터(기존 kind와 같은 경로). 기본은 전체(필터 없음).
  const [johansenView, setJohansenView] = useState<JohansenView>('all')
  const [johCounts, setJohCounts] = useState<Record<string, number>>({})
  const [search, setSearch] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = () => {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ limit: '500' })
    if (kindFilter) params.set('kind', kindFilter)
    if (johansenView !== 'all') params.set('johansen', johansenView)
    fetch(`/api/stat-arb/mn-pairs?${params}`)
      .then((r) => r.json())
      .then((d: MnPairsResp) => {
        setPairs(d.pairs)
        setMeta({ total: d.total, last_run_ms: d.last_run_ms })
        setJohCounts(d.johansen_counts ?? {})
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [kindFilter, johansenView])

  // 세그먼트 배지 카운트 — johansen 필터 전 모수(kind 필터는 반영)라 선택을 바꿔도 안 흔들린다.
  const johOptions = useMemo(() => {
    const rank1 = johCounts.rank1 ?? 0
    const rank0 = johCounts.rank0 ?? 0
    const undetermined = johCounts.undetermined ?? 0
    const all = rank1 + rank0 + undetermined
    const n = (v: number) => (all > 0 ? ` ${v}` : '')
    return [
      {
        v: 'all' as JohansenView,
        label: `전체${n(all)}`,
        title: undetermined > 0 ? `미판정 ${undetermined}개 포함 (표본·leg 수 제약)` : undefined,
      },
      {
        v: 'rank1' as JohansenView,
        label: `공적분${n(rank1)}`,
        title: 'rank ≥ 1 — 최소 1개의 안정적 장기 결합이 검출된 페어',
      },
      {
        v: 'rank0' as JohansenView,
        label: `미검출${n(rank0)}`,
        title: 'rank 0 — 합성 스프레드 ADF는 통과했지만 대칭 검정에서는 결합 미검출',
      },
    ]
  }, [johCounts])

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

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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
          <span
            className="cursor-help text-xs text-t3 underline decoration-t4 decoration-dotted underline-offset-2"
            title={JOHANSEN_HELP}
          >
            공적분
          </span>
          <Seg value={johansenView} onChange={setJohansenView} options={johOptions} />
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
          <span className="text-t4">▶ = leg 펼치기 · 행 클릭 = 상세 새 탭</span>
          <span title="필터 후 = 서버 필터(그룹 종류·공적분) 적용 결과 · 표시 = 검색어까지 적용">
            필터 후 {meta.total} / 표시 <span className="text-t1">{visible.length}</span>
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
              <th
                className="px-3 py-2 font-normal"
                title="Johansen 공적분 검정 (leg 로그가격 레벨 시스템, trace·95%). 방향 구분 없이 '여러 종목이 장기적으로 함께 묶여 있는가'를 검정 — r≥1이면 최소 1개의 안정적 결합이 존재. 발굴 게이팅에는 쓰이지 않는 부가 지표."
              >
                Joh.
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
                <td colSpan={11} className="px-3 py-6 text-center text-t4">
                  발굴된 M:N 페어 없음
                </td>
              </tr>
            )}
            {visible.map((p) => {
              const key = rowKey(p)
              const kind = groupKindOf(p.group_id)
              return (
                <RowFragment
                  key={key}
                  pair={p}
                  kind={kind}
                  isOpen={expanded.has(key)}
                  onToggle={() => toggle(key)}
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
  // 상세는 새 탭 (1:1 페어 목록과 동일). group_id에 콜론이 있어 encodeURIComponent 필수.
  const detailUrl = `/stat-arb/mn/${encodeURIComponent(pair.group_id)}/${pair.component_idx ?? 1}`

  return (
    <>
      <tr
        className="cursor-pointer border-b border-bg-surface/40 hover:bg-bg-surface/40"
        onClick={() => window.open(detailUrl, '_blank', 'noopener,noreferrer')}
      >
        <td
          className="px-2 py-2 text-t3 hover:text-t1"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          title={isOpen ? 'leg 접기' : 'leg 펼치기'}
        >
          {isOpen ? '▼' : '▶'}
        </td>
        <td className="px-3 py-2">
          <span className="mr-1 rounded-sm bg-bg-surface px-1.5 py-0.5 text-[10px] text-t3">
            {KIND_LABEL[kind] ?? kind}
          </span>
          <span className="text-t1">{pair.group_name}</span>
          {(pair.dup_group_count ?? 1) > 1 && (
            <span
              className="ml-1 rounded-sm bg-bg-surface px-1.5 py-0.5 text-[11px] text-t4"
              title={`같은 leg 조합이 ${pair.dup_group_count}개 그룹에서 산출됨 — 대표 1개만 표시`}
            >
              외 {(pair.dup_group_count ?? 1) - 1}개 그룹
            </span>
          )}
          {(pair.component_idx ?? 1) > 1 && (
            <span
              className="ml-1 rounded-sm bg-bg-surface px-1.5 py-0.5 text-[11px] text-t3"
              title={`같은 그룹의 ${pair.component_idx}번째 성분 — 앞 성분이 쓴 종목을 후보에서 뺀 뒤 다시 찾은 축`}
            >
              #{pair.component_idx}
            </span>
          )}
          {(pair.split_factor ?? 0) > 0 && (
            <span
              className="ml-1 rounded-sm bg-blue/15 px-1.5 py-0.5 text-[11px] text-blue"
              title={`PCA factor ${pair.split_factor} 부호로 양변 분할 (시장 공통 팩터 제거 축)`}
            >
              F{pair.split_factor}
            </span>
          )}
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
        <td className="px-3 py-2">
          <JohansenBadge pair={pair} />
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
          <td colSpan={10} className="px-3 py-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <LegList title="X (롱 방향)" legs={pair.x_legs} />
              <LegList title="Y (숏 방향)" legs={pair.y_legs} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-t4">
              <span>
                group_id: <span className="text-t3">{pair.group_id}</span> · 성분{' '}
                {pair.component_idx ?? 1} · 샘플 {pair.sample_size}일 · timeframe {pair.timeframe}
              </span>
              <a
                href={detailUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-accent hover:underline"
              >
                상세 열기 →
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/** Johansen rank 배지 — r≥1(공적분 있음) accent, r0 회색, 미판정 '—'.
 *  hover 로 trace 통계량 vs 95% 임계값·λ₁ 노출. */
function JohansenBadge({ pair }: { pair: MPair }) {
  const rank = pair.johansen_rank
  if (rank == null) {
    return (
      <span
        className="text-t4"
        title="Johansen 미판정 — 표본 부족·거래일 달력 불일치·수치 실패, 또는 leg 수가 임계값 표(n−r ≤ 12) 범위 밖."
      >
        —
      </span>
    )
  }
  const trace = pair.johansen_trace0
  const crit = pair.johansen_crit95
  const detail = [
    trace != null ? `trace(r=0) ${trace.toFixed(1)}` : null,
    crit != null ? `95% 임계 ${crit.toFixed(1)}` : null,
    pair.johansen_eigen1 != null ? `λ₁ ${pair.johansen_eigen1.toFixed(4)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const verdict =
    rank >= 1
      ? `공적분 관계 ${rank}개 추정 — 방향 구분 없이 최소 1개의 안정적 결합 존재`
      : '공적분 관계 없음 (귀무가설 기각 실패) — 합성 스프레드 ADF만 통과한 페어'
  return (
    <span
      className={rank >= 1 ? 'font-medium text-accent' : 'text-t4'}
      title={`${verdict}\n${detail}`}
    >
      r{rank}
    </span>
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
