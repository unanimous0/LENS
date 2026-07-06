import { useEffect, useMemo, useRef, useState } from 'react'

/**
 * 수급 태그 백테스트 "검증 근거" 패널 — 열람 전용 (사용자 파라미터 입력 없음).
 *
 * `/api/flow/backtest-report`(주기 갱신 JSON 원본)를 첫 오픈 시 1회 fetch해 포맷팅만 한다.
 * 어떤 지표도 재계산하지 않는다 — 부검 원칙(공식 1벌). 곡선은 외부 라이브러리 없이 인라인 SVG.
 * 스키마: backend/scripts/flow_tag_backtest.py save_results / flow-tag-backtest.md §PR-A.
 */

type CurvePoint = { excess_pct: number; t: number; n_dates: number; avg_stocks: number }
type PatternReport = {
  h60_excess_pct: number
  t: number
  direction: string
  n_dates: number
  curve?: Record<string, CurvePoint>
}
type RankIcPoint = { ic: number | null; t: number | null; n_dates: number }
type BacktestReport = {
  available: boolean
  generated_at?: string
  universe_n?: number
  horizon_days?: number
  lookback_years?: number
  period?: { start: string; end: string }
  rebalance_days?: number
  universe_criteria?: { adv_min: number; mcap_min: number }
  curve_horizons?: number[]
  method?: string
  rank_ic?: Record<string, RankIcPoint>
  patterns?: Record<string, PatternReport>
}

// 표시 순서 = _canonical_masks 배타 체인 + 경고 계열 (백엔드와 바이트 일치).
const PATTERN_ORDER = [
  '장기동시',
  '정석(동시+진입권)',
  '진입권',
  '추세순항',
  '동시',
  '매집주 눌림',
  '하락추세 매집',
  '동반순매도',
  '분배',
  '단기반등',
]
// 곡선 기본 표시(매수 계열) / 토글 시 추가(경고 계열).
const BUY_SERIES = ['장기동시', '정석(동시+진입권)', '진입권', '추세순항', '동시']
const WARN_SERIES = ['매집주 눌림', '하락추세 매집', '동반순매도', '분배', '단기반등']
// 라인 색 — 강세=초록 톤 변주, 경고=주황/빨강 톤 (기존 태그 색 시맨틱과 일관).
const LINE_COLOR: Record<string, string> = {
  장기동시: '#34c759',
  '정석(동시+진입권)': '#30d158',
  진입권: '#5ed1a0',
  추세순항: '#9acd6b',
  동시: '#4a9e78',
  '매집주 눌림': '#d9a441',
  '하락추세 매집': '#ff9f0a',
  동반순매도: '#ff3b30',
  분배: '#ff6b5e',
  단기반등: '#e08a3c',
}
// 매트릭스·곡선 열 = HORIZONS.
const MATRIX_H = [5, 20, 60, 120]

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
}
function tCls(t: number | null | undefined): string {
  return t != null && Math.abs(t) >= 2 ? '' : 'text-t4'
}
/** |t|≥2일 때만 방향색 — 미달은 회색(색 절제). */
function cellCls(ex: number | null | undefined, t: number | null | undefined): string {
  if (t == null || Math.abs(t) < 2) return 'text-t4'
  if (ex == null) return 'text-t4'
  return ex > 0 ? 'text-up' : ex < 0 ? 'text-down' : 'text-t3'
}

