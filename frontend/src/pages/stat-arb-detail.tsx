import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ResidualHistogram, SpreadChart, ZScoreChart } from '@/components/stat-arb/charts'
import { TimeframeTable } from '@/components/stat-arb/timeframe-table'
import type { PairDetail } from '@/types/stat-arb'

const KPI_TF = '1d' // KPI 카드는 일봉 기준

export function StatArbDetailPage() {
  const { left, right } = useParams<{ left: string; right: string }>()
  const [detail, setDetail] = useState<PairDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!left || !right) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ left, right })
    fetch(`/api/stat-arb/pairs/detail?${params}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text()
          throw new Error(`HTTP ${r.status}: ${body}`)
        }
        return r.json() as Promise<PairDetail>
      })
      .then((d) => setDetail(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [left, right])

  if (loading) {
    return <div className="p-4 text-sm text-t3">로딩 중…</div>
  }
  if (error || !detail) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Link to="/stat-arb" className="text-xs text-accent hover:underline">
          ← 페어 리스트로
        </Link>
        <div className="text-sm text-down">상세 로딩 실패: {error ?? 'unknown'}</div>
      </div>
    )
  }

  const dayStat = detail.timeframes.find((t) => t.timeframe === KPI_TF)
  const currentSpread = detail.spread_series.length
    ? detail.spread_series[detail.spread_series.length - 1].spread
    : 0
  const currentZ = detail.spread_series.length
    ? detail.spread_series[detail.spread_series.length - 1].z
    : 0
  const zCls = Math.abs(currentZ) >= 2.5 ? 'text-warning' : Math.abs(currentZ) >= 1.5 ? 'text-t1' : 'text-t3'

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 헤더 */}
      <div className="panel flex items-center gap-3 p-3">
        <Link to="/stat-arb" className="text-xs text-accent hover:underline">
          ← 페어 리스트
        </Link>
        <div className="flex flex-1 items-center gap-2">
          <span className="text-sm font-medium text-t1">{detail.left_name}</span>
          <span className="text-t3">↔</span>
          <span className="text-sm font-medium text-t1">{detail.right_name}</span>
          <span className="text-[10px] text-t4">
            ({detail.left_key} / {detail.right_key})
          </span>
        </div>
      </div>

      {/* 좌우 분할 */}
      <div className="grid grid-cols-1 gap-1 lg:grid-cols-5">
        {/* 좌측 — KPI + Timeframe 테이블 + Leg */}
        <div className="flex flex-col gap-1 lg:col-span-2">
          {/* KPI 카드 4개 */}
          <div className="panel grid grid-cols-2 gap-2 p-3">
            <KpiCard label="현재 z" value={`${currentZ >= 0 ? '+' : ''}${currentZ.toFixed(2)}`} cls={zCls} />
            <KpiCard
              label="half-life (1d)"
              value={dayStat ? `${dayStat.half_life.toFixed(1)}일` : '—'}
              cls="text-t1"
            />
            <KpiCard
              label="ADF (1d)"
              value={dayStat ? dayStat.adf_tstat.toFixed(2) : '—'}
              cls={dayStat && dayStat.adf_tstat <= -3 ? 'text-up' : 'text-t3'}
            />
            <KpiCard
              label="R² (1d)"
              value={dayStat ? dayStat.r_squared.toFixed(3) : '—'}
              cls={dayStat && dayStat.r_squared >= 0.9 ? 'text-up' : 'text-t1'}
            />
          </div>

          {/* Timeframe 테이블 */}
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">Timeframe 비교</div>
            <TimeframeTable rows={detail.timeframes} />
          </div>

          {/* Leg 정보 */}
          <div className="panel p-3 text-xs text-t2 tabular-nums">
            <div className="mb-2 text-t3">Leg (right = α + β·left + ε)</div>
            <div className="space-y-1.5">
              <div>
                <span className="text-t3">L (x):</span>{' '}
                <span className="text-t1">{detail.left_name}</span>{' '}
                <span className="text-t4">{detail.left_key}</span>
              </div>
              <div>
                <span className="text-t3">R (y):</span>{' '}
                <span className="text-t1">{detail.right_name}</span>{' '}
                <span className="text-t4">{detail.right_key}</span>
              </div>
              {dayStat && (
                <div className="pt-1">
                  <span className="text-t3">α =</span> <span>{dayStat.alpha.toFixed(2)}</span>
                  {'  '}
                  <span className="text-t3">β =</span> <span>{dayStat.hedge_ratio.toFixed(4)}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 우측 — 차트 3개 vertical stack */}
        <div className="flex flex-col gap-1 lg:col-span-3">
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              스프레드 시계열 (잔차 = y − α − β·x)  ·  현재 {Math.round(currentSpread).toLocaleString()}
            </div>
            <div className="h-[260px]">
              <SpreadChart data={detail.spread_series} />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              z-score 시계열 + ±1·±2σ 밴드  ·  현재{' '}
              <span className={zCls}>
                {currentZ >= 0 ? '+' : ''}
                {currentZ.toFixed(2)}
              </span>
            </div>
            <div className="h-[260px]">
              <ZScoreChart data={detail.spread_series} />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">잔차 분포 히스토그램 · 현재 위치 빨강</div>
            <div className="h-[220px]">
              <ResidualHistogram bins={detail.histogram} currentSpread={currentSpread} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function KpiCard({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="rounded-sm bg-bg-surface px-3 py-2">
      <div className="text-[10px] text-t3">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}
