import { useEffect, useMemo, useRef, useState } from 'react'

import { keyToCode } from '@/lib/stat-arb-keys'
import type { PairDetail } from '@/types/stat-arb'

import { PositionEntryModal } from './position-entry-modal'

/**
 * 통합 PnL 시뮬레이터 — 통계차익 + 대여수익.
 *
 * 가정 단순화:
 *  - 1:1 페어 (left/right 각 1 leg)
 *  - z<0 → right 저평가 → right 매수 / left 매도
 *  - z>0 → right 고평가 → right 매도 / left 매수
 *  - 통계차익 = 회귀 시 spread → 0 가정. 진입 spread × 수량 = PnL.
 *    (수량은 right 수량 기준, left 수량은 β·right로 자동)
 *  - 대여수익 = 매수 leg 명목금액 × (요율 / 100) × (보유일 / 365)
 *
 * PR15b: 실시간 가격 props 받아서 spread/z 계산 + 매수가 자동 디폴트.
 * 사용자가 매수가를 직접 손대면 그 후로는 manual 모드로 전환 (자동 갱신 중단).
 */
export function PnlSimulator({
  detail,
  loanRates,
  livePrices,
  liveZ,
  liveSpread,
}: {
  detail: PairDetail
  loanRates: Map<string, number>
  livePrices: { left: number; right: number }
  liveZ: number | null
  liveSpread: number | null
}) {
  const stat1d = detail.timeframes.find((t) => t.timeframe === '1d')
  const lastPoint = detail.spread_series[detail.spread_series.length - 1]

  // 방향 판정 — liveZ가 있으면 우선
  const z = liveZ ?? stat1d?.z_score ?? 0
  const spread = liveSpread ?? lastPoint?.spread ?? 0
  const buyRight = z < 0
  // 매수 leg 현재가 (자동 디폴트용)
  const livePriceForBuy = buyRight ? livePrices.right : livePrices.left

  // 사용자 입력
  const [qty, setQty] = useState(100)
  const [days, setDays] = useState(5)
  const [lendOut, setLendOut] = useState(true)
  const [buyPrice, setBuyPrice] = useState(0)
  // 사용자가 매수가를 직접 수정했는지. true면 자동 갱신 중단.
  const manualEdit = useRef(false)

  // 포지션 등록 모달
  const [modalOpen, setModalOpen] = useState(false)
  const [savedToast, setSavedToast] = useState<string | null>(null)

  // 실시간 매수 leg 가격 들어오면 자동으로 매수가 채움 (manual 진입 전까지).
  useEffect(() => {
    if (!manualEdit.current && livePriceForBuy > 0) {
      setBuyPrice(livePriceForBuy)
    }
  }, [livePriceForBuy])

  const calc = useMemo(() => {
    if (!stat1d) return null
    const beta = stat1d.hedge_ratio

    const buyCode = buyRight ? keyToCode(detail.right_key) : keyToCode(detail.left_key)
    const sellCode = buyRight ? keyToCode(detail.left_key) : keyToCode(detail.right_key)
    const buyName = buyRight ? detail.right_name : detail.left_name
    const sellName = buyRight ? detail.left_name : detail.right_name

    // ① 통계차익 — 회귀 시 spread → 0. 절댓값 × right 수량.
    const statPnL = Math.abs(spread) * qty

    // ② 대여수익 — 매수 leg 명목금액 × 요율 × 일수/365.
    const buyQty = buyRight ? qty : Math.abs(beta) * qty
    const notional = buyPrice * buyQty
    const buyRate = loanRates.get(buyCode) ?? 0
    const loanPnL = lendOut && buyRate > 0 ? notional * (buyRate / 100) * (days / 365) : 0

    const total = statPnL + loanPnL
    const annualRate = notional > 0 ? (total / notional / (days / 365)) * 100 : 0

    return {
      beta,
      z,
      spread,
      buyName,
      sellName,
      buyCode,
      sellCode,
      buyQty,
      notional,
      buyRate,
      statPnL,
      loanPnL,
      total,
      annualRate,
    }
  }, [stat1d, qty, days, lendOut, buyPrice, loanRates, detail, buyRight, z, spread])

  if (!calc) {
    return (
      <div className="panel p-3 text-xs text-t3">
        통계 데이터 부족으로 시뮬레이션 불가
      </div>
    )
  }

  const fmtKRW = (v: number) =>
    `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}원`

  const liveLabel = liveZ != null ? '실시간' : 'DB 마지막'

  return (
    <div className="panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-t1">통합 PnL 시뮬레이터</span>
        <span className="text-[10px] text-t4">통계차익 + 대여수익</span>
      </div>

      {/* 자동 추정된 방향 + 핵심 수치 */}
      <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs">
        <div className="text-t3">
          진입 방향 (z={calc.z.toFixed(2)} · {liveLabel} 기준):
        </div>
        <div className="mt-0.5 text-t1">
          <span className="text-up">매수</span> {calc.buyName}{' '}
          <span className="text-t4">({calc.buyCode})</span>
          {' · '}
          <span className="text-down">매도</span> {calc.sellName}{' '}
          <span className="text-t4">({calc.sellCode})</span>
        </div>
        <div className="mt-0.5 text-t3">
          β = {calc.beta.toFixed(3)} · spread = {Math.round(calc.spread).toLocaleString()}
        </div>
      </div>

      {/* 입력 폼 */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-t3">수량 (right 기준)</span>
          <input
            type="number"
            value={qty}
            onChange={(e) => setQty(Math.max(0, parseInt(e.target.value) || 0))}
            className="rounded-sm bg-bg-surface px-2 py-1 text-t1 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="flex items-center gap-1 text-t3">
            매수가
            {manualEdit.current ? (
              <button
                type="button"
                onClick={() => {
                  manualEdit.current = false
                  if (livePriceForBuy > 0) setBuyPrice(livePriceForBuy)
                }}
                className="text-[10px] text-accent hover:underline"
              >
                자동 복귀
              </button>
            ) : (
              <span className="text-[10px] text-accent">자동</span>
            )}
          </span>
          <input
            type="number"
            value={buyPrice}
            onChange={(e) => {
              manualEdit.current = true
              setBuyPrice(Math.max(0, parseInt(e.target.value) || 0))
            }}
            className="rounded-sm bg-bg-surface px-2 py-1 text-t1 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-t3">보유일</span>
          <input
            type="number"
            value={days}
            onChange={(e) => setDays(Math.max(1, parseInt(e.target.value) || 1))}
            className="rounded-sm bg-bg-surface px-2 py-1 text-t1 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={lendOut}
            onChange={(e) => setLendOut(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-t1">
            대여 송출 (매수분)
            {calc.buyRate > 0 ? (
              <span className="ml-1 text-warning">{calc.buyRate.toFixed(1)}%</span>
            ) : (
              <span className="ml-1 text-t4">요율 미등록</span>
            )}
          </span>
        </label>
      </div>

      {/* 결과 */}
      <div className="rounded-sm bg-bg-surface px-3 py-2">
        <table className="w-full text-xs tabular-nums">
          <tbody>
            <tr className="border-b border-bg-primary/50">
              <td className="py-1 text-t3">통계차익 (회귀 시 spread → 0)</td>
              <td className="py-1 text-right text-t1">{fmtKRW(calc.statPnL)}</td>
            </tr>
            <tr className="border-b border-bg-primary/50">
              <td className="py-1 text-t3">
                대여수익 ({calc.buyRate.toFixed(1)}% × {days}일 / 365)
              </td>
              <td className="py-1 text-right text-t1">{fmtKRW(calc.loanPnL)}</td>
            </tr>
            <tr>
              <td className="pt-1.5 font-semibold text-t1">합산 기대수익</td>
              <td className="pt-1.5 text-right font-semibold text-up">
                {fmtKRW(calc.total)}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="mt-2 text-[10px] text-t4">
          매수 leg 명목금액: {calc.notional.toLocaleString()}원 · 환산 연수익률:{' '}
          <span className="text-t3">{calc.annualRate.toFixed(2)}%</span>
        </div>
      </div>

      <div className="mt-2 text-[10px] text-t4">
        ※ 통계차익은 *완전 회귀 가정*. 실제론 보유기간 내 부분 회귀일 수도. β와 z의 부호로
        방향만 추정 — 실 매매 전 사용자 검토 필수.
      </div>

      {/* 진입 기록 버튼 */}
      <div className="mt-3 flex items-center justify-between gap-2">
        {savedToast ? (
          <span className="text-[11px] text-accent">{savedToast}</span>
        ) : (
          <span className="text-[10px] text-t4">실거래 후 위 입력값으로 포지션 기록 가능</span>
        )}
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={!stat1d}
          className="rounded-sm bg-accent/20 px-3 py-1.5 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
        >
          이 조합으로 진입 기록
        </button>
      </div>

      {stat1d && (
        <PositionEntryModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          detail={detail}
          prefill={{
            buyRight,
            rightQty: qty,
            buyPrice,
            sellPrice: buyRight ? livePrices.left : livePrices.right,
            lendOutBuy: lendOut,
            buyLoanRate: calc.buyRate,
            entryZ: z,
            entryStats: {
              alpha: stat1d.alpha,
              beta: stat1d.hedge_ratio,
              half_life: stat1d.half_life,
              adf: stat1d.adf_tstat,
              r2: stat1d.r_squared,
            },
          }}
          onSaved={(id) => {
            setSavedToast(`포지션 등록됨 (${id.slice(0, 8)}…)`)
            setTimeout(() => setSavedToast(null), 4000)
          }}
        />
      )}
    </div>
  )
}
