import { useState, useRef, useEffect } from "react"
import * as XLSX from "xlsx"

interface RepaymentMatch {
  펀드코드: string
  펀드명: string
  종목코드: string
  종목명: string
  상환수량: number
  체결일: string
  체결번호: number
  대여자계좌: string
  대여자명: string
  수수료율: number
  기준가액: number
  대차금액: number
}

interface StockSummary {
  종목코드: string
  종목명: string
  상환수량: number
  대차금액: number
  체결건수: number
  최고수수료율: number
}

interface RepaymentResponse {
  matches: RepaymentMatch[]
  summary: StockSummary[]
  remaining_office: Record<string, unknown>[]
  remaining_esafe: Record<string, unknown>[]
  no_esafe_stocks: Record<string, unknown>[]
  total_qty: number
  total_amount: number
}

function fmt(n: number) {
  return n.toLocaleString("ko-KR")
}

export function RepaymentCheckPage() {
  const [data, setData] = useState<RepaymentResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [officeFile, setOfficeFile] = useState<File | null>(null)
  const [esafeFile, setEsafeFile] = useState<File | null>(null)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState(true)

  // 5264 필터
  const [excludeFundCodes, setExcludeFundCodes] = useState<string[]>([])
  const [fundCodeInput, setFundCodeInput] = useState("")
  const [officeStockCodes, setOfficeStockCodes] = useState<string[]>([])
  const [officeStockCodeInput, setOfficeStockCodeInput] = useState("")
  const [officeStockNames, setOfficeStockNames] = useState<string[]>([])
  const [officeStockNameInput, setOfficeStockNameInput] = useState("")

  // 예탁원 필터
  const [excludeAssetMgmt, setExcludeAssetMgmt] = useState(false)
  const [excludeSecurities, setExcludeSecurities] = useState(false)
  const [lenderList, setLenderList] = useState<{ account: string; name: string }[]>([])
  const [excludeLenders, setExcludeLenders] = useState<string[]>([])
  const [lenderInput, setLenderInput] = useState("")
  const [lenderDropdownOpen, setLenderDropdownOpen] = useState(false)
  const lenderRef = useRef<HTMLDivElement>(null)
  const [excludeFeeRates, setExcludeFeeRates] = useState<string[]>([])
  const [feeRateInput, setFeeRateInput] = useState("")
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const [excludeDates, setExcludeDates] = useState<string[]>([today])
  const [dateInput, setDateInput] = useState("")
  const [esafeStockCodes, setEsafeStockCodes] = useState<string[]>([])
  const [esafeStockCodeInput, setEsafeStockCodeInput] = useState("")
  const [esafeStockNames, setEsafeStockNames] = useState<string[]>([])
  const [esafeStockNameInput, setEsafeStockNameInput] = useState("")

  const addTag = (value: string, list: string[], setList: (v: string[]) => void, setInput: (v: string) => void) => {
    const v = value.trim()
    if (v && !list.includes(v)) setList([...list, v])
    setInput("")
  }

  const fetchLenders = async (file: File) => {
    const form = new FormData()
    form.append("esafe_file", file)
    try {
      const res = await fetch("/api/repayment/lenders", { method: "POST", body: form })
      if (res.ok) {
        const json = await res.json()
        setLenderList(json.lenders)
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (lenderRef.current && !lenderRef.current.contains(e.target as Node)) {
        setLenderDropdownOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const filteredLenderList = lenderList.filter(
    (l) => !excludeLenders.includes(l.name) && (lenderInput === "" || l.name.includes(lenderInput) || l.account.includes(lenderInput))
  )

  const addFundCode = () => {
    const raw = fundCodeInput.trim()
    if (!raw) { setFundCodeInput(""); return }
    const code = raw.length <= 3 ? raw.padStart(3, "0") : raw.padStart(6, "0")
    if ((code.length === 3 || code.length === 6) && !excludeFundCodes.includes(code)) {
      setExcludeFundCodes([...excludeFundCodes, code].sort())
    }
    setFundCodeInput("")
  }

  const addDate = () => {
    const d = dateInput.trim().replace(/-/g, "")
    if (d.length === 8 && !excludeDates.includes(d)) {
      setExcludeDates([...excludeDates, d])
    }
    setDateInput("")
  }

  const handleCalculate = async () => {
    if (!officeFile || !esafeFile) {
      setError("오피스 파일과 예탁원 파일을 모두 선택하세요")
      return
    }

    setLoading(true)
    setError(null)
    setData(null)
    setExpandedRows(new Set())

    const form = new FormData()
    form.append("office_file", officeFile)
    form.append("esafe_file", esafeFile)
    if (excludeFundCodes.length > 0) form.append("exclude_fund_codes", excludeFundCodes.join(","))
    if (officeStockCodes.length > 0) form.append("exclude_office_stock_code", officeStockCodes.join(","))
    if (officeStockNames.length > 0) form.append("exclude_office_stock_name", officeStockNames.join(","))
    if (excludeLenders.length > 0) form.append("exclude_lender", excludeLenders.join(","))
    if (excludeAssetMgmt) form.append("exclude_asset_mgmt", "true")
    if (excludeSecurities) form.append("exclude_securities", "true")
    if (excludeFeeRates.length > 0) form.append("exclude_fee_rate_below", excludeFeeRates[excludeFeeRates.length - 1])
    if (excludeDates.length > 0) form.append("exclude_dates", excludeDates.join(","))
    if (esafeStockCodes.length > 0) form.append("exclude_esafe_stock_code", esafeStockCodes.join(","))
    if (esafeStockNames.length > 0) form.append("exclude_esafe_stock_name", esafeStockNames.join(","))

    try {
      const res = await fetch("/api/repayment/calculate", {
        method: "POST",
        body: form,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `서버 오류 (${res.status})`)
      }
      const json: RepaymentResponse = await res.json()
      setData(json)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "처리 실패")
    } finally {
      setLoading(false)
    }
  }

  const toggleRow = (code: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  const matchesByStock = (code: string) =>
    data?.matches.filter((m) => m.종목코드 === code) ?? []

  const exportToExcel = () => {
    if (!data) return

    const matchRows = data.matches.map((m) => ({
      펀드코드: m.펀드코드,
      펀드명: m.펀드명,
      종목코드: m.종목코드,
      종목명: m.종목명,
      상환수량: m.상환수량,
      체결일: m.체결일,
      체결번호: m.체결번호,
      대여자계좌: m.대여자계좌,
      대여자명: m.대여자명,
      "수수료율(%)": m.수수료율,
      기준가액: m.기준가액,
      대차금액: m.대차금액,
    }))

    const summaryRows = data.summary.map((s) => ({
      종목코드: s.종목코드,
      종목명: s.종목명,
      상환수량: s.상환수량,
      대차금액: s.대차금액,
      체결건수: s.체결건수,
      최고수수료율: s.최고수수료율,
    }))

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(matchRows), "상환 내역")
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "종목별 합산")
    if (data.remaining_office.length > 0)
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.remaining_office), "상환 후 오피스")
    if (data.remaining_esafe.length > 0)
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.remaining_esafe), "상환 후 예탁원")
    if (data.no_esafe_stocks.length > 0)
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.no_esafe_stocks), "내부차입 추정")

    XLSX.writeFile(wb, "상환가능확인_결과.xlsx")
  }

  return (
    <div className="flex flex-col gap-px bg-border h-full">
      {/* Upload Bar */}
      <div className="panel px-4 py-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3 whitespace-nowrap">오피스(5264)</span>
          <input
            type="file"
            className="text-sm text-t3 file:mr-2 file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
            onChange={(e) => setOfficeFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3 whitespace-nowrap">예탁원(대차내역)</span>
          <input
            type="file"
            className="text-sm text-t3 file:mr-2 file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setEsafeFile(f)
              if (f) fetchLenders(f)
            }}
          />
        </div>
        <button
          className="rounded bg-accent px-4 py-2 text-sm text-black font-semibold hover:bg-accent-hover active:scale-95 active:brightness-90 transition-all"
          onClick={handleCalculate}
        >
          계산 실행
        </button>
        {loading && <span className="text-xs text-accent font-mono">처리 중...</span>}
        {error && <span className="text-xs text-down font-mono">{error}</span>}
      </div>

      {/* Filter Panel */}
      <div className="panel">
        <button
          className="w-full px-4 py-2 flex items-center gap-2 text-xs text-t3 hover:text-t2 transition-colors"
          onClick={() => setFilterOpen(!filterOpen)}
        >
          <span className={`transition-transform duration-150 ${filterOpen ? "rotate-90" : ""}`}>{"\u25B6"}</span>
          <span className="font-medium">필터</span>
          {(excludeFundCodes.length > 0 || officeStockCodes.length > 0 || officeStockNames.length > 0 || excludeLenders.length > 0 || excludeFeeRates.length > 0 || excludeDates.length > 0 || esafeStockCodes.length > 0 || esafeStockNames.length > 0) && (
            <span className="text-accent">적용 중</span>
          )}
        </button>
        {filterOpen && (
          <div className="px-4 pb-3 flex flex-col gap-3">
            {/* 5264 제외조건 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-t4 font-medium">5264 제외조건</span>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 w-14">펀드코드</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-28 outline-none focus:ring-1 focus:ring-accent"
                    placeholder="3자리 또는 6자리"
                    value={fundCodeInput}
                    onChange={(e) => setFundCodeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addFundCode()}
                    maxLength={6}
                  />
                  <button className="text-xs text-accent hover:text-accent-hover px-1" onClick={addFundCode}>+</button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 w-14">종목코드</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-24 outline-none focus:ring-1 focus:ring-accent"
                    placeholder="6자리"
                    value={officeStockCodeInput}
                    onChange={(e) => setOfficeStockCodeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addTag(officeStockCodeInput, officeStockCodes, setOfficeStockCodes, setOfficeStockCodeInput)}
                    maxLength={6}
                  />
                  <button className="text-xs text-accent hover:text-accent-hover px-1" onClick={() => addTag(officeStockCodeInput, officeStockCodes, setOfficeStockCodes, setOfficeStockCodeInput)}>+</button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 w-10">종목명</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs text-t1 w-28 outline-none focus:ring-1 focus:ring-accent"
                    value={officeStockNameInput}
                    onChange={(e) => setOfficeStockNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addTag(officeStockNameInput, officeStockNames, setOfficeStockNames, setOfficeStockNameInput)}
                  />
                </div>
              </div>
              {(excludeFundCodes.length > 0 || officeStockCodes.length > 0 || officeStockNames.length > 0) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {excludeFundCodes.length > 0 && <span className="text-[11px] text-t4">펀드:</span>}
                  {excludeFundCodes.map((c) => (
                    <button key={`f-${c}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-t2 transition-colors cursor-pointer" onClick={() => setExcludeFundCodes(excludeFundCodes.filter((x) => x !== c))}>{c} ×</button>
                  ))}
                  {officeStockCodes.length > 0 && <span className="text-[11px] text-t4 ml-1">종목:</span>}
                  {officeStockCodes.map((c) => (
                    <button key={`sc-${c}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-t2 transition-colors cursor-pointer" onClick={() => setOfficeStockCodes(officeStockCodes.filter((x) => x !== c))}>{c} ×</button>
                  ))}
                  {officeStockNames.length > 0 && <span className="text-[11px] text-t4 ml-1">종목명:</span>}
                  {officeStockNames.map((c) => (
                    <button key={`sn-${c}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs text-t2 transition-colors cursor-pointer" onClick={() => setOfficeStockNames(officeStockNames.filter((x) => x !== c))}>{c} ×</button>
                  ))}
                </div>
              )}
            </div>

            {/* 예탁원 제외조건 */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] text-t4 font-medium">대차내역 제외조건</span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={excludeAssetMgmt} onChange={(e) => setExcludeAssetMgmt(e.target.checked)} className="accent-accent" />
                  <span className="text-xs text-t3">운용사 제외</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={excludeSecurities} onChange={(e) => setExcludeSecurities(e.target.checked)} className="accent-accent" />
                  <span className="text-xs text-t3">증권사 제외</span>
                </label>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1 relative" ref={lenderRef}>
                  <span className="text-xs text-t3 w-10">대여자</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs text-t1 w-40 outline-none focus:ring-1 focus:ring-accent"
                    value={lenderInput}
                    onChange={(e) => { setLenderInput(e.target.value); setLenderDropdownOpen(true) }}
                    onFocus={() => setLenderDropdownOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        addTag(lenderInput, excludeLenders, setExcludeLenders, setLenderInput)
                        setLenderDropdownOpen(false)
                      }
                    }}
                    placeholder={lenderList.length > 0 ? "선택 또는 입력" : "직접 입력"}
                    style={lenderList.length > 0 ? { paddingRight: "1.25rem" } : undefined}
                  />
                  {lenderList.length > 0 && (
                    <span
                      className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] text-t4 pointer-events-none"
                    >
                      {lenderDropdownOpen ? "\u25B2" : "\u25BC"}
                    </span>
                  )}
                  <button className="text-xs text-accent hover:text-accent-hover px-1" onClick={() => { addTag(lenderInput, excludeLenders, setExcludeLenders, setLenderInput); setLenderDropdownOpen(false) }}>+</button>
                  {lenderDropdownOpen && filteredLenderList.length > 0 && (
                    <div className="absolute top-full left-10 mt-1 w-max min-w-64 max-h-48 overflow-y-auto bg-bg-surface rounded border border-border-light z-20">
                      {filteredLenderList.map((l) => (
                        <button
                          key={l.account}
                          className="w-full text-left px-3 py-1.5 text-xs text-t2 hover:bg-bg-hover transition-colors flex gap-4 whitespace-nowrap"
                          onClick={() => {
                            if (!excludeLenders.includes(l.name)) setExcludeLenders([...excludeLenders, l.name])
                            setLenderInput("")
                            setLenderDropdownOpen(false)
                          }}
                        >
                          <span>{l.name}</span>
                          <span className="font-mono text-t4">{l.account}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 whitespace-nowrap">수수료율</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-16 outline-none focus:ring-1 focus:ring-accent"
                    placeholder="%"
                    value={feeRateInput}
                    onChange={(e) => setFeeRateInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        const v = feeRateInput.trim()
                        if (v && !excludeFeeRates.includes(v)) setExcludeFeeRates([...excludeFeeRates, v])
                        setFeeRateInput("")
                      }
                    }}
                  />
                  <span className="text-xs text-t4">% 이하 제외</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 w-10">체결일</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-24 outline-none focus:ring-1 focus:ring-accent"
                    placeholder="YYYYMMDD"
                    value={dateInput}
                    onChange={(e) => setDateInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addDate()}
                    maxLength={8}
                  />
                  <button className="text-xs text-accent hover:text-accent-hover px-1" onClick={addDate}>+</button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 w-14">종목코드</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-24 outline-none focus:ring-1 focus:ring-accent"
                    placeholder="6자리"
                    value={esafeStockCodeInput}
                    onChange={(e) => setEsafeStockCodeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addTag(esafeStockCodeInput, esafeStockCodes, setEsafeStockCodes, setEsafeStockCodeInput)}
                    maxLength={6}
                  />
                  <button className="text-xs text-accent hover:text-accent-hover px-1" onClick={() => addTag(esafeStockCodeInput, esafeStockCodes, setEsafeStockCodes, setEsafeStockCodeInput)}>+</button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-t3 w-10">종목명</span>
                  <input
                    className="bg-bg-input rounded px-2 py-1 text-xs text-t1 w-28 outline-none focus:ring-1 focus:ring-accent"
                    value={esafeStockNameInput}
                    onChange={(e) => setEsafeStockNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addTag(esafeStockNameInput, esafeStockNames, setEsafeStockNames, setEsafeStockNameInput)}
                  />
                </div>
              </div>
              {(excludeLenders.length > 0 || excludeFeeRates.length > 0 || excludeDates.length > 0 || esafeStockCodes.length > 0 || esafeStockNames.length > 0) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {excludeLenders.length > 0 && <span className="text-[11px] text-t4">대여자:</span>}
                  {excludeLenders.map((l) => (
                    <button key={`l-${l}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs text-t2 transition-colors cursor-pointer" onClick={() => setExcludeLenders(excludeLenders.filter((x) => x !== l))}>{l} ×</button>
                  ))}
                  {excludeFeeRates.length > 0 && <span className="text-[11px] text-t4 ml-1">수수료율:</span>}
                  {excludeFeeRates.map((r) => (
                    <button key={`r-${r}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-t2 transition-colors cursor-pointer" onClick={() => setExcludeFeeRates(excludeFeeRates.filter((x) => x !== r))}>{r}% 이하 ×</button>
                  ))}
                  {excludeDates.length > 0 && <span className="text-[11px] text-t4 ml-1">체결일:</span>}
                  {excludeDates.map((d) => (
                    <button key={`d-${d}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-t2 transition-colors cursor-pointer" onClick={() => setExcludeDates(excludeDates.filter((x) => x !== d))}>{d} ×</button>
                  ))}
                  {esafeStockCodes.length > 0 && <span className="text-[11px] text-t4 ml-1">종목:</span>}
                  {esafeStockCodes.map((c) => (
                    <button key={`esc-${c}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-t2 transition-colors cursor-pointer" onClick={() => setEsafeStockCodes(esafeStockCodes.filter((x) => x !== c))}>{c} ×</button>
                  ))}
                  {esafeStockNames.length > 0 && <span className="text-[11px] text-t4 ml-1">종목명:</span>}
                  {esafeStockNames.map((c) => (
                    <button key={`esn-${c}`} className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs text-t2 transition-colors cursor-pointer" onClick={() => setEsafeStockNames(esafeStockNames.filter((x) => x !== c))}>{c} ×</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {data && (
        <>
          {/* Summary Cards */}
          <div className="panel px-4 py-2">
            <div className="grid grid-cols-4 gap-2">
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">매칭 종목 수</p>
                <p className="font-mono text-lg font-semibold text-up">{data.summary.length}</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">매칭 건수</p>
                <p className="font-mono text-lg font-semibold text-up">{data.matches.length}</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">상환 수량</p>
                <p className="font-mono text-lg font-semibold text-up">{fmt(data.total_qty)}주</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">상환 금액</p>
                <p className="font-mono text-lg font-semibold text-up">{fmt(data.total_amount)}원</p>
              </div>
            </div>
          </div>

          {/* Remaining Esafe Summary */}
          {data.remaining_esafe.length > 0 && (
            <div className="panel px-4 py-2">
              <div className={`grid gap-2 ${data.no_esafe_stocks.length > 0 ? "grid-cols-4" : "grid-cols-3"}`}>
                <div className="panel-inner rounded px-3 py-2">
                  <p className="text-[11px] text-t3">미상환 건수</p>
                  <p className="font-mono text-lg font-semibold text-down">{data.remaining_esafe.length}</p>
                </div>
                <div className="panel-inner rounded px-3 py-2">
                  <p className="text-[11px] text-t3">미상환 수량</p>
                  <p className="font-mono text-lg font-semibold text-down">
                    {fmt((data.remaining_esafe as Record<string, number>[]).reduce((s, r) => s + (r["대차수량"] ?? 0), 0))}주
                  </p>
                </div>
                <div className="panel-inner rounded px-3 py-2">
                  <p className="text-[11px] text-t3">미상환 금액</p>
                  <p className="font-mono text-lg font-semibold text-down">
                    {fmt((data.remaining_esafe as Record<string, number>[]).reduce((s, r) => s + (r["대차가액"] ?? 0), 0))}원
                  </p>
                </div>
                {data.no_esafe_stocks.length > 0 && (
                  <div className="panel-inner rounded px-3 py-2">
                    <p className="text-[11px] text-t3 flex items-center gap-1">
                      내부차입 추정
                      <span className="relative group">
                        <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-t4 text-[9px] text-t4 cursor-help">?</span>
                        <span className="absolute bottom-full left-0 mb-2 w-72 px-4 py-3 rounded bg-bg-surface-3 text-xs text-t2 leading-relaxed hidden group-hover:block z-30 shadow-lg">
                          오피스(5264)에 담보가능수량이 있지만,<br />
                          예탁원(대차내역)에 해당 종목의 체결건이 없는 경우.<br /><br />
                          예탁원은 외부 차입만 기록하므로<br />
                          내부(PBS) 차입으로 추정합니다.<br /><br />
                          다만, 사용자가 예탁원 대차내역에서 직접 대상 리스트를 제외한 경우는 내부차입이 아닌 경우가 포함될 수 있습니다.
                        </span>
                      </span>
                    </p>
                    <p className="font-mono text-lg font-semibold text-warning">{data.no_esafe_stocks.length}건</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Export */}
          <div className="panel px-4 py-2 flex justify-end">
            <button
              className="rounded bg-bg-surface-2 px-4 py-2 text-sm text-t2 font-medium hover:bg-bg-surface-3 active:scale-95 transition-all"
              onClick={exportToExcel}
            >
              엑셀 저장
            </button>
          </div>

          {/* Results Table — 종목별 합산 (아코디언) */}
          <div className="panel flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface z-10">
                  <tr className="text-[13px] text-t2 border-b border-border-light">
                    <th className="text-center px-2 py-2.5 font-medium text-t3 w-10">No</th>
                    <th className="text-left px-4 py-2.5 font-medium w-8">
                      <span
                        className="cursor-pointer text-accent hover:text-accent-hover transition-colors select-none"
                        onClick={() => {
                          const codes = data.summary.map((s) => s.종목코드)
                          const allExpanded = codes.every((c) => expandedRows.has(c))
                          setExpandedRows(allExpanded ? new Set() : new Set(codes))
                        }}
                      >
                        {data.summary.every((s) => expandedRows.has(s.종목코드)) ? "\u25BC" : "\u25B6"}
                      </span>
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium">종목코드</th>
                    <th className="text-left px-4 py-2.5 font-medium">종목명</th>
                    <th className="px-4 py-2.5"></th>
                    <th className="text-right px-4 py-2.5 font-medium">상환수량</th>
                    <th className="text-right px-4 py-2.5 font-medium">상환금액</th>
                    <th className="text-right px-4 py-2.5 font-medium">체결건수</th>
                    <th className="px-4 py-2.5"></th>
                    <th className="text-right px-4 py-2.5 font-medium">최고수수료율</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((s, i) => {
                    const expanded = expandedRows.has(s.종목코드)
                    const details = matchesByStock(s.종목코드)
                    return (
                      <SummaryRow
                        key={s.종목코드}
                        no={i + 1}
                        summary={s}
                        details={details}
                        expanded={expanded}
                        onToggle={() => toggleRow(s.종목코드)}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!data && !loading && (
        <div className="panel flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-t3 text-sm">
              오피스(5264) 파일과 예탁원(대차내역) 파일을 업로드하세요
            </p>
            <p className="text-t4 text-xs mt-1">
              오피스: 펀드코드, 종목번호, 담보가능수량 포함 / 예탁원: 단축코드, 대차수량, 수수료율 포함
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function SummaryRow({
  no,
  summary: s,
  details,
  expanded,
  onToggle,
}: {
  no: number
  summary: StockSummary
  details: RepaymentMatch[]
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className={`border-b border-border hover:bg-bg-hover transition-colors cursor-pointer ${
          expanded ? "bg-bg-hover" : ""
        }`}
        onClick={onToggle}
      >
        <td className="text-center px-2 py-2.5 font-mono text-xs text-t4">{no}</td>
        <td className="px-4 py-2.5 text-t3 text-sm">
          <span className={`inline-block transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>
            {"\u25B6"}
          </span>
        </td>
        <td className="px-4 py-2.5 font-mono text-t2">{s.종목코드}</td>
        <td className="px-4 py-2.5 text-t1">
          {s.종목명}
          {!expanded && (
            <span className="ml-2 text-[11px] font-mono text-t4">
              {s.체결건수}건
            </span>
          )}
        </td>
        <td className="px-4 py-2.5"></td>
        <td className="px-4 py-2.5 text-right font-mono text-up">{fmt(s.상환수량)}</td>
        <td className="px-4 py-2.5 text-right font-mono text-t1">{fmt(s.대차금액)}</td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">{s.체결건수}</td>
        <td className="px-4 py-2.5"></td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">{s.최고수수료율.toFixed(2)}%</td>
      </tr>
      {expanded && (
        <>
          <tr className="bg-bg-surface border-b border-border">
            <td></td>
            <td className="px-4 py-1.5 pl-8"></td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">펀드코드</td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">펀드명</td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">대여자</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">상환수량</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">상환금액</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">체결일</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">체결번호</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">수수료율</td>
          </tr>
          {details.map((m, i) => (
            <tr
              key={`${s.종목코드}-${m.체결번호}-${i}`}
              className="border-b border-border bg-bg-surface"
            >
              <td></td>
              <td className="px-4 py-2 text-t4 text-xs pl-8">{"\u2514"}</td>
              <td className="px-4 py-2 font-mono text-xs text-t4">{m.펀드코드}</td>
              <td className="px-4 py-2 text-xs text-t3">{m.펀드명}</td>
              <td className="px-4 py-2 text-xs text-t3">{m.대여자명}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-up">{fmt(m.상환수량)}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t2">{fmt(m.대차금액)}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t4">{m.체결일}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t4">{m.체결번호}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t2">{m.수수료율.toFixed(2)}%</td>
            </tr>
          ))}
        </>
      )}
    </>
  )
}
