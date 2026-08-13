import { useEffect, useMemo, useState } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'
import { BasisChart, DepthChart, type IntervalMin } from '@/components/futures/charts'
import {
  MA_COLOR,
  fmtRatio,
  kstHms,
  ratioValue,
  sessionRange,
  type DepthPoint,
  type LiveDepthPoint,
  type MaMin,
} from '@/components/futures/session'
import type { IndexFuturesProduct, IndexFuturesTick } from '@/types/market'

/**
 * /futures — 지수선물 총잔량(호가 잔량) 모니터.
 *
 * 코스피200·코스닥150 지수선물의 **매도총잔량 / 매수총잔량 / 비율**을 실시간으로 보고,
 * 당일(개장~현재) 비율 추이를 선물가·구간 거래량과 겹쳐 본다. 비율 표기는 **부호 스케일**
 * (+1.24 = 매수잔량 1.24배 / −1.35 = 매도잔량 1.35배, 균형 1.00) — 정의는 session.ts `ratioValue`.
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
const INTERVAL_OPTIONS: IntervalMin[] = [0, 1, 3, 5, 10, 15, 30, 60]
/** 비율 이동평균 선택지 (분). 10초 샘플 기준 시간창 트레일링 평균. */
const MA_OPTIONS: MaMin[] = [5, 15, 60]

/** MA 창 충족 상태 — ready=false면 켜져 있어도 아직 안 그려진다(창 축적 중). */
type MaStatus = Record<MaMin, { ready: boolean; at: string }>

/** 차트 표시 선호 — 상사 배포 대비 localStorage 유지. */
type ChartPrefs = { intervalMin: IntervalMin; ratioCandle: boolean; mas: MaMin[] }
const PREFS_KEY = 'lens.futures.chart'
const DEFAULT_PREFS: ChartPrefs = { intervalMin: 0, ratioCandle: false, mas: [5, 15, 60] }

function loadPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const v = JSON.parse(raw) as Partial<ChartPrefs>
    return {
      intervalMin: INTERVAL_OPTIONS.includes(v.intervalMin as IntervalMin)
        ? (v.intervalMin as IntervalMin)
        : DEFAULT_PREFS.intervalMin,
      ratioCandle: v.ratioCandle === true,
      // 순서를 MA_OPTIONS로 정규화 — 저장값이 뒤섞여도 색·범례가 흔들리지 않게.
      mas: Array.isArray(v.mas) ? MA_OPTIONS.filter((m) => v.mas?.includes(m)) : DEFAULT_PREFS.mas,
    }
  } catch {
    return DEFAULT_PREFS
  }
}

type DepthHistory = {
  date: string
  products: Partial<Record<IndexFuturesProduct, { code: string; points: DepthPoint[] }>>
}

type LoadState = 'loading' | 'ok' | 'error'

/** 아직 서버 샘플이 하나도 없는 상태인가 (개장 직후·장 시작 전). */
const isEmpty = (h: DepthHistory | null) =>
  !h || PRODUCTS.every((p) => !h.products?.[p.id]?.points?.length)

