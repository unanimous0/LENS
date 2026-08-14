import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AlertWatchlist } from '@/components/stat-arb/alert-watchlist'
import { Seg } from '@/components/stat-arb/seg'
import { useStatArbAlerts } from '@/hooks/useStatArbAlerts'
import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import { liveZ, pairKey } from '@/lib/stat-arb/alerts'
import { fetchQuotes, type Quote } from '@/lib/stat-arb/live-quote'
import {
  buyLegCarry,
  CARRY_CUSHION_BP,
  CARRY_VERDICT_LABEL,
  CARRY_VERDICT_TEXT_CLS,
  carryVerdict,
  carryVerdictTitle,
  dividendCaution,
  EMPTY_CARRY_MAP,
  fmtBp,
  fmtExpiry,
  fmtMonthDay,
  fmtValue,
  fmtWon,
  loadFuturesCarry,
  type FuturesCarry,
  type FuturesCarryMap,
} from '@/lib/stat-arb/futures-carry'
import { CLASS_COLORS, CLASS_LABELS } from '@/lib/stat-arb/asset-class'
import { STABILITY_BADGES, STABILITY_RANK } from '@/lib/stat-arb/stability'

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
  // 잔차 정규화 기준 μ·σ — z 셀 hover의 라이브 z 재계산용 (z_score와 같은 잔차에서 나옴).
  resid_mean?: number
  resid_std?: number
  // ETF 분류 (엔진 신규): leg 분류 태그 + 베이시스형 여부
  left_class?: string
  right_class?: string
  same_underlying?: boolean
  // 관계 안정성 (Kalman 시변 β) — 상세 패널과 동일 판정. 미산출이면 빈 문자열.
  stability?: string
  beta_drift_pct?: number
  z_gap?: number
}

type PairsResp = {
  total: number
  filtered: number
  last_run_ms: number
  last_run_duration_ms: number
  pairs: Pair[]
  // group+basis 반영·category/combo 미반영 모수 기준 카테고리별 카운트 (칩 배지용)
  category_counts?: Record<string, number>
  // 같은 모수 기준 안정성 등급별 페어 수 (미산출은 키 '')
  stability_counts?: Record<string, number>
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

// leg 분류 태그 라벨·색은 s-score 목록과 공용 (@/lib/stat-arb/asset-class).

type BasisView = 'exclude' | 'only' | 'all'
type AssetCombo = 'any' | 'etf_etf' | 'etf_stock' | 'stock_stock'
// 관계 안정성 필터 — 서버 stability param 값으로 변환해 전달 (전체=미전달)
type StabilityView = 'all' | 'stable' | 'stable_caution'
const STABILITY_PARAM: Record<StabilityView, string> = {
  all: '',
  stable: 'stable',
  stable_caution: 'stable,caution',
}

// 안정성 등급 배지·랭크는 워치리스트와 공용 (@/lib/stat-arb/stability).

// 정렬 가능한 컬럼
type SortKey =
  | 'score'
  | 'z'
  | 'hl'
  | 'r2'
  | 'adf'
  | 'corr'
  | 'beta'
  | 'loanrate'
  | 'stability'
  | 'carry'

// 컬럼별 hover 설명
const COL_TOOLTIPS: Record<SortKey | 'pair', string> = {
  pair: '좌변 ↔ 우변 자산 (right = α + β·left + ε)',
  beta: 'Hedge ratio β (right/left 비율) — 음수면 short pair',
  corr: '로그수익률 Pearson correlation — 사전 필터 (|r|>0.5)',
  r2: 'OLS 결정계수 — 잔차가 얼마나 작은지 (≥0.9 강한 cointegration)',
  adf: 'ADF t-stat — 1년 잔차 stationarity (<-3 통과). 괄호 = 최근 6개월 잔차 ADF(같은 β) — 최근에도 평균회귀 유지하나(>-2면 발굴 제외)',
  hl: 'Mean-reversion half-life (그 timeframe 단위, 1d 기준 일)',
  z: '전일 종가 기준 잔차 z-score (발굴 시점 값) — |z|≥2 진입 시그널. 장중 값이 궁금하면 z 값에 마우스를 올리면 그 페어만 실시간 z를 조회한다 (상세 페이지 카드와 같은 기준)',
  stability:
    '관계 안정성 (Kalman 시변 β, 일봉) — 정적 OLS β 대비 적응 β 드리프트 ≥10% 또는 정적/적응 z 괴리 ≥2σ면 주의, ≥20%·≥3σ면 드리프트. 상세의 "관계 안정성" 패널과 동일 판정',
  score: '발굴 점수 = -ADF × (1/hl) × |corr|',
  loanrate: '대여요율 (left / right). ≥15% 강조 — 고요율 매수+송출 기회',
  carry:
    '주식선물 대체 캐리 (bp/일) — 진입 방향의 *매수* 종목을 현물 대신 주식선물로 사면 만기까지 하루당 얼마 이득인가. ' +
    '(이론 베이시스 − 실측 베이시스) / 현물가. 이론 = 현물 × 금리×(1−증거금률) × 잔존일/365 − 만기 전 확정배당. ' +
    '양수 = 선물이 쌈(선물 매수 유리). 매수 종목이 ETF·지수거나 주식선물 미상장이면 —. 전일 종가 일봉 기준. ' +
    'β<0(short pair)이면 z≥0에서 두 종목 모두 매도라 매수 종목이 없어 —, z<0에서는 두 종목 모두 매수라 둘 중 캐리가 큰 쪽을 표시. ' +
    `숫자 색 = 판정(상세 배지와 동일, 만기까지 총 bp 기준): 초록 ${CARRY_VERDICT_LABEL.futures}(≥ +${CARRY_CUSHION_BP}bp) / 회색 ${CARRY_VERDICT_LABEL.neutral}(0 ~ +${CARRY_CUSHION_BP}bp, 쿠션 미만이라 실익 미미) / 흐림 ${CARRY_VERDICT_LABEL.spot}(음수). ` +
    '값 옆 배 = 배당 확인 — 만기 후 확정 배당락이 남았거나, 지난 1년 배당락이 잔존 구간에 투영되는데 확정분이 없다(미공시 정기배당 가능 = 캐리 과대). 사유는 값에 마우스를 올리면 나온다',
}

// 빠른 제외 프리셋 — 시장추세 바스켓형 허브(수백 페어 도배)를 원클릭 토글. term은 소문자(매칭용).
/** 자유입력 필터 디바운스(ms). useDeferredValue는 *우선순위*만 낮출 뿐 매 타자마다 렌더가
 *  돌아서, 페어 수천 개 × 행 렌더가 붙으면 입력이 멈춘다. 타이핑이 그친 뒤 1회만 돌린다. */
const FILTER_DEBOUNCE_MS = 350
/** 테이블에 실제로 그리는 최대 행 수. 검색 시에도 반드시 적용 — 예전엔 검색 중엔 매칭
 *  전체를 무제한 렌더해서(4천 행+) 흔한 글자를 치면 화면이 멈췄다. */
const MAX_RENDER_ROWS = 150
/** z 셀에 이만큼 머물러야 라이브 조회 발화 — 표를 훑고 지나갈 때 헛콜 방지. */
const HOVER_DELAY_MS = 220

/** 라이브 z 팝오버 앵커 (뷰포트 좌표 — position:fixed). */
type HoverAnchor = { pk: string; x: number; y: number; pair?: Pair }

type LiveState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; z: number | null; staticZ: number; left: Quote; right: Quote; at: number }

