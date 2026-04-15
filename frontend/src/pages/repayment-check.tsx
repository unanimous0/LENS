import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import * as XLSX from "xlsx"
import { formatSheet } from "@/lib/excel"

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
  qty_052: number
  qty_031: number
  repay_deductions: Record<string, Record<string, number>>
  original_collateral: Record<string, number>
  original_by_fund: Record<string, Record<string, number>>
  locked_collateral: Record<string, number>
  locked_by_fund: Record<string, Record<string, number>>
  fund_names: Record<string, string>
}

function fmt(n: number) {
  return n.toLocaleString("ko-KR")
}

function SortTh<T>({ label, field, sortKey, sortAsc, onSort, align = "right" }: {
  label: string; field: keyof T; sortKey: keyof T; sortAsc: boolean
  onSort: (k: keyof T) => void; align?: "left" | "right" | "center"
}) {
  const active = sortKey === field
  return (
    <th
      className={`text-${align} px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors ${active ? "text-t1" : ""}`}
      onClick={() => onSort(field)}
    >
      {label}
      <span className="ml-0.5 text-[10px]">{active ? (sortAsc ? "\u25B2" : "\u25BC") : ""}</span>
    </th>
  )
}

export function RepaymentCheckPage() {
  const [data, setData] = useState<RepaymentResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [officeFile, setOfficeFile] = useState<File | null>(null)
  const [esafeFile, setEsafeFile] = useState<File | null>(null)
  const [repayFile, setRepayFile] = useState<File | null>(null)
  const [mmFundsFile, setMmFundsFile] = useState<File | null>(null)
  const [restrictedFile, setRestrictedFile] = useState<File | null>(null)
  const [folderPath, setFolderPath] = useState(() => localStorage.getItem("lens_repayment_path") ?? "")
  const [showPathInput, setShowPathInput] = useState(true)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  type SortKey = keyof StockSummary | "담보가능수량" | "상환예정" | "담보가능_상환" | "담보"
  const [sortKey, setSortKey] = useState<SortKey>("대차금액")
  const [sortAsc, setSortAsc] = useState(false)
  const [filterOpen, setFilterOpen] = useState(true)

  const loadRestrictedCodes = useCallback(async (path?: string, file?: File | null) => {
    const form = new FormData()
    if (path) form.append("folder_path", path)
    if (file) form.append("file", file)
    try {
      const res = await fetch("/api/lending/restricted-codes", { method: "POST", body: form })
      if (res.ok) {
        const json = await res.json()
        if (json.codes?.length > 0) setExcludeFundCodes(json.codes)
      }
    } catch { /* ignore */ }
  }, [])

  // 초기 로드: 폴더 경로가 있으면 대여불가펀드 코드 자동 로드
  useEffect(() => {
    if (folderPath) loadRestrictedCodes(folderPath)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
  const [excludeFeeRates, setExcludeFeeRates] = useState<string[]>(["0.05"])
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
    if (!officeFile && !esafeFile && !folderPath) {
      setError("파일을 선택하거나 폴더 경로를 지정하세요")
      return
    }

    setLoading(true)
    setError(null)
    setData(null)
    setExpandedRows(new Set())

    const form = new FormData()
    if (officeFile) form.append("office_file", officeFile)
    if (esafeFile) form.append("esafe_file", esafeFile)
    if (repayFile) form.append("repay_file", repayFile)
    if (mmFundsFile) form.append("mm_funds_file", mmFundsFile)
    if (restrictedFile) form.append("restricted_file", restrictedFile)
    if (folderPath) form.append("folder_path", folderPath)
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

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortAsc((p) => !p)
    else { setSortKey(key); setSortAsc(true) }
  }, [sortKey])

  const getExtraValue = useCallback((s: StockSummary, key: SortKey): number => {
    if (!data) return 0
    const code = s.종목코드
    const orig = data.original_collateral?.[code] ?? 0
    const deducted = Object.values(data.repay_deductions?.[code] ?? {}).reduce((a, b) => a + b, 0)
    const after = orig - deducted
    const locked = data.locked_collateral?.[code] ?? 0
    switch (key) {
      case "담보가능수량": return orig
      case "상환예정": return deducted
      case "담보가능_상환": return after
      case "담보": return locked
      default: return 0
    }
  }, [data])

  const sortedSummary = useMemo(() => {
    if (!data) return []
    const extraKeys: SortKey[] = ["담보가능수량", "상환예정", "담보가능_상환", "담보"]
    return [...data.summary].sort((a, b) => {
      if (extraKeys.includes(sortKey)) {
        const av = getExtraValue(a, sortKey)
        const bv = getExtraValue(b, sortKey)
        return sortAsc ? av - bv : bv - av
      }
      const av = a[sortKey as keyof StockSummary]
      const bv = b[sortKey as keyof StockSummary]
      if (typeof av === "number" && typeof bv === "number")
        return sortAsc ? av - bv : bv - av
      const as = String(av ?? "")
      const bs = String(bv ?? "")
      return sortAsc ? as.localeCompare(bs) : bs.localeCompare(as)
    })
  }, [data, sortKey, sortAsc])

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
    const ws1 = XLSX.utils.json_to_sheet(matchRows); formatSheet(ws1)
    XLSX.utils.book_append_sheet(wb, ws1, "상환 내역")
    const ws2 = XLSX.utils.json_to_sheet(summaryRows); formatSheet(ws2)
    XLSX.utils.book_append_sheet(wb, ws2, "종목별 합산")
    if (data.remaining_office.length > 0) {
      const ws3 = XLSX.utils.json_to_sheet(data.remaining_office); formatSheet(ws3)
      XLSX.utils.book_append_sheet(wb, ws3, "상환 후 오피스")
    }
    if (data.remaining_esafe.length > 0) {
      const ws4 = XLSX.utils.json_to_sheet(data.remaining_esafe); formatSheet(ws4)
      XLSX.utils.book_append_sheet(wb, ws4, "상환 후 예탁원")
    }
    if (data.no_esafe_stocks.length > 0) {
      const ws5 = XLSX.utils.json_to_sheet(data.no_esafe_stocks); formatSheet(ws5)
      XLSX.utils.book_append_sheet(wb, ws5, "내부차입 추정")
    }

    XLSX.writeFile(wb, "상환가능확인_결과.xlsx")
  }

  return (
    <div className="flex flex-col gap-1 bg-bg-base">
      {/* Controls Panel */}
      <div className="panel">
        <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
          {/* 모드 토글 */}
          <div className="flex h-[30px]">
            <button
              className={`h-full px-2.5 rounded-l text-xs font-medium transition-all ${showPathInput ? "bg-bg-surface-2 text-t1" : "bg-bg-base text-t4 hover:text-t3"}`}
              onClick={() => setShowPathInput(true)}
            >
              폴더 경로
            </button>
            <button
              className={`h-full px-2.5 rounded-r text-xs font-medium transition-all ${!showPathInput ? "bg-bg-surface-2 text-t1" : "bg-bg-base text-t4 hover:text-t3"}`}
              onClick={() => { setShowPathInput(false); setFolderPath(""); localStorage.removeItem("lens_repayment_path"); }}
            >
              파일 선택
            </button>
          </div>

          {/* 폴더 경로 모드 */}
          {showPathInput && (
            <input
              className="h-[30px] w-80 bg-bg-input rounded px-3 text-xs font-mono text-t1 outline-none focus:ring-1 focus:ring-accent"
              placeholder="예: C:\Users\SE21297\Desktop\상환가능확인 파일모음"
              value={folderPath}
              onChange={(e) => {
                setFolderPath(e.target.value)
                localStorage.setItem("lens_repayment_path", e.target.value)
              }}
              onBlur={() => { if (folderPath) loadRestrictedCodes(folderPath) }}
            />
          )}

          <button
            className="h-[30px] rounded bg-accent px-3 text-xs text-black font-semibold hover:bg-accent-hover active:scale-95 active:brightness-90 transition-all"
            onClick={handleCalculate}
          >
            계산 실행
          </button>
          {loading && <span className="text-xs text-accent font-mono">처리 중...</span>}
          {error && <span className="text-xs text-down font-mono">{error}</span>}
          {data && (
            <button
              className="ml-auto h-[30px] rounded bg-bg-surface-2 px-3 text-xs text-t2 font-medium hover:bg-bg-surface-3 active:scale-95 transition-all"
              onClick={exportToExcel}
            >
              엑셀 저장
            </button>
          )}
        </div>
        {!showPathInput && (
          <div className="px-4 pb-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">오피스(5264)</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setOfficeFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">예탁원(대차내역)</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setEsafeFile(f)
                  if (f) fetchLenders(f)
                }} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">상환예정내역</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setRepayFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">MM펀드</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setMmFundsFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">대여불가펀드</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null
                  setRestrictedFile(f)
                  if (f) loadRestrictedCodes(undefined, f)
                }} />
            </div>
          </div>
        )}
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
                    className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-32 outline-none focus:ring-1 focus:ring-accent"
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
                <p className="text-[11px] text-t3">상환 금액</p>
                <p className="font-mono text-lg font-semibold text-up">{fmt(data.total_amount)}원</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">상환 수량</p>
                <p className="font-mono text-lg font-semibold text-up">{fmt(data.total_qty)}주</p>
              </div>
            </div>
          </div>

          {/* Remaining Esafe Summary */}
          {data.remaining_esafe.length > 0 && (
            <div className="panel px-4 py-2">
              <div className="grid grid-cols-4 gap-2">
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
                <div className="panel-inner rounded px-3 py-2 flex">
                  <div className="flex-1">
                    <p className="text-[11px] text-t3">052 상환 수량</p>
                    <p className="font-mono text-lg font-semibold text-up">{fmt(data.qty_052)}주</p>
                  </div>
                  <div className="w-px bg-border-light mx-2"></div>
                  <div className="flex-1">
                    <p className="text-[11px] text-t3">031 상환 수량</p>
                    <p className="font-mono text-lg font-semibold text-up">{fmt(data.qty_031)}주</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Results Table — 종목별 합산 (아코디언) */}
          <div className="panel">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface z-10">
                  <tr className="text-[13px] text-t2 border-b border-border-light">
                    <th className="text-center px-2 py-2.5 font-medium text-t3 w-10">No</th>
                    <th className="text-left px-4 py-2.5 font-medium w-8">
                      <span
                        className="cursor-pointer text-accent hover:text-accent-hover transition-colors select-none"
                        onClick={() => {
                          const codes = sortedSummary.map((s) => s.종목코드)
                          const allExpanded = codes.every((c) => expandedRows.has(c))
                          setExpandedRows(allExpanded ? new Set() : new Set(codes))
                        }}
                      >
                        {sortedSummary.every((s) => expandedRows.has(s.종목코드)) ? "\u25BC" : "\u25B6"}
                      </span>
                    </th>
                    <SortTh<StockSummary> label="종목코드" field="종목코드" align="left" sortKey={sortKey as keyof StockSummary} sortAsc={sortAsc} onSort={handleSort as (k: keyof StockSummary) => void} />
                    <SortTh<StockSummary> label="종목명" field="종목명" align="left" sortKey={sortKey as keyof StockSummary} sortAsc={sortAsc} onSort={handleSort as (k: keyof StockSummary) => void} />
                    <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors" onClick={() => handleSort("담보가능수량")}>
                      담보가능수량<span className="ml-0.5 text-[10px]">{sortKey === "담보가능수량" ? (sortAsc ? "▲" : "▼") : ""}</span>
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors" onClick={() => handleSort("상환예정")}>
                      상환예정<span className="ml-0.5 text-[10px]">{sortKey === "상환예정" ? (sortAsc ? "▲" : "▼") : ""}</span>
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors" onClick={() => handleSort("담보가능_상환")}>
                      담보가능-상환예정<span className="ml-0.5 text-[10px]">{sortKey === "담보가능_상환" ? (sortAsc ? "▲" : "▼") : ""}</span>
                    </th>
                    <SortTh<StockSummary> label="상환수량" field="상환수량" sortKey={sortKey as keyof StockSummary} sortAsc={sortAsc} onSort={handleSort as (k: keyof StockSummary) => void} />
                    <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors" onClick={() => handleSort("담보")}>
                      담보<span className="ml-0.5 text-[10px]">{sortKey === "담보" ? (sortAsc ? "▲" : "▼") : ""}</span>
                    </th>
                    <SortTh<StockSummary> label="상환금액" field="대차금액" sortKey={sortKey as keyof StockSummary} sortAsc={sortAsc} onSort={handleSort as (k: keyof StockSummary) => void} />
                    <SortTh<StockSummary> label="체결건수" field="체결건수" sortKey={sortKey as keyof StockSummary} sortAsc={sortAsc} onSort={handleSort as (k: keyof StockSummary) => void} />
                    <SortTh<StockSummary> label="최고수수료율" field="최고수수료율" sortKey={sortKey as keyof StockSummary} sortAsc={sortAsc} onSort={handleSort as (k: keyof StockSummary) => void} />
                  </tr>
                </thead>
                <tbody>
                  {sortedSummary.map((s, i) => {
                    const expanded = expandedRows.has(s.종목코드)
                    const details = matchesByStock(s.종목코드)
                    const remainingEsafe = (data.remaining_esafe as Record<string, unknown>[])
                      .filter((r) => r["단축코드"] === s.종목코드)
                      .reduce((sum, r) => sum + ((r["대차수량"] as number) ?? 0), 0)
                    return (
                      <SummaryRow
                        key={s.종목코드}
                        no={i + 1}
                        summary={s}
                        details={details}
                        expanded={expanded}
                        onToggle={() => toggleRow(s.종목코드)}
                        deductions={data.repay_deductions?.[s.종목코드] ?? {}}
                        originalCollateral={data.original_collateral?.[s.종목코드] ?? 0}
                        originalByFund={data.original_by_fund?.[s.종목코드] ?? {}}
                        lockedCollateral={data.locked_collateral?.[s.종목코드] ?? 0}
                        lockedByFund={data.locked_by_fund?.[s.종목코드] ?? {}}
                        fundNames={data.fund_names ?? {}}
                        remainingEsafe={remainingEsafe}
                      />
                    )
                  })}
                </tbody>
              </table>
          </div>
        </>
      )}

      {!data && !loading && (
        <div className="flex items-center justify-center py-20">
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
  deductions,
  originalCollateral,
  originalByFund,
  lockedCollateral,
  lockedByFund,
  fundNames,
  remainingEsafe,
}: {
  no: number
  summary: StockSummary
  details: RepaymentMatch[]
  expanded: boolean
  onToggle: () => void
  deductions: Record<string, number>
  originalCollateral: number
  originalByFund: Record<string, number>
  lockedCollateral: number
  lockedByFund: Record<string, number>
  fundNames: Record<string, string>
  remainingEsafe: number
}) {
  const totalDeducted = Object.values(deductions).reduce((a, b) => a + b, 0)
  const afterDeduction = originalCollateral - totalDeducted
  const needsUnlock = s.상환수량 >= afterDeduction && lockedCollateral > 0
  const unlockNeeded = Math.min(remainingEsafe, lockedCollateral)
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
          {needsUnlock && (
            <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning">
              담보해지 필요 ({fmt(unlockNeeded)}주)
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">
          {fmt(originalCollateral)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono">
          {totalDeducted > 0 && <span className="text-down">-{fmt(totalDeducted)}</span>}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">
          {fmt(afterDeduction)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-up">{fmt(s.상환수량)}</td>
        <td className={`px-4 py-2.5 text-right font-mono ${lockedCollateral > 0 ? "text-warning" : "text-t2"}`}>
          {fmt(lockedCollateral)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t1">{fmt(s.대차금액)}</td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">{s.체결건수}</td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">{s.최고수수료율.toFixed(2)}%</td>
      </tr>
      {expanded && (
        <>
          <tr className="bg-bg-surface border-b border-border">
            <td></td>
            <td className="px-4 py-1.5 pl-8"></td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">펀드코드</td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">펀드명 / 대여자</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">담보가능수량</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">상환예정</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">담보가능-상환예정</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">상환수량</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">담보</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">상환금액</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">체결일/번호</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">수수료율</td>
          </tr>
          {(() => {
            // 매칭에 등장하는 펀드코드 set
            const matchedFunds = new Set(details.map((m) => m.펀드코드))
            // 차감은 있지만 매칭에 없는 펀드 (전량 소진)
            const consumedFunds = Object.entries(deductions)
              .filter(([fund, qty]) => qty > 0 && !matchedFunds.has(fund))
              .map(([fund, qty]) => ({ fund, deduct: qty, orig: originalByFund[fund] ?? 0, locked: lockedByFund[fund] ?? 0 }))

            return (
              <>
                {details.map((m, i) => {
                  const fundOrig = originalByFund[m.펀드코드] ?? 0
                  const fundDeduct = deductions[m.펀드코드] ?? 0
                  const fundAfter = fundOrig - fundDeduct
                  const isFirstOfFund = i === 0 || details[i - 1].펀드코드 !== m.펀드코드
                  return (
                  <tr
                    key={`${s.종목코드}-${m.체결번호}-${i}`}
                    className="border-b border-border bg-bg-surface"
                  >
                    <td></td>
                    <td className="px-4 py-2 text-t4 text-xs pl-8">{"\u2514"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-t4">{m.펀드코드}</td>
                    <td className="px-4 py-2 text-xs text-t3">
                      {m.펀드명}
                      <span className="ml-1.5 text-t4">{m.대여자명}</span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t2">
                      {isFirstOfFund ? fmt(fundOrig) : <span className="text-t4 text-sm font-bold">↑</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {isFirstOfFund ? fundDeduct > 0 && <span className="text-down">-{fmt(fundDeduct)}</span> : fundDeduct > 0 && <span className="text-t4 text-sm font-bold">↑</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t2">
                      {isFirstOfFund ? fmt(fundAfter) : <span className="text-t4 text-sm font-bold">↑</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-up">{fmt(m.상환수량)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {isFirstOfFund ? (lockedByFund[m.펀드코드] ?? 0) > 0 && (
                        <span className="text-warning">{fmt(lockedByFund[m.펀드코드])}</span>
                      ) : (lockedByFund[m.펀드코드] ?? 0) > 0 && <span className="text-t4 text-sm font-bold">↑</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t2">{fmt(m.대차금액)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t4">{m.체결일} / {m.체결번호}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t2">{m.수수료율.toFixed(2)}%</td>
                  </tr>
                  )
                })}
                {consumedFunds.map((cf) => (
                  <tr key={`${s.종목코드}-consumed-${cf.fund}`} className="border-b border-border bg-bg-surface opacity-60">
                    <td></td>
                    <td className="px-4 py-2 text-t4 text-xs pl-8">{"\u2514"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-t4">{cf.fund}</td>
                    <td className="px-4 py-2 text-xs text-t4">상환예정 전량 차감 ({fundNames[cf.fund] ?? cf.fund})</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t2">{fmt(cf.orig)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs"><span className="text-down">-{fmt(cf.deduct)}</span></td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t2">{fmt(cf.orig - cf.deduct)}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t4">—</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      {cf.locked > 0 && <span className="text-warning">{fmt(cf.locked)}</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t4">—</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t4">—</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-t4">—</td>
                  </tr>
                ))}
              </>
            )
          })()}
        </>
      )}
    </>
  )
}
