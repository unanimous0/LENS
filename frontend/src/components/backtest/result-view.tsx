import { useMemo, useState } from 'react'

import type { CatalogIndex } from './catalog'
import { ExcessHistogram } from './histogram'
import { fmtPct, fmtSigned, signCls } from './format'
import { PortfolioView } from './portfolio-view'
import { type Attempts, type BacktestResult, type Benchmark, type Episode, REASON_LABEL } from './types'

/** 우측 결과 뷰 — 백엔드 결과 포맷팅만 (지표 재계산 없음). */
export function ResultView({ result, idx }: { result: BacktestResult; idx?: CatalogIndex }) {
  const { summary, episodes, warnings, meta } = result
  const isPortfolio = result.mode === 'portfolio' && result.portfolio != null
  const excessValues = useMemo(
    () => episodes.map((e) => e.excess_pct).filter((v): v is number => v != null),
    [episodes],
  )
  const rankByLabel =
    result.portfolio?.rank_by != null
      ? idx?.byKey.get(result.portfolio.rank_by)?.label ?? result.portfolio.rank_by
      : null

  return (
    <div className="flex flex-col gap-3">
      {/* 다중검정 카운터 */}
      {result.attempts && <AttemptsBanner attempts={result.attempts} />}

      {/* 실행 메타 */}
      <div className="panel px-3 py-2 text-xs leading-relaxed text-t3">
        <span className="tabular-nums text-t2">
          {meta.period.start} ~ {meta.period.end}
        </span>{' '}
        · 유니버스 <span className="tabular-nums text-t2">{meta.universe.n_stocks.toLocaleString()}</span>종목
        <span className="text-t4">
          {' '}
          ({meta.universe.markets.join('·')} · 거래대금 {meta.universe.min_adv_eok}억↑ · 시총{' '}
          {meta.universe.min_mcap_eok}억↑)
        </span>{' '}
        · 에피소드 <span className="tabular-nums text-t2">{summary.n_episodes.toLocaleString()}</span>
        <span className="text-t4">
          {' '}
          · 벤치마크 {BENCH_LABELS[meta.benchmark] ?? meta.benchmark} · 패널{' '}
          {Object.entries(meta.panel_versions)
            .map(([k, v]) => `${k} ${v}`)
            .join(' / ')}
        </span>
      </div>

      {/* 경고 배지 */}
      {warnings.length > 0 && (
        <div className="flex flex-col gap-1">
          {warnings.map((w, i) => {
            const strong = /표본 부족|same_close/.test(w)
            return (
              <div
                key={i}
                className={`rounded-sm px-2 py-1.5 text-xs leading-relaxed ${
                  strong ? 'bg-warning/10 text-warning' : 'bg-bg-surface/40 text-t4'
                }`}
              >
                {strong ? '⚠ ' : ''}
                {w}
              </div>
            )
          })}
        </div>
      )}

      {/* 포트폴리오 성과 (자본 제약) */}
      {isPortfolio && result.portfolio && (
        <PortfolioView portfolio={result.portfolio} benchmark={meta.benchmark as Benchmark} rankByLabel={rankByLabel} />
      )}

      {/* 이벤트 스터디 관점 — portfolio 모드에선 자본 무제약 산출을 구분 표기 */}
      {isPortfolio && (
        <div className="mt-1 px-1">
          <h2 className="text-[13px] font-semibold text-t1">용량 제약 없는 이벤트 스터디 관점</h2>
          <p className="text-[11px] leading-relaxed text-t4">
            아래는 자본 제약을 걸지 않고 모든 진입 신호를 잡았을 때의 순수 edge — 방향·유의성 판단용
            (위 포트폴리오와 별개).
          </p>
        </div>
      )}

      {/* 요약 스탯 스트립 */}
      <div className="panel grid grid-cols-3 gap-px overflow-hidden bg-bg-surface/30 sm:grid-cols-6">
        <Stat label="평균 초과" value={fmtPct(summary.avg_excess_pct)} cls={signCls(summary.avg_excess_pct)} />
        <Stat label="중앙 초과" value={fmtPct(summary.median_excess_pct)} cls={signCls(summary.median_excess_pct)} />
        <Stat
          label="승률"
          value={summary.win_rate == null ? '—' : `${(summary.win_rate * 100).toFixed(1)}%`}
        />
        <Stat
          label="t값"
          value={summary.t_value == null ? '—' : summary.t_value.toFixed(2)}
          cls={summary.t_value != null && Math.abs(summary.t_value) >= 2 ? (summary.t_value > 0 ? 'text-up' : 'text-down') : 'text-t3'}
          tip={summary.t_value != null && Math.abs(summary.t_value) >= 2 ? '유의 (|t|≥2)' : '유의성 미달'}
        />
        <Stat
          label="평균 보유일"
          value={summary.avg_holding_days == null ? '—' : `${summary.avg_holding_days}`}
        />
        <Stat label="에피소드" value={summary.n_episodes.toLocaleString()} />
      </div>

      {/* 초과수익 분포 */}
      <div className="panel p-3">
        <div className="mb-1 text-xs text-t3">
          초과수익 분포 — 에피소드별 {meta.benchmark === 'universe_avg' ? '유니버스 평균 대비' : '절대'} 수익%.
          0 기준 왼쪽=열위·오른쪽=우위.
        </div>
        <ExcessHistogram values={excessValues} />
      </div>

      {/* 청산 사유 분해 + 연/월 테이블 */}
      <div className="grid gap-3 lg:grid-cols-2">
        <ReasonBreakdown episodes={episodes} breakdown={summary.exit_reason_breakdown} total={summary.n_episodes} />
        <PeriodTables byYear={summary.by_year_avg_excess} byMonth={summary.by_month_avg_excess} />
      </div>

      {/* 에피소드 테이블 */}
      <EpisodeTable episodes={episodes} names={meta.stock_names ?? {}} />

      {/* 방법론 각주 */}
      <div className="panel px-3 py-2.5 text-xs leading-relaxed text-t4">
        방법론 레일 (사용자 변경 불가): 신호는 D 종가 데이터로만(trailing) · 가격은 수정주가 · 진입/청산은
        선택한 체결 시점(기본 D+1 시가) · 손절/익절은 종가 판정 후 다음날 체결 · 벤치마크는 유니버스
        adj_open 로그수익 평균 기하 누적(Blume-Stambaugh). t값은 에피소드 중첩으로 팽창하니 보수적으로
        해석. 절대치보다 상대 비교용(단일 레짐·생존편향 — backtest.md §4·§9).
      </div>
    </div>
  )
}

