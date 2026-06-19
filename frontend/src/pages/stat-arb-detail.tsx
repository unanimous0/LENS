import type { IChartApi, LogicalRange } from 'lightweight-charts'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { LegCompareChart, ResidualHistogram, ZScoreChart } from '@/components/stat-arb/charts'
import { PnlSimulator } from '@/components/stat-arb/pnl-simulator'
import { TimeframeTable } from '@/components/stat-arb/timeframe-table'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import { humanHalfLifeShort } from '@/lib/stat-arb/half-life'
import { useMarketStore } from '@/stores/marketStore'
import type { PairDetail } from '@/types/stat-arb'

const KPI_TF = '10m' // KPI 카드·메인 차트는 10분 인트라데이 기준 (일봉 종가 스파이크 배제; 30분→10분 2026-06-20)

/** 평균회귀 트레이드 방향 — 차트 추세를 머리로 해석할 필요 없게 명시.
 *  spread = R − α − β·L 이라 z>0 = R 비쌈 → 숏 R / 롱 L,  z<0 = R 쌈 → 롱 R / 숏 L.
 *  |z|<deadzone는 중립, |z|≥2는 진입권. */
function meanRevSignal(z: number, leftName: string, rightName: string) {
  const dead = 0.3
  if (z >= dead) return { longName: leftName, shortName: rightName, neutral: false, entry: z >= 2 }
  if (z <= -dead) return { longName: rightName, shortName: leftName, neutral: false, entry: z <= -2 }
  return { longName: '', shortName: '', neutral: true, entry: false }
}

/** 시계열로부터 mean/std 계산 (실시간 z용). 200개 미만이면 std=0 → z=0 처리. */
function spreadStats(series: { spread: number }[]): { mean: number; std: number } {
  const n = series.length
  if (n < 2) return { mean: 0, std: 0 }
  let sum = 0
  for (const p of series) sum += p.spread
  const mean = sum / n
  let sq = 0
  for (const p of series) {
    const d = p.spread - mean
    sq += d * d
  }
  const std = Math.sqrt(sq / (n - 1))
  return { mean, std }
}

