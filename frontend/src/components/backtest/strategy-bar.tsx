import { useCallback, useEffect, useState } from 'react'

import { fmtPct } from './format'
import type { RunRecord, Strategy, StrategyRecord } from './types'

/**
 * 상단 저장 전략 바 (backtest.md §8) — 저장 전략 선택/로드 + 저장/삭제 + 선택 전략 최근 실행 요약.
 * 실행 시 선택된 strategy_id를 run body에 연결(부모가 selectedId 소유).
 */
export function StrategyBar({
  currentSpec,
  currentName,
  selectedId,
  refreshToken,
  onLoad,
  onCleared,
  onSaved,
  onDeleted,
}: {
  currentSpec: Strategy | null
  currentName: string
  selectedId: string | null
  refreshToken: number
  onLoad: (id: string, spec: Strategy) => void
  onCleared: () => void
  onSaved: (id: string) => void
  onDeleted: () => void
}) {
  const [strategies, setStrategies] = useState<StrategyRecord[]>([])
  const [recent, setRecent] = useState<RunRecord[]>([])
  const [saveName, setSaveName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const reloadList = useCallback(async () => {
    try {
      const r = await fetch('/api/backtest/strategies')
      if (r.ok) setStrategies((await r.json()) as StrategyRecord[])
    } catch {
      /* 목록 조회 실패는 무시 (저장 전략 없음과 동일 취급) */
    }
  }, [])

  useEffect(() => {
    void reloadList()
  }, [reloadList, refreshToken])

  // 선택 전략의 최근 실행 요약
  useEffect(() => {
    if (!selectedId) {
      setRecent([])
      return
    }
    let cancelled = false
    fetch(`/api/backtest/runs?strategy_id=${selectedId}&limit=3`)
      .then((r) => (r.ok ? (r.json() as Promise<RunRecord[]>) : []))
      .then((d) => {
        if (!cancelled) setRecent(d)
      })
      .catch(() => {
        if (!cancelled) setRecent([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, refreshToken])

  const selected = strategies.find((s) => s.id === selectedId) ?? null

  const handleSelect = (id: string) => {
    if (!id) {
      onCleared()
      return
    }
    const rec = strategies.find((s) => s.id === id)
    if (rec?.spec) onLoad(id, rec.spec)
  }

  const handleSave = async () => {
    if (!currentSpec) {
      setMsg('저장 전 빌더 오류를 먼저 해결하세요.')
      return
    }
    const name = (saveName.trim() || currentName.trim() || 'untitled').trim()
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetch('/api/backtest/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, spec: currentSpec }),
      })
      if (!r.ok) {
        setMsg(`저장 실패 (HTTP ${r.status})`)
        return
      }
      const rec = (await r.json()) as StrategyRecord
      setSaveName('')
      await reloadList()
      onSaved(rec.id)
      setMsg(`저장됨: ${rec.name}`)
    } catch {
      setMsg('저장 실패 — 백엔드(8100) 연결 확인')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!selected) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetch(`/api/backtest/strategies/${selected.id}`, { method: 'DELETE' })
      if (!r.ok) {
        setMsg(`삭제 실패 (HTTP ${r.status})`)
        return
      }
      await reloadList()
      onDeleted()
      setMsg(`삭제됨: ${selected.name}`)
    } catch {
      setMsg('삭제 실패 — 백엔드(8100) 연결 확인')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel flex flex-col gap-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-t3">저장 전략</span>
        <select
          value={selectedId ?? ''}
          onChange={(e) => handleSelect(e.target.value)}
          className="rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-[13px] text-t1 outline-none focus:border-accent"
        >
          <option value="">— 불러올 전략 선택 —</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {selected && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="rounded-sm border border-bg-surface px-2 py-1 text-xs text-t3 hover:text-down disabled:opacity-50"
          >
            삭제
          </button>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={currentName || '전략 이름'}
            className="w-40 rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-[13px] text-t1 outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !currentSpec}
            title={!currentSpec ? '빌더 오류를 먼저 해결하세요' : '현재 전략 저장 (이름 중복 시 덮어쓰기)'}
            className="rounded-sm bg-blue/20 px-2.5 py-1 text-xs font-medium text-blue hover:bg-blue/30 disabled:opacity-50"
          >
            저장
          </button>
        </div>
      </div>

      {msg && <div className="text-[11px] text-t4">{msg}</div>}

      {/* 선택 전략의 최근 실행 요약 */}
      {selected && recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-bg-surface/40 pt-1.5 text-[11px] text-t4">
          <span className="text-t3">최근 실행</span>
          {recent.map((r) => {
            const h = r.summary_head
            return (
              <span key={r.id} className="tabular-nums">
                {new Date(r.started_at).toLocaleString('ko-KR', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {h && (
                  <>
                    {' '}
                    <span className="text-t3">{h.mode === 'portfolio' ? '포트폴리오' : '이벤트'}</span>
                    {h.mode === 'portfolio' && h.cagr_pct != null && (
                      <> · CAGR {fmtPct(h.cagr_pct)}</>
                    )}
                    {h.avg_excess_pct != null && <> · 초과 {fmtPct(h.avg_excess_pct)}</>}
                    {h.n_episodes != null && <> · n {h.n_episodes.toLocaleString()}</>}
                  </>
                )}
                {r.status !== 'done' && <span className="text-down"> · {r.status}</span>}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