const BENCH_LABELS: Record<string, string> = {
  universe_avg: '유니버스 평균',
  kospi: 'KOSPI 종합',
  kosdaq: 'KOSDAQ 종합',
  none: '없음',
}

function AttemptsBanner({ attempts }: { attempts: Attempts }) {
  const repeated = attempts.same_spec > 1
  return (
    <div
      className={`rounded-sm px-3 py-2 text-xs leading-relaxed ${
        repeated ? 'bg-warning/10 text-warning' : 'bg-bg-surface/40 text-t4'
      }`}
    >
      {repeated ? '⚠ ' : ''}이 전략(동일 조건) 시도{' '}
      <span className="font-medium tabular-nums">{attempts.same_spec.toLocaleString()}</span>회 · 전체 실험{' '}
      <span className="tabular-nums">{attempts.total_runs.toLocaleString()}</span>회
      {repeated && ' — 반복 튜닝으로 얻은 결과임을 감안하세요 (다중검정).'}
    </div>
  )
}

function Stat({
  label,
  value,
  cls = 'text-t1',
  tip,
}: {
  label: string
  value: string
  cls?: string
  tip?: string
}) {
  return (
    <div className="bg-bg-primary px-3 py-2" title={tip}>
      <div className="text-[11px] text-t4">{label}</div>
      <div className={`tabular-nums text-sm font-medium ${cls}`}>{value}</div>
    </div>
  )
}

