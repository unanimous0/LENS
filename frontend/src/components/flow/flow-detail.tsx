import { createChart, LineStyle, type IChartApi, type LogicalRange } from 'lightweight-charts'
import { useEffect, useRef, useState } from 'react'

/**
 * 수급 종목 상세 — 위: 수정종가 + 외인 평단 추정선 / 아래: 일별 외인 순매수 막대 + 누적선.
 * 데이터는 /api/flow/stocks/{code} (지표 정본의 소비자 — 재계산 없음, 평단 추정만 클라이언트).
 */

type SeriesRow = {
  d: string
  f_eok: number
  i_eok: number
  cum_f_eok: number
  cum_i_eok: number
  adj_close: number | null
}

const C = {
  bg: '#111111',
  surface: '#1c1c1e',
  t1: '#ffffff',
  t3: '#8e8e93',
  accent: '#34c759',
  blue: '#0a84ff',
  down: '#ff3b30',
  warning: '#ff9f0a',
}

const chartOpts = {
  layout: { background: { color: C.bg }, textColor: C.t3, fontSize: 10 },
  grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
  timeScale: { borderColor: C.surface, timeVisible: false },
  rightPriceScale: { borderColor: C.surface },
  crosshair: { mode: 0 },
} as const

/**
 * 수급 해석을 오염시키는 이벤트 날짜 (하드코딩 캘린더 — 보정 말고 마커로만 표시).
 * - 선물·옵션 만기: 매월 둘째 목요일 (memory reference_stock_futures_expiry)
 * - MSCI 분기 리밸: 2·5·8·11월 마지막 영업일 근사 (실제는 월말 몇일 전이나 근사)
 * rows 범위 내 해당 날짜만 반환. YYYY-MM-DD 문자열.
 */
function eventMarkers(rows: SeriesRow[]): { time: string; label: string; color: string }[] {
  if (rows.length === 0) return []
  const first = rows[0].d
  const last = rows[rows.length - 1].d
  const dates = new Set(rows.map((r) => r.d))
  const out: { time: string; label: string; color: string }[] = []
  const startY = Number(first.slice(0, 4))
  const endY = Number(last.slice(0, 4))
  for (let y = startY; y <= endY; y++) {
    for (let m = 0; m < 12; m++) {
      // 둘째 목요일 = 첫 목요일 + 7일. 1일의 요일로 첫 목요일 계산.
      const first1 = new Date(Date.UTC(y, m, 1))
      const firstThu = 1 + ((4 - first1.getUTCDay() + 7) % 7)
      const secondThu = firstThu + 7
      const exp = `${y}-${String(m + 1).padStart(2, '0')}-${String(secondThu).padStart(2, '0')}`
      if (exp >= first && exp <= last) {
        const near = nearestTradingDay(exp, dates)
        if (near) out.push({ time: near, label: '만기', color: '#8e8e93' })
      }
      // MSCI 리밸 근사: 2·5·8·11월 25일 (실제 발효일 근사)
      if ([1, 4, 7, 10].includes(m)) {
        const msci = `${y}-${String(m + 1).padStart(2, '0')}-25`
        if (msci >= first && msci <= last) {
          const near = nearestTradingDay(msci, dates)
          if (near) out.push({ time: near, label: 'MSCI', color: '#0a84ff' })
        }
      }
    }
  }
  return out
}

/** 이벤트 날짜가 휴장이면 가장 가까운(±3일) 거래일로 스냅. */
function nearestTradingDay(target: string, dates: Set<string>): string | null {
  if (dates.has(target)) return target
  const t = new Date(target + 'T00:00:00Z').getTime()
  for (let d = 1; d <= 3; d++) {
    for (const sign of [-1, 1]) {
      const cand = new Date(t + sign * d * 86_400_000).toISOString().slice(0, 10)
      if (dates.has(cand)) return cand
    }
  }
  return null
}

/** 외인 평단 추정: 누적 순매수 저점 이후 매집 구간의 Σ금액 ÷ Σ(금액/종가). */
function estimateAvgPrice(rows: SeriesRow[]): number | null {
  let minIdx = 0
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].cum_f_eok < rows[minIdx].cum_f_eok) minIdx = i
  }
  let amount = 0
  let shares = 0
  for (let i = minIdx; i < rows.length; i++) {
    const r = rows[i]
    if (r.f_eok > 0 && r.adj_close && r.adj_close > 0) {
      amount += r.f_eok
      shares += r.f_eok / r.adj_close
    }
  }
  return shares > 0 ? amount / shares : null
}

