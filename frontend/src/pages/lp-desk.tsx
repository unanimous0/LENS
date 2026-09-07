import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { LpDeskDetailPanel } from '@/components/lp-desk/detail-panel'
import { ExitBasketPanel } from '@/components/lp-desk/exit-basket-panel'
import { FillsPanel } from '@/components/lp-desk/fills-panel'
import { usePageInavSubscriptions } from '@/hooks/usePageInavSubscriptions'
import { usePageOrderbookBulk } from '@/hooks/usePageOrderbookBulk'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import {
  clampHorizon,
  clampZ,
  cV,
  fmtSignedBp,
  fmtWon,
  fmtWonAbs,
  horizonLabel,
  LP_DOWN,
  LP_UP,
  nearSide,
  NEAR_MARGIN_RATIO,
  parseFillInput,
  pickFut,
  QUOTE_HORIZON_OPTIONS,
  QUOTE_HORIZON_SECONDS,
  relPerfBp,
  resolveIndexFutures,
  suggestQuote,
  ticksOutside,
  Z_DEFAULT,
  Z_MAX,
  Z_MIN,
  Z_PRESETS,
  zLabel,
  type FutQuote,
} from '@/lib/lp-desk'
import { cn } from '@/lib/utils'
import { useMarketStore } from '@/stores/marketStore'
import type { IndexFuturesProduct } from '@/types/market'
import {
  CONTRACT_LABEL,
  CONTRACT_MULTIPLIER,
  normalizePositions,
  S_REF_ASK,
  S_REF_BID,
  type HedgeContract,
  type LpDeskDetail,
  type LpDeskExitBasket,
  type LpDeskFill,
  type LpDeskHedgeFill,
  type LpDeskMaster,
  type LpDeskPosition,
  type LpDeskPositions,
} from '@/types/lp-desk'

/**
 * /lp-desk — 섹터 ETF LP 심플 콕핏 (lp-system-design.md §14).
 *
 * "지금 호가 어디에 / 선물 몇 계약 / 뭐 정리" 3개 질문에만 답한다. 화면은 계기판(sticky 헤더)
 * 한 장 + 테이블 한 장. lp-matrix(§13)와 완전 독립이며 링크도 걸지 않는다(§14.10).
 *
 * 데이터:
 *   · 통계·포지션·바스켓 = FastAPI `/api/lp-desk/*` (§14.9)
 *   · ETF 현재가·iNAV·최우선호가 = 기존 usePage* 구독 훅 (Rust 8200)
 *   · 지수선물 = 서버 상시 구독(FC9) → marketStore.indexFuturesTicks. 페이지 구독 불필요.
 *
 * 계약수·미헤지 델타·제안 호가는 **전부 프론트 계산** — 서버는 β·포지션·괴리 통계까지만(§14.4).
 */

const API = '/api/lp-desk'

// ── 튜너 (localStorage) ────────────────────────────────────────────────────

/**
 * 호가 튜너 (§14.5 4차 보완 + 5차). 호가 노브는 **z와 지평 T** 둘이다 —
 * x = μ_g ± z·√(σ_g² + σ_r(T)²). 분위수 선택·밴드·스큐 가중은 전부 폐기됐다.
 * z를 올리면 유리하지만 덜 체결되고, T를 늘리면 "더 오래 걸어 둔다"는 뜻이라 폭이 넓어진다.
 */
type Tuner = {
  /** σ_comb 배수 — 헤더 프리셋(`Z_PRESETS`) 또는 옆 칸 자유 입력(`Z_MIN`~`Z_MAX`). 기본 1.5σ. */
  z: number
  /** 호가 지평 T (초) — 서버가 그 지평의 σ_r을 직접 잰다 (`QUOTE_HORIZON_OPTIONS`). 기본 1분. */
  horizonSeconds: number
  /** 청산 신호 임계 — 헤지 상대성과 edge(bp). */
  exitBp: number
  /** 잔차(헤지불가) 리스크 한도 (₩). */
  residLimitWon: number
}

const DEFAULT_TUNER: Tuner = {
  z: Z_DEFAULT,
  horizonSeconds: QUOTE_HORIZON_SECONDS,
  exitBp: 15,
  residLimitWon: 50_000_000,
}
const TUNER_KEY = 'lpDesk.tuner.v8'
/**
 * 구 튜너 키 — 로드 시 지운다. v1(base+k×잔차vol) / v2·v3(괴리 μ±zσ + 상수 밴드 + 스큐 w) /
 * v4(선물 앵커 + s 분위수) / v5(g 분위수 선택)는 모두 폐기된 호가 공식이라 남길 이유가 없다.
 * v5→v6은 노브 자체가 분위수 → z로 바뀌었고, v6→v7은 지평 T가 노브로 추가되며 σ_r 정의가
 * 바뀌었다(√T 환산 → 지평 직접 측정 — 같은 z라도 폭이 달라진다).
 * **v7→v8**: 기본 z 2.0 → 1.5. 키를 안 올리면 이미 저장된 `z:2`가 그대로 복원돼 기본값 변경이
 * 화면에 안 먹는다 — 기본값을 바꿀 때는 키를 함께 올린다.
 * z 자유 입력 복원(2026-08-28)은 **키 그대로 v8** — 스키마가 같고 v8에 저장된 z는 프리셋
 * 값뿐이라(스냅이 걸려 있었다) 클램프만 남겨도 그대로 복원된다. 마이그레이션 불필요.
 */
const LEGACY_TUNER_KEYS = [
  'lpDesk.tuner.v1', 'lpDesk.tuner.v2', 'lpDesk.tuner.v3',
  'lpDesk.tuner.v4', 'lpDesk.tuner.v5', 'lpDesk.tuner.v6',
  'lpDesk.tuner.v7',
]

function loadTuner(): Tuner {
  try {
    for (const k of LEGACY_TUNER_KEYS) localStorage.removeItem(k)
    const raw = localStorage.getItem(TUNER_KEY)
    if (!raw) return DEFAULT_TUNER
    const v = JSON.parse(raw) as Partial<Tuner>
    const pickNum = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? n : d)
    return {
      // 프리셋 밖 값도 그대로 산다 (자유 입력) — 범위 클램프 + 2자리 반올림만.
      z: clampZ(v.z),
      horizonSeconds: clampHorizon(v.horizonSeconds),
      exitBp: Math.max(0, pickNum(v.exitBp, DEFAULT_TUNER.exitBp)),
      residLimitWon: Math.max(0, pickNum(v.residLimitWon, DEFAULT_TUNER.residLimitWon)),
    }
  } catch {
    return DEFAULT_TUNER
  }
}

// ── 헤지 버킷 ──────────────────────────────────────────────────────────────

type BucketId = 'k200' | 'kq150'

/** 선물가 조회 우선순위 (미니와 K200F는 같은 가격, 승수만 다름). */
const K200_PRODUCTS: IndexFuturesProduct[] = ['mini_k200', 'kospi200']
const KQ150_PRODUCTS: IndexFuturesProduct[] = ['kosdaq150']

/** 버킷 정의. */
const BUCKETS: {
  id: BucketId
  label: string
  contract: HedgeContract
  products: IndexFuturesProduct[]
}[] = [
  { id: 'k200', label: 'K200', contract: 'MK200', products: K200_PRODUCTS },
  { id: 'kq150', label: 'KQ150', contract: 'KQ150F', products: KQ150_PRODUCTS },
]

// ── 페이지 ────────────────────────────────────────────────────────────────

type SK =
  | 'name' | 'price' | 'changePct' | 'nav' | 'premiumBp' | 'mktSpreadBp'
  | 'quoteBid' | 'quoteAsk' | 'bidBp' | 'askBp'
  | 'betaK' | 'betaQ' | 'r2' | 'relBp'
  | 'qty' | 'onCapWon' | 'improveBp' | 'edgeBp' | 'pnl'

/** 절댓값으로 정렬해야 자연스러운 키 (롱·숏을 같이 위로). */
const ABS_SORT: Partial<Record<SK, true>> = { qty: true }

/** 테이블 컬럼 수 — 빈 상태·행 펼침 td의 colSpan. 헤더와 같이 고쳐야 한다. */
const COLS = 21

/** x 컬럼 헤더 툴팁 — 산식과 보조줄(도달 일수)이 무엇인지 한 곳에만 적는다. */
function xHeaderTip(horizonSeconds: number): string {
  return (
    '호가가 설 레벨 x = μ_g ± z·σ결합 (bp, iNAV 대비).\n' +
    `σ결합 = √(σ괴리² + σ선물²) — NAV 괴리 분포와 선물 괴리 분포의 결합.\n` +
    `σ선물은 ${horizonLabel(horizonSeconds)} 지평에서 **직접 측정**한 값이다 (√T 환산 폐기 — §14.5 5차).\n` +
    '보조줄 "N일 중 M일" = 장중 g가 그 x 레벨을 한 번이라도 넘은 날 수.\n' +
    'z를 올릴수록 유리하지만 도달 일수는 줄어든다 (정의상 단조).'
  )
}

/**
 * x 분해 한 줄 — `μ −9.2 · σ괴리 8.1 · σ선물(1분) 9.8 → ±1.5σ 19.2bp`.
 * 셀·툴팁 여러 곳이 같은 문장을 쓰므로 한 벌로 둔다. 지평은 산출에 실제로 쓰인 값
 * (`suggestQuote`가 돌려준 `horizonSeconds`)을 그대로 적는다 — 라벨과 값이 어긋나면 안 된다.
 */
function xBreakdown(
  x: {
    muBp: number | null
    sigmaGBp: number | null
    sigmaRBp: number | null
    sigmaCombBp: number | null
    horizonSeconds: number
  },
  z: number,
): string {
  if (x.muBp == null || x.sigmaCombBp == null) return ''
  const g = x.sigmaGBp != null ? x.sigmaGBp.toFixed(1) : '-'
  const r = x.sigmaRBp != null ? x.sigmaRBp.toFixed(1) : '없음(선물봉 부재 → σ괴리만)'
  return `μ ${fmtSignedBp(x.muBp)} · σ괴리 ${g} · σ선물(${horizonLabel(x.horizonSeconds)}) ${r} → ±${z}σ ${(z * x.sigmaCombBp).toFixed(1)}bp`
}

/**
 * 재구성 바스켓에서 뺀 레그 안내 (§14.3, 2026-08-26). 창 전체에 30초봉이 없는 구성
 * (커버드콜 ETF의 옵션·선물 레그 등)은 빼고 **주식+현금만으로** g를 잰다 — 그 레그의
 * 가치만큼 μ에 레벨 편차가 실리므로, 그런 종목에서만 툴팁에 한 줄로 밝힌다.
 */
function excludedLegsNote(n: number): string {
  return n > 0 ? `\n⚠️ 가격 없는 구성 ${n}개 제외(옵션·선물 등) — 주식+현금만의 g라 μ에 그만큼 레벨 편차` : ''
}

