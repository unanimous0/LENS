import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { buildIndex, type CatalogIndex } from '@/components/backtest/catalog'
import { type BuilderState, PRESETS, defaultState, serialize } from '@/components/backtest/builder-state'
import { ResultView } from '@/components/backtest/result-view'
import { StrategyBuilder } from '@/components/backtest/strategy-builder'
import type { BacktestResult, Catalog, FieldError, JobStatus } from '@/components/backtest/types'

/**
 * 백테스팅 탭 (범용 전략 백테스트 — PR-C1) · backtest.md §8.
 * 좌: 전략 빌더 / 우: 결과 뷰. 프론트는 백엔드 결과 포맷팅만 (지표 재계산 금지).
 */
export function BacktestPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)

  useEffect(() => {
    fetch('/api/backtest/catalog')
      .then((r) => r.json() as Promise<Catalog>)
      .then(setCatalog)
      .catch(() => setCatalogError(true))
  }, [])

  if (catalogError) {
    return <div className="p-4 text-sm text-t3">카탈로그를 불러오지 못했습니다. 백엔드(8100) 상태를 확인하세요.</div>
  }
  if (!catalog) {
    return <div className="p-4 text-sm text-t3">카탈로그 불러오는 중…</div>
  }
  return <BacktestInner catalog={catalog} />
}

function BacktestInner({ catalog }: { catalog: Catalog }) {
  const idx = useMemo<CatalogIndex>(() => buildIndex(catalog), [catalog])
  const [state, setStateRaw] = useState<BuilderState>(() => defaultState(idx))
  const setState = useCallback((updater: (s: BuilderState) => BuilderState) => setStateRaw(updater), [])

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([])
  const [clientErrors, setClientErrors] = useState<string[]>([])
  const pollRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
  }, [])

  const reset = () => {
    setStateRaw(defaultState(idx))
    setResult(null)
    setRunError(null)
    setFieldErrors([])
    setClientErrors([])
  }

  const loadPreset = (make: (i: CatalogIndex) => BuilderState) => {
    setStateRaw(make(idx))
    setFieldErrors([])
    setClientErrors([])
  }

  const run = async () => {
    setFieldErrors([])
    setRunError(null)
    const { strategy, errors } = serialize(idx, state)
    if (!strategy) {
      setClientErrors(errors)
      return
    }
    setClientErrors([])
    setRunning(true)
    setProgress(0)
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(strategy),
      })
      if (res.status === 422) {
        const body = await res.json().catch(() => ({}))
        setFieldErrors(Array.isArray(body.detail) ? body.detail : [{ msg: '검증 실패' }])
        setRunning(false)
        return
      }
      if (!res.ok) {
        setRunError(`실행 실패 (HTTP ${res.status})`)
        setRunning(false)
        return
      }
      const { job_id } = (await res.json()) as { job_id: string }
      poll(job_id)
    } catch {
      setRunError('네트워크 오류 — 백엔드(8100) 연결을 확인하세요.')
      setRunning(false)
    }
  }

  const poll = (jobId: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/backtest/jobs/${jobId}`)
        if (!r.ok) throw new Error(String(r.status))
        const job = (await r.json()) as JobStatus
        setProgress(job.progress)
        if (job.status === 'done' && job.result) {
          if (pollRef.current) window.clearInterval(pollRef.current)
          setResult(job.result)
          setRunning(false)
        } else if (job.status === 'error') {
          if (pollRef.current) window.clearInterval(pollRef.current)
          setRunError(job.error ?? '엔진 오류')
          setRunning(false)
        }
      } catch {
        if (pollRef.current) window.clearInterval(pollRef.current)
        setRunError('job 폴링 실패')
        setRunning(false)
      }
    }, 1000)
  }

  const panelMeta = catalog.panel_meta

  return (
    <div className="flex flex-col gap-2 p-2">
      {/* 헤더 */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <div className="flex items-baseline gap-2">
          <h1 className="text-sm font-semibold text-t1">백테스팅 — 전략 실험실</h1>
          <span className="text-[11px] text-t3">
            수급·가격 조건을 조합해 진입/청산 전략의 이벤트 스터디 성과를 측정. 방법론은 고정 레일.
          </span>
        </div>
        {panelMeta && (
          <span className="text-[10px] text-t4 tabular-nums">
            패널 {panelMeta.period.start}~{panelMeta.period.end} · {panelMeta.n_stocks.toLocaleString()}종목 ·{' '}
            {panelMeta.n_rows.toLocaleString()}행
          </span>
        )}
      </div>

      <div className="grid gap-2 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* 좌: 빌더 */}
        <div className="flex flex-col gap-2">
          {clientErrors.length > 0 && (
            <div className="panel flex flex-col gap-0.5 p-3 text-[11px] text-warning">
              {clientErrors.map((e, i) => (
                <div key={i}>· {e}</div>
              ))}
            </div>
          )}
          <StrategyBuilder
            idx={idx}
            state={state}
            setState={setState}
            onRun={run}
            onReset={reset}
            running={running}
            fieldErrors={fieldErrors}
          />
        </div>

        {/* 우: 결과 */}
        <div className="flex flex-col gap-2">
          {running && (
            <div className="panel px-3 py-2 text-xs text-t3">
              실행 중… <span className="tabular-nums text-t2">{progress}%</span>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-bg-surface">
                <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
              </div>
              {progress < 55 && <div className="mt-1 text-[10px] text-t4">패널 준비 중일 수 있습니다(콜드 빌드 시 수십 초).</div>}
            </div>
          )}
          {runError && (
            <div className="panel px-3 py-2 text-xs text-down">엔진 오류: {runError}</div>
          )}
          {result ? (
            <ResultView result={result} />
          ) : (
            !running && <EmptyState onPreset={loadPreset} />
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onPreset }: { onPreset: (make: (i: CatalogIndex) => BuilderState) => void }) {
  return (
    <div className="panel flex flex-col gap-3 p-5 text-sm text-t3">
      <div className="text-t2">전략을 구성하고 [실행]을 누르면 결과가 여기 표시됩니다.</div>
      <div className="text-[11px] text-t4">
        조건 = 네임스페이스.지표 · 연산 · 값(또는 다른 지표 참조). 진입 onset마다 에피소드를 만들어
        청산 규칙 중 먼저 발동하는 시점에 청산합니다. 검증된 예시로 시작해 보세요:
      </div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => onPreset(p.make)}
            className="group relative rounded-sm border border-bg-surface bg-bg-surface/40 px-3 py-2 text-left hover:border-accent"
          >
            <div className="text-xs font-medium text-t1">{p.label}</div>
            <div className="mt-0.5 max-w-xs text-[10px] leading-relaxed text-t4">{p.desc}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
