import { useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import type { NettingBasketResponse } from '@/types/lp'
import { cn } from '@/lib/utils'

/**
 * 넷팅 바스켓 빌더 (§13.3-D 메인 출구 · §13.2) — Phase 5.
 *
 * "넷팅 바스켓 생성" 버튼 → POST /api/lp/netting-basket (원장 ETF 재고 기반 스냅샷 계산).
 * 보유 ETF PDF 전체를 합산해 종목별 순 주수 실행 주문표를 만든다. 겹치는 종목은 자동 넷팅.
 * 결과는 lpStore.nettingBasket에 저장 → 출구 3개 비교(ExitComparisonPanel)와 공유.
 *
 * 주식선물 배지 클릭 → BasisRouterPanel에 코드·방향·수량 프리필(자동 판정).
 * 주문표 클립보드 복사(탭 구분) — 데스크 엑셀 붙여넣기용.
 */

/** 원화 축약 (부호 有). */
function fmtKrw(krw: number): string {
  const abs = Math.abs(krw)
  const sign = krw > 0 ? '+' : krw < 0 ? '−' : ''
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}만`
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`
}
/** 부호 없는 크기 (억/만). */
function fmtSize(krw: number): string {
  const abs = Math.abs(krw)
  if (abs >= 1e8) return `${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(0)}만`
  return Math.round(abs).toLocaleString('ko-KR')
}