/**
 * 장중인데 **오늘 세션(08:45~15:45) 안의 표본이 하나도 없는** 히스토리인가.
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
  /** 10초 버킷 시계 — MA 창 충족 판정용. 라이브 틱에서 파생(렌더 중 Date.now() 호출 금지). */
  const nowSec = useMarketStore((s) => {
    const d = s.indexFuturesDepth.kospi200 ?? s.indexFuturesDepth.kosdaq150
    return d ? Math.floor(d.time_ms / 10_000) * 10 : 0
  })
  /** 표시 선호(집계 단위·비율 캔들·MA) — 두 상품 차트 공통, localStorage 유지. */
  const [prefs, setPrefs] = useState<ChartPrefs>(loadPrefs)
  const { intervalMin, ratioCandle, mas } = prefs
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* 사파리 프라이빗 등 — 저장 실패해도 화면은 정상 동작 */
    }
  }, [prefs])

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

  // MA 창 충족 상태 — 개장 직후엔 창이 안 차서 켜도 안 그려진다(예: 60분선은 09:45부터).
  // 칩이 "무반응"으로 보이지 않게 대기 상태와 표시 시각을 컨트롤에 넘긴다.
  const maStatus = useMemo<MaStatus | null>(() => {
    const { from, to } = sessionRange(history?.date ?? '')
    let first = Infinity
    let last = 0
    for (const p of PRODUCTS) {
      for (const q of history?.products?.[p.id]?.points ?? []) {
        if (q.t < from || q.t > to || q.a <= 0) continue
        if (q.t < first) first = q.t
        if (q.t > last) last = q.t
      }
    }
    if (!Number.isFinite(first)) return null
    const now = Math.max(last, nowSec >= from && nowSec <= to ? nowSec : 0)
    return Object.fromEntries(
      MA_OPTIONS.map((m) => [m, { ready: now - first >= m * 60, at: kstHms(first + m * 60).hm }]),
    ) as MaStatus
  }, [history, nowSec])

  return (
    <div className="flex flex-col gap-1 p-1">
      <div className="bg-bg-primary px-3 py-2 flex items-baseline justify-between">
        <div className="text-[13px] text-t2 font-medium">지수선물 총잔량</div>
        {/* 재조회 실패는 배지로만 — 이미 그려진 차트를 에러 문구로 대체하지 않는다
            (실시간 append는 WS라 계속 살아있고, 30초 뒤 자동 재시도한다). */}
        <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums">
          {status === 'error' && (
            <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-warning">
              히스토리 재조회 실패 — 재시도 중
            </span>
          )}
          <span className="text-t4">{history?.date ? kstDateLabel(history.date) : ''}</span>
          <ControlStrip prefs={prefs} onChange={setPrefs} maStatus={maStatus} />
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
          ratioCandle={ratioCandle}
          mas={mas}
        />
      ))}

      {/* 베이시스 — 두 상품을 한 행에 나란히 (스케일이 달라 한 차트로 합치지 않는다) */}
      <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
        {PRODUCTS.map((p) => (
          <BasisPanel
            key={p.id}
            product={p.id}
            label={p.label}
            series={history?.products?.[p.id] ?? null}
            date={history?.date ?? ''}
          />
        ))}
      </div>
    </div>
  )
}

