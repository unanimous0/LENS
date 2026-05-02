import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'
import { OrderbookModal, SpreadOrderbookModal } from '@/components/OrderbookModal'

// ── 타입 ──

interface MasterItem {
  base_code: string
  base_name: string
  spread_code?: string
  front: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
  back?: { code: string; name: string; expiry: string; days_left: number; multiplier: number }
}

interface Master {
  updated: string
  front_month: string
  back_month: string
  count: number
  items: MasterItem[]
}

interface Dividend {
  code: string
  ex_date: string | null
  record_date: string | null
  amount: number
  period: string
  confirmed: boolean
  is_latest?: boolean
}

interface DividendItem {
  ex_date: string
  amount: number
  period: string
  confirmed: boolean
}

interface Row {
  baseCode: string
  baseName: string
  frontCode: string
  backCode: string
  multiplier: number
  expiry: string
  daysLeft: number
  spotPrice: number
  spotHigh: number
  spotLow: number
  spotPrevClose: number
  spotChangeRate: number
  spotCumVolume: number
  futuresPrice: number
  futuresVolume: number
  /** 미결제약정수량 (JC0 openyak / t8402 mgjv) — 데이터 없으면 undefined */
  openInterest?: number
  /** 미결제약정 전일대비 증감 */
  openInterestChange?: number
  theoreticalPrice: number
  theoreticalBasis: number
  marketBasis: number
  basisGap: number
  basisGapBp: number
  backPrice: number
  spread: number
  spreadVolume: number
  spreadHasTick: boolean
  dividend: number
  dividendDate: string
  dividendConfirmedAmt: number
  dividendEstimatedAmt: number
  dividendItems: DividendItem[]
  spreadCode: string
  holding031: number
  holding052: number
  futuresHolding: number
}

type SK = keyof Pick<Row,
  'baseName' | 'spotPrice' | 'futuresPrice' | 'theoreticalPrice' | 'marketBasis' | 'basisGapBp' |
  'theoreticalBasis' | 'basisGap' | 'spotCumVolume' | 'futuresVolume' | 'multiplier' |
  'spread' | 'spreadVolume' | 'dividend' | 'spotChangeRate'
>

