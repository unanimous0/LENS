import { useCallback, useEffect, useMemo, useState } from 'react'

import { keyToCode } from '@/lib/stat-arb-keys'
import { frozenZ, storedBand } from '@/lib/stat-arb/frozen-z'
import type {
  EntryBandEstimate,
  EntryZUpdate,
  Position,
  PositionUpdatePayload,
  PositionUpdateResp,
} from '@/types/positions'

/** 진입일·진입가 입력이 멎은 뒤 추정을 쏘기까지 (숫자 입력 한 글자마다 쿼리 방지). */
const ESTIMATE_DEBOUNCE_MS = 400

/**
 * 포지션 기록 수정 모달 — 진입일 / leg별 수량·진입가 / 라벨·메모.
 *
 * 등록 모달(position-entry-modal)과 같은 문법이지만 입력 축이 다르다: 등록은 페어 상세의
 * 실시간 통계량을 prefill해 *새 좌표계를 얼리는* 화면이고, 수정은 이미 얼린 좌표계는 그대로
 * 둔 채 체결 사실(날짜·수량·가격)만 바로잡는 화면이다. 종목·방향·페어 키는 못 바꾼다.
 *
 * entry_z 정합 (stat-arb-engine.md §24.7 + §24.8):
 *   - 저장 밴드 있음 + 진입일 그대로 → 진입가만 고치면 **서버가** 같은 밴드로 entry_z를
 *     재계산한다. 여기선 같은 산식(frozenZ)으로 미리보기만 띄운다.
 *   - 밴드 없음(구 기록) **또는 진입일을 바꾼 경우** → `POST /estimate-entry-band` 로 그날의
 *     밴드를 일봉에서 되살려(refit) 자동 적용한다. 밴드가 자이므로 진입 z는 종속변수 —
 *     추정치를 기본으로 쓰고, 수동 입력은 그걸 덮어쓰는 override로만 남긴다(밴드 미저장 기록).
 *     진입일을 바꾸면 밴드도 같이 그날 기준으로 옮겨져 §24.7의 스냅샷 한계가 풀린다.
 */
