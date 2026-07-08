import { useCallback, useRef, useState } from 'react'
import type {
  LedgerImportResult,
  LedgerInstrument,
  ImportPosition,
} from '@/types/lp'

/**
 * 회사 원장 엑셀 업로드 모달 (§13.5 — 회사 원장 → LP 매트릭스 반영).
 *
 * 파일 다중 선택(.xls/.xlsx) → dry_run 미리보기 → "원장에 반영"(확정). 파싱·정합·환산은
 * 백엔드 services/ledger_import.py. 선물 단위 토글·replace_all 변경 시 dry_run 재호출.
 */

const INST_LABEL: Record<LedgerInstrument, string> = {
  etf: 'ETF',
  stock: '현물',
  stock_fut: '주식선물',
  index_fut: '지수선물',
}

const WARN_LABEL: Record<string, string> = {
  reconcile: '정합',
  collateral_negative: '담보',
  duplicate_file: '중복',
  set_mix: '세트',
}

const fmtQty = (n: number) => n.toLocaleString('ko-KR')
const fmtSigned = (n: number) => (n > 0 ? `+${fmtQty(n)}` : fmtQty(n))
const fmtPx = (n: number | null) =>
  n == null ? '-' : n.toLocaleString('ko-KR', { maximumFractionDigits: 2 })

function qtyColor(q: number): string {
  return q > 0 ? '' : q < 0 ? 'var(--color-down)' : 'var(--color-t4)'
}

