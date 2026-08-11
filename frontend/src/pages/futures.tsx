import { useEffect, useMemo, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'
import { BasisChart, DepthChart, OiChart, type IntervalMin } from '@/components/futures/charts'
import {
  sessionRange,
  type DepthPoint,
  type LiveDepthPoint,
} from '@/components/futures/session'
import type { IndexFuturesProduct, IndexFuturesTick } from '@/types/market'

/**
 * /futures — 지수선물 총잔량(호가 잔량) 모니터.
 *
 * 코스피200·코스닥150 지수선물의 **매도총잔량 / 매수총잔량 / 비율(매수÷매도)** 을 실시간으로
 * 보고, 당일(개장~현재) 비율 추이를 선물가·구간 거래량과 겹쳐 본다. 비율 > 1이면 매수잔량이
 * 두꺼운 것(=매수 대기 우위), < 1이면 매도 우위.
 *
 * 데이터 경로:
 *   · 히스토리 — `GET /realtime/futures/depth-history`. Rust realtime(8200)이 FH9를 **상시**
 *     구독해 10초 간격으로 서버측에 쌓아둔 당일 시계열. 브라우저를 껐다 켜도 개장부터 보인다.
 *   · 실시간   — WS `index_futures_depth` (product별 500ms throttle) + 기존 `index_futures_tick`
 *     (현재가·등락·누적거래량). 서버 상시 구독이라 페이지별 구독 훅이 필요 없다.
 *
 * 탭이 백그라운드로 내려가면 rAF flush가 늦어져 라이브 점에 구멍이 생길 수 있으므로,
 * 다시 보일 때 히스토리를 재시딩한다.
 */

const PRODUCTS: { id: IndexFuturesProduct; label: string }[] = [
  { id: 'kospi200', label: '코스피200 선물' },
  { id: 'kosdaq150', label: '코스닥150 선물' },
]

/** 서버 샘플 주기와 동일 — 라이브 점을 이 버킷으로 묶어 append (틱 폭주 방지). */
const BUCKET_SEC = 10

/** 집계 단위 선택지 (분). 0 = 틱(10초 샘플 라인). */
const INTERVAL_OPTIONS: IntervalMin[] = [0, 1, 5, 10, 15, 30, 60]

type DepthHistory = {
  date: string
  products: Partial<Record<IndexFuturesProduct, { code: string; points: DepthPoint[] }>>
}

type LoadState = 'loading' | 'ok' | 'error'

/** 아직 서버 샘플이 하나도 없는 상태인가 (개장 직후·장 시작 전). */
const isEmpty = (h: DepthHistory | null) =>
  !h || PRODUCTS.every((p) => !h.products?.[p.id]?.points?.length)

/**
 * 장중인데 **오늘 세션(09:00~15:45) 안의 표본이 하나도 없는** 히스토리인가.
 * 개장 전 진입(WarmUp 표본만) 또는 서버가 아직 날짜 롤오버 전(어제 데이터)인 경우 —
 * 이대로 두면 세션 고정 축이 안 걸린 채 굳으므로 30초 재조회 대상에 넣는다.
 * 장외(mock 저녁 등)에는 false — 30초마다 재시딩돼 차트가 재생성되는 것 방지.
 * 세션 기준은 h.date가 아니라 **오늘**(sessionRange('') 폴백 = 오늘 KST).
 */
const missesTodaySession = (h: DepthHistory | null) => {
  if (!h || isEmpty(h)) return false // 빈 히스토리는 기존 isEmpty 조건이 처리
  const { from, to } = sessionRange('')
  const nowSec = Date.now() / 1000
  if (nowSec < from || nowSec > to) return false
  return PRODUCTS.every(
    (p) => !(h.products?.[p.id]?.points ?? []).some((q) => q.t >= from && q.t <= to),
  )
}

export function FuturesPage() {
  const [history, setHistory] = useState<DepthHistory | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  /** 빈 상태일 때만 도는 재시도 카운터 — 첫 샘플이 잡히면 멈춘다. */
  const [retry, setRetry] = useState(0)
  /** 집계 단위 — 두 차트 공통. 0 = 틱(10초 샘플 라인), 그 외는 N분봉 캔들. */
  const [intervalMin, setIntervalMin] = useState<IntervalMin>(0)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetch('/realtime/futures/depth-history')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: DepthHistory) => {
          if (!alive) return
          setHistory(d)
          setStatus('ok')
        })
        .catch(() => {
          if (!alive) return
          setStatus('error')
        })
    }
    load()
    // 백그라운드 탭 복귀 시 재시딩 — 그 사이 놓친 라이브 구간을 서버 샘플로 메움
    // (탭이 숨으면 rAF flush가 멈춰 WS append에 구멍이 생긴다).
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [retry])

  // 30초 재조회가 필요한 세 경우:
  //  · 히스토리가 아직 비어 있음 (개장 직전 진입 등) — 첫 샘플이 쌓이는 즉시 차트 등장
  //  · 마지막 조회가 실패 — 이미 그려둔 차트는 그대로 두고 백그라운드로 복구 시도
  //  · 장중인데 오늘 세션 표본이 없음 (개장 전 진입·서버 날짜 롤오버 전) — 세션 고정 축 진입용
  useEffect(() => {
    if (status === 'loading') return
    if (status === 'ok' && !isEmpty(history) && !missesTodaySession(history)) return
    const id = setTimeout(() => setRetry((n) => n + 1), 30_000)
    return () => clearTimeout(id)
    // retry 포함: 연속 실패 시 status/history가 그대로라도 매 시도마다 타이머를 다시 건다
  }, [status, history, retry])

  return (
    <div className="flex flex-col gap-1 p-1">
      <div className="bg-bg-primary px-3 py-2 flex items-baseline justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">지수선물 총잔량</div>
          <div className="text-[11px] text-t3">
            매수÷매도 비율 — 1.0 위면 매수잔량 우위, 아래면 매도잔량 우위. 서버가 10초 간격으로
            당일 전 구간을 보관한다.
          </div>
        </div>
        {/* 재조회 실패는 배지로만 — 이미 그려진 차트를 에러 문구로 대체하지 않는다
            (실시간 append는 WS라 계속 살아있고, 30초 뒤 자동 재시도한다). */}
        <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
          {status === 'error' && (
            <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-warning">
              히스토리 재조회 실패 — 재시도 중
            </span>
          )}
          <span className="text-t4">{history?.date ? kstDateLabel(history.date) : ''}</span>
          <IntervalSeg value={intervalMin} onChange={setIntervalMin} />
        </div>
      </div>

      {PRODUCTS.map((p) => (
        <ProductSection
          key={p.id}
          product={p.id}
          label={p.label}
          series={history?.products?.[p.id] ?? null}
          status={status}
          date={history?.date ?? ''}
          intervalMin={intervalMin}
        />
      ))}
    </div>
  )
}

