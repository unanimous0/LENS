import { useMemo, useState } from 'react'

import type { PairDetail } from '@/types/stat-arb'

/** series_key (S:005930 등) → 종목코드 */
function keyToCode(key: string): string {
  const i = key.indexOf(':')
  return i >= 0 ? key.slice(i + 1) : key
}

/**
 * 통합 PnL 시뮬레이터 — PR15a (2 레이어: 통계차익 + 대여수익).
 * 매도차익(베이시스)은 PR15b에서 추가.
 *
 * 가정 단순화:
 *  - 1:1 페어 (left/right 각 1 leg)
 *  - z<0 → right 저평가 → right 매수 / left 매도
 *  - z>0 → right 고평가 → right 매도 / left 매수
 *  - 통계차익 = 회귀 시 spread → 0 가정. 진입 spread × 수량 = PnL.
 *    (수량은 right 수량 기준, left 수량은 β·right로 자동)
 *  - 대여수익 = 매수 leg 명목금액 × (요율 / 100) × (보유일 / 365)
 */
export function PnlSimulator({
  detail,
  loanRates,
}: {
  detail: PairDetail
  loanRates: Map<string, number>
}) {
  const stat1d = detail.timeframes.find((t) => t.timeframe === '1d')
  const lastPoint = detail.spread_series[detail.spread_series.length - 1]

  // 사용자 입력
  const [qty, setQty] = useState(100) // right leg 수량
  const [days, setDays] = useState(5)
  const [lendOut, setLendOut] = useState(true)
  // 진입가 — 사용자가 직접 입력 (또는 자동 추정값을 디폴트로)
  // PR15a 단순화: spread만 알면 PnL 계산 충분, 진입가는 *대여수익 명목금액*에만 필요.
  // 디폴트로 spread 절댓값 × 10 (대충 추정) — 사용자가 수정.
  const [buyPrice, setBuyPrice] = useState(() => {
    const sp = lastPoint?.spread ?? 0
    return Math.max(Math.round(Math.abs(sp) * 10), 10000)
  })

  const calc = useMemo(() => {
    if (!stat1d || !lastPoint) return null
    const beta = stat1d.hedge_ratio
    const z = stat1d.z_score
    const spread = lastPoint.spread

    // 방향: z<0 → right 매수 / z>0 → right 매도
    const buyRight = z < 0
    const buyCode = buyRight ? keyToCode(detail.right_key) : keyToCode(detail.left_key)
    const sellCode = buyRight ? keyToCode(detail.left_key) : keyToCode(detail.right_key)
    const buyName = buyRight ? detail.right_name : detail.left_name
    const sellName = buyRight ? detail.left_name : detail.right_name

    // ① 통계차익 — 회귀 시 spread → 0. 절댓값 × right 수량.
    //    spread 단위는 잔차(원 단위). qty는 right 기준이라 spread × qty로 PnL 계산.
    const statPnL = Math.abs(spread) * qty

    // ② 대여수익 — 매수 leg 명목금액 × 요율 × 일수/365.
    //    매수 leg가 right면 수량 = qty, 매수 leg가 left면 수량 = |β| × qty.
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
  }, [stat1d, lastPoint, qty, days, lendOut, buyPrice, loanRates, detail])

  if (!calc) {
    return (
      <div className="panel p-3 text-xs text-t3">
        통계 데이터 부족으로 시뮬레이션 불가
      </div>
    )
  }

  const fmtKRW = (v: number) =>
    `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}원`

  return (
    <div className="panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-t1">통합 PnL 시뮬레이터</span>
        <span className="text-[10px] text-t4">
          PR15a — 통계차익 + 대여 (매도차익은 PR15b)
        </span>
      </div>

      {/* 자동 추정된 방향 + 핵심 수치 */}
      <div className="mb-3 rounded-sm bg-bg-surface px-3 py-2 text-xs">
        <div className="text-t3">
          진입 방향 (z={calc.z.toFixed(2)} 기준 자동):
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
          <span className="text-t3">매수가 (명목금액용)</span>
          <input
            type="number"
            value={buyPrice}
            onChange={(e) => setBuyPrice(Math.max(0, parseInt(e.target.value) || 0))}
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
    </div>
  )
}
