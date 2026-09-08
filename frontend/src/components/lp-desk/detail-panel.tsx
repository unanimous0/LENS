import { useEffect, useMemo, useRef, useState } from 'react'

import { fmtSignedBp } from '@/lib/lp-desk'
import { cn } from '@/lib/utils'
import { S_REF_ASK, S_REF_BID } from '@/types/lp-desk'
import type {
  LpDeskCalib,
  LpDeskDetail,
  LpDeskHist,
  LpDeskResidPoint,
  LpDeskRollingBeta,
  LpDeskSPoint,
} from '@/types/lp-desk'

/**
 * LP 데스크 행 펼침 패널 (§14.8) — NAV 괴리 g 분포 / rolling β / 선물 대비 s 분포·경로 + PDF 상위.
 *
 * **g 분포가 맨 앞**인 건 그게 제안 호가의 근거이기 때문이다 (§14.5 4차 2026-08-21 —
 * x 마커(μ_g ± z·σ결합)·도달 일수·실시간 g 위치가 전부 이 차트에 있다). x가 g 분포 밖으로
 * 나가 보이는 건 정상이다 — 폭에 σ선물이 더해져 있고, 차트는 g 분포만 그리기 때문.
 * s 두 장은 "선물 헤지로 안 덮이는 잔차 리스크" 섹션이고, 거기 수평선은 x가 아니라
 * **s 분위수 p10/p90**이다 (자가 달라 섞으면 거짓말이 된다).
 * 일봉 괴리(μ·σ)는 σ가 재구성 오차에 지배돼(§14.3) 헤더 텍스트로만 남는다.
 *
 * 차트는 전부 인라인 SVG. stat-arb 상세는 lightweight-charts를 쓰지만 여기는
 * 테이블 안에 접히는 보조 패널이라 번들·인스턴스 비용을 지지 않는 쪽을 택했다
 * (backtest/histogram.tsx·flow-backtest-report와 같은 방식).
 */

const C = {
  betaK: '#34c759',
  betaQ: '#0a84ff',
  line: '#d1d1d6',
  grid: '#2a2a2c',
  axis: '#8e8e93',
  warning: '#ff9f0a',
  // 상승/하락은 종목차익 화면과 동일 토큰 (lib/lp-desk의 LP_UP/LP_DOWN과 같은 색).
  up: '#00b26b',
  down: '#bb4a65',
} as const

/** 컨테이너 폭 추적 — 차트 3개가 grid로 나란히 놓여 폭이 제각각이라 각자 관측. */
function useMeasuredWidth(fallback = 320) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(200, Math.round(e.contentRect.width)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, w }
}

