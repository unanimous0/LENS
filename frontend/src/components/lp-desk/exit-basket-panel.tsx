import { useMemo, useState } from 'react'

import { fmtWon, fmtWonAbs, LP_DOWN, LP_UP } from '@/lib/lp-desk'
import { cn, copyTableToClipboard } from '@/lib/utils'
import { CONTRACT_LABEL, type HedgeContract, type LpDeskExitBasket } from '@/types/lp-desk'

/**
 * 정리 미리보기 (§14.7) — 현 ETF 포지션 전체를 최신 PDF로 분해·넷팅한 주식 바스켓.
 * 헤더 버튼으로 여닫는 전폭 확장 영역이며 상시 패널이 아니다.
 * 산출물은 OMS 수동 입력용이라 클립보드 복사(탭 구분 = 엑셀 바로 붙여넣기)가 종착점.
 *
 * ⚠ 서버 응답의 **부호 규약이 레그마다 다르다**: `rows[].qty`는 보유의 look-through 환산
 * (롱 ETF → 양수)인데 `futures_legs[].qty`는 이미 뒤집힌 *집행 주문*이다. 그대로 한 표에
 * 섞으면 "삼성전자 204주 매수"처럼 정반대 지시가 되므로, 주식 레그는 보유 환산과 청산 주문을
 * **두 칸으로 나눠** 보여주고 복사 payload에는 집행 방향만 담는다.
 */
