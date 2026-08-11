import { useEffect, useRef } from 'react'
import {
  ColorType,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'

import {
  TICK_STEP_SEC,
  applySessionAxis,
  bucketOf,
  kstHms,
  liveInSession,
  resolveGrid,
  type DepthPoint,
  type Grid,
  type LiveDepthPoint,
} from './session'

/**
 * "선물" 탭 차트 3종 — 모두 `session.ts`의 09:00~15:45 고정 축 규칙을 공유한다.
 *
 * **DepthChart (메인)** — 한 차트에 3개 축을 겹쳐 "비율이 기울 때 가격·거래량이 어떻게
 * 움직였나"를 한눈에:
 *   · 비율(매수÷매도)  — 왼쪽 축, 초록 라인 + 1.0 기준선
 *   · 선물가           — 오른쪽 축. 틱 모드는 라인, 분봉 모드는 캔들
 *   · 구간 거래량       — 하단 40% 오버레이 히스토그램 (누적거래량 인접 diff의 버킷 합)
 *
 * **OiChart / BasisChart (하단 미니)** — 같은 히스토리 포인트에서 파생:
 *   · 미결제약정 추이 (0 = 미상이면 스킵)
 *   · 시장 베이시스(p−u) vs 이론 베이시스(th−u) + 0 기준선 — 두 선의 간격이 곧 괴리
 *
 * 데이터는 Rust realtime이 10초 간격으로 상시 샘플링한 당일 히스토리(REST 시딩) +
 * 이후 실시간 틱(`live`)을 마지막 버킷에 병합. 리빌드 없이 series.update()만 쓰므로
 * 사용자가 확대해 둔 시간축이 매 틱마다 리셋되지 않는다.
 *
 * 분봉 캔들은 **10초 샘플 기반 근사**다 — 샘플 사이의 고가/저가는 잡히지 않는다.
 *
 * 차트 옵션·컬러는 stat-arb/charts.tsx 와 동일 계열 (공용 차트 컴포넌트가 없는 코드베이스
 * 관례상 화면별로 자체 보유).
 */

// LENS 디자인 컬러 (globals.css 토큰과 동일)
const C = {
  bgPrimary: '#111111',
  bgSurface: '#1c1c1e',
  t1: '#ffffff',
  t3: '#8e8e93',
  t4: '#636366',
  accent: '#34c759',
  warning: '#ff9f0a',
  down: '#ff3b30',
  blue: '#0a84ff',
  candleUp: '#30d158',
  candleDown: '#ee382e',
  volUp: '#30d15855',
  volDown: '#ee382e55',
} as const

const chartOpts = {
  layout: { background: { type: ColorType.Solid, color: C.bgPrimary }, textColor: C.t3, fontSize: 10 },
  grid: { vertLines: { color: C.bgSurface }, horzLines: { color: C.bgSurface } },
  rightPriceScale: { borderColor: C.bgSurface, visible: true },
  leftPriceScale: { borderColor: C.bgSurface, visible: true },
  crosshair: { mode: 1 as const },
  timeScale: {
    borderColor: C.bgSurface,
    timeVisible: true,
    secondsVisible: false,
    // 세션 전 구간(10초 슬롯 2,431개)을 한 화면에 담으려면 기본 minBarSpacing(0.5)으론 부족.
    minBarSpacing: 0.05,
    tickMarkFormatter: (time: number) => kstHms(time).hm,
  },
  localization: { timeFormatter: (time: number) => kstHms(time).hms },
} as const

/** 집계 단위(분). 0 = 틱(10초 샘플 라인). 선택지 배열은 UI 소유(pages/futures.tsx) —
 *  컴포넌트 파일이 값을 export하면 react-refresh가 깨진다. */
export type IntervalMin = 0 | 1 | 5 | 10 | 15 | 30 | 60

const ratioOf = (p: { a: number; b: number }) => (p.a > 0 ? p.b / p.a : null)

/** 한 버킷 (틱 모드면 10초, 분봉 모드면 N분). 가격 OHLC + 비율 종가 + 거래량 합. */
type Bar = {
  t: number
  /** 가격 OHLC. 그 버킷에 유효 가격이 하나도 없으면 0. */
  o: number
  h: number
  l: number
  c: number
  vol: number
  ratio: number | null
  ask: number
  bid: number
}

type TipData = Bar & { candle: boolean }

/**
 * 10초 샘플 → 버킷 집계. 버킷 경계는 **09:00 KST 정렬**.
 * 거래량은 샘플 간 누적 diff의 합 (기준 미상(prevV=0)이면 0 — 당일 누적이 한 막대에 몰리는 것 방지).
 * 반환하는 `lastBase`는 마지막 버킷의 기준점 — 라이브 병합이 같은 산식을 이어가기 위한 앵커.
 */
function aggregate(points: DepthPoint[], from: number, stepSec: number) {
  const bars: Bar[] = []
  let prevV = points.length ? points[0].v : 0
  let prevP = 0
  let lastBase = { v: prevV, p: 0 }
  let cur: Bar | null = null
  for (const p of points) {
    const bt = from + Math.floor((p.t - from) / stepSec) * stepSec
    if (!cur || cur.t !== bt) {
      if (cur) bars.push(cur)
      lastBase = { v: prevV, p: prevP }
      cur = { t: bt, o: 0, h: 0, l: 0, c: 0, vol: 0, ratio: null, ask: 0, bid: 0 }
    }
    // 누적 diff. 재기동·월물 교체로 역행하면 0 (음수 막대 방지).
    // prevV==0은 "FC9 미수신으로 기준 미상" — diff하면 당일 누적 전체가 한 막대에 몰린다.
    cur.vol += prevV > 0 ? Math.max(0, p.v - prevV) : 0
    if (p.p > 0) {
      if (cur.o === 0) {
        cur.o = cur.h = cur.l = p.p
      } else {
        cur.h = Math.max(cur.h, p.p)
        cur.l = Math.min(cur.l, p.p)
      }
      cur.c = p.p
      prevP = p.p
    }
    const r = ratioOf(p)
    if (r != null) cur.ratio = r
    cur.ask = p.a
    cur.bid = p.b
    prevV = p.v
  }
  if (cur) bars.push(cur)
  return { bars, lastBase, lastSeen: { v: prevV, p: prevP } }
}

export function DepthChart({
  points,
  live,
  date,
  intervalMin,
}: {
  points: DepthPoint[]
  live: LiveDepthPoint | null
  /** 히스토리 응답의 date (YYYYMMDD, KST). 비면 오늘로 폴백. */
  date: string
  intervalMin: IntervalMin
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const ratioRef = useRef<ISeriesApi<'Line'> | null>(null)
  const priceLineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  /** 현재(마지막) 버킷. 라이브 틱을 여기에 병합한다. */
  const barRef = useRef<Bar>({ t: 0, o: 0, h: 0, l: 0, c: 0, vol: 0, ratio: null, ask: 0, bid: 0 })
  /** **현재 버킷의 기준점** = 직전 버킷 마지막 관측의 누적거래량·가격. 막대값 = 지금 누적 − 기준.
   *  히스토리 산식(버킷 간 full diff)과 같아 라이브→재시딩 시 값이 안 바뀐다. */
  const baseRef = useRef({ v: 0, p: 0 })
  /** 현재 버킷에서 **마지막으로 관측한** 누적거래량·가격. 버킷이 넘어갈 때 다음 기준이 된다.
   *  (기준을 새 틱 값으로 덮으면 막대가 스파이크→0→재성장 하며 깜빡인다.) */
  const lastSeenRef = useRef({ v: 0, p: 0 })
  /** 툴팁 조회용 시각→값. 라이브 버킷도 같이 갱신. */
  const tipRef = useRef(new Map<number, TipData>())
  /** 버킷 정렬 기준(세션 시작)·간격·세션 경계 + 세션 고정 모드 여부.
   *  라이브 effect가 시딩과 **같은 그리드·같은 게이트**를 쓰게 하기 위한 공유 상태. */
  const gridRef = useRef<Grid>({ from: 0, to: 0, step: TICK_STEP_SEC, sessionMode: true })

  // ── 시딩 (히스토리·집계단위·날짜가 바뀔 때만 재생성) ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const candle = intervalMin > 0
    const step = candle ? intervalMin * 60 : TICK_STEP_SEC
    // 세션 고정 모드 판정 + 세션 밖 표본 제외 (규칙은 session.ts 한 벌).
    const { grid, src } = resolveGrid(points, date, step)
    const { from } = grid
    gridRef.current = grid

    const chart = createChart(el, { ...chartOpts, width: el.clientWidth, height: el.clientHeight })
    chartRef.current = chart

    const ratio = chart.addLineSeries({
      color: C.accent,
      lineWidth: 2,
      priceScaleId: 'left',
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
      priceLineVisible: false,
    })
    // 오버레이 히스토그램 — priceScaleId '' 가 v4의 오버레이 관용구. 하단 40%(라인과 겹침 허용).
    const vol = chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.6, bottom: 0 } })
    ratioRef.current = ratio
    volRef.current = vol

    // 균형선 1.0 — 이 위면 매수우위, 아래면 매도우위.
    ratio.createPriceLine({
      price: 1,
      color: C.t4,
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: true,
      title: '',
    })

    const { bars, lastBase, lastSeen } = aggregate(src, from, step)

    const ratioData: { time: Time; value: number }[] = []
    const priceData: { time: Time; value: number }[] = []
    const candleData: { time: Time; open: number; high: number; low: number; close: number }[] = []
    const volData: { time: Time; value: number; color: string }[] = []
    const tip = new Map<number, TipData>()
    let prevClose = 0
    for (const b of bars) {
      const time = b.t as UTCTimestamp
      if (b.ratio != null) ratioData.push({ time, value: b.ratio })
      if (b.o > 0) {
        if (candle) candleData.push({ time, open: b.o, high: b.h, low: b.l, close: b.c })
        else priceData.push({ time, value: b.c })
      }
      // 막대 색은 직전 버킷 종가 대비 — 틱 모드(버킷당 표본 1개, o==c)에서도 방향이 보인다.
      volData.push({ time, value: b.vol, color: b.c >= prevClose ? C.volUp : C.volDown })
      tip.set(b.t, { ...b, candle })
      if (b.c > 0) prevClose = b.c
    }

    if (candle) {
      const cs = chart.addCandlestickSeries({
        upColor: C.candleUp,
        downColor: C.candleDown,
        borderUpColor: C.candleUp,
        borderDownColor: C.candleDown,
        wickUpColor: C.candleUp,
        wickDownColor: C.candleDown,
        priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false,
      })
      cs.setData(candleData)
      candleRef.current = cs
      priceLineRef.current = null
    } else {
      const pl = chart.addLineSeries({
        color: C.blue,
        lineWidth: 1,
        priceScaleId: 'right',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
        priceLineVisible: false,
      })
      pl.setData(priceData)
      priceLineRef.current = pl
      candleRef.current = null
    }
    ratio.setData(ratioData)
    vol.setData(volData)

    tipRef.current = tip
    barRef.current = bars.length
      ? { ...bars[bars.length - 1] }
      : { t: 0, o: 0, h: 0, l: 0, c: 0, vol: 0, ratio: null, ask: 0, bid: 0 }
    baseRef.current = lastBase
    lastSeenRef.current = lastSeen

    const cleanupTip = attachTooltip(chart, el, (key) => {
      const d = tipRef.current.get(key)
      if (!d) return null
      const rColor = d.ratio == null ? C.t3 : d.ratio >= 1 ? C.accent : C.down
      return [
        { label: '비율', value: d.ratio == null ? '-' : d.ratio.toFixed(3), color: rColor, strong: true },
        { label: '매수총잔량', value: qty(d.bid), color: C.accent },
        { label: '매도총잔량', value: qty(d.ask), color: C.down },
        ...(d.candle
          ? [
              { label: '시가', value: px(d.o) },
              { label: '고가', value: px(d.h) },
              { label: '저가', value: px(d.l) },
              { label: '종가', value: px(d.c), color: d.c >= d.o ? C.candleUp : C.candleDown, strong: true },
            ]
          : [{ label: '선물가', value: px(d.c), color: C.blue }]),
        { label: '구간 거래량', value: qty(d.vol) },
      ]
    })
    // 데이터가 몇 점이든 09:00~15:45 고정. 이후 사용자의 줌/팬은 자유(라이브 틱이 리셋 안 함).
    // 세션 밖 표본뿐이면(mock 장외) 고정 대신 데이터에 맞춘다.
    applySessionAxis(chart, grid)

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cleanupTip()
      chart.remove()
      chartRef.current = null
      ratioRef.current = null
      priceLineRef.current = null
      candleRef.current = null
      volRef.current = null
    }
  }, [points, date, intervalMin])

  // ── 라이브 병합 — 전체 리빌드 없이 현재 버킷만 갱신 ──
  useEffect(() => {
    if (!live) return
    const g = gridRef.current
    // 세션 고정 모드에서는 09:00~15:45 밖 틱을 차트에 올리지 않는다 (축 우측 밀림 방지).
    // 카드의 실시간 숫자는 이 게이트와 무관하게 계속 갱신된다.
    if (!liveInSession(g, live.t)) return
    const bt = bucketOf(g, live.t)
    const bar = barRef.current
    // 시딩 직후엔 클라이언트 버킷이 서버 마지막 샘플보다 과거일 수 있음 → 따라잡을 때까지 skip.
    if (bt < bar.t) return
    if (bt > bar.t) {
      // 버킷 롤 — 직전 버킷의 **마지막 관측**이 새 버킷의 기준점 (버킷 사이 거래량 누락 없음).
      baseRef.current = { ...lastSeenRef.current }
      barRef.current = { t: bt, o: 0, h: 0, l: 0, c: 0, vol: 0, ratio: null, ask: 0, bid: 0 }
    }
    const b = barRef.current
    if (live.p > 0) {
      if (b.o === 0) {
        b.o = b.h = b.l = live.p
      } else {
        b.h = Math.max(b.h, live.p)
        b.l = Math.min(b.l, live.p)
      }
      b.c = live.p
      lastSeenRef.current.p = live.p
    }
    if (live.v > 0) lastSeenRef.current.v = live.v
    b.ratio = ratioOf(live) ?? b.ratio
    b.ask = live.a
    b.bid = live.b
    // 막대값은 기준점 대비 누적 diff — 같은 버킷 안에서 단조 증가하고, 확정값은 히스토리 산식과 동일.
    // 기준 0 = 미상(aggregate 주석 참조) → diff 생략.
    b.vol = baseRef.current.v > 0 ? Math.max(0, live.v - baseRef.current.v) : 0

    const time = bt as UTCTimestamp
    if (b.ratio != null) ratioRef.current?.update({ time, value: b.ratio })
    if (b.o > 0) {
      candleRef.current?.update({ time, open: b.o, high: b.h, low: b.l, close: b.c })
      priceLineRef.current?.update({ time, value: b.c })
    }
    volRef.current?.update({
      time,
      value: b.vol,
      color: b.c >= baseRef.current.p ? C.volUp : C.volDown,
    })
    tipRef.current.set(bt, { ...b, candle: candleRef.current != null })
  }, [live])

  return <div ref={containerRef} className="h-full w-full" />
}

