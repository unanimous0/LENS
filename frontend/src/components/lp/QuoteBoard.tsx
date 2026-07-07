import { memo, useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import type { QuoteRow, QuoteUniverseMeta } from '@/types/lp'
import { FreshnessBadge } from './FreshnessBadge'
import { cn } from '@/lib/utils'

/**
 * 호가 제안 보드 (§13.3-A FV_futures) — /lp-matrix 메인 패널.
 *
 * Rust 8200이 200ms throttle로 보내는 quote_board 스냅샷을 그대로 렌더.
 * **자동 제출 없음** — 전부 "제안" 수치. 유니버스 12종 고정 순서(행 안정성) +
 * |갭| 하이라이트. 트레이딩 화면이라 행이 튀지 않도록 정렬은 config 순서 유지.
 *
 * QuoteRow엔 leverage/beta가 없어 모드 뱃지(배수/β)는 quoteUniverse 메타로 보강.
 */
export function QuoteBoard() {
  const board = useLpStore((s) => s.quoteBoard)
  const universe = useLpStore((s) => s.quoteUniverse)
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = board?.rows ?? []
  const usableCount = rows.filter((r) => r.usable).length

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base flex items-baseline justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">호가 제안 보드</div>
          <div className="text-[11px] text-t4">
            FV_futures 앵커 · 200ms · 자동 제출 X (제안 수치) · 재고 skew 반영
          </div>
        </div>
        {rows.length > 0 && (
          <div className="text-[11px] text-t3 tabular-nums">
            <span className="text-up">{usableCount}</span>
            <span className="text-t4"> / {rows.length} 호가 가능</span>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="text-t3 text-[11px]">
            <tr className="border-b border-bg-base">
              <th className="text-left px-3 py-2 sticky left-0 bg-bg-primary z-10">종목</th>
              <th className="text-right px-2 py-2">현재가</th>
              <th className="text-right px-2 py-2">FV_futures</th>
              <th className="text-right px-2 py-2">갭 bp</th>
              <th className="text-right px-2 py-2">제안 매수</th>
              <th className="text-right px-2 py-2">제안 매도</th>
              <th className="text-right px-2 py-2">제안 수량</th>
              <th className="text-right px-2 py-2">skew bp</th>
              <th className="text-right px-2 py-2">신선도</th>
              <th className="text-center px-2 py-2">모드</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <QuoteRowView
                key={row.code}
                row={row}
                meta={universe[row.code]}
                expanded={expanded === row.code}
                onToggle={() =>
                  setExpanded((cur) => (cur === row.code ? null : row.code))
                }
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-8 text-t4 text-xs">
                  호가 보드 대기 중... (matrix-config quote_universe fetch 후 ~수초)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 text-[10px] text-t4 border-t border-bg-base">
        갭 = (현재가 − FV)/FV. <span className="text-up">저평가(초록)</span> = 매수 기회 ·{' '}
        <span className="text-down">고평가(빨강)</span>. 행 클릭 → 요구엣지 분해(base/buffer/잔차/skew).
      </div>
    </div>
  )
}

const fmtPrice = (v: number) =>
  v > 0
    ? v.toLocaleString('ko-KR', { maximumFractionDigits: v >= 1000 ? 0 : 2 })
    : '-'

const FAMILY_LABEL: Record<string, string> = { k200: 'K200', kq150: 'KQ150' }

/** 모드 뱃지 문자열: 지수형 "K200 ×2" / "KQ150 ×-1", 섹터형 "β0.97". */
function modeBadge(row: QuoteRow, meta?: QuoteUniverseMeta): string {
  const fam = FAMILY_LABEL[row.index_family] ?? row.index_family.toUpperCase()
  if (row.fv_mode === 'index') {
    const lev = meta?.leverage
    return lev != null ? `${fam} ×${lev}` : fam
  }
  const beta = meta?.beta
  return beta != null ? `β${beta.toFixed(2)}` : `${fam} β`
}

const QuoteRowView = memo(
  function QuoteRowView({
    row,
    meta,
    expanded,
    onToggle,
  }: {
    row: QuoteRow
    meta?: QuoteUniverseMeta
    expanded: boolean
    onToggle: () => void
  }) {
    const dim = !row.usable
    const gapBp =
      row.price > 0 && row.fv_futures > 0
        ? ((row.price - row.fv_futures) / row.fv_futures) * 10000
        : null
    // 저평가(현재가 < FV, 갭<0) = 매수 기회 → 초록. 고평가 → 빨강.
    const gapColor =
      gapBp == null || Math.abs(gapBp) < 0.05
        ? 'text-t3'
        : gapBp < 0
          ? 'text-up'
          : 'text-down'

    const skew = row.skew_bp
    const skewGlyph = Math.abs(skew) < 0.05 ? '' : skew < 0 ? '▼' : '▲'
    const skewTitle =
      skew < 0
        ? '롱 재고 → 예약가격 하향 (매도 공격적)'
        : skew > 0
          ? '숏 재고 → 예약가격 상향 (매수 공격적)'
          : '재고 중립'

    return (
      <>
        <tr
          onClick={onToggle}
          className={cn(
            'border-b border-bg-base/30 hover:bg-bg-surface/40 cursor-pointer',
            dim && 'opacity-45',
          )}
        >
          {/* 종목 */}
          <td className="px-3 py-1.5 sticky left-0 bg-bg-primary z-10">
            <div className="flex items-center gap-1.5">
              <span className="text-t4 text-[9px] w-2">{expanded ? '▾' : '▸'}</span>
              <div className="min-w-0">
                <div className="text-t1 font-medium tabular-nums leading-tight">
                  {row.code}
                </div>
                <div className="text-t3 text-[10px] truncate max-w-[130px] leading-tight">
                  {row.name}
                </div>
              </div>
            </div>
          </td>
          {/* 현재가 */}
          <td className="px-2 py-1.5 text-right tabular-nums text-t1 font-mono">
            {fmtPrice(row.price)}
          </td>
          {/* FV_futures */}
          <td className="px-2 py-1.5 text-right tabular-nums text-t2 font-mono">
            {fmtPrice(row.fv_futures)}
          </td>
          {/* 갭 bp */}
          <td
            className={cn('px-2 py-1.5 text-right tabular-nums font-mono', gapColor)}
            title="현재가 vs FV_futures (음수=저평가=매수 기회)"
          >
            {gapBp == null ? '-' : `${gapBp > 0 ? '+' : ''}${gapBp.toFixed(1)}`}
          </td>
          {/* 제안 매수 */}
          <td className="px-2 py-1.5 text-right font-mono">
            {row.usable && row.suggested_bid > 0 ? (
              <>
                <span className="text-t1 tabular-nums">{fmtPrice(row.suggested_bid)}</span>
                <span className="text-t4 text-[10px] tabular-nums ml-1">
                  {row.edge_bid_bp.toFixed(1)}bp
                </span>
              </>
            ) : (
              <span className="text-t4">-</span>
            )}
          </td>
          {/* 제안 매도 */}
          <td className="px-2 py-1.5 text-right font-mono">
            {row.usable && row.suggested_ask > 0 ? (
              <>
                <span className="text-t1 tabular-nums">{fmtPrice(row.suggested_ask)}</span>
                <span className="text-t4 text-[10px] tabular-nums ml-1">
                  {row.edge_ask_bp.toFixed(1)}bp
                </span>
              </>
            ) : (
              <span className="text-t4">-</span>
            )}
          </td>
          {/* 제안 수량 */}
          <td className="px-2 py-1.5 text-right tabular-nums text-t2 font-mono">
            {row.usable && row.suggested_size > 0
              ? row.suggested_size.toLocaleString('ko-KR')
              : '-'}
          </td>
          {/* skew bp */}
          <td
            className="px-2 py-1.5 text-right tabular-nums font-mono text-t2"
            title={skewTitle}
          >
            {skewGlyph && <span className="text-blue mr-0.5 text-[10px]">{skewGlyph}</span>}
            {Math.abs(skew) < 0.05
              ? '0.0'
              : `${skew > 0 ? '+' : ''}${skew.toFixed(1)}`}
          </td>
          {/* 신선도 */}
          <td className="px-2 py-1.5 text-right">
            <FreshnessBadge ageMs={row.inputs_age_ms} />
          </td>
          {/* 모드 */}
          <td className="px-2 py-1.5 text-center">
            <span
              className={cn(
                'inline-block px-1.5 py-0.5 text-[10px] tabular-nums rounded-sm',
                row.fv_mode === 'index'
                  ? 'bg-blue/15 text-blue'
                  : 'bg-warning/15 text-warning',
              )}
            >
              {modeBadge(row, meta)}
            </span>
          </td>
        </tr>

        {/* no_quote 사유 — 인라인 (hover 숨김 지양, 트레이딩 화면) */}
        {dim && row.no_quote_reason && (
          <tr className="border-b border-bg-base/30">
            <td className="px-3 py-1 sticky left-0 bg-bg-primary z-10" />
            <td colSpan={9} className="px-2 py-1 text-[10px] text-down">
              ✗ {row.no_quote_reason}
            </td>
          </tr>
        )}

        {/* 확장 — 요구엣지 분해 + FV 입력 */}
        {expanded && (
          <tr className="border-b border-bg-base bg-bg-base/40">
            <td className="sticky left-0 bg-bg-base/40 z-10" />
            <td colSpan={9} className="px-3 py-2">
              <RowDetail row={row} meta={meta} />
            </td>
          </tr>
        )}
      </>
    )
  },
  (a, b) =>
    a.expanded === b.expanded &&
    a.meta === b.meta &&
    // 200ms마다 새 스냅샷 → 값이 실제로 바뀐 행만 리렌더 (12행이라도 stale 행 스킵).
    a.row.price === b.row.price &&
    a.row.fv_futures === b.row.fv_futures &&
    a.row.suggested_bid === b.row.suggested_bid &&
    a.row.suggested_ask === b.row.suggested_ask &&
    a.row.suggested_size === b.row.suggested_size &&
    a.row.skew_bp === b.row.skew_bp &&
    a.row.edge_bid_bp === b.row.edge_bid_bp &&
    a.row.edge_ask_bp === b.row.edge_ask_bp &&
    a.row.inputs_age_ms === b.row.inputs_age_ms &&
    a.row.usable === b.row.usable &&
    a.row.no_quote_reason === b.row.no_quote_reason,
)

/** bp 칩 한 개. */
function BpChip({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[10px] text-t4">{label}</span>
      <span className={cn('text-[11px] tabular-nums font-mono', color ?? 'text-t2')}>
        {value > 0 ? '+' : ''}
        {value.toFixed(1)}
      </span>
    </div>
  )
}

function RowDetail({ row, meta }: { row: QuoteRow; meta?: QuoteUniverseMeta }) {
  const c = row.components
  const remainEok = row.inventory_remaining_krw / 1e8
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      {/* 요구엣지 분해 */}
      <div>
        <div className="text-[10px] text-t4 mb-1">요구엣지 분해 (bp)</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <BpChip label="기본" value={c.base} />
          <BpChip label="버퍼" value={c.buffer} />
          <BpChip label="잔차" value={c.residual} />
          <BpChip
            label="skew"
            value={c.skew}
            color={
              Math.abs(c.skew) < 0.05
                ? 'text-t3'
                : c.skew < 0
                  ? 'text-blue'
                  : 'text-blue'
            }
          />
          <BpChip label="헤지비용" value={c.hedge_cost} color="text-t3" />
        </div>
        <div className="text-[10px] text-t4 mt-1">
          매수엣지 {row.edge_bid_bp.toFixed(1)} / 매도엣지 {row.edge_ask_bp.toFixed(1)} bp
          (= 기본+버퍼+잔차 ∓ skew). 헤지비용은 가격 미반영·수익성 판단용.
        </div>
      </div>

      {/* FV 입력 */}
      <div>
        <div className="text-[10px] text-t4 mb-1">FV_futures 입력</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums font-mono">
          <span className="text-t4">r_implied</span>
          <span className="text-t2 text-right">
            {(row.r_implied * 100).toFixed(2)}%
          </span>
          <span className="text-t4">함축 현물지수</span>
          <span className="text-t2 text-right">
            {row.implied_index_spot > 0 ? row.implied_index_spot.toFixed(2) : '-'}
          </span>
          <span className="text-t4">선물코드</span>
          <span className="text-t2 text-right">{row.futures_code || '-'}</span>
          {row.futures_theory_price != null && (
            <>
              <span className="text-t4">LS 이론가</span>
              <span className="text-t2 text-right">
                {row.futures_theory_price.toFixed(2)}
              </span>
            </>
          )}
          {meta?.fv_mode === 'beta' && meta.beta != null && (
            <>
              <span className="text-t4">β (60d OLS)</span>
              <span className="text-t2 text-right">{meta.beta.toFixed(3)}</span>
            </>
          )}
        </div>
      </div>

      {/* 사이징 */}
      <div>
        <div className="text-[10px] text-t4 mb-1">제안 수량 근거</div>
        <div className="text-[11px] text-t2">{row.size_basis}</div>
        <div className="text-[11px] tabular-nums font-mono text-t2 mt-0.5">
          재고 한도 잔여 <span className="text-t1">{remainEok.toFixed(2)}억</span>
        </div>
      </div>
    </div>
  )
}