function ReasonBreakdown({
  episodes,
  breakdown,
  total,
}: {
  episodes: Episode[]
  breakdown: Record<string, number>
  total: number
}) {
  // 사유별 평균 초과 — 반환된 에피소드 excess를 그룹 평균 (재계산 아님, 표시용 집계).
  const avgByReason = useMemo(() => {
    const acc: Record<string, { sum: number; n: number }> = {}
    for (const e of episodes) {
      if (e.excess_pct == null) continue
      const a = (acc[e.exit_reason] ??= { sum: 0, n: 0 })
      a.sum += e.excess_pct
      a.n += 1
    }
    const out: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(acc)) out[k] = v.n ? v.sum / v.n : null
    return out
  }, [episodes])

  const rows = Object.entries(breakdown).sort((a, b) => b[1] - a[1])

  return (
    <div className="panel p-3">
      <div className="mb-1.5 text-xs text-t3">청산 사유 분해</div>
      <table className="w-full text-[13px] tabular-nums">
        <thead>
          <tr className="text-t4">
            <th className="py-0.5 text-left font-normal">사유</th>
            <th className="py-0.5 text-right font-normal">건수</th>
            <th className="py-0.5 text-right font-normal">비중</th>
            <th className="py-0.5 text-right font-normal">평균 초과</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([reason, count]) => {
            const avg = avgByReason[reason] ?? null
            return (
              <tr key={reason} className="border-t border-bg-surface/40">
                <td className="py-1 text-t2">{REASON_LABEL[reason] ?? reason}</td>
                <td className="py-1 text-right text-t2">{count.toLocaleString()}</td>
                <td className="py-1 text-right text-t3">{total ? ((count / total) * 100).toFixed(1) : '0'}%</td>
                <td className={`py-1 text-right ${signCls(avg)}`}>{fmtPct(avg)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PeriodTables({
  byYear,
  byMonth,
}: {
  byYear: Record<string, number | null>
  byMonth: Record<string, number | null>
}) {
  const [showMonth, setShowMonth] = useState(false)
  const years = Object.entries(byYear)
  const months = Object.entries(byMonth)
  return (
    <div className="panel p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs text-t3">기간별 평균 초과수익</span>
        <button
          onClick={() => setShowMonth((v) => !v)}
          className="rounded-sm border border-bg-surface px-1.5 py-0.5 text-[11px] text-t3 hover:text-t1"
        >
          {showMonth ? '연도별' : '월별'}
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        <table className="w-full text-[13px] tabular-nums">
          <tbody>
            {(showMonth ? months : years).map(([k, v]) => (
              <tr key={k} className="border-t border-bg-surface/30">
                <td className="py-0.5 text-t3">{k}</td>
                <td className={`py-0.5 text-right ${signCls(v)}`}>{fmtPct(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type SortKey = 'excess_pct' | 'ret_pct' | 'holding_days' | 'entry_date'

function EpisodeTable({ episodes, names }: { episodes: Episode[]; names: Record<string, string> }) {
  const [sortKey, setSortKey] = useState<SortKey>('excess_pct')
  const [asc, setAsc] = useState(false)
  const [shown, setShown] = useState(100)

  const sorted = useMemo(() => {
    const arr = [...episodes]
    arr.sort((a, b) => {
      let av: number | string
      let bv: number | string
      if (sortKey === 'entry_date') {
        av = a.entry_date
        bv = b.entry_date
      } else {
        av = a[sortKey] ?? -Infinity
        bv = b[sortKey] ?? -Infinity
      }
      if (av < bv) return asc ? -1 : 1
      if (av > bv) return asc ? 1 : -1
      return 0
    })
    return arr
  }, [episodes, sortKey, asc])

  const click = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v)
    else {
      setSortKey(k)
      setAsc(false)
    }
  }
  const arrow = (k: SortKey) => (sortKey === k ? <span className="text-t4">{asc ? ' ▲' : ' ▼'}</span> : null)

  return (
    <div className="panel p-3">
      <div className="mb-1.5 text-xs text-t3">
        에피소드 <span className="tabular-nums">{episodes.length.toLocaleString()}</span>건 (상위{' '}
        {Math.min(shown, episodes.length).toLocaleString()} 표시)
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] tabular-nums">
          <thead className="text-t4">
            <tr>
              <th className="px-2 py-1 text-left font-normal">종목</th>
              <th className="px-2 py-1 text-right font-normal cursor-pointer" onClick={() => click('entry_date')}>
                진입일
                {arrow('entry_date')}
              </th>
              <th className="px-2 py-1 text-right font-normal">청산일</th>
              <th className="px-2 py-1 text-left font-normal">사유</th>
              <th className="px-2 py-1 text-right font-normal cursor-pointer" onClick={() => click('holding_days')}>
                보유일
                {arrow('holding_days')}
              </th>
              <th className="px-2 py-1 text-right font-normal cursor-pointer" onClick={() => click('ret_pct')}>
                수익%
                {arrow('ret_pct')}
              </th>
              <th className="px-2 py-1 text-right font-normal cursor-pointer" onClick={() => click('excess_pct')}>
                초과%
                {arrow('excess_pct')}
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, shown).map((e, i) => (
              <tr key={`${e.stock}-${e.entry_date}-${i}`} className="border-t border-bg-surface/30 hover:bg-bg-surface/20">
                <td className="px-2 py-1">
                  <span className="text-t1">{names[e.stock] ?? e.stock}</span>
                  <span className="ml-1.5 text-[11px] text-t4">{e.stock}</span>
                </td>
                <td className="px-2 py-1 text-right text-t3">{e.entry_date}</td>
                <td className="px-2 py-1 text-right text-t3">{e.exit_date}</td>
                <td className="px-2 py-1">
                  <span className="text-t2">{REASON_LABEL[e.exit_reason] ?? e.exit_reason}</span>
                  {e.ongoing && (
                    <span className="ml-1 rounded-sm bg-blue/20 px-1 text-[11px] text-blue">보유중</span>
                  )}
                </td>
                <td className="px-2 py-1 text-right text-t2">{e.holding_days}</td>
                <td className={`px-2 py-1 text-right ${signCls(e.ret_pct)}`}>{fmtSigned(e.ret_pct)}</td>
                <td className={`px-2 py-1 text-right ${signCls(e.excess_pct)}`}>{fmtSigned(e.excess_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < episodes.length && (
        <button
          onClick={() => setShown((v) => v + 100)}
          className="mt-2 w-full rounded-sm border border-bg-surface py-1 text-xs text-t3 hover:text-t1"
        >
          더보기 (+100)
        </button>
      )}
    </div>
  )
}
