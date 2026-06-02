import { Fragment, useEffect, useMemo, useState } from 'react'

import { useMarketStore } from '@/stores/marketStore'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import { usePageInavSubscriptions } from '@/hooks/usePageInavSubscriptions'
import { usePageOrderbookBulk } from '@/hooks/usePageOrderbookBulk'
import { cn } from '@/lib/utils'
import {
  type EtfType,
  type EtfMaster,
  type EtfPdf,
  TYPE_LABEL,
  TYPE_ORDER,
  formatTradeValue,
} from '@/lib/etf'

/**
 * ETF 기본 대시보드 — 전 종류 ETF(지수/섹터/파생/채권/기타)의 순수 시장 데이터.
 * rNAV/fNAV·차익 계산 없음. 현재가/iNAV/괴리/호가/거래량만.
 *
 * 구독: ETF 코드의 iNAV(I5_) + 가격(S3_) + 호가. 표시 ETF에 한정 (외부망 WS 부담 관리).
 * 거래대금 상위 N개만 구독·표시 (30초마다 라이브 cum_volume 재정렬).
 *
 * 행 클릭 시: PDF 구성종목 서브테이블 (전일종가 기반, 실시간 가격 없음).
 *   전일종가는 WS 구독이 아니라 /api/stocks/daily-close REST 단발 조회 → 연결 부담 0.
 */
const VOLUME_CACHE_KEY = 'etf.volumeCache.v1'
const LIMIT_OPTIONS: (number | 'all')[] = [50, 100, 200, 'all']

type SortKey =
  | 'name' | 'type' | 'volume' | 'tradeValue' | 'changePct'
  | 'price' | 'nav' | 'premiumBp' | 'ask1' | 'bid1' | 'spread'

type Row = {
  code: string
  name: string
  type: EtfType
  volume: number       // 당일 누적 거래량 (주)
  tradeValue: number   // 당일 누적 거래대금 (원)
  price: number
  prevClose: number
  changePct: number
  nav: number
  premiumBp: number    // 현재가 vs iNAV 괴리
  ask1: number
  bid1: number
  spread: number       // 매도1 - 매수1 (원)
}

