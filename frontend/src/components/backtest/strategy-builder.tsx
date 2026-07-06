import { type CatalogIndex, blankCond } from './catalog'
import { type BuilderState } from './builder-state'
import { ConditionList } from './condition-row'
import type { FieldError } from './types'
import { Field, NumberInput, Select, SectionTitle } from './ui'

const FILL_OPTIONS = [
  { value: 'next_open', label: '익일 시가 (기본)' },
  { value: 'next_close', label: '익일 종가' },
  { value: 'same_close', label: '당일 종가 ⚠' },
]

export function StrategyBuilder({
  idx,
  state,
  setState,
  onRun,
  onReset,
  running,
  fieldErrors,
}: {
  idx: CatalogIndex
  state: BuilderState
  setState: (updater: (s: BuilderState) => BuilderState) => void
  onRun: () => void
  onReset: () => void
  running: boolean
  fieldErrors: FieldError[]
}) {
  const patch = (p: Partial<BuilderState>) => setState((s) => ({ ...s, ...p }))
  const sameClose = state.entryFill === 'same_close' || state.exitFill === 'same_close'

  return (
    <div className="flex flex-col gap-3">
      {/* 유니버스 */}
      <section className="panel flex flex-col gap-2 p-3">
        <SectionTitle>유니버스</SectionTitle>
        <div className="flex items-center gap-3 text-[13px] text-t2">
          {(['KOSPI', 'KOSDAQ'] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={state.markets[m]}
                onChange={(e) => patch({ markets: { ...state.markets, [m]: e.target.checked } })}
                className="accent-accent"
              />
              {m}
            </label>
          ))}
        </div>
        <Field label="거래대금 하한 (억, 20D 평균)">
          <NumberInput value={state.minAdv} onChange={(v) => patch({ minAdv: v })} min={0} />
        </Field>
        <Field label="시가총액 하한 (억)">
          <NumberInput value={state.minMcap} onChange={(v) => patch({ minMcap: v })} min={0} />
        </Field>
      </section>

      {/* 진입 조건 */}
      <section className="panel flex flex-col gap-2 p-3">
        <SectionTitle>진입 조건 · 모두 충족 (AND)</SectionTitle>
        <ConditionList idx={idx} rows={state.andConds} onChange={(rows) => patch({ andConds: rows })} />

        <div className="mt-1 flex items-center gap-2 border-t border-bg-surface/50 pt-2">
          <label className="flex items-center gap-1.5 text-xs text-t3">
            <input
              type="checkbox"
              checked={state.orEnabled}
              onChange={(e) =>
                patch({ orEnabled: e.target.checked, orConds: e.target.checked && !state.orConds.length ? [blankCond(idx)] : state.orConds })
              }
              className="accent-accent"
            />
            OR 그룹 추가 <span className="text-t4">(하나라도 충족 · AND 리스트와 함께 적용)</span>
          </label>
        </div>
        {state.orEnabled && (
          <div className="rounded-sm border border-bg-surface/60 p-2">
            <div className="mb-1 text-xs text-t3">아래 중 하나라도 충족 (OR)</div>
            <ConditionList idx={idx} rows={state.orConds} onChange={(rows) => patch({ orConds: rows })} />
          </div>
        )}
      </section>

      {/* 체결 · 비용 */}
      <section className="panel flex flex-col gap-2 p-3">
        <SectionTitle>체결 · 비용</SectionTitle>
        <Field label="진입 체결">
          <Select
            value={state.entryFill}
            onChange={(v) => patch({ entryFill: v as BuilderState['entryFill'] })}
            options={FILL_OPTIONS}
            className="w-36"
          />
        </Field>
        <Field label="청산 체결">
          <Select
            value={state.exitFill}
            onChange={(v) => patch({ exitFill: v as BuilderState['exitFill'] })}
            options={FILL_OPTIONS}
            className="w-36"
          />
        </Field>
        <Field label="비용 (bp, 편도)">
          <NumberInput value={state.costBps} onChange={(v) => patch({ costBps: v })} min={0} />
        </Field>
        {sameClose && (
          <div className="rounded-sm bg-warning/10 px-2 py-1.5 text-xs leading-relaxed text-warning">
            ⚠ 당일 종가(same_close) 체결은 &ldquo;D일 데이터를 보고 D일 종가에 산다&rdquo;는 낙관
            가정입니다 — 실현 불가능할 수 있으며(look-ahead) 결과에 영구 경고 배지가 붙습니다.
          </div>
        )}
      </section>

      {/* 청산 규칙 */}
      <section className="panel flex flex-col gap-2 p-3">
        <SectionTitle>청산 규칙 · 먼저 발동 (whichever-first)</SectionTitle>

        <ExitToggle
          checked={state.fixedEnabled}
          onToggle={(v) => patch({ fixedEnabled: v })}
          label="고정 보유일"
        >
          <NumberInput value={state.fixedDays} onChange={(v) => patch({ fixedDays: v })} min={1} />
          <span className="text-xs text-t4">거래일</span>
        </ExitToggle>

        <ExitToggle checked={state.stopEnabled} onToggle={(v) => patch({ stopEnabled: v })} label="손절 %">
          <span className="text-t4">−</span>
          <NumberInput value={state.stopPct} onChange={(v) => patch({ stopPct: v })} min={0} />
          <span className="text-xs text-t4">종가 판정→익일 체결</span>
        </ExitToggle>

        <ExitToggle checked={state.takeEnabled} onToggle={(v) => patch({ takeEnabled: v })} label="익절 %">
          <span className="text-t4">+</span>
          <NumberInput value={state.takePct} onChange={(v) => patch({ takePct: v })} min={0} />
        </ExitToggle>

        <ExitToggle
          checked={state.condExitEnabled}
          onToggle={(v) =>
            patch({ condExitEnabled: v, condExitRows: v && !state.condExitRows.length ? [blankCond(idx)] : state.condExitRows })
          }
          label="조건 청산"
        >
          <Select
            value={state.condExitMode}
            onChange={(v) => patch({ condExitMode: v as 'all' | 'any' })}
            options={[
              { value: 'any', label: '하나라도 (OR)' },
              { value: 'all', label: '모두 (AND)' },
            ]}
            className="w-28"
          />
        </ExitToggle>
        {state.condExitEnabled && (
          <div className="rounded-sm border border-bg-surface/60 p-2">
            <ConditionList idx={idx} rows={state.condExitRows} onChange={(rows) => patch({ condExitRows: rows })} />
          </div>
        )}
        <div className="text-xs leading-relaxed text-t4">
          여러 규칙을 켜면 각 에피소드는 가장 먼저 발동하는 규칙에서 청산됩니다. 손절/익절은 종가로
          판정 후 다음날 체결(장중 저가 터치 금지 — 부검 레일).
        </div>
      </section>

      {/* 기간 · 벤치마크 */}
      <section className="panel flex flex-col gap-2 p-3">
        <SectionTitle>기간 · 벤치마크</SectionTitle>
        <Field label="시작 (비우면 최대)">
          <input
            type="date"
            value={state.start}
            onChange={(e) => patch({ start: e.target.value })}
            className="rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-[13px] text-t1 outline-none focus:border-accent"
          />
        </Field>
        <Field label="종료 (비우면 최대)">
          <input
            type="date"
            value={state.end}
            onChange={(e) => patch({ end: e.target.value })}
            className="rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-[13px] text-t1 outline-none focus:border-accent"
          />
        </Field>
        <Field label="벤치마크">
          <Select
            value={state.benchmark}
            onChange={(v) => patch({ benchmark: v as 'universe_avg' | 'none' })}
            options={[
              { value: 'universe_avg', label: '유니버스 평균 (기하)' },
              { value: 'none', label: '없음 (절대수익)' },
            ]}
            className="w-40"
          />
        </Field>
      </section>

      {/* 필드 에러 (422) */}
      {fieldErrors.length > 0 && (
        <div className="panel flex flex-col gap-1 p-3 text-xs text-down">
          <div className="font-medium">검증 오류</div>
          {fieldErrors.map((e, i) => (
            <div key={i}>
              <span className="text-t4">{(e.loc ?? []).join('.') || e.field}</span> — {e.msg}
            </div>
          ))}
        </div>
      )}

      {/* 실행 */}
      <div className="sticky bottom-0 flex gap-2 bg-bg-base py-2">
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="flex-1 rounded-sm bg-accent px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {running ? '실행 중…' : '실행'}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded-sm border border-bg-surface px-3 py-2 text-sm text-t3 hover:text-t1"
        >
          초기화
        </button>
      </div>
    </div>
  )
}

function ExitToggle({
  checked,
  onToggle,
  label,
  children,
}: {
  checked: boolean
  onToggle: (v: boolean) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <label className="flex w-28 shrink-0 items-center gap-1.5 text-t2">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} className="accent-accent" />
        {label}
      </label>
      <div className={`flex items-center gap-1.5 ${checked ? '' : 'pointer-events-none opacity-40'}`}>{children}</div>
    </div>
  )
}
