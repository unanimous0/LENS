import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
} from 'lightweight-charts'

import type { HistBin, SpreadPoint } from '@/types/stat-arb'

// 인트라데이(30분) 차트 — x축에 KST 날짜 + 시간 표시.
// lightweight-charts는 timestamp를 UTC로 다루므로 +9h offset 후 UTC 필드를 읽어 KST 벽시계로.
const KST_OFFSET_SEC = 9 * 3600
const pad = (n: number) => String(n).padStart(2, '0')
function kstParts(timeSec: number) {
  const d = new Date((timeSec + KST_OFFSET_SEC) * 1000)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    da: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  }
}

// LENS 디자인 컬러 (globals.css 토큰과 동일)
const C = {
  bgPrimary: '#111111',
  bgSurface: '#1c1c1e',
  t1: '#ffffff',
  t2: '#d1d1d6',
  t3: '#8e8e93',
  t4: '#636366',
  accent: '#34c759', // 메인 시리즈 색 (초록)
  warning: '#ff9f0a', // ±2 밴드 / 현재점 강조
  down: '#ff3b30',
} as const

const baseChartOpts = {
  layout: { background: { type: ColorType.Solid, color: C.bgPrimary }, textColor: C.t3, fontSize: 10 },
  grid: { vertLines: { color: C.bgSurface }, horzLines: { color: C.bgSurface } },
  rightPriceScale: { borderColor: C.bgSurface },
  timeScale: { borderColor: C.bgSurface, timeVisible: false, secondsVisible: false },
  crosshair: { mode: 1 as const },
} as const

// 시계열(스프레드·z) 차트 전용 — x축에 시간까지 표시 (인트라데이 30분).
//  · 날짜 경계 틱(Year/Month/Day) → YY-MM-DD
//  · 인트라데이 틱(Time) → HH:MM
//  · 크로스헤어 툴팁 → YYYY-MM-DD HH:MM (KST)
const seriesTimeScale = {
  borderColor: C.bgSurface,
  timeVisible: true,
  secondsVisible: false,
  tickMarkFormatter: (time: number, tickMarkType: number) => {
    const p = kstParts(time)
    if (tickMarkType < 3) return `${String(p.y).slice(2)}-${pad(p.mo)}-${pad(p.da)}`
    return `${pad(p.h)}:${pad(p.mi)}`
  },
}
const seriesLocalization = {
  timeFormatter: (time: number) => {
    const p = kstParts(time)
    return `${p.y}-${pad(p.mo)}-${pad(p.da)} ${pad(p.h)}:${pad(p.mi)}`
  },
}

// ---------------------------------------------------------------------------
// 공통 — 컨테이너 resize observer
// ---------------------------------------------------------------------------
function useResize(
  ref: React.RefObject<HTMLDivElement>,
  chartRef: React.RefObject<IChartApi | null>,
) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ob = new ResizeObserver(() => {
      chartRef.current?.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    })
    ob.observe(el)
    return () => ob.disconnect()
  }, [ref, chartRef])
}