export function StatArbDetailPage() {
  const { left, right } = useParams<{ left: string; right: string }>()
  const [detail, setDetail] = useState<PairDetail | null>(null)
  const [loanRates, setLoanRates] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 스프레드·z 차트 시간축 동기화 (체크박스 토글). 두 차트 인스턴스를 모아 연동.
  const [spreadChart, setSpreadChart] = useState<IChartApi | null>(null)
  const [zChart, setZChart] = useState<IChartApi | null>(null)
  const [syncCharts, setSyncCharts] = useState(true)

  // left/right key에서 종목코드/타입 추출 — 실시간 구독 대상
  const leftCode = left ? keyToCode(left) : ''
  const rightCode = right ? keyToCode(right) : ''
  const leftType = left ? keyType(left) : 'unknown'
  const rightType = right ? keyType(right) : 'unknown'

  // 양쪽 leg LS realtime 구독 (mount/unmount 자동)
  const subCodes = useMemo(() => [leftCode, rightCode].filter(Boolean), [leftCode, rightCode])
  usePageStockSubscriptions(subCodes)

  // 실시간 tick lookup — S:주식, E:ETF (지수 'I:'는 주식과 동일 처리, F:는 향후).
  // realtime/ls_rest.rs가 t1102 시점부터 ETF는 EtfTick으로 분기 emit → etfTicks에 안전하게 들어감.
  const leftTick = useMarketStore((s) =>
    leftType === 'E' ? s.etfTicks[leftCode] : s.stockTicks[leftCode]
  )
  const rightTick = useMarketStore((s) =>
    rightType === 'E' ? s.etfTicks[rightCode] : s.stockTicks[rightCode]
  )

  // 대여요율 1회 로딩 (PnL 시뮬용)
  useEffect(() => {
    fetch('/api/loan-rates')
      .then((r) => r.json())
      .then((d: { items: Array<{ code: string; rate_pct: number }> }) => {
        const m = new Map<string, number>()
        for (const r of d.items) m.set(r.code, r.rate_pct)
        setLoanRates(m)
      })
      .catch(() => {
        /* fail-safe */
      })
  }, [])

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

  // 두 차트 시간축 동기화 — 한쪽 visible range 변경을 다른 쪽에 반영. guard로 무한루프 방지.
  useEffect(() => {
    if (!syncCharts || !spreadChart || !zChart) return
    let guard = false
    const link = (dst: IChartApi) => (range: LogicalRange | null) => {
      if (guard || !range) return
      guard = true
      dst.timeScale().setVisibleLogicalRange(range)
      guard = false
    }
    const h1 = link(zChart)
    const h2 = link(spreadChart)
    spreadChart.timeScale().subscribeVisibleLogicalRangeChange(h1)
    zChart.timeScale().subscribeVisibleLogicalRangeChange(h2)
    // 켜는 즉시 1회 맞춤 (스프레드 → z)
    const r = spreadChart.timeScale().getVisibleLogicalRange()
    if (r) zChart.timeScale().setVisibleLogicalRange(r)
    return () => {
      spreadChart.timeScale().unsubscribeVisibleLogicalRangeChange(h1)
      zChart.timeScale().unsubscribeVisibleLogicalRangeChange(h2)
    }
  }, [syncCharts, spreadChart, zChart])

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

  // 실시간 가격 → 실시간 spread/z 계산 (양쪽 가격 있을 때만)
  const leftPrice = leftTick?.price ?? 0
  const rightPrice = rightTick?.price ?? 0
  const hasLive = leftPrice > 0 && rightPrice > 0 && dayStat != null
  // 실시간 z는 차트 z와 동일 기준이어야 함 → 백엔드가 준 10분 잔차 정규화 기준(center/scale) 우선 사용.
  // (없으면 spread_series에서 재계산 — 구버전 응답 호환.)
  const _fallback = spreadStats(detail.spread_series)
  const spreadMean = detail.spread_center ?? _fallback.mean
  const spreadStd = detail.spread_scale ?? _fallback.std
  const liveSpread = hasLive ? rightPrice - dayStat!.alpha - dayStat!.hedge_ratio * leftPrice : null
  const liveZ = hasLive && spreadStd > 0 ? (liveSpread! - spreadMean) / spreadStd : null

  // KPI 카드: 실시간 있으면 liveZ, 없으면 DB 마지막 점 z
  const dbLastZ = detail.spread_series.length
    ? detail.spread_series[detail.spread_series.length - 1].z
    : 0
  const displayZ = liveZ ?? dbLastZ
  const zCls = Math.abs(displayZ) >= 2.5 ? 'text-warning' : Math.abs(displayZ) >= 1.5 ? 'text-t1' : 'text-t3'
  const signal = meanRevSignal(displayZ, detail.left_name, detail.right_name)

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

      {/* 현재 상태 — 양쪽 leg 실시간 가격 + 실시간 spread/z */}
      <div className="panel grid grid-cols-1 gap-2 p-3 md:grid-cols-3">
        <LiveLegCard
          role="L (x)"
          name={detail.left_name}
          code={leftCode}
          type={leftType}
          tick={leftTick}
        />
        <LiveLegCard
          role="R (y)"
          name={detail.right_name}
          code={rightCode}
          type={rightType}
          tick={rightTick}
        />
        <div className="flex flex-col justify-center rounded-sm bg-bg-surface px-3 py-2.5 tabular-nums">
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-wider text-t3">Spread · Z</span>
            <span className="text-[10px] text-t4">
              μ {Math.round(spreadMean).toLocaleString()} · σ {Math.round(spreadStd).toLocaleString()}
            </span>
          </div>
          {liveSpread != null ? (
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className={`text-xl font-semibold leading-none ${zCls}`}>
                {liveZ != null ? `${liveZ >= 0 ? '+' : ''}${liveZ.toFixed(2)}` : '—'}
              </span>
              <span className="text-[11px] text-t3">σ</span>
              <span className="ml-auto text-[11px] text-t3">
                spread <span className="text-t2">{Math.round(liveSpread).toLocaleString()}</span>
              </span>
            </div>
          ) : (
            <div className="mt-1 text-sm text-t3">실시간 가격 대기 중…</div>
          )}
          {/* 평균회귀 시그널 — 추세 해석 없이 트레이드 방향을 pill로 */}
          <div className="mt-1.5">
            {signal.neutral ? (
              <span className="inline-flex rounded-sm bg-bg-base px-1.5 py-0.5 text-[10px] text-t3">
                중립 · 평균 근처
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-sm bg-bg-base px-1.5 py-0.5 text-[11px]">
                <span className="font-semibold text-up">롱 {signal.longName}</span>
                <span className="text-t4">/</span>
                <span className="font-semibold text-down">숏 {signal.shortName}</span>
                {signal.entry && <span className="ml-0.5 font-semibold text-warning">진입권</span>}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 좌우 분할 */}
      <div className="grid grid-cols-1 gap-1 lg:grid-cols-5">
        {/* 좌측 — KPI + Timeframe 테이블 + Leg */}
        <div className="flex flex-col gap-1 lg:col-span-2">
          {/* KPI 카드 4개 */}
          <div className="panel grid grid-cols-2 gap-2 p-3">
            <KpiCard
              label={liveZ != null ? '현재 z (실시간)' : '현재 z (DB 마지막)'}
              value={`${displayZ >= 0 ? '+' : ''}${displayZ.toFixed(2)}`}
              cls={zCls}
            />
            <KpiCard
              label={`half-life (${KPI_TF})`}
              value={dayStat ? humanHalfLifeShort(KPI_TF, dayStat.half_life) : '—'}
              cls="text-t1"
            />
            <KpiCard
              label={`ADF (${KPI_TF})`}
              value={dayStat ? dayStat.adf_tstat.toFixed(2) : '—'}
              cls={dayStat && dayStat.adf_tstat <= -3 ? 'text-up' : 'text-t3'}
            />
            <KpiCard
              label={`R² (${KPI_TF})`}
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
          <label className="flex cursor-pointer select-none items-center gap-1.5 self-end px-1 text-[11px] text-t3">
            <input
              type="checkbox"
              checked={syncCharts}
              onChange={(e) => setSyncCharts(e.target.checked)}
              className="accent-accent"
            />
            가격·z 차트 시간축 동기화
          </label>
          <div className="panel p-3">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 text-xs text-t3">
              <span>두 종목 % 등락 (시작점 0 기준)</span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-3 rounded-sm bg-accent" />
                <span className="text-t2">{detail.left_name}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-1.5 w-3 rounded-sm bg-blue" />
                <span className="text-t2">{detail.right_name}</span>
              </span>
            </div>
            <div className="h-[260px]">
              <LegCompareChart
                data={detail.spread_series}
                live={leftPrice > 0 && rightPrice > 0 ? { left: leftPrice, right: rightPrice } : null}
                register={setSpreadChart}
              />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              z-score 시계열 + ±1·±2σ 밴드  ·  현재{' '}
              <span className={zCls}>
                {displayZ >= 0 ? '+' : ''}
                {displayZ.toFixed(2)}
              </span>
              {liveZ != null && <span className="ml-1 text-[10px] text-accent">실시간</span>}
              {!signal.neutral && (
                <span className="ml-2">
                  → <span className="font-semibold text-up">롱 {signal.longName}</span>
                  <span className="text-t4"> / </span>
                  <span className="font-semibold text-down">숏 {signal.shortName}</span>
                  {signal.entry && <span className="ml-1 text-warning">· 진입권</span>}
                </span>
              )}
            </div>
            <div className="h-[260px]">
              <ZScoreChart
                data={detail.spread_series}
                live={liveZ}
                register={setZChart}
              />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              잔차 분포 (σ 단위) · 평균 0 · ±1σ/±2σ · 현재 빨강
            </div>
            <div className="h-[220px]">
              <ResidualHistogram
                bins={detail.histogram}
                center={spreadMean}
                scale={spreadStd}
                currentZ={displayZ}
              />
            </div>
          </div>
        </div>
      </div>

      {/* PnL 시뮬레이터 — 페이지 하단 전체 너비 */}
      <PnlSimulator
        detail={detail}
        loanRates={loanRates}
        livePrices={{ left: leftPrice, right: rightPrice }}
        liveZ={liveZ}
        liveSpread={liveSpread}
      />
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

/** Leg별 실시간 가격 카드 — 주식은 등락률 함께, ETF/지수는 가격만. */
function LiveLegCard({
  role,
  name,
  code,
  type,
  tick,
}: {
  role: string
  name: string
  code: string
  type: ReturnType<typeof keyType>
  tick: { price?: number; prev_close?: number } | undefined
}) {
  const price = tick?.price ?? 0
  // 등락률 — 주식 tick만 prev_close 있음
  const prev = (tick as { prev_close?: number } | undefined)?.prev_close
  const hasChange = type === 'S' && prev != null && prev > 0 && price > 0
  const chgPct = hasChange ? ((price - prev!) / prev!) * 100 : 0
  const chgCls = hasChange ? (chgPct > 0 ? 'text-up' : chgPct < 0 ? 'text-down' : 'text-t3') : 'text-t3'

  return (
    <div className="flex flex-col items-center justify-center rounded-sm bg-bg-surface px-3 py-2.5 text-center">
      <div className="flex items-center gap-1.5">
        <span className="rounded-sm bg-bg-base px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-t3">
          {role}
        </span>
        <span className="text-[11px] font-medium text-t2">{name}</span>
      </div>
      <div className="mt-1 text-xl font-semibold leading-none tracking-tight text-t1 tabular-nums">
        {price > 0 ? price.toLocaleString() : '—'}
      </div>
      <div className="mt-1 flex items-center justify-center gap-1.5 text-[10px] tabular-nums">
        <span className="text-t4">{code}</span>
        {hasChange && (
          <span className={chgCls}>
            {chgPct > 0 ? '▲' : chgPct < 0 ? '▼' : ''} {Math.abs(chgPct).toFixed(2)}%
          </span>
        )}
      </div>
    </div>
  )
}