export function LedgerImportModal({
  onClose,
  onApplied,
}: {
  onClose: () => void
  onApplied: () => void
}) {
  const [files, setFiles] = useState<File[]>([])
  const [result, setResult] = useState<LedgerImportResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [err, setErr] = useState('')
  const [futuresUnit, setFuturesUnit] = useState<'contracts' | 'shares'>('contracts')
  const [replaceAll, setReplaceAll] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // dry_run 요청 시퀀스 — 토글 연속 클릭 시 이전 응답이 늦게 도착해 최신 상태를
  // 덮는 race 차단 (최신 seq 응답만 반영).
  const reqSeq = useRef(0)

  const runDryRun = useCallback(
    async (fs: File[], unit: 'contracts' | 'shares', replace: boolean) => {
      if (fs.length === 0) return
      const seq = ++reqSeq.current
      setLoading(true)
      setErr('')
      try {
        const fd = new FormData()
        for (const f of fs) fd.append('files', f)
        fd.append('dry_run', 'true')
        fd.append('futures_unit', unit)
        fd.append('replace_all', String(replace))
        const r = await fetch('/api/lp/ledger/import-excel', { method: 'POST', body: fd })
        if (seq !== reqSeq.current) return // stale — 더 새 요청이 이미 나감
        if (!r.ok) {
          const d = await r.json().catch(() => ({}))
          if (seq !== reqSeq.current) return
          setErr(typeof d.detail === 'string' ? d.detail : `미리보기 실패 (${r.status})`)
          setResult(null)
          return
        }
        const data = await r.json()
        if (seq !== reqSeq.current) return
        setResult(data)
      } catch (e) {
        if (seq !== reqSeq.current) return
        setErr(String(e))
        setResult(null)
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [],
  )

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? [])
    setFiles(fs)
    setResult(null)
    if (fs.length) void runDryRun(fs, futuresUnit, replaceAll)
  }

  const changeUnit = (unit: 'contracts' | 'shares') => {
    setFuturesUnit(unit)
    if (files.length) void runDryRun(files, unit, replaceAll)
  }
  const changeReplace = (replace: boolean) => {
    setReplaceAll(replace)
    if (files.length) void runDryRun(files, futuresUnit, replace)
  }

  const apply = async () => {
    if (files.length === 0) return
    setApplying(true)
    setErr('')
    try {
      const fd = new FormData()
      for (const f of files) fd.append('files', f)
      fd.append('dry_run', 'false')
      fd.append('futures_unit', futuresUnit)
      fd.append('replace_all', String(replaceAll))
      const r = await fetch('/api/lp/ledger/import-excel', { method: 'POST', body: fd })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setErr(typeof d.detail === 'string' ? d.detail : `반영 실패 (${r.status})`)
        return
      }
      onApplied()
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setApplying(false)
    }
  }

  const s = result?.summary

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-bg-primary w-full max-w-5xl my-4 rounded-sm shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 bg-bg-surface rounded-t-sm">
          <div>
            <div className="text-[13px] text-t1 font-medium">회사 원장 엑셀 업로드</div>
            <div className="text-[10px] text-t4">
              5264(수량관리) · 3454(장부) · 2514(선물) 자동 판별 → LP 매트릭스 원장 반영
            </div>
          </div>
          <button onClick={onClose} className="text-t3 hover:text-t1 text-lg px-2 leading-none">
            ×
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {/* 파일 선택 + 옵션 (조작 요소 한 패널) */}
          <div className="bg-bg-base p-3 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-[11px] px-3 py-1.5 bg-accent text-bg-base font-medium hover:opacity-90 rounded-sm"
              >
                파일 선택
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xls,.xlsx"
                multiple
                onChange={onPickFiles}
                className="hidden"
              />
              <span className="text-[11px] text-t3">
                {files.length ? `${files.length}개 선택됨` : '.xls / .xlsx 다중 선택'}
              </span>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-[10px] text-t4 mr-1">선물 단위</span>
              {(['contracts', 'shares'] as const).map((u) => (
                <button
                  key={u}
                  onClick={() => changeUnit(u)}
                  className={`text-[10px] px-2 py-1 rounded-sm ${
                    futuresUnit === u ? 'bg-bg-surface text-t1' : 'bg-bg-primary text-t4 hover:text-t2'
                  }`}
                >
                  {u === 'contracts' ? '계약수' : '주수'}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-1.5 text-[11px] text-t2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={replaceAll}
                onChange={(e) => changeReplace(e.target.checked)}
                className="accent-accent"
              />
              전체 교체 (원장 초기화 후 재구성)
            </label>

            {loading && <span className="text-[11px] text-blue">파싱 중…</span>}
          </div>

          {err && <div className="text-[11px] text-down bg-down/10 px-3 py-2 rounded-sm">{err}</div>}

          {result && (
            <>
              {/* 파일 인식 요약 */}
              <div className="bg-bg-base p-3">
                <div className="text-[11px] text-t3 mb-2 font-medium">인식 요약</div>
                <table className="w-full text-[11px]">
                  <thead className="text-t4 text-[10px]">
                    <tr>
                      <th className="text-left py-1 font-normal">파일</th>
                      <th className="text-left py-1 font-normal">화면</th>
                      <th className="text-left py-1 font-normal">펀드 유형</th>
                      <th className="text-right py-1 font-normal">행 수</th>
                      <th className="text-left py-1 font-normal pl-3">비고</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono tabular-nums">
                    {result.files.map((f, i) => (
                      <tr key={i} className="border-t border-bg-primary/60">
                        <td className="py-1 text-t2 truncate max-w-[240px]">{f.filename}</td>
                        <td className="py-1 text-t3">{f.screen}</td>
                        <td className="py-1 text-t3">{f.fund_types.join(', ') || '-'}</td>
                        <td className="py-1 text-right text-t3">{fmtQty(f.parsed_rows)}</td>
                        <td className="py-1 pl-3 text-[10px]">
                          {f.error && <span className="text-down">{f.error}</span>}
                          {!f.error && f.note && <span className="text-t4">{f.note}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {s && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-t4 font-mono tabular-nums">
                    <span>포지션 {s.n_positions}</span>
                    <span>체결 {s.n_fills}</span>
                    <span>선물환산 {s.n_conversions}</span>
                    <span className={s.n_reconcile_warnings ? 'text-warning' : ''}>
                      정합경고 {s.n_reconcile_warnings}
                    </span>
                    <span className={s.n_collateral_warnings ? 'text-warning' : ''}>
                      담보경고 {s.n_collateral_warnings}
                    </span>
                    <span className={s.n_excluded ? 'text-down' : ''}>제외 {s.n_excluded}</span>
                    {s.n_files_duplicate > 0 && (
                      <span className="text-warning">중복파일 {s.n_files_duplicate}</span>
                    )}
                    {s.n_files_error > 0 && (
                      <span className="text-down">실패파일 {s.n_files_error} — 제외 후 재업로드 필요</span>
                    )}
                  </div>
                )}
              </div>

              {/* 삭제 예상 종목 (replace_all) */}
              {result.replace_all && result.removed.length > 0 && (
                <div className="bg-bg-base p-3">
                  <div className="text-[11px] text-warning mb-1 font-medium">
                    전체 교체 시 삭제될 기존 원장 종목 {result.removed.length}개
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-t3 font-mono tabular-nums max-h-24 overflow-y-auto">
                    {result.removed.map((r) => (
                      <span key={r.code}>
                        {r.code}
                        {r.name ? `(${r.name})` : ''} {fmtSigned(r.net_qty)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 포지션 테이블 */}
              <div className="bg-bg-base p-3">
                <div className="text-[11px] text-t3 mb-2 font-medium">
                  반영될 포지션 ({result.positions.length})
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="text-t4 text-[10px] sticky top-0 bg-bg-base">
                      <tr>
                        <th className="text-left py-1 font-normal">코드 / 이름</th>
                        <th className="text-left py-1 font-normal">유형</th>
                        <th className="text-right py-1 font-normal">이월</th>
                        <th className="text-right py-1 font-normal">당일 체결</th>
                        <th className="text-right py-1 font-normal">순 수량</th>
                        <th className="text-right py-1 font-normal">평단</th>
                        <th className="text-left py-1 font-normal pl-3">환산 / 정합</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {result.positions.map((p: ImportPosition) => (
                        <tr key={p.code} className="border-t border-bg-primary/60">
                          <td className="py-1 text-t2">
                            <span className="text-t1">{p.code}</span>
                            {p.name && <span className="text-t4 ml-1 text-[10px]">{p.name}</span>}
                          </td>
                          <td className="py-1 text-t4 text-[10px]">{INST_LABEL[p.instrument]}</td>
                          <td className="py-1 text-right text-t3">{fmtQty(p.carryover_qty)}</td>
                          <td
                            className="py-1 text-right"
                            style={{ color: qtyColor(p.fills_qty_today) }}
                          >
                            {p.fills_qty_today === 0 ? '-' : fmtSigned(p.fills_qty_today)}
                          </td>
                          <td
                            className="py-1 text-right font-medium"
                            style={{ color: qtyColor(p.net_qty) }}
                          >
                            {fmtQty(p.net_qty)}
                          </td>
                          <td className="py-1 text-right text-t3">{fmtPx(p.avg_price)}</td>
                          <td className="py-1 pl-3 text-[10px]">
                            {p.conversion_note && <span className="text-blue">{p.conversion_note}</span>}
                            {!p.reconciled && (
                              <span className="text-warning">{p.recon_detail}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 경고 / 제외 */}
              {(result.warnings.length > 0 || result.excluded.length > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {result.warnings.length > 0 && (
                    <div className="bg-bg-base p-3">
                      <div className="text-[11px] text-warning mb-1 font-medium">
                        경고 {result.warnings.length}
                      </div>
                      <div className="max-h-40 overflow-y-auto text-[10px] font-mono tabular-nums flex flex-col gap-0.5">
                        {result.warnings.map((w, i) => (
                          <div key={i} className="text-warning">
                            <span className="text-t3">
                              [{WARN_LABEL[w.type] ?? w.type}] {w.code}
                              {w.name ? `(${w.name})` : ''}
                            </span>{' '}
                            {w.detail}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {result.excluded.length > 0 && (
                    <div className="bg-bg-base p-3">
                      <div className="text-[11px] text-down mb-1 font-medium">
                        제외 {result.excluded.length}
                      </div>
                      <div className="max-h-40 overflow-y-auto text-[10px] font-mono tabular-nums flex flex-col gap-0.5">
                        {result.excluded.map((x, i) => (
                          <div key={i} className="text-down">
                            <span className="text-t3">
                              {x.code}
                              {x.name ? `(${x.name})` : ''}
                            </span>{' '}
                            {x.reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 푸터 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 bg-bg-surface rounded-b-sm">
          <button
            onClick={onClose}
            className="text-[11px] px-4 py-1.5 bg-bg-primary text-t2 hover:text-t1 rounded-sm"
          >
            취소
          </button>
          <button
            onClick={apply}
            disabled={
              applying ||
              !result ||
              result.positions.length === 0 ||
              result.summary.n_files_error > 0
            }
            title={
              result && result.summary.n_files_error > 0
                ? '파싱 실패 파일이 있어 확정 불가 — 제외 후 재업로드'
                : undefined
            }
            className="text-[11px] px-4 py-1.5 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-40 rounded-sm"
          >
            {applying ? '반영 중…' : '원장에 반영'}
          </button>
        </div>
      </div>
    </div>
  )
}
