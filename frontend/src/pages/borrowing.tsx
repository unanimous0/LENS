import { useState, useMemo, useCallback } from "react"
import * as XLSX from "xlsx"
import { formatSheet } from "@/lib/excel"

interface DetailItem {
  lender: string
  lender_account: string
  stock_code: string
  stock_name: string
  fee_rate: number
  qty: number
  value: number
  settlement_date: string
  settlement_no: number
}

interface CostItem {
  대여자계좌?: string
  대여자명?: string
  단축코드?: string
  종목명?: string
  total_value: number
  total_qty: number
  count: number
  wa_rate: number
  daily_cost: number
  details?: DetailItem[]
}

interface RolloverItem {
  stock_code: string
  stock_name: string
  maturity_date: string
  maturity_month: string
  lender_account: string
  lender_name: string
  settlement_date: string
  settlement_no: number
  qty: number
  value: number
  fee_rate: number
  rollover_count: number
}

interface BorrowingSummary {
  total_value: number
  total_wa_rate: number
  total_daily_cost: number
  expensive_value: number
  expensive_wa_rate: number
  expensive_daily_cost: number
  total_count: number
  expensive_count: number
  rollover_count: number
}

interface BorrowingData {
  summary: BorrowingSummary
  by_lender: CostItem[]
  by_stock: CostItem[]
  by_expensive: CostItem[]
  rollover_items: RolloverItem[]
  rollover_months: string[]
}

function fmt(n: number) {
  return n.toLocaleString("ko-KR")
}

function fmtRate(n: number) {
  return n.toFixed(4) + "%"
}

function fmtMonth(m: string) {
  if (m === "all") return "전체"
  const [y, mo] = m.split("-")
  return `${y}년 ${parseInt(mo)}월`
}

const TABLE_MAX_H = "max-h-[403px]"