export function LpDeskDetailPanel({
  etfCode,
  name,
  detail,
  loading,
  error,
  residVolBp,
  residZ,
  gapMeanBp,
  gapSigmaBp,
  gapObs,
  xBidBp,
  xAskBp,
  biasBp = 0,
  z,
  xBreakdown,
  touchDaysBid,
  touchDaysAsk,
  touchTotalDays,
  gNowBp,
  sNowBp,
  calib,
  statsWindow,
}: {
  etfCode: string
  name: string
  detail: LpDeskDetail | null
  loading: boolean
  error: string
  residVolBp: number | null
  residZ: number | null
  gapMeanBp: number | null
  gapSigmaBp: number | null
  gapObs: number | null
  /** 현재 x 레벨 (bp) = μ_g ± z·σ결합 − 재고편향. 캘리브 없으면 null. */
  xBidBp: number | null
  xAskBp: number | null
  /** x에 이미 반영된 재고 편향 bp (OMS v1.5) — 0이 아니면 라벨에 밝힌다. */
  biasBp?: number
  /** σ결합 배수 (튜너). 마커 라벨에 표기. */
  z: number
  /** x 분해 한 줄 (`μ … · σ괴리 … · σ선물 … → ±zσ`) — 헤더 툴팁용. */
  xBreakdown: string
  /** 창 N일 중 그 x 레벨이 열린 **날 수** (§14.11 — 구 도달횟수/일 폐기). */
  touchDaysBid: number | null
  touchDaysAsk: number | null
  /** 위 도달 일수의 모수 (g 일별 극값 일수). */
  touchTotalDays: number | null
  /** 실시간 괴리 g (표의 괴리bp). g 분포 차트에 현재 위치를 얹는다. */
  gNowBp: number | null
  /** 오늘 s (실시간). s 차트에 현재 위치를 얹는다. */
  sNowBp: number | null
  calib: LpDeskCalib | null
  statsWindow: number
}) {
  // s 섹션의 수평선은 **s 분위수(고정 p10/p90)**다 — 호가 z와 자가 다르므로 섞지 않는다.
  const sBidBp = calib?.s_quantiles?.[S_REF_BID] ?? null
  const sAskBp = calib?.s_quantiles?.[S_REF_ASK] ?? null
  const sTouchBid = calib?.touch_days?.[S_REF_BID] ?? null
  const sTouchAsk = calib?.touch_days?.[S_REF_ASK] ?? null
  return (
    // 메인 테이블이 auto layout으로 넓어, 확장 패널을 viewport 폭에 sticky 고정
    // (종목차익 EtfHoldersTable과 동일 처리).
    <div
      className="px-4 py-3 bg-[#0a0a0a] border-y border-white/[0.04]"
      style={{ position: 'sticky', left: 0, width: '100vw', maxWidth: '100vw', boxSizing: 'border-box' }}
    >
      <div className="mb-2 flex items-center gap-3 text-[11px] text-[#8b8b8e]">
        <span className="text-white">{name}</span>
        <span className="tabular-nums">{etfCode}</span>
        <span>회귀창 <span className="text-[#d1d1d6] tabular-nums">{statsWindow}</span>일</span>
        {/* 매도 → 매수 순 (단말 관행 — 표의 x매도/x매수 컬럼과 같은 순서). */}
        <span title={xBreakdown || 'x 산출 불가 — g 표본 부족'}>
          x{' '}
          {/* 부호는 항상 계산 — 음수 레벨에 '+'를 하드코딩하면 `+-5.0`이 렌더된다. */}
          <span className="tabular-nums" style={{ color: C.down }}>
            {xAskBp != null ? fmtSignedBp(xAskBp) : '—'}
          </span>
          <span className="text-[#3a3a3e]"> ~ </span>
          <span className="tabular-nums" style={{ color: C.up }}>
            {xBidBp != null ? fmtSignedBp(xBidBp) : '—'}
          </span>
          <span className="text-[#5a5a5e]">bp (μ_g ± {z}σ결합{biasBp !== 0 ? ' − 재고편향' : ''})</span>
          <span
            className="ml-1 text-[#5a5a5e] tabular-nums"
            title="장중 g가 그 x 레벨을 한 번이라도 넘은 날 수 (매도/매수) — z가 클수록 줄어든다"
          >
            도달 {touchTotalDays ?? '-'}일 중 {touchDaysAsk ?? '-'}/{touchDaysBid ?? '-'}일
          </span>
        </span>
        <span title="실시간 괴리 = (mid 또는 현재가 − iNAV)/iNAV. 호가 x와 같은 자.">
          지금 g{' '}
          <span className={cn('tabular-nums', gNowBp == null ? 'text-[#5a5a5e]' : '')} style={gNowBp == null ? undefined : { color: gNowBp >= 0 ? C.up : C.down }}>
            {gNowBp != null ? `${fmtSignedBp(gNowBp)}bp` : '—'}
          </span>
        </span>
        <span title={'g σ 일중 = 일별 demean 후 산포(하루 안의 흔들림).\ng σ 레벨 = 날짜 간 레벨 이동까지 포함한 pooled σ — **호가 폭에 들어가는 σ괴리**가 이쪽이다.'}>
          g σ 일중/레벨{' '}
          <span className="text-[#d1d1d6] tabular-nums">
            {calib?.g_sigma_bp != null ? calib.g_sigma_bp.toFixed(1) : '-'}
            {' / '}
            {calib?.g_sigma_level_bp != null ? `${calib.g_sigma_level_bp.toFixed(1)}bp` : '-'}
          </span>
        </span>
        <span title="선물 대비 스큐 s — 지수선물 헤지로 안 덮이는 오늘의 섹터 고유 움직임 (호가와 무관)">
          오늘 s{' '}
          <span className={cn('tabular-nums', sNowBp == null ? 'text-[#5a5a5e]' : '')} style={sNowBp == null ? undefined : { color: sNowBp >= 0 ? C.up : C.down }}>
            {sNowBp != null ? `${fmtSignedBp(sNowBp)}bp` : '—'}
          </span>
        </span>
        <span title="일봉 PDF 재구성 괴리 — σ가 재구성 오차에 지배돼 호가에는 쓰지 않는다 (§14.3)">
          일봉 괴리 μ/σ{' '}
          <span className={cn('tabular-nums', gapMeanBp == null ? 'text-warning' : 'text-[#d1d1d6]')}>
            {gapMeanBp != null && gapSigmaBp != null
              ? `${gapMeanBp.toFixed(1)} / ${gapSigmaBp.toFixed(1)}bp`
              : '표본부족'}
          </span>
          <span className="ml-1 text-[#5a5a5e] tabular-nums">({gapObs ?? 0}일)</span>
        </span>
        <span>
          잔차vol/z{' '}
          <span className="text-[#d1d1d6] tabular-nums">
            {residVolBp != null ? `${residVolBp.toFixed(1)}bp` : '-'} / {residZ != null ? residZ.toFixed(2) : '-'}
          </span>
        </span>
        {loading && <span className="text-blue">로딩…</span>}
        {error && <span className="text-down">상세 조회 실패: {error}</span>}
      </div>

      <div className="grid gap-1 md:grid-cols-2 xl:grid-cols-4">
        {/* ── 호가 근거 (§14.5 4차) ── */}
        <Card
          title={`NAV 괴리 g 분포 — 호가 근거 (최근 ${calib?.g_days ?? '-'}일 30초봉)`}
          legend={[['x 구간', C.betaK], ['지금 g', C.warning]]}
          className="xl:col-span-2"
        >
          <LevelHistogram
            hist={detail?.g_hist ?? null}
            bidBp={xBidBp}
            askBp={xAskBp}
            nowBp={gNowBp}
            touchDaysBid={touchDaysBid}
            touchDaysAsk={touchDaysAsk}
            calibDays={touchTotalDays}
            bidLabel={`x매수 −${z}σ${biasBp !== 0 ? '−편향' : ''}`}
            askLabel={`x매도 +${z}σ${biasBp !== 0 ? '−편향' : ''}`}
            nowLabel="now"
          />
        </Card>
        <Card title="rolling β (60일)" legend={[['β_K200', C.betaK], ['β_KQ150', C.betaQ]]}>
          <RollingBetaChart points={detail?.rolling_beta ?? []} />
        </Card>
        <Card title="잔차 z 추이 (일봉)" legend={[['z', C.line]]}>
          <ResidZChart points={detail?.resid ?? []} residVolBp={residVolBp} />
        </Card>

        {/* ── 선물 대비 s = 헤지 잔차 리스크 감각 (호가와 무관, §14.5 4차로 강등) ── */}
        <Card
          title={`선물 대비 s 분포 — 잔차 리스크 (최근 ${calib?.days ?? '-'}일)`}
          legend={[[`s ${S_REF_BID}~${S_REF_ASK}`, C.betaK], ['오늘 s', C.warning]]}
        >
          <LevelHistogram
            hist={detail?.s_hist ?? null}
            bidBp={sBidBp}
            askBp={sAskBp}
            nowBp={sNowBp}
            touchDaysBid={sTouchBid}
            touchDaysAsk={sTouchAsk}
            calibDays={calib?.days ?? null}
            bidLabel={`s ${S_REF_BID}`}
            askLabel={`s ${S_REF_ASK}`}
            nowLabel="오늘"
          />
        </Card>
        <Card
          title="선물 대비 s 경로 (최근 3거래일)"
          legend={[['s bp', C.line], ['s 분위수', C.betaK]]}
          className="xl:col-span-3"
        >
          <SRecentChart
            points={detail?.s_recent ?? []}
            bidBp={sBidBp}
            askBp={sAskBp}
            nowBp={sNowBp}
            bidLabel={`s ${S_REF_BID}`}
            askLabel={`s ${S_REF_ASK}`}
          />
        </Card>
      </div>

      <PdfTopTable rows={detail?.pdf_top ?? []} loading={loading} />
    </div>
  )
}

