import { useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import { cn } from '@/lib/utils'

/**
 * 출구 3개 비교 카드 (§13.3-D) — Phase 5. 프론트 계산 위주 (v1 근사 명시).
 *
 * 넷팅 바스켓(BasketBuilderPanel) 생성 결과(lpStore.nettingBasket)를 공유해 세 출구를
 * 동일 기준(재고 명목 대비 순 bp = 편익 − 비용)으로 비교·정렬한다:
 *   1) 넷팅 바스켓 + 선물 청산  — 거래세 + 선물 청산 수수료 (전부 비용)
 *   2) 호가 자연 건조          — 스프레드 수취 − 캐리 × 예상 소요일 (순 편익 가능)
 *   3) 설정/환매              — CU 도달 ETF만, AP 수수료 (cu_fee_bp)
 *
 * 각 카드: "지금 정리 시 추정 순액" + 근사 가정 각주. 세 값의 직접 비교가 목적.
 */

function fmtKrw(krw: number): string {
  const abs = Math.abs(krw)
  const sign = krw > 0 ? '+' : krw < 0 ? '−' : ''
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}만`
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`
}
const fmtBp = (bp: number) => `${bp >= 0 ? '+' : '−'}${Math.abs(bp).toFixed(1)}bp`
const bpClass = (bp: number) => (bp > 0 ? 'text-up' : bp < 0 ? 'text-down' : 'text-t3')

