import { createChart, type Time } from 'lightweight-charts'
import { useEffect, useRef } from 'react'

import type { EquityPoint } from './types'

// globals.css 토큰 (flow-detail 관례 — 색 통일)
const C = {
  bg: '#111111',
  surface: '#1c1c1e',
  t3: '#8e8e93',
  accent: '#30d158',
  bench: '#8e8e93',
} as const

const chartOpts = {
  layout: { background: { color: C.bg }, textColor: C.t3, fontSize: 10 },
  grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
  timeScale: { borderColor: C.surface, timeVisible: false },
  rightPriceScale: { borderColor: C.surface },
  crosshair: { mode: 0 },
} as const

const t = (d: string) => d as never

const timeKey = (tm: Time | undefined): string | null => {
  if (tm == null) return null
  if (typeof tm === 'string') return tm
  if (typeof tm === 'number') return String(tm)
  return `${tm.year}-${String(tm.month).padStart(2, '0')}-${String(tm.day).padStart(2, '0')}`
}

const pct = (x: number) => `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(2)}%`

/**
 * 포트폴리오 에쿼티 커브 — 전략(accent) vs 벤치마크(회색), 둘 다 t0=1.0 정규화.
 * lightweight-charts v4 autoSize (flow-detail 관례). 벤치마크 없으면 1라인.
 */
export function EquityCurve({
  curve,
  hasBenchmark,
  holdoutStart,
}: {
  curve: EquityPoint[]
  hasBenchmark: boolean
  holdoutStart?: string | null
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || curve.length === 0) return
    const chart = createChart(ref.current, { ...chartOpts, autoSize: true })

    const strat = chart.addLineSeries({
      color: C.accent,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    })
    strat.setData(curve.map((p) => ({ time: t(p.date), value: p.equity })))

    // holdout 시작 구분선 — v4는 세로선 시리즈가 없어 경계 데이터점 마커로 표기(주황).
    if (holdoutStart) {
      const b = curve.find((p) => p.date >= holdoutStart)
      if (b) {
        strat.setMarkers([
          { time: t(b.date), position: 'aboveBar', color: '#ff9f0a', shape: 'arrowDown', text: 'holdout' },
        ])
      }
    }

    let benchSeries = false
    if (hasBenchmark) {
      const bench = chart.addLineSeries({
        color: C.bench,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      const bd = curve
        .filter((p) => p.benchmark != null)
        .map((p) => ({ time: t(p.date), value: p.benchmark as number }))
      if (bd.length) {
        bench.setData(bd)
        benchSeries = true
      }
    }

    // 크로스헤어 호버 툴팁 (자체 카드) — 날짜·전략·벤치마크 누적수익%
    const byDate = new Map<string, EquityPoint>(curve.map((p) => [p.date, p]))
    const container = ref.current
    container.style.position = 'relative'
    const tip = document.createElement('div')
    tip.style.cssText =
      'position:absolute;display:none;pointer-events:none;z-index:10;min-width:120px;padding:6px 8px;border-radius:4px;background:#1c1c1ef2;border:1px solid #3a3a3c;box-shadow:0 2px 10px #000a;font-size:11px;line-height:1.55'
    container.appendChild(tip)
    const onMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
      const key = timeKey(param.time)
      const p = key ? byDate.get(key) : null
      if (!p || !param.point) {
        tip.style.display = 'none'
        return
      }
      const rows = [
        `<div style="display:flex;justify-content:space-between;gap:12px"><span style="display:flex;align-items:center;gap:5px;color:#8e8e93"><span style="width:8px;height:8px;border-radius:2px;background:${C.accent}"></span>전략</span><span style="color:${C.accent};font-variant-numeric:tabular-nums">${pct(p.equity)}</span></div>`,
      ]
      if (benchSeries && p.benchmark != null)
        rows.push(
          `<div style="display:flex;justify-content:space-between;gap:12px"><span style="display:flex;align-items:center;gap:5px;color:#8e8e93"><span style="width:8px;height:8px;border-radius:2px;background:${C.bench}"></span>벤치</span><span style="color:#d1d1d6;font-variant-numeric:tabular-nums">${pct(p.benchmark)}</span></div>`,
        )
      tip.innerHTML =
        `<div style="color:#8e8e93;margin-bottom:4px;font-variant-numeric:tabular-nums">${p.date}</div>` +
        rows.join('')
      tip.style.display = 'block'
      const cw = container.clientWidth
      let left = param.point.x + 14
      const top = 6
      if (left + tip.offsetWidth > cw) left = param.point.x - tip.offsetWidth - 14
      tip.style.left = `${Math.max(4, left)}px`
      tip.style.top = `${top}px`
    }
    chart.subscribeCrosshairMove(onMove)
    chart.timeScale().fitContent()

    return () => {
      chart.unsubscribeCrosshairMove(onMove)
      tip.remove()
      chart.remove()
    }
  }, [curve, hasBenchmark, holdoutStart])

  if (curve.length === 0) {
    return <div className="py-8 text-center text-xs text-t4">에쿼티 커브 데이터 없음</div>
  }
  return <div ref={ref} className="h-[240px] w-full" />
}
