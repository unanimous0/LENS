import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { keyToCode } from '@/lib/stat-arb-keys'

type Group = {
  id: string
  name: string
  kind: string
  member_count: number
  /// 그룹 한정 1:1 통과 페어 수. 발굴 cron 1회 이상 돈 후 채워짐. (PR-A)
  pair_count?: number
}

// PR-B: Dense PCA 그룹 결과
type FactorLoading = { key: string; loading: number }
type PcaFactor = {
  factor_idx: number
  eigenvalue: number
  explained_variance_ratio: number
  top_loadings: FactorLoading[]
}
type CandidateMember = { key: string; power: number }
type GroupPcaResult = {
  members_used: string[]
  n_samples: number
  factors: PcaFactor[]
  candidate_pool: CandidateMember[]
}
type GroupPcaResp = {
  group_id: string
  group_name?: string
  result: GroupPcaResult
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
  recent_adf_tstat: number
  half_life: number
  r_squared: number
  z_score: number
  sample_size: number
  score: number
  // ETF 분류 (엔진 신규): leg 분류 태그 + 베이시스형 여부
  left_class?: string
  right_class?: string
  same_underlying?: boolean
}

type PairsResp = {
  total: number
  filtered: number
  last_run_ms: number
  last_run_duration_ms: number
  pairs: Pair[]
  // group+basis 반영·category/combo 미반영 모수 기준 카테고리별 카운트 (칩 배지용)
  category_counts?: Record<string, number>
}

type GroupsResp = {
  total: number
  groups: Group[]
}

const KIND_LABELS: Record<string, string> = {
  index: '지수',
  sector: '섹터',
  etf: 'ETF',
  etf_category: 'ETF 카테고리',
}

// leg 분류 태그 → 한글 라벨 (엔진 left_class/right_class 값)
const CLASS_LABELS: Record<string, string> = {
  broad_index: '광범위지수',
  leverage_inverse: '레버리지·인버스',
  sector: '섹터',
  theme: '테마',
  bond_rates: '채권·금리',
  factor: '팩터',
  overseas: '해외',
  commodity: '원자재',
  active: '액티브',
  other: '기타',
  stock: '주식',
  index: '지수',
}

// 배지 색 — 저채도, 과하지 않게. 미지정은 text-t3.
const CLASS_COLORS: Record<string, string> = {
  broad_index: 'text-blue',
  leverage_inverse: 'text-warning',
  sector: 'text-t2',
  theme: 'text-t2',
  bond_rates: 'text-t2',
  factor: 'text-t2',
  overseas: 'text-t2',
  commodity: 'text-t2',
  active: 'text-t2',
  stock: 'text-t3',
  index: 'text-t3',
}

type BasisView = 'exclude' | 'only' | 'all'
type AssetCombo = 'any' | 'etf_etf' | 'etf_stock' | 'stock_stock'

// 정렬 가능한 컬럼
type SortKey = 'score' | 'z' | 'hl' | 'r2' | 'adf' | 'corr' | 'beta' | 'loanrate'

// 컬럼별 hover 설명
const COL_TOOLTIPS: Record<SortKey | 'pair', string> = {
  pair: '좌변 ↔ 우변 자산 (right = α + β·left + ε)',
  beta: 'Hedge ratio β (right/left 비율) — 음수면 short pair',
  corr: '로그수익률 Pearson correlation — 사전 필터 (|r|>0.5)',
  r2: 'OLS 결정계수 — 잔차가 얼마나 작은지 (≥0.9 강한 cointegration)',
  adf: 'ADF t-stat — 1년 잔차 stationarity (<-3 통과). 괄호 = 최근 6개월 잔차 ADF(같은 β) — 최근에도 평균회귀 유지하나(>-2면 발굴 제외)',
  hl: 'Mean-reversion half-life (그 timeframe 단위, 1d 기준 일)',
  z: '현재 잔차 z-score — |z|≥2 진입 시그널',
  score: '발굴 점수 = -ADF × (1/hl) × |corr|',
  loanrate: '대여요율 (left / right). ≥15% 강조 — 고요율 매수+송출 기회',
}