/** 칩(카테고리 제외·키워드 제외) 토글 디바운스(ms). 사용자가 여러 개를 연달아 누르는데
 *  토글마다 목록을 재요청하면 매번 수백 KB~MB를 새로 받고 500행을 재구축한다. 하이라이트는
 *  원본 state로 즉시 반영하고, **서버 요청만** 손이 멈춘 뒤 1회로 뭉친다. */
const CHIP_DEBOUNCE_MS = 300

/** 키워드 제외 프리셋 — 시장추세 바스켓형 허브(수백 페어를 도배하는 종목).
 *  **전부 기본 ON**(사용자 요청 2026-08-10) — 켜둔 채로 쓰다가 필요할 때 해제한다.
 *  localStorage 저장은 안 함(§22.2, 제외가 눌러앉으면 안 된다는 과거 피드백). */
const QUICK_EXCLUDES: { label: string; term: string }[] = [
  { label: '코리아TOP10', term: '코리아top10' },
  { label: 'ESG사회책임', term: 'esg사회책임' },
  { label: '코리아밸류업', term: '코리아밸류업' },
]

/** 진입 시 기본 제외 카테고리 = 주식·테마를 뺀 전부.
 *  운영상 주식·테마만 보는 게 기본이고 나머지는 필요할 때 칩으로 해제한다 (사용자 요청 2026-08-07).
 *  덤으로 초기 페이로드가 2.4MB → 0.97MB (페어 4,422 → 1,524)로 줄어든다.
 *  ※ localStorage에 저장하지 않는다 — 제외 상태가 눌러앉으면 "왜 계속 빠져 있냐"가 된다(과거 피드백).
 *    매 진입 시 항상 이 기본값에서 시작. */
const DEFAULT_EXCLUDE_CATS = [
  'broad_index',
  'leverage_inverse',
  'sector',
  'bond_rates',
  'factor',
  'overseas',
  'commodity',
  'active',
  'other',
]

/** 카테고리 칩 고정 표시 순서. 카운트 내림차순이면 자주 쓰는 주식·테마가 떨어져 있어서,
 *  둘을 붙여 달라는 요청(2026-08-07). 여기 없는 태그는 뒤에 카운트 내림차순으로 붙는다. */
