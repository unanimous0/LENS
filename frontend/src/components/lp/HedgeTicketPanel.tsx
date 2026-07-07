import { useLpStore } from '@/stores/lpStore'
import type { HedgeLeg, HedgeTicket } from '@/types/lp'
import { FreshnessBadge } from './FreshnessBadge'
import { cn } from '@/lib/utils'

/**
 * 헤지 티켓 패널 (§13.3-B).
 *
 * 북 전체 순 델타를 지수선물로 0 만드는 데 필요한 **상시 티켓** — 가족별(K200/KQ150).
 * 반대 재고/기존 선물이 넷팅하면 "헤지 불필요". Rust book_risk.hedge_tickets(200ms) 소비.
 * 각 leg에 "기장 바로가기" — 원장 입력 폼에 선물코드·방향·계약수를 프리필.
 */

const FAMILY_LABEL: Record<string, string> = { k200: 'K200', kq150: 'KQ150' }

function fmtKrw(n: number): string {
  const abs = Math.abs(n)
  const s = n < 0 ? '−' : n > 0 ? '+' : ''
  if (abs >= 1e8) return `${s}${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${s}${(abs / 1e4).toFixed(0)}만`
  return `${s}${Math.round(abs).toLocaleString('ko-KR')}`
}

export function HedgeTicketPanel() {
  const bookRisk = useLpStore((s) => s.bookRisk)
  const tickets = bookRisk?.hedge_tickets ?? []

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base">
        <div className="text-[13px] text-t2 font-medium">헤지 티켓 (§13.3-B)</div>
        <div className="text-[11px] text-t4">
          북 순 델타 → 지수선물 상시 티켓 · 넷팅 자동 · 자동 제출 X
        </div>
      </div>

      <div className="p-2 flex flex-col gap-1.5">
        {tickets.length === 0 && (
          <div className="text-center py-6 text-t4 text-xs">
            가족 델타 없음 — 지수형 ETF/현물 재고가 없거나 book_risk 대기 중
          </div>
        )}
        {tickets.map((t) => (
          <TicketCard key={t.family} ticket={t} />
        ))}
      </div>
    </div>
  )
}

function TicketCard({ ticket: t }: { ticket: HedgeTicket }) {
  const fam = FAMILY_LABEL[t.family] ?? t.family.toUpperCase()
  const hasTicket = t.ticket.length > 0

  return (
    <div className="bg-bg-surface px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-t1 font-medium">{fam} 선물</span>
          {t.usable ? (
            hasTicket ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning">
                헤지 필요
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-accent/15 text-accent">
                헤지 불필요 (넷팅)
              </span>
            )
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-down/15 text-down">
              산출 불가
            </span>
          )}
        </div>
        <FreshnessBadge ageMs={t.futures_price_age_ms} />
      </div>

      {/* 델타 분해 */}
      <div className="grid grid-cols-3 gap-2 text-[11px] tabular-nums font-mono mb-2">
        <DeltaCell label="재고 델타" value={t.net_delta_krw} />
        <DeltaCell label="기존 선물" value={t.existing_futures_delta_krw} />
        <DeltaCell label="잔여 델타" value={t.residual_delta_krw} emphasize />
      </div>

      {/* 티켓 / 사유 */}
      {!t.usable ? (
        <div className="text-[11px] text-down">✗ {t.reason}</div>
      ) : hasTicket ? (
        <div className="flex flex-col gap-1">
          {t.ticket.map((leg) => (
            <LegRow key={leg.code} leg={leg} />
          ))}
          <div className="text-[10px] text-t4 mt-0.5">
            라운딩 잔차 {fmtKrw(t.rounding_residual_krw)} (본계약+미니로 못 잡는 델타)
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-t3">
          반대 재고/기존 선물이 순 델타를 상쇄 — 추가 헤지 계약 0.
        </div>
      )}
    </div>
  )
}

function DeltaCell({
  label,
  value,
  emphasize,
}: {
  label: string
  value: number
  emphasize?: boolean
}) {
  const color =
    Math.abs(value) < 1
      ? 'text-t3'
      : value > 0
        ? 'text-up'
        : 'text-down'
  return (
    <div>
      <div className="text-[9px] text-t4">{label}</div>
      <div className={cn(emphasize ? 'text-[13px]' : 'text-[12px]', color)}>
        {fmtKrw(value)}
      </div>
    </div>
  )
}

function LegRow({ leg }: { leg: HedgeLeg }) {
  const requestPrefill = useLpStore((s) => s.requestLedgerPrefill)
  const sideKo = leg.side === 'buy' ? '매수' : '매도'
  const sideColor = leg.side === 'buy' ? 'text-up' : 'text-down'

  return (
    <div className="flex items-center justify-between bg-bg-base px-2 py-1">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[11px] text-t2 truncate">{leg.name}</span>
        <span className="text-[10px] text-t4 font-mono tabular-nums">{leg.code}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[12px] font-mono tabular-nums">
          <span className="text-t1">{leg.contracts}</span>
          <span className="text-t4 text-[10px]">계약</span>{' '}
          <span className={sideColor}>{sideKo}</span>
        </span>
        <button
          onClick={() =>
            requestPrefill({ code: leg.code, side: leg.side, qty: leg.contracts })
          }
          title="원장 입력 폼에 프리필"
          className="text-[10px] px-2 py-0.5 bg-bg-surface text-t3 hover:text-t1 border border-transparent hover:border-accent"
        >
          기장
        </button>
      </div>
    </div>
  )
}
