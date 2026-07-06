import { type CatalogIndex, type EditCond, blankCond, isBoolField, nsOf } from './catalog'
import type { Op } from './types'
import { Select, Tip } from './ui'

const OP_LABEL: Record<Op, string> = {
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  '==': '=',
  is_true: '참(true)',
  is_false: '거짓(false)',
}
const COMPARE_OPS: Op[] = ['>', '>=', '<', '<=', '==']
const BOOL_OPS: Op[] = ['is_true', 'is_false']

/**
 * 조건 행: [네임스페이스▾][지표▾][연산▾][값 | 지표참조(ref×mult)] [×].
 * catalog 기반. bool 지표(tag)는 is_true/is_false만·값 숨김.
 */
export function ConditionRow({
  idx,
  cond,
  onChange,
  onRemove,
}: {
  idx: CatalogIndex
  cond: EditCond
  onChange: (c: EditCond) => void
  onRemove: () => void
}) {
  const ns = nsOf(cond.field)
  const metric = idx.byKey.get(cond.field)
  const isBool = isBoolField(idx, cond.field)

  const nsOptions = idx.namespaces.map((n) => ({ value: n, label: n }))
  const metricOptions = (idx.byNs.get(ns) ?? []).map((m) => ({ value: m.key, label: m.label }))
  const refOptions = idx.numeric.map((m) => ({ value: m.key, label: m.label }))

  const setNs = (nextNs: string) => {
    const first = idx.byNs.get(nextNs)?.[0]
    if (!first) return
    const nextBool = first.unit === 'bool'
    onChange({
      ...cond,
      field: first.key,
      op: nextBool ? 'is_true' : COMPARE_OPS.includes(cond.op) ? cond.op : '>=',
    })
  }
  const setField = (key: string) => {
    const nextBool = idx.byKey.get(key)?.unit === 'bool'
    onChange({
      ...cond,
      field: key,
      op: nextBool ? (BOOL_OPS.includes(cond.op) ? cond.op : 'is_true') : COMPARE_OPS.includes(cond.op) ? cond.op : '>=',
    })
  }

  const opOptions = (isBool ? BOOL_OPS : COMPARE_OPS).map((o) => ({ value: o, label: OP_LABEL[o] }))

  return (
    <div className="flex flex-wrap items-center gap-1">
      <Select value={ns} onChange={setNs} options={nsOptions} className="w-16" />
      <span className="group relative">
        <Select value={cond.field} onChange={setField} options={metricOptions} className="w-32" />
        {metric && (
          <Tip
            title={`${metric.label} · ${metric.unit}`}
            body={
              <>
                <div>{metric.desc}</div>
                <div className="mt-1 text-t4">
                  키 {metric.key} · 가용 {metric.available_from}~
                </div>
              </>
            }
          />
        )}
      </span>
      <Select
        value={cond.op}
        onChange={(v) => onChange({ ...cond, op: v as Op })}
        options={opOptions}
        className="w-24"
      />
      {!isBool && (
        <>
          {cond.useRef ? (
            <>
              <Select
                value={cond.ref}
                onChange={(v) => onChange({ ...cond, ref: v })}
                options={refOptions}
                className="w-28"
              />
              <span className="text-t4">×</span>
              <input
                type="number"
                step={0.1}
                value={cond.mult}
                onChange={(e) => onChange({ ...cond, mult: e.target.value })}
                className="w-14 rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-xs tabular-nums text-t1 outline-none focus:border-accent"
              />
            </>
          ) : (
            <input
              type="number"
              value={cond.value}
              placeholder="값"
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              className="w-20 rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-xs tabular-nums text-t1 outline-none focus:border-accent"
            />
          )}
          <button
            type="button"
            onClick={() => onChange({ ...cond, useRef: !cond.useRef })}
            title={cond.useRef ? '상수 값과 비교' : '다른 지표와 비교 (ref×배수)'}
            className="rounded-sm border border-bg-surface px-1 py-1 text-[10px] text-t3 hover:text-t1"
          >
            {cond.useRef ? '지표' : '값'}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="조건 삭제"
        className="ml-auto px-1 text-t4 hover:text-down"
      >
        ✕
      </button>
    </div>
  )
}

/** 조건 행 리스트 + 추가 버튼. all/any 라벨은 부모가 표기. */
export function ConditionList({
  idx,
  rows,
  onChange,
}: {
  idx: CatalogIndex
  rows: EditCond[]
  onChange: (rows: EditCond[]) => void
}) {
  const update = (i: number, c: EditCond) => onChange(rows.map((r, k) => (k === i ? c : r)))
  const remove = (i: number) => onChange(rows.filter((_, k) => k !== i))
  const add = () => onChange([...rows, blankCond(idx)])
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <ConditionRow key={r.id} idx={idx} cond={r} onChange={(c) => update(i, c)} onRemove={() => remove(i)} />
      ))}
      <button
        type="button"
        onClick={add}
        className="self-start rounded-sm border border-dashed border-bg-surface px-2 py-0.5 text-[11px] text-t3 hover:border-accent hover:text-accent"
      >
        + 조건 추가
      </button>
    </div>
  )
}
