import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn, todayKst } from '@/lib/utils'
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
  // 차익 거래 대상 여부. false면 fNAV/실집행/차익BP 컬럼 무의미 (레버리지/인버스/채권/혼합 등).
  // 백엔드 _is_arbitrable() 분류. 누락 시 true 폴백 (구 응답 호환).
  arbitrable: boolean
}

type PdfStock = { code: string; name: string; qty: number }
type EtfPdf = {
  code: string
  name: string
  cu_unit: number
  arbitrable: boolean
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

/** ETF 호가 기준 — 매도차 거래의 ETF 매도가 / 매수차 거래의 ETF 매수가 산출.
 *   self : 자기호가 매도=ask, 매수=bid (호가 걸고 fill)
 *   opp  : 상대호가 매도=bid, 매수=ask (cross spread)
 *   last : 현재가 (last)
 *   mid  : 중간가 ((bid+ask)/2)
 */
type QuoteMode = 'self' | 'opp' | 'last' | 'mid'

/** 종목별 배당 정보 — 만기 이전 배당락이면 이론베이시스 차감용.
 *  confirmed=false면 추정 배당 (LENS estimator 산출), true면 확정 (DART 공시). */
type DividendInfo = {
  amount: number
  ex_date: string
  record_date: string | null
  announced_at: string | null
  pay_date: string | null
  confirmed: boolean
  period: string          // ANNUAL / Q1 / Q2 등
  fiscal_year: number
  source: string          // DART / ESTIMATE
  yield_pct: number | null
  raw_text_url: string | null
  estimation_basis: string | null
}

/** YYYYMMDD → YYYY-MM-DD. 빈 문자열이거나 길이가 안 맞으면 ''. */
function expiryToIso(expiry: string | undefined): string {
  if (!expiry || expiry.length !== 8) return ''
  return `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`
}

/** 오늘(todayIso, YYYY-MM-DD)부터 만기일(YYYYMMDD)까지 달력일 수. 음수/오류 시 0.
 *  futures_master.json의 days_left 필드는 JSON 생성 시점에 고정되어 stale.
 *  매 사용 시 오늘 기준으로 직접 계산해야 정확. */
function daysFromToday(expiryYyyymmdd: string | undefined, todayIso: string): number {
  if (!expiryYyyymmdd || expiryYyyymmdd.length !== 8) return 0
  const expIso = `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`
  const today = Date.parse(`${todayIso}T00:00:00Z`)
  const exp = Date.parse(`${expIso}T00:00:00Z`)
  if (Number.isNaN(today) || Number.isNaN(exp)) return 0
  return Math.max(0, Math.round((exp - today) / 86400000))
}

/** 종목 i의 만기 이전 배당락 — total + confirmed/estimated 분해 + 항목 list.
 *  [today, futExpiryIso] 구간에 ex_date가 있는 것만 (오늘 포함 — 종목차익과 일관).
 *  오늘 ex_date면 장 시작 전 spot은 어제 종가(배당 권리 포함)이므로 M 차감해야 정확.
 *  장중엔 spot에 배당락 이미 반영되어 약간 이중 차감 가능하지만, 빠뜨리는 위험보다 작음. */
function pickDividendsInWindow(divs: DividendInfo[] | undefined, todayIso: string, futExpiryIso: string): {
  total: number; confirmed: number; estimated: number; items: DividendInfo[]
} {
  if (!divs || divs.length === 0) return { total: 0, confirmed: 0, estimated: 0, items: [] }
  let total = 0, conf = 0, est = 0
  const items: DividendInfo[] = []
  for (const d of divs) {
    if (!d.ex_date) continue
    if (d.ex_date < todayIso) continue
    if (futExpiryIso && d.ex_date > futExpiryIso) continue
    total += d.amount
    if (d.confirmed) conf += d.amount
    else est += d.amount
    items.push(d)
  }
  return { total, confirmed: conf, estimated: est, items }
}

/** 한 ETF의 metric을 계산. excluded 토글이 한 ETF만 영향이라 per-ETF 함수로 분리 →
 * base(공통) + overlay(excluded 적용) 두 useMemo가 같은 로직 공유.
 *
 * 부호 컨벤션: 매수차 = +, 매도차 = -.
 * 변수명: S=현물(spot), F=선물(futures market), N=이론가, M=배당, Q=시장베이시스(F-S),
 *   P=이론베이시스((N-S)-M), R=베이시스 갭(Q-P = F-N+M), T=갭BP(R/N·1만).
 *   R > 0: 선물이 이론보다 비쌈 → 매수차 우호 (선물 매도 이득)
 *   R < 0: 선물이 이론보다 쌈   → 매도차 우호 (선물 매수 이득)
 * V=O 가능 종목: arbMode 매칭 + excluded 아님 + 선물 가용.
 *   buy   : R>0 종목만
 *   sell  : R<0 종목만
 *   mixed : 양방향
 * 비용: 매수차 V=O = slip+tax 차감, 매도차 V=O = slip만 차감 (ETF 거래세 0, 매도차는 종목 매수라 매도세 없음).
 */
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
  ratePct: number,
  slippageBp: number,
  taxBp: number,
  quoteMode: QuoteMode,
  dividends: Map<string, DividendInfo[]>,
  todayIso: string,
): EtfMetrics {
  const cuUnit = pdf.cu_unit ?? 0
  const cash = pdf.cash || 0
  const r = ratePct / 100

  // === Pass 1: 종목별 G(현재금액) + 차익 정보 누적 ===
  type StockArb = {
    qty: number; S: number; F: number; G: number; M: number
    N: number; R: number; T: number
    favBuy: boolean; favSell: boolean
    canUse: boolean // 선물 가용 + 거래량 + 미배제
  }
  const arr: StockArb[] = new Array(pdf.stocks.length)
  let G_sum = 0
  let dividendN = 0
  // 누락 종목 추정 가치 — 라이브 S=0 인 종목의 prev_close × qty.
  // rNAV 계산엔 안 들어감 (NAV는 S만 사용). missingWeight 산출 전용.
  // prev_close 사용은 "누락 비중을 추정"하기 위한 용도지 NAV 표시값이 아님 → user 정책 위배 X.
  let missingValueEstimate = 0
  let i = 0

  for (const s of pdf.stocks) {
    if (s.qty <= 0) { i++; continue }
    const S = stockTicks[s.code]?.price ?? 0
    if (S <= 0) {
      const pc = stockTicks[s.code]?.prev_close ?? 0
      if (pc > 0) missingValueEstimate += pc * s.qty
    }
    const fm = futuresByBase.get(s.code)
    const futCode = fm?.front?.code
    const futTick = futCode ? futuresTicks[futCode] : undefined
    const F = futTick?.price ?? 0
    const futVol = futTick?.volume ?? 0
    const futExpiryIso = expiryToIso(fm?.front?.expiry)
    const daysLeft = daysFromToday(fm?.front?.expiry, todayIso)

    const div = pickDividendsInWindow(dividends.get(s.code), todayIso, futExpiryIso)
    const M = div.total
    if (M > 0) dividendN += 1

    let N = 0, R = 0, T = 0
    let favBuy = false, favSell = false
    if (S > 0 && F > 0 && daysLeft >= 0) {
      N = S * (1 + r * (daysLeft / 365))
      // R = F - (N - M). 배당이 R을 +M만큼 키움 (선물이 배당 반영해서 낮으므로).
      R = F - N + M
      T = N > 0 ? (R / N) * 10000 : 0
      favBuy = R > 0
      favSell = R < 0
    }

    const G = S * s.qty
    G_sum += G

    const canUse =
      S > 0 && F > 0 && !!futCode &&
      (minFuturesVolume === 0 || futVol >= minFuturesVolume) &&
      !exSet?.has(s.code)

    arr[i++] = { qty: s.qty, S, F, G, M, N, R, T, favBuy, favSell, canUse }
  }

  const rNAV_total = G_sum + cash
  const rNav = cuUnit > 0 ? rNAV_total / cuUnit : 0
  // 누락 비중 — 라이브 S 없는 종목들이 ETF 가치에서 차지하는 추정 비율.
  // 분모 = rNAV_total + missingValueEstimate (현재 잡힌 가치 + 누락 추정). 이게 더 정확한 전체.
  const totalEstimate = rNAV_total + missingValueEstimate
  const missingWeight = totalEstimate > 0 ? missingValueEstimate / totalEstimate : 0

  // === Pass 2: H, V=O 결정, fNAV, 매수차/매도차BP 합산 ===
  // 매수차BP_net: SUM_{R>0, V=O} (T - slip - tax)·H. ≥ 0
  // 매도차BP_net: SUM_{R<0, V=O} (T + slip)·H.       ≤ 0
  let buyArbBp = 0
  let sellArbBp = 0
  let fSum = 0
  let appliedFutValue = 0
  let futuresCount = 0

  for (let j = 0; j < arr.length; j++) {
    const it = arr[j]
    if (!it) continue
    if (it.qty <= 0 || it.S <= 0) continue
    const H = rNAV_total > 0 ? it.G / rNAV_total : 0

    let isUsed = false
    if (it.canUse) {
      if (arbMode === 'buy' && it.favBuy) isUsed = true
      else if (arbMode === 'sell' && it.favSell) isUsed = true
      else if (arbMode === 'mixed' && (it.favBuy || it.favSell)) isUsed = true
    }

    if (isUsed) {
      futuresCount += 1
      appliedFutValue += it.G
      fSum += it.F * it.qty   // V=O: 선물가로 평가
      if (it.favBuy) {
        buyArbBp += (it.T - slippageBp - taxBp) * H
      } else { // favSell
        sellArbBp += (it.T + slippageBp) * H
      }
    } else {
      fSum += it.S * it.qty   // V=X: 현물가로 평가
    }
  }

  const fNav = cuUnit > 0 ? (fSum + cash) / cuUnit : 0
  const navDiff = fNav - rNav
  const diffBp = buyArbBp + sellArbBp

  // === ETF 호가 + 실집행차익 ===
  const etfTick = etfTicks[code]
  const lastPrice = etfTick?.price ?? stockTicks[code]?.price ?? 0
  const navLive = etfTick?.nav ?? 0
  const ob = orderbookTicks[code]
  const ask1 = ob?.asks[0]?.price ?? 0
  const bid1 = ob?.bids[0]?.price ?? 0
  const mid = ask1 > 0 && bid1 > 0 ? (ask1 + bid1) / 2 : 0

  // 우세 방향 (실집행 식 분기): 모드 강제 또는 mixed에선 절댓값 큰 쪽
  const dominant: 'buy' | 'sell' | null =
    arbMode === 'buy' ? (buyArbBp > 0 ? 'buy' : null) :
    arbMode === 'sell' ? (sellArbBp < 0 ? 'sell' : null) :
    Math.abs(buyArbBp) >= Math.abs(sellArbBp)
      ? (buyArbBp > 0 ? 'buy' : null)
      : (sellArbBp < 0 ? 'sell' : null)

  // ETF 매도/매수 가격 (호가 기준 모드별).
  let etfSellPrice = 0, etfBuyPrice = 0
  if (quoteMode === 'last') { etfSellPrice = lastPrice; etfBuyPrice = lastPrice }
  else if (quoteMode === 'mid') { etfSellPrice = mid; etfBuyPrice = mid }
  else if (quoteMode === 'self') { etfSellPrice = ask1; etfBuyPrice = bid1 }
  else { etfSellPrice = bid1; etfBuyPrice = ask1 } // opp

  // 실집행차익 (per-share, 원). 부호: 매수+ / 매도-.
  // 매수차: fNAV·(1-tax) - ETF_buy, 양수=이익
  // 매도차: -(ETF_sell - fNAV),     음수=이익
  const tax = taxBp / 10000 // 0.002 for 20bp
  let realProfitWon = 0
  if (dominant === 'buy' && etfBuyPrice > 0 && fNav > 0) {
    realProfitWon = fNav * (1 - tax) - etfBuyPrice
  } else if (dominant === 'sell' && etfSellPrice > 0 && fNav > 0) {
    realProfitWon = -(etfSellPrice - fNav)
  }
  const realProfitBp = rNav > 0 ? (realProfitWon / rNav) * 10000 : 0

  // ETF 호가/가격 vs NAV 괴리 (기존 컬럼 유지). NAV는 라이브 nav 사용 (rNav가 PDF 기준 fair NAV라면 차이날 수 있어).
  const navRef = navLive > 0 ? navLive : rNav
  const priceNavBp = navRef > 0 && lastPrice > 0 ? ((lastPrice - navRef) / navRef) * 10000 : 0
  const askNavBp = navRef > 0 && ask1 > 0 ? ((ask1 - navRef) / navRef) * 10000 : 0
  const bidNavBp = navRef > 0 && bid1 > 0 ? ((bid1 - navRef) / navRef) * 10000 : 0

  const tradeValue = stockTicks[code]?.cum_volume ?? 0

  return {
    diffBp,
    buyArbBp,
    sellArbBp,
    realProfitWon,
    realProfitBp,
    fNav,
    rNav,
    nav: navLive > 0 ? navLive : rNav,
    navDiff,
    dividendN,
    pdfValue: rNAV_total,
    appliedPct: rNAV_total > 0 ? (appliedFutValue / rNAV_total) * 100 : 0,
    futuresCount,
    etfPrice: lastPrice,
    etfPrevClose: stockTicks[code]?.prev_close ?? 0,
    tradeValue,
    priceNavBp: Math.abs(priceNavBp) > 1000 ? 0 : priceNavBp,
    askNavBp: Math.abs(askNavBp) > 1000 ? 0 : askNavBp,
    bidNavBp: Math.abs(bidNavBp) > 1000 ? 0 : bidNavBp,
    missingWeight,
    arbitrable: pdf.arbitrable !== false,
  }
}

