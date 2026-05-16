import { useLpStore } from '@/stores/lpStore'
import { HEDGE_ROUTE_COLUMNS } from '@/types/lp'
import type { EtfFairValueSnapshot, FairValueCell } from '@/types/lp'
import { FreshnessBadge } from './FreshnessBadge'
import { cn } from '@/lib/utils'

/**
 * ETF × 헤지경로 매트릭스 표.
 *   행: ETF (matrix.snapshots 순서)
 *   열: 5종 헤지 경로 (HEDGE_ROUTE_COLUMNS, 첫 빌드 2개만 wire)
 *   셀: fair_value · edge_buy/sell_bp · net_fv · 신선도 · usable 게이트
 *
 * best_route_buy/sell 인덱스에 해당하는 셀은 강조 (방향성 표시).
 */
export function FairValueMatrix() {
  const matrix = useLpStore((s) => s.matrix)

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base">
        <div className="text-[13px] text-t2 font-medium">Fair Value 매트릭스</div>
        <div className="text-[11px] text-t4">
          200ms throttle · ETF × 헤지경로 (Level 2 raw · Level 3 net · 신선도)
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="text-t3 text-[11px]">
            <tr className="border-b border-bg-base">
              <th className="text-left px-3 py-2 sticky left-0 bg-bg-primary">ETF</th>
              {HEDGE_ROUTE_COLUMNS.map((col) => (
                <th key={col.kind} className="text-right px-3 py-2 min-w-[160px]">
                  <div className={cn(!col.wiredInFirstBuild && 'text-t4')}>{col.label}</div>
                  {!col.wiredInFirstBuild && (
                    <div className="text-[9px] text-t4 normal-case">다음 빌드</div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix?.snapshots.map((snap) => (
              <EtfRow key={snap.etf_code} snap={snap} />
            ))}
            {!matrix && (
              <tr>
                <td colSpan={6} className="text-center py-8 text-t4 text-xs">
                  매트릭스 대기 중... (백엔드 risk-params/matrix-config fetch 후 ~수초)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EtfRow({ snap }: { snap: EtfFairValueSnapshot }) {
  return (
    <tr className="border-b border-bg-base/30 hover:bg-bg-surface/30">
      <td className="px-3 py-2 sticky left-0 bg-bg-primary">
        <div className="text-t1 font-medium tabular-nums">{snap.etf_code}</div>
        <div className="text-t3 text-[11px] tabular-nums">
          {snap.etf_price > 0 ? snap.etf_price.toLocaleString('ko-KR') : '-'}원
        </div>
      </td>
      {HEDGE_ROUTE_COLUMNS.map((col, idx) => {
        const cell = snap.cells.find((c) => c.route.kind === col.kind)
        const isBestBuy = snap.best_route_buy != null && snap.cells[snap.best_route_buy]?.route.kind === col.kind
        const isBestSell = snap.best_route_sell != null && snap.cells[snap.best_route_sell]?.route.kind === col.kind
        return (
          <td key={col.kind} className="px-3 py-2 align-top">
            {cell ? (
              <CellView cell={cell} highlightBuy={isBestBuy} highlightSell={isBestSell} />
            ) : col.wiredInFirstBuild ? (
              <span className="text-t4 text-xs">-</span>
            ) : (
              <span className="text-t4 text-[10px]">미운영</span>
            )}
          </td>
        )
      })}
    </tr>
  )
}

function CellView({
  cell,
  highlightBuy,
  highlightSell,
}: {
  cell: FairValueCell
  highlightBuy: boolean
  highlightSell: boolean
}) {
  const sign = (v: number) => (v > 0 ? '+' : '')
  const buyColor = cell.edge_buy_bp > 0 ? 'text-up' : cell.edge_buy_bp < 0 ? 'text-down' : 'text-t3'
  const sellColor = cell.edge_sell_bp > 0 ? 'text-up' : cell.edge_sell_bp < 0 ? 'text-down' : 'text-t3'
  return (
    <div className={cn('font-mono tabular-nums text-right', !cell.usable && 'opacity-50')}>
      <div className="text-t2 text-[12px]">
        {cell.fair_value > 0 ? cell.fair_value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '-'}
      </div>
      <div className="flex justify-end gap-2 text-[11px]">
        <span className={cn('inline-flex items-center gap-0.5', buyColor, highlightBuy && 'font-bold')}>
          B {sign(cell.edge_buy_bp)}{cell.edge_buy_bp.toFixed(1)}bp
          {highlightBuy && <span className="text-accent text-[8px]">★</span>}
        </span>
      </div>
      <div className="flex justify-end gap-2 text-[11px]">
        <span className={cn('inline-flex items-center gap-0.5', sellColor, highlightSell && 'font-bold')}>
          S {sign(cell.edge_sell_bp)}{cell.edge_sell_bp.toFixed(1)}bp
          {highlightSell && <span className="text-accent text-[8px]">★</span>}
        </span>
      </div>
      <div className="flex justify-end items-center gap-1 mt-0.5">
        <FreshnessBadge ageMs={cell.inputs_age_ms} />
        {cell.inputs_covered_pct < 1 && (
          <span className="text-[9px] text-warning" title={`결측 ${cell.missing_components.length}개`}>
            {(cell.inputs_covered_pct * 100).toFixed(0)}%
          </span>
        )}
        {!cell.usable && <span className="text-[9px] text-down">✗</span>}
      </div>
    </div>
  )
}
