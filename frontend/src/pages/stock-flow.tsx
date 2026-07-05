import { type ReactNode, useEffect, useMemo, useState } from 'react'

import { FlowDetail } from '@/components/flow/flow-detail'

/**
 * 수급 — 외국인/기관 순매수 기반 종목 랭킹.
 *
 * 설계 원칙 (memory project_supply_demand — 4관점 제로베이스 설계 통합안):
 *  - 지표는 백엔드 정본(services/flow_metrics.py) 하나뿐. 프론트는 포맷팅만.
 *  - 정렬 키 = 외인 20D/유통시총 단일. 매수 = 내림차순, 매도 = 오름차순 토글.
 *  - 합성 점수 없음 — 모든 컬럼이 HTS로 검산 가능한 raw 산수.
 *  - 표기: bp 대신 "유통%"(bp/100) — "유통물량의 몇 %를 순매수했나"가 직관적.
 */

type VerdictPattern = {
  pattern: string
  edge: number // 검증 60일 평균 초과수익 (%, 유니버스 평균 대비)
  t: number
  direction: string // "강세" | "약세"
}
type Verdict = VerdictPattern & { others: VerdictPattern[] }

type FlowRow = {
  code: string
  name: string
  market: string
  sector: string | null
  float_date: string
  mcap_eok: number | null
  float_mcap_eok: number
  f_streak: number
  f_5d_eok: number
  f_20d_eok: number
  f_60d_eok: number
  i_5d_eok: number
  i_20d_eok: number
  f_120d_eok: number
  i_120d_eok: number
  f_5d_bp: number
  f_20d_bp: number
  f_60d_bp: number
  f_120d_bp: number
  i_20d_bp: number
  i_120d_bp: number
  absorb_5d_pct: number | null
  ret_20d_pct: number | null
  y_f_eok: number
  y_i_eok: number
  adv_20d_eok: number
  ret_5d_pct: number | null
  r_5d_eok: number
  both_20d: boolean
  long_both: boolean
  trend_ride: boolean
  entry_ok: boolean
  exit_ok: boolean
  is_distribution: boolean
  short_bounce: boolean
  long_up: boolean
  is_new: boolean
  verdict: Verdict | null
}

type RankingResp = {
  as_of: string
  is_partial: boolean
  preset: string
  count: number
  edges_as_of: string | null // 검증 기준일 (flow_backtest.json generated_at)
  edges: Record<string, { edge: number; t: number; direction: string }> // 태그 범례용 측정값
  rows: FlowRow[]
}

// 태그 일상어 설명 — 화면 범례 정본. edge·t는 API의 edges에서 동적 주입(여기 하드코딩 금지).
const TAG_LEGEND: { name: string; desc: string }[] = [
  { name: '장기동시', desc: '외국인·기관이 단기(20일)와 장기(120일) 모두 순매수 — 4중 겹침. 검증된 태그 중 최강' },
  { name: '정석(동시+진입권)', desc: '외국인이 규모 있게 꾸준히 사는 중 + 기관도 동참 — 가장 강한 조합' },
  { name: '진입권', desc: '외국인이 유통시총 대비 규모 있게(15bp↑) + 꾸준히(3일 연속 or 거래대금 30%↑) 사는 중' },
  { name: '추세순항', desc: '주가가 오르는데도 외국인·기관이 계속 사 모음' },
  { name: '동시', desc: '외국인·기관 20일 동반 순매수' },
  { name: '매집주 눌림', desc: '반년간 사 모은 종목이 최근 20일 눌린 구간 — 과거엔 조정 매수 기회였음' },
  { name: '분배', desc: '외국인은 팔고, 주가는 버티고, 개인이 받아줌 — 조용히 물량 넘기는 중' },
  { name: '동반순매도', desc: '외국인·기관 둘 다 이탈 (장기 매집 맥락도 없음)' },
  { name: '단기반등', desc: '20일은 순매수지만 반년으로는 순매도 — 반등에 속지 말라는 경고' },
]

// 태그 뱃지 색상 시맨틱 — 백테스트 방향 기준. 강세(매수)=초록, 약세=빨강, 경고=주황, 신규=파랑.
// 장기동시는 검증 최강이라 가장 진한 초록으로 강조. (direction 폴백은 badgeCls에서 처리)
const TAG_STYLE: Record<string, string> = {
  장기동시: 'bg-accent/30 font-semibold text-accent',
  '정석(동시+진입권)': 'bg-accent/20 text-accent',
  진입권: 'bg-accent/15 text-accent',
  추세순항: 'bg-accent/20 text-accent',
  동시: 'bg-accent/10 text-accent',
  '매집주 눌림': 'bg-accent/15 text-accent',
  매도권: 'bg-down/20 text-down',
  동반순매도: 'bg-down/15 text-down',
  분배: 'bg-warning/20 text-warning',
  단기반등: 'bg-warning/15 text-warning',
  NEW: 'bg-blue/20 text-blue',
}