// 빠른 제외 프리셋 — 시장추세 바스켓형 허브(수백 페어 도배)를 원클릭 토글. term은 소문자(매칭용).
const QUICK_EXCLUDES: { label: string; term: string }[] = [
  { label: '코리아TOP10', term: '코리아top10' },
  { label: 'ESG사회책임', term: 'esg사회책임' },
]
const QUICK_EXC_LS_KEY = 'statarb.quickExcludes'

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
  // ETF 분류·베이시스 필터 (엔진 신규 API)
  const [basisView, setBasisView] = useState<BasisView>('exclude') // 통계차익(베이시스 제외)이 기본
  const [assetCombo, setAssetCombo] = useState<AssetCombo>('any')
  const [excludeCats, setExcludeCats] = useState<Set<string>>(new Set())
  const [catCounts, setCatCounts] = useState<Record<string, number>>({})
  const [search, setSearch] = useState<string>('')
  const [exclude, setExclude] = useState<string>('') // 종목명 단어/코드 제외 (쉼표 여러 개)
  // 빠른 제외 프리셋 토글 상태 — localStorage에 저장해 다음 방문에도 유지.
  const [quickExc, setQuickExc] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(QUICK_EXC_LS_KEY)
      return raw ? new Set<string>(JSON.parse(raw)) : new Set()
    } catch {
      return new Set()
    }
  })
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortAsc, setSortAsc] = useState<boolean>(false) // 기본 내림차순
  const [loanRates, setLoanRates] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // PR-B: 그룹 PCA — groupFilter 선택 시 fetch. 404 (작은 그룹/데이터 부족)면 null + reason.
  const [pca, setPca] = useState<GroupPcaResp | null>(null)
  const [pcaErr, setPcaErr] = useState<string | null>(null)
  const [pcaOpen, setPcaOpen] = useState(false)
  const [showLogic, setShowLogic] = useState(false) // 발굴 방법론 토글

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

  // 그룹 선택 시 PCA fetch (PR-B). 미선택 또는 작은 그룹은 null.
  useEffect(() => {
    if (!groupFilter) {
      setPca(null)
      setPcaErr(null)
      return
    }
    setPcaErr(null)
    fetch(`/api/stat-arb/groups/${encodeURIComponent(groupFilter)}/pca`)
      .then(async (r) => {
        if (r.status === 404) {
          setPca(null)
          setPcaErr('PCA 미산출 (멤버 < 10 또는 데이터 부족)')
          return null
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<GroupPcaResp>
      })
      .then((d) => { if (d) setPca(d) })
      .catch((e) => { setPca(null); setPcaErr(String(e)) })
  }, [groupFilter])

  // 페어 로딩
  const loadPairs = useCallback(() => {
    setLoading(true)
    setError(null)
    // 전체 로드 — 검색이 score 낮은 페어까지 찾도록. 렌더는 visiblePairs에서 상위 500만.
    const params = new URLSearchParams({ limit: '10000' })
    if (groupFilter) params.set('group', groupFilter)
    params.set('basis', basisView)
    params.set('asset_combo', assetCombo)
    if (excludeCats.size > 0) params.set('exclude_categories', Array.from(excludeCats).join(','))
    fetch(`/api/stat-arb/pairs?${params}`)
      .then((r) => r.json())
      .then((d: PairsResp) => {
        setPairs(d.pairs)
        setMeta({ total: d.total, filtered: d.filtered, last_run_ms: d.last_run_ms })
        setCatCounts(d.category_counts ?? {})
      })
      .catch((e) => setError(`pairs: ${String(e)}`))
      .finally(() => setLoading(false))
  }, [groupFilter, basisView, assetCombo, excludeCats])

  useEffect(() => {
    loadPairs()
  }, [loadPairs])

  const filteredGroups = kindFilter ? groups.filter((g) => g.kind === kindFilter) : groups

  // 카테고리 칩 — 카운트>0 만, 내림차순. 클릭 = 제외 토글.
  const catChips = useMemo(
    () =>
      Object.entries(catCounts)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]),
    [catCounts]
  )
  const toggleCat = (cat: string) =>
    setExcludeCats((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })

  const toggleQuick = (term: string) =>
    setQuickExc((prev) => {
      const next = new Set(prev)
      if (next.has(term)) next.delete(term)
      else next.add(term)
      return next
    })
  // 빠른 제외 선택 변경 시 localStorage 저장 (다음 방문 유지).
  useEffect(() => {
    try {
      localStorage.setItem(QUICK_EXC_LS_KEY, JSON.stringify(Array.from(quickExc)))
    } catch {
      /* 무시 */
    }
  }, [quickExc])

  const lastRunStr = meta.last_run_ms
    ? new Date(meta.last_run_ms).toLocaleTimeString('ko-KR', { hour12: false })
    : '—'

  // 입력은 즉시 반영(controlled)하되, 무거운 필터·정렬·500행 렌더는 deferred 값으로 —
  // React가 여유 있을 때 처리해 타이핑이 목록 재렌더에 막히지 않게 함(입력 렉 제거).
  const deferredSearch = useDeferredValue(search)
  const deferredExclude = useDeferredValue(exclude)

  // 검색(포함) + 제외 + 정렬 적용
  const visiblePairs = useMemo(() => {
    // 쉼표로 여러 단어/코드. 한 term이라도 leg 이름/코드에 있으면 매칭.
    const parseTerms = (s: string) =>
      s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    const incTerms = parseTerms(deferredSearch)
    // 자유입력 제외 + 빠른 제외 프리셋 토글 합치기 (프리셋 term은 이미 소문자).
    const excTerms = [...parseTerms(deferredExclude), ...quickExc]
    const matches = (p: Pair, t: string) =>
      p.left_name.toLowerCase().includes(t) ||
      p.right_name.toLowerCase().includes(t) ||
      p.left_key.toLowerCase().includes(t) ||
      p.right_key.toLowerCase().includes(t)

    let list = pairs
    if (incTerms.length) list = list.filter((p) => incTerms.some((t) => matches(p, t)))
    if (excTerms.length) list = list.filter((p) => !excTerms.some((t) => matches(p, t)))

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
    // 검색(포함) 시엔 매칭 전체 표시 — score 낮은 페어도 찾게. 그 외엔 상위 500만(성능).
    return incTerms.length ? sorted : sorted.slice(0, 500)
  }, [pairs, deferredSearch, deferredExclude, quickExc, sortKey, sortAsc, loanRates])

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
      <div className="panel flex flex-col gap-2 p-3">
       <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">뷰</span>
          <Seg
            value={basisView}
            onChange={setBasisView}
            options={[
              { v: 'exclude', label: '통계차익' },
              { v: 'only', label: '베이시스' },
              { v: 'all', label: '전체' },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">조합</span>
          <Seg
            value={assetCombo}
            onChange={setAssetCombo}
            options={[
              { v: 'any', label: '전체' },
              { v: 'etf_etf', label: 'ETF-ETF' },
              { v: 'etf_stock', label: 'ETF-주식' },
              { v: 'stock_stock', label: '주식-주식' },
            ]}
          />
        </div>
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
            <option value="etf_category">ETF 카테고리</option>
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
                [{KIND_LABELS[g.kind] ?? g.kind}] {g.name} (멤버 {g.member_count}
                {g.pair_count !== undefined ? ` · 페어 ${g.pair_count}` : ''})
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
            placeholder="종목명 / 코드 (쉼표로 여러 개)"
            className="w-[220px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">제외</span>
          <input
            type="text"
            value={exclude}
            onChange={(e) => setExclude(e.target.value)}
            placeholder="예: TOP10, ESG, 069500"
            className="w-[220px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none focus:ring-1 focus:ring-down/40"
          />
          {exclude.trim() && (
            <button
              onClick={() => setExclude('')}
              className="rounded-sm bg-bg-surface px-1.5 py-1 text-[11px] text-t3 hover:text-t1"
              title="제외 조건 초기화"
            >
              ✕
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-t3">빠른제외</span>
          {QUICK_EXCLUDES.map((q) => {
            const on = quickExc.has(q.term)
            return (
              <button
                key={q.term}
                onClick={() => toggleQuick(q.term)}
                title={on ? `${q.label} 제외 해제` : `${q.label} 제외`}
                className={`rounded-sm px-2 py-1 text-[11px] ${
                  on ? 'bg-down/20 text-down line-through' : 'bg-bg-surface text-t3 hover:text-t1'
                }`}
              >
                {q.label}
              </button>
            )
          })}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-t3 tabular-nums">
          <span>
            전체 {meta.total} / 필터 {meta.filtered} / 표시{' '}
            <span className="text-t1">{visiblePairs.length}</span>
            {(deferredSearch !== search || deferredExclude !== exclude) && (
              <span className="ml-1 text-t4">…</span>
            )}
          </span>
          <span>갱신 {lastRunStr}</span>
          <button
            onClick={loadPairs}
            disabled={loading}
            className="rounded-sm bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {loading ? '...' : '새로고침'}
          </button>
          <button
            onClick={() => setShowLogic((v) => !v)}
            className={`rounded-sm px-3 py-1 ${
              showLogic ? 'bg-blue/25 text-blue' : 'bg-bg-surface text-t1'
            }`}
            title="이 페어들이 어떻게 골라지는지 발굴 로직 설명"
          >
            페어로직 {showLogic ? '▴' : '▾'}
          </button>
        </div>
       </div>

       {/* 카테고리 제외 칩 — category_counts 기반. 클릭 = 제외 토글 */}
       {catChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-t4">카테고리 제외</span>
          {catChips.map(([cat, n]) => {
            const active = excludeCats.has(cat)
            return (
              <button
                key={cat}
                onClick={() => toggleCat(cat)}
                title={active ? '제외 중 — 클릭하여 포함' : '클릭하여 제외'}
                className={`rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums ${
                  active
                    ? 'bg-down/20 text-down line-through'
                    : 'bg-bg-surface text-t3 hover:text-t1'
                }`}
              >
                {CLASS_LABELS[cat] ?? cat} <span className="tabular-nums">{n}</span>
              </button>
            )
          })}
        </div>
       )}
      </div>

      {/* PR-B: 그룹 PCA 요약 패널 — 그룹 선택 시만 표시 */}
      {groupFilter && (
        <div className="panel p-3">
          <div className="flex items-center justify-between text-xs">
            <button
              onClick={() => setPcaOpen((v) => !v)}
              className="flex items-center gap-2 text-t2 hover:text-t1"
            >
              <span>{pcaOpen ? '▼' : '▶'}</span>
              <span>PCA 요약</span>
              {pca && (
                <span className="text-t3 tabular-nums">
                  · 멤버 {pca.result.members_used.length} · 샘플 {pca.result.n_samples}
                </span>
              )}
            </button>
            {pcaErr && <span className="text-t4">{pcaErr}</span>}
          </div>
          {pcaOpen && pca && (
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-4">
              {/* factor 1~3 카드 */}
              {pca.result.factors.map((f) => (
                <div key={f.factor_idx} className="rounded-sm bg-bg-surface/40 p-2 text-xs">
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-t2">factor {f.factor_idx + 1}</span>
                    <span className="text-accent tabular-nums">
                      {(f.explained_variance_ratio * 100).toFixed(1)}%
                    </span>
                  </div>
                  <ul className="space-y-0.5 text-t3 tabular-nums">
                    {f.top_loadings.slice(0, 6).map((l) => (
                      <li key={l.key} className="flex items-center justify-between">
                        <span className="truncate text-t2">{keyToCode(l.key)}</span>
                        <span className={l.loading >= 0 ? 'text-up' : 'text-down'}>
                          {l.loading >= 0 ? '+' : ''}
                          {l.loading.toFixed(2)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {/* candidate pool */}
              <div className="rounded-sm bg-bg-surface/40 p-2 text-xs">
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-t2">candidate pool</span>
                  <span className="text-t3 tabular-nums">{pca.result.candidate_pool.length}</span>
                </div>
                <ul className="space-y-0.5 text-t3 tabular-nums">
                  {pca.result.candidate_pool.slice(0, 6).map((c) => (
                    <li key={c.key} className="flex items-center justify-between">
                      <span className="truncate text-t2">{keyToCode(c.key)}</span>
                      <span>{(c.power * 100).toFixed(1)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-t4">
                  Σ(loading² × evr). PR-C Sparse CCA 입력 풀.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 발굴 방법론 — "페어로직" 버튼 토글 */}
      {showLogic && (
      <div className="panel p-5">
        <div className="mb-1 text-base font-semibold text-t1">
          📋 발굴 방법론 — 이 페어들은 어떻게 골라지나?
        </div>

        {/* 한 줄 요약 */}
        <p className="mt-3 text-sm leading-relaxed text-t2">
          전 종목을 무차별 비교하지 않고, <span className="font-semibold text-t1">경제적 관계가 있는 후보</span>를
          추린 뒤 여러 통계 게이트를 <span className="font-semibold text-t1">모두 통과</span>한 페어만 남깁니다.
          발굴 기준은 <span className="font-semibold text-accent">3년 일봉</span>(장기 관계), 진입 타이밍은{' '}
          <span className="font-semibold text-blue">10분·30초 인트라데이</span>입니다.
        </p>

        {/* 3단계 카드 */}
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {/* ① */}
          <div className="rounded-sm bg-bg-surface p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/20 text-sm font-bold text-accent">
                1
              </span>
              <span className="text-sm font-semibold text-t1">유니버스 &amp; 후보 그룹</span>
            </div>
            <p className="text-sm leading-relaxed text-t3">
              KOSPI200 + KOSDAQ150 + 거래대금 상위 ETF + 주요 지수(<span className="text-t2">~470종목</span>)를
              같은 <span className="text-t2">섹터·지수·ETF 구성</span> 관계로 묶어 후보를 한정합니다.
              무차별 비교로 생기는 가짜 페어를 원천 차단.
            </p>
          </div>

          {/* ② */}
          <div className="rounded-sm bg-bg-surface p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/20 text-sm font-bold text-accent">
                2
              </span>
              <span className="text-sm font-semibold text-t1">1:1 통계 게이트 (3년 일봉)</span>
            </div>
            <ul className="space-y-2 text-sm leading-snug text-t3">
              <li>
                <span className="font-semibold text-t1">상관 |r| ≥ 0.3</span> — 같이 움직이나 (사전 필터)
              </li>
              <li>
                <span className="font-semibold text-t1">R² ≥ 0.5</span> — 회귀 직선에 잘 붙나
              </li>
              <li>
                <span className="font-semibold text-t1">양방향 ADF ≤ −3.0</span> — 벌어지면 다시 붙나(cointegration), 방향 바꿔도 성립
              </li>
              <li>
                <span className="font-semibold text-t1">half-life 적정</span> — 회귀가 너무 빠르지·느리지 않나
              </li>
              <li>
                <span className="font-semibold text-t1">최근창 안정성</span> — 최근 6개월에도 유지되나(과거만 좋고 최근 깨진 페어 제거)
              </li>
              <li className="pt-1 text-t4">
                → <span className="font-mono text-t2">score = −ADF × (1/half-life) × |상관|</span> 로 순위
              </li>
            </ul>
          </div>

          {/* ③ */}
          <div className="rounded-sm bg-bg-surface p-4">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue/20 text-sm font-bold text-blue">
                3
              </span>
              <span className="text-sm font-semibold text-t1">M:N 페어 (3종목+)</span>
            </div>
            <p className="text-sm leading-relaxed text-t3">
              3종목 이상의 바스켓 페어. <span className="text-t2">PCA</span>로 공통 팩터를 뽑고,{' '}
              <span className="text-t2">Sparse CCA</span>로 양변 종목을 구성한 뒤 합성 스프레드의
              cointegration을 검정합니다. <span className="text-t4">(별도 &ldquo;M:N 발굴&rdquo; 탭)</span>
            </p>
          </div>
        </div>

        {/* 결론 */}
        <div className="mt-4 rounded-sm border-l-2 border-accent bg-bg-surface px-4 py-3 text-sm leading-relaxed text-t2">
          ※ 즉 <span className="font-semibold text-t1">경제적 관계 + 오래 묶임(3년) + 최근에도 안 깨짐 + 방향 견고</span>를
          모두 만족한 페어만 이 목록에 올라옵니다. 개별 페어가 각 기준을 어떻게 통과했는지는{' '}
          <span className="text-t1">페어를 클릭 → 상세의 &ldquo;발굴 기준 점검&rdquo;</span>에서 수치로 확인할 수 있습니다.
        </div>
      </div>
      )}

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
                    window.open(
                      `/stat-arb/pair/${encodeURIComponent(p.left_key)}/${encodeURIComponent(p.right_key)}`,
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                  className="cursor-pointer border-b border-bg-surface/50 hover:bg-bg-surface/40"
                >
                  <td className="px-3 py-2 text-t4">{i + 1}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                      <span className="text-t1">{p.left_name}</span>
                      <ClassBadge cls={p.left_class} />
                      <span className="mx-0.5 text-t3">↔</span>
                      <span className="text-t1">{p.right_name}</span>
                      <ClassBadge cls={p.right_class} />
                      {p.same_underlying && (
                        <span className="rounded-sm bg-blue/15 px-1 text-[11px] text-blue">
                          베이시스
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-t4">
                      {p.left_key} / {p.right_key}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right text-t1">{p.hedge_ratio.toFixed(3)}</td>
                  <td className="px-3 py-2 text-right text-t2">{p.corr.toFixed(2)}</td>
                  <td className={`px-3 py-2 text-right ${r2Cls}`}>{p.r_squared.toFixed(3)}</td>
                  <td className={`px-3 py-2 text-right ${adfCls}`}>
                    {p.adf_tstat.toFixed(2)}
                    <span
                      className={`ml-1 text-[10px] ${p.recent_adf_tstat <= -3 ? 'text-up' : 'text-t4'}`}
                      title="최근 6개월 잔차 ADF (같은 β)"
                    >
                      ({p.recent_adf_tstat.toFixed(1)})
                    </span>
                  </td>
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

/** leg 분류 배지 — 저채도·소형. class 빈 값이면 렌더 안 함. */
function ClassBadge({ cls }: { cls?: string }) {
  if (!cls) return null
  return (
    <span className={`rounded-sm bg-bg-surface px-1 text-[11px] ${CLASS_COLORS[cls] ?? 'text-t3'}`}>
      {CLASS_LABELS[cls] ?? cls}
    </span>
  )
}

/** 세그먼트 토글 — 트레이딩 터미널 톤. 선택값 accent 강조. */
function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ v: T; label: string }>
}) {
  return (
    <div className="flex overflow-hidden rounded-sm bg-bg-surface">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 text-xs ${
            value === o.v ? 'bg-accent/25 text-accent' : 'text-t3 hover:text-t1'
          }`}
        >
          {o.label}
        </button>
      ))}
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