// ---------------------------------------------------------------------------
// 1. 스프레드 시계열
// ---------------------------------------------------------------------------
export function SpreadChart({
  data,
  entry,
  live,
  register,
}: {
  data: SpreadPoint[]
  /** 포지션 상세에서 진입 시점·값 마킹용. 페어 상세에서는 미전달 */
  entry?: { ts: number; spread: number } | null
  /** 실시간 현재값(스프레드) — DB 시계열(어제까지) 끝에 이어 그림. ts는 내부에서 now()로. */
  live?: number | null
  /** 차트 인스턴스를 부모에 등록 (시간축 동기화용). stable한 setState setter를 넘길 것. */
  register?: (chart: IChartApi | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const curLineRef = useRef<IPriceLine | null>(null)
  const lastTsRef = useRef<number>(0)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      ...baseChartOpts,
      timeScale: seriesTimeScale,
      localization: seriesLocalization,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })
    chartRef.current = chart
    register?.(chart)
    const series: ISeriesApi<'Line'> = chart.addLineSeries({
      color: C.accent,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    series.setData(
      data.map((p) => ({ time: Math.floor(p.ts / 1000), value: p.spread }))
    )
    seriesRef.current = series
    lastTsRef.current = data.length ? Math.floor(data[data.length - 1].ts / 1000) : 0
    // 0 line
    series.createPriceLine({
      price: 0,
      color: C.t4,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
      lineWidth: 1,
    })
    // 현재 점 강조 (라이브 있으면 라이브 effect가 갱신)
    const last = data[data.length - 1]
    curLineRef.current = series.createPriceLine({
      price: live ?? last?.spread ?? 0,
      color: C.warning,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: '현재',
      lineWidth: 1,
    })
    // 진입 마커 — 시계열 위 진입 시점 점 + price line
    if (entry) {
      series.createPriceLine({
        price: entry.spread,
        color: C.t2,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '진입',
        lineWidth: 1,
      })
      series.setMarkers([
        {
          time: Math.floor(entry.ts / 1000) as never,
          position: 'inBar',
          color: C.t1,
          shape: 'circle',
          text: '진입',
        },
      ])
    }
    chart.timeScale().fitContent()
    return () => {
      register?.(null)
      chart.remove()
      seriesRef.current = null
      curLineRef.current = null
    }
  }, [data, entry, register])

  // 라이브 점 append/갱신 — 전체 리빌드 없이 마지막 점만. 30분 버킷으로 묶어 틱 폭주 방지.
  // ts는 effect 안에서 now()로 생성 (render 중 Date.now() 호출 금지 — react-hooks/purity).
  useEffect(() => {
    const s = seriesRef.current
    if (!s || live == null) return
    const bucket = Math.floor(Date.now() / 1000 / 1800) * 1800
    if (bucket < lastTsRef.current) return
    s.update({ time: bucket as never, value: live })
    lastTsRef.current = bucket
    curLineRef.current?.applyOptions({ price: live })
  }, [live])

  useResize(containerRef, chartRef)

  return <div ref={containerRef} className="h-full w-full" />
}

// ---------------------------------------------------------------------------
// 2. z-score 시계열 + ±1 / ±2 밴드
// ---------------------------------------------------------------------------
export function ZScoreChart({
  data,
  entry,
  live,
  register,
}: {
  data: SpreadPoint[]
  entry?: { ts: number; z: number } | null
  /** 실시간 현재 z — DB 시계열 끝에 이어 그림. ts는 내부에서 now()로. */
  live?: number | null
  /** 차트 인스턴스를 부모에 등록 (시간축 동기화용). */
  register?: (chart: IChartApi | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const curLineRef = useRef<IPriceLine | null>(null)
  const lastTsRef = useRef<number>(0)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      ...baseChartOpts,
      timeScale: seriesTimeScale,
      localization: seriesLocalization,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })
    chartRef.current = chart
    register?.(chart)

    const series = chart.addLineSeries({
      color: C.accent,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    series.setData(data.map((p) => ({ time: Math.floor(p.ts / 1000), value: p.z })))
    seriesRef.current = series
    lastTsRef.current = data.length ? Math.floor(data[data.length - 1].ts / 1000) : 0

    // 0 line
    series.createPriceLine({
      price: 0,
      color: C.t3,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: false,
      title: '',
      lineWidth: 1,
    })
    // ±1 (회색 점선)
    ;[-1, 1].forEach((y) =>
      series.createPriceLine({
        price: y,
        color: C.t4,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: `±1σ`,
        lineWidth: 1,
      })
    )
    // ±2 (오렌지 점선)
    ;[-2, 2].forEach((y) =>
      series.createPriceLine({
        price: y,
        color: C.warning,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `±2σ`,
        lineWidth: 1,
      })
    )

    // 현재 z (라이브 있으면 라이브 effect가 갱신)
    const last = data[data.length - 1]
    const curVal = live ?? last?.z ?? 0
    curLineRef.current = series.createPriceLine({
      price: curVal,
      color: Math.abs(curVal) >= 2 ? C.down : C.t1,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: `현재 z`,
      lineWidth: 1,
    })
    // 진입 z 마킹
    if (entry) {
      series.createPriceLine({
        price: entry.z,
        color: C.t2,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '진입 z',
        lineWidth: 1,
      })
      series.setMarkers([
        {
          time: Math.floor(entry.ts / 1000) as never,
          position: 'inBar',
          color: C.t1,
          shape: 'circle',
          text: '진입',
        },
      ])
    }
    chart.timeScale().fitContent()
    return () => {
      register?.(null)
      chart.remove()
      seriesRef.current = null
      curLineRef.current = null
    }
  }, [data, entry, register])

  // 라이브 z append/갱신 (ts는 effect 안에서 now()로 — render 중 Date.now() 금지).
  useEffect(() => {
    const s = seriesRef.current
    if (!s || live == null) return
    const bucket = Math.floor(Date.now() / 1000 / 1800) * 1800
    if (bucket < lastTsRef.current) return
    s.update({ time: bucket as never, value: live })
    lastTsRef.current = bucket
    curLineRef.current?.applyOptions({
      price: live,
      color: Math.abs(live) >= 2 ? C.down : C.t1,
    })
  }, [live])

  useResize(containerRef, chartRef)

  return <div ref={containerRef} className="h-full w-full" />
}