export function BasketBuilderPanel() {
  const basket = useLpStore((s) => s.nettingBasket)
  const setBasket = useLpStore((s) => s.setNettingBasket)
  const requestRoute = useLpStore((s) => s.requestBasisRoutePrefill)
  const ledgerAggregates = useLpStore((s) => s.ledgerAggregates)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)

  const generate = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await fetch('/api/lp/netting-basket', { method: 'POST' })
      if (!r.ok) {
        setErr(`생성 실패 (${r.status})`)
        return
      }
      setBasket((await r.json()) as NettingBasketResponse)
    } catch {
      setErr('네트워크 오류')
    } finally {
      setBusy(false)
    }
  }

  const copyOrders = async () => {
    if (!basket) return
    // 탭 구분: 코드 이름 방향 주수 예상대금 ADV% 거래세bp 주식선물
    const header = ['코드', '이름', '방향', '주수', '예상대금', 'ADV%', '거래세bp', '주식선물'].join('\t')
    const lines = basket.legs.map((l) =>
      [
        l.code,
        l.name ?? '',
        l.side === 'buy' ? '매수' : '매도',
        l.shares,
        l.est_notional != null ? Math.round(l.est_notional) : '',
        l.adv_ratio != null ? l.adv_ratio.toFixed(2) : '',
        l.tax_bp,
        l.has_stock_future ? 'Y' : '',
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

  // 선물 오버레이 청산 안내 — 현재 지수선물 오버레이의 역방향 = 청산 계약수.
  const overlayLegs = ledgerAggregates.filter(
    (a) => a.instrument === 'index_fut' && a.net_qty !== 0,
  )

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base flex items-center justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">넷팅 바스켓 빌더 (§13.3-D 메인 출구)</div>
          <div className="text-[11px] text-t4">
            보유 ETF PDF 합산 → 종목별 순 주수 주문표 (겹침 자동 넷팅)
          </div>
        </div>
        <div className="flex items-center gap-1">
          {basket && (
            <button
              onClick={copyOrders}
              className="text-[11px] px-3 py-1 bg-bg-surface text-t2 hover:text-t1"
            >
              {copied ? '복사됨 ✓' : '주문표 복사'}
            </button>
          )}
          <button
            onClick={generate}
            disabled={busy}
            className="text-[11px] px-4 py-1 bg-accent text-bg-base font-medium hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '생성 중...' : '넷팅 바스켓 생성'}
          </button>
        </div>
      </div>

      {err && <div className="px-3 py-2 text-[11px] text-down">{err}</div>}

      {!basket ? (
        <div className="px-3 py-6 text-[11px] text-t4">
          "넷팅 바스켓 생성"을 눌러 현재 ETF 재고의 순 실행 주문표를 계산합니다.
        </div>
      ) : (
        <>
          {/* ── 합계 스트립 ── */}
          <div className="px-3 py-2.5 border-b border-bg-base flex flex-wrap items-stretch gap-x-6 gap-y-2">
            <Stat label="보유 ETF" value={`${basket.n_etfs_held}종`} />
            <Stat label="실행 leg" value={`${basket.totals.n_legs} (매수 ${basket.totals.n_buy}/매도 ${basket.totals.n_sell})`} />
            <Stat label="총 실행 명목" value={fmtSize(basket.totals.gross_notional)} />
            <Stat
              label="순 명목 (매수−매도)"
              value={fmtKrw(basket.totals.net_notional)}
              valueClass={basket.totals.net_notional > 0 ? 'text-up' : basket.totals.net_notional < 0 ? 'text-down' : 'text-t3'}
            />
            <Stat label="예상 거래세" value={fmtSize(basket.totals.est_tax_krw)} valueClass="text-warning" />
            {/* leg 부호 규약 통일: 음수 = 정리 시 수취(롱 재고), 양수 = 지급(숏 재고) */}
            <Stat
              label="현금 leg (음수=수취)"
              value={fmtKrw(basket.cash_residual)}
              valueClass="text-t2"
            />
            {basket.totals.n_adv_capped > 0 && (
              <Stat label="ADV 캡 초과" value={`${basket.totals.n_adv_capped}종`} valueClass="text-down" />
            )}
          </div>

          {/* ── 선물 오버레이 청산 안내 ── */}
          {overlayLegs.length > 0 && (
            <div className="px-3 py-2 border-b border-bg-base bg-bg-base/30">
              <div className="text-[10px] text-t3 uppercase tracking-wide mb-1">선물 오버레이 청산 (역방향)</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums">
                {overlayLegs.map((a) => {
                  const closeSide = a.net_qty > 0 ? '매도' : '매수'
                  return (
                    <span key={a.code} className="text-t2">
                      {a.name ?? a.code}{' '}
                      <span className={a.net_qty > 0 ? 'text-down' : 'text-up'}>
                        {closeSide} {Math.abs(a.net_qty).toLocaleString('ko-KR')}계약
                      </span>
                    </span>
                  )
                })}
              </div>
              <div className="text-[9px] text-t4 mt-1">
                바스켓 청산과 동시에 현 선물 오버레이를 반대 방향으로 청산 (델타 중립 유지).
              </div>
            </div>
          )}

          {/* ── 주문표 ── */}
          {basket.legs.length === 0 ? (
            <div className="px-3 py-4 text-[11px] text-t4">
              실행 주문 없음 — 재고가 완전히 넷팅되었거나 바스켓 대상 ETF 재고가 없습니다.
            </div>
          ) : (
            <div className="px-3 py-2 max-h-[420px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="text-t4 text-[10px] sticky top-0 bg-bg-primary">
                  <tr>
                    <th className="text-left py-1 font-normal">종목</th>
                    <th className="text-center py-1 font-normal">방향</th>
                    <th className="text-right py-1 font-normal">주수</th>
                    <th className="text-right py-1 font-normal">예상대금</th>
                    <th className="text-right py-1 font-normal">ADV%</th>
                    <th className="text-right py-1 font-normal">거래세</th>
                    <th className="text-center py-1 font-normal">주식선물</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {basket.legs.map((l) => (
                    <tr key={l.code} className="border-t border-bg-base/40">
                      <td className="py-1 text-t2">
                        <span className="text-t1">{l.code}</span>
                        {l.name && <span className="text-t4 ml-1 text-[10px]">{l.name}</span>}
                      </td>
                      <td className="py-1 text-center">
                        <span className={l.side === 'buy' ? 'text-up' : 'text-down'}>
                          {l.side === 'buy' ? '매수' : '매도'}
                        </span>
                      </td>
                      <td className="py-1 text-right text-t1">{l.shares.toLocaleString('ko-KR')}</td>
                      <td className="py-1 text-right text-t2">
                        {l.est_notional != null ? fmtSize(l.est_notional) : <span className="text-t4">-</span>}
                      </td>
                      <td className={cn('py-1 text-right', l.adv_capped ? 'text-down font-medium' : 'text-t3')}>
                        {l.adv_ratio != null ? (
                          <span title={l.adv_capped ? `ADV의 ${l.adv_ratio.toFixed(1)}% — 캡(${basket.adv_cap_pct}%) 초과` : ''}>
                            {l.adv_ratio.toFixed(2)}%{l.adv_capped && ' ⚠'}
                          </span>
                        ) : (
                          <span className="text-t4">-</span>
                        )}
                      </td>
                      <td className="py-1 text-right text-t4">{l.tax_bp > 0 ? `${l.tax_bp}bp` : '-'}</td>
                      <td className="py-1 text-center">
                        {l.has_stock_future ? (
                          <button
                            onClick={() => requestRoute({ code: l.code, side: l.side, qty: l.shares })}
                            className="text-[10px] px-1.5 py-0.5 rounded-sm bg-blue/15 text-blue hover:bg-blue/25"
                            title="베이시스 라우터에서 현물 vs 주식선물 대체 판정"
                          >
                            선물 ↗
                          </button>
                        ) : (
                          <span className="text-t4 text-[10px]">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── excluded ── */}
          {basket.excluded.length > 0 && (
            <div className="px-3 py-2 border-t border-bg-base">
              <div className="text-[10px] text-t3 uppercase tracking-wide mb-1">제외 ETF (바스켓 환산 불가)</div>
              {basket.excluded.map((e) => (
                <div key={e.etf_code} className="text-[10px] text-t4">
                  · <span className="text-t3">{e.name ?? e.etf_code}</span> ({e.etf_code}) — {e.reason}
                </div>
              ))}
            </div>
          )}

          {/* ── caveats ── */}
          {basket.caveats.length > 0 && (
            <div className="px-3 py-2 border-t border-bg-base">
              <div className="text-[10px] text-t4 leading-relaxed">
                {basket.caveats.map((c, i) => (
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
    <div className="flex flex-col justify-between min-w-[92px]">
      <div className="text-[10px] text-t3">{label}</div>
      <div className={cn('text-[14px] font-mono tabular-nums mt-0.5', valueClass)}>{value}</div>
    </div>
  )
}