export function EtfDashboardPage() {
  const [master, setMaster] = useState<EtfMaster[] | null>(null)
  const [pdfs, setPdfs] = useState<Record<string, EtfPdf> | null>(null)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const networkMode = useMarketStore((s) => s.networkMode)

  // 표시 유형 — 기본 전체. 복수 선택.
  const [subTypes, setSubTypes] = useState<Set<EtfType>>(() => {
    try {
      const saved = localStorage.getItem('etfdash.subTypes')
      if (saved) {
        const arr = JSON.parse(saved) as EtfType[]
        if (Array.isArray(arr) && arr.length > 0) return new Set(arr)
      }
    } catch { /* ignore */ }
    return new Set<EtfType>(TYPE_ORDER)
  })
  useEffect(() => {
    localStorage.setItem('etfdash.subTypes', JSON.stringify([...subTypes]))
  }, [subTypes])

  // 표시 개수 제한 — iNAV+가격+호가 구독 대상. 거래대금 상위 N.
  const [subLimit, setSubLimit] = useState<number | 'all'>(() => {
    const saved = localStorage.getItem('etfdash.subLimit')
    if (saved === 'all') return 'all'
    const n = saved ? parseInt(saved, 10) : NaN
    return [50, 100, 200].includes(n) ? n : 100
  })
  useEffect(() => {
    localStorage.setItem('etfdash.subLimit', subLimit === 'all' ? 'all' : String(subLimit))
  }, [subLimit])

  const [sortKey, setSortKey] = useState<SortKey>('tradeValue')
  const [sortAsc, setSortAsc] = useState(false)
  const handleSort = (k: SortKey) => {
    if (k === sortKey) setSortAsc((v) => !v)
    else { setSortKey(k); setSortAsc(k === 'name' || k === 'type') }
  }

  // 펼친 ETF (PDF 서브테이블) — 단일.
  const [expandedCode, setExpandedCode] = useState<string | null>(null)
  // 전일종가 캐시 — 펼친 ETF PDF 종목만 lazy fetch. WS 아님 (REST 단발).
  const [prevCloseCache, setPrevCloseCache] = useState<Record<string, number>>({})

  // 마스터 로드 — 테이블 골격용. 가벼움(61KB)이라 즉시 표시.
  useEffect(() => {
    fetch('/api/etfs')
      .then((r) => r.json())
      .then((m) => {
        const items: EtfMaster[] = (m.items ?? []).map((e: EtfMaster) => ({
          ...e,
          arbitrable: e.arbitrable ?? true,
          type: e.type ?? 'other',
        }))
        setMaster(items)
        setLoadedAt(m.loaded_at ?? null)
      })
      .catch((e) => setError(String(e)))
  }, [])

  // PDF 로드 — 펼침 서브테이블 전용(1.8MB). 테이블 표시를 막지 않게 별도 백그라운드 로드.
  useEffect(() => {
    fetch('/api/etfs/pdf-all')
      .then((r) => r.json())
      .then((p) => setPdfs((p.items ?? {}) as Record<string, EtfPdf>))
      .catch(() => { /* PDF는 펼칠 때만 필요 — 실패해도 테이블은 동작 */ })
  }, [])

  // 펼친 ETF PDF 종목의 전일종가 lazy fetch (캐시에 없는 것만).
  useEffect(() => {
    if (!expandedCode || !pdfs) return
    const pdf = pdfs[expandedCode]
    if (!pdf) return
    const need = pdf.stocks
      .map((s) => s.code)
      .filter((c) => prevCloseCache[c] === undefined)
    if (need.length === 0) return
    fetch('/api/stocks/daily-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: need }),
    })
      .then((r) => r.json())
      .then((res) => {
        const prices = (res.prices ?? {}) as Record<string, number>
        // 없는 종목도 0으로 박아 재요청 방지
        setPrevCloseCache((prev) => {
          const next = { ...prev }
          for (const c of need) next[c] = prices[c] ?? 0
          return next
        })
      })
      .catch(() => { /* ignore */ })
  }, [expandedCode, pdfs, prevCloseCache])

  // 200ms throttled tick snapshot — 라이브 구독 시 매 tick 전체 재계산 방지.
  // stockTicks: 펼친 ETF의 PDF 구성종목 실시간 현재가용 (장중).
  const [{ etfTicks, orderbookTicks, stockTicks }, setTicks] = useState(() => {
    const s = useMarketStore.getState()
    return { etfTicks: s.etfTicks, orderbookTicks: s.orderbookTicks, stockTicks: s.stockTicks }
  })
  useEffect(() => {
    const id = setInterval(() => {
      const s = useMarketStore.getState()
      setTicks({ etfTicks: s.etfTicks, orderbookTicks: s.orderbookTicks, stockTicks: s.stockTicks })
    }, 200)
    return () => clearInterval(id)
  }, [])

  // 거래대금 기준 재정렬용 tick — 30초마다. 구독 churn 줄이려 표시제한 선정은 이 주기로만.
  const [sortTick, setSortTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setSortTick((v) => v + 1), 30000)
    return () => clearInterval(id)
  }, [])

  // 표시·구독 대상 ETF — 타입 필터 + 거래대금 상위 N.
  // 거래대금은 라이브 cum_volume 우선, 없으면 localStorage 캐시.
  const visibleMaster = useMemo(() => {
    if (!master) return [] as EtfMaster[]
    let cache: Record<string, number> = {}
    try { cache = JSON.parse(localStorage.getItem(VOLUME_CACHE_KEY) || '{}') } catch { /* ignore */ }
    const live = useMarketStore.getState().etfTicks
    const filtered = master.filter((e) => subTypes.has((e.type ?? 'other') as EtfType))
    const vol = (code: string) => live[code]?.cum_volume ?? cache[code] ?? 0
    const sorted = [...filtered].sort((a, b) => vol(b.code) - vol(a.code))
    return subLimit === 'all' ? sorted : sorted.slice(0, subLimit)
    // sortTick: 30초마다 거래대금 재정렬 트리거
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master, subTypes, subLimit, sortTick])

  // 구독 — 표시 ETF의 가격(S3_) + iNAV(I5_) + 호가.
  const visibleCodes = useMemo(() => visibleMaster.map((e) => e.code), [visibleMaster])
  usePageInavSubscriptions(visibleCodes)
  usePageOrderbookBulk(visibleCodes)

  // 펼친 ETF의 PDF 구성종목 코드 — 장중 실시간 현재가용. 닫으면 빈 배열 → 자동 unsubscribe.
  // 구분 없이 전체 구독 (KODEX 200처럼 종목 많은 ETF는 사용자가 안 펼치면 됨).
  const expandedPdfCodes = useMemo(() => {
    if (!expandedCode || !pdfs) return [] as string[]
    const pdf = pdfs[expandedCode]
    return pdf ? pdf.stocks.filter((s) => s.qty > 0).map((s) => s.code) : []
  }, [expandedCode, pdfs])

  // ETF 가격 + 펼친 PDF 구성종목을 함께 stock 구독 (S3_). diff 처리는 훅 내부.
  const stockSubCodes = useMemo(
    () => [...visibleCodes, ...expandedPdfCodes],
    [visibleCodes, expandedPdfCodes],
  )
  usePageStockSubscriptions(stockSubCodes)

  // 거래대금 캐시 주기 저장 — 다음 mount 시 초기 정렬용.
  useEffect(() => {
    if (!master) return
    const save = () => {
      const s = useMarketStore.getState()
      const cache: Record<string, number> = {}
      for (const e of master) {
        const v = s.etfTicks[e.code]?.cum_volume ?? 0
        if (v > 0) cache[e.code] = v
      }
      if (Object.keys(cache).length > 0) {
        try { localStorage.setItem(VOLUME_CACHE_KEY, JSON.stringify(cache)) } catch { /* ignore */ }
      }
    }
    const id = setInterval(save, 30000)
    return () => clearInterval(id)
  }, [master])

  // 행 데이터 — 표시 ETF별 시장 데이터 계산 (괴리·호가 등). 차익 계산 없음 → 가벼움.
  const rows = useMemo<Row[]>(() => {
    return visibleMaster.map((e): Row => {
      const t = etfTicks[e.code]
      const price = t?.price ?? 0
      const nav = t?.nav ?? 0
      const prevClose = t?.prev_close ?? 0
      const ob = orderbookTicks[e.code]
      const ask1 = ob?.asks[0]?.price ?? 0
      const bid1 = ob?.bids[0]?.price ?? 0
      const premiumBp =
        nav > 0 && price > 0 ? Math.max(-1000, Math.min(1000, ((price - nav) / nav) * 10000)) : 0
      return {
        code: e.code,
        name: e.name,
        type: (e.type ?? 'other') as EtfType,
        volume: t?.volume ?? 0,
        tradeValue: t?.cum_volume ?? 0,
        price,
        prevClose,
        changePct: prevClose > 0 && price > 0 ? ((price - prevClose) / prevClose) * 100 : 0,
        nav,
        premiumBp,
        ask1,
        bid1,
        spread: ask1 > 0 && bid1 > 0 ? ask1 - bid1 : 0,
      }
    })
  }, [visibleMaster, etfTicks, orderbookTicks])

  const sortedRows = useMemo(() => {
    const dir = sortAsc ? 1 : -1
    const arr = [...rows]
    arr.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name) * dir
      if (sortKey === 'type') return a.type.localeCompare(b.type) * dir
      return ((a[sortKey] as number) - (b[sortKey] as number)) * dir
    })
    return arr
  }, [rows, sortKey, sortAsc])

  return (
    <div className="flex flex-col gap-1">
      {/* 컨트롤 패널 */}
      <div className="panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-t3 w-8">유형</span>
            {TYPE_ORDER.map((t) => (
              <button
                key={t}
                onClick={() => {
                  const next = new Set(subTypes)
                  if (next.has(t)) next.delete(t); else next.add(t)
                  if (next.size === 0) return
                  setSubTypes(next)
                }}
                className={cn(
                  'px-2 py-0.5 rounded transition-colors',
                  subTypes.has(t) ? 'bg-accent text-bg-base font-medium' : 'bg-bg-surface text-t3 hover:text-t1'
                )}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-t3 w-8">표시</span>
            {LIMIT_OPTIONS.map((n) => (
              <button
                key={String(n)}
                onClick={() => setSubLimit(n)}
                className={cn(
                  'px-2 py-0.5 rounded tabular-nums transition-colors',
                  subLimit === n ? 'bg-accent text-bg-base font-medium' : 'bg-bg-surface text-t3 hover:text-t1'
                )}
              >
                {n === 'all' ? '전체' : n}
              </button>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-t4 tabular-nums">
            {visibleMaster.length} / {master?.length ?? 0} ETF
            {loadedAt && <span className="ml-2 text-t4">· {loadedAt.slice(0, 16).replace('T', ' ')}</span>}
          </span>
        </div>
      </div>

      {/* 테이블 패널 */}
      <div className="panel p-0 overflow-x-auto">
        {error && <div className="p-3 text-down text-sm">로드 실패: {error}</div>}
        {!error && !master && <div className="p-3 text-t3 text-sm">로드 중…</div>}
        {master && (
          <table className="border-collapse" style={{ tableLayout: 'fixed', width: '100%', minWidth: '1180px' }}>
            <colgroup>
              <col style={{ width: 230 }} />{/* 종목 */}
              <col style={{ width: 70 }} />{/* 유형 */}
              <col style={{ width: 110 }} />{/* 거래량 */}
              <col style={{ width: 110 }} />{/* 거래대금 */}
              <col style={{ width: 90 }} />{/* 등락 */}
              <col style={{ width: 100 }} />{/* 현재가 */}
              <col style={{ width: 110 }} />{/* iNAV */}
              <col style={{ width: 90 }} />{/* 현재괴리 */}
              <col style={{ width: 100 }} />{/* 매도1호가 */}
              <col style={{ width: 100 }} />{/* 매수1호가 */}
              <col style={{ width: 90 }} />{/* 스프레드 */}
            </colgroup>
            <thead className="sticky top-0 z-20">
              <tr className="text-[12px] text-[#8b8b8e] bg-black">
                <Th onClick={() => handleSort('name')} active={sortKey === 'name'} asc={sortAsc} left className="pl-4">종목</Th>
                <Th onClick={() => handleSort('type')} active={sortKey === 'type'} asc={sortAsc}>유형</Th>
                <Th onClick={() => handleSort('volume')} active={sortKey === 'volume'} asc={sortAsc}>거래량</Th>
                <Th onClick={() => handleSort('tradeValue')} active={sortKey === 'tradeValue'} asc={sortAsc}>거래대금</Th>
                <Th onClick={() => handleSort('changePct')} active={sortKey === 'changePct'} asc={sortAsc}>등락</Th>
                <Th onClick={() => handleSort('price')} active={sortKey === 'price'} asc={sortAsc}>현재가</Th>
                <Th onClick={() => handleSort('nav')} active={sortKey === 'nav'} asc={sortAsc} title="iNAV — 거래소 발행 실시간 NAV (I5_)">iNAV</Th>
                <Th onClick={() => handleSort('premiumBp')} active={sortKey === 'premiumBp'} asc={sortAsc} title="현재가 vs iNAV 괴리">현재괴리</Th>
                <Th onClick={() => handleSort('ask1')} active={sortKey === 'ask1'} asc={sortAsc}>매도1호가</Th>
                <Th onClick={() => handleSort('bid1')} active={sortKey === 'bid1'} asc={sortAsc}>매수1호가</Th>
                <Th onClick={() => handleSort('spread')} active={sortKey === 'spread'} asc={sortAsc} title="매도1호가 - 매수1호가">스프레드</Th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const expanded = expandedCode === r.code
                return (
                  <Fragment key={r.code}>
                    <tr
                      className={cn(
                        'h-[40px] border-b border-white/[0.04] hover:bg-[#1d1d1d] cursor-pointer',
                        expanded ? 'bg-[#1d1d1d]' : 'bg-black',
                      )}
                      onClick={() => setExpandedCode(expanded ? null : r.code)}
                    >
                      <td className="pl-4 pr-3 py-[6px]">
                        <div className="text-[11px] text-white leading-none whitespace-nowrap overflow-hidden text-ellipsis">{r.name}</div>
                        <div className="text-[9px] text-[#8e8e93] leading-none mt-[2px] tabular-nums">{r.code}</div>
                      </td>
                      <Cell c="text-t3">{TYPE_LABEL[r.type]}</Cell>
                      <Cell c="text-t2">{r.volume > 0 ? r.volume.toLocaleString() : '-'}</Cell>
                      <Cell c="text-t2">{r.tradeValue > 0 ? formatTradeValue(r.tradeValue) : '-'}</Cell>
                      <Cell c={r.changePct > 0 ? 'text-up' : r.changePct < 0 ? 'text-down' : 'text-t3'}>
                        {r.price > 0 && r.prevClose > 0 ? `${r.changePct > 0 ? '+' : ''}${r.changePct.toFixed(2)}%` : '-'}
                      </Cell>
                      <Cell>{r.price > 0 ? r.price.toLocaleString() : (r.prevClose > 0 ? r.prevClose.toLocaleString() : '-')}</Cell>
                      <Cell>{r.nav > 0 ? r.nav.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}</Cell>
                      <Cell c={r.premiumBp > 0 ? 'text-up' : r.premiumBp < 0 ? 'text-down' : 'text-t3'}>{r.nav > 0 && r.price > 0 ? `${fmtBp(r.premiumBp)}bp` : '-'}</Cell>
                      <Cell c="text-down">{r.ask1 > 0 ? r.ask1.toLocaleString() : '-'}</Cell>
                      <Cell c="text-up">{r.bid1 > 0 ? r.bid1.toLocaleString() : '-'}</Cell>
                      <Cell c="text-t2">{r.spread > 0 ? r.spread.toLocaleString() : '-'}</Cell>
                    </tr>
                    {expanded && (
                      <tr className="bg-bg-base">
                        <td colSpan={11} className="p-0">
                          <PdfSubTable pdf={pdfs?.[r.code]} prevCloseCache={prevCloseCache} stockTicks={stockTicks} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {sortedRows.length === 0 && (
                <tr><td colSpan={11} className="p-6 text-center text-t3 text-sm">표시할 ETF 없음 (유형 필터 확인)</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {networkMode !== 'internal' && (
        <div className="px-3 py-1 text-[10px] text-t4">
          외부망 — 거래대금 상위 {subLimit === 'all' ? '전체' : subLimit}개 ETF만 실시간 구독합니다.
        </div>
      )}
    </div>
  )
}

/** PDF 구성종목 서브테이블 — 펼친 ETF의 구성종목을 실시간 구독해 현재가 표시.
 *  평가가격 = 현재가(장중 실시간) 우선, 미수신 시 전일종가 폴백. 금액·비중 산출. */
function PdfSubTable({ pdf, prevCloseCache, stockTicks }: {
  pdf: EtfPdf | undefined
  prevCloseCache: Record<string, number>
  stockTicks: Record<string, import('@/types/market').StockTick>
}) {
  if (!pdf) {
    return <div className="px-6 py-3 text-[11px] text-t3">PDF 데이터 없음</div>
  }
  const stocks = pdf.stocks.filter((s) => s.qty > 0)
  const cash = pdf.cash || 0
  // 평가가격 = 현재가(실시간) 우선, 없으면 전일종가. 금액 = 수량 × 평가가격.
  // NAV총액 = 종목금액합 + 현금. 비중 = 금액 / NAV총액.
  const rows = stocks.map((s) => {
    const live = stockTicks[s.code]?.price ?? 0
    const pc = prevCloseCache[s.code] ?? 0
    const price = live > 0 ? live : pc
    return { code: s.code, name: s.name, qty: s.qty, live, prevClose: pc, value: price * s.qty }
  })
  const stockValueSum = rows.reduce((acc, r) => acc + r.value, 0)
  const navTotal = stockValueSum + cash
  const liveCount = rows.filter((r) => r.live > 0).length

  return (
    <div className="px-4 py-3 bg-[#0a0a0a] border-y border-white/[0.04]">
      <div className="mb-2 inline-flex items-center gap-3 px-3 py-1.5 rounded bg-[#141417] text-[11px] text-t3">
        <span>PDF 기준일 <span className="text-t2">{pdf.as_of}</span></span>
        <span className="text-[#3a3a3e]">|</span>
        <span>CU <span className="text-t2 tabular-nums">{(pdf.cu_unit ?? 0).toLocaleString()}</span></span>
        <span className="text-[#3a3a3e]">|</span>
        <span>종목 <span className="text-t2 tabular-nums">{stocks.length}</span></span>
        <span className="text-[#3a3a3e]">|</span>
        <span className="text-t4">실시간 {liveCount}/{stocks.length} · 나머지 전일종가</span>
      </div>
      <div className="rounded bg-[#0d0d0f] border border-white/[0.03] overflow-x-auto">
        <table className="tabular-nums" style={{ tableLayout: 'fixed', width: '100%', minWidth: '880px' }}>
          <colgroup>
            <col style={{ width: 90 }} />{/* 코드 */}
            <col style={{ width: 200 }} />{/* 종목명 */}
            <col style={{ width: 100 }} />{/* 수량 */}
            <col style={{ width: 120 }} />{/* 현재가 */}
            <col style={{ width: 120 }} />{/* 전일종가 */}
            <col style={{ width: 140 }} />{/* 금액 */}
            <col style={{ width: 90 }} />{/* 비중 */}
          </colgroup>
          <thead className="text-[11.5px] text-[#a8a8ae] uppercase tracking-wide bg-[#16161a] border-b border-white/[0.06]">
            <tr>
              <td className="pl-4 py-2.5 text-left">코드</td>
              <td className="py-2.5 text-left">종목명</td>
              <td className="py-2.5 pr-3 text-right">수량(1CU)</td>
              <td className="py-2.5 pr-3 text-right">현재가</td>
              <td className="py-2.5 pr-3 text-right">전일종가</td>
              <td className="py-2.5 pr-3 text-right">금액</td>
              <td className="py-2.5 pr-4 text-right">비중</td>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                <td className="pl-4 py-2 text-left text-[12px] text-t3">{r.code}</td>
                <td className="py-2 text-left text-[12.5px] text-t1 whitespace-nowrap overflow-hidden text-ellipsis">{r.name}</td>
                <td className="py-2 pr-3 text-right text-[12.5px] text-t2">{r.qty.toLocaleString()}</td>
                <td className="py-2 pr-3 text-right text-[12.5px] text-t1">{r.live > 0 ? r.live.toLocaleString() : '-'}</td>
                <td className="py-2 pr-3 text-right text-[12.5px] text-t3">{r.prevClose > 0 ? r.prevClose.toLocaleString() : '-'}</td>
                <td className="py-2 pr-3 text-right text-[12.5px] text-t1">{r.value > 0 ? Math.round(r.value).toLocaleString() : '-'}</td>
                <td className="py-2 pr-4 text-right text-[12.5px] text-t2">{navTotal > 0 && r.value > 0 ? `${((r.value / navTotal) * 100).toFixed(2)}%` : '-'}</td>
              </tr>
            ))}
            {/* 현금 행 */}
            <tr className="border-t border-white/[0.08] bg-white/[0.015]">
              <td className="pl-4 py-2 text-left text-[12px] text-warning">현금</td>
              <td className="py-2 text-left text-[12.5px] text-t3">—</td>
              <td className="py-2 pr-3 text-right text-[12.5px] text-t4">—</td>
              <td className="py-2 pr-3 text-right text-[12.5px] text-t4">—</td>
              <td className="py-2 pr-3 text-right text-[12.5px] text-t4">—</td>
              <td className="py-2 pr-3 text-right text-[12.5px] text-warning">{cash > 0 ? Math.round(cash).toLocaleString() : '-'}</td>
              <td className="py-2 pr-4 text-right text-[12.5px] text-warning">{navTotal > 0 && cash > 0 ? `${((cash / navTotal) * 100).toFixed(2)}%` : '-'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

function fmtBp(v: number): string {
  if (!isFinite(v)) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

function Th({ children, onClick, active, asc, left, className, title }: {
  children: React.ReactNode
  onClick: () => void
  active: boolean
  asc: boolean
  left?: boolean
  className?: string
  title?: string
}) {
  return (
    <th
      onClick={onClick}
      title={title}
      className={cn(
        'sticky top-0 bg-black py-2 px-3 font-medium cursor-pointer select-none whitespace-nowrap',
        left ? 'text-left' : 'text-right',
        active ? 'text-t1' : 'hover:text-t2',
        className
      )}
    >
      {children}
      {active && <span className="ml-0.5 text-[9px]">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}

function Cell({ children, c }: { children: React.ReactNode; c?: string }) {
  return <td className={cn('text-right px-3 py-[6px] text-[12px] tabular-nums whitespace-nowrap', c ?? 'text-white')}>{children}</td>
}