/** 두 메트릭이 모든 number 필드에서 동일한지. ref-cache용 — 같으면 이전 ref 재사용해서
 * ArbRow memo 효과 활성화. */
function metricsEqual(a: EtfMetrics, b: EtfMetrics): boolean {
  return (
    a.diffBp === b.diffBp &&
    a.buyArbBp === b.buyArbBp &&
    a.sellArbBp === b.sellArbBp &&
    a.realProfitWon === b.realProfitWon &&
    a.realProfitBp === b.realProfitBp &&
    a.fNav === b.fNav &&
    a.rNav === b.rNav &&
    a.nav === b.nav &&
    a.navDiff === b.navDiff &&
    a.dividendN === b.dividendN &&
    a.pdfValue === b.pdfValue &&
    a.appliedPct === b.appliedPct &&
    a.futuresCount === b.futuresCount &&
    a.etfPrice === b.etfPrice &&
    a.etfPrevClose === b.etfPrevClose &&
    a.tradeValue === b.tradeValue &&
    a.priceNavBp === b.priceNavBp &&
    a.askNavBp === b.askNavBp &&
    a.bidNavBp === b.bidNavBp &&
    a.missingWeight === b.missingWeight &&
    a.arbitrable === b.arbitrable
  )
}

type EtfMetrics = {
  // 부호 컨벤션: 매수차 = +, 매도차 = -.
  // diffBp = buyArbBp + sellArbBp. 혼합 모드에서 부호로 우세 방향이 보임.
  diffBp: number
  buyArbBp: number       // 매수차BP_net (≥0). R>0 종목 V=O들의 (T - slip - tax)·H 합.
  sellArbBp: number      // 매도차BP_net (≤0). R<0 종목 V=O들의 (T + slip)·H 합.
  realProfitWon: number  // 실집행차익(원, per-share). 우세 방향 따라 ETF 호가 vs fNAV 차익. 매수+/매도-.
  realProfitBp: number   // realProfitWon / rNav · 1만.
  fNav: number           // V=O 종목 K, V=X 종목 F로 평가한 fair NAV.
  rNav: number           // (SUM(F·D) + 현금) / CU. PDF 기준 NAV.
  nav: number            // 라이브 NAV (etfTick.nav). 없으면 rNav.
  navDiff: number        // fNav - rNav.
  dividendN: number      // 만기 이전 배당락 종목 수.
  pdfValue: number       // rNAV·CU 총합 (= G_sum + cash).
  appliedPct: number     // V=O 종목 G 합 / rNAV_total · 100.
  futuresCount: number   // V=O 종목 수.
  etfPrice: number       // 라이브 ETF 가격 (0이면 장 외).
  etfPrevClose: number   // 직전 영업일 종가 — 장 외 표시 폴백용.
  tradeValue: number     // 거래대금 (원). t1102 cum_volume(원) 우선.
  priceNavBp: number     // 현재가 vs NAV 괴리 (bp).
  askNavBp: number       // 매도1호가 vs NAV 괴리 (bp).
  bidNavBp: number       // 매수1호가 vs NAV 괴리 (bp).
  missingWeight: number  // 누락 종목 추정 비중 (0~1). prev_close 기반 추정. 임계값 초과 시 fNav/실집행 흐림.
  arbitrable: boolean    // false면 fNAV/실집행/차익BP 흐림. 레버리지/인버스/채권/혼합 등.
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
    | 'code' | 'name' | 'tradeValue' | 'etfPrice' | 'nav' | 'rNav' | 'fNav'
    | 'priceNavBp' | 'askNavBp' | 'bidNavBp'
    | 'diffBp' | 'buyArbBp' | 'sellArbBp'
    | 'realProfitWon' | 'realProfitBp'
    | 'dividendN' | 'appliedPct' | 'futuresCount'
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
  // 펼칠 때 ETF + PDF 종목들 우선 fetch 요청 (라이브 못 받은 잡주들 60초 안에 보충).
  const handleRowSelect = useCallback((code: string) => {
    setExpanded((prev) => {
      const willExpand = prev !== code
      if (willExpand && pdfs?.[code]) {
        const codes = [code, ...pdfs[code].stocks.map((s) => s.code)]
        fetch('/realtime/prioritize-stocks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes }),
        }).catch(() => {})
      }
      return willExpand ? code : null
    })
    setSelectedEtf(code)
  }, [pdfs])

  // PDF 테이블 정렬 — 페이지 레벨에 두어 펼침/접힘 사이 유지.
  // v2: 변수명 변경(F→S, K→F)으로 구 키 무효화.
  const [pdfSortKey, setPdfSortKey] = useState<PdfSortKey>(() => {
    const saved = localStorage.getItem('etf.pdfSortKey.v2')
    const valid: PdfSortKey[] = ['code', 'name', 'qty', 'H', 'M', 'S', 'F', 'N', 'Q', 'P', 'R', 'T', 'futVol', 'contribBp']
    return valid.includes(saved as PdfSortKey) ? (saved as PdfSortKey) : 'H'
  })
  const [pdfSortAsc, setPdfSortAsc] = useState<boolean>(() => localStorage.getItem('etf.pdfSortAsc') === '1')
  useEffect(() => { localStorage.setItem('etf.pdfSortKey.v2', pdfSortKey) }, [pdfSortKey])
  useEffect(() => { localStorage.setItem('etf.pdfSortAsc', pdfSortAsc ? '1' : '0') }, [pdfSortAsc])
  const handlePdfSort = useCallback((key: PdfSortKey) => {
    setPdfSortKey((prev) => {
      if (prev === key) {
        setPdfSortAsc((v) => !v)
        return prev
      }
      // 텍스트는 asc 디폴트, 수치는 desc.
      setPdfSortAsc(key === 'code' || key === 'name')
      return key
    })
  }, [])

  // 차익 모드 — PDF 종목 중 어느 방향만 합산할지.
  //   buy: R>0 종목만 V=O 가능 (선물 매도 이득). 매수차BP 양수. ETF 매수 거래.
  //   sell: R<0 종목만 V=O 가능 (선물 매수 이득). 매도차BP 음수. ETF 매도 거래.
  //   mixed: 양방향 모두 V=O 가능. 차익BP 부호로 우세 방향 표시.
  const [arbMode, setArbMode] = useState<ArbMode>(() => {
    const saved = localStorage.getItem('etf.arbMode')
    return saved === 'buy' || saved === 'sell' || saved === 'mixed' ? saved : 'mixed'
  })
  useEffect(() => { localStorage.setItem('etf.arbMode', arbMode) }, [arbMode])

  // 호가 기준 — ETF 매수/매도 시 어느 호가를 사용할지.
  const [quoteMode, setQuoteMode] = useState<QuoteMode>(() => {
    const saved = localStorage.getItem('etf.quoteMode')
    return saved === 'self' || saved === 'opp' || saved === 'last' || saved === 'mid' ? saved : 'opp'
  })
  useEffect(() => { localStorage.setItem('etf.quoteMode', quoteMode) }, [quoteMode])

  // 슬리피지 (bp) — 모든 V=O 종목에 균등 비용 차감.
  const [slippageBp, setSlippageBp] = useState<number>(() => {
    const saved = localStorage.getItem('etf.slippageBp')
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  useEffect(() => { localStorage.setItem('etf.slippageBp', String(slippageBp)) }, [slippageBp])

  // 금리 (%) — 이론가 N = F·(1 + r·d/365) 산출용. 종목차익과 동일 디폴트 2.8%.
  const [ratePct, setRatePct] = useState<number>(() => {
    const saved = localStorage.getItem('etf.ratePct')
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) && n >= 0 ? n : 2.8
  })
  const [rateDraft, setRateDraft] = useState<string>(() => String(ratePct))
  useEffect(() => { localStorage.setItem('etf.ratePct', String(ratePct)) }, [ratePct])
  const commitRate = () => {
    const n = parseFloat(rateDraft)
    if (Number.isFinite(n) && n >= 0) setRatePct(n)
    else setRateDraft(String(ratePct))
  }

  // 거래세 (%) — 종목 매도세. 한국 거래세 0.20% (제도 변경 시 수정 가능). 표시 + 매수차 계산.
  const TAX_PCT = 0.20

  // 누락 비중 임계값 (%) — PDF 종목 중 라이브 가격 없는 비중이 이 값 초과 시
  // fNAV / 실집행차익 / 실집행BP 컬럼 흐림 처리 (의심값 가림). 디폴트 1%.
  // 내부망 데이터 완전 → 누락 0% → 자동 비활성. 외부망에서만 trigger.
  const [maxMissingPct, setMaxMissingPct] = useState<number>(() => {
    const saved = localStorage.getItem('etf.maxMissingPct')
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) && n >= 0 ? n : 1
  })
  useEffect(() => { localStorage.setItem('etf.maxMissingPct', String(maxMissingPct)) }, [maxMissingPct])

  // 배당 정보 — code → 가장 가까운 미래 배당. 만기 이전 배당락이면 이론베이시스 차감.
  const [dividends, setDividends] = useState<Map<string, DividendInfo[]>>(new Map())

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
    // 오늘 이후 배당만 fetch — 과거 배당은 이론베이시스 산출에 무관. KST 기준.
    const today = todayKst()
    Promise.all([
      fetch('/api/etfs').then((r) => r.json()),
      fetch('/api/etfs/pdf-all').then((r) => r.json()),
      fetch('/api/arbitrage/master').then((r) => r.json()),
      fetch(`/api/dividends?from_date=${today}&include_estimates=true`).then((r) => r.json()),
    ])
      .then(([mEtf, mPdf, mFut, mDiv]) => {
        // 구 응답 호환: arbitrable 누락 시 true 폴백 (기존 동작 유지).
        const masterItems: EtfMaster[] = (mEtf.items ?? []).map((e: EtfMaster) => ({
          ...e,
          arbitrable: e.arbitrable ?? true,
        }))
        setMaster(masterItems)
        setLoadedAt(mEtf.loaded_at)
        const pdfItems: Record<string, EtfPdf> = {}
        for (const [k, v] of Object.entries(mPdf.items ?? {} as Record<string, EtfPdf>)) {
          pdfItems[k] = { ...v, arbitrable: v.arbitrable ?? true }
        }
        setPdfs(pdfItems)
        setFuturesMaster(mFut)
        const dmap = new Map<string, DividendInfo[]>()
        for (const it of mDiv.items ?? []) {
          if (!it.code || !it.ex_date || !(it.amount > 0)) continue
          const arr = dmap.get(it.code) ?? []
          arr.push({
            amount: it.amount,
            ex_date: it.ex_date,
            record_date: it.record_date ?? null,
            announced_at: it.announced_at ?? null,
            pay_date: it.pay_date ?? null,
            confirmed: it.confirmed !== false,
            period: it.period ?? '',
            fiscal_year: it.fiscal_year ?? 0,
            source: it.source ?? '',
            yield_pct: typeof it.yield_pct === 'number' ? it.yield_pct : null,
            raw_text_url: it.raw_text_url ?? null,
            estimation_basis: it.estimation_basis ?? null,
          })
          dmap.set(it.code, arr)
        }
        setDividends(dmap)
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
  // ETF 거래량 desc 정렬해서 큰 ETF의 PDF 종목들이 먼저 fetch되도록.
  // localStorage 캐시(이전 세션 cum_volume)에 의존 — 첫 mount 후 30초 안에 누적되어 다음 mount부터 효과.
  // 선물은 ls_api 모드에선 fixed group의 auto_spread로 front 월물 자동 구독되지만, mock에서는
  // 명시적으로 subscribe-stocks에 A+7 코드 포함시켜야 mock이 futures tick 생성.
  const stockSubscriptionCodes = useMemo(() => {
    if (!pdfs || !master) return [] as string[]
    // ETF 거래량 캐시 — localStorage에 30초마다 저장됨 (아래 useEffect).
    const etfVolCache: Record<string, number> = (() => {
      try {
        const raw = localStorage.getItem('etf.volumeCache.v1')
        return raw ? (JSON.parse(raw) as Record<string, number>) : {}
      } catch { return {} }
    })()
    // ETF 거래량 desc 정렬. 캐시 없는 ETF는 0 → 마지막. 동일값은 stable order.
    const sortedEtfs = [...master].sort((a, b) => {
      const va = etfVolCache[a.code] ?? 0
      const vb = etfVolCache[b.code] ?? 0
      return vb - va
    })
    const all = new Set<string>()
    // ETF 단위로 묶음 추가 — Set이라 중복 종목 자동 dedup, 첫 등장 ETF의 우선순위 적용.
    for (const etf of sortedEtfs) {
      all.add(etf.code)
      const pdf = pdfs[etf.code]
      if (!pdf) continue
      for (const s of pdf.stocks) {
        all.add(s.code)
        const fm = futuresByBase.get(s.code)
        if (fm?.front?.code) all.add(fm.front.code)
      }
    }
    return Array.from(all)
  }, [master, pdfs, futuresByBase])

  usePageStockSubscriptions(stockSubscriptionCodes)

  // ETF 거래량 캐시 주기적 저장 — stockTicks의 cum_volume 기준. 30초마다.
  // 다음 mount 시 stockSubscriptionCodes useMemo가 이 값으로 정렬.
  // 내부망 모드도 무해 (어차피 즉시 도착하므로 정렬 효과 없음).
  useEffect(() => {
    if (!master) return
    const save = () => {
      const s = useMarketStore.getState()
      const cache: Record<string, number> = {}
      for (const etf of master) {
        const v = s.stockTicks[etf.code]?.cum_volume ?? 0
        if (v > 0) cache[etf.code] = v
      }
      if (Object.keys(cache).length > 0) {
        try { localStorage.setItem('etf.volumeCache.v1', JSON.stringify(cache)) } catch {}
      }
    }
    const id = setInterval(save, 30000)
    return () => clearInterval(id)
  }, [master])

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
  // 오늘 ISO 날짜 — 배당 만기-이전 필터용. 세션 동안 동일.
  const todayIso = useMemo(() => todayKst(), [])
  const taxBp = TAX_PCT * 100 // 0.20% = 20bp

  const baseMetricsRefCache = useRef<Record<string, EtfMetrics>>({})
  const baseMetricsByCode = useMemo(() => {
    const out: Record<string, EtfMetrics> = {}
    const cache = baseMetricsRefCache.current
    if (!pdfs) { baseMetricsRefCache.current = out; return out }
    for (const [code, pdf] of Object.entries(pdfs)) {
      const newM = computeMetric(code, pdf, undefined, stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode, ratePct, slippageBp, taxBp, quoteMode, dividends, todayIso)
      const cached = cache[code]
      out[code] = cached && metricsEqual(cached, newM) ? cached : newM
    }
    baseMetricsRefCache.current = out
    return out
  }, [pdfs, stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode, ratePct, slippageBp, taxBp, quoteMode, dividends, todayIso])

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
      const newM = computeMetric(code, pdf, excluded[code], stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode, ratePct, slippageBp, taxBp, quoteMode, dividends, todayIso)
      const cached = cache[code]
      out[code] = cached && metricsEqual(cached, newM) ? cached : newM
    }
    metricsRefCache.current = out
    return out
  }, [baseMetricsByCode, excluded, pdfs, stockTicks, futuresTicks, etfTicks, orderbookTicks, futuresByBase, minFuturesVolume, arbMode, ratePct, slippageBp, taxBp, quoteMode, dividends, todayIso])


  const naturalRows = useMemo(() => {
    if (!master) return [] as EtfMaster[]
    // 텍스트 정렬은 오름차순, 그 외 (수치)는 내림차순.
    // 모든 sort는 "강도(strength) 내림차순". 매수는 음수 클수록 강하므로 -buyBp.
    // 괴리 컬럼들도 매수가 강한 ETF가 위에 오게 하려면 별도 처리하나, 여기선 기본 signed 값 그대로
    // 내림차순 (양수 큰 = 매도 premium 큰 ETF 위로). 매수 신호 보고 싶으면 다시 클릭해서 toggle 가능.
    // 비차익 ETF가 끝으로 가야 하는 컬럼: rNAV/fNAV/차익/실집행/적용%/배당/선물수.
    // 차익과 무관한 컬럼(거래대금/가격/iNAV/괴리bp)은 비차익도 정상 정렬.
    const ARBITRAGE_SORT_KEYS = new Set<SortKey>([
      'rNav', 'fNav', 'diffBp', 'buyArbBp', 'sellArbBp',
      'realProfitWon', 'realProfitBp',
      'dividendN', 'appliedPct', 'futuresCount',
    ])
    const valueOf = (etf: EtfMaster): number => {
      const m = metricsByCode[etf.code]
      if (!m) return 0
      switch (sortKey) {
        case 'tradeValue': return m.tradeValue
        case 'etfPrice': return m.etfPrice
        case 'nav': return m.nav
        case 'rNav': return m.rNav
        case 'fNav': return m.fNav
        case 'priceNavBp': return m.priceNavBp
        case 'askNavBp': return m.askNavBp
        case 'bidNavBp': return m.bidNavBp
        case 'diffBp': return m.diffBp           // signed: 매수+, 매도-
        case 'buyArbBp': return m.buyArbBp       // ≥0
        case 'sellArbBp': return m.sellArbBp     // ≤0. desc 정렬 시 매도차 강한 ETF가 위로
        case 'realProfitWon': return m.realProfitWon
        case 'realProfitBp': return m.realProfitBp
        case 'dividendN': return m.dividendN
        case 'appliedPct': return m.appliedPct
        case 'futuresCount': return m.futuresCount
        default: return 0
      }
    }
    const isArbSort = ARBITRAGE_SORT_KEYS.has(sortKey)
    // tier: 차익 컬럼 정렬 시 비차익은 1(끝), 차익은 0(앞). 그 외 컬럼은 모두 0.
    const tierOf = (etf: EtfMaster): number => {
      if (!isArbSort) return 0
      const m = metricsByCode[etf.code]
      return m && m.arbitrable === false ? 1 : 0
    }
    // ETF row 필터 (절댓값 기반 임계 통과만)
    const filtered = master.filter((etf) => {
      const m = metricsByCode[etf.code]
      if (!m) return true   // metric 아직 미계산 → 표시
      if (minDiffBp > 0 && Math.abs(m.diffBp) < minDiffBp) return false
      if (minTradeProfit > 0 && Math.abs(m.realProfitWon) < minTradeProfit) return false
      return true
    })
    const sorted = [...filtered]
    const dir = sortAsc ? 1 : -1
    sorted.sort((a, b) => {
      // 차익 컬럼 정렬: 비차익 ETF 무조건 끝 (asc/desc 무관)
      const ta = tierOf(a), tb = tierOf(b)
      if (ta !== tb) return ta - tb
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
              <>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]">
                  <FilterField label="차익 방향">
                    <div className="flex items-center gap-0.5">
                      <Quick on={arbMode === 'buy'} onClick={() => setArbMode('buy')}>매수차만</Quick>
                      <Quick on={arbMode === 'sell'} onClick={() => setArbMode('sell')}>매도차만</Quick>
                      <Quick on={arbMode === 'mixed'} onClick={() => setArbMode('mixed')}>혼합</Quick>
                    </div>
                  </FilterField>
                  <FilterField label="호가 기준">
                    <div className="flex items-center gap-0.5">
                      <Quick on={quoteMode === 'last'} onClick={() => setQuoteMode('last')}>현재가</Quick>
                      <Quick on={quoteMode === 'self'} onClick={() => setQuoteMode('self')}>자기호가</Quick>
                      <Quick on={quoteMode === 'opp'} onClick={() => setQuoteMode('opp')}>상대호가</Quick>
                      <Quick on={quoteMode === 'mid'} onClick={() => setQuoteMode('mid')}>중간가</Quick>
                    </div>
                  </FilterField>
                  <FilterField label="슬리피지">
                    <NumInput value={slippageBp} step={0.1} onChange={setSlippageBp} width={56} suffix="bp" />
                  </FilterField>
                  <FilterField label="누락한도">
                    <NumInput value={maxMissingPct} step={0.5} onChange={setMaxMissingPct} width={56} suffix="%" />
                  </FilterField>
                  <div className="flex items-center gap-2 rounded-md bg-[#1e1e22] px-3 py-1.5">
                    <span className="text-[11px] text-[#8b8b8e]">금리</span>
                    <input
                      type="number"
                      step="0.1"
                      value={rateDraft}
                      onChange={(e) => setRateDraft(e.target.value)}
                      onBlur={commitRate}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                      className="w-12 bg-transparent text-[12px] text-white tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
                    />
                    <span className="text-[11px] text-[#8b8b8e]">%</span>
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-[#1e1e22] px-3 py-1.5">
                    <span className="text-[11px] text-[#8b8b8e]">거래세</span>
                    <span className="text-[12px] text-white tabular-nums">{TAX_PCT.toFixed(2)}</span>
                    <span className="text-[11px] text-[#8b8b8e]">%</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px]">
                  <FilterField label="선물거래량 ≥">
                    <NumInput value={minFuturesVolume} onChange={setMinFuturesVolume} width={64} />
                    <Quick on={minFuturesVolume === 100} onClick={() => setMinFuturesVolume((p) => p === 100 ? 0 : 100)}>100+</Quick>
                    <Quick on={minFuturesVolume === 1000} onClick={() => setMinFuturesVolume((p) => p === 1000 ? 0 : 1000)}>1,000+</Quick>
                    <Quick on={minFuturesVolume === 0} onClick={() => setMinFuturesVolume(0)}>전체</Quick>
                  </FilterField>
                  <FilterField label="|차익bp| ≥">
                    <NumInput value={minDiffBp} step={0.1} onChange={setMinDiffBp} width={48} suffix="bp" />
                    <Quick on={minDiffBp === 10} onClick={() => setMinDiffBp((p) => p === 10 ? 0 : 10)}>10+</Quick>
                    <Quick on={minDiffBp === 30} onClick={() => setMinDiffBp((p) => p === 30 ? 0 : 30)}>30+</Quick>
                    <Quick on={minDiffBp === 0} onClick={() => setMinDiffBp(0)}>전체</Quick>
                  </FilterField>
                  <FilterField label="|실집행차익| ≥">
                    <NumInput value={minTradeProfit} step={1} onChange={setMinTradeProfit} width={56} suffix="원" />
                    <Quick on={minTradeProfit === 1} onClick={() => setMinTradeProfit((p) => p === 1 ? 0 : 1)}>1+</Quick>
                    <Quick on={minTradeProfit === 10} onClick={() => setMinTradeProfit((p) => p === 10 ? 0 : 10)}>10+</Quick>
                    <Quick on={minTradeProfit === 0} onClick={() => setMinTradeProfit(0)}>전체</Quick>
                  </FilterField>
                </div>
              </>
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
          {/* width 100% + minWidth 1404 → 컨테이너 좁으면 가로 스크롤, 넓으면 추이 컬럼이 남는 공간 흡수.
              추이 col만 width 미지정 (tableLayout: fixed에서 명시 안 한 col은 남는 공간 차지). */}
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: '100%', minWidth: '1564px' }}>
            <colgroup>
              <col style={{ width: 180 }} />{/* 종목 */}
              <col style={{ width: 96 }} />{/* 거래대금 */}
              <col style={{ width: 78 }} />{/* 현재가 */}
              <col style={{ width: 78 }} />{/* iNAV */}
              <col style={{ width: 78 }} />{/* rNAV */}
              <col style={{ width: 78 }} />{/* fNAV */}
              <col style={{ width: 76 }} />{/* 현재괴리 */}
              <col style={{ width: 76 }} />{/* 매도괴리 */}
              <col style={{ width: 76 }} />{/* 매수괴리 */}
              <col style={{ width: 80 }} />{/* 매수차BP */}
              <col style={{ width: 80 }} />{/* 매도차BP */}
              <col style={{ width: 76 }} />{/* 차익bp */}
              <col style={{ width: 100 }} />{/* 실집행차익(원) */}
              <col style={{ width: 80 }} />{/* 실집행BP */}
              <col style={{ width: 56 }} />{/* 배당수 */}
              <col style={{ width: 60 }} />{/* 선물비중 */}
              <col style={{ width: 56 }} />{/* 선물수 */}
              <col />{/* 추이 — 남는 공간 흡수 (min 160px guarantee는 minWidth로) */}
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="text-[12px] text-[#8b8b8e] bg-black">
                <ArbTh sort={() => handleSort('name')} active={sortKey === 'name'} asc={sortAsc} left sticky className="pl-4">종목</ArbTh>
                <ArbTh sort={() => handleSort('tradeValue')} active={sortKey === 'tradeValue'} asc={sortAsc}>거래대금</ArbTh>
                <ArbTh sort={() => handleSort('etfPrice')} active={sortKey === 'etfPrice'} asc={sortAsc}>현재가</ArbTh>
                <ArbTh sort={() => handleSort('nav')} active={sortKey === 'nav'} asc={sortAsc} title="iNAV — 거래소 발행 실시간 NAV (LS API I5_ feed). 모든 ETF 공통.">iNAV</ArbTh>
                <ArbTh sort={() => handleSort('rNav')} active={sortKey === 'rNav'} asc={sortAsc} title="현물 NAV — (SUM(S·D)+현금)/CU 자체 산출. 비차익 ETF는 PDF 처리가 깨져 흐림.">rNAV</ArbTh>
                <ArbTh sort={() => handleSort('fNav')} active={sortKey === 'fNav'} asc={sortAsc} title="선물대체 NAV. V=O 종목은 K로 평가">fNAV</ArbTh>
                <ArbTh sort={() => handleSort('priceNavBp')} active={sortKey === 'priceNavBp'} asc={sortAsc}>현재 괴리</ArbTh>
                <ArbTh sort={() => handleSort('askNavBp')} active={sortKey === 'askNavBp'} asc={sortAsc}>매도 괴리</ArbTh>
                <ArbTh sort={() => handleSort('bidNavBp')} active={sortKey === 'bidNavBp'} asc={sortAsc}>매수 괴리</ArbTh>
                <ArbTh sort={() => handleSort('buyArbBp')} active={sortKey === 'buyArbBp'} asc={sortAsc} title="매수차BP_net. R>0 종목 V=O들의 (T-slip-tax)·H 합">매수차BP</ArbTh>
                <ArbTh sort={() => handleSort('sellArbBp')} active={sortKey === 'sellArbBp'} asc={sortAsc} title="매도차BP_net. R<0 종목 V=O들의 (T+slip)·H 합. 음수=이익">매도차BP</ArbTh>
                <ArbTh sort={() => handleSort('diffBp')} active={sortKey === 'diffBp'} asc={sortAsc} title="매수차BP + 매도차BP. 부호로 우세 방향">차익bp</ArbTh>
                <ArbTh sort={() => handleSort('realProfitWon')} active={sortKey === 'realProfitWon'} asc={sortAsc} title="실집행차익(1 CU 기준 원). ETF 호가 vs fNAV 차익 (매수차는 매도세 차감)">실집행차익</ArbTh>
                <ArbTh sort={() => handleSort('realProfitBp')} active={sortKey === 'realProfitBp'} asc={sortAsc}>실집행BP</ArbTh>
                <ArbTh sort={() => handleSort('dividendN')} active={sortKey === 'dividendN'} asc={sortAsc} title="만기 이전 배당락 종목 수">배당수</ArbTh>
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
                      maxMissingFrac={maxMissingPct / 100}
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
                    <td colSpan={18} className="p-0">
                      <ExpandedPanel
                        pdf={entry.pdf}
                        etfCode={entry.etfCode}
                        metrics={metricsByCode[entry.etfCode]}
                        futuresByBase={futuresByBase}
                        excluded={excluded[entry.etfCode] ?? EMPTY_SET}
                        onToggle={toggleExclude}
                        stockTicks={stockTicks}
                        futuresTicks={futuresTicks}
                        arbMode={arbMode}
                        ratePct={ratePct}
                        slippageBp={slippageBp}
                        taxBp={taxBp}
                        minFuturesVolume={minFuturesVolume}
                        dividends={dividends}
                        todayIso={todayIso}
                        pdfSortKey={pdfSortKey}
                        pdfSortAsc={pdfSortAsc}
                        onPdfSort={handlePdfSort}
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
  stockTicks: Record<string, import('@/types/market').StockTick>
  futuresTicks: Record<string, import('@/types/market').FuturesTick>
  // 차익 계산 입력
  arbMode: ArbMode
  ratePct: number
  slippageBp: number
  taxBp: number
  minFuturesVolume: number
  dividends: Map<string, DividendInfo[]>
  todayIso: string
  pdfSortKey: PdfSortKey
  pdfSortAsc: boolean
  onPdfSort: (key: PdfSortKey) => void
}

