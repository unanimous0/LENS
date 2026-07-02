import { createChart, LineStyle, type IChartApi, type LogicalRange, type SeriesMarker, type Time } from 'lightweight-charts'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

// 4개 차트 시간축 동기화용 — mount 시 register(chart), 반환 cleanup으로 unregister.
type RegisterFn = (chart: IChartApi | null) => () => void

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
  vol: number | null
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
  candleUp: '#089981', // 트레이딩뷰 기본 양봉 (청록)
  candleDown: '#f23645', // 트레이딩뷰 기본 음봉 (코랄)
}

const chartOpts = {
  layout: { background: { color: C.bg }, textColor: C.t3, fontSize: 10 },
  grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
  timeScale: { borderColor: C.surface, timeVisible: false },
  rightPriceScale: { borderColor: C.surface },
  crosshair: { mode: 0 },
} as const

const t = (d: string) => d as never

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

/** 단순 이동평균 (n일). 데이터 < n이면 null. */
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

/** 거래량 가중 이동평균 (n일). Σ(price×vol)/Σ(vol). vol 없으면 그 지점 null. */
function vwma(prices: number[], vols: (number | null)[], n: number): (number | null)[] {
  const out: (number | null)[] = []
  let pv = 0
  let vv = 0
  for (let i = 0; i < prices.length; i++) {
    const v = vols[i] ?? 0
    pv += prices[i] * v
    vv += v
    if (i >= n) {
      const ov = vols[i - n] ?? 0
      pv -= prices[i - n] * ov
      vv -= ov
    }
    out.push(i >= n - 1 && vv > 0 ? pv / vv : null)
  }
  return out
}

export function FlowDetail({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const [rows, setRows] = useState<SeriesRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(365)
  const [netView, setNetView] = useState<'chart' | 'table'>('chart')
  const [cumView, setCumView] = useState<'chart' | 'table'>('chart')

  // 4개 차트 시간축 동기화 (통계차익 상세와 동일 패턴): 차트를 state로 모아
  // useEffect에서 일괄 subscribe. 모든 차트가 rows 같은 길이(주가는 whitespace 패딩)라
  // logical range 인덱스 일치.
  // ⚠️ 각 차트는 createChart의 autoSize:true 필수 — 2열(grid-cols-2)에선 우측 열
  // 차트가 생성 시 폭 0이면 setVisibleLogicalRange를 무시해 sync가 깨진다.
  // autoSize 내부 ResizeObserver가 폭 확정 후 정상화 (수동 width/useResize 대체).
  const [charts, setCharts] = useState<IChartApi[]>([])
  const register = useCallback<RegisterFn>((chart) => {
    if (!chart) return () => {}
    setCharts((prev) => [...prev, chart])
    return () => setCharts((prev) => prev.filter((c) => c !== chart))
  }, [])

  useEffect(() => {
    if (charts.length < 2) return
    let guard = false
    const subs: Array<[IChartApi, (r: LogicalRange | null) => void]> = []
    charts.forEach((src) => {
      const h = (range: LogicalRange | null) => {
        if (guard || !range) return
        guard = true
        charts.forEach((dst) => {
          if (dst !== src) dst.timeScale().setVisibleLogicalRange(range)
        })
        guard = false
      }
      src.timeScale().subscribeVisibleLogicalRangeChange(h)
      subs.push([src, h])
    })
    return () => subs.forEach(([c, h]) => c.timeScale().unsubscribeVisibleLogicalRangeChange(h))
  }, [charts])

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
          <PriceChart rows={rows} register={register} />
          <MomentumChart rows={rows} register={register} />
          <CumFlowPanel rows={rows} view={cumView} setView={setCumView} register={register} />
          <NetFlowPanel rows={rows} view={netView} setView={setNetView} register={register} />
        </div>
      )}
    </div>
  )
}