const CAT_CHIP_ORDER = [
  'stock',
  'theme',
  'broad_index',
  'sector',
  'factor',
  'leverage_inverse',
  'overseas',
  'bond_rates',
  'commodity',
  'active',
  'other',
]
const CAT_CHIP_RANK = new Map(CAT_CHIP_ORDER.map((c, i) => [c, i]))

/** 값이 멈춘 뒤 `ms` 지나서야 반영. setState가 타이머 콜백 안이라 effect 본문 동기 setState가 아님. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return debounced
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
  // ETF 분류·베이시스 필터 (엔진 신규 API)
  const [basisView, setBasisView] = useState<BasisView>('exclude') // 통계차익(베이시스 제외)이 기본
  const [assetCombo, setAssetCombo] = useState<AssetCombo>('any')
  const [excludeCats, setExcludeCats] = useState<Set<string>>(() => new Set(DEFAULT_EXCLUDE_CATS))
  const [catCounts, setCatCounts] = useState<Record<string, number>>({})
  // 관계 안정성 필터 — 서버 필터(카테고리 제외와 동일 경로). 기본은 전체(필터 없음).
  const [stabilityView, setStabilityView] = useState<StabilityView>('all')
  const [stabCounts, setStabCounts] = useState<Record<string, number>>({})
  const [search, setSearch] = useState<string>('')
  const [exclude, setExclude] = useState<string>('') // 종목명 단어/코드 제외 (쉼표 여러 개)
  // 빠른 제외 프리셋 토글 상태 — 기본 OFF(제외 안 함). 서버 필터로 적용.
  const [quickExc, setQuickExc] = useState<Set<string>>(
    () => new Set(QUICK_EXCLUDES.map((q) => q.term))
  )
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [sortAsc, setSortAsc] = useState<boolean>(false) // 기본 내림차순
  const [loanRates, setLoanRates] = useState<Map<string, number>>(new Map())
  // 주식선물 대체 캐리 (일봉 스냅샷 1회 로드 — 대여요율과 같은 패턴)
  const [carry, setCarry] = useState<FuturesCarryMap>(EMPTY_CARRY_MAP)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // PR-B: 그룹 PCA — groupFilter 선택 시 fetch. 404 (작은 그룹/데이터 부족)면 null + reason.
  const [pca, setPca] = useState<GroupPcaResp | null>(null)
  const [pcaErr, setPcaErr] = useState<string | null>(null)
  const [pcaOpen, setPcaOpen] = useState(false)
  const [showLogic, setShowLogic] = useState(false) // 발굴 방법론 토글

  // 목표 z 도달 알림 — 워치리스트 패널과 목록 🔔 버튼이 같은 상태를 공유.
  const alertsApi = useStatArbAlerts()
  const { alerts, toggle: toggleAlert } = alertsApi
  const alertKeys = useMemo(
    () => new Set(alerts.map((a) => pairKey(a.left_key, a.right_key))),
    [alerts]
  )

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

  // 주식선물 대체 캐리 1회 로딩 (일봉 스냅샷 — 장중 안 바뀜)
  useEffect(() => {
    loadFuturesCarry()
      .then(setCarry)
      .catch(() => {
        /* fail-safe: 캐리 컬럼만 '—' */
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

  // 칩 필터는 **서버 파라미터 문자열로 변환한 뒤** 디바운스한다. Set을 그대로 디바운스하면
  // 켰다 껐다 해서 내용이 원상복귀해도 identity가 달라 재요청이 한 번 더 나간다.
  // 정렬된 CSV로 만들면 값이 같을 때 useState가 bail out → 불필요한 fetch 자체가 사라진다.
  const excludeCatsParam = useMemo(() => Array.from(excludeCats).sort().join(','), [excludeCats])
  const quickExcParam = useMemo(() => Array.from(quickExc).sort().join(','), [quickExc])
  const debExcludeCats = useDebounced(excludeCatsParam, CHIP_DEBOUNCE_MS)
  const debQuickExc = useDebounced(quickExcParam, CHIP_DEBOUNCE_MS)

  // 페어 로딩
  const loadPairs = useCallback(() => {
    setLoading(true)
    setError(null)
    // 전체 로드 — 검색이 score 낮은 페어까지 찾도록. 렌더는 visiblePairs에서 상위 500만.
    // limit은 '전체'를 뜻하는 여유값(엔진 통과 페어 1.1만, 프록시 상한 5만).
    const params = new URLSearchParams({ limit: '50000' })
    if (groupFilter) params.set('group', groupFilter)
    params.set('basis', basisView)
    params.set('asset_combo', assetCombo)
    if (debExcludeCats) params.set('exclude_categories', debExcludeCats)
    // 키워드 제외도 서버 필터(exclude_terms) — 카테고리 제외와 동일 경로(디바운스 후 재요청).
    if (debQuickExc) params.set('exclude_terms', debQuickExc)
    const stabParam = STABILITY_PARAM[stabilityView]
    if (stabParam) params.set('stability', stabParam)
    fetch(`/api/stat-arb/pairs?${params}`)
      .then((r) => r.json())
      .then((d: PairsResp) => {
        setPairs(d.pairs)
        setMeta({ total: d.total, filtered: d.filtered, last_run_ms: d.last_run_ms })
        setCatCounts(d.category_counts ?? {})
        setStabCounts(d.stability_counts ?? {})
      })
      .catch((e) => setError(`pairs: ${String(e)}`))
      .finally(() => setLoading(false))
  }, [groupFilter, basisView, assetCombo, debExcludeCats, debQuickExc, stabilityView])

  useEffect(() => {
    loadPairs()
  }, [loadPairs])

  const filteredGroups = kindFilter ? groups.filter((g) => g.kind === kindFilter) : groups

  // 카테고리 칩 — 카운트>0 만, CAT_CHIP_ORDER 고정 순서(미등록 태그는 뒤·카운트 내림차순).
  // 클릭 = 제외 토글. 카운트는 facet(자기 축 제외) 기준이라 제외 중인 칩도 숫자가 남는다.
  const catChips = useMemo(
    () =>
      Object.entries(catCounts)
        .filter(([, n]) => n > 0)
        .sort((a, b) => {
          const ra = CAT_CHIP_RANK.get(a[0]) ?? Number.MAX_SAFE_INTEGER
          const rb = CAT_CHIP_RANK.get(b[0]) ?? Number.MAX_SAFE_INTEGER
          return ra !== rb ? ra - rb : b[1] - a[1]
        }),
    [catCounts]
  )
  const toggleCat = (cat: string) =>
    setExcludeCats((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })

  // 안정성 세그먼트 옵션 — 카운트는 group+basis 모수 기준(카테고리/조합/키워드 제외 미반영,
  // category_counts와 동일 정책). 안정성 필터 자체엔 영향받지 않아 토글해도 숫자가 안 흔들림.
  const stabOptions = useMemo(() => {
    const stable = stabCounts.stable ?? 0
    const caution = stabCounts.caution ?? 0
    const total = Object.values(stabCounts).reduce((a, b) => a + b, 0)
    const n = (v: number) => (total > 0 ? ` ${v}` : '')
    return [
      { v: 'all' as StabilityView, label: `전체${n(total)}` },
      { v: 'stable' as StabilityView, label: `안정만${n(stable)}` },
      { v: 'stable_caution' as StabilityView, label: `안정+주의${n(stable + caution)}` },
    ]
  }, [stabCounts])

  const toggleQuick = (term: string) =>
    setQuickExc((prev) => {
      const next = new Set(prev)
      if (next.has(term)) next.delete(term)
      else next.add(term)
      return next
    })

  const lastRunStr = meta.last_run_ms
    ? new Date(meta.last_run_ms).toLocaleTimeString('ko-KR', { hour12: false })
    : '—'

  // 입력은 즉시 반영(controlled)하되, 무거운 필터·정렬·행 렌더는 **디바운스된** 값으로.
  // useDeferredValue만으로는 부족했다 — 우선순위만 낮출 뿐 매 타자마다 렌더가 돌아서,
  // 페어 수천 개 상태에서 입력이 버벅이거나 멈췄다. 타이핑이 그친 뒤 1회만 돌린다.
  const deferredSearch = useDebounced(search, FILTER_DEBOUNCE_MS)
  const deferredExclude = useDebounced(exclude, FILTER_DEBOUNCE_MS)

  // 검색(포함) + 제외 + 정렬 적용
  const visibleResult = useMemo(() => {
    // 쉼표로 여러 단어/코드. 한 term이라도 leg 이름/코드에 있으면 매칭.
    const parseTerms = (s: string) =>
      s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    const incTerms = parseTerms(deferredSearch)
    // 자유입력 제외(클라이언트). 빠른제외는 서버(exclude_terms)에서 이미 제거됨.
    const excTerms = parseTerms(deferredExclude)
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
      // 내림차순(기본) = 드리프트 먼저. 미산출은 -1로 항상 끝쪽.
      stability: (p) => (p.stability ? STABILITY_RANK[p.stability] ?? -1 : -1),
      loanrate: (p) => {
        // 페어의 max(L요율, R요율) — 한쪽만 있으면 그것만, 둘 다 없으면 -1
        const l = loanRates.get(keyToCode(p.left_key))
        const r = loanRates.get(keyToCode(p.right_key))
        if (l == null && r == null) return -1
        return Math.max(l ?? 0, r ?? 0)
      },
      // 매수 종목(z·β 부호로 결정)의 선물 대체 캐리. 없으면 NaN → 오름/내림 무관하게 맨 뒤.
      carry: (p) =>
        buyLegCarry(carry, p.z_score, p.hedge_ratio, p.left_key, p.right_key)?.carry_bp_per_day ??
        NaN,
    }
    const sorted = [...list].sort((a, b) => {
      const va = getter[sortKey](a)
      const vb = getter[sortKey](b)
      // 값 없음(NaN)은 정렬 방향과 무관하게 항상 뒤로 — 빈칸이 위로 올라오면 표가 안 읽힌다.
      const na = Number.isNaN(va)
      const nb = Number.isNaN(vb)
      if (na || nb) return na && nb ? 0 : na ? 1 : -1
      return sortAsc ? va - vb : vb - va
    })
    // 검색 중에도 반드시 상한을 건다. 예전엔 검색이면 매칭 전체를 렌더해서(4천 행+)
    // 흔한 글자를 치는 순간 화면이 멈췄다. 잘린 개수는 상단 카운트에 표기한다.
    return { rows: sorted.slice(0, MAX_RENDER_ROWS), matched: sorted.length }
  }, [pairs, deferredSearch, deferredExclude, sortKey, sortAsc, loanRates, carry])
  const visiblePairs = visibleResult.rows
  const matchedCount = visibleResult.matched

  // 행 JSX를 useMemo로 캐시 — 필터 외 상태 변경(visiblePairs 미변경) 렌더에서
  // 500행을 재생성하지 않게 함(이중 렌더 제거). visiblePairs/loanRates 변경 시에만 1회 재생성.
  const tableRows = useMemo(
    () =>
      visiblePairs.map((p, i) => {
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
              <div className="flex items-start gap-1.5">
                <BellButton
                  on={alertKeys.has(pairKey(p.left_key, p.right_key))}
                  onToggle={() =>
                    toggleAlert({
                      left_key: p.left_key,
                      right_key: p.right_key,
                      left_name: p.left_name,
                      right_name: p.right_name,
                    })
                  }
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                    <span className="text-t1">{p.left_name}</span>
                    <ClassBadge cls={p.left_class} />
                    <span className="mx-0.5 text-t3">↔</span>
                    <span className="text-t1">{p.right_name}</span>
                    <ClassBadge cls={p.right_class} />
                    {p.same_underlying && (
                      <span className="rounded-sm bg-blue/15 px-1 text-[11px] text-blue">베이시스</span>
                    )}
                  </div>
                  <div className="text-[10px] text-t4">
                    {p.left_key} / {p.right_key}
                  </div>
                </div>
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
            {/* hover 시 이 페어만 실시간 z 조회 (delegation — 핸들러는 tbody에 1개). */}
            <td
              data-zcell={pairKey(p.left_key, p.right_key)}
              className={`px-3 py-2 text-right ${zClass}`}
            >
              <span className="cursor-help border-b border-dotted border-t4/60">
                {z >= 0 ? '+' : ''}
                {z.toFixed(2)}
              </span>
            </td>
            <td className="px-3 py-2 text-right">
              <StabilityBadge
                stability={p.stability}
                driftPct={p.beta_drift_pct}
                zGap={p.z_gap}
              />
            </td>
            <td className="px-3 py-2 text-right">
              <LoanRateCell
                lRate={loanRates.get(keyToCode(p.left_key))}
                rRate={loanRates.get(keyToCode(p.right_key))}
              />
            </td>
            <td className="px-3 py-2 text-right">
              <CarryCell
                c={buyLegCarry(carry, p.z_score, p.hedge_ratio, p.left_key, p.right_key)}
                asof={carry.asof}
              />
            </td>
            <td className="px-3 py-2 text-right text-t1">{p.score.toFixed(2)}</td>
          </tr>
        )
      }),
    // alertKeys/toggleAlert는 알림 추가·삭제 때만 바뀜 (toggleAlert identity 고정).
    // carry는 페이지당 1회 로드 후 불변.
    [visiblePairs, loanRates, carry, alertKeys, toggleAlert]
  )

  // --- z 셀 hover → 그 페어만 라이브 z ----------------------------------------
  // 목록 z는 발굴(전일 종가) 값이라 장중엔 상세 카드(실시간)와 다르다. 목록 전체를 실시간
  // 구독하면 수백 종목 WS라 계정 한계를 건드리므로, 마우스 올린 페어 2종목만 REST 1콜로 찍는다.
  // hover 상태는 tableRows memo 밖에 둔다 — 안에 넣으면 hover마다 150행 JSX가 재생성된다.
  const pairByKey = useMemo(() => {
    const m = new Map<string, Pair>()
    for (const p of visiblePairs) m.set(pairKey(p.left_key, p.right_key), p)
    return m
  }, [visiblePairs])

  const [hover, setHover] = useState<HoverAnchor | null>(null)
  const [live, setLive] = useState<LiveState>({ status: 'idle' })
  const hoverPk = useRef<string | null>(null)
  const hoverTimer = useRef<number | null>(null)
  /** 늦게 도착한 이전 hover 응답이 현재 표시를 덮어쓰지 않게 하는 시퀀스. */
  const liveSeq = useRef(0)

  const clearHover = useCallback(() => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    hoverPk.current = null
    liveSeq.current += 1
    setHover(null)
    setLive({ status: 'idle' })
  }, [])

  const loadLive = useCallback(
    async (pk: string) => {
      const p = pairByKey.get(pk)
      if (!p) return
      const seq = ++liveSeq.current
      const put = (s: LiveState) => {
        if (seq === liveSeq.current) setLive(s)
      }
      // t8407은 6자리 주식/ETF 전용 — 지수·선물 종목은 현재가 조회 대상이 아니다.
      const unsupported = [p.left_key, p.right_key].find((k) => {
        const t = keyType(k)
        return t !== 'S' && t !== 'E'
      })
      if (unsupported) {
        put({ status: 'error', message: `${unsupported} — 지수·선물 종목은 실시간 조회 미지원` })
        return
      }
      if (p.resid_mean == null || !(p.resid_std != null && p.resid_std > 0)) {
        put({ status: 'error', message: '정규화 기준(μ·σ) 없음 — 엔진 응답이 구버전' })
        return
      }
      put({ status: 'loading' })
      const lCode = keyToCode(p.left_key)
      const rCode = keyToCode(p.right_key)
      try {
        const q = await fetchQuotes([lCode, rCode])
        const lq = q[lCode]
        const rq = q[rCode]
        if (!lq || !rq || !(lq.price > 0) || !(rq.price > 0)) {
          put({ status: 'error', message: '현재가 응답 없음 (거래정지·장 시작 전)' })
          return
        }
        put({
          status: 'ok',
          z: liveZ(p, lq.price, rq.price),
          staticZ: p.z_score,
          left: lq,
          right: rq,
          at: Date.now(),
        })
      } catch (e) {
        put({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    },
    [pairByKey]
  )

  const onTableOver = useCallback(
    (e: React.MouseEvent<HTMLTableSectionElement>) => {
      const cell = (e.target as HTMLElement).closest('td[data-zcell]') as HTMLElement | null
      const pk = cell?.dataset.zcell
      if (!pk) {
        if (hoverPk.current) clearHover()
        return
      }
      if (hoverPk.current === pk) return // 같은 셀 안에서의 이동 — 재조회 없음
      if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current)
      hoverPk.current = pk
      const r = cell!.getBoundingClientRect()
      // 스쳐 지나가는 셀마다 조회하지 않도록 잠깐 머문 뒤에만 발화.
      hoverTimer.current = window.setTimeout(() => {
        setHover({ pk, x: r.right, y: r.bottom, pair: pairByKey.get(pk) })
        void loadLive(pk)
      }, HOVER_DELAY_MS)
    },
    [clearHover, loadLive, pairByKey]
  )

  // 스크롤하면 앵커 좌표가 어긋나므로 그냥 닫는다.
  useEffect(() => {
    if (!hover) return
    const onScroll = () => clearHover()
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [hover, clearHover])

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
       </div>

       {/* 필터 칩 줄 — 안정성(서버) + 카테고리 제외(서버) + 키워드 제외 프리셋(서버) */}
       <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="cursor-help text-xs text-t4 underline decoration-t4 decoration-dotted underline-offset-2"
            title={COL_TOOLTIPS.stability}
          >
            안정성
          </span>
          <Seg value={stabilityView} onChange={setStabilityView} options={stabOptions} />
        </div>
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
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-t4">키워드 제외</span>
          {QUICK_EXCLUDES.map((q) => {
            const on = quickExc.has(q.term)
            return (
              <button
                key={q.term}
                onClick={() => toggleQuick(q.term)}
                title={on ? `${q.label} 제외 해제` : `${q.label} 제외`}
                className={`rounded-sm px-1.5 py-0.5 text-[11px] ${
                  on ? 'bg-down/20 text-down line-through' : 'bg-bg-surface text-t3 hover:text-t1'
                }`}
              >
                {q.label}
              </button>
            )
          })}
        </div>
       </div>

       {/* 카운트·갱신·액션 줄 — 좌측 정렬(위 필터 줄들과 시작점 통일) */}
       <div className="flex flex-wrap items-center gap-3 text-xs text-t3 tabular-nums">
        <span>
          전체 {meta.total} / 필터 {meta.filtered} / 표시{' '}
          <span className="text-t1">{visiblePairs.length}</span>
          {matchedCount > visiblePairs.length && (
            <span className="text-t4"> (매칭 {matchedCount} 중 상위 {MAX_RENDER_ROWS})</span>
          )}
          {/* 디바운스 대기 중 표시 — 자유입력(검색·제외) + 칩(카테고리·키워드) 공통 */}
          {(deferredSearch !== search ||
            deferredExclude !== exclude ||
            debExcludeCats !== excludeCatsParam ||
            debQuickExc !== quickExcParam) && <span className="ml-1 text-t4">…</span>}
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

      {/* 목표 z 도달 알림 워치리스트 — 비어 있으면 한 줄로 접힘 */}
      <AlertWatchlist api={alertsApi} />

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

      {/* 페어 테이블.
          contain:layout style — 최대 MAX_RENDER_ROWS행×12열이라, 위쪽 패널(알림 워치리스트
          펼침/접힘 등)로 문서 높이가 바뀔 때마다 이 테이블 전체가 재레이아웃되면 체감 렉이 생긴다.
          레이아웃 격리로 외부 크기 변화가 내부 재계산을 강제하지 않게 한다. */}
      <div className="panel overflow-x-auto" style={{ contain: 'layout style' }}>
        <table className="w-full table-fixed text-xs tabular-nums">
          {/* 열 너비 고정 — 필터 토글(레버리지 배지·긴 종목명 등)로 내용이 바뀌어도 열이 안 흔들리게.
              페어 열만 가변(나머지 공간 흡수), 숫자 열은 고정폭. */}
          <colgroup>
            <col className="w-12" /> {/* # */}
            <col /> {/* 페어 (가변) */}
            <col className="w-20" /> {/* β */}
            <col className="w-16" /> {/* corr */}
            <col className="w-16" /> {/* R² */}
            <col className="w-32" /> {/* ADF (recent 값 포함해 넓게) */}
            <col className="w-20" /> {/* half-life */}
            <col className="w-28" /> {/* z (+ '전일종가' 부제) */}
            <col className="w-24" /> {/* 안정성 */}
            <col className="w-28" /> {/* 대여 L/R */}
            <col className="w-24" /> {/* 캐리 (선물대체) */}
            <col className="w-20" /> {/* score */}
          </colgroup>
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
                <span className="ml-1 text-[10px] text-t4">전일종가</span>
              </SortableTh>
              <SortableTh active={sortKey === 'stability'} asc={sortAsc} onClick={() => sortClick('stability')} title={COL_TOOLTIPS.stability}>
                안정성
              </SortableTh>
              <SortableTh active={sortKey === 'loanrate'} asc={sortAsc} onClick={() => sortClick('loanrate')} title={COL_TOOLTIPS.loanrate}>
                대여 L/R
              </SortableTh>
              <SortableTh active={sortKey === 'carry'} asc={sortAsc} onClick={() => sortClick('carry')} title={COL_TOOLTIPS.carry}>
                캐리
                <span className="ml-1 text-[10px] text-t4">bp/일</span>
              </SortableTh>
              <SortableTh active={sortKey === 'score'} asc={sortAsc} onClick={() => sortClick('score')} title={COL_TOOLTIPS.score}>
                score
              </SortableTh>
            </tr>
          </thead>
          <tbody onMouseOver={onTableOver} onMouseLeave={clearHover}>
            {tableRows}
          </tbody>
        </table>
        {hover && <LiveZPopover anchor={hover} state={live} />}
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

/** 목표 z 알림 토글 — 켜면 |z| ≥ 2.0 도달 시 워치리스트가 알림. 행 클릭(상세 열기)과 분리. */
function BellButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      title={on ? '알림 해제' : '알림 추가 (|z| ≥ 2.0 도달 시)'}
      // 이모지는 text-* 색을 안 따르므로 off는 grayscale+투명도로 죽임 (500행에서 시각 소음 방지).
      className={`mt-px shrink-0 text-[13px] leading-none ${
        on ? '' : 'opacity-25 grayscale hover:opacity-70'
      }`}
    >
      🔔
    </button>
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

/** 관계 안정성 배지 — 상세 "관계 안정성" 패널과 동일 판정·라벨. 미산출(표본 부족)은 '—'. */
function StabilityBadge({
  stability,
  driftPct,
  zGap,
}: {
  stability?: string
  driftPct?: number
  zGap?: number
}) {
  const badge = stability ? STABILITY_BADGES[stability] : undefined
  if (!badge) return <span className="text-t4">—</span>
  return (
    <span
      className={`inline-block rounded-sm px-1.5 py-0.5 text-[11px] ${badge.cls}`}
      title={`β드리프트 ${((driftPct ?? 0) * 100).toFixed(1)}% · z괴리 ${(zGap ?? 0).toFixed(2)}`}
    >
      {badge.label}
    </span>
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

/** 주식선물 대체 캐리 셀 — 매수 종목을 선물로 바꿨을 때 하루당 이득(bp).
 *  숫자 색 = 상세와 같은 **판정 1벌**(`carryVerdict`, 만기까지 총 bp 기준): 선물 매수(up) /
 *  중립(t3) / 현물 매수(t4). 150행에서 색이 곧 결론이라 임계를 여기 또 두지 않는다.
 *  캐리 숫자에 안 들어간 배당 리스크(`dividendCaution` — 만기 후 확정분 / 이력 투영 힌트)가
 *  있으면 '배' 마커 1개만 붙인다 (컬럼 폭·행 높이는 그대로 유지, 사유는 툴팁). */
function CarryCell({ c, asof }: { c?: FuturesCarry; asof: string }) {
  if (!c) return <span className="text-t4">—</span>
  const v = c.carry_bp_per_day
  const verdict = carryVerdict(c)
  const cls = `${CARRY_VERDICT_TEXT_CLS[verdict]}${verdict === 'futures' ? ' font-semibold' : ''}`
  const caution = dividendCaution(c)
  return (
    <span
      className="tabular-nums"
      title={
        `${c.name} — 매수 종목을 주식선물로 대체\n` +
        `▶ ${carryVerdictTitle(c)}\n` +
        `${c.futures_code} (${c.contract === 'back' ? '차월물' : '근월물'} ${fmtExpiry(c.expiry)} · 잔존 ${c.days_left}일)\n` +
        `실측 베이시스 ${Math.round(c.basis_now).toLocaleString()}원 / 이론 ${Math.round(c.basis_theory).toLocaleString()}원` +
        (c.div_sum > 0 ? ` (배당 −${Math.round(c.div_sum).toLocaleString()}원 반영)` : '') +
        `\n캐리 ${fmtWon(c.carry_advantage)}원/주 = ${fmtBp(c.carry_bp)}bp (만기까지)\n` +
        `1계약 = ${c.multiplier}주 · 근월물 30일 평균 거래대금 ${fmtValue(c.avg_value_30d)}\n` +
        (caution.flag
          ? `⚠ 배 = 배당 확인 (만기 ${fmtMonthDay(c.expiry)}) — 캐리 숫자엔 미반영\n` +
            caution.reasons.map((r) => `· ${r}`).join('\n') +
            '\n'
          : '') +
        `일봉 ${c.data_date} 기준 (asof ${asof}) — 실시간 아님`
      }
    >
      <span className={cls}>{fmtBp(v)}</span>
      {caution.flag && <span className="ml-0.5 text-[10px] text-warning">배</span>}
    </span>
  )
}

/** 정렬 가능한 컬럼 헤더. 활성 시 ▲/▼ 표시. */
/** 라이브 z 팝오버 — z 셀 hover 시 그 페어의 실시간 z(상세 카드와 같은 기준)를 보여준다.
 *  pointer-events-none: 커서를 가로채지 않아 표를 계속 훑을 수 있다. */
function LiveZPopover({ anchor, state }: { anchor: HoverAnchor; state: LiveState }) {
  const W = 268
  const H = 132
  const left = Math.max(4, Math.min(anchor.x + 8, window.innerWidth - W - 8))
  // 아래로 넘치면 셀 위쪽으로 뒤집어 띄운다.
  const top = anchor.y + H + 8 > window.innerHeight ? Math.max(4, anchor.y - H - 24) : anchor.y + 6
  const pct = (q: Quote) => (q.prev_close > 0 ? ((q.price / q.prev_close - 1) * 100).toFixed(2) : null)
  const p = anchor.pair
  return (
    <div
      style={{ left, top, width: W }}
      className="pointer-events-none fixed z-50 rounded-sm border border-bg-surface bg-bg-primary p-2 text-xs shadow-lg"
    >
      <div className="mb-1 text-[10px] text-t4">실시간 z · 일봉 기준 (상세 카드와 동일)</div>
      {state.status === 'loading' && <div className="text-t3">조회 중…</div>}
      {state.status === 'error' && <div className="text-warning">{state.message}</div>}
      {state.status === 'ok' && (
        <>
          <div className="flex items-baseline justify-between">
            <span
              className={`font-mono text-lg ${
                state.z != null && Math.abs(state.z) >= 2.5
                  ? 'text-warning'
                  : state.z != null && Math.abs(state.z) >= 1.5
                    ? 'text-t1'
                    : 'text-t2'
              }`}
            >
              {state.z != null ? `${state.z >= 0 ? '+' : ''}${state.z.toFixed(2)}` : '—'}
            </span>
            <span className="text-[10px] text-t4">
              전일종가 z {state.staticZ >= 0 ? '+' : ''}
              {state.staticZ.toFixed(2)}
              {state.z != null && (
                <span className="ml-1 text-t3">
                  (Δ {state.z - state.staticZ >= 0 ? '+' : ''}
                  {(state.z - state.staticZ).toFixed(2)})
                </span>
              )}
            </span>
          </div>
          <div className="mt-1 grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-0.5 text-[11px] tabular-nums">
            {(
              [
                [p?.left_name ?? '좌', state.left],
                [p?.right_name ?? '우', state.right],
              ] as Array<[string, Quote]>
            ).map(([nm, q], i) => (
              <div key={i} className="contents">
                <span className="truncate text-t3">{nm}</span>
                <span className="text-right text-t1">{q.price.toLocaleString()}</span>
                <span className={`text-right ${q.price >= q.prev_close ? 'text-up' : 'text-down'}`}>
                  {pct(q) != null ? `${Number(pct(q)) >= 0 ? '+' : ''}${pct(q)}%` : '—'}
                </span>
              </div>
            ))}
          </div>
          {(state.left.stale || state.right.stale) && (
            <div className="mt-1 text-[10px] text-warning">당일 체결 없는 종목 있음 — 전일 종가 이월값</div>
          )}
          <div className="mt-1 text-[10px] text-t4">
            {new Date(state.at).toLocaleTimeString('ko-KR', { hour12: false })} 조회 · t8407 스냅샷
          </div>
        </>
      )}
    </div>
  )
}

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