/** PDF 테이블 정렬 키 — 모든 컬럼 정렬 가능. */
type PdfSortKey =
  | 'code' | 'name' | 'qty' | 'H' | 'M'
  | 'S' | 'F' | 'N' | 'Q' | 'P' | 'R' | 'T'
  | 'futVol' | 'contribBp'

/** 종목 단위 차익 정보 — ExpandedPanel에서 각 PDF 행마다 계산해 PdfRow에 전달.
 *  변수명: S=현물(spot), F=선물 시장가(futures), N=이론가(theoretical forward),
 *   Q=시장베이시스(F-S), P=이론베이시스(N-S-M), R=베이시스 갭(Q-P), T=갭BP, M=배당. */
type StockArbInfo = {
  S: number; F: number; futVol: number
  N: number; Q: number; P: number; R: number; T: number; M: number
  M_confirmed: number  // 확정 배당 합 (DART)
  M_estimated: number  // 추정 배당 합 (LENS estimator)
  M_items: DividendInfo[]  // tooltip용 항목 list (만기 이전 윈도우 안에 있는 배당들)
  H: number          // 비중 (0~1)
  hasFut: boolean
  favBuy: boolean    // R > 0
  favSell: boolean   // R < 0
  modeMatch: boolean // arbMode와 우호 방향 일치
  canToggle: boolean // 사용자가 V=O 토글할 수 있는지 (선물 가용 + 모드 매칭)
  isUsed: boolean    // 실제 V=O 적용 (canToggle && !excluded)
  contribBp: number  // 사용 시 ETF 차익 BP에 더해지는 값. 부호: 매수+/매도-.
}

