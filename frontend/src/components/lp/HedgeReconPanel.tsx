import { useCallback, useEffect, useRef, useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import type { HedgeReconClass, HedgeReconResponse, HedgeReconStock } from '@/types/lp'
import { cn } from '@/lib/utils'

/**
 * 헤지 정합 보드 (§13.12) — 무기억 진단.
 *
 * "현재 원장이 PDF 기준으로 알맞게 헤지돼 있는지, 어디가 어떻게 어긋났는지, 델타가 얼마나
 * 떠 있는지"를 원장 스냅샷 하나로 진단. LedgerBoard 바로 위에 배치 (원장의 진단이므로).
 *
 * "정합 진단" 버튼 + 원장 변경(ledgerUpdatedAt) 시 자동 재계산 (디바운스). POST
 * /api/lp/hedge-recon. 분류: 정합(현물)·대체 헤지(주식선물)·매크로(지수선물 설명)·미설명(진짜
 * 리스크). 미설명 gap을 0으로 만드는 리밸런싱 주문표 + 클립보드 복사. 지수선물 잔여는 헤지
 * 티켓 참조 (역할 분리 — 중복 제안 금지).
 */

/** 부호 있는 원화 축약 (− 기호). */
function fmtKrw(krw: number): string {
  const abs = Math.abs(krw)
  const sign = krw > 0 ? '+' : krw < 0 ? '−' : ''
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}만`
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`
}
function fmtSize(krw: number): string {
  const abs = Math.abs(krw)
  if (abs >= 1e8) return `${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(0)}만`
  return Math.round(abs).toLocaleString('ko-KR')
}
const fmtQty = (n: number) => n.toLocaleString('ko-KR')
const famLabel = (f: string) => (f === 'k200' ? 'K200' : f === 'kq150' ? 'KQ150' : f.toUpperCase())

const CLASS_META: Record<HedgeReconClass, { label: string; cls: string; title: string }> = {
  aligned_spot: { label: '정합', cls: 'bg-accent/15 text-accent', title: '현물만으로 PDF 헤지 정합' },
  alt_hedge: { label: '대체', cls: 'bg-blue/15 text-blue', title: '주식선물 합쳐 정합 (대체 헤지)' },
  macro: { label: '매크로', cls: 'bg-bg-surface text-t3', title: '종목 gap은 있으나 지수선물 오버레이로 설명됨' },
  macro_offset: {
    label: '매크로(상쇄)',
    cls: 'bg-warning/15 text-warning',
    title: '주문 0 (net 커버)이지만 gap 델타가 커서 종목 스프레드 리스크 잔존 — 잔차위험(#3)으로 관리',
  },
  unexplained: { label: '미설명', cls: 'bg-down/15 text-down', title: '헤지되지 않은 방향 노출 — 종목 리밸런싱 대상' },
}

