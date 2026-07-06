import { EquityCurve } from './equity-curve'
import { fmtPct, fmtSigned, signCls } from './format'
import type { Benchmark, PortfolioResult } from './types'
import { Tip } from './ui'

const BENCH_LABEL: Record<Benchmark, string> = {
  universe_avg: '유니버스 평균',
  kospi: 'KOSPI 종합',
  kosdaq: 'KOSDAQ 종합',
  none: '없음',
}

/** 포트폴리오 모드 결과 — 스탯 스트립 + 에쿼티 커브 + 연도별 테이블. */
export function PortfolioView({
  portfolio,
  benchmark,
  rankByLabel,
  holdoutStart,
}: {
  portfolio: PortfolioResult
  benchmark: Benchmark
  rankByLabel: string | null
  holdoutStart?: string | null // 개봉 시 에쿼티 커브 holdout 시작 구분선
}) {
  const p = portfolio
  const hasBench = benchmark !== 'none'
  const mddTip =
    p.mdd_peak_date && p.mdd_trough_date ? `고점 ${p.mdd_peak_date} → 저점 ${p.mdd_trough_date}` : undefined
  const missedTip = `진입 ${p.n_entered.toLocaleString()} · 미체결 ${p.missed_signals.toLocaleString()} · 중복 ${p.dup_skipped.toLocaleString()} (합 ${(
    p.n_entered +
    p.missed_signals +
    p.dup_skipped
  ).toLocaleString()} = 후보 신호). 슬롯(${p.n_slots})이 차서 못 잡은 신호가 미체결.`

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-[13px] font-semibold text-t1">포트폴리오 성과 (자본 제약)</h2>
        <span className="text-[11px] text-t4 tabular-nums">
          슬롯 {p.n_slots} · {p.start_date} ~ {p.end_date}
          {rankByLabel ? ` · 우선순위 ${rankByLabel}` : ' · 선착순'}
        </span>
      </div>

      {/* 스탯 스트립 */}
      <div className="panel grid grid-cols-3 gap-px overflow-hidden bg-bg-surface/30 sm:grid-cols-4 lg:grid-cols-7">
        <PStat label="누적수익" value={fmtPct(p.total_return_pct)} cls={signCls(p.total_return_pct)} />
        <PStat label="CAGR" value={fmtPct(p.cagr_pct)} cls={signCls(p.cagr_pct)} />
        <PStat label="MDD" value={fmtPct(p.mdd_pct)} cls={signCls(p.mdd_pct)} tip={mddTip} />
        <PStat
          label="샤프"
          value={p.sharpe == null ? '—' : p.sharpe.toFixed(2)}
          cls={p.sharpe == null ? 'text-t3' : signCls(p.sharpe)}
          tip="일별 초과수익(전략−벤치) 연율화. 벤치 없으면 절대수익 기준."
        />
        <PStat
          label="회전율"
          value={p.annual_turnover == null ? '—' : `${p.annual_turnover.toFixed(2)}x`}
          tip="연간 진입 notional / 평균 에쿼티 (편도 배치 비율)."
        />
        <PStat label="평균 보유" value={`${p.avg_positions.toFixed(1)}`} tip={`슬롯 ${p.n_slots} 중 일평균 투자 슬리브 수.`} />
        <PStat
          label="미체결 신호"
          value={p.missed_signals.toLocaleString()}
          cls="text-t2"
          tip={missedTip}
        />
      </div>

      {/* ADV 체결 캡 (활성 시에만) */}
      {p.adv_cap && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm bg-bg-surface/20 px-3 py-2 text-[11px] text-t4">
          <span className="font-medium text-t3">ADV 체결 캡</span>
          <span className="tabular-nums">
            자본 {p.adv_cap.capital_eok.toLocaleString()}억 · ADV20의 {p.adv_cap.adv_cap_pct}%
          </span>
          <span className="tabular-nums">축소 진입 {p.adv_cap.capped_entries.toLocaleString()}건</span>
          <span className="tabular-nums">
            평균 체결률{' '}
            <span className={p.adv_cap.avg_fill_ratio != null && p.adv_cap.avg_fill_ratio < 50 ? 'text-warning' : 'text-t3'}>
              {p.adv_cap.avg_fill_ratio == null ? '—' : `${p.adv_cap.avg_fill_ratio}%`}
            </span>
          </span>
        </div>
      )}

      {/* 에쿼티 커브 */}
      <div className="panel p-3">
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-t3">에쿼티 커브 (첫 진입일 = 1.0)</span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-3 rounded-sm bg-accent" />
            <span className="text-t3">전략</span>
          </span>
          {hasBench && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: '#8e8e93' }} />
              <span className="text-t3">{BENCH_LABEL[benchmark]}</span>
            </span>
          )}
          {holdoutStart && (
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-px" style={{ background: '#ff9f0a' }} />
              <span className="text-t3">holdout 시작 ({holdoutStart})</span>
            </span>
          )}
        </div>
        <EquityCurve curve={p.equity_curve} hasBenchmark={hasBench} holdoutStart={holdoutStart} />
      </div>

      {/* 연도별 테이블 */}
      {p.by_year.length > 0 && (
        <div className="panel p-3">
          <div className="mb-1.5 text-xs text-t3">연도별 수익</div>
          <table className="w-full text-[13px] tabular-nums">
            <thead className="text-t4">
              <tr>
                <th className="py-0.5 text-left font-normal">연도</th>
                <th className="py-0.5 text-right font-normal">전략</th>
                {hasBench && <th className="py-0.5 text-right font-normal">{BENCH_LABEL[benchmark]}</th>}
                {hasBench && <th className="py-0.5 text-right font-normal">초과</th>}
              </tr>
            </thead>
            <tbody>
              {p.by_year.map((y) => (
                <tr key={y.year} className="border-t border-bg-surface/40">
                  <td className="py-1 text-t3">{y.year}</td>
                  <td className={`py-1 text-right ${signCls(y.strategy_pct)}`}>{fmtSigned(y.strategy_pct)}</td>
                  {hasBench && (
                    <td className={`py-1 text-right ${signCls(y.benchmark_pct)}`}>{fmtSigned(y.benchmark_pct)}</td>
                  )}
                  {hasBench && (
                    <td className={`py-1 text-right ${signCls(y.excess_pct)}`}>{fmtSigned(y.excess_pct)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PStat({
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
    <div className="group relative bg-bg-primary px-3 py-2">
      <div className="flex items-center gap-1 text-[11px] text-t4">
        {label}
        {tip && <span className="cursor-help text-t4">ⓘ</span>}
      </div>
      <div className={`tabular-nums text-sm font-medium ${cls}`}>{value}</div>
      {tip && <Tip title={label} body={<div>{tip}</div>} align="left" />}
    </div>
  )
}
