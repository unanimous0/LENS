import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { useMarketStore } from '@/stores/marketStore'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import { usePageInavSubscriptions } from '@/hooks/usePageInavSubscriptions'
import { usePageOrderbookBulk } from '@/hooks/usePageOrderbookBulk'

const HISTORY_INTERVAL_MS = 5000  // 5초 간격
const HISTORY_MAX_POINTS = 120    // 10분치
const TOP_N_CHART = 7

type EtfMaster = {
  code: string
  name: string
  cu_unit: number
  group: string | null
  lp: string | null
}

type PdfStock = { code: string; name: string; qty: number }
type EtfPdf = {
  code: string
  name: string
  cu_unit: number
  as_of: string
  cash: number
  stocks: PdfStock[]
}

type FuturesItem = {
  base_code: string
  base_name: string
  market: string
  front: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
  back?: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
}

type FuturesMaster = { items: FuturesItem[] }

type ArbMode = 'buy' | 'sell' | 'mixed'

/** 한 ETF의 metric을 계산. excluded 토글이 한 ETF만 영향이라 per-ETF 함수로 분리 →
 * base(공통) + overlay(excluded 적용) 두 useMemo가 같은 로직 공유. */
function computeMetric(
  code: string,
  pdf: EtfPdf,
  exSet: Set<string> | undefined,
  stockTicks: Record<string, import('@/types/market').StockTick>,
  futuresTicks: Record<string, import('@/types/market').FuturesTick>,
  etfTicks: Record<string, import('@/types/market').ETFTick>,
  orderbookTicks: Record<string, import('@/types/market').OrderbookTick>,
  futuresByBase: Map<string, FuturesItem>,
  minFuturesVolume: number,
  arbMode: ArbMode,
): EtfMetrics {
  const cuUnit = pdf.cu_unit ?? 0
  const nav = etfTicks[code]?.nav ?? 0
  const cuValue = nav > 0 && cuUnit > 0 ? nav * cuUnit : 0

  let appliedFutValue = 0
  let buyFutSum = 0
  let sellFutSum = 0
  let futuresCount = 0

  for (const s of pdf.stocks) {
    if (s.qty <= 0) continue
    if (exSet?.has(s.code)) continue
    const spot = stockTicks[s.code]?.price ?? 0
    if (spot <= 0) continue
    const fm = futuresByBase.get(s.code)
    if (!fm?.front?.code) continue
    const futTick = futuresTicks[fm.front.code]
    const fut = futTick?.price ?? 0
    if (fut <= 0) continue
    if (futTick && minFuturesVolume > 0 && (futTick.volume ?? 0) < minFuturesVolume) continue

    const isContango = fut > spot
    const isBackward = fut < spot
    if (arbMode === 'buy' && !isContango) continue
    if (arbMode === 'sell' && !isBackward) continue

    futuresCount += 1
    appliedFutValue += s.qty * spot
    if (isContango) buyFutSum += s.qty * (fut - spot)
    if (isBackward) sellFutSum += s.qty * (spot - fut)
  }

  const futuresBuyBp = cuValue > 0 ? (buyFutSum / cuValue) * 10000 : 0
  const futuresSellBp = cuValue > 0 ? (sellFutSum / cuValue) * 10000 : 0
  const diffBp =
    arbMode === 'buy' ? futuresBuyBp :
    arbMode === 'sell' ? -futuresSellBp :
    futuresBuyBp - futuresSellBp

  const lastPrice = etfTicks[code]?.price ?? stockTicks[code]?.price ?? 0
  const ob = orderbookTicks[code]
  const ask1 = ob?.asks[0]?.price ?? 0
  const bid1 = ob?.bids[0]?.price ?? 0

  let fNavValue = pdf.cash || 0
  const sellSide = arbMode === 'sell' || (arbMode === 'mixed' && diffBp < 0)
  const buySide = arbMode === 'buy' || (arbMode === 'mixed' && diffBp > 0)
  for (const s of pdf.stocks) {
    if (s.qty <= 0) continue
    const spotTick = stockTicks[s.code]
    const live = spotTick?.price ?? 0
    if (live <= 0) continue
    const fm = futuresByBase.get(s.code)
    const futTick = fm?.front?.code ? futuresTicks[fm.front.code] : undefined
    const fut = futTick?.price ?? 0
    let useFut = false
    if (fut > 0) {
      if (sellSide && fut < live) useFut = true
      else if (buySide && fut > live) useFut = true
    }
    fNavValue += s.qty * (useFut ? fut : live)
  }
  const fNav = cuUnit > 0 && fNavValue > 1000 ? fNavValue / cuUnit : 0
  const navDiff = fNav > 0 && nav > 0 ? fNav - nav : 0

  let tradeProfitMaker: number | null = null
  let tradeProfitTaker: number | null = null
  if (fNav > 0) {
    if (sellSide) {
      if (ask1 > 0) tradeProfitMaker = fNav - ask1
      if (bid1 > 0) tradeProfitTaker = fNav - bid1
    } else if (buySide) {
      if (bid1 > 0) tradeProfitMaker = fNav - bid1
      if (ask1 > 0) tradeProfitTaker = fNav - ask1
    }
  }

  const priceNavBp = nav > 0 && lastPrice > 0 ? ((lastPrice - nav) / nav) * 10000 : 0
  const askNavBp = nav > 0 && ask1 > 0 ? ((ask1 - nav) / nav) * 10000 : 0
  const bidNavBp = nav > 0 && bid1 > 0 ? ((bid1 - nav) / nav) * 10000 : 0

  const tradeValue = stockTicks[code]?.cum_volume ?? 0

  return {
    diffBp, fNav, navDiff,
    tradeProfitMaker, tradeProfitTaker,
    futuresBuyBp, futuresSellBp,
    pdfValue: cuValue,
    appliedPct: cuValue > 0 ? (appliedFutValue / cuValue) * 100 : 0,
    futuresCount,
    etfPrice: lastPrice,
    etfPrevClose: stockTicks[code]?.prev_close ?? 0,
    nav, tradeValue,
    priceNavBp: Math.abs(priceNavBp) > 1000 ? 0 : priceNavBp,
    askNavBp: Math.abs(askNavBp) > 1000 ? 0 : askNavBp,
    bidNavBp: Math.abs(bidNavBp) > 1000 ? 0 : bidNavBp,
  }
}

/** 두 메트릭이 모든 number 필드에서 동일한지. ref-cache용 — 같으면 이전 ref 재사용해서
 * ArbRow memo 효과 활성화. 17개 필드 비교 < 1µs/code, 585개여도 무시 가능. */
function metricsEqual(a: EtfMetrics, b: EtfMetrics): boolean {
  return (
    a.diffBp === b.diffBp &&
    a.fNav === b.fNav &&
    a.navDiff === b.navDiff &&
    a.tradeProfitMaker === b.tradeProfitMaker &&
    a.tradeProfitTaker === b.tradeProfitTaker &&
    a.futuresBuyBp === b.futuresBuyBp &&
    a.futuresSellBp === b.futuresSellBp &&
    a.pdfValue === b.pdfValue &&
    a.appliedPct === b.appliedPct &&
    a.futuresCount === b.futuresCount &&
    a.etfPrice === b.etfPrice &&
    a.etfPrevClose === b.etfPrevClose &&
    a.nav === b.nav &&
    a.tradeValue === b.tradeValue &&
    a.priceNavBp === b.priceNavBp &&
    a.askNavBp === b.askNavBp &&
    a.bidNavBp === b.bidNavBp
  )
}