export function HedgeReconPanel() {
  const recon = useLpStore((s) => s.hedgeRecon)
  const setRecon = useLpStore((s) => s.setHedgeRecon)
  const requestRoute = useLpStore((s) => s.requestBasisRoutePrefill)
  const ledgerUpdatedAt = useLpStore((s) => s.ledgerUpdatedAt)

  const [tolPct, setTolPct] = useState('0.5') // % 단위 입력 (0.5 = 0.5%)
  const [tolAbs, setTolAbs] = useState('1')
  const [offsetWarnMan, setOffsetWarnMan] = useState('5000') // 상쇄 경고 임계 (만원 단위 입력)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showAligned, setShowAligned] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const run = useCallback(async () => {
    setBusy(true)
    setErr('')
    try {
      const body = {
        tol_abs_shares: Math.max(0, parseFloat(tolAbs) || 0),
        tol_pct: Math.max(0, (parseFloat(tolPct) || 0) / 100),
        offset_warn_krw: Math.max(0, (parseFloat(offsetWarnMan) || 0) * 10_000),
      }
      const r = await fetch('/api/lp/hedge-recon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) {
        setErr(`진단 실패 (${r.status})`)
        return
      }
      setRecon((await r.json()) as HedgeReconResponse)
    } catch {
      setErr('네트워크 오류')
    } finally {
      setBusy(false)
    }
  }, [tolAbs, tolPct, offsetWarnMan, setRecon])

  // 원장 변경 → 자동 재계산 (디바운스). 최초 로드(ledgerUpdatedAt null→값)도 트리거.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void run()
    }, 700)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // ledgerUpdatedAt·파라미터 변화 시 재진단. run은 파라미터 의존이라 함께 안정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerUpdatedAt, tolAbs, tolPct, offsetWarnMan])

  const copyOrders = async () => {
    if (!recon || recon.rebalance_orders.length === 0) return
    const header = ['코드', '이름', '방향', '주수', '예상대금', 'ADV%', '주식선물'].join('\t')
    const lines = recon.rebalance_orders.map((o) =>
      [
        o.code,
        o.name ?? '',
        o.side === 'buy' ? '매수' : '매도',
        o.shares,
        o.est_notional != null ? Math.round(o.est_notional) : '',
        o.adv_ratio != null ? o.adv_ratio.toFixed(2) : '',
        o.has_stock_future ? 'Y' : '',
      ].join('\t'),
    )
    try {
      await navigator.clipboard.writeText([header, ...lines].join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setErr('클립보드 복사 실패')
    }
  }

  const toggle = (code: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })

  const s = recon?.summary
  const famEntries = recon ? Object.entries(recon.summary.unexplained_delta_by_family) : []
  const visibleStocks = recon
    ? recon.stocks.filter((r) => showAligned || r.classification !== 'aligned_spot')
    : []

  return (
    <div className="flex flex-col gap-1">
      {/* ── 헤더 + 요약 스트립 ── */}
      <div className="bg-bg-primary p-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-[13px] text-t2 font-medium">헤지 정합 보드</div>
              {s &&
                (s.fully_aligned ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-sm bg-accent/15 text-accent font-medium">
                    ✓ 헤지 정합
                  </span>
                ) : s.n_unexplained > 0 ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-sm bg-down/15 text-down font-medium">
                    미설명 {s.n_unexplained}종목
                  </span>
                ) : (
                  // 종목은 0건인데 가족 델타(선물 과다·미설명 잔여)만 뜬 케이스 — 문구 구분.
                  <span className="text-[10px] px-2 py-0.5 rounded-sm bg-warning/15 text-warning font-medium">
                    가족 델타 미설명 {fmtSize(s.unexplained_delta_total + s.futures_excess_total)}
                  </span>
                ))}
            </div>
            <div className="text-[10px] text-t4 mt-0.5">
              원장이 PDF 기준으로 헤지됐는지 · 어디가 어긋났는지 · 델타가 얼마나 떠 있는지 (무기억 진단)
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-[10px] text-t4 flex items-center gap-1">
              tol
              <input
                value={tolAbs}
                onChange={(e) => setTolAbs(e.target.value)}
                className="w-10 bg-bg-base px-1 py-0.5 text-[10px] tabular-nums text-right text-t2 outline-none focus:border-accent border border-transparent"
                title="정합 tolerance 절대 하한 (주)"
              />
              주 /
              <input
                value={tolPct}
                onChange={(e) => setTolPct(e.target.value)}
                className="w-10 bg-bg-base px-1 py-0.5 text-[10px] tabular-nums text-right text-t2 outline-none focus:border-accent border border-transparent"
                title="정합 tolerance = max(주, |요구|×%)"
              />
              %
            </label>
            <label className="text-[10px] text-t4 flex items-center gap-1">
              상쇄
              <input
                value={offsetWarnMan}
                onChange={(e) => setOffsetWarnMan(e.target.value)}
                className="w-12 bg-bg-base px-1 py-0.5 text-[10px] tabular-nums text-right text-t2 outline-none focus:border-accent border border-transparent"
                title="상쇄 경고 임계 (만원) — 주문 0인데 |gap δ| 초과 시 매크로(상쇄) 표시"
              />
              만
            </label>
            {recon && recon.rebalance_orders.length > 0 && (
              <button
                onClick={copyOrders}
                className="text-[11px] px-3 py-1 bg-bg-surface text-t2 hover:text-t1"
              >
                {copied ? '복사됨 ✓' : '주문표 복사'}
              </button>
            )}
            <button
              onClick={() => void run()}
              disabled={busy}
              className="text-[11px] px-4 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
            >
              {busy ? '진단 중...' : '정합 진단'}
            </button>
          </div>
        </div>

        {err && <div className="text-[11px] text-down mt-2">{err}</div>}

        {s && (
          <>
            <div className="mt-2.5 flex flex-wrap items-stretch gap-x-6 gap-y-2 font-mono tabular-nums">
              <Stat label="정합 (현물)" value={`${s.n_aligned_spot}`} valueClass="text-accent" />
              <Stat label="대체 헤지" value={`${s.n_alt_hedge}`} valueClass="text-blue" />
              <Stat label="매크로" value={`${s.n_macro}`} valueClass="text-t3" />
              {s.n_macro_offset > 0 && (
                <Stat label="매크로(상쇄)" value={`${s.n_macro_offset}`} valueClass="text-warning" />
              )}
              <Stat
                label="미설명"
                value={`${s.n_unexplained}`}
                valueClass={s.n_unexplained > 0 ? 'text-down' : 'text-t3'}
              />
              <div className="w-px bg-bg-base self-stretch" />
              {famEntries.length === 0 ? (
                <Stat label="미설명 델타" value="0" valueClass="text-accent" />
              ) : (
                famEntries.map(([fam, v]) => (
                  <Stat
                    key={fam}
                    label={`미설명 δ ${famLabel(fam)}`}
                    value={fmtKrw(v)}
                    valueClass={Math.abs(v) < 1 ? 'text-t3' : v > 0 ? 'text-up' : 'text-down'}
                  />
                ))
              )}
              {Object.entries(s.futures_excess_by_family).map(([fam, v]) => (
                <Stat
                  key={`fx-${fam}`}
                  label={`선물 과다 ${famLabel(fam)}`}
                  value={fmtKrw(v)}
                  valueClass="text-warning"
                />
              ))}
              <div className="w-px bg-bg-base self-stretch" />
              <Stat
                label="리밸런싱 주문"
                value={`${s.n_rebalance_orders}건`}
                valueClass={s.n_rebalance_orders > 0 ? 'text-t1' : 'text-t3'}
              />
              <Stat label="주문 명목" value={fmtSize(s.rebalance_gross_notional)} valueClass="text-t2" />
              {s.n_adv_capped > 0 && (
                <Stat label="ADV 캡 초과" value={`${s.n_adv_capped}종`} valueClass="text-down" />
              )}
            </div>
            {/* M2 — 이중 실행 방어 상시 문구 */}
            <div className="mt-2 text-[10px] text-warning/90">
              ⚠ 리밸런싱 주문 실행·기장 후 헤지 티켓이 자동 재계산됨 — 티켓과 동시 실행 금지 (같은 델타의
              회계 분해이지 주문 중복 제거가 아님).
            </div>
          </>
        )}
      </div>

      {!recon ? (
        <div className="bg-bg-primary px-3 py-6 text-[11px] text-t4">
          "정합 진단"을 눌러 현재 원장의 PDF 헤지 정합을 계산합니다 (원장 변경 시 자동 재계산).
        </div>
      ) : (
        <>
          {/* ── 종목 테이블 ── */}
          <div className="bg-bg-primary p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[12px] text-t2 font-medium">
                종목 정합 <span className="text-t4 text-[10px]">(미설명 우선 · 행 클릭 시 ETF 롤업)</span>
              </div>
              <label className="text-[10px] text-t4 flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showAligned}
                  onChange={(e) => setShowAligned(e.target.checked)}
                />
                정합 종목도 표시
              </label>
            </div>
            <div className="max-h-[480px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-t4 text-[10px] sticky top-0 bg-bg-primary">
                  <tr>
                    <th className="text-left py-1 font-normal">종목</th>
                    <th className="text-right py-1 font-normal">요구</th>
                    <th className="text-right py-1 font-normal">실제</th>
                    <th className="text-right py-1 font-normal text-t4/70">현물</th>
                    <th className="text-right py-1 font-normal text-t4/70">선물</th>
                    <th className="text-right py-1 font-normal">gap</th>
                    <th className="text-right py-1 font-normal">gap δ</th>
                    <th className="text-center py-1 font-normal">분류</th>
                    <th className="text-right py-1 font-normal">리밸런싱</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {visibleStocks.length === 0 && (
                    <tr>
                      <td colSpan={9} className="text-center text-t4 py-3 text-xs">
                        {recon.stocks.length === 0
                          ? '요구/실제 헤지 종목 없음 (보유 ETF 없음)'
                          : '전부 정합 — "정합 종목도 표시" 체크로 확인'}
                      </td>
                    </tr>
                  )}
                  {visibleStocks.map((r) => (
                    <StockRow
                      key={r.code}
                      row={r}
                      rollup={recon.etf_rollup[r.code] ?? []}
                      expanded={expanded.has(r.code)}
                      onToggle={() => toggle(r.code)}
                      onRoute={() => requestRoute({ code: r.code, side: r.order_side ?? 'sell', qty: r.order_shares })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── 지수선물경로 ETF ── */}
          {recon.index_route_etfs.length > 0 && (
            <div className="bg-bg-primary p-3">
              <div className="text-[12px] text-t2 font-medium mb-1">
                지수선물 헤지 경로 ETF{' '}
                <span className="text-t4 text-[10px]">
                  (선물지수추종·레버리지 — PDF 환산 불가, 요구 델타만 지수선물로 헤지)
                </span>
              </div>
              <table className="w-full text-[11px]">
                <thead className="text-t4 text-[10px]">
                  <tr>
                    <th className="text-left py-1 font-normal">ETF</th>
                    <th className="text-right py-1 font-normal">순 수량</th>
                    <th className="text-center py-1 font-normal">가족</th>
                    <th className="text-center py-1 font-normal">배수</th>
                    <th className="text-right py-1 font-normal">요구 델타</th>
                    <th className="text-left py-1 font-normal pl-3">사유</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {recon.index_route_etfs.map((e) => (
                    <tr key={e.code} className="border-t border-bg-base/40">
                      <td className="py-1 text-t2">
                        <span className="text-t1">{e.code}</span>
                        {e.name && <span className="text-t4 ml-1 text-[10px]">{e.name}</span>}
                      </td>
                      <td className="py-1 text-right text-t2">{fmtQty(e.net_qty)}</td>
                      <td className="py-1 text-center text-t3">{famLabel(e.family)}</td>
                      <td className="py-1 text-center text-t3">{e.leverage != null ? `×${e.leverage}` : 'β'}</td>
                      <td
                        className="py-1 text-right"
                        style={{
                          color:
                            e.required_delta_krw == null
                              ? 'var(--color-t4)'
                              : e.required_delta_krw > 0
                                ? 'var(--color-up)'
                                : 'var(--color-down)',
                        }}
                      >
                        {e.required_delta_krw != null ? fmtKrw(e.required_delta_krw) : '-'}
                      </td>
                      <td className="py-1 text-left text-t4 text-[10px] pl-3">{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 가족별 델타 대조 (매크로 설명) ── */}
          <div className="bg-bg-primary p-3">
            <div className="text-[12px] text-t2 font-medium mb-1">
              가족별 매크로 델타 대조{' '}
              <span className="text-t4 text-[10px]">(미정합 gap + 지수선물경로 ETF vs 지수선물 오버레이)</span>
            </div>
            <table className="w-full text-[11px]">
              <thead className="text-t4 text-[10px]">
                <tr>
                  <th className="text-left py-1 font-normal">가족</th>
                  <th className="text-right py-1 font-normal">요구 δ (net)</th>
                  <th className="text-right py-1 font-normal">gross Σ|δ|</th>
                  <th className="text-right py-1 font-normal">지수선물 오버레이</th>
                  <th className="text-right py-1 font-normal">커버리지</th>
                  <th className="text-right py-1 font-normal">미설명 δ (종목)</th>
                  <th className="text-right py-1 font-normal">선물 초과 (→티켓)</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {Object.values(recon.families)
                  .filter(
                    (f) =>
                      Math.abs(f.needed_delta_krw) > 1 ||
                      Math.abs(f.index_fut_delta_krw) > 1 ||
                      f.gross_delta_krw > 1,
                  )
                  .map((f) => (
                    <tr key={f.family} className="border-t border-bg-base/40">
                      <td className="py-1 text-t1">
                        {famLabel(f.family)}
                        {f.offset_warning && (
                          <span
                            className="ml-1.5 px-1 py-0.5 text-[9px] rounded-sm bg-warning/15 text-warning align-middle"
                            title="gross가 net의 3배 초과 — 종목 간 상쇄 큼. 델타는 중립이나 잔차 위험 잔존 (#3 참조)"
                          >
                            상쇄 큼
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-right text-t2">{fmtKrw(f.needed_delta_krw)}</td>
                      <td className="py-1 text-right text-t3">{fmtSize(f.gross_delta_krw)}</td>
                      <td className="py-1 text-right text-t3">{fmtKrw(f.index_fut_delta_krw)}</td>
                      <td className="py-1 text-right text-t3">{(f.coverage_ratio * 100).toFixed(0)}%</td>
                      <td
                        className="py-1 text-right font-medium"
                        style={{
                          color:
                            Math.abs(f.unexplained_delta_krw) < 1
                              ? 'var(--color-accent)'
                              : f.unexplained_delta_krw > 0
                                ? 'var(--color-up)'
                                : 'var(--color-down)',
                        }}
                      >
                        {fmtKrw(f.unexplained_delta_krw)}
                      </td>
                      <td
                        className="py-1 text-right"
                        style={{
                          color:
                            Math.abs(f.futures_excess_krw) < 1
                              ? 'var(--color-t4)'
                              : 'var(--color-warning)',
                        }}
                        title={
                          Math.abs(f.futures_excess_krw) >= 1
                            ? '선물 과다/동방향 잔여 — 헤지 티켓에서 청산 제안 확인 (종목 주문으로 대응 금지)'
                            : ''
                        }
                      >
                        {Math.abs(f.futures_excess_krw) < 1 ? '-' : fmtKrw(f.futures_excess_krw)}
                      </td>
                    </tr>
                  ))}
                {Object.values(recon.families).every(
                  (f) =>
                    Math.abs(f.needed_delta_krw) <= 1 &&
                    Math.abs(f.index_fut_delta_krw) <= 1 &&
                    f.gross_delta_krw <= 1,
                ) && (
                  <tr>
                    <td colSpan={7} className="text-center text-t4 py-2 text-[10px]">
                      매크로 델타 없음 (전부 종목 레벨 정합 또는 미설명 델타 0)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="text-[10px] text-t4 mt-1.5">
              미설명 δ(종목)는 리밸런싱 주문으로, 선물 초과분은 <span className="text-t3">헤지 티켓</span>에서
              지수선물로 마감 — 같은 델타의 회계 분해이므로 두 패널 동시 실행 금지.
            </div>
          </div>

          {/* ── caveats ── */}
          {recon.caveats.length > 0 && (
            <div className="bg-bg-primary px-3 py-2">
              <div className="text-[10px] text-t4 leading-relaxed">
                {recon.caveats.map((c, i) => (
                  <div key={i}>· {c}</div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass = 'text-t1',
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex flex-col justify-between min-w-[64px]">
      <div className="text-[10px] text-t3">{label}</div>
      <div className={cn('text-[14px] font-mono tabular-nums mt-0.5', valueClass)}>{value}</div>
    </div>
  )
}

function StockRow({
  row,
  rollup,
  expanded,
  onToggle,
  onRoute,
}: {
  row: HedgeReconStock
  rollup: import('@/types/lp').HedgeReconEtfContribution[]
  expanded: boolean
  onToggle: () => void
  onRoute: () => void
}) {
  const meta = CLASS_META[row.classification]
  const gapColor = (n: number) =>
    Math.abs(n) < 1e-9 ? 'var(--color-t4)' : n > 0 ? 'var(--color-up)' : 'var(--color-down)'
  const reqRounded = Math.round(row.required)
  return (
    <>
      <tr
        className="border-t border-bg-base/40 cursor-pointer hover:bg-bg-surface/30"
        onClick={onToggle}
      >
        <td className="py-1 text-t2">
          <span className="text-t4 text-[9px] mr-1">{expanded ? '▾' : '▸'}</span>
          <span className="text-t1">{row.code}</span>
          {row.name && <span className="text-t4 ml-1 text-[10px]">{row.name}</span>}
        </td>
        <td className="py-1 text-right text-t3">{fmtQty(reqRounded)}</td>
        <td className="py-1 text-right text-t2">{fmtQty(row.actual)}</td>
        <td className="py-1 text-right text-t4/80 text-[10px]">{fmtQty(row.actual_spot)}</td>
        <td className="py-1 text-right text-t4/80 text-[10px]">
          {row.actual_stockfut !== 0 ? fmtQty(row.actual_stockfut) : '-'}
        </td>
        <td className="py-1 text-right font-medium" style={{ color: gapColor(row.gap) }}>
          {row.gap > 0 ? '+' : ''}
          {fmtQty(Math.round(row.gap))}
        </td>
        <td className="py-1 text-right text-[10px]" style={{ color: gapColor(row.gap) }}>
          {row.gap_delta_krw != null ? fmtKrw(row.gap_delta_krw) : '-'}
        </td>
        <td className="py-1 text-center">
          <span className={cn('px-1.5 py-0.5 text-[9px] rounded-sm', meta.cls)} title={meta.title}>
            {meta.label}
          </span>
        </td>
        <td className="py-1 text-right">
          {row.order_side ? (
            <span className="inline-flex items-center gap-1">
              <span className={row.order_side === 'buy' ? 'text-up' : 'text-down'}>
                {row.order_side === 'buy' ? '매수' : '매도'} {fmtQty(row.order_shares)}
                {row.adv_capped && <span title="ADV 캡 초과"> ⚠</span>}
              </span>
              {row.has_stock_future && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onRoute()
                  }}
                  className="text-[9px] px-1 py-0.5 rounded-sm bg-blue/15 text-blue hover:bg-blue/25"
                  title="베이시스 라우터에서 현물 vs 주식선물 대체 판정"
                >
                  선물 ↗
                </button>
              )}
            </span>
          ) : (
            <span className="text-t4 text-[10px]">-</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-bg-base/20">
          <td colSpan={9} className="px-3 py-1.5 text-[10px] text-t4">
            <span className="text-t3">요구 출처 ETF:</span>{' '}
            {rollup.length === 0 ? (
              <span>없음 (현물/선물 보유만 — 요구=0)</span>
            ) : (
              rollup.map((c, i) => (
                <span key={c.etf_code} className="ml-1">
                  {i > 0 && '· '}
                  {c.name ?? c.etf_code}{' '}
                  <span className={c.contribution < 0 ? 'text-down' : 'text-up'}>
                    {c.contribution > 0 ? '+' : ''}
                    {fmtQty(Math.round(c.contribution))}주
                  </span>
                </span>
              ))
            )}
            <span className="ml-3 text-t4">
              tol {Math.round(row.tolerance)}주 · gap δ{' '}
              {row.gap_delta_krw != null ? fmtKrw(row.gap_delta_krw) : 'n/a'} · 가족 {famLabel(row.family)}
            </span>
          </td>
        </tr>
      )}
    </>
  )
}