export function ExitBasketPanel({
  data,
  loading,
  error,
  onRefresh,
  onClose,
}: {
  data: LpDeskExitBasket | null
  loading: boolean
  error: string
  onRefresh: () => void
  onClose: () => void
}) {
  const [copied, setCopied] = useState('')

  const rows = useMemo(() => {
    const list = data?.rows ?? []
    return [...list].sort((a, b) => Math.abs(b.est_value) - Math.abs(a.est_value))
  }, [data])
  const legs = useMemo(() => data?.futures_legs ?? [], [data])

  // 보유 환산 기준 롱/숏 금액 (정리 주문은 이 반대 방향).
  const totals = useMemo(() => {
    let long = 0
    let short = 0
    for (const r of rows) {
      if (r.est_value >= 0) long += r.est_value
      else short += r.est_value
    }
    return { long, short, net: long + short }
  }, [rows])

  const copy = async (label: string, payload: Record<string, unknown>[], columns: { key: string; label: string }[]) => {
    const ok = await copyTableToClipboard(payload, columns)
    setCopied(ok ? label : '복사 실패')
    setTimeout(() => setCopied(''), 1800)
  }

  // 복사본은 **주문 티켓** — 보유 환산(rows[].qty)의 반대 방향이 집행할 주문이다.
  const copyBasket = () =>
    copy(
      '바스켓',
      rows.map((r) => ({
        code: r.code,
        name: r.name,
        market: r.market ?? '',
        side: r.qty >= 0 ? '매도' : '매수',
        qty: Math.abs(r.qty),
        est_value: Math.round(Math.abs(r.est_value)),
      })),
      [
        { key: 'code', label: '종목코드' },
        { key: 'name', label: '종목명' },
        { key: 'market', label: '시장' },
        { key: 'side', label: '구분' },
        { key: 'qty', label: '수량' },
        { key: 'est_value', label: '평가액' },
      ],
    )

  /**
   * 선물 청산 레그(§14.7)는 **별도 TSV**로 복사한다. 주식 바스켓과 한 표에 섞으면 수량 단위가
   * 주(株)/계약으로 뒤섞이고, OMS 바스켓 입력창이 통째로 거부한다.
   * legs[].qty는 서버가 이미 뒤집은 집행 주문 방향 그대로.
   */
  const copyFutures = () =>
    copy(
      '선물 레그',
      legs.map((leg) => ({
        contract: leg.contract,
        name: CONTRACT_LABEL[leg.contract as HedgeContract] ?? leg.contract,
        side: leg.qty >= 0 ? '매수' : '매도',
        qty: Math.abs(leg.qty),
        avg_price: leg.price != null && leg.price > 0 ? leg.price : '',
      })),
      [
        { key: 'contract', label: '계약' },
        { key: 'name', label: '계약명' },
        { key: 'side', label: '구분' },
        { key: 'qty', label: '계약수' },
        { key: 'avg_price', label: '보유평단' },
      ],
    )

  return (
    <div className="mx-2 mb-1 rounded-sm bg-[#0d0d0f] border border-white/[0.05]">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-white/[0.05] text-[11px]">
        <span className="text-[13px] text-white">정리 미리보기</span>
        <span className="text-[#8b8b8e]">
          PDF 기준일 <span className="text-[#d1d1d6] tabular-nums">{data?.pdf_date ?? '-'}</span>
        </span>
        <span className="text-[#8b8b8e]">
          종목 <span className="text-white tabular-nums">{rows.length}</span>
        </span>
        <span className="text-[#8b8b8e]" title="보유 환산 기준 금액 — 정리 주문은 이 반대 방향">
          보유환산 롱 <span className={cn('tabular-nums', LP_UP)}>{fmtWon(totals.long)}</span> · 숏{' '}
          <span className={cn('tabular-nums', LP_DOWN)}>{fmtWon(totals.short)}</span> · 순{' '}
          <span className="text-white tabular-nums">{fmtWon(totals.net)}</span>
        </span>
        {/* 숏 ETF 포지션이 섞이면 현금 제외분도 음수가 된다 — 크기만 쓰면 방향이 사라진다 */}
        {data?.cash_omitted != null && (
          <span className="text-[#8b8b8e]" title="PDF의 현금성(is_cash) 항목은 바스켓에서 제외됨 (보유 환산 기준 부호)">
            현금 제외{' '}
            <span className={cn('tabular-nums', data.cash_omitted < 0 ? LP_DOWN : 'text-warning')}>
              {fmtWon(data.cash_omitted)}
            </span>
          </span>
        )}
        {loading && <span className="text-blue">계산 중…</span>}
        {error && <span className="text-down">조회 실패: {error}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {copied && <span className="text-accent">{copied} 복사됨</span>}
          <button
            onClick={copyBasket}
            disabled={rows.length === 0}
            className="h-[24px] rounded bg-[#1e1e22] px-2.5 text-[11px] text-[#d1d1d6] hover:bg-[#2e2e32] hover:text-white disabled:cursor-not-allowed disabled:text-[#4a4a4e] transition-colors"
            title="탭 구분(TSV) — 엑셀·OMS 입력창에 그대로 붙여넣기"
          >
            바스켓 복사
          </button>
          <button
            onClick={copyFutures}
            disabled={legs.length === 0}
            className="h-[24px] rounded bg-[#1e1e22] px-2.5 text-[11px] text-[#d1d1d6] hover:bg-[#2e2e32] hover:text-white disabled:cursor-not-allowed disabled:text-[#4a4a4e] transition-colors"
            title="선물 청산 레그만 별도 TSV — 수량 단위(계약)가 달라 바스켓과 분리"
          >
            선물 복사
          </button>
          <button
            onClick={onRefresh}
            className="h-[24px] rounded bg-[#1e1e22] px-2.5 text-[11px] text-[#d1d1d6] hover:bg-[#2e2e32] hover:text-white transition-colors"
          >
            재계산
          </button>
          <button
            onClick={onClose}
            className="h-[24px] rounded bg-[#1e1e22] px-2.5 text-[11px] text-[#8b8b8e] hover:bg-[#2e2e32] hover:text-white transition-colors"
          >
            닫기
          </button>
        </div>
      </div>

      {/* 선물 레그 — qty는 서버가 이미 뒤집어 준 **집행 주문**, position_qty가 현 보유 */}
      <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 border-b border-white/[0.05] text-[11px]">
        <span className="text-[#8b8b8e]">선물 레그</span>
        {legs.length === 0 ? (
          <span className="text-[#5a5a5e]">없음</span>
        ) : (
          legs.map((leg) => (
            <span key={leg.contract} className="rounded bg-[#1e1e22] px-2 py-0.5 tabular-nums">
              <span className="text-[#d1d1d6]">{CONTRACT_LABEL[leg.contract as HedgeContract] ?? leg.contract}</span>{' '}
              <span className={leg.qty >= 0 ? LP_UP : LP_DOWN}>
                {Math.abs(leg.qty).toLocaleString()}계약 {leg.qty >= 0 ? '매수' : '매도'}
              </span>
              {leg.position_qty != null && (
                <span className="ml-1 text-[#5a5a5e]">
                  (보유 {leg.position_qty > 0 ? '+' : ''}{leg.position_qty.toLocaleString()})
                </span>
              )}
              {leg.price != null && leg.price > 0 && (
                <span className="ml-1 text-[#8b8b8e]">평단 {leg.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              )}
            </span>
          ))
        )}
        <span className="text-[10px] text-[#5a5a5e]">표시 수량 = 집행할 청산 주문</span>
        {(data?.source_etfs?.length ?? 0) > 0 && (
          <span
            className="text-[10px] text-[#5a5a5e]"
            title={(data?.source_etfs ?? []).map((s) => `${s.name || s.etf_code} ${s.qty.toLocaleString()}주 (CU ${s.creation_unit.toLocaleString()})`).join('\n')}
          >
            분해 ETF <span className="text-[#8b8b8e] tabular-nums">{data?.source_etfs?.length}</span>종
          </span>
        )}
      </div>

      {(data?.warnings?.length ?? 0) > 0 && (
        <div className="px-3 py-1.5 border-b border-white/[0.05] text-[11px] text-warning">
          {(data?.warnings ?? []).map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-[#5a5a5e]">
          {loading ? '계산 중…' : '정리할 포지션이 없습니다.'}
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full tabular-nums">
            <thead className="sticky top-0 bg-[#16161a] text-[10px] text-[#a8a8ae]">
              <tr>
                <th className="py-1.5 pl-3 text-left font-normal">종목코드</th>
                <th className="py-1.5 text-left font-normal">종목명</th>
                <th className="py-1.5 pr-3 text-right font-normal">시장</th>
                <th className="py-1.5 pr-3 text-right font-normal" title="ETF 포지션의 look-through 환산 보유">보유환산</th>
                <th className="py-1.5 pr-3 text-right font-normal" title="정리 시 집행할 주문 — 보유 환산의 반대 방향">청산주문</th>
                <th className="py-1.5 pr-3 text-right font-normal">평가액</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-b border-white/[0.03] hover:bg-white/[0.04]">
                  <td className="py-[5px] pl-3 text-left text-[11px] text-[#8b8b8e]">{r.code}</td>
                  <td className="py-[5px] text-left text-[11px] text-white">{r.name}</td>
                  <td className="py-[5px] pr-3 text-right text-[10px] text-[#8b8b8e]">{r.market ?? '미분류'}</td>
                  <td className={cn('py-[5px] pr-3 text-right text-[11px]', r.qty >= 0 ? LP_UP : LP_DOWN)}>
                    {r.qty > 0 ? '+' : ''}{r.qty.toLocaleString()}
                  </td>
                  <td className={cn('py-[5px] pr-3 text-right text-[11px] font-medium', r.qty >= 0 ? LP_DOWN : LP_UP)}>
                    {Math.abs(r.qty).toLocaleString()} {r.qty >= 0 ? '매도' : '매수'}
                  </td>
                  <td className="py-[5px] pr-3 text-right text-[11px] text-[#d1d1d6]">{fmtWonAbs(r.est_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