type EtfMetrics = {
  // diffBp: PDF 차익. (콘탱고 합 - 백워데이션 합) / cuValue × 10000.
  //   양수 클수록 매수차 우세 (콘탱고 종목 매수+선물매도 차익 큼) → 빨강
  //   음수 클수록 매도차 우세 (백워데이션 종목 매도+선물매수 차익 큼) → 초록
  // ETF/NAV 괴리는 별도 priceNavBp/askNavBp/bidNavBp 컬럼에 표시.
  diffBp: number
  // f_nav: 차익 우세 방향에 따라 유리한 선물 베이시스로 종목 가격을 대체해서 재계산한 NAV.
  // 매도차 우세(diffBp<0): 백워데이션 종목들(fut<spot) → fut로 평가 → NAV 낮아짐
  // 매수차 우세(diffBp>0): 콘탱고 종목들(fut>spot) → fut로 평가 → NAV 높아짐
  fNav: number
  navDiff: number              // f_nav - nav. 음수=매도 유리, 양수=매수 유리
  tradeProfitMaker: number | null  // 자기호가 fill 매매이익 (fNav-ask1 또는 fNav-bid1). 음수=매도이익, 양수=매수이익
  tradeProfitTaker: number | null  // 상대호가 fill 매매이익 (반대편 호가 hit). 비교용.
  futuresBuyBp: number   // ExpandedPanel용. 콘탱고 차익 absolute.
  futuresSellBp: number  // ExpandedPanel용. 백워데이션 차익 absolute.
  pdfValue: number
  appliedPct: number
  futuresCount: number
  etfPrice: number       // 라이브 ETF 가격 (0이면 장 외)
  etfPrevClose: number   // 직전 영업일 종가 — 장 외 표시 폴백용
  nav: number
  tradeValue: number     // 거래대금 (원). t1102 cum_volume(원) 우선, EtfTick.volume * price 보조
  priceNavBp: number     // 현재가 vs NAV 괴리 (bp)
  askNavBp: number       // 매도1호가 vs NAV 괴리 (bp)
  bidNavBp: number       // 매수1호가 vs NAV 괴리 (bp)
}