const qty = (v: number) => Math.round(v).toLocaleString()
const px = (v: number) => (v > 0 ? v.toFixed(2) : '-')

type TipRow = { label: string; value: string; color?: string; strong?: boolean }

/** 크로스헤어 호버 툴팁 (flow-detail.tsx 패턴). build가 null이면 그 지점은 숨김. 반환값은 cleanup. */
function attachTooltip(
  chart: IChartApi,
  container: HTMLDivElement,
  build: (timeSec: number) => TipRow[] | null,
): () => void {
  container.style.position = 'relative'
  const tip = document.createElement('div')
  tip.style.cssText =
    'position:absolute;display:none;pointer-events:none;z-index:10;min-width:150px;padding:6px 8px;border-radius:4px;background:#1c1c1ef2;border:1px solid #3a3a3c;box-shadow:0 2px 10px #000a;font-size:11px;line-height:1.55'
  container.appendChild(tip)
  const onMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
    const key = typeof param.time === 'number' ? param.time : null
    const rows = key != null ? build(key) : null
    if (!rows || !param.point || key == null) {
      tip.style.display = 'none'
      return
    }
    tip.innerHTML =
      `<div style="color:#8e8e93;margin-bottom:4px;font-variant-numeric:tabular-nums">${kstHms(key).hms}</div>` +
      rows
        .map(
          (r) =>
            `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px">` +
            `<span style="color:#8e8e93">${r.label}</span>` +
            `<span style="color:${r.color ?? '#fff'};font-weight:${r.strong ? 600 : 400};font-variant-numeric:tabular-nums">${r.value}</span>` +
            `</div>`,
        )
        .join('')
    tip.style.display = 'block'
    let left = param.point.x + 14
    let top = param.point.y + 14
    if (left + tip.offsetWidth > container.clientWidth) left = param.point.x - tip.offsetWidth - 14
    if (top + tip.offsetHeight > container.clientHeight) top = container.clientHeight - tip.offsetHeight - 4
    tip.style.left = `${Math.max(4, left)}px`
    tip.style.top = `${Math.max(4, top)}px`
  }
  chart.subscribeCrosshairMove(onMove)
  return () => {
    chart.unsubscribeCrosshairMove(onMove)
    tip.remove()
  }
}

