import { useEffect, useState } from 'react'

import { fmtPct, signCls } from './format'
import type { RunRecord } from './types'

/** 실행 이력 패널 (접이식) — GET /runs 전체(최신순). 요약만, 재실행 없음. */
export function RunHistory({ refreshToken }: { refreshToken: number }) {
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/backtest/runs?limit=30')
      .then((r) => (r.ok ? (r.json() as Promise<RunRecord[]>) : []))
      .then((d) => {
        if (!cancelled) {
          setRuns(d)
          setLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  if (loaded && runs.length === 0) return null

  return (
    <div className="panel p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-xs text-t3 hover:text-t1"
      >
        <span>
          실행 이력 <span className="tabular-nums text-t4">({runs.length})</span>
        </span>
        <span className="text-t4">{open ? '접기 ▲' : '펼치기 ▼'}</span>
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-[13px] tabular-nums">
            <thead className="text-t4">
              <tr>
                <th className="px-2 py-1 text-left font-normal">시각</th>
                <th className="px-2 py-1 text-left font-normal">모드</th>
                <th className="px-2 py-1 text-left font-normal">해시</th>
                <th className="px-2 py-1 text-right font-normal">n</th>
                <th className="px-2 py-1 text-right font-normal">평균 초과</th>
                <th className="px-2 py-1 text-right font-normal">CAGR</th>
                <th className="px-2 py-1 text-right font-normal">MDD</th>
                <th className="px-2 py-1 text-left font-normal">상태</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const h = r.summary_head
                return (
                  <tr key={r.id} className="border-t border-bg-surface/30">
                    <td className="px-2 py-1 text-t3">
                      {new Date(r.started_at).toLocaleString('ko-KR', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-2 py-1 text-t2">
                      {h?.mode === 'portfolio' ? '포트폴리오' : h?.mode === 'event_study' ? '이벤트' : '—'}
                    </td>
                    <td className="px-2 py-1 text-[11px] text-t4" title={r.spec_hash}>
                      {r.spec_hash.slice(0, 8)}
                    </td>
                    <td className="px-2 py-1 text-right text-t2">
                      {h?.n_episodes != null ? h.n_episodes.toLocaleString() : '—'}
                    </td>
                    <td className={`px-2 py-1 text-right ${signCls(h?.avg_excess_pct)}`}>
                      {fmtPct(h?.avg_excess_pct)}
                    </td>
                    <td className={`px-2 py-1 text-right ${signCls(h?.cagr_pct)}`}>
                      {h?.cagr_pct != null ? fmtPct(h.cagr_pct) : '—'}
                    </td>
                    <td className={`px-2 py-1 text-right ${signCls(h?.mdd_pct)}`}>
                      {h?.mdd_pct != null ? fmtPct(h.mdd_pct) : '—'}
                    </td>
                    <td className={`px-2 py-1 ${r.status === 'done' ? 'text-t3' : 'text-down'}`}>{r.status}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