/**
 * 오버나이트 상한 룰(§14.12) 파라미터. **숫자는 서버 `/master`의 params가 단일 진실원**이라
 * 화면에 다시 적지 않고 받아서 문장에만 끼운다 (백테스트 갱신 시 서버만 고치면 된다).
 */
type OvernightRule = {
  tailLossWon: number | null
  z: number | null
  maxResidVolBp: number | null
  minObs: number | null
}

const EMPTY_ON_RULE: OvernightRule = { tailLossWon: null, z: null, maxResidVolBp: null, minObs: null }

type ExpandPanel = 'none' | 'exit' | 'fills'

export function LpDeskPage() {
  const [master, setMaster] = useState<LpDeskMaster | null>(null)
  const [masterErr, setMasterErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [positions, setPositions] = useState<LpDeskPositions>({ positions: [], hedges: [] })
  const [posErr, setPosErr] = useState('')

  const [tuner, setTuner] = useState<Tuner>(loadTuner)
  useEffect(() => {
    try { localStorage.setItem(TUNER_KEY, JSON.stringify(tuner)) } catch { /* 저장 실패는 무해 */ }
  }, [tuner])
  /** z가 프리셋 값이면 세그먼트가, 아니면(자유 입력) 옆 입력칸이 켜진다. */
  const zIsPreset = (Z_PRESETS as readonly number[]).includes(tuner.z)

  const [sk, setSk] = useState<SK>('qty')
  const [asc, setAsc] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, LpDeskDetail>>({})
  /** 상세 조회 실패는 **행별**로 — 한 벌로 두면 A행 실패 후 B행을 펼쳤을 때 stale 에러가 뜬다. */
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const [detailLoadingCode, setDetailLoadingCode] = useState<string | null>(null)

  const [panel, setPanel] = useState<ExpandPanel>('none')
  const [basket, setBasket] = useState<LpDeskExitBasket | null>(null)
  const [basketState, setBasketState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' })
  const [fills, setFills] = useState<LpDeskFill[]>([])
  const [hedgeFills, setHedgeFills] = useState<LpDeskHedgeFill[]>([])
  const [fillsState, setFillsState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' })

  const [input, setInput] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 헤더 높이 — thead sticky 오프셋. 튜너 줄바꿈 등으로 높이가 변하므로 관측한다.
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerH, setHeaderH] = useState(92)
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight))
    ro.observe(el)
    setHeaderH(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  // 200ms throttled 스냅샷 — store 직접 구독 시 매 tick마다 페이지 전체 재렌더.
  const [snap, setSnap] = useState(() => {
    const s = useMarketStore.getState()
    return {
      etfTicks: s.etfTicks,
      stockTicks: s.stockTicks,
      orderbookTicks: s.orderbookTicks,
      indexFuturesTicks: s.indexFuturesTicks,
    }
  })
  useEffect(() => {
    const id = setInterval(() => {
      const s = useMarketStore.getState()
      // store는 배치 갱신 때만 맵 identity를 바꾼다 → 변화 없으면 setState 자체를 건너뛴다
      // (장 외/조용한 구간에서 5Hz 헛렌더 방지).
      setSnap((prev) =>
        prev.etfTicks === s.etfTicks &&
        prev.stockTicks === s.stockTicks &&
        prev.orderbookTicks === s.orderbookTicks &&
        prev.indexFuturesTicks === s.indexFuturesTicks
          ? prev
          : {
              etfTicks: s.etfTicks,
              stockTicks: s.stockTicks,
              orderbookTicks: s.orderbookTicks,
              indexFuturesTicks: s.indexFuturesTicks,
            },
      )
    }, 200)
    return () => clearInterval(id)
  }, [])

  // ── 서버 조회 ──
  /** 한 번이라도 마스터를 받았는지 — 수동 새로고침 때 테이블을 로딩 문구로 비우지 않기 위해. */
  const hasMaster = useRef(false)
  const loadMaster = useCallback(() => {
    if (!hasMaster.current) setLoading(true)
    fetch(`${API}/master`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d: LpDeskMaster) => {
        hasMaster.current = true
        setMaster(d)
        setMasterErr('')
        setLoading(false)
      })
      .catch((e: Error) => { setMasterErr(e.message); setLoading(false) })
  }, [])

  const loadPositions = useCallback(() => {
    fetch(`${API}/positions`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setPositions(normalizePositions(d)); setPosErr('') })
      .catch((e: Error) => setPosErr(e.message))
  }, [])

  useEffect(() => { loadMaster() }, [loadMaster])
  useEffect(() => {
    loadPositions()
    // 체결은 이 화면에서만 들어가지만 여러 탭·기기에서 볼 수 있어 주기 재조회 (SQLite라 저렴).
    const id = setInterval(loadPositions, 60_000)
    return () => clearInterval(id)
  }, [loadPositions])

  const loadBasket = useCallback(() => {
    setBasketState({ loading: true, error: '' })
    fetch(`${API}/exit-basket`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d: LpDeskExitBasket) => { setBasket(d); setBasketState({ loading: false, error: '' }) })
      .catch((e: Error) => setBasketState({ loading: false, error: e.message }))
  }, [])

  const loadFills = useCallback(() => {
    setFillsState({ loading: true, error: '' })
    Promise.all([
      fetch(`${API}/fills`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      fetch(`${API}/hedge-fills`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    ])
      .then(([f, h]) => {
        setFills(asList<LpDeskFill>(f, 'fills'))
        setHedgeFills(asList<LpDeskHedgeFill>(h, 'hedge_fills'))
        setFillsState({ loading: false, error: '' })
      })
      .catch((e: Error) => setFillsState({ loading: false, error: e.message }))
  }, [])

  const openPanel = (next: ExpandPanel) => {
    setPanel((prev) => {
      const target = prev === next ? 'none' : next
      if (target === 'exit') loadBasket()
      if (target === 'fills') loadFills()
      return target
    })
  }

  // 행 펼침 — 상세는 코드별 1회만 가져와 캐시.
  const toggleExpand = useCallback((code: string) => {
    setExpanded((prev) => (prev === code ? null : code))
  }, [])

  useEffect(() => {
    if (!expanded || details[expanded]) return
    const code = expanded
    let alive = true
    setDetailLoadingCode(code)
    setDetailErrors((p) => (p[code] === undefined ? p : dropKey(p, code)))
    fetch(`${API}/detail/${code}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d: LpDeskDetail) => {
        if (!alive) return
        setDetails((p) => ({ ...p, [code]: d }))
      })
      .catch((e: Error) => { if (alive) setDetailErrors((p) => ({ ...p, [code]: e.message })) })
      .finally(() => { if (alive) setDetailLoadingCode((c) => (c === code ? null : c)) })
    return () => { alive = false }
  }, [expanded, details])

  // 통계일이 바뀌면(장 마감 후 재계산·수동 새로고침) 상세 캐시는 전부 전날 것 — 통째로 버린다.
  // 펼쳐둔 행이 있으면 위 effect가 details 변화를 보고 곧바로 재조회한다.
  const statsDate = master?.stats_date ?? ''
  const lastStatsDate = useRef(statsDate)
  useEffect(() => {
    if (lastStatsDate.current === statsDate) return
    lastStatsDate.current = statsDate
    // 비어 있으면 identity를 굳이 바꾸지 않는다 (첫 마스터 수신 시 헛렌더 방지).
    setDetails((p) => (Object.keys(p).length ? {} : p))
    setDetailErrors((p) => (Object.keys(p).length ? {} : p))
  }, [statsDate])

  // ── 실시간 구독 (36종 고정) ──
  const codes = useMemo(() => (master?.items ?? []).map((i) => i.etf_code), [master])
  usePageStockSubscriptions(codes)
  usePageInavSubscriptions(codes)
  usePageOrderbookBulk(codes)

  /** 입력 파싱용 — 대문자 심볼 → 정식 ETF 코드. (0117V0 같은 영숫자 혼합 코드 대응) */
  const universe = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of master?.items ?? []) m.set(i.etf_code.toUpperCase(), i.etf_code)
    return m
  }, [master])

  const nameByCode = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of master?.items ?? []) m.set(i.etf_code, i.name)
    return m
  }, [master])
  const nameOf = useCallback((code: string) => nameByCode.get(code) ?? code, [nameByCode])

  const posByCode = useMemo(() => {
    const m = new Map<string, LpDeskPosition>()
    for (const p of positions.positions) m.set(p.etf_code, p)
    return m
  }, [positions])

  // 지수선물 — 헤지 환산(§14.4)·edge(§14.6)·스큐(§14.5)·진입 스냅샷이 **한 벌의 체인**을 쓴다
  // (resolveIndexFutures: price>0 + timestamp 최신 월물).
  const futByProduct = useMemo(() => resolveIndexFutures(snap.indexFuturesTicks), [snap.indexFuturesTicks])
  const futK200 = useMemo(() => pickFut(futByProduct, K200_PRODUCTS), [futByProduct])
  const futKq150 = useMemo(() => pickFut(futByProduct, KQ150_PRODUCTS), [futByProduct])

  // ── 행 산출 ──
  const rows = useMemo(() => {
    const items = master?.items ?? []
    const fkPrice = futK200?.price ?? 0
    const fqPrice = futKq150?.price ?? 0
    // 선물 등락률은 둘 다 있어야 rel이 성립한다 (한쪽만이면 β 조합이 반쪽).
    const fkChg = futK200?.changePct ?? null
    const fqChg = futKq150?.changePct ?? null
    return items.map((it) => {
      const code = it.etf_code
      const etf = snap.etfTicks[code]
      const stock = snap.stockTicks[code]
      const ob = snap.orderbookTicks[code]
      const price = etf?.price || stock?.price || 0
      // 전일종가는 **행 계산 초입에서 한 번만** 해석한다 (§14.11). 등락률·오늘 s·제안 호가가
      // 서로 다른 기준가를 쓰면 "s는 있는데 호가는 없다" 같은 어긋남이 난다.
      // 우선순위: 실시간 틱(오늘 장의 정답, 배당락 기준가 반영) → 서버 일봉 종가.
      const tickPrev = etf?.prev_close || stock?.prev_close || 0
      const serverPrev = it.prev_close != null && it.prev_close > 0 ? it.prev_close : null
      const prevClose = tickPrev > 0 ? tickPrev : serverPrev
      // 서버 종가로 폴백한 경우에만 신선도가 문제가 된다 — 틱이 있으면 FD 적재 지연과 무관.
      const prevCloseStale = tickPrev <= 0 && prevClose != null && it.prev_close_stale === true
      const nav = etf?.nav ?? 0
      const bid1 = ob?.bids[0]?.price ?? 0
      const ask1 = ob?.asks[0]?.price ?? 0
      const mid = bid1 > 0 && ask1 > 0 ? (bid1 + ask1) / 2 : 0
      const ref = mid || price
      const insufficient = it.insufficient === true || it.beta_k200 == null
      const residVol = insufficient ? null : it.resid_vol_bp
      const changePct = prevClose != null && price > 0 ? ((price - prevClose) / prevClose) * 100 : null

      // 실시간 괴리 g = (mid 또는 현재가 − iNAV)/iNAV — **호가 x와 같은 자**(§14.5 4차).
      // 이게 x에 다가가는 게 곧 체결 임박이라, 호가보다 먼저 구한다.
      const premiumBp = nav > 0 && ref > 0 ? ((ref - nav) / nav) * 10000 : null

      // 오늘 s (§14.5) — ETF가 β 조합 선물 대비 전일종가에서 얼마나 벌어졌는가.
      // 호가와 무관한 **잔차 리스크 감각** 컬럼 (4차 정정으로 호가에서 빠졌다).
      const relBp = insufficient
        ? null
        : relPerfBp(changePct, it.beta_k200 ?? null, it.beta_kq150 ?? null, fkChg, fqChg)

      // 제안 호가 (§14.5 호가 층) — 앵커 iNAV × (1 + x), x = μ_g ± z·√(σ_g²+σ_r²).
      // 캘리브·iNAV 중 하나라도 없으면 가격 없이 사유만. 선물·β·전일종가는 무관
      // (σ_r은 선물이 필요하지만, 없으면 차단이 아니라 σ_g로 degrade).
      const quote = suggestQuote({
        inav: nav > 0 ? nav : null,
        calib: it.calib,
        z: tuner.z,
        horizonSeconds: tuner.horizonSeconds,
      })
      // 체결 임박 — 실시간 g가 x 레벨까지 |x|의 20% 이내로 접근했는지 (§14.5 운영 사이클).
      const near = nearSide(premiumBp, quote.xAskBp, quote.xBidBp)

      const pos = posByCode.get(code)
      const qty = pos?.qty ?? 0
      const markPrice = ref || pos?.avg_price || 0
      const value = qty * markPrice
      const entryGapBp = pos?.entry_gap_bp ?? null
      const improveBp =
        qty !== 0 && premiumBp != null && entryGapBp != null
          ? (premiumBp - entryGapBp) * Math.sign(qty)
          : null

      // 헤지 상대성과 (§14.6) — ETF 수익률에서 β로 환산한 선물 수익률을 뺀 초과분.
      // 진입 선물가가 없는(시세 미수신 체결) 포지션은 산출 불가 — 사유를 툴팁으로 남긴다.
      const entryK200 = pos?.entry_k200 ?? null
      const entryKq150 = pos?.entry_kq150 ?? null
      const avgPrice = pos?.avg_price ?? 0
      let edgeBp: number | null = null
      let edgeNote = ''
      if (qty !== 0) {
        if (insufficient) edgeNote = '회귀 표본 부족 — β 없음'
        else if (avgPrice <= 0 || markPrice <= 0) edgeNote = '현재가/평단 미수신'
        else if (entryK200 == null || entryKq150 == null) edgeNote = '진입 시점 선물가 없음 (체결 당시 시세 미수신)'
        else if (fkPrice <= 0 || fqPrice <= 0) edgeNote = '지수선물 시세 미수신'
        else
          edgeBp =
            Math.sign(qty) *
            (markPrice / avgPrice - 1
              - (it.beta_k200 ?? 0) * (fkPrice / entryK200 - 1)
              - (it.beta_kq150 ?? 0) * (fqPrice / entryKq150 - 1)) *
            10000
      }

      return {
        code,
        name: it.name,
        insufficient,
        betaK: insufficient ? null : it.beta_k200,
        betaQ: insufficient ? null : it.beta_kq150,
        r2: insufficient ? null : it.r2,
        residVol,
        residZ: insufficient ? null : it.resid_z,
        // 오버나이트 상한 (§14.12) — 서버 산출값 그대로. 금지 = 0, 표본부족 = null.
        onCapWon: it.overnight_cap_won ?? null,
        onBanned: it.overnight_banned === true,
        obs: it.obs ?? null,
        gapMeanBp: it.gap_mean_bp ?? null,
        gapSigmaBp: it.gap_sigma_bp ?? null,
        gapObs: it.gap_obs ?? null,
        calib: it.calib ?? null,
        relBp,
        near,
        price,
        // 등락률은 **미수신과 보합을 구분**한다 — 전일종가/현재가가 없으면 null("—"),
        // 0으로 눌러 "+0.00%"를 렌더하지 않는다 (§14.11).
        changePct,
        // 호가는 iNAV 앵커라 전일종가와 무관하지만, 등락률·오늘 s는 이 종가로 계산된다.
        prevCloseNote: prevCloseStale
          ? `전일종가 미갱신(${it.prev_close_date ?? '일자 미상'}) — 등락률·오늘 s가 2거래일 이상 수익률`
          : '',
        nav,
        bid1,
        ask1,
        mid,
        premiumBp,
        anchor: quote.anchor,
        bidBp: quote.xBidBp,
        askBp: quote.xAskBp,
        // x 분해 (μ_g / σ_g / σ_r / σ_comb) — 툴팁에서 "왜 이 폭인가"를 보여준다.
        muBp: quote.muBp,
        sigmaGBp: quote.sigmaGBp,
        sigmaRBp: quote.sigmaRBp,
        sigmaCombBp: quote.sigmaCombBp,
        // σ_r을 실제로 가져온 지평 — 라벨이 값과 어긋나지 않게 산출 결과를 그대로 들고 다닌다.
        horizonSeconds: quote.horizonSeconds,
        sigmaDegraded: quote.degraded,
        touchDaysBid: quote.touchDaysBid,
        touchDaysAsk: quote.touchDaysAsk,
        touchTotalDays: quote.touchTotalDays,
        quoteBidReason: quote.bidReason,
        quoteAskReason: quote.askReason,
        quoteBid: quote.bid,
        quoteAsk: quote.ask,
        // 내 호가가 시장 최우선호가에서 몇 틱 밖인지 (양수 = 밖에서 대기).
        ticksOutBid: ticksOutside(quote.bid, 'bid', bid1, ask1),
        ticksOutAsk: ticksOutside(quote.ask, 'ask', bid1, ask1),
        mktSpreadBp: bid1 > 0 && ask1 > 0 ? ((ask1 - bid1) / ((ask1 + bid1) / 2)) * 10000 : null,
        qty,
        avgPrice,
        value,
        entryGapBp,
        improveBp,
        edgeBp,
        edgeNote,
        // 행 PnL = 헤지 후 손익 (ETF 단독이 아니라 선물 상대, §14.6).
        pnl: edgeBp != null ? (edgeBp / 10000) * Math.abs(value) : null,
      }
    })
  }, [master, snap, posByCode, tuner, futK200, futKq150])

  type Row = (typeof rows)[number]

  const sorted = useMemo(() => {
    const order = new Map(rows.map((r, i) => [r.code, i]))
    const list = [...rows]
    list.sort((a, b) => {
      if (sk === 'name') {
        const c = a.name.localeCompare(b.name)
        return asc ? c : -c
      }
      const raw = (r: Row) => {
        const v = r[sk] as number | null
        if (v == null || !Number.isFinite(v)) return null
        return ABS_SORT[sk] ? Math.abs(v) : v
      }
      const av = raw(a)
      const bv = raw(b)
      if (av == null && bv == null) return (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0)
      if (av == null) return 1 // null은 방향과 무관하게 뒤로
      if (bv == null) return -1
      if (av !== bv) return asc ? av - bv : bv - av
      return (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0)
    })
    return list
  }, [rows, sk, asc])

  const doSort = (k: SK) => {
    if (sk === k) setAsc((v) => !v)
    else { setSk(k); setAsc(k === 'name') }
  }

  // ── 헤지 환산 (§14.4) ──
  const hedgeByContract = useMemo(() => {
    const m = new Map<HedgeContract, { qty: number; avgPrice: number }>()
    for (const h of positions.hedges) m.set(h.contract, { qty: h.qty, avgPrice: h.avg_price })
    return m
  }, [positions])

  const desk = useMemo(() => {
    const buckets = BUCKETS.map((b) => {
      const futPrice = pickFut(futByProduct, b.products)?.price ?? 0
      const mult = CONTRACT_MULTIPLIER[b.contract]
      const contractValue = futPrice * mult
      let exposure = 0
      for (const r of rows) {
        const beta = b.id === 'k200' ? r.betaK : r.betaQ
        if (beta == null || r.qty === 0) continue
        exposure += r.value * beta
      }
      const held = hedgeByContract.get(b.contract)?.qty ?? 0
      const target = contractValue > 0 ? Math.round(-exposure / contractValue) : 0
      const action = target - held
      const unhedged = exposure + held * contractValue
      return { ...b, futPrice, mult, contractValue, exposure, held, target, action, unhedged }
    })

    let residWon = 0
    for (const r of rows) {
      if (r.qty === 0 || r.residVol == null) continue
      residWon += Math.abs(r.value) * (r.residVol / 10000)
    }

    // 헤지 후 PnL 합계 — 각 행의 edge × |평가액| (선물 계좌 손익은 별도 futPnl).
    let edgePnl = 0
    for (const r of rows) if (r.pnl != null) edgePnl += r.pnl

    let futPnl = 0
    let futPnlKnown = false
    for (const b of buckets) {
      const h = hedgeByContract.get(b.contract)
      if (!h || h.qty === 0 || b.futPrice <= 0 || h.avgPrice <= 0) continue
      futPnl += (b.futPrice - h.avgPrice) * h.qty * b.mult
      futPnlKnown = true
    }

    const totalUnhedged = buckets.reduce((s, b) => s + b.unhedged, 0)
    // 신호등 기준은 "헤지 정밀도 한계" — 미니K200 1계약(≈₩2천만)보다 작은 잔여 델타는
    // 계약 단위로 더 줄일 수 없다. 0.5계약 이내 초록 / 1.5계약 이내 경고 / 그 이상 빨강.
    const unit = buckets.find((b) => b.id === 'k200')?.contractValue || buckets[0]?.contractValue || 0
    const deltaTone: 'ok' | 'warn' | 'bad' | 'unknown' =
      unit <= 0 ? 'unknown'
        : Math.abs(totalUnhedged) <= unit * 0.5 ? 'ok'
        : Math.abs(totalUnhedged) <= unit * 1.5 ? 'warn'
        : 'bad'
    return { buckets, residWon, edgePnl, futPnl, futPnlKnown, totalUnhedged, deltaTone, unit }
  }, [rows, futByProduct, hedgeByContract])

  const positionCount = useMemo(() => rows.reduce((n, r) => n + (r.qty !== 0 ? 1 : 0), 0), [rows])

  /** 오버나이트 상한 룰(§14.12) — 툴팁 문장에만 쓰인다. 서버가 안 주면 문장에서 그 항만 빠진다. */
  const onRule = useMemo<OvernightRule>(() => {
    const p = master?.params
    if (!p) return EMPTY_ON_RULE
    return {
      tailLossWon: p.on_tail_loss_won ?? null,
      z: p.on_tail_z ?? null,
      maxResidVolBp: p.on_max_resid_vol_bp ?? null,
      minObs: p.on_min_obs ?? null,
    }
  }, [master])

  // ── 체결 입력 ──
  useEffect(() => {
    if (!feedback) return
    const id = setTimeout(() => setFeedback(null), 4000)
    return () => clearTimeout(id)
  }, [feedback])

  const submitFill = useCallback(async () => {
    if (submitting) return
    const parsed = parseFillInput(input, universe)
    if (parsed.kind === 'error') {
      setFeedback({ ok: false, msg: parsed.message })
      return
    }
    setSubmitting(true)
    try {
      let res: Response
      let label: string
      if (parsed.kind === 'etf') {
        // 진입 스냅샷은 **기록 시점의 store 최신값**을 쓴다 (200ms throttled snap이 아니라).
        const st = useMarketStore.getState()
        const nav = st.etfTicks[parsed.code]?.nav ?? 0
        const byProduct = resolveIndexFutures(st.indexFuturesTicks)
        const fk = pickFut(byProduct, K200_PRODUCTS)?.price ?? 0
        const fq = pickFut(byProduct, KQ150_PRODUCTS)?.price ?? 0
        res = await fetch(`${API}/fills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            etf_code: parsed.code,
            qty: parsed.qty,
            price: parsed.price,
            entry_inav: nav > 0 ? nav : null,
            entry_k200: fk > 0 ? fk : null,
            entry_kq150: fq > 0 ? fq : null,
          }),
        })
        const missing = [nav > 0 ? '' : 'iNAV', fk > 0 && fq > 0 ? '' : '지수선물'].filter(Boolean)
        label = `${nameOf(parsed.code)} ${parsed.qty > 0 ? '+' : ''}${parsed.qty.toLocaleString()} @${parsed.price.toLocaleString()}${missing.length ? ` (${missing.join('·')} 미수신 — 진입 스냅샷 일부 없음)` : ''}`
      } else {
        res = await fetch(`${API}/hedge-fills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contract: parsed.contract, qty: parsed.qty, price: parsed.price }),
        })
        label = `${CONTRACT_LABEL[parsed.contract]} ${parsed.qty > 0 ? '+' : ''}${parsed.qty}계약 @${parsed.price.toLocaleString()}`
      }
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`)
      setInput('')
      setFeedback({ ok: true, msg: `체결 기록 — ${label}` })
      loadPositions()
      if (panel === 'fills') loadFills()
    } catch (e) {
      setFeedback({ ok: false, msg: `기록 실패: ${(e as Error).message.slice(0, 120)}` })
    } finally {
      setSubmitting(false)
    }
  }, [input, universe, submitting, nameOf, loadPositions, loadFills, panel])

  const deleteFill = useCallback(
    async (kind: 'etf' | 'hedge', id: number) => {
      const path = kind === 'etf' ? 'fills' : 'hedge-fills'
      try {
        const res = await fetch(`${API}/${path}/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setFeedback({ ok: true, msg: '체결 삭제됨' })
        loadFills()
        loadPositions()
      } catch (e) {
        setFeedback({ ok: false, msg: `삭제 실패: ${(e as Error).message}` })
      }
    },
    [loadFills, loadPositions],
  )

  /**
   * 파라미터 엑셀 내보내기 (§14.11) — 실집행은 LENS가 없는 **내부망**에서 하므로 β·호가 밴드
   * 같은 정적 파라미터만 엑셀로 반입하고, 체결·시세·선물가는 내부망 엑셀이 DDE로 받아
   * 워크북 수식이 헤지 계약수를 낸다. 화면 튜너(z·지평)를 그대로 실어 보내 파일의 x가
   * 지금 보고 있는 호가 밴드와 어긋나지 않게 한다.
   *
   * `window.open`이 아니라 fetch→blob인 이유: 캘리브가 없을 때 서버가 503을 주는데, 링크
   * 이동이면 데스크 화면이 JSON 오류 페이지로 통째로 날아간다. 실패는 헤더 배지로만 알린다.
   */
  const exportXlsx = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      const res = await fetch(`${API}/export.xlsx?z=${tuner.z}&horizon=${tuner.horizonSeconds}`)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        let msg = body || `HTTP ${res.status}`
        try { msg = (JSON.parse(body) as { detail?: string }).detail || msg } catch { /* JSON 아니면 원문 */ }
        throw new Error(msg)
      }
      const name =
        /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ??
        'lp_desk_params.xlsx'
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 즉시 revoke하면 브라우저가 다운로드를 시작하기 전에 blob이 사라질 수 있다.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      setFeedback({ ok: true, msg: `엑셀 내보냄 — ${name}` })
    } catch (e) {
      setFeedback({ ok: false, msg: `엑셀 내보내기 실패: ${(e as Error).message.slice(0, 160)}` })
    } finally {
      setExporting(false)
    }
  }, [exporting, tuner.z, tuner.horizonSeconds])

  return (
    <div className="flex flex-col bg-black">
      {/* ── 계기판 (sticky 헤더, §14.8) ── */}
      <div ref={headerRef} className="shrink-0 sticky top-0 z-30 bg-black">
        <div className="px-4 pt-3 pb-2 flex items-center gap-2.5 flex-wrap">
          <h1 className="text-[14px] text-white">LP 데스크</h1>

          {/* 지수선물 시세 */}
          <FutChip label="K200F" product="kospi200" futByProduct={futByProduct} multNote="승수 25만 · 참고" />
          <FutChip label="미니K200" product="mini_k200" futByProduct={futByProduct} multNote="승수 5만 · 집행" />
          <FutChip label="KQ150F" product="kosdaq150" futByProduct={futByProduct} multNote="승수 1만 · 집행" />

          {/* 총 미헤지 델타 신호등 */}
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md h-[28px] px-2.5 text-[11px]',
              desk.deltaTone === 'ok' ? 'bg-accent/15 text-accent'
                : desk.deltaTone === 'warn' ? 'bg-warning/15 text-warning'
                : desk.deltaTone === 'bad' ? 'bg-down/15 text-down'
                : 'bg-[#1e1e22] text-[#8b8b8e]',
            )}
            title={
              desk.unit > 0
                ? `미니K200 1계약 ≈ ${fmtWonAbs(desk.unit)} — 0.5계약 이내 정상 / 1.5계약 초과 위험`
                : '지수선물 시세 미수신 — 계약 환산 불가'
            }
          >
            <span className="opacity-70">미헤지 델타</span>
            <span className="tabular-nums font-medium">{fmtWon(desk.totalUnhedged)}</span>
            {desk.unit > 0 && (
              <span className="opacity-60 tabular-nums">
                ({(desk.totalUnhedged / desk.unit).toFixed(1)}계약)
              </span>
            )}
          </div>

          {/* 잔차 vs 한도 */}
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md h-[28px] px-2.5 text-[11px]',
              desk.residWon > tuner.residLimitWon ? 'bg-down/15 text-down' : 'bg-[#1e1e22] text-[#8b8b8e]',
            )}
            title="잔차(헤지불가) = Σ|포지션 평가액| × 잔차변동성. 지수 2팩터로 못 덮는 종목 고유 리스크(1일 1σ)"
          >
            <span className="opacity-70">잔차</span>
            <span className="tabular-nums text-white">{fmtWonAbs(desk.residWon)}</span>
            <span className="opacity-60">/ 한도</span>
            <NumInput
              value={tuner.residLimitWon / 1e8}
              step={0.5}
              width="w-9"
              suffix="억"
              onCommit={(v) => setTuner((p) => ({ ...p, residLimitWon: Math.max(0, v) * 1e8 }))}
            />
          </div>

          {/* P&L */}
          <div className="flex items-center gap-2 rounded-md h-[28px] px-2.5 text-[11px] bg-[#1e1e22]" title="헤지 후 손익 합계(포지션 edge × 평가액) / 헤지 선물 평가손익">
            <span className="text-[#8b8b8e]">헤지후</span>
            <span className={cn('tabular-nums', cV(desk.edgePnl))}>{fmtWon(desk.edgePnl)}</span>
            <span className="text-[#8b8b8e]">선물</span>
            <span className={cn('tabular-nums', desk.futPnlKnown ? cV(desk.futPnl) : 'text-[#5a5a5e]')}>
              {desk.futPnlKnown ? fmtWon(desk.futPnl) : '-'}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {/* 호가 z — 프리셋 세그먼트 + 자유 입력 (§14.5, 기본 1.5σ). 가장 자주 만지는 노브라 튜너 줄 앞머리에 둔다. */}
            <div
              className="flex items-center gap-1 rounded-md bg-[#1e1e22] p-0.5 h-[28px]"
              title={
                'x = μ_g ± z·σ결합 — z가 호가 폭. 기본 1.5σ\n' +
                'z를 올릴수록 유리하지만 덜 체결된다: 2σ는 실측 8거래일 중 매도측 도달 0일(사실상 체결 불가),\n' +
                '1.5σ가 "가끔·유리한 순간만" 잡히는 빈도였다 (2026-08-21 확정)\n' +
                '레벨별 실제 빈도는 x 컬럼의 "N일 중 M일 도달" 참조\n' +
                `프리셋 밖 값은 오른쪽 칸에 직접 입력 (${Z_MIN}~${Z_MAX})`
              }
            >
              <span className="pl-1.5 text-[10px] text-[#8b8b8e]">호가 z</span>
              {Z_PRESETS.map((z) => (
                <button
                  key={z}
                  onClick={() => setTuner((p) => ({ ...p, z }))}
                  className={cn(
                    'h-full px-2 rounded text-[11px] tabular-nums transition-colors',
                    tuner.z === z ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white',
                  )}
                >
                  {zLabel(z)}
                </button>
              ))}
              {/* 자유 입력 — 프리셋과 일치하면 위 버튼이 켜지고, 그 밖의 값이면 이 칸이 켜진다. */}
              <span className="text-[10px] text-[#5a5a5e]">|</span>
              <span className={cn('flex h-full items-center rounded pl-1 pr-1.5', !zIsPreset && 'bg-[#2e2e32]')}>
                <NumInput
                  value={tuner.z}
                  step={0.05}
                  width="w-9"
                  suffix="σ"
                  title={`프리셋 밖 값 직접 입력 (${Z_MIN}~${Z_MAX})`}
                  onCommit={(v) => {
                    const z = clampZ(v)
                    setTuner((p) => ({ ...p, z }))
                    return z
                  }}
                />
              </span>
            </div>

            {/* 호가 폭 튜너 (§14.5 4차 보완 + 5차 — 노브는 z와 지평 T) */}
            <div
              className="flex items-center gap-1.5 rounded-md h-[28px] px-2.5 bg-[#1e1e22] text-[10px] text-[#8b8b8e]"
              title={
                '매도 = iNAV × (1 + x매도) 5원 올림 / 매수 = iNAV × (1 + x매수) 5원 내림\n' +
                'x = μ_g ± z·σ결합 · σ결합 = √(σ괴리² + σ선물²)\n' +
                `  μ_g·σ괴리 = 최근 ${master?.calib_params?.calib_days ?? 10}거래일 30초봉 NAV 괴리 g의 평균·레벨 σ\n` +
                `  σ선물 = 선물 대비 스큐 s의 ${horizonLabel(tuner.horizonSeconds)} 변화 σ — 그 지평에서 **직접 측정**(√T 환산 폐기)\n` +
                `지평 T = 호가를 걸어 두는 시간. 늘릴수록 폭이 넓어지지만 √T 가정만큼은 아니다\n` +
                `z(호가 폭 배수)는 왼쪽 프리셋 토글·입력칸에서 — 현재 ${zLabel(tuner.z)}\n` +
                `g 표본 ${master?.calib_params?.g_window ?? '09:10~15:20'} (선물 불필요 — 하루 전체)`
              }
            >
              <span>지평</span>
              {QUOTE_HORIZON_OPTIONS.map((h) => (
                <button
                  key={h}
                  onClick={() => setTuner((p) => ({ ...p, horizonSeconds: h }))}
                  className={cn(
                    'rounded-sm px-1 tabular-nums transition-colors',
                    tuner.horizonSeconds === h ? 'bg-white/10 text-white' : 'hover:text-white',
                  )}
                >
                  {horizonLabel(h)}
                </button>
              ))}
              <span className="text-[#5a5a5e]">|</span>
              <span>청산≥</span>
              <NumInput value={tuner.exitBp} step={1} width="w-8" suffix="bp" onCommit={(v) => setTuner((p) => ({ ...p, exitBp: Math.max(0, v) }))} />
            </div>
            <HeaderButton
              onClick={exportXlsx}
              disabled={exporting}
              title={
                '내부망 반입용 파라미터 엑셀 (β·호가 밴드·전일종가·CU 36종 스냅샷)\n' +
                '실집행은 LENS가 없는 내부망에서 하므로, 체결·시세·선물가는 그쪽 엑셀이 DDE로 받고\n' +
                '이 파일의 수식이 K200/KQ150 노출 → 목표 계약수 → 집행할 계약까지 계산한다.\n' +
                `x는 지금 헤더 설정(z ${zLabel(tuner.z)} · 지평 ${horizonLabel(tuner.horizonSeconds)})으로 채워진다. 매크로 없음.`
              }
            >
              {exporting ? '내보내는 중…' : '엑셀 내보내기'}
            </HeaderButton>
            <HeaderButton active={panel === 'exit'} onClick={() => openPanel('exit')}>정리 미리보기</HeaderButton>
            <HeaderButton active={panel === 'fills'} onClick={() => openPanel('fills')}>체결 내역</HeaderButton>
            <HeaderButton onClick={() => { loadMaster(); loadPositions() }}>새로고침</HeaderButton>
          </div>
        </div>

        {/* 버킷 2줄 + 체결 입력 */}
        <div className="px-4 pb-2 flex items-start gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            {desk.buckets.map((b) => (
              <BucketLine key={b.id} bucket={b} />
            ))}
          </div>

          <div className="ml-auto flex flex-col items-end gap-1">
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitFill() }}
                placeholder="396500 +5000 @35565"
                spellCheck={false}
                title={'체결 원라인 입력\nETF: 코드 ±수량 @가격\n헤지: MK200 / KQ150F ±계약수 @가격'}
                className="w-[240px] rounded-md bg-[#1e1e22] h-[28px] px-3 text-[12px] text-white tabular-nums placeholder:text-[#4a4a4e] outline-none focus:ring-1 focus:ring-accent/40"
              />
              <button
                onClick={submitFill}
                disabled={submitting}
                className="h-[28px] rounded-md bg-[#1e1e22] px-3 text-[11px] text-[#d1d1d6] hover:bg-[#2e2e32] hover:text-white disabled:text-[#4a4a4e] transition-colors"
              >
                {submitting ? '기록 중…' : '체결 기록'}
              </button>
            </div>
            <div className="h-[14px] text-[10px] tabular-nums">
              {feedback ? (
                <span className={feedback.ok ? 'text-accent' : 'text-down'}>{feedback.msg}</span>
              ) : (
                <span className="text-[#4a4a4e]">
                  {master ? `통계 ${master.stats_date} · 회귀창 ${master.params?.window ?? '-'}일 · ${master.items.length}종 · 보유 ${positionCount}종` : ''}
                  {master && (master.calib_params
                    ? <span
                        className="ml-2"
                        title={
                          `세션 필터 ${master.calib_params.session} · 계산 ${master.calib_params.built_at.slice(11, 16)} (${(master.calib_params.elapsed_ms / 1000).toFixed(1)}초)\n` +
                          `g 표본 ${master.calib_params.g_window ?? '-'} — 호가 x의 원천. 선물이 필요 없어 하루 전체가 표본이다.\n` +
                          `s 표본 ${master.calib_params.s_window ?? '-'} — 지수선물 30초봉이 이 구간만 적재돼 있어서다(LS 500봉/일 상한).\n` +
                          '오전장 스큐(s)는 아직 표본에 없다 — 잔차 감각용 참고치로만 읽을 것. 호가는 무관.'
                        }
                      >
                        캘리브 {master.calib_params.as_of} · {master.calib_params.calib_days}일
                        {master.calib_params.g_window && (
                          <span className="text-[#3a3a3e]"> · g 표본 {master.calib_params.g_window}</span>
                        )}
                        {master.calib_params.s_window && (
                          <span className="text-[#3a3a3e]"> · s 표본 {master.calib_params.s_window}</span>
                        )}
                      </span>
                    : <span className="ml-2 text-warning">캘리브 없음 — 제안 호가 미산출</span>)}
                  {posErr && <span className="ml-2 text-down">포지션 조회 실패: {posErr}</span>}
                  {/* 이미 마스터가 있는데 재조회만 실패한 경우 — 표는 그대로 두고 배지로만 알린다. */}
                  {master && masterErr && <span className="ml-2 text-warning">통계 재조회 실패: {masterErr}</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── 확장 영역 (테이블 위, 상시 아님) ── */}
      {panel === 'exit' && (
        <ExitBasketPanel
          data={basket}
          loading={basketState.loading}
          error={basketState.error}
          onRefresh={loadBasket}
          onClose={() => setPanel('none')}
        />
      )}
      {panel === 'fills' && (
        <FillsPanel
          fills={fills}
          hedgeFills={hedgeFills}
          loading={fillsState.loading}
          error={fillsState.error}
          onDelete={deleteFill}
          onRefresh={loadFills}
          onClose={() => setPanel('none')}
          nameOf={nameOf}
        />
      )}

      {/* ── 테이블 (유일한 본문) ── */}
      <div className="px-2">
        <table className="w-max min-w-full border-collapse">
          <thead className="sticky z-20" style={{ top: headerH }}>
            <tr className="text-[10px] text-[#8b8b8e] bg-black">
              <Th sort={() => doSort('name')} active={sk === 'name'} asc={asc} left sticky className="pl-4 min-w-[168px]">ETF</Th>
              {/* ① 시세·호가 — 매도가 먼저, 매수가 나중 (단말 관행). iNAV는 제안 호가의 앵커라 바로 옆. */}
              <Th sort={() => doSort('price')} active={sk === 'price'} asc={asc} className="min-w-[74px]">현재가</Th>
              <Th
                sort={() => doSort('premiumBp')} active={sk === 'premiumBp'} asc={asc} className="min-w-[60px]"
                title={'실시간 괴리 g = (mid 또는 현재가 − iNAV)/iNAV.\n호가 x와 같은 자 — 이 값이 x에 다가서면 셀이 강조된다(체결 임박).'}
              >괴리bp</Th>
              <Th sort={() => doSort('nav')} active={sk === 'nav'} asc={asc} className="min-w-[74px]" title="실시간 iNAV — 제안 호가의 앵커 (§14.5 4차 정정)">iNAV</Th>
              {/* 제안 호가는 **가격 한 줄만** — x bp·틱 거리·분해는 셀 hover 툴팁으로 (§14.11) */}
              <Th sort={() => doSort('quoteAsk')} active={sk === 'quoteAsk'} asc={asc} className="min-w-[126px]" title="가격 + x bp(고정폭 슬롯 — 행 간 세로 정렬). iNAV × (1+x매도) 5원 올림. hover = 분해·도달 일수·시장 최우선매도 대비 틱 거리">제안매도</Th>
              <Th sort={() => doSort('quoteBid')} active={sk === 'quoteBid'} asc={asc} className="min-w-[126px]" title="가격 + x bp(고정폭 슬롯 — 행 간 세로 정렬). iNAV × (1+x매수) 5원 내림. hover = 분해·도달 일수·시장 최우선매수 대비 틱 거리">제안매수</Th>
              <Th className="min-w-[72px] border-l border-white/[0.06]">시장ask</Th>
              <Th className="min-w-[72px]">시장bid</Th>
              <Th sort={() => doSort('mktSpreadBp')} active={sk === 'mktSpreadBp'} asc={asc} className="min-w-[58px]">시장bp</Th>
              {/* ② 통계 근거 — x 분위수가 호가의 원천, β는 헤지의 원천 (§14.5) */}
              <Th sort={() => doSort('askBp')} active={sk === 'askBp'} asc={asc} className="min-w-[80px] border-l border-white/[0.06]" title={xHeaderTip(tuner.horizonSeconds)}>x매도</Th>
              <Th sort={() => doSort('bidBp')} active={sk === 'bidBp'} asc={asc} className="min-w-[80px]" title={xHeaderTip(tuner.horizonSeconds)}>x매수</Th>
              <Th
                sort={() => doSort('relBp')} active={sk === 'relBp'} asc={asc} className="min-w-[82px]"
                title={'오늘 s = ETF 등락률 − (β_K×K200F + β_Q×KQ150F).\n지수선물 헤지로 덮이지 않는 섹터 고유 움직임 = 잔차 리스크의 크기.\n호가와는 무관 (4차 정정).'}
              >선물대비</Th>
              <Th sort={() => doSort('betaK')} active={sk === 'betaK'} asc={asc} className="min-w-[54px]">β_K</Th>
              <Th sort={() => doSort('betaQ')} active={sk === 'betaQ'} asc={asc} className="min-w-[54px]">β_Q</Th>
              <Th sort={() => doSort('r2')} active={sk === 'r2'} asc={asc} className="min-w-[46px]">R²</Th>
              {/* ③ 포지션 */}
              <Th sort={() => doSort('qty')} active={sk === 'qty'} asc={asc} className="min-w-[86px] border-l border-white/[0.06]">수량</Th>
              <Th
                sort={() => doSort('onCapWon')} active={sk === 'onCapWon'} asc={asc} className="min-w-[92px]"
                title={
                  '오버나이트로 넘길 수 있는 평가액 상한 (§14.12).\n' +
                  `${onRule.tailLossWon != null ? `${onRule.tailLossWon.toLocaleString()}원` : '허용 꼬리손실'} ÷ (${onRule.z ?? 'z'} × 잔차σ) — 1박 5% 꼬리손실이 그 금액을 넘지 않는 크기.\n` +
                  (onRule.maxResidVolBp != null && onRule.minObs != null
                    ? `잔차σ > ${onRule.maxResidVolBp}bp(또는 회귀 표본 ${onRule.minObs} 미만)는 "—" = 금지 — 당일 정리한다.\n`
                    : '잔차σ가 큰 종목(또는 신규상장)은 "—" = 금지 — 당일 정리한다.\n') +
                  '현재 평가액이 상한을 넘으면 경고 톤 — 14:30 전에 초과분을 줄인다.'
                }
              >O/N 상한</Th>
              <Th sort={() => doSort('improveBp')} active={sk === 'improveBp'} asc={asc} className="min-w-[80px]">진입→현재</Th>
              <Th sort={() => doSort('edgeBp')} active={sk === 'edgeBp'} asc={asc} className="min-w-[62px]">edge bp</Th>
              <Th sort={() => doSort('pnl')} active={sk === 'pnl'} asc={asc} className="min-w-[78px]">헤지PnL</Th>
              <Th className="min-w-[56px] pr-4">신호</Th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={COLS} className="px-4 py-8 text-center text-[12px] text-[#8b8b8e]">마스터 로딩 중…</td></tr>
            )}
            {!loading && masterErr && !master && (
              <tr>
                <td colSpan={COLS} className="px-4 py-8 text-center text-[12px] text-down">
                  마스터 조회 실패: {masterErr}
                  <button onClick={loadMaster} className="ml-3 rounded bg-[#1e1e22] px-2.5 py-1 text-[11px] text-[#d1d1d6] hover:bg-[#2e2e32]">재시도</button>
                </td>
              </tr>
            )}
            {!loading && master && sorted.length === 0 && (
              <tr><td colSpan={COLS} className="px-4 py-8 text-center text-[12px] text-[#8b8b8e]">유니버스가 비어 있습니다.</td></tr>
            )}
            {sorted.map((r) => (
              <Fragment key={r.code}>
                <tr
                  onClick={() => toggleExpand(r.code)}
                  className="border-b border-white/[0.04] bg-black hover:bg-[#1d1d1d] transition-colors cursor-pointer"
                >
                  <td className="pl-4 pr-3 py-[9px] sticky left-0 z-10" style={{ backgroundColor: 'inherit' }} title="클릭 — NAV 괴리 g 분포(호가 근거) / rolling β / 선물 대비 s / PDF 상위">
                    <div className={cn('text-[11px] leading-none truncate max-w-[220px]', expanded === r.code ? 'text-accent' : 'text-white')}>
                      {expanded === r.code ? '▾ ' : ''}{r.name}
                    </div>
                    <div className="text-[9px] text-[#5a5a5e] leading-none mt-[2px] tabular-nums">{r.code}</div>
                  </td>
                  {/* ① 시세·호가 */}
                  <PriceCell value={r.price} changePct={r.changePct} note={r.prevCloseNote} />
                  {/* 괴리bp = 실시간 g. **호가와 같은 자**라 x에 다가서면 여기가 강조된다 (§14.5 4차). */}
                  <td
                    className={cn(
                      'px-2 py-[9px] text-right text-[11px] tabular-nums whitespace-nowrap',
                      r.near === 'ask' ? 'bg-[#bb4a65]/15' : r.near === 'bid' ? 'bg-[#00b26b]/15' : '',
                    )}
                    title={
                      r.premiumBp == null
                        ? 'iNAV/현재가 미수신 — 괴리 산출 불가'
                        : `실시간 괴리 g = (${r.mid > 0 ? 'mid' : '현재가'} − iNAV)/iNAV = ${fmtSignedBp(r.premiumBp)}bp\n` +
                          `x매도 ${r.askBp != null ? fmtSignedBp(r.askBp) : '-'} / x매수 ${r.bidBp != null ? fmtSignedBp(r.bidBp) : '-'}bp (μ_g ± ${tuner.z}σ결합)` +
                          (r.near ? `\n→ ${r.near === 'ask' ? '매도' : '매수'} 체결 임박 (x까지 |x|의 ${Math.round(NEAR_MARGIN_RATIO * 100)}% 이내)` : '')
                    }
                  >
                    <span className={r.premiumBp == null ? 'text-[#5a5a5e]' : cV(r.premiumBp)}>{fmtBp(r.premiumBp)}</span>
                  </td>
                  <C c="text-[#d1d1d6]">{r.nav > 0 ? fmtNum(r.nav, 1) : '-'}</C>
                  <QuoteCell
                    price={r.quoteAsk} side="ask" anchor={r.anchor} xBp={r.askBp}
                    breakdown={xBreakdown(r, tuner.z)} excludedLegs={r.calib?.excluded_legs ?? 0}
                    touchDays={r.touchDaysAsk} calibDays={r.touchTotalDays}
                    ticksOut={r.ticksOutAsk} reason={r.quoteAskReason}
                  />
                  <QuoteCell
                    price={r.quoteBid} side="bid" anchor={r.anchor} xBp={r.bidBp}
                    breakdown={xBreakdown(r, tuner.z)} excludedLegs={r.calib?.excluded_legs ?? 0}
                    touchDays={r.touchDaysBid} calibDays={r.touchTotalDays}
                    ticksOut={r.ticksOutBid} reason={r.quoteBidReason}
                  />
                  <C c="text-[#d1d1d6]" className="border-l border-white/[0.04]">{r.ask1 > 0 ? r.ask1.toLocaleString() : '-'}</C>
                  <C c="text-[#d1d1d6]">{r.bid1 > 0 ? r.bid1.toLocaleString() : '-'}</C>
                  <C c="text-[#8b8b8e]">{r.mktSpreadBp != null ? r.mktSpreadBp.toFixed(1) : '-'}</C>
                  {/* ② 통계 근거 — x(호가의 원천 = μ_g ± zσ결합) → 오늘 s(잔차 감각) → β (헤지의 원천) */}
                  <XCell
                    bp={r.askBp} side="ask" z={tuner.z} breakdown={xBreakdown(r, tuner.z)} degraded={r.sigmaDegraded}
                    excludedLegs={r.calib?.excluded_legs ?? 0}
                    touchDays={r.touchDaysAsk} calibDays={r.touchTotalDays} className="border-l border-white/[0.04]"
                  />
                  <XCell
                    bp={r.bidBp} side="bid" z={tuner.z} breakdown={xBreakdown(r, tuner.z)} degraded={r.sigmaDegraded}
                    excludedLegs={r.calib?.excluded_legs ?? 0}
                    touchDays={r.touchDaysBid} calibDays={r.touchTotalDays}
                  />
                  {/* 오늘 s — 지수선물로 안 덮이는 오늘의 섹터 고유 움직임 = 헤지 잔차 (호가와 무관) */}
                  <C
                    c={r.relBp == null ? 'text-[#3a3a3e]' : cV(r.relBp)}
                    title={
                      r.relBp == null
                        ? (r.insufficient ? '회귀 표본 부족 — β 없어 s 산출 불가' : '전일종가/지수선물 미수신 — s 산출 불가')
                        : `오늘 s = ETF ${r.changePct != null ? fmtSignedBp(r.changePct, 2) : '-'}% − (β_K×K200F + β_Q×KQ150F) = ${fmtSignedBp(r.relBp)}bp\n` +
                          '지수선물 헤지로 덮이지 않는 오늘의 섹터 고유 움직임 = 잔차 리스크의 크기.\n' +
                          `이 **레벨**은 호가 위치와 무관하다 — 호가에 들어가는 건 s의 ${horizonLabel(r.horizonSeconds)} 변화 σ뿐 (§14.5).` +
                          (r.calib?.s_quantiles
                            ? `\n최근 ${r.calib.days}일 s 분포 ${S_REF_BID}/${S_REF_ASK} = ${fmtBp(r.calib.s_quantiles[S_REF_BID] ?? null)} / ${fmtBp(r.calib.s_quantiles[S_REF_ASK] ?? null)}bp`
                            : '') +
                          (r.sigmaRBp != null
                            ? `\n호가에 실린 σ선물(${horizonLabel(r.horizonSeconds)}) = ${r.sigmaRBp.toFixed(1)}bp` +
                              (r.calib?.s_inc_sigma_bp != null ? ` (참고: 30초 증분 σ ${r.calib.s_inc_sigma_bp.toFixed(1)}bp)` : '')
                            : '')
                    }
                  >
                    {r.relBp == null ? '—' : fmtBp(r.relBp)}
                  </C>
                  {r.insufficient ? (
                    <td colSpan={3} className="px-2 py-[9px] text-center text-[10px] text-[#5a5a5e]" title="회귀 표본 부족 — β·헤지 환산 불가">
                      회귀 표본부족
                    </td>
                  ) : (
                    <>
                      <C c="text-white">{fmtNum(r.betaK, 3)}</C>
                      <C c="text-white">{fmtNum(r.betaQ, 3)}</C>
                      <C
                        c={(r.r2 ?? 0) >= 0.7 ? 'text-[#d1d1d6]' : 'text-warning'}
                        title={`잔차vol ${r.residVol != null ? `${r.residVol.toFixed(1)}bp` : '-'} · 최근 잔차z ${r.residZ != null ? r.residZ.toFixed(2) : '-'}`}
                      >
                        {r.r2 != null ? r.r2.toFixed(2) : '-'}
                      </C>
                    </>
                  )}
                  {/* ③ 포지션 — 수량 셀에 평가액을 겹쳐 담아 컬럼 수를 늘리지 않는다 */}
                  <QtyCell qty={r.qty} value={r.value} />
                  <OvernightCell
                    capWon={r.onCapWon} banned={r.onBanned} residVolBp={r.residVol} obs={r.obs}
                    positionValue={r.value} rule={onRule}
                  />
                  <C c="text-[#8b8b8e]" title="진입 시점 괴리 → 현재 괴리 (보조 지표 — 청산 판정은 edge)">
                    {r.qty === 0 || r.entryGapBp == null ? '-' : (
                      <>
                        <span className="text-[#8b8b8e]">{r.entryGapBp.toFixed(1)}</span>
                        <span className="text-[#3a3a3e]"> → </span>
                        <span className={cV(r.premiumBp ?? 0)}>{r.premiumBp != null ? r.premiumBp.toFixed(1) : '-'}</span>
                      </>
                    )}
                  </C>
                  <C
                    c={r.edgeBp == null ? 'text-[#3a3a3e]' : cV(r.edgeBp)}
                    title={r.edgeBp == null ? (r.edgeNote || undefined) : 'ETF 수익률 − β_K×K200선물 − β_Q×KQ150선물 (진입 대비)'}
                  >
                    {r.edgeBp == null ? '—' : fmtBp(r.edgeBp)}
                  </C>
                  <C c={r.pnl == null ? 'text-[#3a3a3e]' : cV(r.pnl)} title="헤지 후 손익 = edge × |평가액|">
                    {r.pnl == null ? '-' : fmtWon(r.pnl)}
                  </C>
                  <td className="px-2 py-[9px] text-right pr-4">
                    {r.edgeBp != null && r.edgeBp >= tuner.exitBp ? (
                      <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent" title={`헤지 상대성과 ${r.edgeBp.toFixed(1)}bp ≥ ${tuner.exitBp}bp`}>
                        청산
                      </span>
                    ) : (
                      <span className="text-[10px] text-[#3a3a3e]">-</span>
                    )}
                  </td>
                </tr>
                {expanded === r.code && (
                  <tr className="bg-bg-base">
                    <td colSpan={COLS} className="p-0">
                      <LpDeskDetailPanel
                        etfCode={r.code}
                        name={r.name}
                        detail={details[r.code] ?? null}
                        loading={detailLoadingCode === r.code && !details[r.code]}
                        error={details[r.code] ? '' : (detailErrors[r.code] ?? '')}
                        residVolBp={r.residVol}
                        residZ={r.residZ}
                        gapMeanBp={r.gapMeanBp}
                        gapSigmaBp={r.gapSigmaBp}
                        gapObs={r.gapObs}
                        xBidBp={r.bidBp}
                        xAskBp={r.askBp}
                        z={tuner.z}
                        xBreakdown={xBreakdown(r, tuner.z)}
                        touchDaysBid={r.touchDaysBid}
                        touchDaysAsk={r.touchDaysAsk}
                        touchTotalDays={r.touchTotalDays}
                        gNowBp={r.premiumBp}
                        sNowBp={r.relBp}
                        calib={r.calib}
                        statsWindow={master?.params?.window ?? 0}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── 헤더 조각 ──────────────────────────────────────────────────────────────

function FutChip({
  label,
  product,
  futByProduct,
  multNote,
}: {
  label: string
  product: IndexFuturesProduct
  futByProduct: Map<IndexFuturesProduct, FutQuote>
  multNote: string
}) {
  const f = futByProduct.get(product)
  return (
    <div
      className="flex items-center gap-1.5 rounded-md h-[28px] px-2.5 bg-[#1e1e22] text-[11px]"
      title={`${f?.code ?? '월물 미해석'} · ${multNote}`}
    >
      <span className="text-[#8b8b8e]">{label}</span>
      <span className="text-white tabular-nums">{f && f.price > 0 ? f.price.toFixed(2) : '-'}</span>
      {f && f.price > 0 && (
        <span className={cn('tabular-nums text-[10px]', cV(f.changePct))}>
          {f.changePct > 0 ? '+' : ''}{f.changePct.toFixed(2)}%
        </span>
      )}
    </div>
  )
}

type Bucket = {
  id: BucketId
  label: string
  contract: HedgeContract
  futPrice: number
  contractValue: number
  exposure: number
  held: number
  target: number
  action: number
  unhedged: number
}

/** 버킷 한 줄 — "K200 노출 +1.4억 → 미니K200 12계약 매도 (보유 −9 / 목표 −21)". */
function BucketLine({ bucket: b }: { bucket: Bucket }) {
  const hasFut = b.futPrice > 0
  const actionAbs = Math.abs(b.action)
  return (
    <div className="flex items-center gap-2 text-[11px] tabular-nums">
      <span className="w-[42px] shrink-0 text-[#8b8b8e]">{b.label}</span>
      <span className="text-[#8b8b8e]">노출</span>
      <span className={cn('w-[64px] text-right', cV(b.exposure))}>{fmtWon(b.exposure)}</span>
      <span className="text-[#3a3a3e]">→</span>
      {!hasFut ? (
        <span className="text-warning">선물 시세 미수신 — 계약 환산 불가</span>
      ) : actionAbs === 0 ? (
        <span className="rounded-sm bg-[#1e1e22] px-1.5 py-0.5 text-[#8b8b8e]">
          {CONTRACT_LABEL[b.contract]} 조치 없음
        </span>
      ) : (
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 font-medium',
            b.action > 0 ? cn('bg-[#00b26b]/15', LP_UP) : cn('bg-[#bb4a65]/15', LP_DOWN),
          )}
        >
          {CONTRACT_LABEL[b.contract]} {actionAbs.toLocaleString()}계약 {b.action > 0 ? '매수' : '매도'}
        </span>
      )}
      <span className="text-[#5a5a5e]">
        (보유 {fmtSigned(b.held)} / 목표 {hasFut ? fmtSigned(b.target) : '-'})
      </span>
      <span className="text-[#8b8b8e]">미헤지</span>
      <span className={cn(cV(b.unhedged))}>{fmtWon(b.unhedged)}</span>
    </div>
  )
}

function HeaderButton({
  children,
  onClick,
  active,
  title,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
  title?: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        'h-[28px] rounded-md px-3 text-[11px] transition-colors',
        active ? 'bg-accent/15 text-accent' : 'bg-[#1e1e22] text-[#8b8b8e] hover:bg-[#2e2e32] hover:text-white',
        disabled && 'text-[#4a4a4e] hover:bg-[#1e1e22] hover:text-[#4a4a4e]',
      )}
    >
      {children}
    </button>
  )
}

/**
 * 헤더 튜너용 숫자 입력 — blur/Enter에 커밋, 잘못된 값은 되돌린다.
 * `onCommit`이 실제 적용된 값을 돌려주면 칸도 그 값으로 맞춘다 — 클램프에 걸려 상태가 안
 * 바뀌는 입력(예: z가 이미 4인데 9 입력)에서 칸만 거짓 값을 들고 있는 상태를 막는다.
 */
function NumInput({
  value,
  step,
  width,
  suffix,
  title,
  onCommit,
}: {
  value: number
  step: number
  width: string
  suffix?: string
  title?: string
  onCommit: (v: number) => number | void
}) {
  const [draft, setDraft] = useState(String(value))
  // 외부에서 값이 바뀌면(클램프·다른 탭 복원) 렌더 중 동기화 — effect setState 캐스케이드 회피.
  const [lastValue, setLastValue] = useState(value)
  if (lastValue !== value) {
    setLastValue(value)
    setDraft(String(value))
  }
  const commit = () => {
    const n = parseFloat(draft)
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const applied = onCommit(n)
    if (typeof applied === 'number') {
      setLastValue(applied)
      setDraft(String(applied))
    }
  }
  return (
    <span className="flex items-baseline" title={title}>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'bg-transparent text-[11px] text-white tabular-nums outline-none text-right',
          '[appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden',
          width,
        )}
      />
      {suffix && <span className="text-[10px] text-[#8b8b8e]">{suffix}</span>}
    </span>
  )
}

// ── 테이블 조각 ────────────────────────────────────────────────────────────

function Th({
  children, className, title, sort, active, asc, left, sticky,
}: {
  children?: React.ReactNode
  className?: string
  title?: string
  sort?: () => void
  active?: boolean
  asc?: boolean
  left?: boolean
  sticky?: boolean
}) {
  return (
    <th
      title={title}
      className={cn(
        'px-2 py-[9px] font-normal whitespace-nowrap border-b border-white/[0.06]',
        left ? 'text-left' : 'text-right',
        sort ? 'cursor-pointer select-none hover:text-white transition-colors' : '',
        active ? 'text-white' : '',
        sticky && 'sticky left-0 bg-black z-30',
        className,
      )}
      onClick={sort}
    >
      {children}
      {active && <span className="ml-1 text-[9px] opacity-50">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}

/**
 * 숫자 셀 한 칸. 본문 **1차 숫자는 전부 12px 한 사이즈**로 통일한다 (사용자 요구 2026-08-26 —
 * 셀마다 11/12px이 섞여 크기가 들쭉날쭉했다). 셀 안 2차 보조줄(도달 일수·평가액 등)만 9px로 남긴다.
 */
function C({
  children, c, className, title,
}: {
  children: React.ReactNode
  c?: string
  className?: string
  title?: string
}) {
  return (
    <td
      title={title}
      className={cn('px-2 py-[9px] text-right text-[11px] tabular-nums whitespace-nowrap', c || 'text-white', className)}
    >
      {children}
    </td>
  )
}

/**
 * 현재가 + 등락률 2줄 셀. 등락률 null = **전일종가 미수신**이라 "—"로 둔다 —
 * 0으로 눌러 "+0.00%"를 찍으면 보합과 구분이 안 된다 (§14.11).
 */
function PriceCell({
  value, changePct, note,
}: {
  value: number
  changePct: number | null
  /** 전일종가 신선도 경고 등 — 등락률이 나와도 믿을 값이 아닐 때. */
  note?: string
}) {
  const stale = !!note && changePct != null
  return (
    <td
      className="px-2 py-[9px] text-right whitespace-nowrap"
      title={changePct == null ? '등락률 산출 불가 — 전일종가/현재가 미수신' : (note || undefined)}
    >
      <div className="text-[11px] text-white tabular-nums leading-none">{value > 0 ? value.toLocaleString() : '-'}</div>
      <div className={cn('text-[9px] tabular-nums leading-none mt-[2px]', changePct == null ? 'text-[#3a3a3e]' : stale ? 'text-warning' : cV(changePct))}>
        {changePct == null ? '—' : `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`}
      </div>
    </td>
  )
}

/**
 * 제안 호가 셀 — **가격 한 줄뿐**. 보조줄(x bp · 시장 최우선호가 대비 틱)은 폐지하고 x 분해·
 * 도달 일수와 함께 hover 툴팁으로 통합했다 (사용자 요구 2026-08-26). 실제로 주문에 찍는 건
 * 가격이고, 틱 거리는 "왜 저 가격인가"를 확인할 때만 필요하다.
 * 산출 불가면 사유를 툴팁에 싣고 "—"를 경고 톤으로 (대체값은 절대 만들지 않는다).
 */
function QuoteCell({
  price, side, anchor, xBp, breakdown, excludedLegs, touchDays, calibDays, ticksOut, reason,
}: {
  price: number | null
  side: 'bid' | 'ask'
  /** 호가 앵커 = iNAV (§14.5 4차 정정). */
  anchor: number | null
  xBp: number | null
  /** x 분해 한 줄 (`μ … · σ괴리 … · σ선물 … → ±zσ`). */
  breakdown: string
  /** 재구성에서 뺀 레그 수 (0이면 표기 없음, §14.3). */
  excludedLegs: number
  touchDays: number | null
  calibDays: number | null
  /** 시장 최우선호가 대비 틱 거리 (양수 = 시장 밖). 호가 미수신이면 null. */
  ticksOut: number | null
  reason: string
}) {
  const label = side === 'ask' ? '매도' : '매수'
  const mktLabel = side === 'ask' ? '최우선매도' : '최우선매수'
  return (
    <td
      className="px-2 py-[9px] text-right whitespace-nowrap"
      title={
        price == null
          ? `제안 ${label} 산출 불가 — ${reason || '데이터 부족'}`
          : // 보조줄을 없앴으므로 셀 밖에서 보이던 x bp를 툴팁 첫 줄에 올려 hover 한 번으로 끝낸다.
            `제안${label} ${price.toLocaleString()} · x ${xBp != null ? fmtSignedBp(xBp) : '-'}bp\n` +
            `iNAV ${anchor != null ? anchor.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '-'} × (1 ${fmtSignedBp(xBp ?? 0)}bp) → 5원 ${side === 'ask' ? '올림' : '내림'}\n` +
            `x = ${breakdown}` +
            (touchDays != null ? `\n도달 ${calibDays ?? '-'}일 중 ${touchDays}일 (장중 g가 이 레벨을 넘은 날)` : '') +
            (ticksOut != null
              ? `\n시장 ${mktLabel} 대비 ${fmtSigned(ticksOut)}틱 (양수 = 시장 밖에서 대기 / 음수 = 안쪽)`
              : '\n시장 호가 미수신 — 틱 거리 산출 불가') +
            excludedLegsNote(excludedLegs)
      }
    >
      {/*
        가격 + x bp를 같은 12px로 나란히 두되, bp는 **고정폭 슬롯**에 우측정렬로 넣는다
        (사용자 요구 2026-08-26). 셀이 우측정렬이라 슬롯의 오른쪽 끝이 모든 행에서 같은 x가 되고,
        따라서 bp 열도 가격 오른쪽 끝도 행 사이에 딱 맞춰진다 — 가격과 bp가 섞여 보이지 않는다.
        산출 불가("—") 행도 빈 슬롯을 그대로 둬 정렬이 흐트러지지 않게 한다.
      */}
      <div className="text-[11px] tabular-nums leading-none">
        {price == null ? (
          <span className="text-warning">—</span>
        ) : (
          <span className={side === 'ask' ? LP_DOWN : LP_UP}>{price.toLocaleString()}</span>
        )}
        <span className="inline-block w-[60px] text-right text-t2">
          {price != null && xBp != null ? `${fmtSignedBp(xBp)}bp` : ''}
        </span>
      </div>
    </td>
  )
}

/**
 * x 셀 — bp(위) + 도달 일수(아래, 회색 소자). 파란 글씨 금지 (§14.8 가독성).
 * x는 μ_g ± z·σ결합이므로 툴팁에 **분해**를 싣는다 — 폭이 왜 이만큼인지가 곧 근거다.
 */
function XCell({
  bp, side, z, breakdown, degraded, excludedLegs, touchDays, calibDays, className,
}: {
  bp: number | null
  side: 'bid' | 'ask'
  z: number
  /** x 분해 한 줄 (`μ … · σ괴리 … · σ선물 … → ±zσ`). */
  breakdown: string
  /** σ선물 없음 → σ괴리만으로 좁힌 상태 (선물 30초봉 부재). */
  degraded: boolean
  /** 재구성에서 뺀 레그 수 (0이면 표기 없음, §14.3). */
  excludedLegs: number
  /** 창 `calibDays`(= g 일별 극값 일수)일 중 이 레벨이 한 번이라도 열린 날 수 (단조, §14.11). */
  touchDays: number | null
  calibDays: number | null
  className?: string
}) {
  const sign = side === 'ask' ? '+' : '−'
  return (
    <td
      className={cn('px-2 py-[9px] text-right whitespace-nowrap', className)}
      title={
        bp == null
          ? '캘리브 표본 부족 — g μ·σ 없음'
          : `x${side === 'ask' ? '매도' : '매수'} = ${fmtSignedBp(bp)}bp (iNAV 대비, 최근 ${calibDays ?? '-'}거래일 30초봉)\n` +
            `${breakdown}\n` +
            `도달 ${calibDays ?? '-'}일 중 ${touchDays ?? '-'}일 — 장중 g가 이 레벨을 한 번이라도 넘은 날` +
            (degraded ? '\n⚠️ 선물 30초봉 없음 — σ선물 제외(σ괴리만)로 폭이 좁다' : '') +
            excludedLegsNote(excludedLegs)
      }
    >
      <div className={cn('text-[11px] tabular-nums leading-none', bp == null ? 'text-[#3a3a3e]' : degraded ? 'text-warning' : 'text-[#d1d1d6]')}>
        {bp == null ? '—' : fmtSignedBp(bp)}
      </div>
      <div className="text-[9px] tabular-nums leading-none mt-[2px] text-[#5a5a5e]">
        {touchDays != null && calibDays != null ? `${calibDays}일 중 ${touchDays}일` : `${sign}${z}σ`}
      </div>
    </td>
  )
}

/** 수량 + 평가액 2줄 셀 (§14.8 포지션 그룹을 5칸으로 유지하면서 금액도 남긴다). */
function QtyCell({ qty, value }: { qty: number; value: number }) {
  if (qty === 0) {
    return <td className="px-2 py-[9px] text-right text-[11px] tabular-nums text-[#3a3a3e] border-l border-white/[0.04]">-</td>
  }
  return (
    <td className="px-2 py-[9px] text-right whitespace-nowrap border-l border-white/[0.04]">
      <div className={cn('text-[11px] tabular-nums leading-none', qty > 0 ? LP_UP : LP_DOWN)}>
        {qty > 0 ? '+' : ''}{qty.toLocaleString()}
      </div>
      <div className="text-[9px] tabular-nums leading-none mt-[2px] text-[#8b8b8e]">{fmtWon(value)}</div>
    </td>
  )
}

/**
 * O/N 상한 셀 (§14.12) — 이 종목을 밤 넘겨 들고 갈 수 있는 평가액.
 *
 * 상한은 잔차σ만의 함수라 **포지션이 없어도 미리 보인다**(체결 전에 "여긴 얼마까지"를 알아야
 * 한다). 판단이 필요한 순간은 하나뿐 — **현재 평가액이 상한을 넘었을 때**. 그때만 경고 톤 +
 * 초과분을 둘째 줄에 찍는다(= 14:30 전에 줄일 금액). 롱·숏 모두 1박 리스크는 |평가액|이라
 * 부호는 보지 않는다 (§14.4 잔차 합산과 같은 규약).
 */
function OvernightCell({
  capWon, banned, residVolBp, obs, positionValue, rule,
}: {
  /** 상한(₩). 금지 = 0, 회귀 표본 부족 = null (금지와 다른 상태). */
  capWon: number | null
  banned: boolean
  residVolBp: number | null
  obs: number | null
  /** 현재 포지션 평가액 (부호 포함 — 여기서 절댓값을 취한다). */
  positionValue: number
  rule: OvernightRule
}) {
  const exposure = Math.abs(positionValue)
  const over = capWon != null && exposure > capWon ? exposure - capWon : 0
  const sigma = residVolBp != null ? `${residVolBp.toFixed(0)}bp` : '-'
  const overNote = over > 0
    ? `\n현재 ${fmtWonAbs(exposure)} — 초과 ${fmtWonAbs(over)}: 14:30 전에 초과분을 정리한다.`
    : ''

  let title: string
  if (capWon == null) {
    title = '회귀 표본 부족 — 잔차σ가 없어 O/N 상한 산출 불가.'
  } else if (banned) {
    const why = rule.minObs != null && obs != null && obs < rule.minObs
      ? `회귀 표본 ${obs} < ${rule.minObs} (신규상장) — 잔차σ를 믿을 수 없다`
      : `잔차 σ ${sigma}${rule.maxResidVolBp != null ? ` > ${rule.maxResidVolBp}bp` : ' 한도 초과'}`
    title =
      `${why} — 오버나이트 금지.\n` +
      '1박 잔차 꼬리가 허용 손실을 넘는다. 저잔차 지수형만 오버나이트 가치가 있다는 백테스트 결론(§14.12).' +
      overNote
  } else {
    const formula = rule.tailLossWon != null && rule.z != null
      ? ` = ${rule.tailLossWon.toLocaleString()} ÷ (${rule.z} × 잔차σ ${sigma})`
      : ` (잔차σ ${sigma})`
    title =
      `O/N 상한 ${capWon.toLocaleString()}원${formula}\n` +
      '1박 5% 꼬리손실 기준 — 이 금액까지만 밤을 넘긴다 (백만 내림).' +
      overNote
  }

  return (
    <td
      title={title}
      className={cn('px-2 py-[9px] text-right whitespace-nowrap', over > 0 && 'bg-warning/10')}
    >
      <div
        className={cn(
          'text-[11px] tabular-nums leading-none',
          over > 0 ? 'text-warning' : capWon == null || banned ? 'text-t4' : 'text-[#d1d1d6]',
        )}
      >
        {capWon == null || banned ? '—' : fmtWonAbs(capWon)}
      </div>
      {over > 0 && (
        <div className="text-[9px] tabular-nums leading-none mt-[2px] text-warning">초과 {fmtWonAbs(over)}</div>
      )}
    </td>
  )
}

// ── 포맷 ──────────────────────────────────────────────────────────────────

function fmtBp(v: number | null) {
  return v == null ? '-' : fmtSignedBp(v)
}

/** 객체에서 키 하나 제거 (없으면 원본 그대로 — 불필요한 identity 변경 방지). */
function dropKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj
  const next = { ...obj }
  delete next[key]
  return next
}

function fmtNum(v: number | null, digits: number) {
  if (v == null) return '-'
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function fmtSigned(v: number) {
  return `${v > 0 ? '+' : ''}${v.toLocaleString()}`
}

/** 배열 응답이 `[...]` / `{items:[...]}` / `{fills:[...]}` 어느 쪽이든 받는다. */
function asList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[]
  const r = (raw ?? {}) as Record<string, unknown>
  const v = r.items ?? r[key]
  return Array.isArray(v) ? (v as T[]) : []
}