// ---------------------------------------------------------------------------
// 하단 미니 차트 — OI / 베이시스. 메인과 같은 세션 축 규칙, 라인만(분봉 토글 영향 없음).
// ---------------------------------------------------------------------------

/** 미니 차트 한 라인의 정의. `value`가 null이면 그 시점은 스킵(0 = 미상). */
type MiniLine = {
  label: string
  color: string
  value: (p: DepthPoint) => number | null
}

/** OI는 계약수(정수), 베이시스는 지수 포인트(소수 2자리). */
const OI_LINES: MiniLine[] = [
  { label: '미결제약정', color: C.blue, value: (p) => (p.oi > 0 ? p.oi : null) },
]
const BASIS_LINES: MiniLine[] = [
  { label: '시장', color: C.accent, value: (p) => (p.p > 0 && p.u > 0 ? p.p - p.u : null) },
  { label: '이론', color: C.warning, value: (p) => (p.th > 0 && p.u > 0 ? p.th - p.u : null) },
]

const miniChartOpts = {
  ...chartOpts,
  leftPriceScale: { borderColor: C.bgSurface, visible: false },
} as const

function MiniChart({
  points,
  live,
  date,
  lines,
  precision,
  zeroLine = false,
  fmt,
}: {
  points: DepthPoint[]
  live: LiveDepthPoint | null
  date: string
  lines: MiniLine[]
  precision: number
  zeroLine?: boolean
  fmt: (v: number) => string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const gridRef = useRef<Grid>({ from: 0, to: 0, step: TICK_STEP_SEC, sessionMode: true })
  const lastTRef = useRef(0)
  /** 툴팁용 — 버킷 시각 → 그 시점 포인트 원본 (라인 값은 build에서 lines로 재계산). */
  const tipRef = useRef(new Map<number, DepthPoint>())

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const { grid, src } = resolveGrid(points, date, TICK_STEP_SEC)
    gridRef.current = grid

    const chart = createChart(el, {
      ...miniChartOpts,
      width: el.clientWidth,
      height: el.clientHeight,
    })
    const series = lines.map((ln) =>
      chart.addLineSeries({
        color: ln.color,
        lineWidth: 1,
        priceFormat: { type: 'price', precision, minMove: Math.pow(10, -precision) },
        priceLineVisible: false,
      }),
    )
    seriesRef.current = series

    const tip = new Map<number, DepthPoint>()
    // 10초 그리드 정렬 — 메인 차트와 x축 슬롯을 공유해 크로스헤어 비교가 어긋나지 않게.
    const data: { time: Time; value: number }[][] = lines.map(() => [])
    for (const p of src) {
      const bt = bucketOf(grid, p.t) as UTCTimestamp
      lines.forEach((ln, i) => {
        const v = ln.value(p)
        if (v != null) data[i].push({ time: bt, value: v })
      })
      tip.set(bt, p)
    }
    series.forEach((s, i) => s.setData(data[i]))
    tipRef.current = tip
    lastTRef.current = src.length ? bucketOf(grid, src[src.length - 1].t) : 0

    if (zeroLine) {
      series[0].createPriceLine({
        price: 0,
        color: C.t4,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: false,
        title: '',
      })
    }

    const cleanupTip = attachTooltip(chart, el, (key) => {
      const p = tipRef.current.get(key)
      if (!p) return null
      const rows = lines
        .map((ln) => ({ ln, v: ln.value(p) }))
        .filter((x) => x.v != null)
        .map((x) => ({ label: x.ln.label, value: fmt(x.v as number), color: x.ln.color }))
      return rows.length ? rows : null
    })
    applySessionAxis(chart, grid)

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      cleanupTip()
      chart.remove()
      seriesRef.current = []
    }
  }, [points, date, lines, precision, zeroLine, fmt])

  // 라이브 병합 — 메인 차트와 같은 10초 버킷/세션 게이트.
  useEffect(() => {
    if (!live) return
    const g = gridRef.current
    if (!liveInSession(g, live.t)) return
    const bt = bucketOf(g, live.t)
    if (bt < lastTRef.current) return
    lastTRef.current = bt
    const time = bt as UTCTimestamp
    lines.forEach((ln, i) => {
      const v = ln.value(live)
      if (v != null) seriesRef.current[i]?.update({ time, value: v })
    })
    tipRef.current.set(bt, live)
  }, [live, lines])

  return <div ref={containerRef} className="h-full w-full" />
}

/** 당일 미결제약정 추이. 0(미상) 구간은 스킵. */
export function OiChart(props: { points: DepthPoint[]; live: LiveDepthPoint | null; date: string }) {
  return <MiniChart {...props} lines={OI_LINES} precision={0} fmt={qty} />
}

/** 시장 베이시스(선물−기초지수) vs 이론 베이시스(이론가−기초지수). 두 선의 간격 = 괴리. */
export function BasisChart(props: { points: DepthPoint[]; live: LiveDepthPoint | null; date: string }) {
  return <MiniChart {...props} lines={BASIS_LINES} precision={2} zeroLine fmt={bp2} />
}

const bp2 = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`