function Card({
  title,
  legend,
  children,
  className,
}: {
  title: string
  legend: [string, string][]
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('bg-[#0d0d0f] border border-white/[0.03] rounded-sm px-2 py-1.5', className)}>
      <div className="mb-1 flex items-center gap-2 text-[10px] text-[#8b8b8e]">
        <span className="text-[#d1d1d6]">{title}</span>
        <span className="ml-auto flex items-center gap-2">
          {legend.map(([label, color]) => (
            <span key={label} className="flex items-center gap-1">
              <span className="h-[2px] w-2.5" style={{ backgroundColor: color }} />
              {label}
            </span>
          ))}
        </span>
      </div>
      {children}
    </div>
  )
}

function Empty({ h = 140 }: { h?: number }) {
  return (
    <div className="flex items-center justify-center text-[11px] text-[#5a5a5e]" style={{ height: h }}>
      데이터 없음
    </div>
  )
}

/** 값 배열 → SVG polyline points. */
function polyline(values: number[], w: number, h: number, pad: number, lo: number, hi: number): string {
  const n = values.length
  if (n === 0) return ''
  const span = hi - lo || 1
  const innerW = w - pad * 2
  const innerH = h - pad * 2
  const stepX = n > 1 ? innerW / (n - 1) : 0
  const out: string[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const x = pad + i * stepX
    const y = pad + innerH * (1 - (values[i] - lo) / span)
    out[i] = `${x.toFixed(1)},${y.toFixed(1)}`
  }
  return out.join(' ')
}

