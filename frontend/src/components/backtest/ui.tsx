import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 스타일된 hover 툴팁 — native title 대체 (CSS만). 부모에 `group relative` 필요. (stock-flow Tip 관례) */
export function Tip({
  title,
  body,
  align = 'center',
}: {
  title: string
  body: ReactNode
  align?: 'center' | 'left' | 'right'
}) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-full z-30 mt-1 hidden w-64 whitespace-normal break-keep rounded-sm bg-bg-surface-2 p-2 text-left text-xs font-normal normal-case leading-relaxed text-t2 shadow-lg group-hover:block',
        align === 'right' && 'right-0',
        align === 'left' && 'left-0',
        align === 'center' && 'left-1/2 -translate-x-1/2',
      )}
    >
      <div className="mb-0.5 font-semibold text-t1">{title}</div>
      {body}
    </div>
  )
}

const selectCls =
  'rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-[13px] text-t1 outline-none focus:border-accent'
const inputCls =
  'rounded-sm border border-bg-surface bg-bg-input px-1.5 py-1 text-[13px] text-t1 tabular-nums outline-none focus:border-accent'

export function Select({
  value,
  onChange,
  options,
  className,
  title,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
  title?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={title}
      className={cn(selectCls, className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function NumberInput({
  value,
  onChange,
  className,
  placeholder,
  step,
  min,
}: {
  value: string
  onChange: (v: string) => void
  className?: string
  placeholder?: string
  step?: number
  min?: number
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      step={step}
      min={min}
      className={cn(inputCls, 'w-20', className)}
    />
  )
}

/** 필드 라벨 + 자식 (좌 빌더 섹션 행). */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[13px] text-t3">
      <span className="shrink-0">{label}</span>
      <span className="flex items-center gap-1.5">{children}</span>
    </label>
  )
}

/** 좌 빌더 섹션 타이틀. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-t3">{children}</div>
}