/** 뱃지 클래스 — TAG_STYLE 우선, 없으면 edges 방향으로 강세=초록/약세=빨강 폴백. */
function badgeCls(name: string, dir?: string): string {
  if (TAG_STYLE[name]) return TAG_STYLE[name]
  if (dir === '강세') return 'bg-accent/15 text-accent'
  if (dir === '약세') return 'bg-down/15 text-down'
  return 'bg-bg-surface text-t2'
}

const PRESET_LABELS: Record<string, string> = {
  default: '기본 (거래대금 10억·유통 500억↑)',
  large: '대형주 (유통 1조↑)',
  all: '전체',
}

const SHOW_LIMIT = 100

// 정렬 가능 컬럼 → FlowRow에서 값 뽑는 함수
type SortKey =
  | 'f_20d_bp' | 'f_streak' | 'f_5d_eok' | 'i_20d_bp' | 'absorb_5d_pct'
  | 'ret_20d_pct' | 'y_f_eok' | 'f_120d_bp' | 'verdict' | 'float_mcap_eok'
const SORT_GETTER: Record<SortKey, (r: FlowRow) => number> = {
  f_20d_bp: (r) => r.f_20d_bp,
  f_120d_bp: (r) => r.f_120d_bp,
  f_streak: (r) => r.f_streak,
  f_5d_eok: (r) => r.f_5d_eok,
  i_20d_bp: (r) => r.i_20d_bp,
  absorb_5d_pct: (r) => r.absorb_5d_pct ?? -Infinity,
  ret_20d_pct: (r) => r.ret_20d_pct ?? -Infinity,
  y_f_eok: (r) => r.y_f_eok,
  float_mcap_eok: (r) => r.float_mcap_eok,
  verdict: (r) => r.verdict?.edge ?? 0, // 판정 없는 행은 0 취급
}