// ── 1. 주가 (캔들 + 평단선 + 이평선) ────────────────────────────────────
function PriceChart({ rows, register }: { rows: SeriesRow[]; register: RegisterFn }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, autoSize: true })
    const s = chart.addCandlestickSeries({
      upColor: C.candleUp,
      downColor: C.candleDown,
      borderUpColor: C.candleUp,
      borderDownColor: C.candleDown,
      wickUpColor: C.candleUp,
      wickDownColor: C.candleDown,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    // rows 전체 사용 — OHLC 없는 날은 whitespace({time})로 패딩해 다른 차트와 인덱스 일치(동기화용)
    s.setData(
      rows.map((r) =>
        r.o != null && r.h != null && r.l != null && r.adj_close != null
          ? { time: t(r.d), open: r.o, high: r.h, low: r.l, close: r.adj_close }
          : { time: t(r.d) }
      )
    )
    // 주가 이동평균선 (50·100·200일, 수정종가) + VWMA 200(거래량 가중)
    // 실제 거래일(adj_close 있는 날)만으로 계산 — null 날을 NaN으로 섞으면 러닝-합
    // SMA가 그 지점 이후 영구 오염돼(3년 구간 거래정지 등) 이평선이 통째로 사라짐.
    const priced = rows.filter((r) => r.adj_close != null)
    const closes = priced.map((r) => r.adj_close as number)
    const vols = priced.map((r) => r.vol)
    const addLine = (series: (number | null)[], color: string, w: number, style?: LineStyle) => {
      const line = chart.addLineSeries({
        color,
        lineWidth: w as never,
        lineStyle: style,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      line.setData(
        priced
          .map((r, i) => ({ time: t(r.d), value: series[i] }))
          .filter((x) => x.value != null && !Number.isNaN(x.value)) as never
      )
    }
    addLine(sma(closes, 50), C.warning, 1)
    addLine(sma(closes, 100), C.blue, 1)
    addLine(sma(closes, 200), C.t1, 1) // 200일 = 흰색
    addLine(vwma(closes, vols, 200), '#a78bfa', 2, LineStyle.Dotted) // VWMA200 (보라 점선)
    const avg = estimateAvgPrice(rows)
    if (avg != null)
      // 회색 얇은 대시. title은 비워 차트 위 텍스트 태그 제거 (축 가격값만 표시). 범례로 식별.
      s.createPriceLine({ price: avg, color: C.t3, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: '' })
    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      chart.remove()
    }
  }, [rows, register])
  return (
    <ChartBox
      title="① 주가 (수정주가)"
      legend={[
        ['50일', C.warning],
        ['100일', C.blue],
        ['200일', C.t1],
        ['VWMA200', '#a78bfa'],
        ['외인평단', C.t3],
      ]}
    >
      <div ref={ref} className="h-[210px] w-full" />
    </ChartBox>
  )
}

// ── 2. 순매수 모멘텀 (외인/기관 토글 + 50/100/200 MA) ──────────────────
function MomentumChart({ rows, register }: { rows: SeriesRow[]; register: RegisterFn }) {
  const ref = useRef<HTMLDivElement>(null)
  const [who, setWho] = useState<'f' | 'i'>('f') // 외인 / 기관
  useEffect(() => {
    if (!ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, autoSize: true })
    const pick = (r: SeriesRow) => (who === 'f' ? r.f_eok : r.i_eok)
    const bars = chart.addHistogramSeries({ priceFormat: { type: 'price', precision: 0, minMove: 1 } })
    bars.setData(
      rows.map((r) => {
        const v = pick(r)
        return { time: t(r.d), value: v, color: v >= 0 ? '#30d15866' : '#ee382e66' }
      })
    )
    // 순매수 단기 이동평균 5·20일 = "최근 매수 강도" (일별은 0중심 진동이라 장기 MA는
    // 평평 → 무의미. 추세·골든/데드크로스는 누적 차트 ③에서 다룸)
    const vals = rows.map(pick)
    const addMa = (n: number, color: string) => {
      const ma = sma(vals, n)
      const line = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      line.setData(rows.map((r, i) => ({ time: t(r.d), value: ma[i] })).filter((x) => x.value != null) as never)
    }
    addMa(5, C.warning)
    addMa(20, C.blue)
    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      chart.remove()
    }
  }, [rows, who, register])
  return (
    <ChartBox
      title={`② 순매수 모멘텀 (${who === 'f' ? '외인' : '기관'}, 억)`}
      legend={[
        ['일별', C.t3],
        ['5일선', C.warning],
        ['20일선', C.blue],
      ]}
      seg={{
        value: who,
        onChange: (v) => setWho(v as 'f' | 'i'),
        options: [
          ['f', '외인'],
          ['i', '기관'],
        ],
      }}
    >
      <div ref={ref} className="h-[210px] w-full" />
    </ChartBox>
  )
}