// --- 종목 행 + hover 상세 tooltip (fixed position) ---
function StockRow({ item, no, cols, showSettlement = false, counterpartyLabel = "대여자", dailyLabel = "1D 비용" }: { item: CostItem; no?: number; cols: "stock" | "expensive"; showSettlement?: boolean; counterpartyLabel?: string; dailyLabel?: string }) {
  const details = item.details ?? []
  const [tooltip, setTooltip] = useState<{ x: number; y: number; above: boolean } | null>(null)

  const handleCellMouseEnter = (e: React.MouseEvent<HTMLTableCellElement>) => {
    const cell = e.currentTarget
    const row = cell.closest("tr")
    if (!row) return
    const rect = row.getBoundingClientRect()
    const estimatedH = 36 + details.length * 22
    const scrollParent = row.closest(".overflow-y-auto")
    const boundary = scrollParent ? scrollParent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    const spaceBelow = boundary.bottom - rect.bottom
    const spaceAbove = rect.top - boundary.top
    const above = spaceBelow < estimatedH && spaceAbove > spaceBelow
    setTooltip({
      x: rect.right,
      y: above ? rect.top : rect.bottom,
      above,
    })
  }

  const handleCellMouseLeave = () => setTooltip(null)

  return (
    <tr className="border-b border-border hover:bg-bg-hover transition-colors">
      {cols === "stock" && (
        <td className="text-center px-2 py-2 font-mono text-xs text-t4">{no}</td>
      )}
      <td className={`px-4 py-2 ${cols === "expensive" ? "text-t1" : "font-mono text-t2"}`}>
        {cols === "expensive" ? (
          <>
            {item.종목명}
            <span className="ml-2 font-mono text-[11px] text-t4">{item.단축코드}</span>
          </>
        ) : (
          item.단축코드
        )}
      </td>
      {cols === "stock" && <td className="px-4 py-2 text-t1">{item.종목명}</td>}
      {cols === "stock" && <td className="px-4 py-2 text-right font-mono text-t2">{fmt(item.count)}</td>}
      {cols === "stock" && <td className="px-4 py-2 text-right font-mono text-t2">{fmt(item.total_qty)}</td>}
      <td className="px-4 py-2 text-right font-mono text-t2 cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>{fmt(item.total_value)}</td>
      {cols === "expensive" && <td className="px-4 py-2 text-right font-mono text-t2 cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>{fmt(item.total_qty)}</td>}
      <td className="px-4 py-2 text-right font-mono text-up cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>{fmtRate(item.wa_rate)}</td>
      <td className="px-4 py-2 text-right font-mono text-up cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>
        {fmt(item.daily_cost)}
        {tooltip && details.length > 0 && (
          <div
            className="fixed w-max max-w-md px-3 py-2 rounded bg-bg-surface-3 shadow-lg z-50"
            style={{
              right: window.innerWidth - tooltip.x,
              ...(tooltip.above ? { bottom: window.innerHeight - tooltip.y + 4 } : { top: tooltip.y + 4 }),
            }}
          >
            <table className="text-[11px]">
              <thead>
                <tr className="text-t4">
                  <th className="text-left pr-3 pb-1 font-medium">{counterpartyLabel}</th>
                  <th className="text-right pr-3 pb-1 font-medium">수수료율</th>
                  <th className="text-right pr-3 pb-1 font-medium">수량</th>
                  <th className="text-right pr-3 pb-1 font-medium">대차가액</th>
                  {showSettlement && <th className="text-center pr-3 pb-1 font-medium">체결일</th>}
                  {showSettlement && <th className="text-right pb-1 font-medium">체결번호</th>}
                </tr>
              </thead>
              <tbody>
                {details.map((d, i) => (
                  <tr key={i} className="text-t2">
                    <td className="pr-3 py-0.5">{d.lender}</td>
                    <td className="pr-3 py-0.5 text-right font-mono text-up">{d.fee_rate.toFixed(4)}%</td>
                    <td className="pr-3 py-0.5 text-right font-mono">{fmt(d.qty)}</td>
                    <td className="pr-3 py-0.5 text-right font-mono">{fmt(d.value)}</td>
                    {showSettlement && <td className="pr-3 py-0.5 text-center font-mono">{d.settlement_date}</td>}
                    {showSettlement && <td className="py-0.5 text-right font-mono">{d.settlement_no}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  )
}

// --- 대여자 행 + hover 상세 tooltip ---
function LenderRow({ item, showSettlement = false, dailyLabel = "1D 비용" }: { item: CostItem; showSettlement?: boolean; dailyLabel?: string }) {
  const details = item.details ?? []
  const [tooltip, setTooltip] = useState<{ x: number; y: number; above: boolean } | null>(null)

  const handleCellMouseEnter = (e: React.MouseEvent<HTMLTableCellElement>) => {
    const cell = e.currentTarget
    const row = cell.closest("tr")
    if (!row) return
    const rect = row.getBoundingClientRect()
    const estimatedH = Math.min(320, 36 + details.length * 22)
    const scrollParent = row.closest(".overflow-y-auto")
    const boundary = scrollParent ? scrollParent.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    const spaceBelow = boundary.bottom - rect.bottom
    const spaceAbove = rect.top - boundary.top
    const above = spaceBelow < estimatedH && spaceAbove > spaceBelow
    setTooltip({ x: rect.right, y: above ? rect.top : rect.bottom, above })
  }

  const handleCellMouseLeave = () => setTooltip(null)

  return (
    <tr className="border-b border-border hover:bg-bg-hover transition-colors">
      <td className="px-4 py-2 text-t1">
        {item.대여자명}
        <span className="ml-2 font-mono text-[11px] text-t4">{item.대여자계좌}</span>
      </td>
      <td className="px-4 py-2 text-right font-mono text-t2">{fmt(item.count)}</td>
      <td className="px-4 py-2 text-right font-mono text-t2 cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>{fmt(item.total_value)}</td>
      <td className="px-4 py-2 text-right font-mono text-up cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>{fmtRate(item.wa_rate)}</td>
      <td className="px-4 py-2 text-right font-mono text-up cursor-default" onMouseEnter={handleCellMouseEnter} onMouseLeave={handleCellMouseLeave}>
        {fmt(item.daily_cost)}
        {tooltip && details.length > 0 && (
          <div
            className="fixed w-max max-w-lg max-h-80 overflow-y-auto rounded bg-bg-surface-3 shadow-lg z-50"
            style={{
              scrollbarWidth: "thin",
              scrollbarColor: "#8e8e93 #3a3a3c",
              right: window.innerWidth - tooltip.x,
              ...(tooltip.above ? { bottom: window.innerHeight - tooltip.y + 4 } : { top: tooltip.y + 4 }),
            }}
          >
            <table className="text-[11px]">
              <thead className="sticky top-0 bg-bg-surface-3">
                <tr className="text-t4">
                  <th className="text-left pr-3 pb-1 pl-3 pt-2 font-medium">종목코드</th>
                  <th className="text-left pr-3 pb-1 pt-2 font-medium">종목명</th>
                  <th className="text-right pr-3 pb-1 pt-2 font-medium">수수료율</th>
                  <th className="text-right pr-3 pb-1 pt-2 font-medium">수량</th>
                  <th className="text-right pr-3 pb-1 pt-2 font-medium">대차가액</th>
                  <th className="text-right pr-3 pb-1 pt-2 font-medium">{dailyLabel}</th>
                  {showSettlement && <th className="text-center pr-3 pb-1 pt-2 font-medium">체결일</th>}
                  {showSettlement && <th className="text-right pr-3 pb-1 pt-2 font-medium">체결번호</th>}
                </tr>
              </thead>
              <tbody>
                {details.map((d, i) => (
                  <tr key={i} className="text-t2 whitespace-nowrap">
                    <td className="pr-3 py-0.5 pl-3 font-mono">{d.stock_code}</td>
                    <td className="pr-3 py-0.5">{d.stock_name}</td>
                    <td className="pr-3 py-0.5 text-right font-mono text-up">{d.fee_rate.toFixed(4)}%</td>
                    <td className="pr-3 py-0.5 text-right font-mono">{fmt(d.qty)}</td>
                    <td className="pr-3 py-0.5 text-right font-mono">{fmt(d.value)}</td>
                    <td className="pr-3 py-0.5 text-right font-mono text-up">{fmt(Math.round(d.value * d.fee_rate / 100 / 365))}</td>
                    {showSettlement && <td className="pr-3 py-0.5 text-center font-mono">{d.settlement_date}</td>}
                    {showSettlement && <td className="pr-3 py-0.5 text-right font-mono">{d.settlement_no}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  )
}

type InnerTab = "cost" | "rollover"

// --- 정렬 훅 ---
function useSortable<T>(items: T[], defaultKey: keyof T, defaultAsc = false) {
  const [sortKey, setSortKey] = useState<keyof T>(defaultKey)
  const [sortAsc, setSortAsc] = useState(defaultAsc)

  const toggle = useCallback((key: keyof T) => {
    if (sortKey === key) setSortAsc((p) => !p)
    else { setSortKey(key); setSortAsc(true) }
  }, [sortKey])

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === "number" && typeof bv === "number")
        return sortAsc ? av - bv : bv - av
      const as = String(av ?? "")
      const bs = String(bv ?? "")
      return sortAsc ? as.localeCompare(bs) : bs.localeCompare(as)
    })
  }, [items, sortKey, sortAsc])

  return { sorted, sortKey, sortAsc, toggle }
}

// --- 정렬 헤더 ---
function SortTh<T>({ label, field, sortKey, sortAsc, onSort, align = "right" }: {
  label: string; field: keyof T; sortKey: keyof T; sortAsc: boolean
  onSort: (k: keyof T) => void; align?: "left" | "right" | "center"
}) {
  const active = sortKey === field
  return (
    <th
      className={`text-${align} px-4 py-2 font-medium cursor-pointer select-none hover:text-t1 transition-colors ${active ? "text-t1" : ""}`}
      onClick={() => onSort(field)}
    >
      {label}
      <span className="ml-0.5 text-[10px]">{active ? (sortAsc ? "\u25B2" : "\u25BC") : ""}</span>
    </th>
  )
}

const CONFIGS = {
  borrowing: {
    apiEndpoint: "/api/borrowing/analyze",
    fileLabel: "대차내역",
    counterpartyLabel: "대여자",
    groupLabel: "차입처별",
    actionLabel: "비용",
    dailyLabel: "1D 비용",
    expensiveLabel: "고비용 종목",
    expensiveDailyLabel: "고비용 1D 비용",
    stockActionLabel: "종목별 비용",
    description: "차입처별·종목별 비용 분석 + Rollover 상환 관리",
  },
  lending: {
    apiEndpoint: "/api/lending/analyze",
    fileLabel: "대여내역",
    counterpartyLabel: "차입자",
    groupLabel: "차입처별",
    actionLabel: "수익",
    dailyLabel: "1D 수익",
    expensiveLabel: "5% 이상 종목",
    expensiveDailyLabel: "5% 이상 1D 수익",
    stockActionLabel: "종목별 수익",
    description: "차입처별·종목별 수익 분석 + Rollover 관리",
  },
} as const

export function BorrowingPage({ mode = "borrowing" }: { mode?: "borrowing" | "lending" }) {
  const cfg = CONFIGS[mode]
  const [data, setData] = useState<BorrowingData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [innerTab, setInnerTab] = useState<InnerTab>("cost")
  const [showSettlement, setShowSettlement] = useState(false)
  const [rolloverMonth, setRolloverMonth] = useState<string>("all")

  // 정렬
  const lenderSort = useSortable<CostItem>(data?.by_lender ?? [], "daily_cost")
  const expensiveSort = useSortable<CostItem>(data?.by_expensive ?? [], "daily_cost")
  const stockSort = useSortable<CostItem>(data?.by_stock ?? [], "daily_cost")

  // Rollover — 차입 모드에서만 사용
  const filteredRollover = useMemo(() => {
    if (!data || mode !== "borrowing") return []
    if (rolloverMonth === "all") return data.rollover_items
    return data.rollover_items.filter((item) => item.maturity_month === rolloverMonth)
  }, [data, rolloverMonth, mode])

  const rolloverSort = useSortable<RolloverItem>(filteredRollover, "maturity_date", true)
  const filteredValue = useMemo(() => filteredRollover.reduce((s, r) => s + r.value, 0), [filteredRollover])
  const totalRolloverValue = useMemo(() => data?.rollover_items.reduce((s, r) => s + r.value, 0) ?? 0, [data])
  const [monthDropdownOpen, setMonthDropdownOpen] = useState(false)

  const handleUpload = async () => {
    if (!selectedFile) {
      setError("파일을 먼저 선택하세요")
      return
    }
    setLoading(true)
    setError(null)
    setData(null)

    const form = new FormData()
    form.append("file", selectedFile)

    try {
      const res = await fetch(cfg.apiEndpoint, {
        method: "POST",
        body: form,
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `서버 오류 (${res.status})`)
      }
      const json: BorrowingData = await res.json()
      setData(json)

      if (mode === "borrowing") {
        const now = new Date()
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
        if (json.rollover_months.includes(currentMonth)) {
          setRolloverMonth(currentMonth)
        } else if (json.rollover_months.length > 0) {
          setRolloverMonth(json.rollover_months[0])
        } else {
          setRolloverMonth("all")
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "업로드 실패")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-1 bg-bg-base">
      {/* Controls */}
      <div className="panel">
        <div className="px-4 py-3 flex items-center gap-4">
          <span className="text-xs text-t3 whitespace-nowrap">{cfg.fileLabel}</span>
          <input
            type="file"
            className="h-[30px] text-xs text-t3 file:mr-3 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:active:scale-95 file:transition-all"
            onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
          />
          <button
            className="h-[30px] rounded bg-accent px-3 text-xs text-black font-semibold hover:bg-accent-hover active:scale-95 active:brightness-90 transition-all"
            onClick={handleUpload}
          >
            분석 실행
          </button>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={showSettlement} onChange={(e) => setShowSettlement(e.target.checked)} className="accent-accent" />
            <span className="text-xs text-t3 whitespace-nowrap">체결일/체결번호 포함</span>
          </label>
          {loading && <span className="text-xs text-accent font-mono">처리 중...</span>}
          {error && <span className="text-xs text-down font-mono">{error}</span>}
          {data && mode === "borrowing" && (
            <div className="ml-auto flex rounded bg-bg-surface-2 p-0.5">
              <button
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  innerTab === "cost" ? "bg-accent text-black" : "text-t3 hover:text-t2"
                }`}
                onClick={() => setInnerTab("cost")}
              >
                비용 분석
              </button>
              <button
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  innerTab === "rollover" ? "bg-accent text-black" : "text-t3 hover:text-t2"
                }`}
                onClick={() => setInnerTab("rollover")}
              >
                Rollover 3 확인
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ===== 비용 분석 ===== */}
      {data && innerTab === "cost" && (
        <>
          <div className="panel px-4 py-2">
            <div className="grid grid-cols-5 gap-2">
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">총 건수</p>
                <p className="font-mono text-lg font-semibold text-t1">{fmt(data.summary.total_count)}</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">총 대차가액</p>
                <p className="font-mono text-lg font-semibold text-t1">{fmt(data.summary.total_value)}원</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">가중평균 수수료</p>
                <p className="font-mono text-lg font-semibold text-up">{fmtRate(data.summary.total_wa_rate)}</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">{cfg.dailyLabel}</p>
                <p className="font-mono text-lg font-semibold text-up">{fmt(data.summary.total_daily_cost)}원</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">{cfg.expensiveDailyLabel}</p>
                <p className="font-mono text-lg font-semibold text-up">{fmt(data.summary.expensive_daily_cost)}원</p>
              </div>
            </div>
          </div>

          {/* 차입처별 + 고비용 */}
          <div className="flex gap-1">
            <div className="flex-1 panel flex flex-col">
              <div className="px-4 py-2 border-b border-border-light flex items-center justify-between">
                <span className="text-sm font-semibold text-t1">{cfg.groupLabel} {cfg.actionLabel}</span>
                <span className="text-[11px] text-t4">{data.by_lender.length}개</span>
              </div>
              <div className={`overflow-y-auto ${TABLE_MAX_H}`}>
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-bg-surface z-10">
                    <tr className="text-xs text-t3 border-b border-border-light">
                      <SortTh<CostItem> label={cfg.counterpartyLabel} field="대여자명" align="left" sortKey={lenderSort.sortKey} sortAsc={lenderSort.sortAsc} onSort={lenderSort.toggle} />
                      <SortTh<CostItem> label="건수" field="count" sortKey={lenderSort.sortKey} sortAsc={lenderSort.sortAsc} onSort={lenderSort.toggle} />
                      <SortTh<CostItem> label="총 대차가액" field="total_value" sortKey={lenderSort.sortKey} sortAsc={lenderSort.sortAsc} onSort={lenderSort.toggle} />
                      <SortTh<CostItem> label="가중평균 수수료" field="wa_rate" sortKey={lenderSort.sortKey} sortAsc={lenderSort.sortAsc} onSort={lenderSort.toggle} />
                      <SortTh<CostItem> label={cfg.dailyLabel} field="daily_cost" sortKey={lenderSort.sortKey} sortAsc={lenderSort.sortAsc} onSort={lenderSort.toggle} />
                    </tr>
                  </thead>
                  <tbody>
                    {lenderSort.sorted.map((item) => (
                      <LenderRow key={item.대여자계좌} item={item} showSettlement={showSettlement} dailyLabel={cfg.dailyLabel} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex-1 panel flex flex-col">
              <div className="px-4 py-2 border-b border-border-light flex items-center justify-between">
                <span className="text-sm font-semibold text-t1">{cfg.expensiveLabel}</span>
                <span className="text-[11px] text-t4">수수료율 &gt; 0.05% · {data.by_expensive.length}개</span>
              </div>
              {data.by_expensive.length > 0 ? (
                <div className={`overflow-y-auto ${TABLE_MAX_H}`}>
                  <table className="w-full text-[13px]">
                    <thead className="sticky top-0 bg-bg-surface z-10">
                      <tr className="text-xs text-t3 border-b border-border-light">
                        <SortTh<CostItem> label="종목" field="종목명" align="left" sortKey={expensiveSort.sortKey} sortAsc={expensiveSort.sortAsc} onSort={expensiveSort.toggle} />
                        <SortTh<CostItem> label="총 대차가액" field="total_value" sortKey={expensiveSort.sortKey} sortAsc={expensiveSort.sortAsc} onSort={expensiveSort.toggle} />
                        <SortTh<CostItem> label={mode === "borrowing" ? "차입수량" : "대여수량"} field="total_qty" sortKey={expensiveSort.sortKey} sortAsc={expensiveSort.sortAsc} onSort={expensiveSort.toggle} />
                        <SortTh<CostItem> label="가중평균 수수료" field="wa_rate" sortKey={expensiveSort.sortKey} sortAsc={expensiveSort.sortAsc} onSort={expensiveSort.toggle} />
                        <SortTh<CostItem> label={cfg.dailyLabel} field="daily_cost" sortKey={expensiveSort.sortKey} sortAsc={expensiveSort.sortAsc} onSort={expensiveSort.toggle} />
                      </tr>
                    </thead>
                    <tbody>
                      {expensiveSort.sorted.map((item) => (
                        <StockRow key={item.단축코드} item={item} cols="expensive" showSettlement={showSettlement} counterpartyLabel={cfg.counterpartyLabel} dailyLabel={cfg.dailyLabel} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-4 py-6 text-center text-sm text-t3">해당 없음</div>
              )}
            </div>
          </div>

          {/* 종목별 */}
          <div className="panel flex flex-col">
            <div className="px-4 py-2 border-b border-border-light flex items-center justify-between">
              <span className="text-sm font-semibold text-t1">{cfg.stockActionLabel}</span>
              <span className="text-[11px] text-t4">{data.by_stock.length}개 종목</span>
            </div>
            <div className={`overflow-y-auto ${TABLE_MAX_H}`}>
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface z-10">
                  <tr className="text-xs text-t3 border-b border-border-light">
                    <th className="text-center px-2 py-2 font-medium text-t4 w-10">No</th>
                    <SortTh<CostItem> label="종목코드" field="단축코드" align="left" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                    <SortTh<CostItem> label="종목명" field="종목명" align="left" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                    <SortTh<CostItem> label="건수" field="count" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                    <SortTh<CostItem> label="총 수량" field="total_qty" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                    <SortTh<CostItem> label="총 대차가액" field="total_value" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                    <SortTh<CostItem> label="가중평균 수수료" field="wa_rate" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                    <SortTh<CostItem> label={cfg.dailyLabel} field="daily_cost" sortKey={stockSort.sortKey} sortAsc={stockSort.sortAsc} onSort={stockSort.toggle} />
                  </tr>
                </thead>
                <tbody>
                  {stockSort.sorted.map((item, i) => (
                    <StockRow key={item.단축코드} item={item} no={i + 1} cols="stock" showSettlement={showSettlement} counterpartyLabel={cfg.counterpartyLabel} dailyLabel={cfg.dailyLabel} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ===== Rollover (차입 모드 전용) ===== */}
      {data && mode === "borrowing" && innerTab === "rollover" && (
        <>
          <div className="panel px-4 py-2">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-t1">Rollover 상환 관리</span>
              <span className="text-[11px] text-t4">횟수 3 이상 · 만기일까지 필수 상환</span>
              <button
                className="ml-auto rounded bg-bg-surface-2 px-3 py-1.5 text-xs text-t2 font-medium hover:bg-bg-surface-3 active:scale-95 transition-all"
                onClick={() => {
                  const sorted = [...filteredRollover].sort((a, b) => a.maturity_date.localeCompare(b.maturity_date))
                  const rows = sorted.map((r) => ({
                    종목코드: r.stock_code,
                    종목명: r.stock_name,
                    대차수량: r.qty,
                    [`${cfg.counterpartyLabel}코드`]: r.lender_account,
                    [`${cfg.counterpartyLabel}명`]: r.lender_name,
                    체결일: r.settlement_date,
                    체결번호: r.settlement_no,
                    상환만기일: r.maturity_date,
                  }))
                  const ws = XLSX.utils.json_to_sheet(rows)
                  formatSheet(ws)
                  const wb = XLSX.utils.book_new()
                  XLSX.utils.book_append_sheet(wb, ws, "Rollover")
                  const label = rolloverMonth === "all" ? "전체" : rolloverMonth
                  XLSX.writeFile(wb, `Rollover_상환대상_${label}.xlsx`)
                }}
              >
                엑셀 저장
              </button>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <button
                    className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-bg-surface-2 text-t1 font-medium font-mono transition-colors hover:bg-bg-surface-3"
                    onClick={() => setMonthDropdownOpen((p) => !p)}
                  >
                    {fmtMonth(rolloverMonth)}
                    <span className="text-[10px] text-t4">{monthDropdownOpen ? "\u25B2" : "\u25BC"}</span>
                  </button>
                  {monthDropdownOpen && (
                    <div className="absolute top-full right-0 mt-1 w-max min-w-28 max-h-48 overflow-y-auto bg-bg-surface rounded border border-border-light z-20">
                      <button
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-bg-hover ${rolloverMonth === "all" ? "text-accent font-medium" : "text-t2"}`}
                        onClick={() => { setRolloverMonth("all"); setMonthDropdownOpen(false) }}
                      >
                        전체
                      </button>
                      {data.rollover_months.map((month) => (
                        <button
                          key={month}
                          className={`w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-bg-hover ${rolloverMonth === month ? "text-accent font-medium" : "text-t2"}`}
                          onClick={() => { setRolloverMonth(month); setMonthDropdownOpen(false) }}
                        >
                          {fmtMonth(month)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 mt-2">
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">{fmtMonth(rolloverMonth)} 상환 대상</p>
                <p className="font-mono text-lg font-semibold text-down">{filteredRollover.length}건</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">{fmtMonth(rolloverMonth)} 대차가액</p>
                <p className="font-mono text-lg font-semibold text-t1">{fmt(filteredValue)}원</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">전체 상환 대상</p>
                <p className="font-mono text-lg font-semibold text-t2">{data.rollover_items.length}건</p>
              </div>
              <div className="panel-inner rounded px-3 py-2">
                <p className="text-[11px] text-t3">전체 대차가액</p>
                <p className="font-mono text-lg font-semibold text-t2">{fmt(totalRolloverValue)}원</p>
              </div>
            </div>
          </div>

          <div className="panel">
            {rolloverSort.sorted.length > 0 ? (
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface z-10">
                  <tr className="text-xs text-t3 border-b border-border-light">
                    <th className="text-center px-2 py-2 font-medium text-t4 w-10">No</th>
                    <SortTh<RolloverItem> label="종목코드" field="stock_code" align="left" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="종목명" field="stock_name" align="left" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="상환만기일" field="maturity_date" align="center" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label={cfg.counterpartyLabel} field="lender_name" align="left" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="체결일" field="settlement_date" align="center" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="체결번호" field="settlement_no" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="대차수량" field="qty" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="대차가액" field="value" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                    <SortTh<RolloverItem> label="수수료율" field="fee_rate" sortKey={rolloverSort.sortKey} sortAsc={rolloverSort.sortAsc} onSort={rolloverSort.toggle} />
                  </tr>
                </thead>
                <tbody>
                  {rolloverSort.sorted.map((item, i) => {
                    const maturity = new Date(item.maturity_date)
                    const now = new Date()
                    const daysLeft = Math.ceil((maturity.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
                    return (
                      <tr key={`${item.stock_code}-${item.settlement_no}`} className="border-b border-border hover:bg-bg-hover transition-colors">
                        <td className="text-center px-2 py-2 font-mono text-xs text-t4">{i + 1}</td>
                        <td className="px-4 py-2 font-mono text-t2">{item.stock_code}</td>
                        <td className="px-4 py-2 text-t1">{item.stock_name}</td>
                        <td className="px-4 py-2 text-center font-mono">
                          <span className={daysLeft <= 7 ? "text-down" : daysLeft <= 30 ? "text-warning" : "text-t1"}>
                            {item.maturity_date}
                          </span>
                          <span className="ml-1.5 text-[11px] text-t4">
                            {daysLeft > 0 ? `D-${daysLeft}` : daysLeft === 0 ? "D-Day" : `D+${Math.abs(daysLeft)}`}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-t2">
                          {item.lender_name}
                          <span className="ml-1.5 font-mono text-[11px] text-t4">{item.lender_account}</span>
                        </td>
                        <td className="px-4 py-2 text-center font-mono text-t2">{item.settlement_date}</td>
                        <td className="px-4 py-2 text-right font-mono text-t2">{item.settlement_no}</td>
                        <td className="px-4 py-2 text-right font-mono text-t2">{fmt(item.qty)}</td>
                        <td className="px-4 py-2 text-right font-mono text-t2">{fmt(item.value)}</td>
                        <td className="px-4 py-2 text-right font-mono text-up">{item.fee_rate.toFixed(4)}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <div className="px-4 py-6 text-center text-sm text-t3">해당 월에 상환 대상이 없습니다</div>
            )}
          </div>
        </>
      )}

      {!data && !loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <p className="text-t3 text-sm">{cfg.fileLabel} 파일(.xls, .xlsx)을 업로드하세요</p>
            <p className="text-t4 text-xs mt-1">{cfg.description}</p>
          </div>
        </div>
      )}
    </div>
  )
}