export function StockFlowPage() {
  const [data, setData] = useState<RankingResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preset, setPreset] = useState('default')
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy')
  const [longOnly, setLongOnly] = useState(true) // 장기 정합(120일도 순매수)만 — 기본 ON
  const [excludeLongAccum, setExcludeLongAccum] = useState(true) // 매도 뷰: 장기매집(120D+) 제외 — 기본 ON
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('f_20d_bp')
  const [sortAsc, setSortAsc] = useState(false)
  const [showLegend, setShowLegend] = useState(false) // 태그 설명 패널 토글

  // 방향(매수/매도) 전환 시 기본 정렬 = 20D bp, 방향에 맞는 오름/내림
  const sortClick = (k: SortKey) => {
    if (sortKey === k) setSortAsc((v) => !v)
    else {
      setSortKey(k)
      setSortAsc(false) // 새 컬럼은 내림차순 시작
    }
  }
  const [selected, setSelected] = useState<{ code: string; name: string } | null>(null)
  // 관심종목 — localStorage. 트레이더 워크플로우 "내 종목 수급 살아있나" 상단 고정.
  const [watchlist, setWatchlist] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('flow.watchlist') || '[]'))
    } catch {
      return new Set()
    }
  })
  const toggleWatch = (code: string) => {
    setWatchlist((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      localStorage.setItem('flow.watchlist', JSON.stringify([...next]))
      return next
    })
  }

  // 로딩은 파생값 — 요청한 preset의 응답이 아직 없으면 로딩 중 (effect 내 동기 setState 회피)
  const loading = !error && (!data || data.preset !== preset)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/flow/ranking?preset=${preset}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        return r.json() as Promise<RankingResp>
      })
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [preset])

  const visible = useMemo(() => {
    if (!data) return []
    let rows = data.rows
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.code.includes(q))
    }
    // 장기 정합(장투 모드): 120일도 순매수인 종목만 — "장기 분산+단기 반등" 제거
    if (longOnly && direction === 'buy') rows = rows.filter((r) => r.long_up)
    // 매도 뷰 장기매집 제외: 120D 순매수(f120>0) 종목 숨김 — 백테스트상 장기매집주의 단기
    // 이탈은 오히려 +2.5% 강세(매집주 눌림)라 매도후보로 부적격. 해제 시 다시 노출.
    if (excludeLongAccum && direction === 'sell') rows = rows.filter((r) => !(r.f_120d_bp > 0))
    // 매도 뷰는 20D bp 정렬일 때만 오름차순이 자연스러움(약한 수급 위로). 그 외엔 sortKey 그대로.
    const asc = sortKey === 'f_20d_bp' ? (direction === 'sell' ? !sortAsc : sortAsc) : sortAsc
    const get = SORT_GETTER[sortKey]
    const sorted = [...rows].sort((a, b) => (asc ? get(a) - get(b) : get(b) - get(a)))
    return search.trim() ? sorted : sorted.slice(0, SHOW_LIMIT)
  }, [data, direction, longOnly, excludeLongAccum, search, sortKey, sortAsc])

  // 외인 20D 매집% 히트 컬러 임계값 — 표시 대상(visible) 내 분위 기준. 양/음 분리 대칭.
  const heat = useMemo(() => {
    const q = (arr: number[], p: number) => (arr.length ? arr[Math.floor(p * (arr.length - 1))] : null)
    const pos = visible.map((r) => r.f_20d_bp).filter((v) => v > 0).sort((a, b) => a - b)
    const neg = visible.map((r) => r.f_20d_bp).filter((v) => v < 0).sort((a, b) => a - b)
    return {
      posP90: q(pos, 0.9), // 상위 10% (진하게)
      posP75: q(pos, 0.75), // 상위 25% (옅게)
      negP10: q(neg, 0.1), // 하위 10% (진하게) — neg 오름차순이라 앞쪽이 가장 음수
      negP25: q(neg, 0.25), // 하위 25% (옅게)
    }
  }, [visible])

  // 요약 스트립 — 오늘 시장 수급의 전체 그림 (필터 전 전체 프리셋 기준)
  const summary = useMemo(() => {
    if (!data) return null
    const rows = data.rows
    const buyFav = rows.filter((r) => r.f_20d_bp > 0).length
    return {
      total: rows.length,
      buyFav,
      sellFav: rows.length - buyFav,
      entry: rows.filter((r) => r.entry_ok).length,
      exit: rows.filter((r) => r.exit_ok).length,
      both: rows.filter((r) => r.both_20d).length,
      trend: rows.filter((r) => r.trend_ride).length,
      dist: rows.filter((r) => r.is_distribution).length,
    }
  }, [data])

  // 관심종목 행 — 현재 로드된 랭킹(preset 적용)에서 매칭. 흐름 상태 판정 포함.
  const watchRows = useMemo(() => {
    if (!data || watchlist.size === 0) return []
    return data.rows.filter((r) => watchlist.has(r.code))
  }, [data, watchlist])

  const floatStale = useMemo(() => {
    if (!data || data.rows.length === 0) return null
    // 유통주식수 기준일이 as_of보다 오래 묵었으면 경고 (Finance_Data 크롤러 이슈 감지)
    const latestFloat = data.rows.reduce((m, r) => (r.float_date > m ? r.float_date : m), '')
    const ageDays = Math.round(
      (new Date(data.as_of).getTime() - new Date(latestFloat).getTime()) / 86_400_000
    )
    return ageDays > 45 ? { date: latestFloat, ageDays } : null
  }, [data])

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 컨트롤 */}
      <div className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
        <span className="text-sm font-medium text-t1">수급 랭킹</span>
        <div className="flex overflow-hidden rounded-sm border border-bg-surface">
          <button
            onClick={() => setDirection('buy')}
            className={`px-3 py-1 ${direction === 'buy' ? 'bg-up/20 text-up' : 'text-t3'}`}
          >
            매수 후보
          </button>
          <button
            onClick={() => setDirection('sell')}
            className={`px-3 py-1 ${direction === 'sell' ? 'bg-down/20 text-down' : 'text-t3'}`}
          >
            매도 후보
          </button>
        </div>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="rounded-sm bg-bg-surface px-2 py-1 text-t1 focus:outline-none"
        >
          {Object.entries(PRESET_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="종목명 / 코드"
          className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t3 focus:outline-none"
        />
        {direction === 'buy' && (
          <label
            className="flex cursor-pointer select-none items-center gap-1.5"
            title="장기 정합: 120일(반년)도 순매수인 종목만 — '장기 분산+단기 반등' 제거 (장투 모드)"
          >
            <input type="checkbox" checked={longOnly} onChange={(e) => setLongOnly(e.target.checked)} />
            <span className={longOnly ? 'text-accent' : 'text-t3'}>장기 정합만</span>
          </label>
        )}
        {direction === 'sell' && (
          <label
            className="flex cursor-pointer select-none items-center gap-1.5"
            title="장기매집 제외: 120일(반년) 순매수인 종목을 매도후보에서 숨김 — 장기매집주의 단기 이탈은 백테스트상 오히려 +2.5% 강세(매집주 눌림)라 매도후보 부적격. 해제하면 다시 노출(그 행의 '매집주 눌림' 초록 판정으로 이유 설명됨)"
          >
            <input
              type="checkbox"
              checked={excludeLongAccum}
              onChange={(e) => setExcludeLongAccum(e.target.checked)}
            />
            <span className={excludeLongAccum ? 'text-accent' : 'text-t3'}>장기매집 제외</span>
          </label>
        )}
        <div className="ml-auto flex items-center gap-3 text-t3">
          {data && (
            <>
              <span>
                기준일 <span className="text-t1">{data.as_of}</span>
                {data.is_partial && <span className="ml-1 text-warning">· 금일 수집 중 (전일 기준)</span>}
              </span>
              <span>
                {data.count}종목 / 표시 {visible.length}
              </span>
            </>
          )}
        </div>
      </div>

      {/* 요약 스트립 */}
      {summary && (
        <div className="panel flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-xs text-t3">
          <span className="font-medium text-t2">오늘의 수급</span>
          <span>
            외인 20D 순매수 <span className="font-semibold text-up">{summary.buyFav}</span>
            <span className="text-t4"> / 순매도 </span>
            <span className="font-semibold text-down">{summary.sellFav}</span>
          </span>
          <span>
            진입권 <span className="font-semibold text-warning">{summary.entry}</span>
            <span className="text-t4"> · 매도권 </span>
            <span className="font-semibold text-down">{summary.exit}</span>
          </span>
          <span>
            외인·기관 동시매수 <span className="font-semibold text-accent">{summary.both}</span>
          </span>
          <span>
            추세순항 <span className="font-semibold text-accent">{summary.trend}</span>
          </span>
          <span>
            분배 의심 <span className="font-semibold text-warning">{summary.dist}</span>
          </span>
          <button
            onClick={() => setShowLegend((v) => !v)}
            className="ml-auto rounded-sm border border-bg-surface bg-accent/20 px-2 py-0.5 text-accent hover:bg-accent/30"
          >
            {showLegend ? '태그 설명 닫기' : '태그 설명'}
          </button>
        </div>
      )}

      {/* 태그 범례 — 검증 edge·t는 API edges에서 동적 표시 (|t|<2면 유의성 미달 경고) */}
      {showLegend && data && (
        <div className="panel px-3 py-3 text-xs">
          <div className="mb-2 font-medium text-t2">태그 설명 — 백테스트로 검증한 수급 패턴</div>
          <div className="mb-3 rounded-sm bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-t3">
            <span className="font-medium text-warning">정렬 ≠ 추천</span> — 정렬은 수급 강도 순서일 뿐
            매수 매력 순위가 아닙니다. 상위권 내 세부 순위는 예측력이 없음이 측정됨(조건부 IC ≈ 0).
            종목 판단은 <span className="text-t2">판정·태그</span> 기준. 색상: 초록=강세 검증, 빨강/주황=약세·경고,
            파랑=신규.
          </div>
          <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
            {TAG_LEGEND.map((tag) => {
              const e = data.edges?.[tag.name]
              const weak = !e || Math.abs(e.t) < 2
              return (
                <div key={tag.name} className="flex flex-col gap-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-t1">{tag.name}</span>
                    {e ? (
                      <span className="tabular-nums">
                        <span className={signCls(e.edge)}>
                          {e.edge >= 0 ? '+' : ''}
                          {e.edge.toFixed(1)}%
                        </span>
                        <span className="ml-1 text-t4">t {e.t.toFixed(1)}</span>
                        {weak && <span className="ml-1 text-warning">· 유의성 미달 — 경고 참고용</span>}
                      </span>
                    ) : (
                      <span className="text-t4">측정값 없음</span>
                    )}
                  </div>
                  <div className="text-t3">{tag.desc}</div>
                </div>
              )
            })}
          </div>
          <div className="mt-3 border-t border-bg-surface/50 pt-2 text-[11px] leading-relaxed text-t4">
            초과수익 = 과거 2년, 해당 태그 종목의 이후 60일 시장(유니버스 평균) 대비. 검증 기준일{' '}
            {data.edges_as_of ?? '기본값(미갱신)'}. 자동 월간 갱신.
          </div>
        </div>
      )}

      {/* 관심종목 고정 섹션 — 내 종목 수급 브리핑 (흐름 깨진 것 강조) */}
      {watchRows.length > 0 && (
        <div className="panel p-3">
          <div className="mb-2 text-xs font-medium text-t2">
            관심종목 <span className="text-t3">({watchRows.length}) — 내 종목 수급 살아있나</span>
          </div>
          <table className="w-full text-xs tabular-nums">
            <tbody>
              {watchRows.map((r) => {
                const broken = r.f_streak < 0 || r.f_20d_bp < 0 // 외인 이탈 or 20D 순매도 전환
                return (
                  <tr
                    key={r.code}
                    onClick={() => setSelected({ code: r.code, name: r.name })}
                    className="cursor-pointer border-t border-bg-surface/40 hover:bg-bg-surface/30"
                  >
                    <td className="w-6 py-1.5 pl-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleWatch(r.code)
                        }}
                        className="text-warning hover:text-t1"
                        title="관심종목 해제"
                      >
                        ★
                      </button>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="text-t1">{r.name}</span>
                      <span className="ml-1.5 text-[10px] text-t3">{r.code}</span>
                    </td>
                    <td className={`px-3 py-1.5 text-right ${r.f_streak > 0 ? 'text-up' : r.f_streak < 0 ? 'text-down' : 'text-t3'}`}>
                      외인 {r.f_streak > 0 ? `+${r.f_streak}D` : r.f_streak < 0 ? `${r.f_streak}D` : '—'}
                    </td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${signCls(r.f_20d_bp)}`}>
                      {fmtPct(r.f_20d_bp)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-t2">
                      어제 <span className={signCls(r.y_f_eok)}>{fmtEok(r.y_f_eok)}</span>
                      <span className="text-t3"> / </span>
                      <span className={signCls(r.y_i_eok)}>{fmtEok(r.y_i_eok)}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {broken ? (
                        <span className="rounded-sm bg-down/15 px-1.5 py-0.5 text-[10px] text-down">흐름 약화</span>
                      ) : (
                        <span className="rounded-sm bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">유지</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 데이터 품질 경고 */}
      {floatStale && (
        <div className="panel px-3 py-2 text-xs text-warning">
          ⚠ 유통주식수 기준일 {floatStale.date} ({floatStale.ageDays}일 경과) — Finance_Data
          floating_shares 갱신 지연. 유통% 지표의 분모가 오래된 값입니다.
        </div>
      )}

      {error && <div className="panel p-3 text-xs text-down">로딩 실패: {error}</div>}
      {loading && <div className="panel p-3 text-xs text-t3">로딩 중…</div>}

      {/* 선택 종목 상세 차트 */}
      {selected && (
        <FlowDetail
          key={selected.code}
          code={selected.code}
          name={selected.name}
          onClose={() => setSelected(null)}
        />
      )}

      {/* 랭킹 테이블 — sticky thead (overflow-x-auto 없음: main이 스크롤 컨테이너) */}
      {data && !loading && (
        <div className="panel">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-bg-primary">
              <tr className="border-b border-bg-surface text-left text-t3">
                <th className="px-3 py-2 font-normal">#</th>
                <th className="w-6 py-2 font-normal" />
                <th className="px-3 py-2 font-normal">종목</th>
                <SortTh
                  k="float_mcap_eok"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  tip={{
                    title: '유통시총',
                    body: '유통주식수 × 현재가 (억원). 시장에서 실제 거래 가능한 시가총액 — 매집%의 분모.',
                  }}
                >
                  유통시총
                </SortTh>
                <th className="group relative px-3 py-2 text-left font-normal">
                  태그
                  <Tip
                    title="태그"
                    body="백테스트로 검증한 수급 패턴 뱃지. 초록=강세 검증(장기동시가 최상위), 빨강=약세, 주황=경고, 파랑=신규 진입."
                  />
                </th>
                <SortTh
                  k="verdict"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  tip={{
                    title: '판정 (검증 초과수익)',
                    body: '이 종목에 해당하는 패턴의 과거 2년 이후 60일 시장(유니버스 평균) 대비 평균 초과수익. 대표 패턴 1개 표시(|edge| 최대). 개별 종목 보장이 아닌 패턴 평균.',
                  }}
                >
                  판정
                </SortTh>
                <SortTh
                  k="f_streak"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  tip={{ title: '연속', body: '외국인 순매수(+)/순매도(−) 연속 영업일 수. 지속성 판단.' }}
                >
                  연속
                </SortTh>
                <SortTh
                  k="f_5d_eok"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  tip={{ title: '외인 5D', body: '외국인 최근 5일 순매수 합 (억원). 단기 유입 세기.' }}
                >
                  외인 5D
                </SortTh>
                <SortTh
                  k="f_20d_bp"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  bright
                  tip={{
                    title: '외인 20D 매집% (정렬 기본축)',
                    body: (
                      <>
                        <div>외국인 20일 누적 순매수 ÷ 유통시총. 아래 작은 값=120일(반년) 장기 추세: 20D는 +인데 120D가 −면 단기 반등.</div>
                        <div className="mt-1 text-warning">
                          정렬 ≠ 추천 — 수급 강도 순서일 뿐 매수 매력 순위가 아님. 상위권 내 세부 순위는 예측력이
                          없음이 측정됨(조건부 IC ≈ 0). 종목 판단은 판정·태그 기준.
                        </div>
                        <div className="mt-1 text-t3">검증: 정렬축 Rank IC h60 +0.05 (t7) — 방향 자체는 유효.</div>
                      </>
                    ),
                  }}
                >
                  외인 20D 매집%
                  <div className="text-[10px] font-normal text-t3">(아래 120D=장기)</div>
                </SortTh>
                <SortTh
                  k="i_20d_bp"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  align="right"
                  tip={{
                    title: '기관 20D 매집%',
                    body: '기관 20일 누적 순매수 ÷ 유통시총 (연기금 포함). 아래 작은 값=120일(반년) 장기 추세.',
                  }}
                >
                  기관 20D%
                  <div className="text-[10px] font-normal text-t3">(아래 120D=장기)</div>
                </SortTh>
                <SortTh
                  k="absorb_5d_pct"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  align="right"
                  tip={{
                    title: '흡수율',
                    body: '최근 5일 (외인+기관) 순매수 ÷ 거래대금. 높을수록 진성 매집 — 낮으면 소음.',
                  }}
                >
                  흡수율
                </SortTh>
                <SortTh
                  k="ret_20d_pct"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  align="right"
                  tip={{ title: '20D 수익률', body: '수정종가 기준 20일 수익률 (20일 전 대비).' }}
                >
                  20D 수익률
                </SortTh>
                <SortTh
                  k="y_f_eok"
                  cur={sortKey}
                  asc={sortAsc}
                  onClick={sortClick}
                  align="right"
                  tip={{ title: '어제 (외/기)', body: '전일 외국인 / 기관 순매수 (억원). 외인 기준 정렬.' }}
                >
                  어제 (외/기)
                </SortTh>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                const streakCls = r.f_streak > 0 ? 'text-up' : r.f_streak < 0 ? 'text-down' : 'text-t3'
                const retCls =
                  r.ret_20d_pct == null ? 'text-t3' : r.ret_20d_pct > 0 ? 'text-up' : r.ret_20d_pct < 0 ? 'text-down' : 'text-t3'
                const isSel = selected?.code === r.code
                // 매수 아키타입 뱃지 — 배타 단일 (장기동시 > 추세순항 > 동시). verdict 우선순위와 동일 승격.
                const archetype = r.long_both ? '장기동시' : r.trend_ride ? '추세순항' : r.both_20d ? '동시' : null
                const showEntry = direction === 'buy' && r.entry_ok && !r.long_both
                const showExit = direction === 'sell' && r.exit_ok
                const showShort = direction === 'buy' && r.short_bounce
                const hasTag = r.is_new || archetype || showEntry || showExit || r.is_distribution || showShort
                return (
                  <tr
                    key={r.code}
                    onClick={() => setSelected(isSel ? null : { code: r.code, name: r.name })}
                    className={`cursor-pointer border-t border-bg-surface/40 hover:bg-bg-surface/30 ${
                      isSel ? 'bg-bg-surface/50' : ''
                    }`}
                  >
                    <td className="px-3 py-1.5 text-t3">{i + 1}</td>
                    <td className="w-6 py-1.5 text-center">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleWatch(r.code)
                        }}
                        className={watchlist.has(r.code) ? 'text-warning' : 'text-t4 hover:text-t2'}
                        title={watchlist.has(r.code) ? '관심종목 해제' : '관심종목 추가'}
                      >
                        {watchlist.has(r.code) ? '★' : '☆'}
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="text-t1">{r.name}</div>
                      <div className="text-[10px] text-t3">
                        {r.code} · {r.sector ?? r.market}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-t2">
                      {Math.round(r.float_mcap_eok).toLocaleString()}억
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {r.is_new && (
                          <span className={`rounded-sm px-1 text-[10px] ${badgeCls('NEW')}`}>NEW</span>
                        )}
                        {archetype && (
                          <span
                            className={`rounded-sm px-1 text-[10px] ${badgeCls(archetype)}`}
                            title={
                              archetype === '장기동시'
                                ? '장기동시: 외인·기관이 20일·120일 모두 순매수 (4중 겹침) — 검증된 최상위 조합'
                                : archetype === '추세순항'
                                  ? '추세순항: 외인·기관 20D 동시 순매수 + 20D 주가 상승 — 상승추세 동반 매집'
                                  : '동시: 외인·기관 20D 동반 순매수'
                            }
                          >
                            {archetype}
                          </span>
                        )}
                        {showEntry && (
                          <span
                            className={`rounded-sm px-1 text-[10px] ${badgeCls('진입권')}`}
                            title="진입권: 20D ≥ 15bp + 지속성(연속 3D↑ 또는 5D가 일평균 거래대금의 30%↑) — 이벤트성 스파이크 배제"
                          >
                            진입권
                          </span>
                        )}
                        {showExit && (
                          <span
                            className={`rounded-sm px-1 text-[10px] ${badgeCls('매도권')}`}
                            title="매도권: 20D ≤ −15bp + 지속성 — 이벤트성 스파이크 배제"
                          >
                            매도권
                          </span>
                        )}
                        {r.is_distribution && (
                          <span
                            className={`rounded-sm px-1 text-[10px] ${badgeCls('분배')}`}
                            title="분배 의심: 외인 5일 순매도 + 주가 방어(5D −2% 이내) + 개인이 물량 받음 — 조용히 무너지기 전 신호"
                          >
                            분배
                          </span>
                        )}
                        {showShort && (
                          <span
                            className={`rounded-sm px-1 text-[10px] ${badgeCls('단기반등')}`}
                            title="단기반등: 20일은 순매수 상위지만 120일(반년)은 순매도 — 장기 분산 중 단기 반등. 장투 주의"
                          >
                            단기반등
                          </span>
                        )}
                        {!hasTag && <span className="text-t4">—</span>}
                      </div>
                    </td>
                    <td className="group relative whitespace-nowrap px-3 py-1.5 text-right">
                      {r.verdict ? (
                        <>
                          <span className="tabular-nums">
                            <span className="text-t3">{r.verdict.pattern}</span>{' '}
                            <span className={`font-semibold ${signCls(r.verdict.edge)}`}>
                              {fmtEdge(r.verdict.edge)}
                            </span>
                          </span>
                          <Tip
                            align="right"
                            title={`${r.verdict.pattern} · 검증 초과수익`}
                            body={
                              <>
                                <div>
                                  과거 2년, 이 패턴 종목은 이후 60일 시장(유니버스 평균) 대비 평균{' '}
                                  <span className={signCls(r.verdict.edge)}>{fmtEdge(r.verdict.edge)}</span> (t{' '}
                                  {r.verdict.t.toFixed(1)}). 개별 종목 보장이 아닌 패턴 평균.
                                </div>
                                {r.verdict.others.length > 0 && (
                                  <div className="mt-1 text-t3">
                                    동시 태그:{' '}
                                    {r.verdict.others
                                      .map((o) => `${o.pattern} ${fmtEdge(o.edge)}`)
                                      .join(', ')}
                                  </div>
                                )}
                                {data?.edges_as_of && (
                                  <div className="mt-1 text-t4">검증 기준일 {data.edges_as_of}</div>
                                )}
                              </>
                            }
                          />
                        </>
                      ) : (
                        <span className="text-t4">—</span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${streakCls}`}>
                      {r.f_streak > 0 ? `+${r.f_streak}D` : r.f_streak < 0 ? `${r.f_streak}D` : '—'}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${signCls(r.f_5d_eok)}`}>{fmtEok(r.f_5d_eok)}</td>
                    <td className={`px-3 py-1.5 text-right ${heatCls(r.f_20d_bp, heat)}`}>
                      <div className={`font-semibold ${signCls(r.f_20d_bp)}`}>{fmtPct(r.f_20d_bp)}</div>
                      <div className={`text-[10px] ${signCls(r.f_120d_bp)}`}>
                        120D {fmtPct(r.f_120d_bp)}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <div className={signCls(r.i_20d_bp)}>{fmtPct(r.i_20d_bp)}</div>
                      <div className={`text-[10px] ${signCls(r.i_120d_bp)}`}>
                        120D {fmtPct(r.i_120d_bp)}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right text-t2">
                      {r.absorb_5d_pct != null ? `${r.absorb_5d_pct.toFixed(1)}%` : '—'}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${retCls}`}>
                      {r.ret_20d_pct != null ? `${r.ret_20d_pct > 0 ? '+' : ''}${r.ret_20d_pct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-t2">
                      <span className={signCls(r.y_f_eok)}>{fmtEok(r.y_f_eok)}</span>
                      <span className="text-t3"> / </span>
                      <span className={signCls(r.y_i_eok)}>{fmtEok(r.y_i_eok)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="p-4 text-center text-xs text-t3">조건에 맞는 종목이 없습니다</div>
          )}
        </div>
      )}

      {/* 데이터 규약 안내 */}
      <div className="panel px-3 py-2 text-[11px] leading-relaxed text-t3">
        매집% = N일 누적 순매수 ÷ 유통시총 × 100 —{' '}
        <span className="text-t2">&ldquo;유통물량의 몇 %를 순매수했나&rdquo;</span> (예: +14.4% = 20일간
        외인이 유통주식의 14.4%를 순매수). 기관에 연기금 포함(별도 가산 금지). D일 수급은 장 마감 후
        확정 — 신호는 <span className="text-t2">D+1 시가부터 실행 가능</span>. 매도 후보는 같은 지표의
        오름차순. 행 클릭 시 상세 차트.
      </div>
    </div>
  )
}

function SortTh({
  k,
  cur,
  asc,
  onClick,
  tip,
  align = 'center',
  bright,
  children,
}: {
  k: SortKey
  cur: SortKey
  asc: boolean
  onClick: (k: SortKey) => void
  tip?: { title: string; body: ReactNode }
  align?: 'center' | 'right'
  bright?: boolean
  children: ReactNode
}) {
  const active = cur === k
  return (
    <th
      onClick={() => onClick(k)}
      className={`group relative cursor-pointer select-none px-3 py-2 text-right font-normal hover:text-t1 ${
        active || bright ? 'text-t1' : ''
      }`}
    >
      {children} <span className="text-t3">{active ? (asc ? '▲' : '▼') : '↕'}</span>
      {tip && <Tip title={tip.title} body={tip.body} align={align} />}
    </th>
  )
}

function signCls(v: number): string {
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3'
}

/** 검증 초과수익 표기. +3.6% / −2.1%. */
function fmtEdge(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

/** 스타일된 hover 툴팁 — native title 대체 (CSS만). 부모에 `group relative` 필요. */
function Tip({
  title,
  body,
  align = 'center',
}: {
  title: string
  body: ReactNode
  align?: 'center' | 'right'
}) {
  return (
    <div
      className={`pointer-events-none absolute top-full z-30 mt-1 hidden w-64 rounded-sm bg-bg-surface-2 p-2 text-left text-[11px] font-normal normal-case leading-relaxed text-t2 shadow-lg group-hover:block ${
        align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
      }`}
    >
      <div className="mb-0.5 font-semibold text-t1">{title}</div>
      {body}
    </div>
  )
}

type Heat = { posP90: number | null; posP75: number | null; negP10: number | null; negP25: number | null }
/** 외인 20D 매집% 히트 배경 — 표시 대상 내 분위. 상위/하위 10%=진하게, 25%=옅게. 낮은 opacity로 가독성 유지. */
function heatCls(v: number, h: Heat): string {
  if (v > 0 && h.posP90 != null) {
    if (v >= h.posP90) return 'bg-up/20'
    if (h.posP75 != null && v >= h.posP75) return 'bg-up/[0.08]'
  }
  if (v < 0 && h.negP10 != null) {
    if (v <= h.negP10) return 'bg-down/20'
    if (h.negP25 != null && v <= h.negP25) return 'bg-down/[0.08]'
  }
  return ''
}

/** bp → 유통% 표기. 1444bp = "+14.4%". */
function fmtPct(bp: number): string {
  return `${bp >= 0 ? '+' : ''}${(bp / 100).toFixed(1)}%`
}

function fmtEok(v: number): string {
  const s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1)
  return `${v > 0 ? '+' : ''}${s}억`
}
