import { createChart, LineStyle, type IChartApi } from 'lightweight-charts'
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'

/**
 * 수급 종목 상세 — 4개 차트로 분리:
 *  1. 주가 (수정주가 캔들 + 외인 평단 추정선 + 이벤트 마커)
 *  2. 순매수 모멘텀 (외인 일별 순매수 막대 + 5/20일 이동평균선)
 *  3. 순매수 (외/기/개 일별) — 차트 ↔ 테이블 전환
 *  4. 누적순매수 (외/기/개 누적) — 차트 ↔ 테이블 전환
 * 데이터는 /api/flow/stocks/{code} (지표 정본의 소비자 — 평단·MA만 클라이언트 계산).
 * 참고: alphasquare 종목분석 "투자자별 매매동향".
 */

type SeriesRow = {
  d: string
  f_eok: number
  i_eok: number
  r_eok: number
  cum_f_eok: number
  cum_i_eok: number
  cum_r_eok: number
  o: number | null
  h: number | null
  l: number | null
  adj_close: number | null
}

// globals.css 토큰과 동일 (다른 화면과 색 통일)
const C = {
  bg: '#111111',
  surface: '#1c1c1e',
  t1: '#ffffff',
  t3: '#8e8e93',
  up: '#30d158',
  accent: '#30d158',
  blue: '#0a84ff',
  down: '#ee382e',
  warning: '#ff9f0a',
  retail: '#8e8e93', // 개인
}

const chartOpts = {
  layout: { background: { color: C.bg }, textColor: C.t3, fontSize: 10 },
  grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
  timeScale: { borderColor: C.surface, timeVisible: false },
  rightPriceScale: { borderColor: C.surface },
  crosshair: { mode: 0 },
} as const

const t = (d: string) => d as never

/** 이벤트 날짜 (하드코딩 캘린더): 선물 만기(둘째 목), MSCI 리밸(2·5·8·11월 근사). */
function eventMarkers(rows: SeriesRow[]): { time: string; color: string; text: string }[] {
  if (rows.length === 0) return []
  const first = rows[0].d
  const last = rows[rows.length - 1].d
  const dates = new Set(rows.map((r) => r.d))
  const out: { time: string; color: string; text: string }[] = []
  for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    for (let m = 0; m < 12; m++) {
      const first1 = new Date(Date.UTC(y, m, 1))
      const secondThu = 1 + ((4 - first1.getUTCDay() + 7) % 7) + 7
      const exp = `${y}-${String(m + 1).padStart(2, '0')}-${String(secondThu).padStart(2, '0')}`
      if (exp >= first && exp <= last) {
        const near = nearestTradingDay(exp, dates)
        if (near) out.push({ time: near, color: C.t3, text: '만기' })
      }
      if ([1, 4, 7, 10].includes(m)) {
        const msci = `${y}-${String(m + 1).padStart(2, '0')}-25`
        if (msci >= first && msci <= last) {
          const near = nearestTradingDay(msci, dates)
          if (near) out.push({ time: near, color: C.blue, text: 'MSCI' })
        }
      }
    }
  }
  return out
}

function nearestTradingDay(target: string, dates: Set<string>): string | null {
  if (dates.has(target)) return target
  const tm = new Date(target + 'T00:00:00Z').getTime()
  for (let d = 1; d <= 3; d++) {
    for (const sign of [-1, 1]) {
      const cand = new Date(tm + sign * d * 86_400_000).toISOString().slice(0, 10)
      if (dates.has(cand)) return cand
    }
  }
  return null
}

/** 외인 평단 추정: 누적 순매수 저점 이후 매집 구간 Σ금액 ÷ Σ(금액/종가). */
function estimateAvgPrice(rows: SeriesRow[]): number | null {
  let minIdx = 0
  for (let i = 1; i < rows.length; i++) if (rows[i].cum_f_eok < rows[minIdx].cum_f_eok) minIdx = i
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

/** 단순 이동평균 (n일). 앞쪽 n-1개는 whatever 있는 만큼 평균. */
function sma(vals: number[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]
    if (i >= n) sum -= vals[i - n]
    out.push(i >= n - 1 ? sum / n : null)
  }
  return out
}