export function FlowBacktestReport({ open }: { open: boolean }) {
  const [report, setReport] = useState<BacktestReport | null>(null)
  const [error, setError] = useState(false)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (!open || fetchedRef.current) return
    fetchedRef.current = true
    fetch('/api/flow/backtest-report')
      .then((r) => r.json() as Promise<BacktestReport>)
      .then(setReport)
      .catch(() => setError(true))
  }, [open])

  if (!open) return null

  const patterns = report?.patterns
  const hasCurve =
    !!patterns && Object.values(patterns).some((p) => p.curve && Object.keys(p.curve).length > 0)

  if (error || (report && !report.available) || !patterns || !report?.rank_ic || !hasCurve) {
    return (
      <div className="panel px-3 py-3 text-xs text-t3">
        {report === null && !error
          ? '검증 리포트 불러오는 중…'
          : '검증 리포트 미생성 — 서버 주기 갱신 후 표시됩니다.'}
      </div>
    )
  }

  return (
    <div className="panel px-3 py-3 text-xs">
      <Header report={report} />
      <RankIcTable rankIc={report.rank_ic} />
      <CurveChart patterns={patterns} horizons={report.curve_horizons} />
      <MatrixTable patterns={patterns} />
      <Footnote report={report} />
    </div>
  )
}

function Header({ report }: { report: BacktestReport }) {
  const uc = report.universe_criteria
  const advEok = uc ? Math.round(uc.adv_min / 1e8) : null
  const mcapEok = uc ? Math.round(uc.mcap_min / 1e8) : null
  return (
    <div className="mb-3 flex flex-col gap-0.5">
      <div className="font-medium text-t2">검증 근거 — 태그 × 보유기간 백테스트 (열람 전용)</div>
      <div className="text-t3">
        기준일 <span className="text-t2 tabular-nums">{report.generated_at ?? '—'}</span>
        {report.lookback_years != null && (
          <>
            {' · 룩백 '}
            <span className="text-t2 tabular-nums">{report.lookback_years}년</span>
          </>
        )}
        {report.period && (
          <span className="text-t4 tabular-nums">
            {' ('}
            {report.period.start}~{report.period.end}
            {')'}
          </span>
        )}
        {report.universe_n != null && (
          <>
            {' · 유니버스 '}
            <span className="text-t2 tabular-nums">{report.universe_n.toLocaleString()}</span>종목
          </>
        )}
        {advEok != null && (
          <span className="text-t4">
            {' (거래대금 '}
            {advEok.toLocaleString()}억·시총 {mcapEok?.toLocaleString()}억↑)
          </span>
        )}
      </div>
      {report.method && <div className="text-t4">방법: {report.method}</div>}
    </div>
  )
}