const H = 140
const PAD = 18

function RollingBetaChart({ points }: { points: LpDeskRollingBeta[] }) {
  const { ref, w } = useMeasuredWidth()
  const model = useMemo(() => {
    if (points.length === 0) return null
    const bk = points.map((p) => p.bk)
    const bq = points.map((p) => p.bq)
    let lo = Infinity
    let hi = -Infinity
    for (const v of bk) { if (v < lo) lo = v; if (v > hi) hi = v }
    for (const v of bq) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
    const margin = (hi - lo) * 0.15 || 0.05
    return { bk, bq, lo: lo - margin, hi: hi + margin, first: points[0].date, last: points[points.length - 1].date }
  }, [points])

  return (
    <div ref={ref} className="w-full">
      {!model ? (
        <Empty />
      ) : (
        <svg width={w} height={H} className="block">
          <ZeroBase w={w} lo={model.lo} hi={model.hi} />
          <polyline points={polyline(model.bk, w, H, PAD, model.lo, model.hi)} fill="none" stroke={C.betaK} strokeWidth={1.2} />
          <polyline points={polyline(model.bq, w, H, PAD, model.lo, model.hi)} fill="none" stroke={C.betaQ} strokeWidth={1.2} />
          <text x={2} y={PAD} fontSize={9} fill={C.axis} className="tabular-nums">{model.hi.toFixed(2)}</text>
          <text x={2} y={H - PAD + 8} fontSize={9} fill={C.axis} className="tabular-nums">{model.lo.toFixed(2)}</text>
          <text x={PAD} y={H - 3} fontSize={9} fill={C.axis} textAnchor="start" className="tabular-nums">{model.first}</text>
          <text x={w - 2} y={H - 3} fontSize={9} fill={C.axis} textAnchor="end" className="tabular-nums">{model.last}</text>
          <text x={w - 2} y={PAD} fontSize={9} fill={C.betaK} textAnchor="end" className="tabular-nums">
            {model.bk[model.bk.length - 1].toFixed(3)}
          </text>
          <text x={w - 2} y={PAD + 11} fontSize={9} fill={C.betaQ} textAnchor="end" className="tabular-nums">
            {model.bq[model.bq.length - 1].toFixed(3)}
          </text>
        </svg>
      )}
    </div>
  )
}