// ── 3. 순매수 (외/기/개 일별) — 차트 ↔ 테이블 ──────────────────────────
function NetFlowPanel({ rows, view, setView, register }: { rows: SeriesRow[]; view: 'chart' | 'table'; setView: (v: 'chart' | 'table') => void; register: RegisterFn }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (view !== 'chart' || !ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, autoSize: true })
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
    const unreg = register(chart)
    return () => {
      unreg()
      chart.remove()
    }
  }, [rows, view, register])
  return (
    <ChartBox
      title="④ 순매수 (일별, 억)"
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

// ── 3. 누적순매수 (외인/기관 토글) + 20·60일 이평 + 골든/데드크로스 ─────
// 누적선은 주가처럼 추세를 갖는 시계열 → 이평 크로스가 의미 있음 (OBV+시그널선 개념).
// 일별(②)엔 추세가 없어 장기 이평이 평평 → 크로스 신호는 여기 누적에서 잡는다.
function CumFlowPanel({ rows, view, setView, register }: { rows: SeriesRow[]; view: 'chart' | 'table'; setView: (v: 'chart' | 'table') => void; register: RegisterFn }) {
  const ref = useRef<HTMLDivElement>(null)
  const [who, setWho] = useState<'f' | 'i'>('f') // 외인 / 기관
  useEffect(() => {
    if (view !== 'chart' || !ref.current) return
    const chart = createChart(ref.current, { ...chartOpts, autoSize: true })
    const cum = rows.map((r) => (who === 'f' ? r.cum_f_eok : r.cum_i_eok))
    // 선택 주체 누적선
    const cumColor = who === 'f' ? C.accent : C.blue
    const line = chart.addLineSeries({ color: cumColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    line.setData(rows.map((r, i) => ({ time: t(r.d), value: cum[i] })))
    // 20·60일 이평
    const ma20 = sma(cum, 20)
    const ma60 = sma(cum, 60)
    const addMa = (ma: (number | null)[], color: string) => {
      const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      s.setData(rows.map((r, i) => ({ time: t(r.d), value: ma[i] })).filter((x) => x.value != null) as never)
    }
    addMa(ma20, '#ffd60a') // 20일 (노랑)
    addMa(ma60, '#a78bfa') // 60일 (보라)
    // 골든/데드크로스 마커 (MA20 × MA60)
    const markers: SeriesMarker<Time>[] = []
    for (let i = 1; i < rows.length; i++) {
      const a0 = ma20[i - 1]
      const a1 = ma20[i]
      const b0 = ma60[i - 1]
      const b1 = ma60[i]
      if (a0 == null || a1 == null || b0 == null || b1 == null) continue
      const prev = a0 - b0
      const cur = a1 - b1
      if (prev <= 0 && cur > 0)
        markers.push({ time: t(rows[i].d), position: 'belowBar', color: C.up, shape: 'arrowUp', text: 'G' })
      else if (prev >= 0 && cur < 0)
        markers.push({ time: t(rows[i].d), position: 'aboveBar', color: C.down, shape: 'arrowDown', text: 'D' })
    }
    line.setMarkers(markers)
    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      chart.remove()
    }
  }, [rows, view, who, register])
  return (
    <ChartBox
      title={`③ 누적순매수 (${who === 'f' ? '외인' : '기관'}, 억)`}
      legend={[
        [who === 'f' ? '외인 누적' : '기관 누적', who === 'f' ? C.accent : C.blue],
        ['20일', '#ffd60a'],
        ['60일', '#a78bfa'],
        ['▲골든/▼데드', C.t3],
      ]}
      seg={{
        value: who,
        onChange: (v) => setWho(v as 'f' | 'i'),
        options: [
          ['f', '외인'],
          ['i', '기관'],
        ],
      }}
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
  seg,
  children,
}: {
  title: string
  legend: [string, string][]
  view?: 'chart' | 'table'
  setView?: (v: 'chart' | 'table') => void
  seg?: { value: string; onChange: (v: string) => void; options: [string, string][] }
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
        {(seg || (view && setView)) && (
          <div className="ml-auto flex items-center gap-2">
            {seg && (
              <div className="flex overflow-hidden rounded-sm border border-bg-surface">
                {seg.options.map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => seg.onChange(val)}
                    className={`px-2 py-0.5 ${seg.value === val ? 'bg-accent/20 text-accent' : 'text-t3'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {view && setView && (
              <div className="flex overflow-hidden rounded-sm border border-bg-surface">
                <button onClick={() => setView('chart')} className={`px-2 py-0.5 ${view === 'chart' ? 'bg-accent/20 text-accent' : 'text-t3'}`}>
                  차트
                </button>
                <button onClick={() => setView('table')} className={`px-2 py-0.5 ${view === 'table' ? 'bg-accent/20 text-accent' : 'text-t3'}`}>
                  테이블
                </button>
              </div>
            )}
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
