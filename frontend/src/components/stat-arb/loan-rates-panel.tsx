import { useCallback, useEffect, useRef, useState } from 'react'

type LoanRate = {
  code: string
  rate_pct: number
  source: string
  updated_at: number
}

export function LoanRatesPanel({
  names,
  onClose,
}: {
  /** code → 종목명 lookup. 없으면 코드만 표시. */
  names?: Map<string, string>
  /** 있으면 헤더 우측에 "닫기" 버튼 표시 (inline 패널용). 별도 페이지면 미전달. */
  onClose?: () => void
}) {
  const [rates, setRates] = useState<LoanRate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 입력 폼
  const [codeInput, setCodeInput] = useState('')
  const [rateInput, setRateInput] = useState('')

  // CSV 업로드
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch('/api/loan-rates')
      .then((r) => r.json())
      .then((d) => setRates(d.items))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleSave = async () => {
    const code = codeInput.trim()
    const rate = parseFloat(rateInput)
    if (!code || !isFinite(rate) || rate < 0) {
      setError('종목코드와 0 이상 숫자 요율 필요')
      return
    }
    setError(null)
    try {
      const r = await fetch(`/api/loan-rates/${encodeURIComponent(code)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_pct: rate, source: 'manual' }),
      })
      if (!r.ok) throw new Error(await r.text())
      setCodeInput('')
      setRateInput('')
      load()
    } catch (e) {
      setError(`저장 실패: ${e}`)
    }
  }

  const handleDelete = async (code: string) => {
    if (!confirm(`${code} 대여요율 삭제?`)) return
    try {
      const r = await fetch(`/api/loan-rates/${encodeURIComponent(code)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(await r.text())
      load()
    } catch (e) {
      setError(`삭제 실패: ${e}`)
    }
  }

  const handleCsvUpload = async (file: File) => {
    setError(null)
    const fd = new FormData()
    fd.append('file', file)
    try {
      const r = await fetch('/api/loan-rates/csv-import', { method: 'POST', body: fd })
      const result = await r.json()
      if (!r.ok) throw new Error(JSON.stringify(result))
      if (result.errors?.length) {
        setError(`일부 행 실패 (${result.errors.length}): ${result.errors.slice(0, 3).join(' / ')}`)
      }
      load()
    } catch (e) {
      setError(`CSV 업로드 실패: ${e}`)
    }
  }

  return (
    <div className="panel p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-t1">대여요율 관리</span>
          <span className="text-xs text-t3">{rates.length}건 등록</span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="rounded-sm px-2 py-1 text-xs text-t3 hover:bg-bg-surface hover:text-t1"
          >
            닫기 ✕
          </button>
        )}
      </div>

      {/* 입력 폼 + CSV */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          placeholder="종목코드 (예: 005930, A005930)"
          className="w-[240px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none"
        />
        <input
          type="number"
          step="0.1"
          value={rateInput}
          onChange={(e) => setRateInput(e.target.value)}
          placeholder="연 % (예: 15.5)"
          className="w-[140px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none"
        />
        <button
          onClick={handleSave}
          className="rounded-sm bg-accent/20 px-3 py-1 text-xs text-accent hover:bg-accent/30"
        >
          저장
        </button>

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) {
                handleCsvUpload(f)
                e.target.value = ''
              }
            }}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-sm bg-bg-surface px-3 py-1 text-xs text-t2 hover:text-t1"
            title="CSV 포맷: code,rate_pct (헤더 필수). UTF-8."
          >
            CSV 업로드
          </button>
        </div>
      </div>

      {error && <div className="mb-2 text-xs text-down">{error}</div>}

      {/* 목록 */}
      <div className="max-h-[280px] overflow-y-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 bg-bg-primary">
            <tr className="border-b border-bg-surface text-left text-t3">
              <th className="px-2 py-1.5 font-normal">종목</th>
              <th className="px-2 py-1.5 text-right font-normal">요율</th>
              <th className="px-2 py-1.5 font-normal">출처</th>
              <th className="px-2 py-1.5 font-normal">갱신</th>
              <th className="px-2 py-1.5 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {rates.map((r) => {
              const name =
                names?.get(`S:${r.code}`) ?? names?.get(`E:${r.code}`) ?? names?.get(r.code) ?? '—'
              const dateStr = new Date(r.updated_at).toLocaleString('ko-KR', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })
              const hot = r.rate_pct >= 15 // 고요율 강조
              return (
                <tr key={r.code} className="border-b border-bg-surface/40">
                  <td className="px-2 py-1.5">
                    <span className="text-t1">{name}</span>{' '}
                    <span className="text-[10px] text-t4">{r.code}</span>
                  </td>
                  <td className={`px-2 py-1.5 text-right ${hot ? 'text-warning font-semibold' : 'text-t1'}`}>
                    {r.rate_pct.toFixed(1)}%
                  </td>
                  <td className="px-2 py-1.5 text-t3">{r.source}</td>
                  <td className="px-2 py-1.5 text-t3">{dateStr}</td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      onClick={() => handleDelete(r.code)}
                      className="rounded-sm px-2 py-0.5 text-[10px] text-t3 hover:bg-down/20 hover:text-down"
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!loading && rates.length === 0 && (
          <div className="p-3 text-center text-xs text-t3">등록된 대여요율 없음</div>
        )}
      </div>

      {/* CSV 포맷 안내 */}
      <div className="mt-2 text-[10px] text-t4">
        CSV 포맷: <code className="text-t3">code,rate_pct</code> 헤더 필수. 선택 컬럼:{' '}
        <code className="text-t3">source</code>. UTF-8.
      </div>
    </div>
  )
}