export function ExitComparisonPanel() {
  const basket = useLpStore((s) => s.nettingBasket)
  const qp = useLpStore((s) => s.quoteParams)
  const cost = useLpStore((s) => s.costInputs)
  const [dryDays, setDryDays] = useState(3)

  if (!basket) {
    return (
      <div className="bg-bg-primary">
        <Header />
        <div className="px-3 py-6 text-[11px] text-t4">
          넷팅 바스켓을 먼저 생성하면 세 출구를 재고 명목 대비 순 bp로 비교합니다.
        </div>
      </div>
    )
  }

  const inv = basket.inventory_notional_krw
  const invOk = inv > 0

  // ── 출구 1: 넷팅 바스켓 + 선물 청산 (전부 비용) ──
  const tax = basket.totals.est_tax_krw
  // 선물 청산 수수료 근사 = 재고 명목 × 선물수수료bp (오버레이 ≈ 재고 델타 근사).
  const futFee = inv * (qp.futures_fee_bp / 1e4)
  const e1Cost = tax + futFee
  const e1Net = -e1Cost
  const e1Bp = invOk ? (e1Net / inv) * 1e4 : 0

  // ── 출구 2: 호가 자연 건조 (스프레드 수취 − 캐리) ──
  const spreadBenefit = inv * (qp.base_spread_bp / 1e4)
  const carryCost = inv * cost.base_rate_annual * (dryDays / 365)
  const e2Net = spreadBenefit - carryCost
  const e2Bp = invOk ? (e2Net / inv) * 1e4 : 0

  // ── 출구 3: 설정/환매 (CU 도달 ETF만, AP 수수료) ──
  const cuHoldings = basket.etf_holdings.filter((h) => h.cu_count > 0 && h.price != null)
  const redeemNotional = cuHoldings.reduce(
    (s, h) => s + h.cu_count * (h.cu_unit ?? 0) * (h.price ?? 0),
    0,
  )
  const e3Cost = redeemNotional * (qp.cu_fee_bp / 1e4)
  const e3Net = -e3Cost
  // 순 bp는 재고 전체 대비 (환매 가능분만 비용 발생하나 비교 기준은 동일 재고 명목).
  const e3Bp = invOk ? (e3Net / inv) * 1e4 : 0

  const cards = [
    {
      key: 'basket',
      title: '넷팅 바스켓 + 선물 청산',
      badge: '메인',
      net: e1Net,
      bp: e1Bp,
      rows: [
        ['거래세', fmtKrw(-tax)],
        ['선물 청산 수수료', fmtKrw(-futFee)],
        ...(basket.totals.n_adv_capped > 0
          ? [['ADV 캡 초과', `${basket.totals.n_adv_capped}종 ⚠`] as [string, string]]
          : []),
      ] as Array<[string, string]>,
      notes: [
        '종목 스프레드·시장 임팩트 비용 v1 생략 (실현 비용 과소평가 가능).',
        '선물 청산 수수료 = 재고 명목 × 선물수수료bp 근사 (오버레이≈재고 델타).',
      ],
    },
    {
      key: 'dry',
      title: '호가 자연 건조',
      net: e2Net,
      bp: e2Bp,
      rows: [
        ['스프레드 수취', fmtKrw(spreadBenefit)],
        [`캐리 (${dryDays}일)`, fmtKrw(-carryCost)],
      ] as Array<[string, string]>,
      notes: [
        '스프레드 수취 = 재고 명목 × 기본 반스프레드 (전량 스큐 소진 가정, 낙관적).',
        '소요일은 사용자 입력 (일거래대금 기반 자동 추정 미구현 — v1).',
      ],
      daysInput: true,
    },
    {
      key: 'redeem',
      title: '설정/환매 (CU)',
      net: e3Net,
      bp: e3Bp,
      rows: [
        ['환매 가능 명목', redeemNotional > 0 ? fmtKrw(redeemNotional) : '해당 없음'],
        ['AP 수수료', fmtKrw(-e3Cost)],
        ['CU 도달 ETF', `${cuHoldings.length}종`],
      ] as Array<[string, string]>,
      notes: [
        `AP 수수료 ${qp.cu_fee_bp}bp × CU 명목 (조성/해지 비용 파라미터).`,
        'CU 미도달 잔량은 환매 불가 → 다른 출구 병행 필요.',
      ],
    },
  ]

  const bestBp = Math.max(...cards.map((c) => c.bp))

  return (
    <div className="bg-bg-primary">
      <Header inv={inv} />
      <div className="p-2 grid grid-cols-1 gap-2">
        {cards.map((c) => (
          <div
            key={c.key}
            className={cn(
              'bg-bg-surface px-3 py-2.5',
              c.bp === bestBp && invOk ? 'ring-1 ring-accent/40' : '',
            )}
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-t1 font-medium">{c.title}</span>
                {c.badge && (
                  <span className="text-[9px] px-1 py-0.5 rounded-sm bg-blue/15 text-blue">{c.badge}</span>
                )}
                {c.bp === bestBp && invOk && (
                  <span className="text-[9px] px-1 py-0.5 rounded-sm bg-accent/15 text-accent">최선</span>
                )}
              </div>
              <div className="text-right">
                <div className={cn('text-[15px] font-mono tabular-nums', bpClass(c.bp))}>{fmtBp(c.bp)}</div>
                <div className="text-[9px] text-t4">순 {fmtKrw(c.net)}</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
              {c.rows.map(([k, v], i) => (
                <div key={i} className="flex flex-col">
                  <span className="text-[9px] text-t4">{k}</span>
                  <span className="text-[11px] font-mono tabular-nums text-t2">{v}</span>
                </div>
              ))}
            </div>
            {c.daysInput && (
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] text-t4">예상 소요일</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={dryDays}
                  onChange={(e) => setDryDays(Math.max(0, parseInt(e.target.value) || 0))}
                  className="w-16 bg-bg-base px-2 py-0.5 text-right text-[11px] tabular-nums text-t1 outline-none focus:border-accent border border-transparent"
                />
              </div>
            )}
            <div className="text-[9px] text-t4 leading-relaxed mt-1.5">
              {c.notes.map((n, i) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-3 py-2 border-t border-bg-base text-[9px] text-t4 leading-relaxed">
        순 bp = (편익 − 비용) / 재고 명목. 세 값의 직접 비교용 근사치 — 실집행 비용은 호가 깊이·
        임팩트로 달라짐. 넷팅 바스켓/설정환매는 비용만, 자연 건조는 스프레드 편익이 있어 부호가 갈림.
      </div>
    </div>
  )
}

function Header({ inv }: { inv?: number }) {
  return (
    <div className="px-3 py-2 border-b border-bg-base flex items-center justify-between">
      <div>
        <div className="text-[13px] text-t2 font-medium">출구 3개 비교 (§13.3-D)</div>
        <div className="text-[11px] text-t4">넷팅 바스켓 / 자연 건조 / 설정·환매 — 순 bp 정렬</div>
      </div>
      {inv != null && inv > 0 && (
        <div className="text-right">
          <div className="text-[9px] text-t4">재고 명목</div>
          <div className="text-[13px] font-mono tabular-nums text-t2">{fmtKrw(inv)}</div>
        </div>
      )}
    </div>
  )
}