/** 0 이 세로 범위 안에 있으면 기준선을 긋는다. */
function ZeroBase({ w, lo, hi }: { w: number; lo: number; hi: number }) {
  if (lo > 0 || hi < 0) return null
  const y = PAD + (H - PAD * 2) * (1 - (0 - lo) / (hi - lo || 1))
  return <line x1={PAD} x2={w - 2} y1={y} y2={y} stroke={C.grid} strokeWidth={1} />
}

/** 잔차 z 추이 — z = 잔차bp / 잔차vol(bp). vol 미산출이면 bp 그대로 그린다. */
function ResidZChart({ points, residVolBp }: { points: LpDeskResidPoint[]; residVolBp: number | null }) {
  const { ref, w } = useMeasuredWidth()
  const model = useMemo(() => {
    if (points.length === 0) return null
    const scale = residVolBp && residVolBp > 0 ? residVolBp : 0
    const vals = points.map((p) => (scale > 0 ? p.bp / scale : p.bp))
    let maxAbs = 0
    for (const v of vals) if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v)
    const range = scale > 0 ? Math.max(2.5, Math.ceil(maxAbs * 10) / 10) : Math.max(1, maxAbs * 1.1)
    return {
      vals,
      lo: -range,
      hi: range,
      unit: scale > 0 ? 'σ' : 'bp',
      bands: scale > 0 ? [-2, -1, 0, 1, 2] : [0],
      first: points[0].date,
      last: points[points.length - 1].date,
    }
  }, [points, residVolBp])

  const yAt = (v: number, lo: number, hi: number) => PAD + (H - PAD * 2) * (1 - (v - lo) / (hi - lo || 1))

  return (
    <div ref={ref} className="w-full">
      {!model ? (
        <Empty />
      ) : (
        <svg width={w} height={H} className="block">
          {model.bands.map((b) => (
            <g key={b}>
              <line
                x1={PAD}
                x2={w - 2}
                y1={yAt(b, model.lo, model.hi)}
                y2={yAt(b, model.lo, model.hi)}
                stroke={b === 0 ? C.grid : '#1f1f21'}
                strokeDasharray={b === 0 ? undefined : '3 2'}
              />
              {b !== 0 && (
                <text x={2} y={yAt(b, model.lo, model.hi) + 3} fontSize={9} fill={C.axis} className="tabular-nums">
                  {b > 0 ? `+${b}` : b}
                </text>
              )}
            </g>
          ))}
          <polyline points={polyline(model.vals, w, H, PAD, model.lo, model.hi)} fill="none" stroke={C.line} strokeWidth={1.1} />
          <circle
            cx={w - PAD}
            cy={yAt(model.vals[model.vals.length - 1], model.lo, model.hi)}
            r={2.5}
            fill={Math.abs(model.vals[model.vals.length - 1]) >= 2 ? C.warning : C.line}
          />
          <text x={PAD} y={H - 3} fontSize={9} fill={C.axis} textAnchor="start" className="tabular-nums">{model.first}</text>
          <text x={w - 2} y={H - 3} fontSize={9} fill={C.axis} textAnchor="end" className="tabular-nums">{model.last}</text>
          <text x={w - 2} y={PAD} fontSize={9} fill={C.axis} textAnchor="end" className="tabular-nums">
            {model.vals[model.vals.length - 1].toFixed(2)}{model.unit}
          </text>
        </svg>
      )}
    </div>
  )
}

/** bins가 중심값으로 오면 균등 간격 가정으로 경계로 환산. */
function toEdges(hist: LpDeskHist): number[] | null {
  const { bins, counts } = hist
  if (!Array.isArray(bins) || !Array.isArray(counts) || counts.length === 0) return null
  if (bins.length === counts.length + 1) return bins
  if (bins.length !== counts.length || bins.length < 2) return null
  const step = bins[1] - bins[0]
  const edges = bins.map((b) => b - step / 2)
  edges.push(bins[bins.length - 1] + step / 2)
  return edges
}