export function StockArbitragePage() {
  const [master, setMaster] = useState<Master | null>(null)
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [sk, setSk] = useState<SK>('basisGapBp')
  const [asc, setAsc] = useState(false)
  const [month, setMonth] = useState<'front' | 'back'>('front')
  // 이론가: 시장베이시스 - 이론베이시스 (단기 차익, 이론 수렴 가정)
  // 이론0원: 시장베이시스 - 0 (만기 holding 가정 — 만기엔 이론베이시스 0으로 수렴)
  const [basisMode, setBasisMode] = useState<'theory' | 'zero'>(() => {
    const saved = localStorage.getItem('arbitrage.basisMode')
    return saved === 'zero' ? 'zero' : 'theory'
  })
  useEffect(() => { localStorage.setItem('arbitrage.basisMode', basisMode) }, [basisMode])
  const [rate, setRate] = useState<number>(() => {
    const saved = localStorage.getItem('arbitrage.rate')
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) ? n : 2.8
  })
  const [rateDraft, setRateDraft] = useState<string>(() => String(rate))
  useEffect(() => { localStorage.setItem('arbitrage.rate', String(rate)) }, [rate])
  const commitRate = () => {
    const n = parseFloat(rateDraft)
    if (Number.isFinite(n) && n >= 0) setRate(n)
    else setRateDraft(String(rate))
  }

  // 수치 필터 (≥ 임계값). 0 = 미적용. localStorage 유지.
  type Filters = { futVol: number; gapBp: number; spreadVol: number }
  const DEFAULT_FILTERS: Filters = { futVol: 0, gapBp: 0, spreadVol: 0 }
  const [filters, setFilters] = useState<Filters>(() => {
    const saved = localStorage.getItem('arbitrage.filters')
    if (!saved) return DEFAULT_FILTERS
    try { return { ...DEFAULT_FILTERS, ...JSON.parse(saved) } } catch { return DEFAULT_FILTERS }
  })
  const [filterDrafts, setFilterDrafts] = useState({
    futVol: filters.futVol > 0 ? String(filters.futVol) : '',
    gapBp: filters.gapBp > 0 ? String(filters.gapBp) : '',
    spreadVol: filters.spreadVol > 0 ? String(filters.spreadVol) : '',
  })
  useEffect(() => { localStorage.setItem('arbitrage.filters', JSON.stringify(filters)) }, [filters])
  const [filterOpen, setFilterOpen] = useState(false)

  const commitFilter = (key: keyof Filters) => {
    const raw = filterDrafts[key]
    const n = parseFloat(raw)
    const val = Number.isFinite(n) && n > 0 ? n : 0
    setFilters((p) => ({ ...p, [key]: val }))
    setFilterDrafts((p) => ({ ...p, [key]: val > 0 ? String(val) : '' }))
  }
  const setPreset = (key: keyof Filters, val: number) => {
    setFilters((p) => ({ ...p, [key]: val }))
    setFilterDrafts((p) => ({ ...p, [key]: String(val) }))
  }
  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS)
    setFilterDrafts({ futVol: '', gapBp: '', spreadVol: '' })
  }
  const activeFilterCount =
    (filters.futVol > 0 ? 1 : 0) + (filters.gapBp > 0 ? 1 : 0) + (filters.spreadVol > 0 ? 1 : 0)
  const [obTarget, setObTarget] = useState<{ spotCode: string; futuresCode: string; spotName: string } | null>(null)
  const [spreadTarget, setSpreadTarget] = useState<{ spreadCode: string; spotName: string } | null>(null)
  const closeOb = useCallback(() => setObTarget(null), [])
  const closeSpread = useCallback(() => setSpreadTarget(null), [])

  const stockTicks = useMarketStore((s) => s.stockTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)

  useEffect(() => {
    fetch('/api/arbitrage/master')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((d) => { setMaster(d); setLoading(false) })
      .catch((e) => { setError(e.message); setLoading(false) })
  }, [])

  useEffect(() => {
    fetch('/api/dividends')
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((d) => setDividends(d.items ?? []))
      .catch(() => {})  // 배당 API 실패는 치명적이지 않음 — dividend 0으로 떨어짐
  }, [])

  // 종목코드별 배당 인덱스 — 행 매칭 시 O(1) 조회
  const divByCode = useMemo(() => {
    const m: Record<string, Dividend[]> = {}
    for (const d of dividends) {
      if (!d.ex_date) continue
      ;(m[d.code] ??= []).push(d)
    }
    return m
  }, [dividends])

  // 월물 전환 시 선물 구독 전환 (현물/스프레드는 고정)
  // 실시간 JC0 체결이 오면 즉시 갱신됨. 체결 전에는 마스터 초기값 표시.
  // dedupe: master 객체 ref만 바뀌고 코드 셋이 동일하면 (HMR/리로드/탭 다중 등)
  // 백엔드에 같은 subscribe를 또 보내지 않음. 이게 없으면 LS API에 storm 발생.
  const lastSubKey = useRef<string>('')
  useEffect(() => {
    if (!master) return
    const futuresCodes = master.items
      .map((i) => (i as any)[month]?.code)
      .filter(Boolean) as string[]
    if (futuresCodes.length === 0) return
    const key = `${month}:${futuresCodes.slice().sort().join(',')}`
    if (key === lastSubKey.current) return
    lastSubKey.current = key
    fetch('/realtime/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: futuresCodes }),
    }).catch(() => {})
  }, [master, month])

  const rows = useMemo(() => {
    if (!master) return [] as Row[]
    const today = new Date().toISOString().slice(0, 10)
    return master.items.map((item, idx): Row => {
      const spot = stockTicks[item.base_code]
      // 선택된 월물에 따라 선물 데이터 참조
      const sel = month === 'back' && item.back ? item.back : item.front
      const other = month === 'back' ? item.front : item.back
      const fut = futuresTicks[sel.code]
      const otherFut = other ? futuresTicks[other.code] : undefined

      const sp = spot?.price ?? 0  // 실시간 S3_/K3_만
      const sHigh = spot?.high ?? 0
      const sLow = spot?.low ?? 0
      const sPrevClose = spot?.prev_close ?? 0
      const sChangeRate = sPrevClose > 0 && sp > 0 ? ((sp - sPrevClose) / sPrevClose) * 100 : 0
      const fp = fut?.price ?? 0  // 실시간 JC0 체결만 표시
      const mb = fp > 0 && sp > 0 ? fp - sp : (fut?.basis ?? 0)

      // 배당 매칭: 오늘 ~ 선택 월물 만기일 사이에 배당락이 있으면 합산.
      // 만기일은 master.expiry (YYYYMMDD or YYYYMM)에서 직접 파싱 — days_left는 마스터
      // 갱신일 기준이라 며칠 stale될 수 있음.
      const cutoff = expiryToCutoffDate(sel.expiry)
      const applicable = (divByCode[item.base_code] ?? [])
        .filter((d) => d.ex_date && d.ex_date >= today && d.ex_date <= cutoff)
      let totalDividend = 0
      let confirmedAmt = 0, estimatedAmt = 0
      const dividendItems: DividendItem[] = []
      for (const d of applicable) {
        totalDividend += d.amount
        if (d.confirmed === false) estimatedAmt += d.amount
        else confirmedAmt += d.amount
        dividendItems.push({
          ex_date: d.ex_date!,
          amount: d.amount,
          period: d.period,
          confirmed: d.confirmed !== false,
        })
      }
      dividendItems.sort((a, b) => a.ex_date.localeCompare(b.ex_date))
      const earliestExDate = dividendItems[0]?.ex_date ?? ''

      // 이론가 = 현물 × (1 + r × d/365) - 배당
      const dLeft = sel.days_left || 0
      const tp = sp > 0 ? sp * (1 + (rate / 100) * dLeft / 365) - totalDividend : 0
      const tb = tp > 0 ? tp - sp : 0
      const gap = mb - (basisMode === 'zero' ? 0 : tb)
      const ofp = otherFut?.price ?? other?.price ?? 0
      // 스프레드: 항상 원월 - 근월
      const frontP = month === 'front' ? fp : ofp
      const backP = month === 'front' ? ofp : fp
      return {
        baseCode: item.base_code, baseName: item.base_name,
        frontCode: sel.code, backCode: other?.code ?? '',
        multiplier: sel.multiplier, expiry: sel.expiry, daysLeft: sel.days_left || 0,
        spotPrice: sp, spotHigh: sHigh, spotLow: sLow, spotPrevClose: sPrevClose, spotChangeRate: sChangeRate,
        spotCumVolume: spot?.cum_volume ?? 0,
        futuresPrice: fp, futuresVolume: fut?.volume ?? 0,  // 실시간만
        openInterest: fut?.open_interest,
        openInterestChange: fut?.open_interest_change,
        theoreticalPrice: tp, theoreticalBasis: basisMode === 'zero' ? 0 : tb,
        marketBasis: mb, basisGap: gap, basisGapBp: sp > 0 ? (gap / sp) * 10000 : 0,
        backPrice: backP,
        spread: item.spread_code ? (futuresTicks[item.spread_code]?.price ?? 0) : 0,
        spreadVolume: item.spread_code ? (futuresTicks[item.spread_code]?.volume ?? 0) : 0,
        // tick 존재 여부는 price 값과 독립. 스프레드는 근월=원월이면 price=0이 정상이므로
        // falsy 판정으로 "-" 처리하면 안 됨.
        spreadHasTick: !!(item.spread_code && futuresTicks[item.spread_code]),
        spreadCode: item.spread_code ?? '',
        dividend: totalDividend,
        dividendDate: earliestExDate,
        dividendConfirmedAmt: confirmedAmt,
        dividendEstimatedAmt: estimatedAmt,
        dividendItems,
        holding031: 0, holding052: 0, futuresHolding: 0,
      }
    })
  }, [master, stockTicks, futuresTicks, month, rate, divByCode, basisMode])

  const filtered = useMemo(() => {
    let list = rows
    if (search) {
      const q = search.toLowerCase()
      list = list.filter((r) => r.baseName.toLowerCase().includes(q) || r.baseCode.includes(q) || r.frontCode.toLowerCase().includes(q))
    }
    // 수치 필터 — 빈 값(0)은 미적용. 갭bp는 절댓값 기준.
    if (filters.futVol > 0) list = list.filter((r) => r.futuresVolume >= filters.futVol)
    if (filters.gapBp > 0) list = list.filter((r) => Math.abs(r.basisGapBp) >= filters.gapBp)
    if (filters.spreadVol > 0) list = list.filter((r) => r.spreadVolume >= filters.spreadVol)
    list.sort((a, b) => {
      const av = a[sk] ?? 0, bv = b[sk] ?? 0
      if (sk === 'baseName') {
        const as = String(av), bs = String(bv)
        // 영문 시작이면 한글보다 우선. 같은 언어 내에선 알파벳/가나다 순.
        const aEng = /^[A-Za-z]/.test(as)
        const bEng = /^[A-Za-z]/.test(bs)
        if (aEng !== bEng) return asc ? (aEng ? -1 : 1) : (aEng ? 1 : -1)
        return asc ? as.localeCompare(bs) : bs.localeCompare(as)
      }
      return asc ? +av - +bv : +bv - +av
    })
    return list
  }, [rows, search, sk, asc, filters])

  const doSort = (k: SK) => { if (sk === k) setAsc(!asc); else { setSk(k); setAsc(false) } }

  if (loading) return <Center>마스터 데이터 로딩 중...</Center>
  if (error) return <Center className="text-down">로드 실패: {error}</Center>

  const selInfo = master?.items[0]?.[month]
  const selExpiry = selInfo?.expiry ?? ''
  const selDaysLeft = selInfo?.days_left ?? 0
  const todayStr = new Date().toISOString().slice(0, 10)

  return (
    <div className="flex flex-col bg-black">
      {/* 헤더 — main 스크롤 시 상단에 sticky. 필터 펼치면 두 번째 줄 추가됨. */}
      <div className="shrink-0 sticky top-0 z-30 bg-black">
        <div className="px-6 py-4 flex items-center gap-5">
          <h1 className="text-[14px] text-white">종목차익</h1>
          <div className="flex items-center gap-1 rounded-md bg-[#1e1e22] p-0.5">
            <button
              onClick={() => setMonth('front')}
              className={cn('px-3 py-1 rounded text-[11px] transition-colors', month === 'front' ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white')}
            >
              근월물
            </button>
            <button
              onClick={() => setMonth('back')}
              className={cn('px-3 py-1 rounded text-[11px] transition-colors', month === 'back' ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white')}
            >
              원월물
            </button>
          </div>
          <div
            className="flex items-center gap-1 rounded-md bg-[#1e1e22] p-0.5"
            title={'이론가: 갭 = 시장베이시스 − 이론베이시스 (단기 차익, 이론 수렴 가정)\n이론0원: 갭 = 시장베이시스 − 0 (만기 holding 가정)'}
          >
            <button
              onClick={() => setBasisMode('theory')}
              className={cn('px-3 py-1 rounded text-[11px] transition-colors', basisMode === 'theory' ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white')}
            >
              이론가
            </button>
            <button
              onClick={() => setBasisMode('zero')}
              className={cn('px-3 py-1 rounded text-[11px] transition-colors', basisMode === 'zero' ? 'bg-[#2e2e32] text-white' : 'text-[#8b8b8e] hover:text-white')}
            >
              이론0원
            </button>
          </div>
          {/* 금리 입력 */}
          <div className="flex items-center gap-1.5 rounded-md bg-[#1e1e22] h-[28px] px-2.5">
            <span className="text-[10px] text-[#8b8b8e]">금리</span>
            <input
              type="number"
              step="0.1"
              value={rateDraft}
              onChange={(e) => setRateDraft(e.target.value)}
              onBlur={commitRate}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="w-10 bg-transparent text-[11px] text-white tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
            />
            <span className="text-[10px] text-[#8b8b8e]">%</span>
          </div>
          {/* 날짜 / 잔존 */}
          <div className="flex items-center gap-3 text-[10px] text-[#8b8b8e] tabular-nums">
            <span>오늘 <span className="text-white">{fmtDate(todayStr)}</span></span>
            <span>만기 <span className="text-white">{fmtExpiry(selExpiry)}</span></span>
            <span>잔존 <span className="text-white">{selDaysLeft}</span>일</span>
          </div>
          <span className="text-[10px] text-[#8b8b8e]">마스터 갱신일 <span className="text-[#d1d1d6] tabular-nums">{master?.updated ?? '-'}</span></span>
          {/* 필터 토글 */}
          <button
            onClick={() => setFilterOpen((v) => !v)}
            className={cn(
              'flex items-center gap-1 rounded-md h-[28px] px-2.5 text-[11px] transition-colors',
              activeFilterCount > 0 ? 'bg-accent/15 text-accent' : 'bg-[#1e1e22] text-[#8b8b8e] hover:text-white',
            )}
          >
            <span>필터 {filterOpen ? '▼' : '▶'}</span>
            {activeFilterCount > 0 && <span className="font-mono tabular-nums">{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <button
              onClick={resetFilters}
              disabled={activeFilterCount === 0}
              className="h-[28px] rounded bg-[#1e1e22] px-3 text-[12px] text-[#00b26b] hover:bg-[#2e2e32] disabled:cursor-not-allowed disabled:hover:bg-[#1e1e22] transition-colors"
            >
              초기화
            </button>
          )}
          {activeFilterCount > 0 && master && (
            <span className="text-[10px] text-[#8b8b8e] tabular-nums">
              <span className="text-white">{filtered.length}</span> / {master.count}
            </span>
          )}
          <div className="ml-auto">
            <input
              type="text"
              placeholder="종목 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 rounded-lg bg-[#1e1e22] px-4 py-2 text-[13px] text-white placeholder:text-[#5a5a5e] outline-none focus:ring-1 focus:ring-white/20"
            />
          </div>
        </div>
        {filterOpen && (
          <div className="px-6 pb-2 pt-0.5 flex items-center gap-5 flex-wrap">
            <FilterField
              label="선물량 ≥"
              draft={filterDrafts.futVol}
              setDraft={(v) => setFilterDrafts((p) => ({ ...p, futVol: v }))}
              onCommit={() => commitFilter('futVol')}
              presets={[1000, 10000]}
              presetLabels={['1천', '1만']}
              onPreset={(v) => setPreset('futVol', v)}
              unit="계약"
            />
            <FilterField
              label="|갭bp| ≥"
              draft={filterDrafts.gapBp}
              setDraft={(v) => setFilterDrafts((p) => ({ ...p, gapBp: v }))}
              onCommit={() => commitFilter('gapBp')}
              presets={[30, 50, 70, 100]}
              presetLabels={['30', '50', '70', '100']}
              onPreset={(v) => setPreset('gapBp', v)}
              unit="bp"
            />
            <FilterField
              label="스프량 ≥"
              draft={filterDrafts.spreadVol}
              setDraft={(v) => setFilterDrafts((p) => ({ ...p, spreadVol: v }))}
              onCommit={() => commitFilter('spreadVol')}
              presets={[100, 1000]}
              presetLabels={['100', '1천']}
              onPreset={(v) => setPreset('spreadVol', v)}
              unit="계약"
            />
          </div>
        )}
      </div>

      {/* 테이블 — main 스크롤에 thead가 페이지 헤더 바로 아래에 sticky.
          필터 펼침 여부에 따라 top 오프셋 변경 (헤더 높이 ~60 / ~120). */}
      <div className="px-2">
        <table className="w-max min-w-full border-collapse">
          <thead className={cn('sticky z-20', filterOpen ? 'top-[100px]' : 'top-[60px]')}>
            <tr className="text-[10px] text-[#8b8b8e] bg-black">
              {/* 종목 */}
              <Th sort={() => doSort('baseName')} active={sk === 'baseName'} asc={asc} left sticky className="pl-4 min-w-[110px]">종목</Th>
              {/* 일중 위치: 변화율 + 고저막대 */}
              <Th sort={() => doSort('spotChangeRate')} active={sk === 'spotChangeRate'} asc={asc} className="min-w-[78px]">일중</Th>
              {/* 가격 */}
              <Th sort={() => doSort('spotPrice')} active={sk === 'spotPrice'} asc={asc} className="min-w-[74px]">현물가</Th>
              <Th sort={() => doSort('futuresPrice')} active={sk === 'futuresPrice'} asc={asc} className="min-w-[74px]">선물가</Th>
              <Th sort={() => doSort('theoreticalPrice')} active={sk === 'theoreticalPrice'} asc={asc} className="min-w-[74px]">이론가</Th>
              {/* 베이시스 */}
              <Th sort={() => doSort('theoreticalBasis')} active={sk === 'theoreticalBasis'} asc={asc} className="min-w-[62px]">이론B</Th>
              <Th sort={() => doSort('marketBasis')} active={sk === 'marketBasis'} asc={asc} className="min-w-[62px]">시장B</Th>
              <Th sort={() => doSort('basisGap')} active={sk === 'basisGap'} asc={asc} className="min-w-[62px]">갭</Th>
              <Th sort={() => doSort('basisGapBp')} active={sk === 'basisGapBp'} asc={asc} className="min-w-[56px]">갭bp</Th>
              {/* 거래 */}
              <Th sort={() => doSort('spotCumVolume')} active={sk === 'spotCumVolume'} asc={asc} className="min-w-[76px]">현물대금</Th>
              <Th sort={() => doSort('futuresVolume')} active={sk === 'futuresVolume'} asc={asc} className="min-w-[64px]">선물량</Th>
              <Th sort={() => doSort('multiplier')} active={sk === 'multiplier'} asc={asc} className="min-w-[42px]">승수</Th>
              {/* 스프레드 */}
              <Th sort={() => doSort('spread')} active={sk === 'spread'} asc={asc} className="min-w-[64px]">스프레드</Th>
              <Th sort={() => doSort('spreadVolume')} active={sk === 'spreadVolume'} asc={asc} className="min-w-[52px]">스프량</Th>
              {/* 배당 */}
              <Th sort={() => doSort('dividend')} active={sk === 'dividend'} asc={asc} className="min-w-[56px]">배당금</Th>
              <Th className="min-w-[62px]">배당락</Th>
              {/* 액션 */}
              <Th className="min-w-[38px]">호가</Th>
              <Th className="min-w-[38px]">스프</Th>
              {/* 보유 */}
              <Th className="min-w-[48px]">031</Th>
              <Th className="min-w-[48px]">052</Th>
              <Th className="min-w-[34px]">펀드</Th>
              <Th className="min-w-[48px] pr-4">선물</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.baseCode} className="border-b border-white/[0.04] bg-black hover:bg-[#1d1d1d] transition-colors">
                {/* 종목 */}
                <td className="pl-4 pr-3 py-[11px] sticky left-0 z-10" style={{ backgroundColor: 'inherit' }}>
                  <div className="text-[11px] text-white leading-none">{r.baseName}</div>
                  <div className="text-[9px] text-[#5a5a5e] leading-none mt-[2px] tabular-nums">
                    {r.baseCode} / {r.frontCode}
                  </div>
                </td>
                {/* 일중 위치 */}
                <IntradayCell row={r} />
                {/* 가격 */}
                <PriceCell value={r.spotPrice} formatted={fP(r.spotPrice)} />
                <PriceCell value={r.futuresPrice} formatted={fP(r.futuresPrice)} />
                <C sub>{r.theoreticalPrice ? Math.round(r.theoreticalPrice).toLocaleString() : '-'}</C>
                {/* 베이시스 */}
                <C c={cV(r.theoreticalBasis)}>{fBi(r.theoreticalBasis)}</C>
                <C c={cV(r.marketBasis)}>{fB(r.marketBasis)}</C>
                <C c={cV(r.basisGap)}>{fBi(r.basisGap)}</C>
                <C c={cV(r.basisGapBp)}>{fBp(r.basisGapBp)}</C>
                {/* 거래 */}
                <C sub>{r.spotCumVolume ? fVol(r.spotCumVolume) : '-'}</C>
                <FuturesVolumeCell row={r} />
                <C mute>{r.multiplier % 1 === 0 ? r.multiplier : r.multiplier.toFixed(2)}</C>
                {/* 스프레드 */}
                <C c={cV(r.spread)}>{r.spreadHasTick ? fB(r.spread) : '-'}</C>
                <C sub>{r.spreadVolume ? r.spreadVolume.toLocaleString() : '-'}</C>
                {/* 배당 */}
                <DividendAmountCell row={r} />
                <C mute>{r.dividendDate ? r.dividendDate.slice(5) : '-'}</C>
                {/* 액션 */}
                <td className="px-1 py-[11px] text-center align-middle">
                  <button
                    onClick={() => setObTarget({ spotCode: r.baseCode, futuresCode: r.frontCode, spotName: r.baseName })}
                    className="text-[10px] text-white/90 bg-[#2a2a2e] border border-white/10 rounded px-2.5 py-[3px] hover:bg-[#444448] transition-colors"
                  >호가</button>
                </td>
                <td className="px-1 py-[11px] text-center align-middle">
                  <button
                    onClick={() => r.spreadCode && setSpreadTarget({ spreadCode: r.spreadCode, spotName: r.baseName })}
                    className={cn('text-[10px] rounded px-2.5 py-[3px] border transition-colors', r.spreadCode ? 'text-white/90 bg-[#2a2a2e] border-white/10 hover:bg-[#444448]' : 'text-[#3a3a3e] border-transparent cursor-default')}
                  >스프</button>
                </td>
                {/* 보유 */}
                <C>{r.holding031 ? r.holding031.toLocaleString() : '-'}</C>
                <C>{r.holding052 ? r.holding052.toLocaleString() : '-'}</C>
                <td className="px-1 py-[11px] text-center align-middle">
                  <button className="text-[10px] text-white/90 bg-[#2a2a2e] border border-white/10 rounded px-2.5 py-[3px] hover:bg-[#444448] transition-colors">조회</button>
                </td>
                <C sub className="pr-4">{r.futuresHolding ? r.futuresHolding.toLocaleString() : '-'}</C>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 호가창 모달 */}
      {obTarget && (
        <OrderbookModal
          spotCode={obTarget.spotCode}
          futuresCode={obTarget.futuresCode}
          spotName={obTarget.spotName}
          onClose={closeOb}
        />
      )}

      {/* 스프레드 호가창 모달 */}
      {spreadTarget && (
        <SpreadOrderbookModal
          spreadCode={spreadTarget.spreadCode}
          spotName={spreadTarget.spotName}
          onClose={closeSpread}
        />
      )}
    </div>
  )
}

// ── 컴포넌트 ──

function Center({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className="flex h-full items-center justify-center"><p className={cn('text-[13px] text-[#8b8b8e]', className)}>{children}</p></div>
}

function Th({ children, className, sort, active, asc, left, sticky, style }: {
  children: React.ReactNode; className?: string; sort?: () => void; active?: boolean; asc?: boolean
  left?: boolean; sticky?: boolean; style?: React.CSSProperties
}) {
  return (
    <th
      className={cn(
        'px-2 py-[11px] font-normal whitespace-nowrap border-b border-white/[0.06]',
        left ? 'text-left' : 'text-right',
        sort ? 'cursor-pointer select-none hover:text-white transition-colors' : '',
        active ? 'text-white' : '',
        sticky && 'sticky left-0 bg-black z-30',
        className,
      )}
      style={style}
      onClick={sort}
    >
      {children}
      {active && <span className="ml-1 text-[9px] opacity-50">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}

function C({ children, c, sub, mute, className }: {
  children: React.ReactNode; c?: string; sub?: boolean; mute?: boolean; className?: string
}) {
  return (
    <td className={cn(
      'px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap',
      c || 'text-white',
      className,
    )}>
      {children}
    </td>
  )
}

/** 배당금 셀 — 색깔로 확정/추정 구분, 호버 시 항목별 분해 툴팁.
 * 화면 아래쪽 행은 툴팁이 잘리니 사용 가능 공간을 보고 위/아래 자동 배치. */
function DividendAmountCell({ row }: { row: Row }) {
  const items = row.dividendItems
  const cellRef = useRef<HTMLTableCellElement>(null)
  const [openUp, setOpenUp] = useState(false)

  if (items.length === 0) {
    return <td className="px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap text-white">-</td>
  }
  const allConfirmed = row.dividendEstimatedAmt === 0
  const allEstimated = row.dividendConfirmedAmt === 0
  const color = allConfirmed ? 'text-up' : allEstimated ? 'text-warning' : 'text-white'
  const showSum = items.length > 1
  // 툴팁 대략 높이: 항목당 ~22px + 합계 줄 ~28px + 패딩 ~16px
  const estTooltipHeight = items.length * 22 + (showSum ? 28 : 0) + 16

  const handleEnter = () => {
    if (!cellRef.current) return
    const rect = cellRef.current.getBoundingClientRect()
    setOpenUp(window.innerHeight - rect.bottom < estTooltipHeight + 8)
  }

  return (
    <td
      ref={cellRef}
      onMouseEnter={handleEnter}
      className="px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap relative group/div cursor-help"
    >
      <span className={color}>{row.dividend.toLocaleString()}</span>
      <div className={cn(
        'hidden group-hover/div:block absolute z-30 right-0 w-72 bg-bg-surface-2 border border-border-light rounded px-3 py-2 text-[11px] text-left pointer-events-none shadow-lg',
        openUp ? 'bottom-full mb-1' : 'top-full mt-1',
      )}>
        <div className="grid grid-cols-[auto_auto_1fr_auto] gap-x-3 gap-y-1 items-baseline">
          {items.map((d, i) => (
            <Fragment key={i}>
              <span className="text-t3 font-mono">{d.ex_date}</span>
              <span className="text-t4 text-[10px] uppercase tracking-wide">{d.period}</span>
              <span className={cn('text-right tabular-nums', d.confirmed ? 'text-up' : 'text-warning')}>
                {d.amount.toLocaleString()}원
              </span>
              <span className={cn('text-[10px] font-medium', d.confirmed ? 'text-up' : 'text-warning')}>
                {d.confirmed ? '확정' : '예상'}
              </span>
            </Fragment>
          ))}
          {showSum && (
            <>
              <div className="col-span-4 border-t border-border-light my-0.5" />
              <span className="text-t2 font-medium">합계</span>
              <span></span>
              <span className="text-right tabular-nums text-t1 font-medium">{row.dividend.toLocaleString()}원</span>
              <span></span>
            </>
          )}
        </div>
      </div>
    </td>
  )
}

/** 가격 변동 시 배경 플래시 셀 (0.3초) */
/**
 * 일중 위치 셀 — 변화율 + 고저 막대 + 호버 tooltip
 * 위: ±X.XX% (전일 종가 대비)
 * 아래: ▌────●────▌ 형태로 현재가가 [low, high] 안에서 어디 있는지
 */
function IntradayCell({ row }: { row: Row }) {
  const { spotHigh: hi, spotLow: lo, spotPrice: cur, spotChangeRate: rate, spotPrevClose: pc } = row
  const cellRef = useRef<HTMLTableCellElement>(null)
  const [openUp, setOpenUp] = useState(false)

  const valid = cur > 0 && hi > 0 && lo > 0 && hi >= lo
  const pos = valid ? (hi === lo ? 0.5 : Math.max(0, Math.min(1, (cur - lo) / (hi - lo)))) : 0.5
  const rateClass = !pc || cur === 0 ? 'text-[#5a5a5e]' : rate > 0 ? 'text-[#00b26b]' : rate < 0 ? 'text-[#bb4a65]' : 'text-[#8b8b8e]'
  const rateText = !pc || cur === 0 ? '-' : `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`

  const handleEnter = () => {
    if (!cellRef.current) return
    const rect = cellRef.current.getBoundingClientRect()
    setOpenUp(window.innerHeight - rect.bottom < 110)
  }

  return (
    <td
      ref={cellRef}
      onMouseEnter={handleEnter}
      className="px-2 py-[11px] align-middle relative group/intra cursor-help"
    >
      <div className="flex flex-col items-stretch gap-[3px]">
        <div className={cn('text-[10px] tabular-nums text-right leading-none', rateClass)}>{rateText}</div>
        {valid ? (
          <div className="relative h-[7px]">
            {/* 아래쪽으로 가리키는 삼각형 마커 (CSS border trick) */}
            <div
              className="absolute top-0"
              style={{
                left: `calc(${pos * 100}% - 4px)`,
                width: 0,
                height: 0,
                borderLeft: '4px solid transparent',
                borderRight: '4px solid transparent',
                borderTop: '4px solid #d1d1d6',
              }}
            />
            {/* 얇은 가로선 */}
            <div className="absolute bottom-0 left-0 right-0 h-px bg-[#3a3a3e]" />
          </div>
        ) : (
          <div className="h-[7px]"><div className="absolute bottom-0 left-0 right-0 h-px bg-[#1a1a1d]" /></div>
        )}
      </div>
      <div className={cn(
        'hidden group-hover/intra:block absolute z-30 left-1/2 -translate-x-1/2 w-52 bg-bg-surface-2 border border-border-light rounded px-3 py-2 text-[11px] text-left pointer-events-none shadow-lg',
        openUp ? 'bottom-full mb-1' : 'top-full mt-1',
      )}>
        {valid ? (
          <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 items-baseline tabular-nums">
            <span className="text-t3">고가</span>
            <span className="text-right text-t1">{hi.toLocaleString()}</span>
            <RateBadge value={pc > 0 ? ((hi - pc) / pc) * 100 : null} />
            <span className="text-t3">현재</span>
            <span className="text-right text-t1 font-medium">{cur.toLocaleString()}</span>
            <RateBadge value={pc > 0 ? rate : null} />
            <span className="text-t3">저가</span>
            <span className="text-right text-t1">{lo.toLocaleString()}</span>
            <RateBadge value={pc > 0 ? ((lo - pc) / pc) * 100 : null} />
            {pc > 0 && (
              <>
                <span className="col-span-3 border-t border-border-light my-0.5" />
                <span className="text-t3">전일</span>
                <span className="text-right text-t1">{pc.toLocaleString()}</span>
                <span />
              </>
            )}
          </div>
        ) : (
          <span className="text-t3">데이터 없음</span>
        )}
      </div>
    </td>
  )
}

/** 선물량 셀 — 거래량 표시, 호버 시 미결제약정/전일대비/전일대비% 툴팁.
 * 미결 = openyak (JC0 실시간) 또는 mgjv (t8402 초기). 갱신 주기 분당 ~1회. */
function FuturesVolumeCell({ row }: { row: Row }) {
  const cellRef = useRef<HTMLTableCellElement>(null)
  const [openUp, setOpenUp] = useState(false)
  const oi = row.openInterest
  const oic = row.openInterestChange
  const hasOI = typeof oi === 'number'
  const prevOI = hasOI && typeof oic === 'number' ? oi - oic : null
  const oicRate = prevOI && prevOI > 0 && typeof oic === 'number' ? (oic / prevOI) * 100 : null

  const handleEnter = () => {
    if (!cellRef.current) return
    const rect = cellRef.current.getBoundingClientRect()
    setOpenUp(window.innerHeight - rect.bottom < 90)
  }

  return (
    <td
      ref={cellRef}
      onMouseEnter={handleEnter}
      className={cn(
        'px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap relative group/oi',
        hasOI ? 'cursor-help' : '',
      )}
    >
      <span className="text-t2">{row.futuresVolume ? row.futuresVolume.toLocaleString() : '-'}</span>
      {hasOI && (
        <div className={cn(
          'hidden group-hover/oi:block absolute z-30 right-0 w-56 bg-bg-surface-2 border border-border-light rounded px-3 py-2 text-[11px] text-left pointer-events-none shadow-lg',
          openUp ? 'bottom-full mb-1' : 'top-full mt-1',
        )}>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline tabular-nums">
            <span className="text-t3">미결수량</span>
            <span className="text-right text-t1">{oi.toLocaleString()}</span>
            <span className="text-t3">전일대비</span>
            <span className={cn(
              'text-right',
              typeof oic !== 'number' ? 'text-t3' : oic > 0 ? 'text-up' : oic < 0 ? 'text-down' : 'text-t1',
            )}>
              {typeof oic === 'number' ? `${oic > 0 ? '+' : ''}${oic.toLocaleString()}` : '-'}
            </span>
            <span className="text-t3">전일대비%</span>
            <span className={cn(
              'text-right',
              oicRate == null ? 'text-t3' : oicRate > 0 ? 'text-up' : oicRate < 0 ? 'text-down' : 'text-t1',
            )}>
              {oicRate == null ? '-' : `${oicRate > 0 ? '+' : ''}${oicRate.toFixed(2)}%`}
            </span>
          </div>
        </div>
      )}
    </td>
  )
}

function RateBadge({ value }: { value: number | null }) {
  if (value == null) return <span />
  const cls = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-t3'
  return (
    <span className={cn('text-right text-[10px] tabular-nums', cls)}>
      {value > 0 ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

function PriceCell({ value, formatted }: { value: number; formatted: string }) {
  const ref = useRef<HTMLTableCellElement>(null)
  const prev = useRef(value)

  useEffect(() => {
    if (prev.current === value || !ref.current) { prev.current = value; return }
    const dir = value > prev.current ? 'up' : 'down'
    prev.current = value
    const el = ref.current
    el.style.backgroundColor = dir === 'up' ? 'rgba(0,178,107,0.15)' : 'rgba(187,74,101,0.15)'
    const t = setTimeout(() => { el.style.backgroundColor = '' }, 300)
    return () => clearTimeout(t)
  }, [value])

  return (
    <td
      ref={ref}
      className="px-2 py-[11px] text-right text-[11px] tabular-nums whitespace-nowrap text-white"
      style={{ transition: 'background-color 0.3s ease-out' }}
    >
      {formatted}
    </td>
  )
}

// ── 포맷 ──

function cV(v: number) { return v === 0 ? 'text-[#e0e0e3]' : v > 0 ? 'text-[#00b26b]' : 'text-[#bb4a65]' }
function fP(v: number) { return v ? v.toLocaleString() : '-' }
function fB(v: number) { return `${v > 0 ? '+' : ''}${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}` }
function fBi(v: number) { const r = Math.round(v); return `${r > 0 ? '+' : ''}${r.toLocaleString()}` }
function fBp(v: number) { return `${v > 0 ? '+' : ''}${v.toFixed(2)}` }
// ── 필터 필드 ──

function FilterField({
  label, draft, setDraft, onCommit, presets, presetLabels, onPreset, unit,
}: {
  label: string
  draft: string
  setDraft: (v: string) => void
  onCommit: () => void
  presets: number[]
  presetLabels: string[]
  onPreset: (v: number) => void
  unit: string
}) {
  const isActive = draft.trim().length > 0 && parseFloat(draft) > 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-[#8b8b8e] whitespace-nowrap">{label}</span>
      <div className={cn(
        'flex items-center gap-1 rounded-md h-[28px] px-2.5',
        isActive ? 'bg-accent/15 ring-1 ring-accent/40' : 'bg-[#1e1e22]',
      )}>
        <input
          type="number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="w-16 bg-transparent text-[13px] text-white tabular-nums outline-none text-right [appearance:textfield] [&::-webkit-inner-spin-button]:hidden [&::-webkit-outer-spin-button]:hidden"
          placeholder="—"
        />
        <span className="text-[12px] text-[#8b8b8e]">{unit}</span>
      </div>
      <div className="flex items-center gap-1">
        {presets.map((p, i) => (
          <button
            key={p}
            onClick={() => onPreset(p)}
            className="h-[28px] rounded bg-[#1e1e22] px-2 text-[12px] text-[#8b8b8e] hover:bg-[#2e2e32] hover:text-white transition-colors"
          >
            {presetLabels[i]}
          </button>
        ))}
      </div>
    </div>
  )
}

function fmtDate(s: string) { return s.length >= 10 ? s.slice(5, 10) : s }
function fmtExpiry(e: string) {
  if (e.length === 8) return `${e.slice(4, 6)}-${e.slice(6, 8)}`
  if (e.length === 6) return `${e.slice(4, 6)}월`
  return e || '-'
}
/** 만기 문자열을 ISO 일자(YYYY-MM-DD)로 변환. 배당 매칭 cutoff 계산용.
 *  YYYYMMDD: 그 날짜 그대로
 *  YYYYMM (back month — 정확한 만기일 미상): 해당 월 말일 사용 */
function expiryToCutoffDate(e: string): string {
  if (e.length === 8) {
    return `${e.slice(0, 4)}-${e.slice(4, 6)}-${e.slice(6, 8)}`
  }
  if (e.length === 6) {
    const year = parseInt(e.slice(0, 4), 10)
    const month = parseInt(e.slice(4, 6), 10)
    const lastDay = new Date(year, month, 0).getDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  }
  return ''
}
function fVol(v: number) {
  if (v >= 1e12) return `${(v / 1e12).toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}조`
  if (v >= 1e8) return `${Math.round(v / 1e8).toLocaleString()}억`
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`
  return v.toLocaleString()
}
