import { useEffect, useRef, useState } from 'react'

import { useStatArbAlerts } from '@/hooks/useStatArbAlerts'
import { DEFAULT_TARGET_Z, DIRECTION_LABELS } from '@/lib/stat-arb/alerts'
import type { AlertDirection } from '@/lib/stat-arb/alerts'

/**
 * 페어 상세용 목표 z 알림 등록 버튼 (+ 작은 팝오버).
 *
 * 실제 감시·발화는 목록 탭의 워치리스트 패널이 한다 — 여기서는 등록/해제만.
 * 방향(abs/above/below)은 알림의 고유키 일부라 같은 페어에 여러 건을 걸 수 있다.
 */
export function AlertButton({
  leftKey,
  rightKey,
  leftName,
  rightName,
  currentZ,
}: {
  leftKey: string
  rightKey: string
  leftName: string
  rightName: string
  /** 현재 z — 팝오버에 참고 표시 (없으면 생략). */
  currentZ?: number | null
}) {
  const { alerts, add, remove, update } = useStatArbAlerts()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(String(DEFAULT_TARGET_Z))
  const [dir, setDir] = useState<AlertDirection>('abs')
  const boxRef = useRef<HTMLDivElement>(null)

  const pairAlerts = alerts.filter((a) => a.left_key === leftKey && a.right_key === rightKey)

  // 바깥 클릭으로 닫기
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const submit = () => {
    const v = parseFloat(target)
    if (!isFinite(v) || v <= 0 || v > 10) return
    void add({
      left_key: leftKey,
      right_key: rightKey,
      left_name: leftName,
      right_name: rightName,
      target_z: v,
      direction: dir,
    })
  }

  const dup = pairAlerts.find((a) => a.direction === dir)

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="목표 z 도달 알림 걸기 (목록 탭의 워치리스트가 감시)"
        className={`rounded-sm px-2 py-1 text-xs ${
          pairAlerts.length > 0 ? 'bg-warning/20 text-warning' : 'bg-bg-surface text-t2 hover:text-t1'
        }`}
      >
        {pairAlerts.length > 0 ? `🔔 알림 ${pairAlerts.length}` : '🔔 알림 추가'}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-[320px] rounded-sm bg-bg-surface p-3 shadow-xl">
          <div className="mb-2 text-xs text-t2">
            목표 z 도달 알림
            {currentZ != null && (
              <span className="ml-2 text-[11px] text-t3 tabular-nums">
                현재 z {currentZ >= 0 ? '+' : ''}
                {currentZ.toFixed(2)}
              </span>
            )}
          </div>

          {pairAlerts.length > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              {pairAlerts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 rounded-sm bg-bg-base px-2 py-1 text-[11px] tabular-nums"
                >
                  <span className="text-t1">{a.target_z.toFixed(1)}</span>
                  <span className="text-t3">{DIRECTION_LABELS[a.direction]}</span>
                  <button
                    onClick={() => update(a.id, { enabled: !a.enabled })}
                    className={`ml-auto rounded-sm px-1.5 py-0.5 ${
                      a.enabled ? 'bg-accent/20 text-accent' : 'bg-bg-surface text-t4'
                    }`}
                    title={a.enabled ? '감시 중 — 클릭하여 일시 중지' : '중지됨 — 클릭하여 재개'}
                  >
                    {a.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button
                    onClick={() => remove(a.id)}
                    className="text-t4 hover:text-down"
                    title="삭제"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="10"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              className="w-16 rounded-sm bg-bg-base px-2 py-1 text-right text-xs text-t1 tabular-nums focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
            <select
              value={dir}
              onChange={(e) => setDir(e.target.value as AlertDirection)}
              className="flex-1 rounded-sm bg-bg-base px-2 py-1 text-xs text-t1 focus:outline-none"
            >
              <option value="abs">{DIRECTION_LABELS.abs}</option>
              <option value="above">{DIRECTION_LABELS.above}</option>
              <option value="below">{DIRECTION_LABELS.below}</option>
            </select>
            <button
              onClick={submit}
              className="rounded-sm bg-accent/20 px-2.5 py-1 text-xs text-accent hover:bg-accent/30"
            >
              {dup ? '갱신' : '추가'}
            </button>
          </div>

          <div className="mt-2 text-[11px] leading-relaxed text-t4">
            감시·발화는 <span className="text-t3">통계차익 목록 탭</span>의 워치리스트가 열려 있는
            동안만 동작합니다 (서버 푸시 아님). 실시간 z는 일봉 회귀(α·β)·정규화(μ·σ)에 장중 가격을
            넣은 값 — 이 페이지 &lsquo;장중&rsquo; 뷰와 같은 척도입니다.
          </div>
        </div>
      )}
    </div>
  )
}