export function EtfArbitragePage() {
  const [master, setMaster] = useState<EtfMaster[] | null>(null)
  const [pdfs, setPdfs] = useState<Record<string, EtfPdf> | null>(null)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [futuresMaster, setFuturesMaster] = useState<FuturesMaster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [minFuturesVolume, setMinFuturesVolume] = useState(0)
  const [minDiffBp, setMinDiffBp] = useState(0)             // |차익bp| ≥ N
  const [minTradeProfit, setMinTradeProfit] = useState(0)   // |매매이익(자기)| ≥ N (원)
  const [expanded, setExpanded] = useState<string | null>(null)
  type SortKey =
    | 'code' | 'name' | 'tradeValue' | 'etfPrice' | 'nav' | 'fNav' | 'navDiff' | 'tradeProfitMaker' | 'tradeProfitTaker'
    | 'priceNavBp' | 'askNavBp' | 'bidNavBp'
    | 'diffBp'
    | 'appliedPct' | 'futuresCount'
  const [sortKey, setSortKey] = useState<SortKey>('diffBp')
  const [sortAsc, setSortAsc] = useState<boolean>(false)
  // 같은 컬럼 클릭 시 방향 토글, 다른 컬럼이면 default 방향(텍스트=asc, 수치=desc).
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((v) => !v)
    } else {
      setSortKey(key)
      setSortAsc(key === 'name' || key === 'code')
    }
  }
  // ETF별 제외된 종목 코드. 펼침 패널의 사용 토글로 변경됨.
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({})
  // 차트 패널 펼침/접힘 (localStorage 보존)
  const [chartsOpen, setChartsOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem('etf.chartsOpen')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => { localStorage.setItem('etf.chartsOpen', chartsOpen ? '1' : '0') }, [chartsOpen])
  const [filterOpen, setFilterOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem('etf.filterOpen')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => { localStorage.setItem('etf.filterOpen', filterOpen ? '1' : '0') }, [filterOpen])
  // 차트 강조용 선택 ETF (행 또는 막대 클릭)
  const [selectedEtf, setSelectedEtf] = useState<string | null>(null)

  // 행 클릭 핸들러 — useCallback + functional setter로 reference 안정화.
  // ArbRow memo가 onSelect 재생성으로 bust되지 않도록.
  const handleRowSelect = useCallback((code: string) => {
    setExpanded((prev) => (prev === code ? null : code))
    setSelectedEtf(code)
  }, [])

  // 차익 모드 — PDF 종목 중 어느 방향만 합산할지.
  //   buy: 콘탱고(fut>spot) 종목만 → diffBp 양수 only, fNav 상승, ETF 매수 시나리오
  //   sell: 백워(fut<spot) 종목만 → diffBp 음수 only, fNav 하락, ETF 매도 시나리오
  //   mixed: 양쪽 합산 (콘탱고 - 백워, signed) — 한 방향이 우세하면 그쪽 표시
  const [arbMode, setArbMode] = useState<ArbMode>(() => {
    const saved = localStorage.getItem('etf.arbMode')
    return saved === 'buy' || saved === 'sell' || saved === 'mixed' ? saved : 'mixed'
  })
  useEffect(() => { localStorage.setItem('etf.arbMode', arbMode) }, [arbMode])

  // Tick 데이터 200ms throttled snapshot. 라이브로 store 구독하면 매 tick마다 페이지 전체 재계산
  // (metricsByCode loop 17K iter × 매초 수십 회). 5Hz면 사람이 보기에 충분히 부드러움.
  const [{ stockTicks, futuresTicks, etfTicks, orderbookTicks }, setThrottledTicks] = useState(() => {
    const s = useMarketStore.getState()
    return {
      stockTicks: s.stockTicks,
      futuresTicks: s.futuresTicks,
      etfTicks: s.etfTicks,
      orderbookTicks: s.orderbookTicks,
    }
  })
  useEffect(() => {
    const id = setInterval(() => {
      const s = useMarketStore.getState()
      setThrottledTicks({
        stockTicks: s.stockTicks,
        futuresTicks: s.futuresTicks,
        etfTicks: s.etfTicks,
        orderbookTicks: s.orderbookTicks,
      })
    }, 200)
    return () => clearInterval(id)
  }, [])
  // history는 store가 자체 5초 interval로 push하니 직접 구독해도 부담 없음 + Sparkline은 React.memo
  const etfHistory = useMarketStore((s) => s.etfHistory)
  const pushEtfHistoryBatch = useMarketStore((s) => s.pushEtfHistoryBatch)

  useEffect(() => {
    Promise.all([
      fetch('/api/etfs').then((r) => r.json()),
      fetch('/api/etfs/pdf-all').then((r) => r.json()),
      fetch('/api/arbitrage/master').then((r) => r.json()),
    ])
      .then(([mEtf, mPdf, mFut]) => {
        setMaster(mEtf.items)
        setLoadedAt(mEtf.loaded_at)
        setPdfs(mPdf.items)
        setFuturesMaster(mFut)
      })
      .catch((e) => setError(e.message))
  }, [])

  const futuresByBase = useMemo(() => {
    const m = new Map<string, FuturesItem>()
    if (!futuresMaster) return m
    for (const it of futuresMaster.items) m.set(it.base_code, it)
    return m
  }, [futuresMaster])

  // 주식/ETF + 선물 front 코드 구독.
  // 선물은 ls_api 모드에선 fixed group의 auto_spread로 front 월물 자동 구독되지만, mock에서는
  // 명시적으로 subscribe-stocks에 A+7 코드 포함시켜야 mock이 futures tick 생성.
  const stockSubscriptionCodes = useMemo(() => {
    if (!pdfs || !master) return [] as string[]
    const all = new Set<string>()
    for (const etf of master) all.add(etf.code)
    for (const pdf of Object.values(pdfs)) {
      for (const s of pdf.stocks) {
        all.add(s.code)
        const fm = futuresByBase.get(s.code)
        if (fm?.front?.code) all.add(fm.front.code)
      }
    }
    return Array.from(all)
  }, [master, pdfs, futuresByBase])

  usePageStockSubscriptions(stockSubscriptionCodes)

  // ETF iNAV 구독 (I5_) — 거래소 발행 실시간 NAV.
  const inavCodes = useMemo(() => master?.map((e) => e.code) ?? [], [master])
  usePageInavSubscriptions(inavCodes)

  // ETF 호가 일괄 구독 — 4모드 가격 (own/opp/mid)에 필요. 마스터에서 ETF 코드만.
  const etfCodesForOrderbook = useMemo(() => master?.map((e) => e.code) ?? [], [master])
  usePageOrderbookBulk(etfCodesForOrderbook)

  // ETF별 메트릭 계산 — 두 단계로 분리해서 excluded 토글 응답 최적화.
  //   baseMetricsByCode: 모든 ETF, exSet=undefined로 계산. 무거움 (~50ms). 200ms tick에만 재실행.
  //   metricsByCode: base를 spread + 사용자가 exclude한 ETF만 재계산해서 덮어씀. 가벼움 (<5ms).
  // → 사용 체크박스 토글 시 baseMetricsByCode는 그대로, overlay만 영향 받는 ETF 1개 재계산.
  const baseMetricsRefCache = useRef<Record<string, EtfMetrics>>({})
  const baseMetricsByCode = useMemo(() => {
    const out: Record<string, EtfMetrics> = {}
    const cache = baseMetricsRefCache.current
    if (!pdfs) { baseMetricsRefCache.current = out; return out }
    for (const [code, pdf] of Object.entries(pdfs)) {
      const newM = computeMetric(code, pdf, undefined, stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode)
      const cached = cache[code]
      out[code] = cached && metricsEqual(cached, newM) ? cached : newM
    }
    baseMetricsRefCache.current = out
    return out
  }, [pdfs, stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode])

  const metricsRefCache = useRef<Record<string, EtfMetrics>>({})
  const metricsByCode = useMemo(() => {
    if (!pdfs) return baseMetricsByCode
    // exclude된 ETF 없으면 base 그대로 (object spread도 생략, ref 재사용 가능).
    const excludedCodes = Object.keys(excluded).filter((c) => (excluded[c]?.size ?? 0) > 0)
    if (excludedCodes.length === 0) {
      metricsRefCache.current = baseMetricsByCode
      return baseMetricsByCode
    }
    const out: Record<string, EtfMetrics> = { ...baseMetricsByCode }
    const cache = metricsRefCache.current
    for (const code of excludedCodes) {
      const pdf = pdfs[code]
      if (!pdf) continue
      const newM = computeMetric(code, pdf, excluded[code], stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode)
      const cached = cache[code]
      out[code] = cached && metricsEqual(cached, newM) ? cached : newM
    }
    metricsRefCache.current = out
    return out
  }, [baseMetricsByCode, excluded, pdfs, stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode])


  const naturalRows = useMemo(() => {
    if (!master) return [] as EtfMaster[]
    // 텍스트 정렬은 오름차순, 그 외 (수치)는 내림차순.
    // 모든 sort는 "강도(strength) 내림차순". 매수는 음수 클수록 강하므로 -buyBp.
    // 괴리 컬럼들도 매수가 강한 ETF가 위에 오게 하려면 별도 처리하나, 여기선 기본 signed 값 그대로
    // 내림차순 (양수 큰 = 매도 premium 큰 ETF 위로). 매수 신호 보고 싶으면 다시 클릭해서 toggle 가능.
    const valueOf = (etf: EtfMaster): number => {
      const m = metricsByCode[etf.code]
      if (!m) return 0
      switch (sortKey) {
        case 'tradeValue': return m.tradeValue
        case 'etfPrice': return m.etfPrice
        case 'nav': return m.nav
        case 'fNav': return m.fNav
        case 'navDiff': return m.navDiff   // signed: 양수 위 (매수 우세), 음수 아래 (매도 우세)
        case 'tradeProfitMaker': return m.tradeProfitMaker ?? 0
        case 'tradeProfitTaker': return m.tradeProfitTaker ?? 0
        case 'priceNavBp': return m.priceNavBp
        case 'askNavBp': return m.askNavBp
        case 'bidNavBp': return m.bidNavBp
        case 'diffBp': return m.diffBp   // signed: 양수(매수)↑, 0 중간, 음수(매도)↓
        case 'appliedPct': return m.appliedPct
        case 'futuresCount': return m.futuresCount
        default: return 0
      }
    }
    // ETF row 필터 (절댓값 기반 임계 통과만)
    const filtered = master.filter((etf) => {
      const m = metricsByCode[etf.code]
      if (!m) return true   // metric 아직 미계산 → 표시
      if (minDiffBp > 0 && Math.abs(m.diffBp) < minDiffBp) return false
      if (minTradeProfit > 0 && (m.tradeProfitMaker == null || Math.abs(m.tradeProfitMaker) < minTradeProfit)) return false
      return true
    })
    const sorted = [...filtered]
    const dir = sortAsc ? 1 : -1
    sorted.sort((a, b) => {
      if (sortKey === 'code') return a.code.localeCompare(b.code) * dir
      if (sortKey === 'name') return a.name.localeCompare(b.name) * dir
      return (valueOf(b) - valueOf(a)) * (sortAsc ? -1 : 1)
    })
    return sorted
  }, [master, metricsByCode, sortKey, sortAsc, minDiffBp, minTradeProfit])

  // 펼침 패널 열린 동안 행 순서 freeze (사용 토글로 metric이 바뀌어도 row 위치 안 흔들리게).
  // 닫히면 자연 정렬로 복귀, sortKey 바꾸면 새로 정렬 + 재freeze.
  const naturalRowsRef = useRef(naturalRows)
  naturalRowsRef.current = naturalRows
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null)
  useEffect(() => {
    if (expanded == null) setFrozenOrder(null)
    else setFrozenOrder(naturalRowsRef.current.map((r) => r.code))
  }, [expanded, sortKey, sortAsc])

  const rows = useMemo(() => {
    if (frozenOrder == null) return naturalRows
    const orderMap = new Map(frozenOrder.map((c, i) => [c, i] as const))
    return [...naturalRows].sort((a, b) => (orderMap.get(a.code) ?? Infinity) - (orderMap.get(b.code) ?? Infinity))
  }, [naturalRows, frozenOrder])

  // 5초 간격 시계열 누적. 페이지 mount 동안 동작, unmount해도 zustand history는 유지.
  const metricsRef = useRef(metricsByCode)
  metricsRef.current = metricsByCode
  useEffect(() => {
    const id = setInterval(() => {
      const entries: Record<string, { diffBp: number }> = {}
      for (const [code, m] of Object.entries(metricsRef.current)) {
        entries[code] = { diffBp: m.diffBp }
      }
      if (Object.keys(entries).length > 0) {
        pushEtfHistoryBatch(entries, HISTORY_MAX_POINTS)
      }
    }, HISTORY_INTERVAL_MS)
    return () => clearInterval(id)
  }, [pushEtfHistoryBatch])

  // 가상화 — 메인 + 펼침 행을 평탄화한 가상 리스트.
  type VRow =
    | { kind: 'main'; etf: EtfMaster }
    | { kind: 'expanded'; etfCode: string; pdf: EtfPdf }
  const vRows = useMemo<VRow[]>(() => {
    if (!pdfs) return []
    const out: VRow[] = []
    for (const etf of rows) {
      out.push({ kind: 'main', etf })
      if (expanded === etf.code && pdfs[etf.code]) {
        out.push({ kind: 'expanded', etfCode: etf.code, pdf: pdfs[etf.code] })
      }
    }
    return out
  }, [rows, expanded, pdfs])

  // <main> 스크롤 컨테이너 안에 위치 — scrollMargin으로 차트/필터 위 영역 보정.
  const tableContainerRef = useRef<HTMLDivElement>(null)
  const mainScrollRef = useRef<HTMLElement | null>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    if (!mainScrollRef.current) mainScrollRef.current = document.querySelector('main')
    const main = mainScrollRef.current
    const tbl = tableContainerRef.current
    if (!main || !tbl) return
    const top = tbl.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
    if (Math.abs(top - scrollMargin) > 1) setScrollMargin(top)
  })

  const rowVirtualizer = useVirtualizer({
    count: vRows.length,
    getScrollElement: () => mainScrollRef.current,
    estimateSize: (index) => vRows[index]?.kind === 'main' ? 32 : 360,
    overscan: 20, // 마운트 직후 viewport 계산이 부정확할 때를 위한 여유 — 추가 12행 DOM, 영향 미미
    scrollMargin,
  })

  // window resize / 차트 패널 토글 시 scrollMargin 강제 재계산.
  // useLayoutEffect는 매 렌더 돌지만 외부 이벤트(resize)가 부모 렌더를 트리거하지 않으면 stale 상태 유지.
  useEffect(() => {
    const recompute = () => {
      const main = mainScrollRef.current
      const tbl = tableContainerRef.current
      if (!main || !tbl) return
      const top = tbl.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop
      setScrollMargin((prev) => Math.abs(top - prev) > 1 ? top : prev)
    }
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [])
  const vItems = rowVirtualizer.getVirtualItems()
  const totalSize = rowVirtualizer.getTotalSize()
  const padTop = vItems[0] ? vItems[0].start - scrollMargin : 0
  const padBottom = vItems.length > 0 ? totalSize - vItems[vItems.length - 1].end : totalSize

  // useCallback으로 ref 안정화 — ExpandedPanel/PdfRow의 onToggle prop이 매 렌더 새 ref가
  // 되어 memo를 깨뜨리지 않도록.
  const toggleExclude = useCallback((etfCode: string, stockCode: string) => {
    setExcluded((prev) => {
      const next = new Set(prev[etfCode] ?? [])
      if (next.has(stockCode)) next.delete(stockCode)
      else next.add(stockCode)
      return { ...prev, [etfCode]: next }
    })
  }, [])

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 필터 패널 */}
      {(() => {
        const activeCount =
          (minFuturesVolume > 0 ? 1 : 0) +
          (minDiffBp > 0 ? 1 : 0) +
          (minTradeProfit > 0 ? 1 : 0)
        const reset = () => {
          setMinFuturesVolume(0); setMinDiffBp(0); setMinTradeProfit(0)
        }
        return (
          <div className="panel px-3 py-2 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px] text-t3">
              <button
                onClick={() => setFilterOpen((v) => !v)}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  filterOpen
                    ? 'bg-accent/15 text-accent hover:bg-accent/25'
                    : 'bg-[#2a2a2e] text-[#d1d1d6] hover:bg-[#3a3a3e]'
                )}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2 3h12l-4.5 6v4l-3-1.5V9L2 3z"/></svg>
                <span>필터</span>
                <span className="text-[10px] opacity-80">{filterOpen ? '▾' : '▸'}</span>
              </button>
              {activeCount > 0 && (
                <>
                  <span className="text-accent tabular-nums">{activeCount} 적용</span>
                  <button onClick={reset} className="text-t4 hover:text-t1 underline-offset-2 text-[10px]">초기화</button>
                </>
              )}
              <span className="ml-auto text-[10px] text-t4 tabular-nums">ETF {rows.length}개</span>
              {loadedAt && <span className="text-[10px] text-t4">PDF: {loadedAt.slice(0, 10)}</span>}
              <button
                onClick={() => setChartsOpen((v) => !v)}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  chartsOpen
                    ? 'bg-accent/15 text-accent hover:bg-accent/25'
                    : 'bg-[#2a2a2e] text-[#d1d1d6] hover:bg-[#3a3a3e]'
                )}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                  <rect x="2" y="9" width="2.5" height="5" rx="0.5"/>
                  <rect x="6.75" y="6" width="2.5" height="8" rx="0.5"/>
                  <rect x="11.5" y="3" width="2.5" height="11" rx="0.5"/>
                </svg>
                <span>차트</span>
                <span className="text-[9px] opacity-70">{chartsOpen ? '▾' : '▸'}</span>
              </button>
            </div>
            {filterOpen && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]">
                <FilterField label="차익 방향">
                  <div className="flex items-center gap-0.5">
                    <Quick on={arbMode === 'buy'} onClick={() => setArbMode('buy')}>매수차만</Quick>
                    <Quick on={arbMode === 'sell'} onClick={() => setArbMode('sell')}>매도차만</Quick>
                    <Quick on={arbMode === 'mixed'} onClick={() => setArbMode('mixed')}>혼합</Quick>
                  </div>
                </FilterField>
                <FilterField label="선물거래량 ≥">
                  <NumInput value={minFuturesVolume} onChange={setMinFuturesVolume} width={64} />
                  <Quick on={minFuturesVolume === 100} onClick={() => setMinFuturesVolume(100)}>100+</Quick>
                  <Quick on={minFuturesVolume === 1000} onClick={() => setMinFuturesVolume(1000)}>1,000+</Quick>
                  <Quick on={minFuturesVolume === 0} onClick={() => setMinFuturesVolume(0)}>전체</Quick>
                </FilterField>
                <FilterField label="|차익bp| ≥">
                  <NumInput value={minDiffBp} step={0.1} onChange={setMinDiffBp} width={48} suffix="bp" />
                  <Quick on={minDiffBp === 10} onClick={() => setMinDiffBp(10)}>10+</Quick>
                  <Quick on={minDiffBp === 30} onClick={() => setMinDiffBp(30)}>30+</Quick>
                  <Quick on={minDiffBp === 0} onClick={() => setMinDiffBp(0)}>전체</Quick>
                </FilterField>
                <FilterField label="|매매이익(자기)| ≥">
                  <NumInput value={minTradeProfit} step={1} onChange={setMinTradeProfit} width={48} suffix="원" />
                  <Quick on={minTradeProfit === 10} onClick={() => setMinTradeProfit(10)}>10+</Quick>
                  <Quick on={minTradeProfit === 30} onClick={() => setMinTradeProfit(30)}>30+</Quick>
                  <Quick on={minTradeProfit === 0} onClick={() => setMinTradeProfit(0)}>전체</Quick>
                </FilterField>
              </div>
            )}
          </div>
        )
      })()}

      {/* 차트 패널 — 좌(막대) / 중(호가) / 우(시계열) 같은 높이 */}
      {chartsOpen && master && pdfs && (() => {
        const effectiveCode = selectedEtf ?? rows[0]?.code ?? null
        const effectiveName = effectiveCode ? master.find((e) => e.code === effectiveCode)?.name ?? '' : ''
        return (
          <div className="grid grid-cols-3 gap-1 h-[260px]">
            <div className="bg-black border border-white/[0.04] p-2 overflow-hidden [contain:paint]">
              <TopBarChart
                rows={rows}
                metrics={metricsByCode}
                selected={effectiveCode}
                onSelect={(code) => setSelectedEtf(code === selectedEtf ? null : code)}
                arbMode={arbMode}
              />
            </div>
            <div className="bg-black border border-white/[0.04] p-2 overflow-hidden [contain:paint]">
              <TimeSeriesChart
                code={effectiveCode}
                etfName={effectiveName}
                history={effectiveCode ? etfHistory[effectiveCode] ?? [] : []}
                isAuto={!selectedEtf}
              />
            </div>
            <div className="bg-black border border-white/[0.04] p-2 overflow-hidden [contain:paint]">
              <OrderbookPanel
                code={effectiveCode}
                etfName={effectiveName}
                ob={effectiveCode ? orderbookTicks[effectiveCode] : undefined}
                price={effectiveCode ? (etfTicks[effectiveCode]?.price ?? stockTicks[effectiveCode]?.price ?? 0) : 0}
              />
            </div>
          </div>
        )
      })()}

      {/* 메인 테이블 (가상화) — vRows: 메인+펼침 평탄화 리스트, 보이는 ~30행만 DOM에 */}
      <div ref={tableContainerRef} className="mt-5 px-2 bg-black">
        {error && <div className="p-3 text-down text-sm">로드 실패: {error}</div>}
        {!error && (!master || !pdfs) && <div className="p-3 text-t3 text-sm">로드 중…</div>}
        {master && pdfs && (
          <table className="w-max min-w-full border-collapse" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: 180 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 78 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 88 }} />
              <col style={{ width: 60 }} />
              <col style={{ width: 60 }} />
              <col style={{ width: 170 }} />
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="text-[12px] text-[#8b8b8e] bg-black">
                <ArbTh sort={() => handleSort('name')} active={sortKey === 'name'} asc={sortAsc} left sticky className="pl-4">종목</ArbTh>
                <ArbTh sort={() => handleSort('tradeValue')} active={sortKey === 'tradeValue'} asc={sortAsc}>거래대금</ArbTh>
                <ArbTh sort={() => handleSort('etfPrice')} active={sortKey === 'etfPrice'} asc={sortAsc}>현재가</ArbTh>
                <ArbTh sort={() => handleSort('nav')} active={sortKey === 'nav'} asc={sortAsc}>NAV</ArbTh>
                <ArbTh sort={() => handleSort('priceNavBp')} active={sortKey === 'priceNavBp'} asc={sortAsc}>현재 괴리</ArbTh>
                <ArbTh sort={() => handleSort('askNavBp')} active={sortKey === 'askNavBp'} asc={sortAsc}>매도 괴리</ArbTh>
                <ArbTh sort={() => handleSort('bidNavBp')} active={sortKey === 'bidNavBp'} asc={sortAsc}>매수 괴리</ArbTh>
                <ArbTh sort={() => handleSort('diffBp')} active={sortKey === 'diffBp'} asc={sortAsc}>차익bp</ArbTh>
                <ArbTh sort={() => handleSort('fNav')} active={sortKey === 'fNav'} asc={sortAsc}>f_nav</ArbTh>
                <ArbTh sort={() => handleSort('navDiff')} active={sortKey === 'navDiff'} asc={sortAsc}>nav 차이</ArbTh>
                <ArbTh sort={() => handleSort('tradeProfitMaker')} active={sortKey === 'tradeProfitMaker'} asc={sortAsc}>매매이익(자기)</ArbTh>
                <ArbTh sort={() => handleSort('tradeProfitTaker')} active={sortKey === 'tradeProfitTaker'} asc={sortAsc}>매매이익(상대)</ArbTh>
                <ArbTh sort={() => handleSort('appliedPct')} active={sortKey === 'appliedPct'} asc={sortAsc}>선물비중</ArbTh>
                <ArbTh sort={() => handleSort('futuresCount')} active={sortKey === 'futuresCount'} asc={sortAsc}>선물수</ArbTh>
                <ArbTh className="text-center">추이</ArbTh>
              </tr>
            </thead>
            <tbody>
              {padTop > 0 && <tr aria-hidden style={{ height: padTop }} />}
              {vItems.map((vr) => {
                const entry = vRows[vr.index]
                if (!entry) return null
                if (entry.kind === 'main') {
                  const m = metricsByCode[entry.etf.code]
                  const isSelected = selectedEtf === entry.etf.code
                  return (
                    <ArbRow
                      key={entry.etf.code}
                      etf={entry.etf}
                      m={m}
                      history={etfHistory[entry.etf.code]}
                      isSelected={isSelected}
                      onSelect={handleRowSelect}
                    />
                  )
                }
                // expanded
                return (
                  <tr
                    key={`exp-${entry.etfCode}`}
                    className="bg-bg-base"
                    data-index={vr.index}
                    ref={rowVirtualizer.measureElement}
                  >
                    <td colSpan={15} className="p-0">
                      <ExpandedPanel
                        pdf={entry.pdf}
                        etfCode={entry.etfCode}
                        metrics={metricsByCode[entry.etfCode]}
                        futuresByBase={futuresByBase}
                        excluded={excluded[entry.etfCode] ?? EMPTY_SET}
                        onToggle={toggleExclude}
                        stockTicks={stockTicks}
                        futuresTicks={futuresTicks}
                      />
                    </td>
                  </tr>
                )
              })}
              {padBottom > 0 && <tr aria-hidden style={{ height: padBottom }} />}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function formatBp(v: number): string {
  if (!isFinite(v)) return '—'
  if (Math.abs(v) < 0.05) return '0.0'
  return v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

/** 천단위 쉼표 + 고정 소수점. */
function fmt(v: number, decimals: number = 2): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** 거래대금(원) → "5,300억" 형식. 천단위 쉼표 + 단위. */
function formatTradeValue(won: number): string {
  if (won >= 1_0000_0000_0000) return Math.round(won / 1_0000_0000_0000).toLocaleString() + '조'
  if (won >= 1_0000_0000) return Math.round(won / 1_0000_0000).toLocaleString() + '억'
  if (won >= 1_0000) return Math.round(won / 1_0000).toLocaleString() + '만'
  return won.toLocaleString()
}


/* ---------- 펼침 패널 ---------- */

type ExpandedPanelProps = {
  pdf: EtfPdf
  etfCode: string
  metrics?: EtfMetrics
  futuresByBase: Map<string, FuturesItem>
  excluded: Set<string>
  // (etfCode, stockCode) 시그니처. useCallback으로 안정화된 ref 받음.
  onToggle: (etfCode: string, stockCode: string) => void
  // 200ms throttled snapshot — 부모에서 prop으로 전달.
  // 이전엔 store에서 직접 구독해 매 tick(50Hz) 재렌더 → 페이지 클릭 처리 starve. fix.
  stockTicks: Record<string, import('@/types/market').StockTick>
  futuresTicks: Record<string, import('@/types/market').FuturesTick>
}

/** PDF 행 — 해당 종목의 spot/fut/futVol/isExcluded만 변할 때 렌더.
 * 부모 ExpandedPanel이 매 200ms 재렌더돼도 가격 변동 없는 행은 memo skip. */
const PdfRow = memo(function PdfRow({
  code, name, qty, futCode, spot, fut, futVol, isExcluded, etfCode, onToggle,
}: {
  code: string; name: string; qty: number; futCode: string | undefined
  spot: number; fut: number; futVol: number; isExcluded: boolean
  etfCode: string; onToggle: (etfCode: string, stockCode: string) => void
}) {
  const hasFuture = !!futCode
  const basis = spot > 0 && fut > 0 ? fut - spot : 0
  return (
    <tr className={cn('border-t border-border/30', isExcluded && 'opacity-50')}>
      <td className="py-0.5 text-t2 font-mono text-[11px]">{code}</td>
      <td className={cn('py-0.5', hasFuture ? 'text-t1' : 'text-t4')}>
        {name}{!hasFuture && <span className="ml-1 text-[10px]">(선물無)</span>}
      </td>
      <td className="py-0.5 text-right text-t2">{qty.toLocaleString()}</td>
      <td className="py-0.5 text-right text-t2">{spot ? spot.toLocaleString() : '—'}</td>
      <td className="py-0.5 text-right text-t2">{fut ? fut.toLocaleString() : '—'}</td>
      <td className={cn('py-0.5 text-right', basis > 0 ? 'text-down' : basis < 0 ? 'text-up' : 'text-t4')}>{basis ? basis.toLocaleString() : '—'}</td>
      <td className="py-0.5 text-right text-t2">{futVol ? futVol.toLocaleString() : '—'}</td>
      <td className="py-0.5 text-center">
        <input
          type="checkbox"
          checked={!isExcluded}
          disabled={!hasFuture}
          onChange={() => onToggle(etfCode, code)}
          className="accent-accent"
        />
      </td>
    </tr>
  )
})

function ExpandedPanel({ pdf, etfCode, metrics, futuresByBase, excluded, onToggle, stockTicks, futuresTicks }: ExpandedPanelProps) {

  return (
    <div className="px-4 py-2">
      <div className="mb-2 flex items-center gap-3 text-[11px] text-t3 flex-wrap">
        <span>기준일: {pdf.as_of}</span>
        <span>CU: {pdf.cu_unit?.toLocaleString()}주</span>
        <span>현금: {pdf.cash.toLocaleString()}원</span>
        <span>종목수: {pdf.stocks.length}</span>
        {metrics && (
          <>
            <span className="text-t4">|</span>
            <span>선물대체 매수차: {formatBp(metrics.futuresBuyBp)}bp</span>
            <span>선물대체 매도차: {formatBp(metrics.futuresSellBp)}bp</span>
            <span>차익bp: {formatBp(metrics.diffBp)}</span>
          </>
        )}
      </div>
      <table className="w-full text-[12px] tabular-nums">
        <thead className="text-t3 text-[10px] uppercase">
          <tr>
            <th className="py-1 text-left font-medium">코드</th>
            <th className="py-1 text-left font-medium">종목명</th>
            <th className="py-1 text-right font-medium">주식수</th>
            <th className="py-1 text-right font-medium">현물가</th>
            <th className="py-1 text-right font-medium">선물가</th>
            <th className="py-1 text-right font-medium">베이시스</th>
            <th className="py-1 text-right font-medium">선물거래량</th>
            <th className="py-1 text-center font-medium">사용</th>
          </tr>
        </thead>
        <tbody>
          {pdf.stocks.map((s) => {
            const fm = futuresByBase.get(s.code)
            const futCode = fm?.front?.code
            return (
              <PdfRow
                key={s.code}
                code={s.code}
                name={s.name}
                qty={s.qty}
                futCode={futCode}
                spot={stockTicks[s.code]?.price ?? 0}
                fut={futCode ? futuresTicks[futCode]?.price ?? 0 : 0}
                futVol={futCode ? futuresTicks[futCode]?.volume ?? 0 : 0}
                isExcluded={excluded.has(s.code)}
                etfCode={etfCode}
                onToggle={onToggle}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ---------- 차트 컴포넌트 ---------- */

type TopBarProps = {
  rows: EtfMaster[]
  metrics: Record<string, EtfMetrics>
  selected: string | null
  onSelect: (code: string) => void
  arbMode: 'buy' | 'sell' | 'mixed'
}

/**
 * Top N ETF 막대 차트. arbMode별:
 *   buy: 매수차 Top만 풀폭 (양수, 초록)
 *   sell: 매도차 Top만 풀폭 (음수, 빨강)
 *   mixed: 좌(매수차) + 우(매도차) 분할
 */
const TopBarChart = memo(function TopBarChart({ rows, metrics, selected, onSelect, arbMode }: TopBarProps) {
  const buyTop = useMemo(
    () => rows
      .map((etf) => ({ etf, bp: metrics[etf.code]?.diffBp ?? 0 }))
      .filter((it) => it.bp > 0)
      .sort((a, b) => b.bp - a.bp)
      .slice(0, TOP_N_CHART),
    [rows, metrics]
  )
  const sellTop = useMemo(
    () => rows
      .map((etf) => ({ etf, bp: metrics[etf.code]?.diffBp ?? 0 }))
      .filter((it) => it.bp < 0)
      .sort((a, b) => a.bp - b.bp)
      .slice(0, TOP_N_CHART),
    [rows, metrics]
  )
  const buyMax = Math.max(1, ...buyTop.map((it) => it.bp))
  const sellMax = Math.max(1, ...sellTop.map((it) => Math.abs(it.bp)))

  return (
    <div className="flex flex-col h-full">
      <div className="mb-1 flex items-center justify-between text-[11px] text-t3">
        <span>차익 Top {TOP_N_CHART} (bp)</span>
      </div>
      <div className={cn(
        'grid gap-3 flex-1 text-[11px] min-h-0',
        arbMode === 'mixed' ? 'grid-cols-2' : 'grid-cols-1',
      )}>
        {(arbMode === 'mixed' || arbMode === 'buy') && (
          <TopSide title="매수차" items={buyTop} maxBp={buyMax} barClass="bg-up/40" textClass="text-[#00b26b]" selected={selected} onSelect={onSelect} />
        )}
        {(arbMode === 'mixed' || arbMode === 'sell') && (
          <TopSide title="매도차" items={sellTop} maxBp={sellMax} barClass="bg-down/40" textClass="text-[#bb4a65]" selected={selected} onSelect={onSelect} />
        )}
      </div>
    </div>
  )
})

function TopSide({ title, items, maxBp, barClass, textClass, selected, onSelect }: {
  title: string
  items: { etf: EtfMaster; bp: number }[]
  maxBp: number
  barClass: string
  textClass: string
  selected: string | null
  onSelect: (code: string) => void
}) {
  return (
    <div className="flex flex-col min-h-0">
      <div className="mb-1 flex items-center gap-1 text-[10px] text-t3">
        <span className={cn('inline-block w-2 h-2', barClass)} />
        <span className="text-t2">{title}</span>
      </div>
      <div className="flex-1 flex flex-col justify-around min-h-0">
        {items.length === 0 ? (
          <div className="text-t4 text-[10px] text-center">—</div>
        ) : items.map(({ etf, bp }) => {
          const w = (Math.abs(bp) / maxBp) * 100
          const isSelected = selected === etf.code
          return (
            <div
              key={etf.code}
              onClick={() => onSelect(etf.code)}
              className={cn(
                'grid items-center gap-1.5 px-1 py-0.5 cursor-pointer hover:bg-bg-surface',
                isSelected && 'bg-bg-surface ring-1 ring-accent/30'
              )}
              style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr) 28px' }}
            >
              <div className={cn('truncate', isSelected ? 'text-t1 font-medium' : 'text-t2')}>{etf.name}</div>
              <div className="flex items-center min-w-0">
                <div className={cn('h-3 rounded-sm shrink-0', barClass)} style={{ width: `${w}%` }} />
              </div>
              <span className={cn('tabular-nums whitespace-nowrap text-right shrink-0', textClass)}>{bp.toFixed(0)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 종목차익 테이블과 통일된 Th. 정렬 indicator ▲/▼. */
/** 필터 한 묶음 — 라벨 + 입력. 둥근 컨테이너로 시각적 그룹화. */
function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-[#1e1e22] px-2 py-1">
      <span className="text-[10px] text-[#8b8b8e] whitespace-nowrap">{label}</span>
      {children}
    </div>
  )
}

function NumInput({ value, onChange, width = 60, step = 1, suffix }: {
  value: number; onChange: (v: number) => void; width?: number; step?: number; suffix?: string
}) {
  return (
    <div className="flex items-center gap-0.5">
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="bg-transparent text-[11px] text-white tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
        style={{ width }}
      />
      {suffix && <span className="text-[10px] text-[#8b8b8e]">{suffix}</span>}
    </div>
  )
}

function Quick({ children, onClick, on }: { children: React.ReactNode; onClick: () => void; on: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] tabular-nums transition-colors',
        on ? 'bg-accent text-black' : 'bg-[#2a2a2e] text-[#d1d1d6] hover:bg-[#3a3a3e]'
      )}
    >
      {children}
    </button>
  )
}

function ArbTh({ children, className, sort, active, asc, left, sticky, title }: {
  children: React.ReactNode; className?: string; sort?: () => void; active?: boolean; asc?: boolean
  left?: boolean; sticky?: boolean; title?: string
}) {
  return (
    <th
      title={title}
      className={cn(
        'px-2 py-[7px] font-normal whitespace-nowrap border-b border-white/[0.06]',
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

/** 종목차익 테이블과 통일된 Cell. memo로 children/c/className 동일하면 재렌더 skip. */
const ArbC = memo(function ArbC({ children, c, className }: { children: React.ReactNode; c?: string; className?: string }) {
  return (
    <td className={cn('px-2 py-[7px] text-right text-[11px] tabular-nums whitespace-nowrap', c || 'text-white', className)}>
      {children}
    </td>
  )
})

/** ArbRow — memo로 wrap된 행. m/history/isSelected ref 안정 시 reconcile skip.
 * 필터 클릭 시 metricsByCode가 재계산 안 되어야(=Step B 적용) 실제 효과 발현. */
const ArbRow = memo(function ArbRow({ etf, m, history, isSelected, onSelect }: {
  etf: EtfMaster
  m: EtfMetrics | undefined
  history: { t: number; diffBp: number }[] | undefined
  isSelected: boolean
  onSelect: (code: string) => void
}) {
  const diffColor = m && Math.abs(m.diffBp) > 5
    ? (m.diffBp > 0 ? 'text-[#00b26b]' : 'text-[#bb4a65]')
    : 'text-white'
  return (
    <tr
      className={cn(
        'border-b border-white/[0.04] hover:bg-[#1d1d1d] cursor-pointer',
        isSelected ? 'bg-[#1d1d1d]' : 'bg-black'
      )}
      onClick={() => onSelect(etf.code)}
    >
      <td className="pl-4 pr-3 py-[7px] sticky left-0 z-10" style={STICKY_INHERIT_BG}>
        <div className="text-[11px] text-white leading-none whitespace-nowrap">{etf.name}</div>
        <div className="text-[9px] text-[#5a5a5e] leading-none mt-[2px] tabular-nums">{etf.code}</div>
      </td>
      <ArbC c="text-[#d1d1d6]">{m && m.tradeValue > 0 ? formatTradeValue(m.tradeValue) : '-'}</ArbC>
      <ArbC>{
        m?.etfPrice
          ? m.etfPrice.toLocaleString()
          : (m?.etfPrevClose ? m.etfPrevClose.toLocaleString() : '-')
      }</ArbC>
      <ArbC>{m?.nav ? m.nav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</ArbC>
      <ArbC c={m && m.priceNavBp > 0 ? 'text-[#00b26b]' : m && m.priceNavBp < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.nav > 0 ? `${fmt(m.priceNavBp, 2)}bp` : '-'}</ArbC>
      <ArbC c={m && m.askNavBp > 0 ? 'text-[#00b26b]' : m && m.askNavBp < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.nav > 0 && m.askNavBp !== 0 ? `${fmt(m.askNavBp, 2)}bp` : '-'}</ArbC>
      <ArbC c={m && m.bidNavBp > 0 ? 'text-[#00b26b]' : m && m.bidNavBp < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.nav > 0 && m.bidNavBp !== 0 ? `${fmt(m.bidNavBp, 2)}bp` : '-'}</ArbC>
      <ArbC c={cn('font-medium', diffColor)}>{m ? formatBp(m.diffBp) : '-'}</ArbC>
      <ArbC>{m?.fNav ? m.fNav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</ArbC>
      <ArbC c={m && m.navDiff > 0 ? 'text-[#00b26b]' : m && m.navDiff < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.fNav > 0 ? fmt(m.navDiff, 2) : '-'}</ArbC>
      <ArbC c={m?.tradeProfitMaker != null && m.tradeProfitMaker > 0 ? 'text-[#00b26b]' : m?.tradeProfitMaker != null && m.tradeProfitMaker < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m?.tradeProfitMaker != null ? fmt(m.tradeProfitMaker, 2) : '-'}</ArbC>
      <ArbC c={m?.tradeProfitTaker != null && m.tradeProfitTaker > 0 ? 'text-[#00b26b]' : m?.tradeProfitTaker != null && m.tradeProfitTaker < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m?.tradeProfitTaker != null ? fmt(m.tradeProfitTaker, 2) : '-'}</ArbC>
      <ArbC c="text-[#d1d1d6]">{m ? m.appliedPct.toFixed(1) : '-'}</ArbC>
      <ArbC c="text-[#d1d1d6]">{m ? m.futuresCount : '-'}</ArbC>
      <td className="px-2 py-[7px] text-center"><Sparkline history={history} /></td>
    </tr>
  )
})
const STICKY_INHERIT_BG = { backgroundColor: 'inherit' as const }
const EMPTY_SET: Set<string> = new Set()

/** Sparkline — diffBp 시계열. signed 한 줄 라인 차트.
 * 색은 마지막 시점 부호로 결정 (양수=매수차 초록, 음수=매도차 빨강). */
const Sparkline = memo(function Sparkline({ history, width = 150, height = 34 }: {
  history: { t: number; diffBp: number }[] | undefined; width?: number; height?: number
}) {
  const drawing = useMemo(() => {
    if (!history || history.length < 2) return null
    const last = history[history.length - 1]
    const useSell = last.diffBp <= 0
    let minV = 0, maxV = 0
    for (const p of history) {
      if (p.diffBp < minV) minV = p.diffBp
      if (p.diffBp > maxV) maxV = p.diffBp
    }
    const span = Math.max(0.1, maxV - minV)
    const xStep = width / (history.length - 1)
    let path = ''
    for (let i = 0; i < history.length; i++) {
      const p = history[i]
      const y = height - ((p.diffBp - minV) / span) * height
      path += `${i === 0 ? 'M' : ' L'} ${(i * xStep).toFixed(1)} ${y.toFixed(1)}`
    }
    const stroke = useSell ? 'rgb(238,56,46)' : 'rgb(48,209,88)'
    return { path, stroke }
  }, [history, width, height])

  if (!drawing) {
    return <span className="inline-flex items-center justify-center text-t4 text-[9px]" style={{ width, height }}>—</span>
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="inline-block align-middle">
      <path d={drawing.path} fill="none" stroke={drawing.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
})

/** ETF 호가창 — 5호가만, 선택 ETF에 대한 즉시 시세 확인 용도 */
const OrderbookPanel = memo(function OrderbookPanel({ code, etfName, ob, price }: { code: string | null; etfName: string; ob: import('@/types/market').OrderbookTick | undefined; price: number }) {
  if (!code) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-t3">
        ETF 선택 시 호가창 표시
      </div>
    )
  }
  if (!ob) {
    return (
      <div className="flex flex-col h-full">
        <div className="mb-1 text-[11px] text-t3"><span className="text-t1">{etfName}</span> 호가</div>
        <div className="flex flex-1 items-center justify-center text-[11px] text-t4">호가 수신 대기…</div>
      </div>
    )
  }
  const asks = (ob.asks ?? []).slice(0, 5)
  const bids = (ob.bids ?? []).slice(0, 5)
  // 잔량 막대 스케일 — 5호가 잔량 최댓값 기준
  const maxQty = Math.max(1, ...asks.map((l) => l.quantity), ...bids.map((l) => l.quantity))

  return (
    <div className="flex flex-col h-full text-[12px]">
      <div className="mb-1 flex items-center justify-between text-[11px] text-t3">
        <span><span className="text-t1">{etfName}</span> 호가 5단</span>
        <span className="tabular-nums text-[10px] flex gap-2">
          <span className="text-[#bb4a65]">매도 {ob.total_ask_qty.toLocaleString()}</span>
          <span className="text-[#00b26b]">매수 {ob.total_bid_qty.toLocaleString()}</span>
        </span>
      </div>
      {/* 호가창 본문 — 세로 가운데 정렬. 현재가에 매칭되는 호가에 흰색 ring 하이라이트. */}
      <div className="flex-1 flex flex-col justify-center tabular-nums gap-1">
        {asks.slice().reverse().map((l, i) => {
          const w = (l.quantity / maxQty) * 100
          const hi = price > 0 && l.price === price
          return (
            <div key={`a-${i}`} className="grid grid-cols-[1fr_84px_1fr] items-center gap-1">
              <div className="flex items-center justify-end gap-1 min-w-0 pr-1">
                <span className="text-t3 text-[11px]">{l.quantity.toLocaleString()}</span>
                <div className="h-4 bg-down/40 rounded-sm shrink-0" style={{ width: `${w * 0.8}%` }} />
              </div>
              <div className={cn(
                'text-[#bb4a65] text-center font-medium text-[12px] py-[1px] rounded-sm',
                hi && 'bg-white/20 ring-1 ring-white/40 font-semibold',
              )}>{l.price.toLocaleString()}</div>
              <div></div>
            </div>
          )
        })}
        <div className="my-1 border-t border-border/40"></div>
        {bids.map((l, i) => {
          const w = (l.quantity / maxQty) * 100
          const hi = price > 0 && l.price === price
          return (
            <div key={`b-${i}`} className="grid grid-cols-[1fr_84px_1fr] items-center gap-1">
              <div></div>
              <div className={cn(
                'text-[#00b26b] text-center font-medium text-[12px] py-[1px] rounded-sm',
                hi && 'bg-white/20 ring-1 ring-white/40 font-semibold',
              )}>{l.price.toLocaleString()}</div>
              <div className="flex items-center gap-1 min-w-0 pl-1">
                <div className="h-4 bg-up/40 rounded-sm shrink-0" style={{ width: `${w * 0.8}%` }} />
                <span className="text-t3 text-[11px]">{l.quantity.toLocaleString()}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

/** 시계열 라인 차트 — 선택 ETF의 차익bp(diffBp) 추이. signed: 양수=매수차(초록), 음수=매도차(빨강). */
const TimeSeriesChart = memo(function TimeSeriesChart({ code, etfName, history, isAuto }: { code: string | null; etfName: string; history: { t: number; diffBp: number }[]; isAuto: boolean }) {
  if (!code) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-t3">
        ETF 행 또는 막대를 클릭하면 시계열 추이가 표시됩니다.
      </div>
    )
  }
  if (history.length < 2) {
    return (
      <div className="flex flex-col h-full">
        <div className="mb-1 text-[11px] text-t3">
          <span className="text-t1">{etfName}</span> 시계열
          {isAuto && <span className="ml-1 text-t4">(Top 자동선택)</span>}
        </div>
        <div className="flex flex-1 items-center justify-center text-[11px] text-t4">
          데이터 누적 중… (5초 간격, 현재 {history.length}점)
        </div>
      </div>
    )
  }

  const W = 100
  const H = 60
  const minT = history[0].t
  const maxT = history[history.length - 1].t
  const span = Math.max(1, maxT - minT)
  const last = history[history.length - 1]
  const useSell = last.diffBp <= 0
  const vals = history.map((p) => p.diffBp)
  const minV = Math.min(...vals, 0)
  const maxV = Math.max(...vals, 0)
  const vSpan = Math.max(0.1, maxV - minV)
  const padTop = 2, padBot = 2
  const padLeft = 10  // y축 라벨 영역 (~9% of W=100, panel 폭 비례)
  const drawH = H - padTop - padBot
  const drawW = W - padLeft

  const xOf = (t: number) => padLeft + ((t - minT) / span) * drawW
  const yOf = (v: number) => padTop + (1 - (v - minV) / vSpan) * drawH

  const path = history.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.t).toFixed(2)} ${yOf(p.diffBp).toFixed(2)}`).join(' ')

  const zeroY = yOf(0)
  const baseY = H - padBot
  const area = `${path} L ${xOf(maxT).toFixed(2)} ${baseY} L ${xOf(minT).toFixed(2)} ${baseY} Z`

  const dur = ((maxT - minT) / 1000 / 60).toFixed(1)
  // 부호 컨벤션: 양수=매수차(초록), 음수=매도차(빨강)
  const areaId = useSell ? 'ts-neg-area' : 'ts-pos-area'
  const lineId = useSell ? 'ts-neg-line' : 'ts-pos-line'

  return (
    <div className="flex flex-col h-full">
      <div className="mb-1 flex items-center justify-between text-[11px] text-t3">
        <span>
          <span className="text-t1">{etfName}</span> 시계열 ({dur}분)
          {isAuto && <span className="ml-1 text-t4">(Top 자동선택)</span>}
        </span>
        <span className="flex items-center gap-3 tabular-nums">
          <span className={useSell ? 'text-down' : 'text-up'}>
            {useSell ? '매도차' : '매수차'} {fmt(last.diffBp, 1)}bp
          </span>
        </span>
      </div>
      <div className="flex-1 relative min-h-0">
        {/* y축 라벨 — SVG 위에 absolute. translate-y로 grid line 위치에 텍스트 중심 정렬. */}
        <div className="absolute left-0 top-[3.3%] -translate-y-1/2 text-[9px] text-t4 tabular-nums w-9 pr-1 text-right z-10 leading-none">{maxV.toFixed(0)}</div>
        <div className="absolute left-0 top-1/2 -translate-y-1/2 text-[9px] text-t4 tabular-nums w-9 pr-1 text-right z-10 leading-none">{((maxV + minV) / 2).toFixed(0)}</div>
        <div className="absolute left-0 bottom-[3.3%] translate-y-1/2 text-[9px] text-t4 tabular-nums w-9 pr-1 text-right z-10 leading-none">{minV.toFixed(0)}</div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full">
          <defs>
            {/* area: vertical fade, line: horizontal lighten.
                ts-pos-* = 양수=매수차=초록, ts-neg-* = 음수=매도차=빨강 */}
            <linearGradient id="ts-neg-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ee382e" stopOpacity="0.4" />
              <stop offset="50%" stopColor="#ee382e" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#ee382e" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="ts-neg-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#ff6b60" />
              <stop offset="100%" stopColor="#ee382e" />
            </linearGradient>
            <linearGradient id="ts-pos-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#30d158" stopOpacity="0.4" />
              <stop offset="50%" stopColor="#30d158" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#30d158" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="ts-pos-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#4cd964" />
              <stop offset="100%" stopColor="#30d158" />
            </linearGradient>
          </defs>
          {/* 가로 그리드 (top/mid/bottom) */}
          <line x1={padLeft} y1={padTop} x2={W} y2={padTop} stroke="currentColor" strokeOpacity="0.08" vectorEffect="non-scaling-stroke" />
          <line x1={padLeft} y1={padTop + drawH / 2} x2={W} y2={padTop + drawH / 2} stroke="currentColor" strokeOpacity="0.08" vectorEffect="non-scaling-stroke" />
          <line x1={padLeft} y1={H - padBot} x2={W} y2={H - padBot} stroke="currentColor" strokeOpacity="0.08" vectorEffect="non-scaling-stroke" />
          {/* 0선 (있으면) */}
          {minV < 0 && maxV > 0 && (
            <line x1={padLeft} y1={zeroY} x2={W} y2={zeroY} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="0.5 0.5" vectorEffect="non-scaling-stroke" />
          )}
          {/* 우세 측 한쪽만 그림 (매수=초록 / 매도=빨강) */}
          <path d={area} fill={`url(#${areaId})`} />
          <path d={path} fill="none" stroke={`url(#${lineId})`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      {/* x축 라벨 — 양쪽 끝 시각 */}
      <div className="flex justify-between text-[9px] text-t4 tabular-nums pl-9 mt-0.5">
        <span>{formatHM(minT)}</span>
        <span>{formatHM(maxT)}</span>
      </div>
    </div>
  )
})

function formatHM(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}