export function FlowDetail({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const [rows, setRows] = useState<SeriesRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(365)
  const [netView, setNetView] = useState<'chart' | 'table'>('chart')
  const [cumView, setCumView] = useState<'chart' | 'table'>('chart')

  useEffect(() => {
    let cancelled = false
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

  return (
    <div className="panel p-3">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-sm font-medium text-t1">
          {name} <span className="text-t3">{code}</span>
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

      {rows && (
        <div className="grid gap-3 lg:grid-cols-2">
          <PriceChart rows={rows} />
          <MomentumChart rows={rows} />
          <NetFlowPanel rows={rows} view={netView} setView={setNetView} />
          <CumFlowPanel rows={rows} view={cumView} setView={setCumView} />
        </div>
      )}
    </div>
  )
}

// ── 1. 주가 (캔들 + 평단선 + 이벤트 마커) ───────────────────────────────
function PriceChart({ rows }: { rows: SeriesRow[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, width: ref.current.clientWidth, height: 210 })
    chartRef.current = chart
    const priced = rows.filter((r) => r.adj_close != null && r.o != null && r.h != null && r.l != null)
    const s = chart.addCandlestickSeries({
      upColor: C.up,
      downColor: C.down,
      borderUpColor: C.up,
      borderDownColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    s.setData(priced.map((r) => ({ time: t(r.d), open: r.o!, high: r.h!, low: r.l!, close: r.adj_close! })))
    const avg = estimateAvgPrice(rows)
    if (avg != null)
      s.createPriceLine({ price: avg, color: C.warning, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: '외인 평단' })
    const markers = eventMarkers(rows)
    if (markers.length)
      s.setMarkers(markers.map((m) => ({ time: t(m.time), position: 'aboveBar' as const, color: m.color, shape: 'circle' as const, text: m.text })))
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [rows])
  useResize(ref, chartRef)
  return (
    <ChartBox title="① 주가 (수정주가)" legend={[['외인 평단', C.warning]]}>
      <div ref={ref} className="h-[210px] w-full" />
    </ChartBox>
  )
}

// ── 2. 순매수 모멘텀 (외인 일별 순매수 막대 + 5/20 MA) ──────────────────
function MomentumChart({ rows }: { rows: SeriesRow[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, width: ref.current.clientWidth, height: 210 })
    chartRef.current = chart
    const bars = chart.addHistogramSeries({ priceFormat: { type: 'price', precision: 0, minMove: 1 } })
    bars.setData(rows.map((r) => ({ time: t(r.d), value: r.f_eok, color: r.f_eok >= 0 ? '#30d15866' : '#ee382e66' })))
    const vals = rows.map((r) => r.f_eok)
    const ma5 = sma(vals, 5)
    const ma20 = sma(vals, 20)
    const l5 = chart.addLineSeries({ color: C.warning, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    l5.setData(rows.map((r, i) => ({ time: t(r.d), value: ma5[i] })).filter((x) => x.value != null) as never)
    const l20 = chart.addLineSeries({ color: C.blue, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    l20.setData(rows.map((r, i) => ({ time: t(r.d), value: ma20[i] })).filter((x) => x.value != null) as never)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [rows])
  useResize(ref, chartRef)
  return (
    <ChartBox
      title="② 순매수 모멘텀 (외인, 억)"
      legend={[
        ['일별', C.t3],
        ['5일선', C.warning],
        ['20일선', C.blue],
      ]}
    >
      <div ref={ref} className="h-[210px] w-full" />
    </ChartBox>
  )
}

// ── 3. 순매수 (외/기/개 일별) — 차트 ↔ 테이블 ──────────────────────────
function NetFlowPanel({ rows, view, setView }: { rows: SeriesRow[]; view: 'chart' | 'table'; setView: (v: 'chart' | 'table') => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    if (view !== 'chart' || !ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, width: ref.current.clientWidth, height: 210 })
    chartRef.current = chart
    // 외/기/개 일별 순매수 — 3개 라인 (0선 중심)
    const add = (color: string, w: number, get: (r: SeriesRow) => number) => {
      const s = chart.addLineSeries({ color, lineWidth: w as never, priceLineVisible: false, lastValueVisible: false })
      s.setData(rows.map((r) => ({ time: t(r.d), value: get(r) })))
      return s
    }
    add(C.accent, 2, (r) => r.f_eok)
    add(C.blue, 1, (r) => r.i_eok)
    add(C.retail, 1, (r) => r.r_eok)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [rows, view])
  useResize(ref, chartRef)
  return (
    <ChartBox
      title="③ 순매수 (일별, 억)"
      legend={[
        ['외인', C.accent],
        ['기관', C.blue],
        ['개인', C.retail],
      ]}
      view={view}
      setView={setView}
    >
      {view === 'chart' ? (
        <div ref={ref} className="h-[210px] w-full" />
      ) : (
        <FlowTable rows={rows} kind="net" />
      )}
    </ChartBox>
  )
}

// ── 4. 누적순매수 (외/기/개) — 차트 ↔ 테이블 ───────────────────────────
function CumFlowPanel({ rows, view, setView }: { rows: SeriesRow[]; view: 'chart' | 'table'; setView: (v: 'chart' | 'table') => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  useEffect(() => {
    if (view !== 'chart' || !ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, width: ref.current.clientWidth, height: 210 })
    chartRef.current = chart
    const add = (color: string, w: number, get: (r: SeriesRow) => number) => {
      const s = chart.addLineSeries({ color, lineWidth: w as never, priceLineVisible: false, lastValueVisible: false })
      s.setData(rows.map((r) => ({ time: t(r.d), value: get(r) })))
      return s
    }
    add(C.accent, 2, (r) => r.cum_f_eok)
    add(C.blue, 1, (r) => r.cum_i_eok)
    add(C.retail, 1, (r) => r.cum_r_eok)
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [rows, view])
  useResize(ref, chartRef)
  return (
    <ChartBox
      title="④ 누적순매수 (억)"
      legend={[
        ['외인', C.accent],
        ['기관', C.blue],
        ['개인', C.retail],
      ]}
      view={view}
      setView={setView}
    >
      {view === 'chart' ? (
        <div ref={ref} className="h-[210px] w-full" />
      ) : (
        <FlowTable rows={rows} kind="cum" />
      )}
    </ChartBox>
  )
}

// ── 공통: 차트 박스 (제목 + 범례 + 선택적 차트/테이블 토글) ─────────────
function ChartBox({
  title,
  legend,
  view,
  setView,
  children,
}: {
  title: string
  legend: [string, string][]
  view?: 'chart' | 'table'
  setView?: (v: 'chart' | 'table') => void
  children: ReactNode
}) {
  return (
    <div className="rounded-sm bg-bg-surface/40 p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-t2">{title}</span>
        {legend.map(([label, color]) => (
          <span key={label} className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: color }} />
            <span className="text-t3">{label}</span>
          </span>
        ))}
        {view && setView && (
          <div className="ml-auto flex overflow-hidden rounded-sm border border-bg-surface">
            <button onClick={() => setView('chart')} className={`px-2 py-0.5 ${view === 'chart' ? 'bg-accent/20 text-accent' : 'text-t3'}`}>
              차트
            </button>
            <button onClick={() => setView('table')} className={`px-2 py-0.5 ${view === 'table' ? 'bg-accent/20 text-accent' : 'text-t3'}`}>
              테이블
            </button>
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

// ── 투자자별 매매동향 테이블 (날짜 역순, 외/기/개) ─────────────────────
function FlowTable({ rows, kind }: { rows: SeriesRow[]; kind: 'net' | 'cum' }) {
  const rev = [...rows].reverse()
  const cell = (v: number) => (
    <td className={`px-2 py-1 text-right tabular-nums ${v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3'}`}>
      {v > 0 ? '+' : ''}
      {v.toLocaleString(undefined, { maximumFractionDigits: 0 })}
    </td>
  )
  return (
    <div className="h-[210px] overflow-y-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-bg-surface text-t3">
          <tr>
            <th className="px-2 py-1 text-left font-normal">날짜</th>
            <th className="px-2 py-1 text-right font-normal">외인</th>
            <th className="px-2 py-1 text-right font-normal">기관</th>
            <th className="px-2 py-1 text-right font-normal">개인</th>
          </tr>
        </thead>
        <tbody>
          {rev.map((r) => (
            <tr key={r.d} className="border-t border-bg-surface/40">
              <td className="px-2 py-1 text-t2">{r.d.slice(2)}</td>
              {kind === 'net' ? (
                <>
                  {cell(r.f_eok)}
                  {cell(r.i_eok)}
                  {cell(r.r_eok)}
                </>
              ) : (
                <>
                  {cell(r.cum_f_eok)}
                  {cell(r.cum_i_eok)}
                  {cell(r.cum_r_eok)}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 차트 리사이즈 (컨테이너 폭 변경 시)
function useResize(ref: RefObject<HTMLDivElement | null>, chartRef: RefObject<IChartApi | null>) {
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && chartRef.current) chartRef.current.applyOptions({ width: Math.floor(w) })
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [ref, chartRef])
}