/**
 * 레벨 마커가 있는 분포 히스토그램 — **g(호가 근거)와 s(잔차 감각) 두 곳이 같이 쓴다.**
 *
 * 하한~상한 구간을 음영으로 깔고 두 레벨에 마커 + **도달 일수**를 붙인 뒤, 실시간 값을 주황
 * 세로선으로 얹는다. g에 쓰면 "내 호가가 최근 N일 NAV 괴리 분포의 어디에 서 있고, 그 레벨이
 * 며칠이나 열렸나"가 되고, s에 쓰면 "오늘 잔차가 평소 분포의 어디인가"가 된다.
 * 라벨을 인자로 받는 이유: 두 축은 **자가 다르다** — g 레벨을 s 차트에 "x"로 긋는 순간 거짓말이
 * 된다 (§14.5 4차 정정에서 실제로 그렇게 틀렸다).
 */
function LevelHistogram({
  hist, bidBp, askBp, nowBp, touchDaysBid, touchDaysAsk, calibDays, bidLabel, askLabel, nowLabel,
}: {
  hist: LpDeskHist | null
  bidBp: number | null
  askBp: number | null
  nowBp: number | null
  touchDaysBid: number | null
  touchDaysAsk: number | null
  calibDays: number | null
  bidLabel: string
  askLabel: string
  nowLabel: string
}) {
  const { ref, w } = useMeasuredWidth()
  const model = useMemo(() => {
    if (!hist) return null
    const edges = toEdges(hist)
    if (!edges) return null
    const counts = hist.counts
    let max = 0
    let total = 0
    for (const c of counts) {
      if (c > max) max = c
      total += c
    }
    if (max === 0) return null
    // x 구간 안에 든 표본 비율 — 구간이 걸친 만큼 선형 배분.
    const lo0 = bidBp ?? edges[0]
    const hi0 = askBp ?? edges[edges.length - 1]
    let covered = 0
    for (let i = 0; i < counts.length; i++) {
      const a = edges[i]
      const b = edges[i + 1]
      const width = b - a
      if (width <= 0) continue
      covered += counts[i] * (Math.max(0, Math.min(b, hi0) - Math.max(a, lo0)) / width)
    }
    // x·오늘 s가 표본 밖으로 나가도 보이도록 축을 넓힌다.
    let lo = Math.min(edges[0], lo0)
    let hi = Math.max(edges[edges.length - 1], hi0)
    if (nowBp != null) {
      lo = Math.min(lo, nowBp)
      hi = Math.max(hi, nowBp)
    }
    return { edges, counts, max, lo, hi, insidePct: total > 0 ? (covered / total) * 100 : 0 }
  }, [hist, bidBp, askBp, nowBp])

  return (
    <div ref={ref} className="w-full">
      {!model ? (
        <Empty />
      ) : (
        (() => {
          const innerW = w - PAD * 2
          const innerH = H - PAD * 2
          const span = model.hi - model.lo || 1
          const xAt = (v: number) => PAD + innerW * ((v - model.lo) / span)
          const clampX = (v: number) => Math.max(PAD, Math.min(PAD + innerW, xAt(v)))
          return (
            <svg width={w} height={H} className="block">
              {bidBp != null && askBp != null && (
                <rect
                  x={clampX(bidBp)} y={PAD}
                  width={Math.max(0, clampX(askBp) - clampX(bidBp))} height={innerH}
                  fill={C.betaK} opacity={0.1}
                />
              )}
              {model.counts.map((c, i) => {
                const x0 = xAt(model.edges[i])
                const x1 = xAt(model.edges[i + 1])
                const bh = innerH * (c / model.max)
                const mid = (model.edges[i] + model.edges[i + 1]) / 2
                const inside = (bidBp == null || mid >= bidBp) && (askBp == null || mid <= askBp)
                return (
                  <rect
                    key={i}
                    x={x0 + 0.5}
                    y={PAD + innerH - bh}
                    width={Math.max(0.5, x1 - x0 - 1)}
                    height={bh}
                    fill={inside ? C.betaK : C.axis}
                    opacity={inside ? 0.7 : 0.45}
                  >
                    <title>{`${model.edges[i].toFixed(1)} ~ ${model.edges[i + 1].toFixed(1)}bp · ${c}봉`}</title>
                  </rect>
                )
              })}
              {/* 레벨 마커 + 도달 일수 */}
              <XMarker x={bidBp} color={C.up} label={bidLabel} touchDays={touchDaysBid} calibDays={calibDays} clampX={clampX} innerH={innerH} />
              <XMarker x={askBp} color={C.down} label={askLabel} touchDays={touchDaysAsk} calibDays={calibDays} clampX={clampX} innerH={innerH} />
              {nowBp != null && (
                <g>
                  <line
                    x1={clampX(nowBp)} x2={clampX(nowBp)} y1={PAD} y2={PAD + innerH}
                    stroke={C.warning} strokeWidth={1}
                  />
                  <text x={clampX(nowBp)} y={PAD - 4} fontSize={9} fill={C.warning} textAnchor="middle" className="tabular-nums">
                    {nowLabel} {nowBp.toFixed(0)}
                  </text>
                </g>
              )}
              <line x1={PAD} x2={w - 2} y1={PAD + innerH} y2={PAD + innerH} stroke={C.grid} />
              <text x={PAD} y={H - 3} fontSize={9} fill={C.axis} textAnchor="start" className="tabular-nums">
                {model.lo.toFixed(0)}bp
              </text>
              <text x={w - 2} y={H - 3} fontSize={9} fill={C.axis} textAnchor="end" className="tabular-nums">
                {model.hi.toFixed(0)}bp
              </text>
              <text x={w - 2} y={PAD} fontSize={9} fill={C.betaK} textAnchor="end" className="tabular-nums">
                구간 안 {model.insidePct.toFixed(0)}%
              </text>
            </svg>
          )
        })()
      )}
    </div>
  )
}