export function FlowDetail({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const [rows, setRows] = useState<SeriesRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(365)
  const priceRef = useRef<HTMLDivElement>(null)
  const flowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    // setRows(null) 안 함 — code 전환은 부모의 key remount로 초기화됨(effect 내 동기
    // setState 회피). days 전환 시엔 이전 차트가 새 데이터 올 때까지 잠깐 유지.
    fetch(`/api/flow/stocks/${code}?days=${days}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{ rows: SeriesRow[] }>
      })
      .then((d) => {
        if (!cancelled) {
          setRows(d.rows)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [code, days])

  useEffect(() => {
    if (!rows || !priceRef.current || !flowRef.current) return
    const priceChart = createChart(priceRef.current, {
      ...chartOpts,
      width: priceRef.current.clientWidth,
      height: 240,
    })
    const flowChart = createChart(flowRef.current, {
      ...chartOpts,
      width: flowRef.current.clientWidth,
      height: 170,
    })

    const t = (d: string) => d as never
    const priced = rows.filter((r) => r.adj_close != null)
    const priceSeries = priceChart.addLineSeries({
      color: C.t1,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    priceSeries.setData(priced.map((r) => ({ time: t(r.d), value: r.adj_close! })))

    const avg = estimateAvgPrice(rows)
    if (avg != null) {
      priceSeries.createPriceLine({
        price: avg,
        color: C.warning,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
        title: '외인 평단(추정)',
      })
    }

    // 이벤트 마커 (만기·MSCI) — 수급 스파이크가 이벤트성인지 눈으로 할인
    const markers = eventMarkers(rows)
    if (markers.length > 0) {
      priceSeries.setMarkers(
        markers.map((m) => ({
          time: t(m.time),
          position: 'aboveBar' as const,
          color: m.color,
          shape: 'circle' as const,
          text: m.label,
        }))
      )
    }

    // 아래: 일별 외인 순매수 막대(우축) + 외인/기관 누적선(좌축)
    const bars = flowChart.addHistogramSeries({
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
      priceScaleId: 'right',
    })
    bars.setData(rows.map((r) => ({ time: t(r.d), value: r.f_eok, color: r.f_eok >= 0 ? '#34c75955' : '#ff3b3055' })))
    const cumF = flowChart.addLineSeries({ color: C.accent, lineWidth: 2, priceScaleId: 'left' })
    cumF.setData(rows.map((r) => ({ time: t(r.d), value: r.cum_f_eok })))
    const cumI = flowChart.addLineSeries({ color: C.blue, lineWidth: 1, priceScaleId: 'left' })
    cumI.setData(rows.map((r) => ({ time: t(r.d), value: r.cum_i_eok })))
    flowChart.priceScale('left').applyOptions({ visible: true, borderColor: C.surface })

    priceChart.timeScale().fitContent()
    flowChart.timeScale().fitContent()

    // 두 차트 시간축 동기화 (guard로 무한루프 방지)
    let guard = false
    const link = (dst: IChartApi) => (range: LogicalRange | null) => {
      if (guard || !range) return
      guard = true
      dst.timeScale().setVisibleLogicalRange(range)
      guard = false
    }
    const h1 = link(flowChart)
    const h2 = link(priceChart)
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(h1)
    flowChart.timeScale().subscribeVisibleLogicalRangeChange(h2)

    return () => {
      priceChart.remove()
      flowChart.remove()
    }
  }, [rows])

  return (
    <div className="panel p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-sm font-medium text-t1">
          {name} <span className="text-t3">{code}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-accent" />
          <span className="text-t2">외인 누적</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-blue" />
          <span className="text-t2">기관 누적</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-sm bg-warning" />
          <span className="text-t2">외인 평단(추정)</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex overflow-hidden rounded-sm border border-bg-surface">
            {[365, 1095].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2 py-0.5 ${days === d ? 'bg-accent/20 text-accent' : 'text-t3'}`}
              >
                {d === 365 ? '1년' : '3년'}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="rounded-sm bg-bg-surface px-2 py-0.5 text-t3 hover:text-t1">
            닫기 ✕
          </button>
        </div>
      </div>
      {error && <div className="py-4 text-xs text-down">로딩 실패: {error}</div>}
      {!rows && !error && <div className="py-4 text-xs text-t3">로딩 중…</div>}
      <div ref={priceRef} className={rows ? '' : 'hidden'} />
      <div ref={flowRef} className={`mt-1 ${rows ? '' : 'hidden'}`} />
      {rows && (
        <div className="mt-1.5 text-[11px] leading-relaxed text-t3">
          위: 수정종가 + <span className="text-warning">외인 평단 추정선</span>(누적 저점 이후 매집
          구간의 Σ금액÷Σ주수) — 현재가가 평단 위면 외인이 수익권. 아래: 일별 외인 순매수(막대,
          우축·억원) + 누적 순매수(선, 좌축·억원).
        </div>
      )}
    </div>
  )
}
