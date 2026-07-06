import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * 초과수익 분포 히스토그램 (인라인 SVG — flow-backtest-report 방식).
 * 반환된 에피소드 excess_pct를 구간으로 집계해 표시할 뿐, 어떤 지표도 재계산하지 않는다.
 * 0 기준선 · 양(초록)/음(빨강) 색 구분.
 */
export function ExcessHistogram({ values }: { values: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(560)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(320, Math.round(e.contentRect.width)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { bins, edges, maxCount } = useMemo(() => buildBins(values), [values])

  const H = 180
  const M = { top: 12, right: 12, bottom: 26, left: 34 }
  const plotW = Math.max(1, w - M.left - M.right)
  const plotH = H - M.top - M.bottom
  const n = bins.length
  const bw = plotW / Math.max(1, n)

  if (!values.length || n === 0) {
    return <div className="py-6 text-center text-xs text-t4">표시할 에피소드가 없습니다.</div>
  }

  const yAt = (c: number) => M.top + plotH * (1 - c / (maxCount || 1))
  // x=0 위치 (구간 경계 선형 보간)
  const lo = edges[0]
  const hi = edges[edges.length - 1]
  const zeroFrac = hi > lo ? (0 - lo) / (hi - lo) : 0.5
  const zeroX = M.left + Math.max(0, Math.min(1, zeroFrac)) * plotW

  return (
    <div ref={wrapRef} className="w-full">
      <svg width={w} height={H} className="block">
        {/* baseline */}
        <line x1={M.left} x2={w - M.right} y1={M.top + plotH} y2={M.top + plotH} stroke="#1a1a1a" />
        {/* 0 기준선 */}
        {zeroFrac >= 0 && zeroFrac <= 1 && (
          <line x1={zeroX} x2={zeroX} y1={M.top} y2={M.top + plotH} stroke="#3a3a3c" strokeDasharray="3 2" />
        )}
        {bins.map((b, i) => {
          const x = M.left + i * bw
          const y = yAt(b.count)
          const h = M.top + plotH - y
          const mid = (edges[i] + edges[i + 1]) / 2
          const color = mid >= 0 ? '#34c759' : '#ff3b30'
          return (
            <rect key={i} x={x + 0.5} y={y} width={Math.max(0, bw - 1)} height={Math.max(0, h)} fill={color} opacity={0.7}>
              <title>
                {edges[i].toFixed(1)}% ~ {edges[i + 1].toFixed(1)}% · {b.count}건
              </title>
            </rect>
          )
        })}
        {/* x 라벨: lo · 0 · hi */}
        <text x={M.left} y={H - 8} textAnchor="start" className="fill-t4 tabular-nums" fontSize={9}>
          {lo.toFixed(0)}%
        </text>
        {zeroFrac > 0.08 && zeroFrac < 0.92 && (
          <text x={zeroX} y={H - 8} textAnchor="middle" className="fill-t4 tabular-nums" fontSize={9}>
            0
          </text>
        )}
        <text x={w - M.right} y={H - 8} textAnchor="end" className="fill-t4 tabular-nums" fontSize={9}>
          {hi.toFixed(0)}%
        </text>
        {/* y 최대 눈금 */}
        <text x={M.left - 4} y={M.top + 6} textAnchor="end" className="fill-t4 tabular-nums" fontSize={9}>
          {maxCount}
        </text>
      </svg>
    </div>
  )
}

function buildBins(values: number[]): {
  bins: { count: number }[]
  edges: number[]
  maxCount: number
} {
  if (!values.length) return { bins: [], edges: [], maxCount: 0 }
  // 극단값 클립(1·99 분위)으로 구간 폭 안정화 — 표시 목적.
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
  let lo = q(0.01)
  let hi = q(0.99)
  if (!(hi > lo)) {
    lo = sorted[0]
    hi = sorted[sorted.length - 1]
  }
  if (!(hi > lo)) {
    lo -= 1
    hi += 1
  }
  const N = 31 // 홀수 → 0 근처 구간 대칭 느낌
  const edges = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N)
  const counts = new Array(N).fill(0)
  for (const v of values) {
    let idx = Math.floor(((v - lo) / (hi - lo)) * N)
    if (idx < 0) idx = 0
    if (idx >= N) idx = N - 1
    counts[idx]++
  }
  const maxCount = counts.reduce((m, c) => Math.max(m, c), 0)
  return { bins: counts.map((count) => ({ count })), edges, maxCount }
}