/** 레벨 세로 마커 + "도달 N/M일" 라벨. */
function XMarker({
  x, color, label, touchDays, calibDays, clampX, innerH,
}: {
  x: number | null
  color: string
  label: string
  touchDays: number | null
  calibDays: number | null
  clampX: (v: number) => number
  innerH: number
}) {
  if (x == null) return null
  const px = clampX(x)
  return (
    <g>
      <line x1={px} x2={px} y1={PAD} y2={PAD + innerH} stroke={color} strokeWidth={1} strokeDasharray="3 2" />
      <text x={px} y={PAD + innerH - 3} fontSize={9} fill={color} textAnchor="middle" className="tabular-nums">
        {label} {touchDays != null && calibDays != null ? `${touchDays}/${calibDays}일` : ''}
      </text>
    </g>
  )
}

/**
 * 최근 s 경로 (§14.5) — 30초 s 경로에 **s 분위수** 수평선을 깐다.
 *
 * 4차 정정 전에는 여기 수평선이 제안 호가의 x였다. 지금 x는 iNAV 기준 g라 자가 달라, 그 선을
 * 여기 그으면 "선물 대비 이만큼 벌어져야 체결"이라는 거짓 신호가 된다. 이 차트가 답하는 질문은
 * "오늘 잔차가 평소 분포 대비 어디까지 벌어졌나"다.
 * 일자 경계에는 세로 구분선 (`t`가 "MM-DD HH:MM"이라 접두 날짜로 판정).
 */