/** 집계 단위 토글 — 두 차트 공통. stat-arb Seg와 같은 톤(고밀도 세그먼트). */
function IntervalSeg({
  value,
  onChange,
}: {
  value: IntervalMin
  onChange: (v: IntervalMin) => void
}) {
  return (
    <div className="flex overflow-hidden rounded-sm bg-bg-surface">
      {INTERVAL_OPTIONS.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={v === 0 ? '10초 샘플 원본 (라인)' : `${v}분봉 캔들 (10초 샘플 집계)`}
          className={cn(
            'px-2 py-1 text-[11px] tabular-nums',
            value === v ? 'bg-accent/25 text-accent' : 'text-t3 hover:text-t1',
          )}
        >
          {v === 0 ? '틱' : v}
        </button>
      ))}
    </div>
  )
}

function ProductSection({
  product,
  label,
  series,
  status,
  date,
  intervalMin,
}: {
  product: IndexFuturesProduct
  label: string
  series: { code: string; points: DepthPoint[] } | null
  status: LoadState
  date: string
  intervalMin: IntervalMin
}) {
  const depth = useMarketStore((s) => s.indexFuturesDepth[product])
  const indexTicks = useMarketStore((s) => s.indexFuturesTicks)
  // 지수선물은 상품당 근월물 1개 — code로 키잉된 맵에서 product로 역인덱싱 (엔트리 3개).
  const tick = useMemo<IndexFuturesTick | undefined>(
    () => Object.values(indexTicks).find((t) => t.product === product),
    [indexTicks, product],
  )

  const code = depth?.code ?? tick?.code ?? series?.code ?? ''
  const ratio = depth && depth.total_ask_qty > 0 ? depth.total_bid_qty / depth.total_ask_qty : null

  // 라이브 점 — 10초 버킷 + 총잔량/가격/누적거래량/OI/기초지수/이론가 스냅샷.
  // 히스토리 포인트와 같은 모양이라 메인·미니 차트가 그대로 공유한다.
  const live = useMemo<LiveDepthPoint | null>(() => {
    if (!depth) return null
    return {
      t: Math.floor(depth.time_ms / 1000 / BUCKET_SEC) * BUCKET_SEC,
      a: depth.total_ask_qty,
      b: depth.total_bid_qty,
      p: tick?.price ?? 0,
      v: tick?.volume ?? 0,
      oi: tick?.open_interest ?? 0,
      u: tick?.underlying_index ?? 0,
      th: tick?.theory_price ?? 0,
    }
  }, [depth, tick?.price, tick?.volume, tick?.open_interest, tick?.underlying_index, tick?.theory_price])

  // useMemo — `?? []`를 인라인으로 두면 매 렌더 새 배열이라 차트 재생성·통계 재계산이 헛돈다.
  const points = useMemo(() => series?.points ?? [], [series])
  // 한 번이라도 시딩됐으면 차트 유지 — 이후 재조회가 실패해도 실시간 append는 계속된다.
  const hasChart = points.length > 0
  const stats = useRatioStats(points, date, ratio)
  // 하단 미니 차트에 그릴 값이 히스토리에 있는지 (0 = 미상).
  const avail = useMemo(
    () => ({ oi: points.some((p) => p.oi > 0), basis: points.some((p) => p.u > 0) }),
    [points],
  )

  const empty = (
    <div className="flex h-full items-center justify-center text-[12px] text-t4">
      {status === 'loading'
        ? '히스토리 로딩 중…'
        : status === 'error'
          ? '히스토리를 불러오지 못했습니다 (realtime 8200 확인) — 30초 뒤 재시도'
          : '데이터 없음 — 장 시작 후 총잔량 샘플이 쌓이면 표시됩니다'}
    </div>
  )

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-1 lg:flex-row">
        <DepthCard label={label} code={code} tick={tick} depth={depth} ratio={ratio} stats={stats} />
        <div className="panel min-w-0 flex-1" style={{ height: 300 }}>
          {hasChart ? (
            <DepthChart points={points} live={live} date={date} intervalMin={intervalMin} />
          ) : (
            empty
          )}
        </div>
      </div>
      {/* 하단 미니 — 미결제약정 / 베이시스. 메인과 같은 09:00~15:45 고정 축.
          OI·기초지수는 나중에 추가된 샘플 필드라 그 이전 구간은 0(미상) → 값이 하나도 없으면
          차트 대신 안내를 띄운다. */}
      {hasChart && (
        <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
          <MiniPanel title="미결제약정" legend={[['OI', '#0a84ff']]}>
            {avail.oi || (live?.oi ?? 0) > 0 ? (
              <OiChart points={points} live={live} date={date} />
            ) : (
              <MiniEmpty />
            )}
          </MiniPanel>
          <MiniPanel
            title="베이시스 (선물 − 기초지수)"
            legend={[
              ['시장', '#34c759'],
              ['이론', '#ff9f0a'],
            ]}
          >
            {avail.basis || (live?.u ?? 0) > 0 ? (
              <BasisChart points={points} live={live} date={date} />
            ) : (
              <MiniEmpty />
            )}
          </MiniPanel>
        </div>
      )}
    </div>
  )
}

