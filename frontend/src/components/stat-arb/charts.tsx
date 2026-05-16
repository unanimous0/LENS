import { useEffect, useRef } from 'react'
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts'

import type { HistBin, SpreadPoint } from '@/types/stat-arb'

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

// ---------------------------------------------------------------------------
// 공통 — 컨테이너 resize observer
// ---------------------------------------------------------------------------
function useResize(ref: React.RefObject<HTMLDivElement>, chart: IChartApi | null) {
  useEffect(() => {
    if (!ref.current || !chart) return
    const el = ref.current
    const ob = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight })
    })
    ob.observe(el)
    return () => ob.disconnect()
  }, [ref, chart])
}

// ---------------------------------------------------------------------------
// 1. 스프레드 시계열
// ---------------------------------------------------------------------------
export function SpreadChart({
  data,
  entry,
}: {
  data: SpreadPoint[]
  /** 포지션 상세에서 진입 시점·값 마킹용. 페어 상세에서는 미전달 */
  entry?: { ts: number; spread: number } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      ...baseChartOpts,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })
    chartRef.current = chart
    const series: ISeriesApi<'Line'> = chart.addLineSeries({
      color: C.accent,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    })
    series.setData(
      data.map((p) => ({ time: Math.floor(p.ts / 1000), value: p.spread }))
    )
    // 0 line
    series.createPriceLine({
      price: 0,
      color: C.t4,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
      lineWidth: 1,
    })
    // 현재 점 강조
    const last = data[data.length - 1]
    if (last) {
      series.createPriceLine({
        price: last.spread,
        color: C.warning,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '현재',
        lineWidth: 1,
      })
    }
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
    return () => chart.remove()
  }, [data, entry])

  useResize(containerRef, chartRef.current)

  return <div ref={containerRef} className="h-full w-full" />
}

// ---------------------------------------------------------------------------
// 2. z-score 시계열 + ±1 / ±2 밴드
// ---------------------------------------------------------------------------
export function ZScoreChart({
  data,
  entry,
}: {
  data: SpreadPoint[]
  entry?: { ts: number; z: number } | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      ...baseChartOpts,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })
    chartRef.current = chart

    const series = chart.addLineSeries({
      color: C.accent,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    series.setData(data.map((p) => ({ time: Math.floor(p.ts / 1000), value: p.z })))

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

    // 현재 z
    const last = data[data.length - 1]
    if (last) {
      series.createPriceLine({
        price: last.z,
        color: Math.abs(last.z) >= 2 ? C.down : C.t1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `현재 z`,
        lineWidth: 1,
      })
    }
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
    return () => chart.remove()
  }, [data, entry])

  useResize(containerRef, chartRef.current)

  return <div ref={containerRef} className="h-full w-full" />
}

// ---------------------------------------------------------------------------
// 3. 잔차 히스토그램 (Histogram series — time축을 bin 인덱스로 매핑)
// ---------------------------------------------------------------------------
export function ResidualHistogram({
  bins,
  currentSpread,
}: {
  bins: HistBin[]
  currentSpread: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || bins.length === 0) return
    const chart = createChart(containerRef.current, {
      ...baseChartOpts,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      timeScale: { ...baseChartOpts.timeScale, timeVisible: false },
    })
    chartRef.current = chart

    const series = chart.addHistogramSeries({ color: C.accent })

    // bin 인덱스를 가짜 time으로 매핑 (1일 간격)
    const baseT = 1700000000 // 2023-11-14 근처, 충돌 없는 임의의 base
    const w = bins.length >= 2 ? bins[1].center - bins[0].center : 1
    const currentBin = bins.findIndex((b) => currentSpread <= b.center + w / 2)
    series.setData(
      bins.map((b, i) => ({
        time: (baseT + i * 86400) as never,
        value: b.count,
        color: i === currentBin ? C.down : C.accent,
      }))
    )
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [bins, currentSpread])

  useResize(containerRef, chartRef.current)

  return <div ref={containerRef} className="h-full w-full" />
}
