import { useState, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import { formatSheet } from "@/lib/excel";

interface FundBreakdown {
  fund_code: string;
  fund_name: string;
  account_code: string;
  settlement_balance: number;
  collateral_free: number;
  collateral_locked: number;
  lending: number;
  repayment_deducted: number;
}

interface StockResult {
  stock_code: string;
  stock_name: string;
  requested_qty: number;
  rate: number;
  total_free: number;
  total_locked: number;
  total_combined: number;
  repay_scheduled: number;
  prev_close: number;
  meets_request: boolean;
  funds: FundBreakdown[];
}

interface LendingResponse {
  results: StockResult[];
  total_inquiry: number;
  total_met: number;
  total_unmet: number;
}

function fmt(n: number) {
  return n.toLocaleString("ko-KR");
}

function cleanName(name: string) {
  return name.replace(/^[*#\s]+/, "");
}

const DEFAULT_RESTRICTED: string[] = [];

export function LendingAvailabilityPage() {
  const [data, setData] = useState<LendingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inquiryFile, setInquiryFile] = useState<File | null>(null);
  const [holdingsFile, setHoldingsFile] = useState<File | null>(null);
  const [restrictedFile, setRestrictedFile] = useState<File | null>(null);
  const [mmFundsFile, setMmFundsFile] = useState<File | null>(null);
  const [repayFile, setRepayFile] = useState<File | null>(null);
  const [folderPath, setFolderPath] = useState(() => localStorage.getItem("lens_lending_path") ?? "");
  const [showPathInput, setShowPathInput] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<keyof StockResult>("total_combined");
  const [sortAsc, setSortAsc] = useState(false);
  const [filterOpen, setFilterOpen] = useState(true);
  const [restrictedSuffixes, setRestrictedSuffixes] = useState<string[]>(DEFAULT_RESTRICTED);
  const [suffixInput, setSuffixInput] = useState("");

  const loadRestrictedCodes = useCallback(async (path?: string, file?: File | null) => {
    const form = new FormData();
    if (path) form.append("folder_path", path);
    if (file) form.append("file", file);
    try {
      const res = await fetch("/api/lending/restricted-codes", { method: "POST", body: form });
      if (res.ok) {
        const json = await res.json();
        if (json.codes?.length > 0) setRestrictedSuffixes(json.codes);
      }
    } catch { /* ignore */ }
  }, []);

  // 초기 로드: 폴더 경로가 있으면 대여불가펀드 코드 자동 로드
  useEffect(() => {
    if (folderPath) loadRestrictedCodes(folderPath);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addSuffix = () => {
    const raw = suffixInput.trim();
    if (!raw) { setSuffixInput(""); return; }
    const code = raw.length <= 3 ? raw.padStart(3, "0") : raw.padStart(6, "0");
    if ((code.length === 3 || code.length === 6) && !restrictedSuffixes.includes(code)) {
      setRestrictedSuffixes([...restrictedSuffixes, code].sort());
    }
    setSuffixInput("");
  };

  const handleCalculate = async () => {
    if (!inquiryFile && !holdingsFile && !folderPath) {
      setError("파일을 선택하거나 폴더 경로를 지정하세요");
      return;
    }
    setLoading(true);
    setError(null);
    setData(null);
    setExpandedRows(new Set());

    const form = new FormData();
    if (inquiryFile) form.append("inquiry_file", inquiryFile);
    if (holdingsFile) form.append("holdings_file", holdingsFile);
    if (restrictedFile) form.append("restricted_file", restrictedFile);
    if (mmFundsFile) form.append("mm_funds_file", mmFundsFile);
    if (repayFile) form.append("repayments_file", repayFile);
    if (folderPath) {
      form.append("folder_path", folderPath);
    }
    if (restrictedSuffixes.length > 0) {
      form.append("restricted_suffixes", restrictedSuffixes.join(","));
    }

    try {
      const res = await fetch(`/api/lending/calculate`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `서버 오류 (${res.status})`);
      }
      const json: LendingResponse = await res.json();
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "업로드 실패");
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (key: keyof StockResult) => {
    if (sortKey === key) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sortedResults = data
    ? [...data.results].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        if (typeof av === "number" && typeof bv === "number") {
          return sortAsc ? av - bv : bv - av;
        }
        const as = String(av);
        const bs = String(bv);
        return sortAsc ? as.localeCompare(bs) : bs.localeCompare(as);
      })
    : [];

  const exportToExcel = () => {
    if (!data) return;
    const rows: Record<string, string | number>[] = [];
    for (const r of sortedResults) {
      const activeFunds = r.funds.filter((f) => f.collateral_free + f.collateral_locked > 0);
      for (const f of activeFunds) {
        rows.push({
          펀드코드: f.fund_code,
          펀드명: f.fund_name,
          종목코드: r.stock_code,
          종목명: cleanName(r.stock_name),
          담보가능수량: f.collateral_free,
          담보: f.collateral_locked,
          합산: f.collateral_free + f.collateral_locked,
          문의수량: r.requested_qty,
          요율: r.rate,
          상태: r.total_combined === 0 ? "수량 없음" : r.total_combined > r.requested_qty ? "초과 수량" : "수량 있음",
          대여: f.lending,
        });
      }
    }
    // 시트1: 종목별 합산
    const summaryRows = sortedResults.map((r) => ({
      종목코드: r.stock_code,
      종목명: cleanName(r.stock_name),
      합산수량: r.total_combined,
      합계: r.total_combined,
      요율: r.rate,
    }));
    const ws1 = XLSX.utils.json_to_sheet(summaryRows);
    formatSheet(ws1);

    // 시트2: 대여가능산출 (펀드별 상세)
    const ws2 = XLSX.utils.json_to_sheet(rows);
    formatSheet(ws2);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "종목별합산");
    XLSX.utils.book_append_sheet(wb, ws2, "대여가능산출");
    XLSX.writeFile(wb, "대여가능산출_결과.xlsx");
  };

  const toggleRow = (code: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-1 bg-bg-base">
      {/* Controls Panel */}
      <div className="panel">
        <div className="px-4 py-3 flex items-center gap-3">
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
              onClick={() => { setShowPathInput(false); setFolderPath(""); localStorage.removeItem("lens_lending_path"); }}
            >
              파일 선택
            </button>
          </div>

          {/* 폴더 경로 모드 */}
          {showPathInput && (
            <input
              className="h-[30px] w-80 bg-bg-input rounded px-3 text-xs font-mono text-t1 outline-none focus:ring-1 focus:ring-accent"
              placeholder="예: C:\Users\SE21297\Desktop\대여가능확인 파일모음"
              value={folderPath}
              onChange={(e) => {
                setFolderPath(e.target.value);
                localStorage.setItem("lens_lending_path", e.target.value);
              }}
              onBlur={() => { if (folderPath) loadRestrictedCodes(folderPath); }}
            />
          )}

          <button
            className="h-[30px] rounded bg-green px-3 text-xs text-black font-semibold hover:bg-green-light active:scale-95 active:brightness-90 transition-all"
            onClick={handleCalculate}
          >
            계산 실행
          </button>
          {loading && <span className="text-xs text-green font-mono">처리 중...</span>}
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
              <span className="text-xs text-t3 whitespace-nowrap">대여문의종목</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setInquiryFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">5264</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setHoldingsFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">대여불가펀드</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setRestrictedFile(f);
                  if (f) loadRestrictedCodes(undefined, f);
                }} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">MM펀드</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setMmFundsFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-t3 whitespace-nowrap">상환예정내역</span>
              <input type="file" className="h-[30px] text-xs text-t3 file:mr-2 file:h-[30px] file:rounded file:border-0 file:bg-bg-surface-2 file:px-3 file:text-xs file:text-t2 file:cursor-pointer hover:file:bg-bg-surface-3 file:transition-all"
                onChange={(e) => setRepayFile(e.target.files?.[0] ?? null)} />
            </div>
          </div>
        )}
        <button
          className="w-full px-4 py-2 flex items-center gap-2 text-xs text-t3 hover:text-t2 transition-colors"
          onClick={() => setFilterOpen(!filterOpen)}
        >
          <span className={`transition-transform duration-150 ${filterOpen ? "rotate-90" : ""}`}>{"\u25B6"}</span>
          <span className="font-medium">필터</span>
          {restrictedSuffixes.length > 0 && (
            <span className="text-accent">적용 중</span>
          )}
        </button>
        {filterOpen && (
          <div className="px-4 pb-3 flex flex-col gap-1.5">
            <span className="text-[11px] text-t4 font-medium">대여불가펀드</span>
            <div className="flex items-center gap-2">
              <input
                className="bg-bg-input rounded px-2 py-1 text-xs font-mono text-t1 w-32 outline-none focus:ring-1 focus:ring-accent"
                placeholder="3자리 또는 6자리"
                value={suffixInput}
                onChange={(e) => setSuffixInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addSuffix()}
                maxLength={6}
              />
              <button className="text-xs text-accent hover:text-accent-hover px-1" onClick={addSuffix}>+</button>
            </div>
            {restrictedSuffixes.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {restrictedSuffixes.map((s) => (
                  <button
                    key={s}
                    className="bg-bg-surface-2 hover:bg-bg-surface-3 rounded px-1.5 py-0.5 text-xs font-mono text-t2 transition-colors cursor-pointer"
                    onClick={() => setRestrictedSuffixes(restrictedSuffixes.filter((x) => x !== s))}
                  >
                    {s} ×
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {data && (
        <>
          {/* Summary Cards */}
          <div className="panel p-4">
            <div className="grid grid-cols-4 gap-3">
              <div className="panel-inner rounded p-4">
                <div className="flex h-full">
                  <div className="flex-1 flex flex-col justify-between border-r border-border pr-3">
                    <p className="text-xs text-t3 mb-1">문의 종목</p>
                    <p className="font-mono text-2xl font-semibold text-t1">
                      {data.total_inquiry}
                    </p>
                  </div>
                  <div className="flex-1 flex flex-col justify-between border-r border-border px-3">
                    <p className="text-xs text-t3 mb-1">대여가능</p>
                    <p className="font-mono text-2xl font-semibold text-up">
                      {data.results.filter((r) => r.total_combined > 0).length}
                    </p>
                  </div>
                  <div className="flex-1 flex flex-col justify-between pl-3">
                    <p className="text-xs text-t3 mb-1">대여불가</p>
                    <p className="font-mono text-2xl font-semibold text-down">
                      {data.results.filter((r) => r.total_combined === 0).length}
                    </p>
                  </div>
                </div>
              </div>
              <div className="panel-inner rounded p-4">
                <p className="text-xs text-t3 mb-1">총 대여가능 수량</p>
                <p className="font-mono text-2xl font-semibold text-t1">
                  {fmt(data.results.reduce((s, r) => s + r.total_combined, 0))}
                </p>
              </div>
              <div className="panel-inner rounded p-4">
                <p className="text-xs text-t3 mb-1">총 대여가능 금액</p>
                <p className="font-mono text-2xl font-semibold text-t1">
                  {fmt(data.results.reduce((s, r) => s + r.total_combined * r.prev_close, 0))}
                </p>
              </div>
              <div className="panel-inner rounded p-4">
                <div className="flex h-full">
                  <div className="flex-1 flex flex-col justify-between border-r border-border pr-3">
                    <p className="text-xs text-t3 mb-1">1Y 기대수익</p>
                    <p className="font-mono text-lg font-semibold text-up">
                      {fmt(Math.round(data.results.reduce((s, r) => s + r.total_combined * r.prev_close * r.rate / 100, 0)))}
                    </p>
                  </div>
                  <div className="flex-1 flex flex-col justify-between pl-3">
                    <p className="text-xs text-t3 mb-1">1D 기대수익</p>
                    <p className="font-mono text-lg font-semibold text-up">
                      {fmt(Math.round(data.results.reduce((s, r) => s + r.total_combined * r.prev_close * r.rate / 100 / 365, 0)))}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Results Table */}
          <div className="panel">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface z-10">
                  <tr className="text-[13px] text-t2 border-b border-border-light">
                    <th className="text-center px-2 py-2.5 font-medium text-t3 w-10">No</th>
                    <th className="text-left px-4 py-2.5 font-medium w-8">
                      <span
                        className="cursor-pointer text-accent hover:text-accent-hover transition-colors select-none"
                        onClick={() => {
                          const allCodes = sortedResults.filter((r) => r.funds.length > 0).map((r) => r.stock_code);
                          const allExpanded = allCodes.every((c) => expandedRows.has(c));
                          setExpandedRows(allExpanded ? new Set() : new Set(allCodes));
                        }}
                      >
                        {sortedResults.filter((r) => r.funds.length > 0).every((r) => expandedRows.has(r.stock_code)) && sortedResults.some((r) => r.funds.length > 0) ? "\u25BC" : "\u25B6"}
                      </span>
                    </th>
                    <SortTh align="left" sortKey="stock_code" label="종목코드" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <SortTh align="left" sortKey="stock_name" label="종목명" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <SortTh align="right" sortKey="requested_qty" label="문의수량" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <SortTh align="right" sortKey="rate" label="요율" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <SortTh align="right" sortKey="total_free" label="담보가능수량" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <SortTh align="right" sortKey="repay_scheduled" label="상환예정" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <th className="text-right px-4 py-2.5 font-medium">담보가능-상환예정</th>
                    <SortTh align="right" sortKey="total_locked" label="담보" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <SortTh align="right" sortKey="total_combined" label="대여가능수량" current={sortKey} asc={sortAsc} onSort={handleSort} />
                    <th className="text-right px-4 py-2.5 font-medium">1D 기대수익</th>
                    <th className="text-center px-4 py-2.5 font-medium">상태</th>
                    <th className="text-right px-4 py-2.5 font-medium">대여</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map((r, i) => (
                    <ResultRow
                      key={r.stock_code}
                      no={i + 1}
                      result={r}
                      expanded={expandedRows.has(r.stock_code)}
                      onToggle={() => toggleRow(r.stock_code)}
                    />
                  ))}
                </tbody>
              </table>
          </div>
        </>
      )}

      {!data && !loading && (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <p className="text-t3 text-sm">
              대여확인 엑셀 파일(.xlsx)을 업로드하세요
            </p>
            <p className="text-t4 text-xs mt-1">
              문의종목, 원장RAW, MM펀드, 상환예정내역 시트 포함
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function SortTh({
  align,
  sortKey,
  label,
  current,
  asc,
  onSort,
}: {
  align: "left" | "right";
  sortKey: keyof StockResult;
  label: string;
  current: keyof StockResult;
  asc: boolean;
  onSort: (key: keyof StockResult) => void;
}) {
  const active = current === sortKey;
  return (
    <th
      className={`text-${align} px-4 py-2.5 font-medium cursor-pointer select-none hover:text-t1 transition-colors ${
        active ? "text-t1" : ""
      }`}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span className="ml-1 text-[10px]">
        {active ? (asc ? "\u25B2" : "\u25BC") : ""}
      </span>
    </th>
  );
}

function ResultRow({
  no,
  result: r,
  expanded,
  onToggle,
}: {
  no: number;
  result: StockResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`border-b border-border hover:bg-bg-hover transition-colors ${
          r.funds.length > 0 ? "cursor-pointer" : ""
        } ${expanded ? "bg-bg-hover" : ""}`}
        onClick={() => r.funds.length > 0 && onToggle()}
      >
        <td className="text-center px-2 py-2.5 font-mono text-xs text-t4">{no}</td>
        <td className="px-4 py-2.5 text-t3 text-sm">
          {r.funds.length > 0 && (
            <span className={`inline-block transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>
              {"\u25B6"}
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 font-mono text-t2">{r.stock_code}</td>
        <td className="px-4 py-2.5 text-t1">
          {cleanName(r.stock_name)}
          {r.funds.length > 0 && !expanded && (
            <span className="ml-2 text-[11px] font-mono text-t4">
              {r.funds.length}개 펀드
            </span>
          )}
          {r.total_free < r.requested_qty && r.total_locked > 0 && (
            <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning">
              담보해지 필요 ({fmt(r.total_locked)}주)
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">
          {fmt(r.requested_qty)}
        </td>
        <td className={`px-4 py-2.5 text-right font-mono ${r.rate >= 5 ? "text-up" : "text-t2"}`}>
          {r.rate.toFixed(2)}%
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">
          {fmt(r.total_free + (r.repay_scheduled ?? 0))}
        </td>
        <td className="px-4 py-2.5 text-right font-mono">
          {(r.repay_scheduled ?? 0) > 0 && <span className="text-down">-{fmt(r.repay_scheduled)}</span>}
        </td>
        <td className={`px-4 py-2.5 text-right font-mono ${r.total_free > 0 ? "text-up" : "text-t2"}`}>
          {fmt(r.total_free)}
        </td>
        <td className={`px-4 py-2.5 text-right font-mono ${r.total_locked > 0 ? "text-warning" : "text-t2"}`}>
          {fmt(r.total_locked)}
        </td>
        <td
          className={`px-4 py-2.5 text-right font-mono font-semibold ${
            r.total_combined > 0 ? "text-up" : "text-t1"
          }`}
        >
          {fmt(r.total_combined)}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">
          {r.total_combined > 0 ? fmt(Math.round(r.total_combined * r.prev_close * r.rate / 100 / 365)) : ""}
        </td>
        <td className="px-4 py-2.5 text-center">
          {r.total_combined === 0 ? (
            <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-sm bg-down-bg text-down">
              수량 없음
            </span>
          ) : r.total_combined > r.requested_qty ? (
            <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-sm bg-warning/12 text-warning">
              초과 수량
            </span>
          ) : (
            <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded-sm bg-up-bg text-up">
              수량 있음
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 text-right font-mono text-t2">
          {fmt(r.funds.reduce((s, f) => s + f.lending, 0))}
        </td>
      </tr>
      {expanded && (
        <>
          <tr className="bg-bg-surface border-b border-border">
            <td></td>
            <td className="px-4 py-1.5 pl-8"></td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">펀드코드</td>
            <td className="px-4 py-1.5 text-xs text-t3 font-medium">펀드명 (계정)</td>
            <td></td>
            <td></td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">담보가능수량</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">상환차감</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">담보가능-상환예정</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">담보</td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">합산</td>
            <td></td>
            <td></td>
            <td className="px-4 py-1.5 text-right text-xs text-t3 font-medium">대여</td>
          </tr>
          {r.funds
            .filter((f) => f.collateral_free + f.collateral_locked > 0 || f.repayment_deducted > 0 || f.lending > 0)
            .map((f, i) => (
            <tr
              key={`${r.stock_code}-${f.fund_code}-${i}`}
              className="border-b border-border bg-bg-surface"
            >
              <td></td>
              <td className="px-4 py-2 text-t4 text-xs pl-8">{"\u2514"}</td>
              <td className="px-4 py-2 font-mono text-xs text-t4">
                {f.fund_code}
              </td>
              <td className="px-4 py-2 text-xs text-t3">
                {f.fund_name}
                <span className="ml-2 font-mono text-t4">({f.account_code})</span>
              </td>
              <td></td>
              <td></td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t3">
                {fmt(f.collateral_free + f.repayment_deducted)}
              </td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t4">
                {f.repayment_deducted > 0 && (
                  <span className="text-down">-{fmt(f.repayment_deducted)}</span>
                )}
              </td>
              <td className={`px-4 py-2 text-right font-mono text-xs ${f.collateral_free > 0 ? "text-up" : "text-t1"}`}>
                {fmt(f.collateral_free)}
              </td>
              <td className={`px-4 py-2 text-right font-mono text-xs ${f.collateral_locked > 0 ? "text-up" : "text-t1"}`}>
                {fmt(f.collateral_locked)}
              </td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t2">
                {fmt(f.collateral_free + f.collateral_locked)}
              </td>
              <td></td>
              <td></td>
              <td className="px-4 py-2 text-right font-mono text-xs text-t3">
                {fmt(f.lending)}
              </td>
            </tr>
          ))}
        </>
      )}
    </>
  );
}
