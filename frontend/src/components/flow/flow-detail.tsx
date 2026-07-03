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

// ── 크로스헤어 호버 툴팁 (모든 차트 공통) ──────────────────────────────
// lightweight-charts 시리즈엔 기본 툴팁이 없어 crosshair 위치의 날짜로 커스텀 카드를 그린다.
type TipRow = { label: string; value: string; dot?: string; valueColor?: string; strong?: boolean }

const timeKey = (tm: Time | undefined): string | null => {
  if (tm == null) return null
  if (typeof tm === 'string') return tm
  if (typeof tm === 'number') return String(tm)
  return `${tm.year}-${String(tm.month).padStart(2, '0')}-${String(tm.day).padStart(2, '0')}`
}

const eok = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString()}억`
const signColor = (v: number) => (v > 0 ? C.up : v < 0 ? C.down : C.t3)
const won = (v: number) => Math.round(v).toLocaleString()

/** 차트에 호버 툴팁을 붙인다. build(dateKey)가 null이면 그 지점은 숨김. 반환값은 cleanup. */
function attachTooltip(
  chart: IChartApi,
  container: HTMLDivElement,
  build: (dateKey: string) => { title: string; rows: TipRow[] } | null
): () => void {
  container.style.position = 'relative'
  const tip = document.createElement('div')
  tip.style.cssText =
    'position:absolute;display:none;pointer-events:none;z-index:10;min-width:132px;padding:6px 8px;border-radius:4px;background:#1c1c1ef2;border:1px solid #3a3a3c;box-shadow:0 2px 10px #000a;font-size:11px;line-height:1.55'
  container.appendChild(tip)
  const onMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
    const key = timeKey(param.time)
    const data = key ? build(key) : null
    if (!data || !param.point) {
      tip.style.display = 'none'
      return
    }
    tip.innerHTML =
      `<div style="color:#8e8e93;margin-bottom:4px;font-variant-numeric:tabular-nums">${data.title}</div>` +
      data.rows
        .map((r) => {
          const dot = r.dot ? `<span style="width:8px;height:8px;border-radius:2px;background:${r.dot};flex:0 0 auto"></span>` : ''
          const vc = r.valueColor ?? (r.strong ? (r.dot ?? '#fff') : '#fff')
          return (
            `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">` +
            `<span style="display:flex;align-items:center;gap:5px;color:#8e8e93">${dot}${r.label}</span>` +
            `<span style="color:${vc};font-weight:${r.strong ? 600 : 400};font-variant-numeric:tabular-nums">${r.value}</span>` +
            `</div>`
          )
        })
        .join('')
    tip.style.display = 'block'
    const cw = container.clientWidth
    const ch = container.clientHeight
    let left = param.point.x + 14
    let top = param.point.y + 14
    if (left + tip.offsetWidth > cw) left = param.point.x - tip.offsetWidth - 14
    if (top + tip.offsetHeight > ch) top = ch - tip.offsetHeight - 4
    tip.style.left = `${Math.max(4, left)}px`
    tip.style.top = `${Math.max(4, top)}px`
  }
  chart.subscribeCrosshairMove(onMove)
  return () => {
    chart.unsubscribeCrosshairMove(onMove)
    tip.remove()
  }
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
    // 호버 툴팁 — 날짜·시고저종·등락
    const priceMap = new Map<string, { o: number; h: number; l: number; c: number; chg: number }>()
    let pc: number | null = null
    for (const r of rows) {
      if (r.o == null || r.h == null || r.l == null || r.adj_close == null) continue
      priceMap.set(r.d, { o: r.o, h: r.h, l: r.l, c: r.adj_close, chg: pc ? (r.adj_close / pc - 1) * 100 : 0 })
      pc = r.adj_close
    }
    const cleanupTip = attachTooltip(chart, ref.current, (key) => {
      const p = priceMap.get(key)
      if (!p) return null
      const col = p.chg >= 0 ? C.candleUp : C.candleDown
      return {
        title: key,
        rows: [
          { label: '시가', value: won(p.o) },
          { label: '고가', value: won(p.h) },
          { label: '저가', value: won(p.l) },
          { label: '종가', value: won(p.c), valueColor: col, strong: true },
          { label: '등락', value: `${p.chg >= 0 ? '+' : ''}${p.chg.toFixed(2)}%`, valueColor: col },
        ],
      }
    })
    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      cleanupTip()
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
    const ma5 = sma(vals, 5)
    const ma20 = sma(vals, 20)
    const addMa = (ma: (number | null)[], color: string) => {
      const line = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      line.setData(rows.map((r, i) => ({ time: t(r.d), value: ma[i] })).filter((x) => x.value != null) as never)
    }
    addMa(ma5, C.warning)
    addMa(ma20, C.blue)
    // 호버 툴팁 — 선택 주체 순매수·5·20일선
    const idxByDate = new Map<string, number>(rows.map((r, i) => [r.d, i]))
    const label = who === 'f' ? '외인 순매수' : '기관 순매수'
    const cleanupTip = attachTooltip(chart, ref.current, (key) => {
      const i = idxByDate.get(key)
      if (i == null) return null
      const out: TipRow[] = [{ label, value: eok(vals[i]), valueColor: signColor(vals[i]), strong: true }]
      if (ma5[i] != null) out.push({ label: '5일선', value: eok(ma5[i] as number), dot: C.warning, valueColor: C.warning })
      if (ma20[i] != null) out.push({ label: '20일선', value: eok(ma20[i] as number), dot: C.blue, valueColor: C.blue })
      return { title: key, rows: out }
    })
    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      cleanupTip()
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
    // 호버 툴팁 — 외/기/개 일별 순매수
    const byDate = new Map<string, SeriesRow>(rows.map((r) => [r.d, r]))
    const cleanupTip = attachTooltip(chart, ref.current, (key) => {
      const r = byDate.get(key)
      if (!r) return null
      return {
        title: key,
        rows: [
          { label: '외인', value: eok(r.f_eok), dot: C.accent, valueColor: signColor(r.f_eok) },
          { label: '기관', value: eok(r.i_eok), dot: C.blue, valueColor: signColor(r.i_eok) },
          { label: '개인', value: eok(r.r_eok), dot: C.retail, valueColor: signColor(r.r_eok) },
        ],
      }
    })
    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      cleanupTip()
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
    // 20·50·100·200일 이평 (색은 누적선 green/blue와 안 겹치게)
    const ma20 = sma(cum, 20)
    const ma50 = sma(cum, 50)
    const ma100 = sma(cum, 100)
    const ma200 = sma(cum, 200)
    const addMa = (ma: (number | null)[], color: string) => {
      const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      s.setData(rows.map((r, i) => ({ time: t(r.d), value: ma[i] })).filter((x) => x.value != null) as never)
    }
    addMa(ma20, '#ffd60a') // 20일 (노랑)
    addMa(ma50, C.warning) // 50일 (주황)
    addMa(ma100, '#a78bfa') // 100일 (보라)
    addMa(ma200, C.t1) // 200일 (흰색)
    // 골든/데드크로스 마커 (MA20 × MA50 — 기본 1년 뷰에서 신호 확보) + 툴팁용 맵
    const markers: SeriesMarker<Time>[] = []
    const crossMap = new Map<string, { kind: string; color: string; value: number }>()
    for (let i = 1; i < rows.length; i++) {
      const a0 = ma20[i - 1]
      const a1 = ma20[i]
      const b0 = ma50[i - 1]
      const b1 = ma50[i]
      if (a0 == null || a1 == null || b0 == null || b1 == null) continue
      const prev = a0 - b0
      const cur = a1 - b1
      if (prev <= 0 && cur > 0) {
        markers.push({ time: t(rows[i].d), position: 'belowBar', color: C.up, shape: 'arrowUp', text: 'G' })
        crossMap.set(rows[i].d, { kind: '골든크로스', color: C.up, value: cum[i] })
      } else if (prev >= 0 && cur < 0) {
        markers.push({ time: t(rows[i].d), position: 'aboveBar', color: C.down, shape: 'arrowDown', text: 'D' })
        crossMap.set(rows[i].d, { kind: '데드크로스', color: C.down, value: cum[i] })
      }
    }
    line.setMarkers(markers)

    // 호버 툴팁 — 누적(선택 주체)·20·50·100·200일선 + 크로스일이면 종류 강조
    const idxByDate = new Map<string, number>(rows.map((r, i) => [r.d, i]))
    const invLabel = who === 'f' ? '외인 누적' : '기관 누적'
    const cleanupTip = attachTooltip(chart, ref.current, (key) => {
      const i = idxByDate.get(key)
      if (i == null) return null
      const out: TipRow[] = [{ label: invLabel, value: eok(cum[i]), dot: cumColor, valueColor: cumColor, strong: true }]
      if (ma20[i] != null) out.push({ label: '20일', value: eok(ma20[i] as number), dot: '#ffd60a', valueColor: '#ffd60a' })
      if (ma50[i] != null) out.push({ label: '50일', value: eok(ma50[i] as number), dot: C.warning, valueColor: C.warning })
      if (ma100[i] != null) out.push({ label: '100일', value: eok(ma100[i] as number), dot: '#a78bfa', valueColor: '#a78bfa' })
      if (ma200[i] != null) out.push({ label: '200일', value: eok(ma200[i] as number), dot: C.t1, valueColor: C.t1 })
      const cx = crossMap.get(key)
      if (cx) out.push({ label: '신호', value: cx.kind === '골든크로스' ? '▲ 골든크로스' : '▼ 데드크로스', valueColor: cx.color, strong: true })
      return { title: key, rows: out }
    })

    chart.timeScale().fitContent()
    const unreg = register(chart)
    return () => {
      unreg()
      cleanupTip()
      chart.remove()
    }
  }, [rows, view, who, register])
  return (
    <ChartBox
      title={`③ 누적순매수 (${who === 'f' ? '외인' : '기관'}, 억)`}
      legend={[
        [who === 'f' ? '외인 누적' : '기관 누적', who === 'f' ? C.accent : C.blue],
        ['20일', '#ffd60a'],
        ['50일', C.warning],
        ['100일', '#a78bfa'],
        ['200일', C.t1],
        ['▲골든/▼데드(20×50)', C.t3],
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