/** 차트 컨트롤 한 줄 — 집계 단위 / 비율 표시 / 비율 MA. stat-arb Seg와 같은 톤(고밀도 세그먼트). */
function ControlStrip({
  prefs,
  onChange,
  maStatus,
}: {
  prefs: ChartPrefs
  onChange: (p: ChartPrefs) => void
  maStatus: MaStatus | null
}) {
  const { intervalMin, ratioCandle, mas } = prefs
  const tickMode = intervalMin === 0
  const toggleMa = (m: MaMin) =>
    onChange({
      ...prefs,
      // MA_OPTIONS 순서 유지 — 색·범례가 선택 순서에 흔들리지 않게.
      mas: MA_OPTIONS.filter((x) => (x === m ? !mas.includes(m) : mas.includes(x))),
    })
  return (
    <div className="flex items-center gap-2">
      <div className="flex overflow-hidden rounded-sm bg-bg-surface">
        {INTERVAL_OPTIONS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange({ ...prefs, intervalMin: v })}
            title={v === 0 ? '10초 샘플 원본 (라인)' : `${v}분봉 캔들 (10초 샘플 집계)`}
            className={cn(
              'px-2 py-1 text-[11px] tabular-nums',
              intervalMin === v ? 'bg-accent/25 text-accent' : 'text-t3 hover:text-t1',
            )}
          >
            {v === 0 ? '틱' : v}
          </button>
        ))}
      </div>

      {/* 비율 표시 — 틱 모드는 버킷당 표본 1개라 캔들이 무의미해 비활성 */}
      <span className="text-t4">비율</span>
      <div className={cn('flex overflow-hidden rounded-sm bg-bg-surface', tickMode && 'opacity-40')}>
        {([false, true] as const).map((v) => (
          <button
            key={String(v)}
            type="button"
            disabled={tickMode}
            onClick={() => onChange({ ...prefs, ratioCandle: v })}
            title={tickMode ? '분봉 모드에서만 선택 가능' : v ? '버킷 내 비율 OHLC 캔들' : '버킷 종가 라인'}
            className={cn(
              'px-2 py-1 text-[11px]',
              !tickMode && ratioCandle === v ? 'bg-accent/25 text-accent' : 'text-t3',
              !tickMode && 'hover:text-t1',
              tickMode && 'cursor-not-allowed',
            )}
          >
            {v ? '캔들' : '라인'}
          </button>
        ))}
      </div>

      {/* 비율 이동평균 — 다중 선택(0~3개) */}
      <span className="text-t4">MA</span>
      <div className="flex gap-1">
        {MA_OPTIONS.map((m) => {
          const on = mas.includes(m)
          const st = maStatus?.[m]
          // 켜져 있는데 창이 아직 안 찼으면 "대기" — 흐리게 + 표시 예정 시각 툴팁.
          const waiting = on && st != null && !st.ready
          return (
            <button
              key={m}
              type="button"
              onClick={() => toggleMa(m)}
              title={
                waiting
                  ? `비율 ${m}분 이동평균 — 창 축적 중, ${st.at}부터 표시`
                  : `비율 ${m}분 이동평균 (10초 샘플 시간창)`
              }
              className={cn(
                'flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] tabular-nums',
                on ? 'bg-bg-surface text-t1' : 'bg-bg-surface/50 text-t4 hover:text-t2',
                waiting && 'opacity-50',
              )}
            >
              <span
                className="h-[2px] w-2.5"
                style={{ backgroundColor: on ? MA_COLOR[m] : '#48484a' }}
              />
              {m}
              {waiting && <span className="text-t4">…</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 상품별 실시간 상태 — 카드/차트/베이시스 패널이 공유. */
function useProductLive(product: IndexFuturesProduct) {
  const depth = useMarketStore((s) => s.indexFuturesDepth[product])
  const indexTicks = useMarketStore((s) => s.indexFuturesTicks)
  // 지수선물은 상품당 근월물 1개 — code로 키잉된 맵에서 product로 역인덱싱 (엔트리 3개).
  const tick = useMemo<IndexFuturesTick | undefined>(
    () => Object.values(indexTicks).find((t) => t.product === product),
    [indexTicks, product],
  )
  // 라이브 점 — 10초 버킷 + 총잔량/가격/누적거래량/OI/기초지수/이론가 스냅샷.
  // 히스토리 포인트와 같은 모양이라 메인·베이시스 차트가 그대로 공유한다.
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
  return { depth, tick, live }
}

/** 페이지 하단 베이시스 행 — 상품별 시장/이론 베이시스. */
function BasisPanel({
  product,
  label,
  series,
  date,
}: {
  product: IndexFuturesProduct
  label: string
  series: { code: string; points: DepthPoint[] } | null
  date: string
}) {
  const { live } = useProductLive(product)
  const points = useMemo(() => series?.points ?? [], [series])
  const hasBasis = useMemo(() => points.some((p) => p.u > 0), [points])
  return (
    <MiniPanel
      title={`${label} 베이시스 (선물 − 기초지수)`}
      legend={[
        ['시장', '#089981'],
        ['이론', '#ff9f0a'],
      ]}
    >
      {hasBasis || (live?.u ?? 0) > 0 ? (
        <BasisChart points={points} live={live} date={date} />
      ) : (
        <MiniEmpty />
      )}
    </MiniPanel>
  )
}

function ProductSection({
  product,
  label,
  series,
  status,
  date,
  intervalMin,
  ratioCandle,
  mas,
}: {
  product: IndexFuturesProduct
  label: string
  series: { code: string; points: DepthPoint[] } | null
  status: LoadState
  date: string
  intervalMin: IntervalMin
  ratioCandle: boolean
  mas: MaMin[]
}) {
  const { depth, tick, live } = useProductLive(product)
  const code = depth?.code ?? tick?.code ?? series?.code ?? ''
  // 화면 전 구간 공통 **v 스케일**(0 중심 부호) — 표시는 fmtRatio로 ±1.xx (session.ts).
  const ratio = depth ? ratioValue(depth.total_bid_qty, depth.total_ask_qty) : null

  // useMemo — `?? []`를 인라인으로 두면 매 렌더 새 배열이라 차트 재생성·통계 재계산이 헛돈다.
  const points = useMemo(() => series?.points ?? [], [series])
  // 한 번이라도 시딩됐으면 차트 유지 — 이후 재조회가 실패해도 실시간 append는 계속된다.
  const hasChart = points.length > 0
  const stats = useRatioStats(points, date, ratio)

  return (
    <div className="flex flex-col gap-1 lg:flex-row">
      <DepthCard label={label} code={code} tick={tick} depth={depth} ratio={ratio} stats={stats} />
      {/* 높이는 왼쪽 정보 카드에 맞춤 (lg에서 flex stretch) — 모바일 세로 배치에서만 고정 300px */}
      <div className="panel h-[300px] min-w-0 flex-1 lg:h-auto">
        {hasChart ? (
          <DepthChart
            points={points}
            live={live}
            date={date}
            intervalMin={intervalMin}
            ratioCandle={ratioCandle}
            mas={mas}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-t4">
            {status === 'loading'
              ? '히스토리 로딩 중…'
              : status === 'error'
                ? '히스토리를 불러오지 못했습니다 (realtime 8200 확인) — 30초 뒤 재시도'
                : '데이터 없음 — 장 시작 후 총잔량 샘플이 쌓이면 표시됩니다'}
          </div>
        )}
      </div>
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

/** 당일 비율 통계 — 세션 내 유효 샘플만, **v 스케일**(0 중심 부호)로 계산. 차트와 같은 제외 규칙. */
type RatioStats = {
  n: number
  min: number
  max: number
  mean: number
  /** 현재 비율의 당일 분포 percentile (0~100). 현재값 없으면 null. */
  pct: number | null
  /** 매수우위(v>0) 샘플 비중(%) — 샘플 간격이 균일해 시간 비중과 같다. */
  aboveOne: number
}

function useRatioStats(points: DepthPoint[], date: string, current: number | null): RatioStats | null {
  return useMemo(() => {
    const { from, to } = sessionRange(date)
    const inSession = points.filter((p) => p.t >= from && p.t <= to)
    const src = inSession.length ? inSession : points
    const rs: number[] = []
    for (const p of src) {
      const v = ratioValue(p.b, p.a)
      if (v != null) rs.push(v)
    }
    if (!rs.length) return null
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let above = 0
    for (const r of rs) {
      sum += r
      if (r < min) min = r
      if (r > max) max = r
      if (r > 0) above++
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
  // 상승/하락 색은 사용자 TV 차트 팔레트 (docs/화면 캡처 2026-08-12 094528.png) — 선물 탭 한정.
  const chgColor = chg > 0 ? 'text-[#089981]' : chg < 0 ? 'text-[#f23645]' : 'text-t3'
  // 색 판정을 fmtRatio 결과로 — '1.00'(균형 근처 반올림 밴드)이 청록/빨강으로 착색되지 않게.
  const ratioColor =
    ratio == null
      ? 'text-t4'
      : fmtRatio(ratio) === '1.00'
        ? 'text-t2'
        : ratio > 0
          ? 'text-[#089981]'
          : 'text-[#f23645]'
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
          {tick
            ? tick.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '-'}
        </span>
        <span className={cn('font-mono text-[12px] tabular-nums', chgColor)}>
          {tick ? `${chg > 0 ? '+' : ''}${chg.toFixed(2)} (${chg > 0 ? '+' : ''}${tick.change_rate.toFixed(2)}%)` : ''}
        </span>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        {/* 부호가 방향, 크기가 배율 — +1.24면 매수잔량이 1.24배, −1.35면 매도잔량이 1.35배. */}
        <span className="text-[11px] text-t3">비율 (+매수 / −매도 우위)</span>
        <span className={cn('font-mono text-[24px] font-semibold tabular-nums', ratioColor)}>
          {ratio == null ? '-' : fmtRatio(ratio)}
        </span>
      </div>

      {/* 잔량 분포 바 — 좌 빨강(매도) : 우 청록(매수) 비중 + 숫자를 한 덩어리로.
          숫자는 세그먼트 안이 아니라 **바 위 좌/우 고정 오버레이**라 한쪽이 극단적으로
          좁아져도 잘리지 않는다 (truncate 정보손실 금지). */}
      <div className="relative mt-1.5 h-7 w-full overflow-hidden rounded-sm bg-bg-surface">
        <div className="flex h-full w-full">
          <div className="bg-[#f23645]/30" style={{ width: `${100 - bidPct}%` }} />
          <div className="flex-1 bg-[#089981]/30" />
        </div>
        <div className="absolute inset-0 flex items-center justify-between gap-2 px-2 text-[10px]">
          <span className="flex items-baseline gap-1 whitespace-nowrap">
            <span className="text-t3">매도</span>
            <span className="font-mono text-[12px] font-medium tabular-nums text-[#f23645]">
              {depth ? depth.total_ask_qty.toLocaleString() : '-'}
            </span>
          </span>
          <span className="flex items-baseline gap-1 whitespace-nowrap">
            <span className="font-mono text-[12px] font-medium tabular-nums text-[#089981]">
              {depth ? depth.total_bid_qty.toLocaleString() : '-'}
            </span>
            <span className="text-t3">매수</span>
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
              className="absolute top-1/2 h-2.5 w-[2px] -translate-y-1/2 bg-[#089981]"
              style={{ left: `calc(${Math.min(100, Math.max(0, stats.pct))}% - 1px)` }}
            />
          )}
        </div>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <span className="text-t3">당일 고 / 저</span>
          <span className="text-right font-mono tabular-nums text-t2">
            {stats ? `${fmtRatio(stats.max)} / ${fmtRatio(stats.min)}` : '-'}
          </span>
          <span className="text-t3">평균</span>
          <span className="text-right font-mono tabular-nums text-t2">
            {stats ? fmtRatio(stats.mean) : '-'}
          </span>
          <span className="text-t3">매수우위 비중</span>
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
