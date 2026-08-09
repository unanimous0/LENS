/** 카탈로그 인덱스 + 편집 상태 ↔ 전략 JSON 변환. */
import type { Catalog, CatalogMetric, Condition, Op } from './types'

export type EditCond = {
  id: string
  field: string // 전체 키 (예: "flow.tag.장기동시")
  op: Op
  value: string // 텍스트 입력 (파싱 전)
  useRef: boolean // true면 지표 참조(ref×mult) 비교
  ref: string
  mult: string
}

export type CatalogIndex = {
  namespaces: string[]
  byNs: Map<string, CatalogMetric[]>
  numeric: CatalogMetric[] // ref 대상 (bool 제외)
  byKey: Map<string, CatalogMetric>
}

export function buildIndex(cat: Catalog): CatalogIndex {
  const byNs = new Map<string, CatalogMetric[]>()
  const byKey = new Map<string, CatalogMetric>()
  for (const m of cat.metrics) {
    const ns = m.key.split('.', 1)[0]
    if (!byNs.has(ns)) byNs.set(ns, [])
    byNs.get(ns)!.push(m)
    byKey.set(m.key, m)
  }
  return {
    namespaces: cat.namespaces,
    byNs,
    numeric: cat.metrics.filter((m) => m.unit !== 'bool'),
    byKey,
  }
}

export function isBoolField(idx: CatalogIndex, field: string): boolean {
  return idx.byKey.get(field)?.unit === 'bool'
}

export function nsOf(field: string): string {
  return field.split('.', 1)[0]
}

let _seq = 0
export function newId(): string {
  return `c${Date.now().toString(36)}${(_seq++).toString(36)}`
}

export function blankCond(idx: CatalogIndex): EditCond {
  const first = idx.byNs.get(idx.namespaces[0])?.[0]
  return {
    id: newId(),
    field: first?.key ?? '',
    op: first?.unit === 'bool' ? 'is_true' : '>=',
    value: '',
    useRef: false,
    ref: idx.numeric[0]?.key ?? '',
    mult: '1',
  }
}

export function isRankOp(op: Op): boolean {
  return op === 'rank_pct_top' || op === 'rank_pct_bottom'
}

/** 편집 조건 → 스키마 Condition. 유효하지 않으면 null (예: 값 미입력). */
export function toCondition(_idx: CatalogIndex, c: EditCond): Condition | null {
  if (!c.field) return null
  if (c.op === 'is_true' || c.op === 'is_false') {
    return { field: c.field, op: c.op }
  }
  // rank_pct는 ref를 받지 않고 value(0<v<=100, %)만. bool 지표엔 라우터가 422.
  if (isRankOp(c.op)) {
    if (c.value.trim() === '') return null
    const v = Number(c.value)
    if (!Number.isFinite(v) || v <= 0 || v > 100) return null
    return { field: c.field, op: c.op, value: v }
  }
  if (c.useRef) {
    if (!c.ref) return null
    const mult = Number(c.mult)
    return { field: c.field, op: c.op, ref: c.ref, mult: Number.isFinite(mult) ? mult : 1 }
  }
  if (c.value.trim() === '') return null
  const v = Number(c.value)
  if (!Number.isFinite(v)) return null
  return { field: c.field, op: c.op, value: v }
}

/** 스키마 Condition → 편집 조건 (프리셋 로드용). */
export function fromCondition(c: Condition): EditCond {
  const isRef = c.ref != null
  return {
    id: newId(),
    field: c.field,
    op: c.op,
    value: c.value != null ? String(c.value) : '',
    useRef: isRef,
    ref: c.ref ?? '',
    mult: c.mult != null ? String(c.mult) : '1',
  }
}