function SRecentChart({
  points, bidBp, askBp, nowBp, bidLabel, askLabel,
}: {
  points: LpDeskSPoint[]
  bidBp: number | null
  askBp: number | null
  nowBp: number | null
  bidLabel: string
  askLabel: string
}) {
  const { ref, w } = useMeasuredWidth()
  const model = useMemo(() => {
    const vals: number[] = []
    const breaks: number[] = []
    const days: string[] = []
    let prevDay = ''
    for (const p of points) {
      if (p.bp == null || !Number.isFinite(p.bp)) continue
      const day = p.t.slice(0, 5)
      if (day !== prevDay) {
        if (prevDay) breaks.push(vals.length)
        days.push(day)
        prevDay = day
      }
      vals.push(p.bp)
    }
    if (vals.length === 0) return null
    let lo = Math.min(bidBp ?? Infinity, 0)
    let hi = Math.max(askBp ?? -Infinity, 0)
    for (const v of vals) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (nowBp != null) {
      lo = Math.min(lo, nowBp)
      hi = Math.max(hi, nowBp)
    }
    const margin = (hi - lo) * 0.1 || 1
    return {
      vals, breaks, days,
      lo: lo - margin, hi: hi + margin,
      last: vals[vals.length - 1],
      firstT: points[0]?.t ?? '',
      lastT: points[points.length - 1]?.t ?? '',
    }
  }, [points, bidBp, askBp, nowBp])

  return (
    <div ref={ref} className="w-full">
      {!model ? (
        <Empty />
      ) : (
        (() => {
          const innerW = w - PAD * 2
          const innerH = H - PAD * 2
          const yAt = (v: number) => PAD + innerH * (1 - (v - model.lo) / (model.hi - model.lo || 1))
          const xAt = (i: number) => PAD + (model.vals.length > 1 ? (innerW * i) / (model.vals.length - 1) : 0)
          const level = (v: number | null, color: string, label: string) =>
            v == null ? null : (
              <g key={label}>
                <line x1={PAD} x2={w - 2} y1={yAt(v)} y2={yAt(v)} stroke={color} strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
                <text x={w - 2} y={yAt(v) - 3} fontSize={9} fill={color} textAnchor="end" className="tabular-nums">
                  {label} {fmtSignedBp(v, 0)}
                </text>
              </g>
            )
          return (
            <svg width={w} height={H} className="block">
              <line x1={PAD} x2={w - 2} y1={yAt(0)} y2={yAt(0)} stroke={C.grid} />
              {model.breaks.map((i) => (
                <line key={i} x1={xAt(i)} x2={xAt(i)} y1={PAD} y2={PAD + innerH} stroke="#1f1f21" />
              ))}
              {level(askBp, C.down, askLabel)}
              {level(bidBp, C.up, bidLabel)}
              <polyline
                points={polyline(model.vals, w, H, PAD, model.lo, model.hi)}
                fill="none" stroke={C.line} strokeWidth={1.1}
              />
              <circle cx={w - PAD} cy={yAt(model.last)} r={2.5} fill={model.last >= 0 ? C.up : C.down} />
              <text x={2} y={PAD} fontSize={9} fill={C.axis} className="tabular-nums">{model.hi.toFixed(0)}</text>
              <text x={2} y={H - PAD + 8} fontSize={9} fill={C.axis} className="tabular-nums">{model.lo.toFixed(0)}</text>
              <text x={PAD} y={H - 3} fontSize={9} fill={C.axis} textAnchor="start" className="tabular-nums">{model.firstT}</text>
              <text x={w - 2} y={H - 3} fontSize={9} fill={C.axis} textAnchor="end" className="tabular-nums">{model.lastT}</text>
            </svg>
          )
        })()
      )}
    </div>
  )
}

function PdfTopTable({ rows, loading }: { rows: LpDeskDetail['pdf_top']; loading: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="mt-1 px-1 py-2 text-[11px] text-[#5a5a5e]">
        {loading ? 'PDF 로딩…' : 'PDF 구성종목 없음'}
      </div>
    )
  }
  return (
    <div className="mt-1 rounded-sm bg-[#0d0d0f] border border-white/[0.03] px-2 py-1.5">
      <div className="mb-1 text-[10px] text-[#8b8b8e]">PDF 상위 {rows.length}</div>
      <div className="grid grid-cols-2 gap-x-6 lg:grid-cols-5">
        {rows.map((r) => (
          <div key={r.code} className="flex items-baseline gap-2 py-[3px] text-[11px] border-b border-white/[0.03]">
            <span className="w-[46px] shrink-0 text-[10px] text-[#5a5a5e] tabular-nums">{r.code}</span>
            <span className="truncate text-white" title={r.name}>{r.name}</span>
            {r.market && <span className="shrink-0 text-[9px] text-[#5a5a5e]">{r.market}</span>}
            <span className={cn('ml-auto shrink-0 tabular-nums', (r.weight_pct ?? 0) >= 10 ? 'text-accent' : 'text-[#d1d1d6]')}>
              {r.weight_pct != null ? `${r.weight_pct.toFixed(2)}%` : '-'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