export function PositionEditModal({
  open,
  onClose,
  position,
  leftName,
  rightName,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  /** legs 포함 상세. 목록/상세 모두 상세를 들고 있다. */
  position: Position
  leftName?: string
  rightName?: string
  onSaved: (updated: Position, entryZUpdate?: EntryZUpdate) => void
}) {
  const legs = useMemo(() => position.legs ?? [], [position])
  const band = storedBand(position.entry_stats)
  const leftCode = keyToCode(position.left_key)
  const rightCode = keyToCode(position.right_key)

  const [openedAt, setOpenedAt] = useState('')
  const [qtyById, setQtyById] = useState<Record<number, number>>({})
  const [priceById, setPriceById] = useState<Record<number, number>>({})
  const [entryZ, setEntryZ] = useState('')
  // 사용자가 진입 z를 직접 건드렸나 — 건드렸으면 추정 밴드를 저장하지 않고 그 값을 쓴다.
  const [zTouched, setZTouched] = useState(false)
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<EntryBandEstimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateError, setEstimateError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setOpenedAt(toDateInput(position.opened_at))
    setQtyById(Object.fromEntries(legs.map((l) => [l.id, l.qty])))
    setPriceById(Object.fromEntries(legs.map((l) => [l.id, l.entry_price])))
    setEntryZ(position.entry_z != null ? String(position.entry_z) : '')
    setZTouched(false)
    setLabel(position.label ?? '')
    setNote(position.note ?? '')
    setError(null)
    setEstimate(null)
    setEstimateError(null)
    setEstimating(false)
  }, [open, position, legs])

  const priceOf = useCallback(
    (code: string): number => {
      const leg = legs.find((l) => l.code === code)
      return leg ? priceById[leg.id] ?? 0 : 0
    },
    [legs, priceById]
  )
  const leftPrice = priceOf(leftCode)
  const rightPrice = priceOf(rightCode)
  const dateDirty = openedAt !== toDateInput(position.opened_at)
  // 밴드가 없거나(구 기록) 진입일이 바뀌었으면 그날 기준으로 밴드를 다시 뜬다 (§24.8).
  // 밴드가 있고 날짜도 그대로면 얼린 자를 건드리지 않는다 — 재계산 강제 안 함.
  const wantRefit = !band || dateDirty
  const { left_key: leftKey, right_key: rightKey } = position

  // 진입일·진입가가 채워지면 자동 추정 (입력 중 재호출은 debounce + 이전 요청 abort).
  useEffect(() => {
    if (!open || !wantRefit || !isDateInput(openedAt) || !(leftPrice > 0) || !(rightPrice > 0)) {
      setEstimate(null)
      setEstimateError(null)
      setEstimating(false)
      return
    }
    const ctrl = new AbortController()
    setEstimating(true)
    const timer = setTimeout(() => {
      fetch('/api/positions/estimate-entry-band', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          left_key: leftKey,
          right_key: rightKey,
          entry_date: openedAt,
          left_price: leftPrice,
          right_price: rightPrice,
        }),
        signal: ctrl.signal,
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(await errorDetail(r))
          setEstimate((await r.json()) as EntryBandEstimate)
          setEstimateError(null)
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return
          setEstimate(null)
          setEstimateError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setEstimating(false)
        })
    }, ESTIMATE_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [open, wantRefit, openedAt, leftPrice, rightPrice, leftKey, rightKey])

  if (!open) return null

  // 진입가를 실제로 건드렸을 때만 서버가 entry_z를 다시 잡는다 — 미리보기도 같은 조건으로
  // 띄운다 (안 바꿨는데 화살표가 뜨면 적용되지 않을 값을 약속하는 셈).
  const pricesDirty = legs.some((l) => (priceById[l.id] ?? l.entry_price) !== l.entry_price)
  const previewZ = band && pricesDirty ? frozenZ(band, leftPrice, rightPrice) : null
  const openedMs = parseDateInput(openedAt)
  const entryZNum = entryZ.trim() === '' ? null : Number(entryZ)
  const entryZInvalid = entryZNum != null && !Number.isFinite(entryZNum)
  const legsValid = legs.every((l) => (qtyById[l.id] ?? 0) > 0 && (priceById[l.id] ?? 0) > 0)
  // 추정은 가격이 아니라 *날짜*로 결정된다 — 날짜가 어긋난 추정치는 다른 날의 자다.
  const fresh = estimate && estimate.entry_date === openedAt ? estimate : null
  // 수동 입력으로 덮어쓴 경우엔 밴드를 저장하지 않는다 (밴드를 두고 z만 다르면 항등이 깨진다).
  const applyRefit = fresh != null && !(zTouched && !band)
  const canSave =
    legs.length > 0 && legsValid && openedMs != null && !entryZInvalid && !estimating

  const submit = async () => {
    if (openedMs == null) {
      setError('진입일 형식 오류')
      return
    }
    setSubmitting(true)
    setError(null)
    const payload: PositionUpdatePayload = {
      label: label.trim() || null,
      note: note.trim() || null,
      legs: legs.map((l) => ({
        leg_id: l.id,
        qty: qtyById[l.id] ?? l.qty,
        entry_price: priceById[l.id] ?? l.entry_price,
      })),
    }
    // 날짜를 실제로 바꾼 경우에만 opened_at 전송 — 안 바꿨는데 보내면 기존 기록의
    // 시각 정보가 로컬 09:00으로 덮여 의도치 않은 변경이 된다 (부분 업데이트 활용).
    if (dateDirty) payload.opened_at = openedMs
    if (applyRefit && fresh) {
      // 재계산 밴드가 새 자 — 서버가 이걸로 entry_stats를 갈아끼우고 진입 z도 다시 잰다.
      payload.entry_band = {
        alpha: fresh.alpha,
        beta: fresh.beta,
        center: fresh.center,
        scale: fresh.sigma,
        basis: fresh.basis,
        source: 'refit',
        asof: fresh.asof,
        window_bars: fresh.window_bars,
        r2: fresh.r2,
        adf: fresh.adf,
        half_life: fresh.half_life,
      }
    } else if (!band) {
      // 밴드도 추정도 없는 구 기록 — 진입 z는 사용자 입력이 정본. (밴드가 있으면 서버가
      // 어차피 무시하므로 보내지 않아 의도를 분명히 한다.)
      payload.entry_z = entryZNum
    }
    try {
      const r = await fetch(`/api/positions/${position.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try {
          const body = (await r.json()) as { detail?: unknown }
          if (body.detail) msg = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
        } catch {
          msg = `HTTP ${r.status}`
        }
        throw new Error(msg)
      }
      const updated = (await r.json()) as PositionUpdateResp
      onSaved(updated, updated.entry_z_update)
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      // click이 아니라 mousedown 기준 — 입력창에서 텍스트 드래그를 시작해 배경에서 손을 떼면
      // click 타깃이 배경(공통 조상)이 돼 모달이 닫히는 버그 (2026-08-27 사용자 보고).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-xl rounded bg-bg-primary p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium text-t1">포지션 기록 수정</span>
          <button type="button" onClick={onClose} className="text-xs text-t3 hover:text-t1">
            ✕
          </button>
        </div>

        <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs">
          <div className="text-t3">페어</div>
          <div className="mt-0.5 text-t1">
            {leftName ?? leftCode} <span className="text-t3">↔</span> {rightName ?? rightCode}
          </div>
          <div className="mt-0.5 text-[10px] text-t4">
            종목·방향·페어는 변경 불가 — 잘못 등록했으면 삭제 후 재등록
            {position.status === 'closed' && ' · 청산 기록 (청산가는 청산 화면에서)'}
          </div>
        </div>

        {/* 진입일 — 시간은 기록하지 않는다 (사용자 확정 2026-08-27) */}
        <label className="mb-3 flex flex-col gap-0.5 text-xs">
          <span className="text-t3">진입일</span>
          <input
            type="date"
            value={openedAt}
            onChange={(e) => setOpenedAt(e.target.value)}
            className="w-full rounded-sm bg-bg-surface px-2 py-1 text-t1 tabular-nums focus:outline-none"
          />
          {openedMs == null && <span className="text-[10px] text-down">날짜 형식 오류</span>}
        </label>

        {/* leg별 수량 / 진입가 */}
        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          {legs.map((l) => {
            const name = l.code === leftCode ? leftName : l.code === rightCode ? rightName : undefined
            return (
              <div key={l.id} className="rounded-sm bg-bg-surface px-3 py-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className={`font-medium ${l.side > 0 ? 'text-up' : 'text-down'}`}>
                    {l.side > 0 ? '매수 (long)' : '매도 (short)'}
                  </span>
                  <span className="text-[10px] text-t4">{l.code}</span>
                </div>
                <div className="mb-1 truncate text-t1">{name ?? l.code}</div>
                <label className="mb-1 flex flex-col gap-0.5">
                  <span className="text-t3">수량</span>
                  <input
                    type="number"
                    value={qtyById[l.id] ?? 0}
                    onChange={(e) =>
                      setQtyById((p) => ({ ...p, [l.id]: Math.max(0, parseInt(e.target.value) || 0) }))
                    }
                    className="rounded-sm bg-bg-primary px-2 py-1 text-t1 tabular-nums focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-t3">진입가</span>
                  <input
                    type="number"
                    value={priceById[l.id] ?? 0}
                    onChange={(e) =>
                      setPriceById((p) => ({
                        ...p,
                        [l.id]: Math.max(0, parseFloat(e.target.value) || 0),
                      }))
                    }
                    className="rounded-sm bg-bg-primary px-2 py-1 text-t1 tabular-nums focus:outline-none"
                  />
                </label>
                {l.exit_price != null && (
                  <div className="mt-1 text-[10px] text-t4">
                    청산가 {l.exit_price.toLocaleString()} (수정 불가)
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 진입 z — 밴드 유무·진입일 변경으로 갈린다 (§24.7 정합 / §24.8 재계산) */}
        <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs">
          {wantRefit ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-t3">
                  진입 z{' '}
                  {dateDirty && band ? '(진입일이 바뀌어 밴드 재계산)' : '(진입일 기준 자동 추정)'}
                </span>
                <span className="tabular-nums text-t1">
                  {position.entry_z != null ? fmtZ(position.entry_z) : '—'}
                  <span className="mx-1 text-t3">→</span>
                  <span className={applyRefit ? 'font-semibold text-accent' : 'font-semibold'}>
                    {fresh ? fmtZ(fresh.entry_z) : estimating ? '추정 중…' : '—'}
                  </span>
                </span>
              </div>
              {fresh && (
                <div className="mt-0.5 text-[10px] text-t4">
                  {fresh.asof} 종가까지 {fresh.window_bars}봉 재계산 (진입일 당일 미포함) · β=
                  {fmtBeta(fresh.beta)} · σ₀={Math.round(fresh.sigma).toLocaleString()}원
                  {applyRefit ? (
                    <>
                      {' '}
                      — 저장하면 이 밴드가 진입 밴드가 된다 (<span className="text-t3">재계산</span>{' '}
                      마커)
                    </>
                  ) : (
                    <> — 아래 직접 입력값이 우선이라 이 밴드는 저장하지 않는다</>
                  )}
                </div>
              )}
              {!fresh && !estimating && !estimateError && (
                <div className="mt-0.5 text-[10px] text-t4">
                  진입일과 양쪽 진입가가 채워지면 그날의 밴드를 일봉으로 되살려 진입 z를 추정한다.
                </div>
              )}
              {estimateError && (
                <div className="mt-0.5 text-[10px] text-warning">
                  추정 불가 — {estimateError}
                  {band && ' (기존 진입 밴드 유지)'}
                </div>
              )}
              {!band && (
                <label className="mt-2 flex flex-col gap-0.5">
                  <span className="text-t3">진입 z 직접 입력 {fresh && '(추정 덮어쓰기)'}</span>
                  <input
                    type="number"
                    step="0.01"
                    value={entryZ}
                    onChange={(e) => {
                      setEntryZ(e.target.value)
                      setZTouched(true)
                    }}
                    className="rounded-sm bg-bg-primary px-2 py-1 text-t1 tabular-nums focus:outline-none"
                  />
                  {zTouched && (
                    <span className="text-[10px] text-warning">
                      직접 입력 우선 — 밴드는 저장되지 않고 고정 z는 종전대로 진입 z에서 σ₀를
                      역산해 쓴다.
                    </span>
                  )}
                </label>
              )}
            </>
          ) : (
            band && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-t3">
                    진입 z {pricesDirty ? '(진입가로 자동 재계산)' : '(진입가를 고치면 재계산)'}
                  </span>
                  <span className="tabular-nums text-t1">
                    {position.entry_z != null ? fmtZ(position.entry_z) : '—'}
                    {pricesDirty && (
                      <>
                        <span className="mx-1 text-t3">→</span>
                        <span className="font-semibold">
                          {previewZ != null ? fmtZ(previewZ) : '—'}
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-t4">
                  진입 밴드 μ₀={Math.round(band.center).toLocaleString()} · σ₀=
                  {Math.round(band.scale).toLocaleString()}원은{' '}
                  <span className="text-t3">그대로 유지</span> — 저장 시 서버가 같은 산식으로 진입
                  z만 다시 계산한다. 진입일을 바꾸면 그날 기준으로 밴드까지 재계산한다.
                </div>
              </>
            )
          )}
        </div>

        {/* 라벨 / 메모 */}
        <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
          <label className="flex flex-col gap-0.5">
            <span className="text-t3">라벨</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="예: 반도체 페어 1차"
              className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-t3">메모</span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="진입 근거 등"
              className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
            />
          </label>
        </div>

        {error && (
          <div className="mb-3 rounded-sm bg-down/10 px-3 py-2 text-xs text-down">{error}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[10px] text-t4">수정 이력은 남지 않는다 (덮어쓰기)</span>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-sm bg-bg-surface px-3 py-1.5 text-xs text-t2 hover:text-t1 disabled:opacity-50"
          >
            취소
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !canSave}
            className="rounded-sm bg-accent/20 px-3 py-1.5 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {submitting ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  )
}

function fmtZ(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
}

/** β 표기 — 종목 가격대에 따라 0.99부터 103까지 나오므로 유효숫자로 자른다. */
function fmtBeta(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4)
}

/** 에러 응답에서 사람이 읽을 사유 뽑기 (422 = 표본 부족 등 서버가 문장으로 준다). */
async function errorDetail(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { detail?: unknown }
    if (body.detail) {
      return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    }
  } catch {
    /* 본문이 JSON이 아니면 상태코드로 */
  }
  return `HTTP ${r.status}`
}

const DATE_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function isDateInput(v: string): boolean {
  return DATE_INPUT_RE.test(v)
}

/** epoch ms → `<input type="date">` 값 (로컬 날짜). */
function toDateInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** date 값 → epoch ms — 로컬 09:00(장 시작) 고정. 시간은 기록하지 않는다 (사용자 확정). */
function parseDateInput(v: string): number | null {
  const m = DATE_INPUT_RE.exec(v)
  if (!m) return null
  const ms = new Date(+m[1], +m[2] - 1, +m[3], 9, 0, 0).getTime()
  return Number.isFinite(ms) ? ms : null
}