/** PDF 행 — 14컬럼. 가격/contribBp/V=O만 변할 때 렌더. */
const PdfRow = memo(function PdfRow({
  code, name, qty, info, isExcluded, etfCode, onToggle,
}: {
  code: string; name: string; qty: number
  info: StockArbInfo
  isExcluded: boolean
  etfCode: string; onToggle: (etfCode: string, stockCode: string) => void
}) {
  const { S, F, futVol, N, Q, P, R, T, M, M_confirmed, M_estimated, M_items, H, hasFut, favBuy, favSell, modeMatch, canToggle, isUsed, contribBp } = info

  // 행 배경 — V=O 적용 시 우호 방향 색조 약하게.
  const rowBg = isUsed
    ? (favBuy ? 'bg-[#00b26b]/[0.06]' : 'bg-[#bb4a65]/[0.06]')
    : ''
  const dimmed = !modeMatch || !hasFut

  // 갭BP / 기여BP 색상 (부호: 매수+ 초록, 매도- 빨강).
  const tColor = !hasFut ? 'text-[#5a5a5e]' : T > 0.001 ? 'text-[#00b26b]' : T < -0.001 ? 'text-[#bb4a65]' : 'text-[#8b8b8e]'
  const contribColor = !isUsed ? 'text-[#5a5a5e]' : contribBp > 0 ? 'text-[#00b26b]' : contribBp < 0 ? 'text-[#bb4a65]' : 'text-[#8b8b8e]'

  return (
    <tr className={cn(
      'border-b border-white/[0.03] hover:bg-[#1a1a1c] transition-colors',
      rowBg,
      dimmed && 'opacity-40',
    )}>
      <td className="py-1 pl-4 pr-2 font-mono text-[10.5px] text-[#8b8b8e]">{code}</td>
      <td className={cn('py-1 px-2 text-[11px] truncate', hasFut ? 'text-white' : 'text-[#a8a8ae]')}>
        {name}{!hasFut && <span className="ml-1 text-[9px] text-[#7a7a7e]">·선물無</span>}
      </td>
      <td className="py-1 px-2 text-right text-[11px] tabular-nums text-[#d1d1d6]">{qty.toLocaleString()}</td>
      <td className="py-1 px-2 text-right text-[11px] tabular-nums">
        {/* 비중 mini bar */}
        <div className="flex items-center justify-end gap-1.5">
          <div className="w-8 h-1 bg-[#2a2a2e] rounded-sm overflow-hidden">
            <div className="h-full bg-[#4a4a4e]" style={{ width: `${Math.min(100, H * 100)}%` }} />
          </div>
          <span className="text-[#d1d1d6] w-9">{(H * 100).toFixed(2)}%</span>
        </div>
      </td>
      <td className="py-1 px-2 text-right text-[11px] tabular-nums relative group/div">
        {M > 0 ? (() => {
          // 색: 모두 확정 → 초록, 모두 예상 → 오렌지, 혼합 → 흰색.
          const allConfirmed = M_estimated === 0
          const allEstimated = M_confirmed === 0
          const color = allConfirmed ? 'text-[#00b26b]' : allEstimated ? 'text-[#ff9f0a]' : 'text-white'
          const badge = allConfirmed ? null : allEstimated ? '예상' : '혼'
          return (
            <>
              <span className="inline-flex items-center justify-end gap-1 cursor-help">
                <span className={color}>{M.toLocaleString()}</span>
                {badge && <span className={cn('text-[8.5px] font-medium uppercase', allEstimated ? 'text-[#ff9f0a]' : 'text-[#8b8b8e]')}>{badge}</span>}
              </span>
              <DividendTooltip items={M_items} />
            </>
          )
        })() : <span className="text-[#5a5a5e]">—</span>}
      </td>
      <td className="py-1 px-2 text-right text-[11px] tabular-nums text-[#d1d1d6]">{S > 0 ? S.toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums', F > 0 ? 'text-[#d1d1d6]' : 'text-[#5a5a5e]')}>{F > 0 ? F.toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums', N > 0 ? 'text-[#d1d1d6]' : 'text-[#5a5a5e]')}>{N > 0 ? Math.round(N).toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums', hasFut ? (Q > 0 ? 'text-[#00b26b]' : Q < 0 ? 'text-[#bb4a65]' : 'text-[#8b8b8e]') : 'text-[#5a5a5e]')}>{hasFut ? Math.round(Q).toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums', N > 0 ? 'text-[#8b8b8e]' : 'text-[#5a5a5e]')}>{N > 0 ? Math.round(P).toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums', hasFut ? (R > 0 ? 'text-[#00b26b]' : R < 0 ? 'text-[#bb4a65]' : 'text-[#8b8b8e]') : 'text-[#5a5a5e]')}>{hasFut ? Math.round(R).toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums font-medium', tColor)}>{hasFut && Math.abs(T) > 0.001 ? formatBp(T) : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums', futVol > 0 ? 'text-[#8b8b8e]' : 'text-[#5a5a5e]')}>{futVol > 0 ? futVol.toLocaleString() : '—'}</td>
      <td className={cn('py-1 px-2 text-right text-[11px] tabular-nums font-medium', contribColor)}>{isUsed && Math.abs(contribBp) > 0.001 ? formatBp(contribBp) : '—'}</td>
      <td className="py-1 px-2 text-center">
        <input
          type="checkbox"
          checked={!isExcluded && canToggle}
          disabled={!canToggle}
          onChange={() => onToggle(etfCode, code)}
          className={cn('accent-accent w-3 h-3', !canToggle && 'cursor-not-allowed opacity-30')}
          title={!hasFut ? '선물 없음' : !modeMatch ? `현재 모드(${arbModeLabel(favBuy, favSell)})와 불일치` : ''}
        />
      </td>
    </tr>
  )
})

/** 우호 방향 한글 — disabled 툴팁용. */
function arbModeLabel(favBuy: boolean, favSell: boolean): string {
  if (favBuy) return '매수차 우호'
  if (favSell) return '매도차 우호'
  return '중립'
}

/** ANNUAL → Y, 그 외 (Q1~Q4, H1~H2)는 그대로. */
function periodShort(period: string): string {
  if (!period) return ''
  if (period === 'ANNUAL') return 'Y'
  return period
}

/** 배당 source 색상 배지. */
function SourceBadge({ source }: { source: string }) {
  const cls: Record<string, string> = {
    DART: 'bg-[#0a84ff]/12 text-[#5b9dff]',
    SEIBro: 'bg-[#34c759]/12 text-[#5cd97a]',
    KRX: 'bg-[#34c759]/12 text-[#5cd97a]',
    ESTIMATE: 'bg-[#ff9f0a]/12 text-[#ff9f0a]',
  }
  return (
    <span className={cn('font-mono text-[9px] px-1 py-0.5 rounded-sm', cls[source] ?? 'bg-[#2a2a2e] text-[#8b8b8e]')}>
      {source}
    </span>
  )
}

/** PdfRow 배당 셀 hover 툴팁 — 만기 윈도우 안 배당 항목별 상세 정보.
 *  배당 페이지 DetailPanel의 카드 형식과 동일. 부모에 group/div + cursor-help 필요. */
function DividendTooltip({ items }: { items: DividendInfo[] }) {
  if (!items || items.length === 0) return null
  return (
    <div className="hidden group-hover/div:block absolute z-50 right-0 top-full mt-1 w-72 bg-[#16161a] border border-white/[0.08] rounded shadow-xl p-2 text-left pointer-events-none space-y-1.5">
      {items.map((d, i) => (
        <DividendCard key={`${d.ex_date}-${i}`} d={d} />
      ))}
    </div>
  )
}

function DividendCard({ d }: { d: DividendInfo }) {
  return (
    <div className={cn(
      'rounded p-2 border-l-[3px]',
      d.confirmed ? 'border-l-[#34c759] bg-[#34c759]/5' : 'border-l-[#ff9f0a] bg-[#ff9f0a]/5',
    )}>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-mono text-[11px] text-white tabular-nums">{d.ex_date}</span>
        <div className="flex items-center gap-1">
          {d.period && (
            <span className="font-mono text-[9px] px-1 py-0.5 rounded-sm bg-[#2a2a2e] text-[#d1d1d6]">
              {periodShort(d.period)} {d.fiscal_year ? String(d.fiscal_year).slice(2) : ''}
            </span>
          )}
          {d.source && <SourceBadge source={d.source} />}
          <span className={cn(
            'font-mono text-[9px] font-semibold px-1 py-0.5 rounded-sm',
            d.confirmed ? 'bg-[#34c759]/12 text-[#5cd97a]' : 'bg-[#ff9f0a]/12 text-[#ff9f0a]'
          )}>
            {d.confirmed ? '확정' : '예상'}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
        <div className="flex justify-between"><span className="text-[#8b8b8e]">배당금</span><span className="text-white tabular-nums">{d.amount.toLocaleString()}원</span></div>
        <div className="flex justify-between"><span className="text-[#8b8b8e]">수익률</span><span className="text-white tabular-nums">{d.yield_pct != null ? `${d.yield_pct.toFixed(2)}%` : '-'}</span></div>
        <div className="flex justify-between"><span className="text-[#8b8b8e]">기준일</span><span className="text-[#d1d1d6] tabular-nums">{d.record_date ?? '-'}</span></div>
        <div className="flex justify-between"><span className="text-[#8b8b8e]">공시일</span><span className="text-[#d1d1d6] tabular-nums">{d.announced_at?.slice(0, 10) ?? '-'}</span></div>
      </div>
    </div>
  )
}

function ExpandedPanel({
  pdf, etfCode, metrics, futuresByBase, excluded, onToggle,
  stockTicks, futuresTicks, arbMode, ratePct, slippageBp, taxBp, minFuturesVolume,
  dividends, todayIso, pdfSortKey, pdfSortAsc, onPdfSort,
}: ExpandedPanelProps) {
  const cash = pdf.cash || 0
  const cuUnit = pdf.cu_unit ?? 0
  const r = ratePct / 100

  // 종목별 arb info 계산 — 펼친 ETF만 영향, 200ms tick에 재계산.
  const stockInfos = useMemo<Map<string, StockArbInfo>>(() => {
    type Pre = StockArbInfo & { code: string; G: number }
    const arr: Pre[] = []
    let G_sum = 0
    for (const s of pdf.stocks) {
      const S = stockTicks[s.code]?.price ?? 0
      const fm = futuresByBase.get(s.code)
      const futCode = fm?.front?.code
      const futTick = futCode ? futuresTicks[futCode] : undefined
      const F = futTick?.price ?? 0
      const futVol = futTick?.volume ?? 0
      const futExpiryIso = expiryToIso(fm?.front?.expiry)
      const daysLeft = daysFromToday(fm?.front?.expiry, todayIso)
      const div = pickDividendsInWindow(dividends.get(s.code), todayIso, futExpiryIso)
      const M = div.total
      let N = 0, Q = 0, R = 0, T = 0, P = 0
      let favBuy = false, favSell = false
      if (S > 0 && F > 0 && daysLeft >= 0) {
        N = S * (1 + r * (daysLeft / 365))
        Q = F - S
        P = (N - S) - M
        R = F - N + M
        T = N > 0 ? (R / N) * 10000 : 0
        favBuy = R > 0
        favSell = R < 0
      }
      const G = S * s.qty
      G_sum += G
      const hasFut = !!futCode && F > 0 && (minFuturesVolume === 0 || futVol >= minFuturesVolume)
      const modeMatch =
        arbMode === 'mixed' ? (favBuy || favSell) :
        arbMode === 'buy' ? favBuy :
        arbMode === 'sell' ? favSell : false
      const canToggle = hasFut && modeMatch
      const isUsed = canToggle && !excluded.has(s.code)
      arr.push({
        code: s.code, S, F, futVol, N, Q, P, R, T, M,
        M_confirmed: div.confirmed, M_estimated: div.estimated, M_items: div.items,
        G, H: 0, hasFut, favBuy, favSell, modeMatch, canToggle, isUsed,
        contribBp: 0,
      })
    }
    const total = G_sum + cash
    const map = new Map<string, StockArbInfo>()
    for (const it of arr) {
      const H = total > 0 ? it.G / total : 0
      let contribBp = 0
      if (it.isUsed) {
        if (it.favBuy) contribBp = (it.T - slippageBp - taxBp) * H
        else if (it.favSell) contribBp = (it.T + slippageBp) * H
      }
      const { code: _c, G: _G, ...rest } = it
      map.set(it.code, { ...rest, H, contribBp })
    }
    return map
  }, [pdf, stockTicks, futuresTicks, futuresByBase, dividends, todayIso, ratePct, slippageBp, taxBp, minFuturesVolume, arbMode, excluded, cash, r])

  // 정렬된 종목 목록.
  const sortedStocks = useMemo(() => {
    const dir = pdfSortAsc ? 1 : -1
    const list = [...pdf.stocks]
    if (pdfSortKey === 'code') return list.sort((a, b) => a.code.localeCompare(b.code) * dir)
    if (pdfSortKey === 'name') return list.sort((a, b) => a.name.localeCompare(b.name) * dir)
    if (pdfSortKey === 'qty') return list.sort((a, b) => (b.qty - a.qty) * (pdfSortAsc ? -1 : 1))
    return list.sort((a, b) => {
      const ia = stockInfos.get(a.code)
      const ib = stockInfos.get(b.code)
      const va = ia ? (ia[pdfSortKey] as number) ?? 0 : 0
      const vb = ib ? (ib[pdfSortKey] as number) ?? 0 : 0
      return (vb - va) * (pdfSortAsc ? -1 : 1)
    })
  }, [pdf, stockInfos, pdfSortKey, pdfSortAsc])

  // 만기 d일 — 첫 번째 선물의 expiry로 today 기준 직접 계산.
  // (대부분 KRX 주식선물은 동일 만기. days_left 필드는 stale일 수 있어 사용 X)
  const firstFutDays = useMemo(() => {
    for (const s of pdf.stocks) {
      const fm = futuresByBase.get(s.code)
      if (fm?.front?.expiry) return daysFromToday(fm.front.expiry, todayIso)
    }
    return null
  }, [pdf, futuresByBase, todayIso])

  return (
    <div className="px-4 py-3 bg-[#0a0a0a] border-y border-white/[0.04]">
      {/* PDF 메타 */}
      <div className="mb-3 inline-flex items-center gap-3 px-3 py-2 rounded bg-[#141417] text-[11px] text-[#8b8b8e]">
        <span>PDF 기준일 <span className="text-[#d1d1d6]">{pdf.as_of}</span></span>
        <span className="text-[#3a3a3e]">|</span>
        <span>CU <span className="text-[#d1d1d6] tabular-nums">{cuUnit.toLocaleString()}</span></span>
        <span className="text-[#3a3a3e]">|</span>
        <span>현금 <span className="text-[#d1d1d6] tabular-nums">{cash.toLocaleString()}</span></span>
        <span className="text-[#3a3a3e]">|</span>
        <span>종목 <span className="text-[#d1d1d6] tabular-nums">{pdf.stocks.length}</span></span>
        {firstFutDays != null && (
          <>
            <span className="text-[#3a3a3e]">|</span>
            <span>만기 <span className="text-[#d1d1d6] tabular-nums">{firstFutDays}</span>일</span>
          </>
        )}
        {metrics && metrics.dividendN > 0 && (
          <>
            <span className="text-[#3a3a3e]">|</span>
            <span>배당 <span className="text-[#ff9f0a] tabular-nums">{metrics.dividendN}</span>종</span>
          </>
        )}
      </div>

      {/* PDF 테이블 */}
      <div className="rounded bg-[#0d0d0f] border border-white/[0.03]">
        <table className="tabular-nums" style={{ tableLayout: 'fixed', width: '1568px' }}>
          <colgroup>
            <col style={{ width: 80 }} />{/* 코드 */}
            <col style={{ width: 170 }} />{/* 종목명 */}
            <col style={{ width: 110 }} />{/* 1CU */}
            <col style={{ width: 126 }} />{/* 비중 */}
            <col style={{ width: 80 }} />{/* 배당 */}
            <col style={{ width: 110 }} />{/* 현물가 */}
            <col style={{ width: 110 }} />{/* 선물가 */}
            <col style={{ width: 110 }} />{/* 이론가 */}
            <col style={{ width: 110 }} />{/* 시장베이시스 */}
            <col style={{ width: 110 }} />{/* 이론베이시스 */}
            <col style={{ width: 94 }} />{/* 갭 */}
            <col style={{ width: 94 }} />{/* 갭BP */}
            <col style={{ width: 110 }} />{/* 거래량 */}
            <col style={{ width: 94 }} />{/* 기여BP */}
            <col style={{ width: 60 }} />{/* 사용 */}
          </colgroup>
          <thead className="sticky top-[33px] z-10 text-[#a8a8ae] text-[10px] uppercase tracking-wide bg-[#16161a] border-b border-white/[0.06]">
            <tr>
              <PdfTh sk="code" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} className="pl-4 text-left">코드</PdfTh>
              <PdfTh sk="name" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} className="text-left">종목명</PdfTh>
              <PdfTh sk="qty" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort}>1CU 수량</PdfTh>
              <PdfTh sk="H" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort}>비중</PdfTh>
              <PdfTh sk="M" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort}>배당</PdfTh>
              <PdfTh sk="S" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort}>현물가</PdfTh>
              <PdfTh sk="F" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort}>선물가</PdfTh>
              <PdfTh sk="N" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} title="현물·(1+r·d/365)">이론가</PdfTh>
              <PdfTh sk="Q" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} title="F - S">시장베이시스</PdfTh>
              <PdfTh sk="P" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} title="(N-S)-M, 배당 차감">이론베이시스</PdfTh>
              <PdfTh sk="R" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} title="시장베이시스 - 이론베이시스 = F-N+M">갭</PdfTh>
              <PdfTh sk="T" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} title="R/N·1만, 매수+/매도-">갭BP</PdfTh>
              <PdfTh sk="futVol" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort}>거래량</PdfTh>
              <PdfTh sk="contribBp" cur={pdfSortKey} asc={pdfSortAsc} onSort={onPdfSort} title="(갭BP±slip-tax)·H, V=O일 때">기여BP</PdfTh>
              <th className="py-1.5 px-2 text-center font-medium">사용</th>
            </tr>
          </thead>
          <tbody>
            {sortedStocks.map((s) => {
              const info = stockInfos.get(s.code)
              if (!info) return null
              return (
                <PdfRow
                  key={s.code}
                  code={s.code}
                  name={s.name}
                  qty={s.qty}
                  info={info}
                  isExcluded={excluded.has(s.code)}
                  etfCode={etfCode}
                  onToggle={onToggle}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** PDF 테이블 정렬 헤더 — sk(자기 키)와 cur(현재 sortKey)이 일치하면 active 표시. */
function PdfTh({ children, sk, cur, asc, onSort, className, title }: {
  children: React.ReactNode; sk: PdfSortKey; cur: PdfSortKey; asc: boolean
  onSort: (k: PdfSortKey) => void; className?: string; title?: string
}) {
  const active = sk === cur
  return (
    <th
      title={title}
      onClick={() => onSort(sk)}
      className={cn(
        'py-1.5 px-2 font-medium cursor-pointer select-none hover:text-white transition-colors whitespace-nowrap',
        active && 'text-white',
        className?.includes('text-left') ? '' : 'text-right',
        className,
      )}
    >
      {children}
      {active && <span className="ml-0.5 opacity-60 text-[8px]">{asc ? '▲' : '▼'}</span>}
    </th>
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
 *   buy: 매수차BP Top만 풀폭 (양수, 초록)
 *   sell: 매도차BP Top만 풀폭 (음수, 빨강)
 *   mixed: 좌(매수차) + 우(매도차) — 양방향 혼재 ETF는 양쪽에 모두 등장 가능
 * buyArbBp/sellArbBp 직접 사용 (diffBp 부호 분류 X — 혼합 ETF의 양면 모두 노출).
 */
const TopBarChart = memo(function TopBarChart({ rows, metrics, selected, onSelect, arbMode }: TopBarProps) {
  const buyTop = useMemo(
    () => rows
      .map((etf) => ({ etf, bp: metrics[etf.code]?.buyArbBp ?? 0 }))
      .filter((it) => it.bp > 0.001)
      .sort((a, b) => b.bp - a.bp)
      .slice(0, TOP_N_CHART),
    [rows, metrics]
  )
  const sellTop = useMemo(
    () => rows
      .map((etf) => ({ etf, bp: metrics[etf.code]?.sellArbBp ?? 0 }))
      .filter((it) => it.bp < -0.001)
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
    <div className="flex items-center gap-2 rounded-md bg-[#1e1e22] px-3 py-1.5">
      <span className="text-[11px] text-[#8b8b8e] whitespace-nowrap">{label}</span>
      {children}
    </div>
  )
}

function NumInput({ value, onChange, width = 72, step = 1, suffix }: {
  value: number; onChange: (v: number) => void; width?: number; step?: number; suffix?: string
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="bg-transparent text-[12px] text-white tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
        style={{ width }}
      />
      {suffix && <span className="text-[11px] text-[#8b8b8e]">{suffix}</span>}
    </div>
  )
}

function Quick({ children, onClick, on }: { children: React.ReactNode; onClick: () => void; on: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded px-2 py-1 text-[11px] tabular-nums transition-colors',
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
const ArbRow = memo(function ArbRow({ etf, m, history, isSelected, onSelect, maxMissingFrac }: {
  etf: EtfMaster
  m: EtfMetrics | undefined
  history: { t: number; diffBp: number }[] | undefined
  isSelected: boolean
  onSelect: (code: string) => void
  maxMissingFrac: number  // 누락 비중 임계값 (0.01 = 1%). 초과 시 fNAV/실집행 컬럼 흐림
}) {
  const diffColor = m && Math.abs(m.diffBp) > 5
    ? (m.diffBp > 0 ? 'text-[#00b26b]' : 'text-[#bb4a65]')
    : 'text-white'
  // 비차익(레버리지/인버스/채권 등): PDF로 fNAV·차익 산출 자체가 불가 → 차익 관련 컬럼 일괄 흐림.
  // 누락(라이브 가격 못 받은 종목 비중 초과): fNAV·실집행만 의심값 → 동일하게 흐림.
  // 두 케이스 모두 `dim`으로 통합 처리 (행 opacity 60 + 차익 컬럼 '—').
  const nonArb = !!m && m.arbitrable === false
  const tooMissing = !!m && m.missingWeight > maxMissingFrac
  const dim = nonArb || tooMissing
  const dimReason = nonArb
    ? '레버리지/인버스/채권 등 — 자체 차익 산출 불가, 라이브 NAV만 신뢰'
    : tooMissing
      ? `누락 비중 ${(m!.missingWeight * 100).toFixed(1)}% — fNAV/실집행 의심값`
      : undefined
  return (
    <tr
      className={cn(
        'border-b border-white/[0.04] hover:bg-[#1d1d1d] cursor-pointer',
        isSelected ? 'bg-[#1d1d1d]' : 'bg-black',
      )}
      onClick={() => onSelect(etf.code)}
      title={dimReason}
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
      {/* iNAV: 거래소 발행 실시간 NAV (I5_). 모든 ETF 공통. rNAV/자체 산출과 비교용 진실값. */}
      <ArbC>{m && m.nav > 0 ? m.nav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</ArbC>
      {/* rNAV: 자체 산출 (SUM(S·D)+현금)/CU. 비차익 ETF는 PDF 처리가 깨져 (지수선물 미평가, 채권 시세 없음 등)
       *  의미 없으므로 흐림. 라이브 NAV는 iNAV 컬럼에 별도 표시. */}
      <ArbC c={dim ? 'text-[#5a5a5e]' : undefined}>
        {dim ? '—' : (m?.rNav ? m.rNav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-')}
      </ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : (m && m.fNav > 0 && m.rNav > 0 ? (m.fNav > m.rNav ? 'text-[#00b26b]' : m.fNav < m.rNav ? 'text-[#bb4a65]' : 'text-white') : 'text-white')}>{dim ? '—' : (m?.fNav ? m.fNav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-')}</ArbC>
      <ArbC c={m && m.priceNavBp > 0 ? 'text-[#00b26b]' : m && m.priceNavBp < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.nav > 0 ? `${fmt(m.priceNavBp, 2)}bp` : '-'}</ArbC>
      <ArbC c={m && m.askNavBp > 0 ? 'text-[#00b26b]' : m && m.askNavBp < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.nav > 0 && m.askNavBp !== 0 ? `${fmt(m.askNavBp, 2)}bp` : '-'}</ArbC>
      <ArbC c={m && m.bidNavBp > 0 ? 'text-[#00b26b]' : m && m.bidNavBp < 0 ? 'text-[#bb4a65]' : 'text-[#d1d1d6]'}>{m && m.nav > 0 && m.bidNavBp !== 0 ? `${fmt(m.bidNavBp, 2)}bp` : '-'}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : (m && m.buyArbBp > 0 ? 'text-[#00b26b]' : 'text-[#5a5a5e]')}>{dim ? '—' : (m && m.buyArbBp > 0.001 ? formatBp(m.buyArbBp) : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : (m && m.sellArbBp < 0 ? 'text-[#bb4a65]' : 'text-[#5a5a5e]')}>{dim ? '—' : (m && m.sellArbBp < -0.001 ? formatBp(m.sellArbBp) : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : cn('font-medium', diffColor)}>{dim ? '—' : (m ? formatBp(m.diffBp) : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : (m && m.realProfitWon > 0 ? 'text-[#00b26b]' : m && m.realProfitWon < 0 ? 'text-[#bb4a65]' : 'text-[#5a5a5e]')}>{dim ? '—' : (m && Math.abs(m.realProfitWon) > 1 ? `${Math.round(m.realProfitWon).toLocaleString()}원` : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : (m && m.realProfitBp > 0 ? 'text-[#00b26b]' : m && m.realProfitBp < 0 ? 'text-[#bb4a65]' : 'text-[#5a5a5e]')}>{dim ? '—' : (m && Math.abs(m.realProfitBp) > 0.01 ? `${formatBp(m.realProfitBp)}bp` : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : (m && m.dividendN > 0 ? 'text-[#ff9f0a]' : 'text-[#5a5a5e]')}>{dim ? '—' : (m && m.dividendN > 0 ? m.dividendN : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : 'text-[#d1d1d6]'}>{dim ? '—' : (m ? m.appliedPct.toFixed(1) : '-')}</ArbC>
      <ArbC c={dim ? 'text-[#5a5a5e]' : 'text-[#d1d1d6]'}>{dim ? '—' : (m ? m.futuresCount : '-')}</ArbC>
      <td className="px-2 py-[7px] text-center">{dim ? <span className="text-[9px] text-[#5a5a5e]">—</span> : <Sparkline history={history} />}</td>
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