/** 미니 차트 패널 — 제목 + 범례 한 줄 + 차트. 높이는 메인(300)보다 낮게. */
function MiniPanel({
  title,
  legend,
  children,
}: {
  title: string
  legend: [string, string][]
  children: React.ReactNode
}) {
  return (
    <div className="panel flex min-w-0 flex-col" style={{ height: 150 }}>
      <div className="flex items-center gap-3 px-2 pt-1.5 text-[11px]">
        <span className="text-t2">{title}</span>
        {legend.map(([label, color]) => (
          <span key={label} className="flex items-center gap-1 text-t4">
            <span className="h-[2px] w-3" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

function MiniEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-t4">
      수집 대기 — 당일 표본 없음
    </div>
  )
}

/** 당일 비율 통계 — 세션 내 유효 샘플(매도잔량>0)만. 차트와 같은 제외 규칙. */
type RatioStats = {
  n: number
  min: number
  max: number
  mean: number
  /** 현재 비율의 당일 분포 percentile (0~100). 현재값 없으면 null. */
  pct: number | null
  /** 1.0 초과 샘플 비중(%) — 샘플 간격이 균일해 시간 비중과 같다. */
  aboveOne: number
}

function useRatioStats(points: DepthPoint[], date: string, current: number | null): RatioStats | null {
  return useMemo(() => {
    const { from, to } = sessionRange(date)
    const inSession = points.filter((p) => p.t >= from && p.t <= to)
    const src = inSession.length ? inSession : points
    const rs: number[] = []
    for (const p of src) if (p.a > 0) rs.push(p.b / p.a)
    if (!rs.length) return null
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let above = 0
    for (const r of rs) {
      sum += r
      if (r < min) min = r
      if (r > max) max = r
      if (r > 1) above++
    }
    let pct: number | null = null
    if (current != null) {
      // 분포 대비 현재 위치 — 정렬 없이 1패스 카운트 (당일 최대 2,400점).
      let le = 0
      for (const r of rs) if (r <= current) le++
      pct = (le / rs.length) * 100
    }
    return { n: rs.length, min, max, mean: sum / rs.length, pct, aboveOne: (above / rs.length) * 100 }
  }, [points, date, current])
}

function DepthCard({
  label,
  code,
  tick,
  depth,
  ratio,
  stats,
}: {
  label: string
  code: string
  tick: IndexFuturesTick | undefined
  depth: { total_ask_qty: number; total_bid_qty: number; time_ms: number } | undefined
  ratio: number | null
  stats: RatioStats | null
}) {
  const chg = tick?.change ?? 0
  const chgColor = chg > 0 ? 'text-up' : chg < 0 ? 'text-down' : 'text-t3'
  const ratioColor = ratio == null ? 'text-t4' : ratio > 1 ? 'text-up' : ratio < 1 ? 'text-down' : 'text-t2'
  const total = depth ? depth.total_ask_qty + depth.total_bid_qty : 0
  const bidPct = total > 0 && depth ? (depth.total_bid_qty / total) * 100 : 50

  return (
    <div className="panel w-full shrink-0 p-3 lg:w-[300px]">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-t1">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-t4">{code || '-'}</span>
      </div>

      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-[22px] font-semibold tabular-nums text-t1">
          {tick ? tick.price.toFixed(2) : '-'}
        </span>
        <span className={cn('font-mono text-[12px] tabular-nums', chgColor)}>
          {tick ? `${chg > 0 ? '+' : ''}${chg.toFixed(2)} (${chg > 0 ? '+' : ''}${tick.change_rate.toFixed(2)}%)` : ''}
        </span>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-[11px] text-t3">비율 (매수÷매도)</span>
        <span className={cn('font-mono text-[24px] font-semibold tabular-nums', ratioColor)}>
          {ratio == null ? '-' : ratio.toFixed(3)}
        </span>
      </div>

      {/* 잔량 분포 바 — 초록(매수) : 빨강(매도) 비중 + 숫자를 한 덩어리로.
          숫자는 세그먼트 안이 아니라 **바 위 좌/우 고정 오버레이**라 한쪽이 극단적으로
          좁아져도 잘리지 않는다 (truncate 정보손실 금지). */}
      <div className="relative mt-1.5 h-7 w-full overflow-hidden rounded-sm bg-bg-surface">
        <div className="flex h-full w-full">
          <div className="bg-up/30" style={{ width: `${bidPct}%` }} />
          <div className="flex-1 bg-down/30" />
        </div>
        <div className="absolute inset-0 flex items-center justify-between gap-2 px-2 text-[10px]">
          <span className="flex items-baseline gap-1 whitespace-nowrap">
            <span className="text-t3">매수</span>
            <span className="font-mono text-[12px] font-medium tabular-nums text-up">
              {depth ? depth.total_bid_qty.toLocaleString() : '-'}
            </span>
          </span>
          <span className="flex items-baseline gap-1 whitespace-nowrap">
            <span className="font-mono text-[12px] font-medium tabular-nums text-down">
              {depth ? depth.total_ask_qty.toLocaleString() : '-'}
            </span>
            <span className="text-t3">매도</span>
          </span>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <span className="text-t3">미결제약정</span>
        <span className="text-right font-mono tabular-nums text-t2">
          {tick?.open_interest ? tick.open_interest.toLocaleString() : '-'}
        </span>
        <span className="text-t3">베이시스 (이론)</span>
        <span className="text-right font-mono tabular-nums text-t2">
          {tick && tick.underlying_index > 0
            ? `${signed(tick.price - tick.underlying_index)}${
                tick.theory_price ? ` (${signed(tick.theory_price - tick.underlying_index)})` : ''
              }`
            : '-'}
        </span>
        <span className="text-t3">누적 거래량</span>
        <span className="text-right font-mono tabular-nums text-t2">
          {tick ? tick.volume.toLocaleString() : '-'}
        </span>
        <span className="text-t3">갱신</span>
        <span className="text-right font-mono tabular-nums text-t4">
          {depth ? hhmmss(depth.time_ms) : '수신 대기'}
        </span>
      </div>

      {/* 당일 비율 통계 — 지금 값이 오늘 분포에서 어디쯤인지 (클라이언트 계산) */}
      <div className="mt-2 border-t border-bg-surface pt-2">
        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-t3">당일 분포 위치</span>
          <span className="font-mono tabular-nums text-t2">
            {stats?.pct == null ? '-' : `${stats.pct.toFixed(0)}%ile`}
          </span>
        </div>
        {/* 미니 게이지 — 저(좌)~고(우) 중 현재 위치 */}
        <div className="relative mt-1 h-1 w-full rounded-sm bg-bg-surface">
          {stats?.pct != null && (
            <span
              className="absolute top-1/2 h-2.5 w-[2px] -translate-y-1/2 bg-accent"
              style={{ left: `calc(${Math.min(100, Math.max(0, stats.pct))}% - 1px)` }}
            />
          )}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <span className="text-t3">당일 고 / 저</span>
          <span className="text-right font-mono tabular-nums text-t2">
            {stats ? `${stats.max.toFixed(3)} / ${stats.min.toFixed(3)}` : '-'}
          </span>
          <span className="text-t3">평균</span>
          <span className="text-right font-mono tabular-nums text-t2">
            {stats ? stats.mean.toFixed(3) : '-'}
          </span>
          <span className="text-t3">1.0 상회 비중</span>
          <span className="text-right font-mono tabular-nums text-t2">
            {stats ? `${stats.aboveOne.toFixed(0)}% · n${stats.n}` : '-'}
          </span>
        </div>
      </div>
    </div>
  )
}

/** 부호 붙은 소수 2자리 (베이시스 표기) */
function signed(v: number) {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`
}

/** YYYYMMDD → "YYYY-MM-DD 기준" */
function kstDateLabel(d: string) {
  if (d.length !== 8) return d
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} 기준`
}

function hhmmss(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