function RankIcTable({ rankIc }: { rankIc: Record<string, RankIcPoint> }) {
  const hs = MATRIX_H.filter((h) => rankIc[String(h)])
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] text-t3">
        정렬축 Rank IC — 외인 20D 매집 정렬의 예측력. 양(+)·유의(t&gt;2)면 정렬 유효.
      </div>
      <table className="text-xs tabular-nums">
        <thead>
          <tr className="text-t3">
            <th className="px-2 py-0.5 text-left font-normal">보유 h</th>
            {hs.map((h) => (
              <th key={h} className="px-3 py-0.5 text-right font-normal">
                {h}일
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-bg-surface/50">
            <td className="px-2 py-0.5 text-t3">IC</td>
            {hs.map((h) => {
              const p = rankIc[String(h)]
              return (
                <td key={h} className={`px-3 py-0.5 text-right ${tCls(p.t)}`}>
                  {p.ic == null ? '—' : `${p.ic >= 0 ? '+' : ''}${p.ic.toFixed(3)}`}
                </td>
              )
            })}
          </tr>
          <tr>
            <td className="px-2 py-0.5 text-t3">t</td>
            {hs.map((h) => {
              const p = rankIc[String(h)]
              return (
                <td key={h} className={`px-3 py-0.5 text-right ${tCls(p.t)}`}>
                  {p.t == null ? '—' : p.t.toFixed(2)}
                </td>
              )
            })}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ── 보유기간 곡선 차트 (인라인 SVG) ─────────────────────────────────────────
function CurveChart({
  patterns,
  horizons,
}: {
  patterns: Record<string, PatternReport>
  horizons?: number[]
}) {
  const [showWarn, setShowWarn] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(680)
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(360, Math.round(e.contentRect.width)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // x축 지평 — JSON curve_horizons 우선, 없으면 곡선 키에서 유도. 등간격(index) 배치.
  const xs = useMemo(() => {
    if (horizons && horizons.length) return [...horizons].sort((a, b) => a - b)
    const set = new Set<number>()
    for (const p of Object.values(patterns)) {
      if (p.curve) for (const k of Object.keys(p.curve)) set.add(Number(k))
    }
    return [...set].sort((a, b) => a - b)
  }, [patterns, horizons])

  const series = useMemo(() => {
    const names = showWarn ? [...BUY_SERIES, ...WARN_SERIES] : BUY_SERIES
    return names
      .filter((n) => patterns[n]?.curve)
      .map((name) => ({
        name,
        color: LINE_COLOR[name] ?? '#8e8e93',
        pts: xs
          .map((h, i) => {
            const c = patterns[name].curve?.[String(h)]
            return c ? { i, h, v: c.excess_pct } : null
          })
          .filter((p): p is { i: number; h: number; v: number } => p != null),
      }))
  }, [patterns, xs, showWarn])

  const H = 240
  const M = { top: 14, right: 14, bottom: 26, left: 40 }
  const plotW = Math.max(1, w - M.left - M.right)
  const plotH = H - M.top - M.bottom
  const n = xs.length

  const { yMin, yMax } = useMemo(() => {
    let lo = 0
    let hi = 0
    for (const s of series) for (const p of s.pts) {
      if (p.v < lo) lo = p.v
      if (p.v > hi) hi = p.v
    }
    const pad = (hi - lo || 1) * 0.08
    return { yMin: lo - pad, yMax: hi + pad }
  }, [series])

  const xAt = (i: number) => M.left + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1))
  const yAt = (v: number) => M.top + plotH * (1 - (v - yMin) / (yMax - yMin || 1))

  // y 눈금 — 최소·0·최대 3개만 (격자 최소화).
  const yTicks = useMemo(() => {
    const t = new Set<number>([yMin, 0, yMax])
    return [...t].filter((v) => v >= yMin && v <= yMax)
  }, [yMin, yMax])

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (n <= 1) return setHoverIdx(0)
    const i = Math.round(((x - M.left) / plotW) * (n - 1))
    setHoverIdx(Math.max(0, Math.min(n - 1, i)))
  }

  const hoverH = hoverIdx != null ? xs[hoverIdx] : null
  const hoverVals =
    hoverIdx == null
      ? []
      : series
          .map((s) => {
            const p = s.pts.find((pp) => pp.i === hoverIdx)
            return p ? { name: s.name, color: s.color, v: p.v } : null
          })
          .filter((x): x is { name: string; color: string; v: number } => x != null)

  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-[11px] text-t3">
          보유기간 곡선 — 태그별 초과수익%(유니버스 평균 대비) × 보유 거래일. 알파가 언제까지 쌓이나.
        </div>
        <button
          onClick={() => setShowWarn((v) => !v)}
          className="rounded-sm border border-bg-surface px-1.5 py-0.5 text-[11px] text-t3 hover:text-t1"
        >
          {showWarn ? '경고 계열 숨김' : '경고 계열 표시'}
        </button>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg
          width={w}
          height={H}
          className="block"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* y 눈금 + 격자 */}
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={M.left}
                x2={w - M.right}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke={v === 0 ? '#3a3a3c' : '#1a1a1a'}
                strokeWidth={1}
              />
              <text
                x={M.left - 4}
                y={yAt(v) + 3}
                textAnchor="end"
                className="fill-t4 tabular-nums"
                fontSize={9}
              >
                {v >= 0 ? '+' : ''}
                {v.toFixed(1)}
              </text>
            </g>
          ))}
          {/* x 라벨 */}
          {xs.map((h, i) => (
            <text
              key={h}
              x={xAt(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-t4 tabular-nums"
              fontSize={9}
            >
              {h}
            </text>
          ))}
          {/* 호버 세로 가이드 */}
          {hoverIdx != null && (
            <line
              x1={xAt(hoverIdx)}
              x2={xAt(hoverIdx)}
              y1={M.top}
              y2={H - M.bottom}
              stroke="#3a3a3c"
              strokeWidth={1}
            />
          )}
          {/* 라인 */}
          {series.map((s) => {
            const d = s.pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${xAt(p.i)},${yAt(p.v)}`).join(' ')
            return (
              <g key={s.name}>
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.name === '장기동시' ? 2.2 : 1.4}
                />
                {hoverIdx != null &&
                  s.pts
                    .filter((p) => p.i === hoverIdx)
                    .map((p) => (
                      <circle key={s.name} cx={xAt(p.i)} cy={yAt(p.v)} r={2.6} fill={s.color} />
                    ))}
              </g>
            )
          })}
        </svg>
        {/* 호버 값 카드 */}
        {hoverIdx != null && hoverVals.length > 0 && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded-sm bg-bg-surface-2 p-1.5 text-[10px] leading-tight shadow-lg"
            style={{
              left:
                xAt(hoverIdx) > w / 2
                  ? undefined
                  : Math.min(xAt(hoverIdx) + 8, w - 130),
              right: xAt(hoverIdx) > w / 2 ? Math.max(w - xAt(hoverIdx) + 8, M.right) : undefined,
            }}
          >
            <div className="mb-0.5 text-t3 tabular-nums">보유 {hoverH}거래일</div>
            {hoverVals
              .slice()
              .sort((a, b) => b.v - a.v)
              .map((hv) => (
                <div key={hv.name} className="flex items-center gap-1.5 tabular-nums">
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: hv.color }}
                  />
                  <span className="text-t2">{hv.name}</span>
                  <span className={hv.v > 0 ? 'ml-auto text-up' : 'ml-auto text-down'}>
                    {hv.v >= 0 ? '+' : ''}
                    {hv.v.toFixed(1)}%
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
      {/* 범례 */}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-t3">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1">
            <span
              className="inline-block h-1.5 w-3 rounded-full"
              style={{ background: s.color }}
            />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  )
}

function MatrixTable({ patterns }: { patterns: Record<string, PatternReport> }) {
  const names = PATTERN_ORDER.filter((n) => patterns[n]?.curve)
  return (
    <div className="mb-3">
      <div className="mb-1 text-[11px] text-t3">
        태그 × 보유기간 초과수익%(t) — |t|≥2만 방향색. 마지막 열은 하루 평균 종목수(h60 기준).
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs tabular-nums">
          <thead>
            <tr className="text-t3">
              <th className="px-2 py-1 text-left font-normal">태그</th>
              {MATRIX_H.map((h) => (
                <th key={h} className="px-3 py-1 text-right font-normal">
                  h{h}
                </th>
              ))}
              <th className="px-3 py-1 text-right font-normal">종목/일</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const curve = patterns[name].curve!
              const h60 = curve['60']
              return (
                <tr key={name} className="border-t border-bg-surface/40">
                  <td className="px-2 py-1 text-t2">{name}</td>
                  {MATRIX_H.map((h) => {
                    const c = curve[String(h)]
                    return (
                      <td key={h} className={`px-3 py-1 text-right ${cellCls(c?.excess_pct, c?.t)}`}>
                        {c ? (
                          <>
                            {fmtPct(c.excess_pct)}
                            <span className="ml-1 text-t4">({c.t.toFixed(1)})</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                  <td className="px-3 py-1 text-right text-t3">
                    {h60 ? h60.avg_stocks.toFixed(0) : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Footnote({ report }: { report: BacktestReport }) {
  return (
    <div className="border-t border-bg-surface/50 pt-2 text-[11px] leading-relaxed text-t4">
      모든 %는 유니버스 평균 대비 초과수익 · D+1 시가 체결 가정 · h는 거래일 · |t|&lt;2는 유의성
      미달. 검증치는 패턴 평균이라 개별 종목 보장이 아님. 결과가 30일 이상 오래되면 서버 시작 시
      자동 재계산(약 월 1회). 현재 기준일{' '}
      <span className="text-t3 tabular-nums">{report.generated_at ?? '—'}</span>.
    </div>
  )
}
