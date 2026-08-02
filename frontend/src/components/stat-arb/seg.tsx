/** 세그먼트 토글 — 트레이딩 터미널 톤. 선택값 accent 강조.
 *  통계차익 컨트롤 바 공용 (1:1 뷰·조합·안정성 / M:N Johansen 등 서버 필터 선택). */
export function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ v: T; label: string; title?: string }>
}) {
  return (
    <div className="flex overflow-hidden rounded-sm bg-bg-surface">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          title={o.title}
          className={`px-2 py-1 text-xs ${
            value === o.v ? 'bg-accent/25 text-accent' : 'text-t3 hover:text-t1'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
