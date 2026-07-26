import type { IChartApi, ISeriesApi, LogicalRange } from 'lightweight-charts'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { AlertButton } from '@/components/stat-arb/alert-button'
import { LegCompareChart, ResidualHistogram, SpreadDualChart, ZScoreChart } from '@/components/stat-arb/charts'
import { PnlSimulator } from '@/components/stat-arb/pnl-simulator'
import { TimeframeTable } from '@/components/stat-arb/timeframe-table'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import { CAL_PER_TRADING_DAY, toTradingDays } from '@/lib/stat-arb/half-life'
import { useMarketStore } from '@/stores/marketStore'
import type { KalmanStat, PairDetail, SpreadPoint } from '@/types/stat-arb'

/** 기준 토글 세그먼트 — 일봉(스윙 판단) / 10분(진입 타이밍). stat-arb.tsx Seg와 동일 톤. */
function BasisSeg({ value, onChange }: { value: '1d' | '10m'; onChange: (v: '1d' | '10m') => void }) {
  const opts: Array<{ v: '1d' | '10m'; label: string }> = [
    { v: '1d', label: '일봉' },
    { v: '10m', label: '10분' },
  ]
  return (
    <div className="flex overflow-hidden rounded-sm bg-bg-surface">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 text-xs ${
            value === o.v ? 'bg-accent/25 text-accent' : 'text-t3 hover:text-t1'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 1D 모드 전용 차트 뷰 토글 — 장중(일봉기준 z를 10분 시간축으로) / 장기(3년 일봉 종가 z, 날짜축).
 *  z·스프레드·leg 3개 시계열 차트에만 영향. 카드·계산기·Kalman은 항상 일봉 기준(불변). */
function ZViewSeg({
  value,
  onChange,
}: {
  value: 'intraday' | 'longterm'
  onChange: (v: 'intraday' | 'longterm') => void
}) {
  const opts: Array<{ v: 'intraday' | 'longterm'; label: string; title: string }> = [
    { v: 'intraday', label: '장중', title: '일봉 기준 z를 장중 실시간으로 (진입 타이밍)' },
    { v: 'longterm', label: '장기', title: '3년 일봉 종가 z (장기 맥락)' },
  ]
  return (
    <div className="flex overflow-hidden rounded-sm bg-bg-surface">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          title={o.title}
          className={`px-2.5 py-1 text-xs ${
            value === o.v ? 'bg-accent/25 text-accent' : 'text-t3 hover:text-t1'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

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
  // 판단 기준 토글 — 일봉(스윙, 기본) / 10분(진입 타이밍). 카드·차트·히스토·베이시스·계산기 전부 연동.
  const [basis, setBasis] = useState<'1d' | '10m'>('1d')
  // 1D 모드 차트 뷰 — 장중(기본, 일봉기준 z를 10분 시간축으로) / 장기(3년 일봉 종가 z). 3개 차트에만 영향.
  const [zView, setZView] = useState<'intraday' | 'longterm'>('intraday')
  // 내 진입 포지션 입력 (베이시스·손익 계산기). 매수/매도 진입가·수량.
  const [posBuyEntry, setPosBuyEntry] = useState('')
  const [posBuyQty, setPosBuyQty] = useState('')
  const [posSellEntry, setPosSellEntry] = useState('')
  const [posSellQty, setPosSellQty] = useState('')

  // 가격·z 차트 동기화 (체크박스 토글). 차트+primary series를 모아 시간축·crosshair 연동.
  type ChartReg = { chart: IChartApi; series: ISeriesApi<'Line'> } | null
  const [legReg, setLegReg] = useState<ChartReg>(null)
  const [spreadReg, setSpreadReg] = useState<ChartReg>(null)
  const [zReg, setZReg] = useState<ChartReg>(null)
  const [syncCharts, setSyncCharts] = useState(true)
  const registerLeg = useCallback(
    (chart: IChartApi | null, series?: ISeriesApi<'Line'> | null) =>
      setLegReg(chart && series ? { chart, series } : null),
    []
  )
  const registerSpread = useCallback(
    (chart: IChartApi | null, series?: ISeriesApi<'Line'> | null) =>
      setSpreadReg(chart && series ? { chart, series } : null),
    []
  )
  const registerZ = useCallback(
    (chart: IChartApi | null, series?: ISeriesApi<'Line'> | null) =>
      setZReg(chart && series ? { chart, series } : null),
    []
  )

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

  // 3개 차트(% 등락 / 스프레드 / z) 시간축 동기화 — 한쪽 range 변경을 나머지에 반영.
  useEffect(() => {
    if (!syncCharts) return
    const cs = [legReg, spreadReg, zReg].filter((r): r is NonNullable<ChartReg> => r != null).map((r) => r.chart)
    if (cs.length < 2) return
    let guard = false
    const subs: Array<[IChartApi, (range: LogicalRange | null) => void]> = []
    cs.forEach((src) => {
      const h = (range: LogicalRange | null) => {
        if (guard || !range) return
        guard = true
        cs.forEach((dst) => {
          if (dst !== src) dst.timeScale().setVisibleLogicalRange(range)
        })
        guard = false
      }
      src.timeScale().subscribeVisibleLogicalRangeChange(h)
      subs.push([src, h])
    })
    // 켜는 즉시 1회 맞춤 (첫 차트 기준)
    const r0 = cs[0].timeScale().getVisibleLogicalRange()
    if (r0) cs.slice(1).forEach((c) => c.timeScale().setVisibleLogicalRange(r0))
    return () => subs.forEach(([c, h]) => c.timeScale().unsubscribeVisibleLogicalRangeChange(h))
  }, [syncCharts, legReg, spreadReg, zReg])

  // 3개 차트 crosshair(십자선) 동기화 — 한쪽 호버 시 나머지 같은 시점에 십자선 표시.
  // 세 차트가 같은 timestamp(spread_series) 공유 → param.logical로 상대 차트 값 조회.
  useEffect(() => {
    if (!syncCharts) return
    const regs = [legReg, spreadReg, zReg].filter((r): r is NonNullable<ChartReg> => r != null)
    if (regs.length < 2) return
    let guard = false
    const subs: Array<[IChartApi, (param: { time?: unknown; logical?: number | null }) => void]> = []
    regs.forEach((src) => {
      const h = (param: { time?: unknown; logical?: number | null }) => {
        if (guard) return
        guard = true
        regs.forEach((dst) => {
          if (dst === src) return
          if (param.time === undefined || param.logical == null) {
            dst.chart.clearCrosshairPosition()
          } else {
            const bar = dst.series.dataByIndex(param.logical)
            if (bar && 'value' in bar && bar.value != null) {
              dst.chart.setCrosshairPosition(bar.value, param.time as never, dst.series)
            } else {
              dst.chart.clearCrosshairPosition()
            }
          }
        })
        guard = false
      }
      src.chart.subscribeCrosshairMove(h)
      subs.push([src.chart, h])
    })
    return () => subs.forEach(([c, h]) => c.unsubscribeCrosshairMove(h))
  }, [syncCharts, legReg, spreadReg, zReg])

  // 장중·일봉기준 시계열 — 장중 10분 가격(spread_series)을 *일봉* 회귀(α·β)·정규화(μ·σ)에 재점수화.
  //  → z=2 = 진짜 "일봉 2σ"(정규화는 항상 일봉)인데 10분 촘촘히 움직여 진입 타이밍 관찰용. 인트라데이 시간축.
  //  detail/basis 변경 시에만 재계산(틱마다 X). 1D 아니거나 표본 없으면 [] → 장기로 fallback.
  const intradayOnDaily = useMemo<SpreadPoint[]>(() => {
    if (!detail) return []
    const dailyOk = (detail.spread_series_daily?.length ?? 0) >= 2
    if (basis !== '1d' || !dailyOk) return []
    const day = detail.timeframes.find((t) => t.timeframe === '1d')
    const src = detail.spread_series
    if (!day || !src.length) return []
    const fb = spreadStats(detail.spread_series_daily!)
    const mean = detail.daily_center ?? fb.mean
    const std = detail.daily_scale ?? fb.std
    return src.map((p) => {
      // left/right 없거나 비정상이면 원 10분 점 유지(안전) — 정상 케이스는 항상 재점수화.
      if (p.left == null || p.right == null || p.left <= 0 || p.right <= 0) {
        return { ts: p.ts, spread: p.spread, z: p.z, left: p.left, right: p.right }
      }
      const spreadD = p.right - day.alpha - day.hedge_ratio * p.left
      const zD = std > 0 ? (spreadD - mean) / std : 0
      return { ts: p.ts, spread: spreadD, z: zD, left: p.left, right: p.right }
    })
  }, [detail, basis])

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

  // 선택된 기준으로 헤드라인 일괄 선택 — 카드·차트·히스토·베이시스·계산기 전부 이 값에 묶임.
  // 일봉 선택했으나 daily 시계열이 비면(구버전 응답·표본 부족) 10분으로 graceful fallback.
  const hasDaily = (detail.spread_series_daily?.length ?? 0) >= 2
  const useDaily = basis === '1d' && hasDaily
  const effBasis: '1d' | '10m' = useDaily ? '1d' : '10m'
  const basisLabel = effBasis === '1d' ? '일봉' : '10분'
  const dayStat = detail.timeframes.find((t) => t.timeframe === effBasis)
  const headlineSeries = useDaily ? detail.spread_series_daily! : detail.spread_series
  const headlineHist = useDaily ? (detail.histogram_daily ?? []) : detail.histogram

  // 실시간 가격 → 실시간 spread/z 계산 (양쪽 가격 있을 때만)
  const leftPrice = leftTick?.price ?? 0
  const rightPrice = rightTick?.price ?? 0
  const hasLive = leftPrice > 0 && rightPrice > 0 && dayStat != null
  // 실시간 z는 차트 z와 동일 기준이어야 함 → 백엔드가 준 헤드라인 잔차 정규화 기준(center/scale) 우선 사용.
  // (없으면 headlineSeries에서 재계산 — 구버전 응답 호환.)
  const _fallback = spreadStats(headlineSeries)
  const spreadMean = (useDaily ? detail.daily_center : detail.spread_center) ?? _fallback.mean
  const spreadStd = (useDaily ? detail.daily_scale : detail.spread_scale) ?? _fallback.std
  const liveSpread = hasLive ? rightPrice - dayStat!.alpha - dayStat!.hedge_ratio * leftPrice : null
  const liveZ = hasLive && spreadStd > 0 ? (liveSpread! - spreadMean) / spreadStd : null

  // 3개 시계열 차트(leg/스프레드/z) 전용 소스·축 — 카드·히스토·계산기는 headlineSeries(일봉) 그대로.
  //  · 1D + 장중 → intradayOnDaily(일봉기준 z를 10분 축)  · 1D + 장기 → spread_series_daily(날짜축)
  //  · 10m       → spread_series(10분 축, 기존)
  //  장중 표본 없으면(intradayOnDaily 빈 배열) 장기로 강등. 토글은 useDaily일 때만 노출.
  const canIntraday = useDaily && intradayOnDaily.length > 0
  const zViewEff: 'intraday' | 'longterm' =
    useDaily ? (zView === 'intraday' && canIntraday ? 'intraday' : 'longterm') : 'intraday'
  const chartSeries = useDaily
    ? zViewEff === 'intraday'
      ? intradayOnDaily
      : detail.spread_series_daily!
    : detail.spread_series
  const chartDaily = useDaily && zViewEff === 'longterm' // business-day 날짜축은 장기 뷰만

  // KPI 카드: 실시간 있으면 liveZ, 없으면 DB 마지막 점 z
  const dbLastZ = headlineSeries.length ? headlineSeries[headlineSeries.length - 1].z : 0
  const displayZ = liveZ ?? dbLastZ
  const zCls = Math.abs(displayZ) >= 2.5 ? 'text-warning' : Math.abs(displayZ) >= 1.5 ? 'text-t1' : 'text-t3'
  const signal = meanRevSignal(displayZ, detail.left_name, detail.right_name)

  // 전형 청산 회귀기간 — *현재 z 무관*, 이 페어가 표준 진입(2σ)에서 청산권(0.3σ)까지
  // 회귀하는 데 보통 걸리는 기간(페어 고유 특성). 달력일(주말·공휴일 포함) 근사.
  //   전형거래일 = half-life(거래일) × log₂(2.0 / 0.3),  달력일 = ×CAL_PER_TRADING_DAY.
  // half-life는 평균치라 큰 충격은 더 걸릴 수 있음(근사).
  const ENTRY_Z_REF = 2.0
  const EXIT_Z = 0.3
  // 선정 근거 — 발굴 기준(3년 일봉)과 같은 1d 통계로 게이트 통과 표시.
  const selDaily = detail.timeframes.find((t) => t.timeframe === '1d')
  const hlTradingDays = dayStat ? toTradingDays(effBasis, dayStat.half_life) : null
  const typicalReversionCalDays =
    hlTradingDays != null && hlTradingDays > 0
      ? hlTradingDays * Math.log2(ENTRY_Z_REF / EXIT_Z) * CAL_PER_TRADING_DAY
      : null

  // 베이시스(원 단위) — 두 표현을 함께(비교 후 하나 정리 예정).
  //  ① 이탈 = 잔차(right − α − β·left) : 균형=0 중심, z 차트와 연동. "균형에서 얼마 벗어남".
  //  ② 절대 = right − β·left (= 이탈 + α) : 평균이 α인 원값, 선물−현물 같은 절대 가격차 느낌.
  //  실제 헤지 = right 1주 : left β주 → 이 포지션 손익 = 베이시스 변화. β≈1이면 거의 단순 가격차.
  const dbLastSpread = headlineSeries.length
    ? headlineSeries[headlineSeries.length - 1].spread
    : 0
  const basisDev = liveSpread ?? dbLastSpread // ① 이탈(잔차)
  const alphaWon = dayStat?.alpha ?? 0
  const basisAbs = basisDev + alphaWon // ② 절대 = right − β·left
  const basis2sigma = spreadStd * 2
  // 진입 방향(signal)의 매수/매도 종목 현재가 매핑
  const longPrice = signal.longName === detail.left_name ? leftPrice : rightPrice
  const shortPrice = signal.shortName === detail.left_name ? leftPrice : rightPrice

  // 내 진입 포지션 계산기 — z 부호로 매수/매도 종목 결정(z≥0: 매수 left/매도 right, z<0: 반대).
  const zSign = displayZ >= 0
  const posBuyName = zSign ? detail.left_name : detail.right_name
  const posSellName = zSign ? detail.right_name : detail.left_name
  const posBuyCur = zSign ? leftPrice : rightPrice // 매수 종목 현재가
  const posSellCur = zSign ? rightPrice : leftPrice // 매도 종목 현재가
  const betaWon = dayStat?.hedge_ratio ?? 0
  const pBE = parseFloat(posBuyEntry) || 0
  const pBQ = parseFloat(posBuyQty) || 0
  const pSE = parseFloat(posSellEntry) || 0
  const pSQ = parseFloat(posSellQty) || 0
  const hasPos = pBE > 0 && pSE > 0 && (pBQ > 0 || pSQ > 0)
  // 진입 시 left/right 가격 (매수/매도를 left/right로 환원)
  const entLeft = zSign ? pBE : pSE
  const entRight = zSign ? pSE : pBE
  const posEntryDev = entRight - alphaWon - betaWon * entLeft // 진입 이탈 베이시스
  const posEntryAbs = entRight - betaWon * entLeft // 진입 절대 베이시스
  const posEntryZ = spreadStd > 0 ? (posEntryDev - spreadMean) / spreadStd : 0
  // 현재 평가손익 = 매수분(현재-진입)×수량 + 매도분(진입-현재)×수량
  const posPnL =
    (posBuyCur > 0 ? (posBuyCur - pBE) * pBQ : 0) + (posSellCur > 0 ? (pSE - posSellCur) * pSQ : 0)

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
          <span className="text-[10px] text-t3">
            ({detail.left_key} / {detail.right_key})
          </span>
        </div>
        <div className="flex items-center gap-3">
          <AlertButton
            leftKey={detail.left_key}
            rightKey={detail.right_key}
            leftName={detail.left_name}
            rightName={detail.right_name}
            currentZ={displayZ}
          />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-t3">기준</span>
            <BasisSeg value={basis} onChange={setBasis} />
          </div>
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
            <span className="text-[10px] text-t3">
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
                <span className="text-t3">/</span>
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
              label={`현재 z · ${basisLabel} (${liveZ != null ? '실시간' : 'DB 마지막'})`}
              value={`${displayZ >= 0 ? '+' : ''}${displayZ.toFixed(2)}`}
              cls={zCls}
            />
            <KpiCard
              label="전형 회귀 (2σ→±0.3σ)"
              value={typicalReversionCalDays != null ? `약 ${Math.round(typicalReversionCalDays)}일` : '—'}
              cls="text-t1"
            />
            <KpiCard
              label={`ADF (${basisLabel})`}
              value={dayStat ? dayStat.adf_tstat.toFixed(2) : '—'}
              cls={dayStat && dayStat.adf_tstat <= -3 ? 'text-up' : 'text-t3'}
            />
            <KpiCard
              label={`R² (${basisLabel})`}
              value={dayStat ? dayStat.r_squared.toFixed(3) : '—'}
              cls={dayStat && dayStat.r_squared >= 0.9 ? 'text-up' : 'text-t1'}
            />
          </div>

          {/* 관계 안정성 (Kalman 시변 β 드리프트) — 항상 일봉 기준 */}
          {detail.kalman && <RelationStabilityPanel k={detail.kalman} />}

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
                <span className="text-t3">{detail.left_key}</span>
              </div>
              <div>
                <span className="text-t3">R (y):</span>{' '}
                <span className="text-t1">{detail.right_name}</span>{' '}
                <span className="text-t3">{detail.right_key}</span>
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

          {/* 선정 근거 — 이 페어가 발굴 게이트를 어떻게 통과했나 (3년 일봉) */}
          {selDaily && (
            <div className="panel p-3 text-xs">
              <div className="mb-2 text-t3">발굴 기준 점검 (3년 일봉) — 목록의 페어는 모두 통과한 것</div>
              <ul className="space-y-1">
                <GateRow
                  ok={Math.abs(selDaily.corr) >= 0.5}
                  label="상관 |r| ≥ 0.5"
                  val={selDaily.corr.toFixed(2)}
                />
                <GateRow
                  ok={selDaily.r_squared >= 0.5}
                  label="R² ≥ 0.5 (직선 관계)"
                  val={selDaily.r_squared.toFixed(2)}
                />
                <GateRow
                  ok={selDaily.adf_tstat <= -3}
                  label="ADF ≤ −3.0 (평균회귀)"
                  val={selDaily.adf_tstat.toFixed(2)}
                />
                <GateRow
                  ok={selDaily.half_life >= 0.5 && selDaily.half_life <= 90}
                  label="half-life 0.5~90거래일"
                  val={`${selDaily.half_life.toFixed(0)}일`}
                />
              </ul>
              <div className="mt-2 text-xs leading-relaxed text-t3">
                + 같은 도메인 그룹(섹터·ETF) 후보 · 양방향 ADF(방향 대칭) · 최근 6개월 안정성까지
                통과해 선정됨. 전반 과정은 페어 목록 상단 &ldquo;발굴 방법론&rdquo; 참고.
              </div>
            </div>
          )}

          {/* 베이시스 (원 단위) — ① 이탈(0중심, z연동) ② 절대(right−β·left) + 매수/매도 + 현재가 */}
          {dayStat && (
            <div className="panel p-3 text-xs">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-t1">
                베이시스 (원 단위)
                {liveSpread != null ? (
                  <span className="text-[11px] font-normal text-accent">실시간</span>
                ) : (
                  <span className="text-[11px] font-normal text-t3">DB 마지막</span>
                )}
              </div>
              <div className="space-y-3 tabular-nums">
                <div>
                  <div className="text-xs text-t2">① 이탈 베이시스 <span className="text-t3">(균형=0, z 차트와 연동)</span></div>
                  <div className="mt-0.5">
                    <span
                      className={`text-base font-semibold ${
                        Math.abs(basisDev) >= basis2sigma
                          ? 'text-warning'
                          : Math.abs(basisDev) >= spreadStd
                          ? 'text-t1'
                          : 'text-t2'
                      }`}
                    >
                      {basisDev >= 0 ? '+' : ''}
                      {Math.round(basisDev).toLocaleString()}원
                    </span>
                    <span className="ml-2 text-t3">
                      ±2σ = ±{Math.round(basis2sigma).toLocaleString()}원
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-t2">② 절대 베이시스 <span className="text-t3">(right − β·left)</span></div>
                  <div className="mt-0.5">
                    <span className="text-base font-semibold text-t1">
                      {Math.round(basisAbs).toLocaleString()}원
                    </span>
                    <span className="ml-2 text-t3">
                      평균 {Math.round(alphaWon).toLocaleString()} · ±2σ [
                      {Math.round(alphaWon - basis2sigma).toLocaleString()} ~{' '}
                      {Math.round(alphaWon + basis2sigma).toLocaleString()}]
                    </span>
                  </div>
                </div>
              </div>

              {/* 진입 방향 + 현재가 */}
              <div className="mt-3 rounded-sm bg-bg-surface p-2.5">
                <div className="mb-1.5 text-xs text-t2">
                  지금 진입한다면
                  {signal.entry ? (
                    <span className="ml-1 text-warning">· ±2σ 진입권</span>
                  ) : signal.neutral ? (
                    <span className="ml-1 text-t3">· 균형 근처 (관망)</span>
                  ) : (
                    <span className="ml-1 text-t3">· 대기 (2σ 미도달)</span>
                  )}
                </div>
                {signal.neutral ? (
                  <div className="text-xs text-t3">
                    {detail.left_name} {leftPrice > 0 ? leftPrice.toLocaleString() : '—'}원 ·{' '}
                    {detail.right_name} {rightPrice > 0 ? rightPrice.toLocaleString() : '—'}원
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-sm font-semibold text-up">매수</span>{' '}
                      <span className="text-sm text-t1">{signal.longName}</span>
                      <div className="text-t2">
                        {longPrice > 0 ? `${longPrice.toLocaleString()}원` : '—'}
                      </div>
                    </div>
                    <div>
                      <span className="text-sm font-semibold text-down">매도</span>{' '}
                      <span className="text-sm text-t1">{signal.shortName}</span>
                      <div className="text-t2">
                        {shortPrice > 0 ? `${shortPrice.toLocaleString()}원` : '—'}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 내 진입 포지션 입력 → 손익·베이시스 계산기 */}
              <div className="mt-2 rounded-sm bg-bg-surface p-2.5">
                <div className="mb-1.5 text-xs text-t2">내 진입 포지션 입력 → 손익·베이시스</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  <div className="col-span-2 text-xs text-t3">
                    매수 <span className="font-medium text-up">{posBuyName}</span>
                  </div>
                  <label className="flex items-center gap-1 text-xs">
                    <span className="w-8 shrink-0 text-t3">진입가</span>
                    <input
                      type="number"
                      value={posBuyEntry}
                      onChange={(e) => setPosBuyEntry(e.target.value)}
                      placeholder={posBuyCur > 0 ? String(Math.round(posBuyCur)) : ''}
                      className="w-full rounded-sm bg-bg-primary px-2 py-1.5 text-sm text-t1 placeholder:text-t3 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <span className="w-8 shrink-0 text-t3">수량</span>
                    <input
                      type="number"
                      value={posBuyQty}
                      onChange={(e) => setPosBuyQty(e.target.value)}
                      className="w-full rounded-sm bg-bg-primary px-2 py-1.5 text-sm text-t1 focus:outline-none"
                    />
                  </label>
                  <div className="col-span-2 mt-0.5 text-xs text-t3">
                    매도 <span className="font-medium text-down">{posSellName}</span>
                  </div>
                  <label className="flex items-center gap-1 text-xs">
                    <span className="w-8 shrink-0 text-t3">진입가</span>
                    <input
                      type="number"
                      value={posSellEntry}
                      onChange={(e) => setPosSellEntry(e.target.value)}
                      placeholder={posSellCur > 0 ? String(Math.round(posSellCur)) : ''}
                      className="w-full rounded-sm bg-bg-primary px-2 py-1.5 text-sm text-t1 placeholder:text-t3 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs">
                    <span className="w-8 shrink-0 text-t3">수량</span>
                    <input
                      type="number"
                      value={posSellQty}
                      onChange={(e) => setPosSellQty(e.target.value)}
                      className="w-full rounded-sm bg-bg-primary px-2 py-1.5 text-sm text-t1 focus:outline-none"
                    />
                  </label>
                </div>
                {hasPos ? (
                  <div className="mt-2 border-t border-bg-primary pt-2 text-xs tabular-nums">
                    <div className="text-t3">
                      진입 시점:{' '}
                      <span className="text-t1">
                        z {posEntryZ >= 0 ? '+' : ''}
                        {posEntryZ.toFixed(2)}
                      </span>{' '}
                      · 이탈 {Math.round(posEntryDev).toLocaleString()}원 · 절대{' '}
                      {Math.round(posEntryAbs).toLocaleString()}원
                    </div>
                    <div className="mt-1 flex items-baseline gap-1">
                      <span className="text-t3">현재 평가손익</span>
                      <span
                        className={`text-base font-semibold ${posPnL >= 0 ? 'text-up' : 'text-down'}`}
                      >
                        {posPnL >= 0 ? '+' : ''}
                        {Math.round(posPnL).toLocaleString()}원
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 text-[11px] text-t3">
                    진입가·수량 입력 시 진입 z·베이시스와 현재 손익 표시
                  </div>
                )}
              </div>

              <div className="mt-2 text-xs leading-relaxed text-t3">
                실제 헤지 ={' '}
                <span className="text-t2">
                  right 1주 : left {Math.abs(dayStat.hedge_ratio).toFixed(2)}주
                </span>
                . 이 포지션 손익 = 베이시스 변화. β≈1(같은 지수 ETF 등)이면 ≈ 단순 가격차.
              </div>
            </div>
          )}
        </div>

        {/* 우측 — 차트 3개 vertical stack */}
        <div className="flex flex-col gap-1 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1">
            {useDaily ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-t3">차트</span>
                <ZViewSeg value={zViewEff} onChange={setZView} />
                <span className="text-[10px] text-t4">
                  {zViewEff === 'intraday'
                    ? '일봉 기준 z를 장중 실시간으로 (진입 타이밍)'
                    : '3년 일봉 종가 z (장기 맥락)'}
                </span>
              </div>
            ) : (
              <span />
            )}
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-t3">
              <input
                type="checkbox"
                checked={syncCharts}
                onChange={(e) => setSyncCharts(e.target.checked)}
                className="accent-accent"
              />
              가격·z 차트 동기화 (시간축 + 십자선)
            </label>
          </div>
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
                data={chartSeries}
                live={leftPrice > 0 && rightPrice > 0 ? { left: leftPrice, right: rightPrice } : null}
                register={registerLeg}
                daily={chartDaily}
              />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-t3">
              <span>스프레드 (%p)</span>
              <span className="flex items-center gap-1" title="right% − left% (1:1 단순 수익률 차이) — 직관적">
                <span className="inline-block h-1.5 w-3 rounded-sm bg-warning" />
                <span className="text-t2">수익률 차이 (A)</span>
              </span>
              <span className="flex items-center gap-1" title="잔차/right×100 (β-가중) — z 차트와 같은 거동">
                <span className="inline-block h-1.5 w-3 rounded-sm bg-t2" />
                <span className="text-t2">β스프레드 (B)</span>
              </span>
            </div>
            <div className="h-[260px]">
              <SpreadDualChart data={chartSeries} register={registerSpread} daily={chartDaily} />
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
                  <span className="text-t3"> / </span>
                  <span className="font-semibold text-down">숏 {signal.shortName}</span>
                  {signal.entry && <span className="ml-1 text-warning">· 진입권</span>}
                </span>
              )}
            </div>
            <div className="h-[260px]">
              <ZScoreChart
                data={chartSeries}
                live={liveZ}
                register={registerZ}
                daily={chartDaily}
              />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              잔차 분포 (σ 단위) · 평균 0 · ±1σ/±2σ · 현재 빨강
            </div>
            <div className="h-[260px]">
              <ResidualHistogram
                bins={headlineHist}
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
        stat={dayStat}
        lastPoint={headlineSeries[headlineSeries.length - 1]}
        basisLabel={basisLabel}
        hlTradingDays={hlTradingDays}
      />
    </div>
  )
}

/** 관계 안정성 (Kalman 시변 β 드리프트) 패널 — 항상 일봉 기준.
 *  정적 OLS β(3년 고정) vs Kalman 적응 β_t 비교로 "관계가 흔들리는지" 자동 감지. */
function RelationStabilityPanel({ k }: { k: KalmanStat }) {
  const driftPct = k.beta_drift_pct * 100
  const betaShaking = k.beta_drift_pct > 0.1
  const zStale = k.z_gap > 2.0
  const [showHelp, setShowHelp] = useState(false)

  // 판정 배지 톤
  const badge =
    k.stability === 'drift'
      ? { label: '드리프트', cls: 'bg-down/15 text-down' }
      : k.stability === 'caution'
      ? { label: '주의', cls: 'bg-warning/15 text-warning' }
      : { label: '안정', cls: 'bg-accent/15 text-accent' }

  // 경고 문구 — 어느 신호가 승격을 유발했는지에 맞춤
  let msg: string
  let msgCls: string
  if (k.stability === 'drift') {
    msgCls = 'text-down'
    msg = betaShaking
      ? `헤지비율 β가 최근 ${driftPct.toFixed(1)}% 변함 — 두 종목 관계가 구조적으로 흔들리는 중. 3년 평균 회귀 가정이 약화됐습니다. 진입 주의.`
      : `정적 z(${k.z_static.toFixed(2)})는 크지만 적응모델은 균형 근처(${k.z_adaptive.toFixed(2)})로 봅니다 — 관계가 최근 재레벨링됨. 3년 평균 회귀 가정이 약화됐습니다. 진입 주의.`
  } else if (k.stability === 'caution') {
    msgCls = 'text-warning'
    msg = betaShaking
      ? `헤지비율 β가 최근 ${driftPct.toFixed(1)}% 변함 — 관계 기울기가 서서히 바뀌는 중. 헤지비율·포지션 사이즈 재점검 권장.`
      : `정적 z와 적응 z 괴리(${k.z_gap.toFixed(2)}) — 3년 평균 대비 현재 편차가 다소 stale. 진입 신중.`
  } else {
    msgCls = 'text-t3'
    msg = zStale
      ? '헤지비율 β 안정. 다만 스프레드 레벨은 다소 이동 — 대체로 평균 회귀 가정 유효.'
      : 'β·스프레드 관계가 안정적. 평균 회귀 가정 유효.'
  }

  return (
    <div className="panel p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-t1">관계 안정성</span>
        <span className="text-[10px] text-t3">β 드리프트 · 일봉 기준</span>
        <button
          onClick={() => setShowHelp((v) => !v)}
          className={`ml-auto rounded-sm px-1.5 py-0.5 text-[11px] ${
            showHelp ? 'bg-blue/20 text-blue' : 'bg-bg-surface text-t3 hover:text-t1'
          }`}
          title="이 패널 읽는 법"
        >
          설명 {showHelp ? '▴' : '▾'}
        </button>
        <span className={`rounded-sm px-1.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      <div className="space-y-1.5 tabular-nums">
        <div className="flex items-baseline justify-between">
          <span
            className="cursor-help text-t3 underline decoration-t4 decoration-dotted underline-offset-2"
            title="정적 β = 3년 전체로 구한 고정 헤지비율. 현재 β = Kalman이 최근까지 갱신한 헤지비율. 드리프트 = 둘의 차이(관계 비율이 얼마나 변했나). 10%↑ 주의 · 20%↑ 드리프트."
          >
            정적 β → 현재 β
          </span>
          <span className="text-t1">
            {k.beta_static.toFixed(4)} <span className="text-t3">→</span> {k.beta_current.toFixed(4)}{' '}
            <span
              className={
                betaShaking ? (k.beta_drift_pct > 0.2 ? 'text-down' : 'text-warning') : 'text-t3'
              }
            >
              (드리프트 {driftPct.toFixed(1)}%)
            </span>
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span
            className="cursor-help text-t3 underline decoration-t4 decoration-dotted underline-offset-2"
            title="정적 z = 3년 고정선 대비 현재 편차. 적응 z = 최근 갱신선 대비 현재 편차. 괴리 = 둘의 차이(스프레드 레벨이 재정착했나). 2.0↑ 주의 · 3.0↑ 드리프트."
          >
            정적 z vs 적응 z
          </span>
          <span className="text-t1">
            {k.z_static >= 0 ? '+' : ''}
            {k.z_static.toFixed(2)} <span className="text-t3">vs</span>{' '}
            {k.z_adaptive >= 0 ? '+' : ''}
            {k.z_adaptive.toFixed(2)}{' '}
            <span className={zStale ? 'text-warning' : 'text-t3'}>(괴리 {k.z_gap.toFixed(2)})</span>
          </span>
        </div>
      </div>

      {/* β_t 스파크라인 — 정적 β 기준선(점선) 대비 적응 β 추이 */}
      {k.beta_series.length >= 2 && (
        <div className="mt-2">
          <BetaSparkline series={k.beta_series} betaStatic={k.beta_static} stability={k.stability} />
        </div>
      )}

      <div className={`mt-2 leading-relaxed ${msgCls}`}>{msg}</div>
      <div className="mt-1.5 leading-relaxed text-t4">
        β = 두 종목의 헤지비율. 최근 β가 얼마나 변했나 = 관계가 흔들리는지. 적응 z = 관계 변화를 반영한
        현재 편차 (정적 z와 크게 다르면 3년 평균 신호가 stale).
      </div>

      {showHelp && (
        <div className="mt-2.5 space-y-2.5 rounded-sm bg-bg-base/60 p-2.5 text-[11px] leading-relaxed">
          {/* ① 두 잣대 */}
          <div>
            <div className="mb-1 font-medium text-t2">① 두 개의 잣대</div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-sm bg-bg-surface p-1.5">
                <div className="font-medium text-t1">정적</div>
                <div className="text-t3">
                  3년 전체를 <span className="text-t2">고정된 자</span> 하나로 측정
                </div>
                <div className="text-t4">= 내 3년 평균 체중</div>
              </div>
              <div className="rounded-sm bg-bg-surface p-1.5">
                <div className="font-medium text-t1">적응</div>
                <div className="text-t3">
                  최근까지 <span className="text-t2">계속 갱신</span>하는 자로 측정
                </div>
                <div className="text-t4">= 요즘 몇 주 체중</div>
              </div>
            </div>
          </div>

          {/* ② 배지 기준표 */}
          <div>
            <div className="mb-1 font-medium text-t2">
              ② 배지 판정 기준 <span className="text-t4">(둘 중 나쁜 쪽으로 결정)</span>
            </div>
            <div className="overflow-hidden rounded-sm border border-bg-surface">
              <table className="w-full text-[11px] tabular-nums">
                <thead className="bg-bg-surface">
                  <tr>
                    <th className="px-1.5 py-1 text-left font-normal text-t3">지표</th>
                    <th className="px-1.5 py-1 text-center font-normal text-accent">안정</th>
                    <th className="px-1.5 py-1 text-center font-normal text-warning">주의</th>
                    <th className="px-1.5 py-1 text-center font-normal text-down">드리프트</th>
                  </tr>
                </thead>
                <tbody className="text-t2">
                  <tr className="border-t border-bg-surface">
                    <td className="px-1.5 py-1">
                      β 드리프트 <span className="text-t4">(비율 변화)</span>
                    </td>
                    <td className="px-1.5 py-1 text-center">≤10%</td>
                    <td className="px-1.5 py-1 text-center">10~20%</td>
                    <td className="px-1.5 py-1 text-center">&gt;20%</td>
                  </tr>
                  <tr className="border-t border-bg-surface">
                    <td className="px-1.5 py-1">
                      z 괴리 <span className="text-t4">(레벨 재정착)</span>
                    </td>
                    <td className="px-1.5 py-1 text-center">≤2.0</td>
                    <td className="px-1.5 py-1 text-center">2.0~3.0</td>
                    <td className="px-1.5 py-1 text-center">&gt;3.0</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* ③ 판정 읽는 법 */}
          <div>
            <div className="mb-1 font-medium text-t2">③ 판정 읽는 법</div>
            <ul className="space-y-1">
              <li className="flex gap-1.5">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span className="text-t3">
                  <span className="text-accent">안정</span> — 관계 튼튼 + 정적·적응 z 동의 →{' '}
                  <span className="text-t2">진짜 회귀 기회</span>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-warning" />
                <span className="text-t3">
                  <span className="text-warning">주의</span> — 관계가 약간 흔들림 →{' '}
                  <span className="text-t2">다른 지표 더 확인</span>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-down" />
                <span className="text-t3">
                  <span className="text-down">드리프트</span> — 관계 재정착 중 →{' '}
                  <span className="text-t2">z 커도 진입 보류</span>
                </span>
              </li>
            </ul>
          </div>

          {/* ④ 활용 */}
          <div className="rounded-sm bg-accent/10 px-2 py-1.5 text-t2">
            💡 메인 화면 z가 커도, 이 배지가 <span className="font-medium text-accent">안정</span>일 때만
            믿고 진입하세요.
          </div>
        </div>
      )}
    </div>
  )
}

/** β_t 스파크라인 — 순수 SVG (차트 라이브러리 불필요). 정적 β는 점선 기준선. */
function BetaSparkline({
  series,
  betaStatic,
  stability,
}: {
  series: { ts: number; beta: number }[]
  betaStatic: number
  stability: KalmanStat['stability']
}) {
  const W = 100
  const H = 28
  const betas = series.map((p) => p.beta)
  let lo = Math.min(...betas, betaStatic)
  let hi = Math.max(...betas, betaStatic)
  if (hi - lo < 1e-9) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.12
  lo -= pad
  hi += pad
  const n = series.length
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * W)
  const y = (b: number) => H - ((b - lo) / (hi - lo)) * H
  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(p.beta).toFixed(2)}`).join(' ')
  const yStatic = y(betaStatic)
  const stroke =
    stability === 'drift' ? 'var(--color-down)' : stability === 'caution' ? 'var(--color-warning)' : 'var(--color-accent)'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-7 w-full">
      {/* 정적 β 기준선 */}
      <line x1={0} y1={yStatic} x2={W} y2={yStatic} stroke="var(--color-t4)" strokeWidth={0.5} strokeDasharray="2 2" />
      {/* 적응 β_t */}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
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

/** 선정 근거 게이트 한 줄 — 통과 ✓ / 미달 ✗ + 실제 값. */
function GateRow({ ok, label, val }: { ok: boolean; label: string; val: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-t2">
        <span className={ok ? 'text-up' : 'text-down'}>{ok ? '✓' : '✗'}</span> {label}
      </span>
      <span className="tabular-nums text-t1">{val}</span>
    </li>
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
        <span className="text-t3">{code}</span>
        {hasChange && (
          <span className={chgCls}>
            {chgPct > 0 ? '▲' : chgPct < 0 ? '▼' : ''} {Math.abs(chgPct).toFixed(2)}%
          </span>
        )}
      </div>
    </div>
  )
}