// ---------------------------------------------------------------------------
// 3. 잔차 분포 히스토그램 — σ(표준편차) 단위. 평균 0 중심 + ±1σ/±2σ 세로선.
//    lightweight-charts는 시계열 전용이라 분포·세로선을 못 그려 커스텀 SVG로 렌더.
//    x축 = z(σ), y축 = 빈도. 현재 위치는 빨강 막대 + 세로 마커.
// ---------------------------------------------------------------------------
export function ResidualHistogram({
  bins,
  center,
  scale,
  currentZ,
}: {
  bins: HistBin[]
  center: number // 잔차 평균 (spread_center)
  scale: number // 잔차 표준편차 (spread_scale)
  currentZ: number | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<{ i: number; mx: number; my: number } | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const apply = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    apply()
    const ob = new ResizeObserver(apply)
    ob.observe(el)
    return () => ob.disconnect()
  }, [])

  const { w, h } = size
  const sc = scale || 1
  const zs = bins.map((b) => (b.center - center) / sc) // 각 bin 중심을 σ 단위로
  const ready = bins.length > 0 && w > 0 && h > 0

  const total = bins.reduce((s, b) => s + b.count, 0) || 1

  let svg: React.ReactNode = null
  let tip: React.ReactNode = null
  if (ready) {
    const padL = 30, // y축 빈도 라벨 공간
      padR = 8,
      padT = 8,
      padB = 18
    const plotW = Math.max(0, w - padL - padR)
    const plotH = Math.max(0, h - padT - padB)
    const binWz = zs.length >= 2 ? zs[1] - zs[0] : 1
    const lo = zs[0] - binWz / 2
    const hi = zs[zs.length - 1] + binWz / 2
    const span = hi - lo || 1
    const xOf = (z: number) => padL + ((z - lo) / span) * plotW
    const maxCount = Math.max(1, ...bins.map((b) => b.count))
    const yOf = (c: number) => padT + (1 - c / maxCount) * plotH
    const barPx = plotW / Math.max(1, bins.length)
    const curBin = currentZ != null ? bins.findIndex((_, i) => currentZ <= zs[i] + binWz / 2) : -1
    const sigmas = [-2, -1, 0, 1, 2].filter((s) => s >= lo && s <= hi)
    const sigColor = (s: number) => (s === 0 ? C.t3 : Math.abs(s) >= 2 ? C.warning : C.t4)
    // y축(빈도) 눈금 — 0~maxCount를 nice step으로 분할.
    const niceStep = (max: number) => {
      const raw = max / 4
      const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)))
      const n = raw / mag
      return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag
    }
    const yStep = niceStep(maxCount)
    const yTicks: number[] = []
    for (let v = 0; v <= maxCount + 1e-9; v += yStep) yTicks.push(Math.round(v))
    // 현재 빨간 막대 위 라벨 위치 (막대 위로, 너무 위로 잘리지 않게 클램프).
    const curCount = curBin >= 0 ? bins[curBin].count : 0
    const curLabelY = Math.max(padT + 11, yOf(curCount) - 6)

    const hoverIdx = hover?.i ?? -1
    const onMove = (e: React.MouseEvent) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      if (mx < padL || mx > padL + plotW) {
        setHover(null)
        return
      }
      const i = Math.floor(((mx - padL) / plotW) * bins.length)
      if (i < 0 || i >= bins.length) {
        setHover(null)
        return
      }
      setHover({ i, mx, my })
    }

    // 호버 툴팁 — σ 구간 / 빈도 / 비중
    if (hover && hover.i >= 0 && hover.i < bins.length) {
      const i = hover.i
      const loZ = zs[i] - binWz / 2
      const hiZ = zs[i] + binWz / 2
      const cnt = bins[i].count
      const pct = (cnt / total) * 100
      const left = Math.min(hover.mx + 10, w - 92)
      const top = Math.max(2, hover.my - 46)
      tip = (
        <div
          style={{
            position: 'absolute',
            left,
            top,
            pointerEvents: 'none',
            zIndex: 10,
            background: 'rgba(0,0,0,0.9)',
            border: `1px solid ${C.bgSurface}`,
            borderRadius: 3,
            padding: '3px 6px',
            fontSize: 10,
            lineHeight: 1.45,
            color: C.t2,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <div>
            구간 {loZ >= 0 ? '+' : ''}
            {loZ.toFixed(1)}σ ~ {hiZ >= 0 ? '+' : ''}
            {hiZ.toFixed(1)}σ
          </div>
          <div>
            빈도 <span style={{ color: C.t1 }}>{cnt}</span>회 ({pct.toFixed(1)}%)
          </div>
        </div>
      )
    }

    svg = (
      <svg
        width={w}
        height={h}
        style={{ display: 'block' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* y축 (빈도) — 가로 그리드 + 값 */}
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={padL}
              y1={yOf(v)}
              x2={padL + plotW}
              y2={yOf(v)}
              stroke={C.bgSurface}
              strokeWidth={1}
            />
            <text x={padL - 5} y={yOf(v) + 4} textAnchor="end" fontSize={11} fill={C.t2}>
              {v}
            </text>
          </g>
        ))}
        {/* σ 세로선 + 라벨 (평균 0 / ±1σ / ±2σ) */}
        {sigmas.map((s) => (
          <g key={s}>
            <line
              x1={xOf(s)}
              y1={padT}
              x2={xOf(s)}
              y2={padT + plotH}
              stroke={sigColor(s)}
              strokeWidth={1}
              strokeDasharray={s === 0 ? undefined : '3 3'}
            />
            <text
              x={xOf(s)}
              y={h - 4}
              textAnchor="middle"
              fontSize={11}
              fontWeight={s === 0 || Math.abs(s) >= 2 ? 600 : 400}
              fill={s === 0 ? C.t2 : Math.abs(s) >= 2 ? C.warning : C.t3}
            >
              {s === 0 ? '0' : `${s > 0 ? '+' : ''}${s}σ`}
            </text>
          </g>
        ))}
        {/* 막대 (빈도) */}
        {bins.map((b, i) => {
          const top = yOf(b.count)
          const isCur = i === curBin
          return (
            <rect
              key={i}
              x={xOf(zs[i]) - (barPx * 0.9) / 2}
              y={top}
              width={barPx * 0.9}
              height={padT + plotH - top}
              fill={isCur ? C.down : C.accent}
              opacity={isCur || i === hoverIdx ? 1 : 0.85}
            />
          )
        })}
        {/* 현재값 라벨 — 빨간 막대 위에 현재 z(σ) 표기 */}
        {currentZ != null && curBin >= 0 && (
          <text
            x={xOf(zs[curBin])}
            y={curLabelY}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill={C.down}
          >
            {`${currentZ >= 0 ? '+' : ''}${currentZ.toFixed(2)}σ`}
          </text>
        )}
      </svg>
    )
  }

  return (
    <div ref={ref} className="relative h-full w-full">
      {svg}
      {tip}
    </div>
  )
}
