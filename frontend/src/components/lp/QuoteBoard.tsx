import { memo, useState } from 'react'
import { useLpStore } from '@/stores/lpStore'
import type { QuoteRow, QuoteUniverseMeta } from '@/types/lp'
import { FreshnessBadge } from './FreshnessBadge'
import { cn } from '@/lib/utils'

/**
 * 호가 제안 보드 (§13.3-A FV_futures) — /lp-matrix "체결 전" 탭 메인 패널.
 *
 * Rust 8200이 200ms throttle로 보내는 quote_board 스냅샷을 그대로 렌더.
 * **자동 제출 없음** — 전부 "제안" 수치. 유니버스 12종 고정 순서(행 안정성).
 *
 * §13.13 보강:
 *  - **MID 기반**: Rust가 호가 mid(fresh)를 갭 기준가로 쓰면 `price_source='mid'`(배지),
 *    stale/결측이면 last 폴백. `gap_bp`는 서버 산출(mid 반영) — 프론트 재계산 안 함(fallback만).
 *  - **매수차/매도차 프레이밍**: 갭 컬럼을 차익 방향 + 진입선 도달률 게이지로 확장.
 *    매수차 = 저평가(ETF 매수+선물 매도), 매도차 = 고평가. 도달률 = |갭|/요구엣지.
 *    진입선 도달(≥100%) 행은 배경 subtle 하이라이트.
 *
 * QuoteRow엔 leverage/beta가 없어 모드 뱃지(배수/β)는 quoteUniverse 메타로 보강.
 */
/**
 * 표시 필터 — 섹터/주식형 ETF(fv_mode 'beta')만 노출. 지수형('index')·파생형(레버리지·인버스)은
 * NAV/FV 신뢰 불가로 임시 제외(별도 작업 예정). 복원: 이 값을 false로 두면 12종 전체 표시.
 * (backend·WS는 12종 전부 계산·전송 유지 — 프론트 표시 필터일 뿐.)
 */
const BETA_ONLY = true

export function QuoteBoard() {
  const board = useLpStore((s) => s.quoteBoard)
  const universe = useLpStore((s) => s.quoteUniverse)
  const [expanded, setExpanded] = useState<string | null>(null)

  const allRows = board?.rows ?? []
  const rows = BETA_ONLY ? allRows.filter((r) => r.fv_mode === 'beta') : allRows
  const hiddenCount = allRows.length - rows.length
  const usableCount = rows.filter((r) => r.usable).length
  const entryCount = rows.filter((r) => arbFraming(r).atEntry).length

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base flex items-baseline justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">호가 제안 보드</div>
          <div className="text-[11px] text-t3">
            FV_futures 앵커 · 200ms · 자동 제출 X (제안 수치) · 호가 mid 기준가 · 재고 skew 반영
          </div>
          {BETA_ONLY && (
            <div className="text-[11px] text-warning mt-0.5">
              섹터/주식형 {rows.length}종만 표시
              {hiddenCount > 0 && ` (지수·파생형 ${hiddenCount}종 제외 — NAV 이상, 별도 작업 예정)`}
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <div className="text-[11px] text-t3 tabular-nums flex items-center gap-3">
            {entryCount > 0 && (
              <span className="text-accent">진입선 도달 {entryCount}</span>
            )}
            <span>
              <span className="text-up">{usableCount}</span>
              <span className="text-t4"> / {rows.length} 호가 가능</span>
            </span>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        {/* table-fixed + colgroup: 열 폭을 내용과 무관하게 고정 → 200ms 틱마다 값이 바뀌어도
            테이블/열 폭 불변(좌우 흔들림 제거). 종목 컬럼은 sticky left 유지. */}
        <table className="w-full text-[12px] table-fixed">
          <colgroup>
            <col style={{ width: 160 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 92 }} />
            <col style={{ width: 190 }} />
            <col style={{ width: 108 }} />
            <col style={{ width: 108 }} />
            <col style={{ width: 92 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 76 }} />
            <col style={{ width: 88 }} />
          </colgroup>
          <thead className="text-t3 text-[11px]">
            <tr className="border-b border-bg-base">
              <th className="text-left px-3 py-2 sticky left-0 bg-bg-primary z-10">종목</th>
              <th className="text-right px-2 py-2">현재가</th>
              <th className="text-right px-2 py-2">FV_futures</th>
              <th className="text-left px-2 py-2">차익 · 진입선 도달률</th>
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
      <div className="px-3 py-1.5 text-[11px] text-t3 border-t border-bg-base">
        <span className="text-up">매수차</span> = ETF 저평가(갭 음수) → ETF 매수 + 선물 매도 ·{' '}
        <span className="text-down">매도차</span> = 고평가 → 반대. 도달률 = |갭| / 요구엣지,{' '}
        <span className="text-accent">100%↑ = 진입선 도달</span>. 기준가:{' '}
        <span className="text-accent">mid</span> = 호가 중간(fresh) · <span>last</span> = 체결가 폴백.
        행 클릭 → 요구엣지 분해.
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

/**
 * 차익 프레이밍 파생 — 서버 산출(§13.13) 우선, 구 Rust 스냅샷은 클라이언트 폴백.
 * gap<0=저평가(매수차), gap>0=고평가(매도차). 도달률 = |gap|/요구엣지.
 */
function arbFraming(row: QuoteRow) {
  const gapBp =
    row.gap_bp ??
    (row.price > 0 && row.fv_futures > 0
      ? ((row.price - row.fv_futures) / row.fv_futures) * 10000
      : null)
  const side: 'buy' | 'sell' | 'none' =
    row.arb_side ??
    (!row.usable || gapBp == null
      ? 'none'
      : gapBp < 0
        ? 'buy'
        : gapBp > 0
          ? 'sell'
          : 'none')
  const edge =
    row.arb_edge_bp ??
    (side === 'buy' ? row.edge_bid_bp : side === 'sell' ? row.edge_ask_bp : 0)
  const reach =
    row.reach_pct ?? (edge > 0 && gapBp != null ? (Math.abs(gapBp) / edge) * 100 : 0)
  const atEntry = row.at_entry ?? (side !== 'none' && reach >= 100)
  const source = row.price_source ?? 'last'
  return { gapBp, side, edge, reach, atEntry, source }
}

/** 방향별 색상 (매수차=저평가=up 초록 / 매도차=고평가=down 빨강). */
const SIDE_COLOR: Record<'buy' | 'sell' | 'none', string> = {
  buy: 'text-up',
  sell: 'text-down',
  none: 'text-t3',
}
const SIDE_BAR: Record<'buy' | 'sell' | 'none', string> = {
  buy: 'bg-up',
  sell: 'bg-down',
  none: 'bg-t4',
}
const SIDE_LABEL: Record<'buy' | 'sell' | 'none', string> = {
  buy: '매수차',
  sell: '매도차',
  none: '중립',
}

/** 차익 방향 + 진입선 도달률 게이지 셀 (갭 컬럼 확장 표현). */
function ArbCell({ row }: { row: QuoteRow }) {
  const { gapBp, side, edge, reach, atEntry } = arbFraming(row)
  if (gapBp == null || side === 'none') {
    return <span className="text-t4 text-[11px]">-</span>
  }
  const reachClamped = Math.min(Math.max(reach, 0), 100)
  // 고정폭 셀(col 190px)을 채움 — 자릿수·값 변동에도 폭 불변(w-full, min/max 제거).
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn('text-[12px] font-medium tabular-nums', SIDE_COLOR[side])}>
          {SIDE_LABEL[side]} {Math.abs(gapBp).toFixed(1)}bp
        </span>
        <span
          className={cn(
            'text-[11px] tabular-nums font-mono',
            atEntry ? 'text-accent font-medium' : 'text-t4',
          )}
        >
          {reach.toFixed(0)}%
        </span>
      </div>
      {/* 도달률 게이지 — 진입선(요구엣지)까지 얼마나 왔나. 100%=진입선. */}
      <div className="mt-1 h-1 w-full bg-bg-surface rounded-sm overflow-hidden relative">
        <div
          className={cn('h-full rounded-sm', atEntry ? 'bg-accent' : SIDE_BAR[side])}
          style={{ width: `${reachClamped}%` }}
        />
      </div>
      <div className="text-[11px] text-t3 mt-0.5 tabular-nums">
        진입선 {edge.toFixed(1)}bp
      </div>
    </div>
  )
}

/** mid/last 기준가 소스 배지. */
function SourceBadge({ source }: { source: 'mid' | 'last' | 'none' }) {
  if (source === 'none') return null
  return (
    <span
      className={cn(
        'inline-block px-1 py-0 text-[8px] leading-[13px] rounded-sm align-middle',
        source === 'mid' ? 'bg-accent/15 text-accent' : 'bg-bg-surface text-t4',
      )}
      title={
        source === 'mid'
          ? '호가 중간값(mid) 기준 — best_bid/ask fresh'
          : '체결가(last) 기준 — 호가 mid stale/결측'
      }
    >
      {source}
    </span>
  )
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
    const { side, atEntry, source } = arbFraming(row)

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
            'border-b border-white/[0.06] hover:bg-bg-surface/50 cursor-pointer',
            // 진입선 도달 행 subtle 하이라이트 (튀지 않게 — 방향색 6% + 좌측 얇은 라인).
            atEntry &&
              (side === 'buy'
                ? 'bg-up/[0.06] shadow-[inset_2px_0_0_0] shadow-up/60'
                : 'bg-down/[0.06] shadow-[inset_2px_0_0_0] shadow-down/60'),
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
                <div className="text-t3 text-[11px] truncate max-w-[130px] leading-tight">
                  {row.name}
                </div>
              </div>
            </div>
          </td>
          {/* 현재가 + 기준가 소스 배지 */}
          <td className="px-2 py-1.5 text-right tabular-nums text-t1 font-mono">
            <div className="flex items-center justify-end gap-1">
              <span>{fmtPrice(row.price)}</span>
              <SourceBadge source={source} />
            </div>
          </td>
          {/* FV_futures */}
          <td className="px-2 py-1.5 text-right tabular-nums text-t2 font-mono">
            {fmtPrice(row.fv_futures)}
          </td>
          {/* 차익 · 진입선 도달률 (갭 확장 표현) */}
          <td className="px-2 py-1.5">
            <ArbCell row={row} />
          </td>
          {/* 제안 매수 */}
          <td className="px-2 py-1.5 text-right font-mono">
            {row.usable && row.suggested_bid > 0 ? (
              <>
                <span className="text-t1 tabular-nums">{fmtPrice(row.suggested_bid)}</span>
                <span className="text-t3 text-[10px] tabular-nums ml-1">
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
                <span className="text-t3 text-[10px] tabular-nums ml-1">
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
    a.row.no_quote_reason === b.row.no_quote_reason &&
    // §13.13 MID·차익 프레이밍 필드 — 바뀌면 리렌더.
    a.row.ref_price === b.row.ref_price &&
    a.row.price_source === b.row.price_source &&
    a.row.gap_bp === b.row.gap_bp &&
    a.row.reach_pct === b.row.reach_pct &&
    a.row.arb_side === b.row.arb_side &&
    a.row.at_entry === b.row.at_entry,
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
  const { gapBp, side, edge, reach, source } = arbFraming(row)
  const midStr =
    row.best_bid != null && row.best_ask != null && row.best_bid > 0 && row.best_ask > 0
      ? `${fmtPrice(row.best_bid)} / ${fmtPrice(row.best_ask)}`
      : '-'
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
      {/* 차익 프레이밍 */}
      <div>
        <div className="text-[10px] text-t4 mb-1">차익 프레이밍</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums font-mono">
          <span className="text-t4">방향</span>
          <span className={cn('text-right', SIDE_COLOR[side])}>{SIDE_LABEL[side]}</span>
          <span className="text-t4">갭 (bp)</span>
          <span className="text-t2 text-right">
            {gapBp == null ? '-' : `${gapBp > 0 ? '+' : ''}${gapBp.toFixed(2)}`}
          </span>
          <span className="text-t4">요구엣지 (bp)</span>
          <span className="text-t2 text-right">{edge > 0 ? edge.toFixed(2) : '-'}</span>
          <span className="text-t4">도달률</span>
          <span className="text-t2 text-right">{reach.toFixed(0)}%</span>
        </div>
      </div>

      {/* 요구엣지 분해 */}
      <div>
        <div className="text-[10px] text-t4 mb-1">요구엣지 분해 (bp)</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <BpChip label="기본" value={c.base} />
          <BpChip label="버퍼" value={c.buffer} />
          <BpChip label="잔차" value={c.residual} />
          <BpChip label="skew" value={c.skew} color="text-blue" />
          <BpChip label="헤지비용" value={c.hedge_cost} color="text-t3" />
        </div>
        <div className="text-[10px] text-t4 mt-1">
          매수엣지 {row.edge_bid_bp.toFixed(1)} / 매도엣지 {row.edge_ask_bp.toFixed(1)} bp
          (= 기본+버퍼+잔차 ∓ skew). 헤지비용은 가격 미반영·수익성 판단용.
        </div>
      </div>

      {/* FV 입력 + 호가 */}
      <div>
        <div className="text-[10px] text-t4 mb-1">FV_futures 입력 · 호가</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] tabular-nums font-mono">
          <span className="text-t4">기준가 ({source})</span>
          <span className="text-t2 text-right">
            {row.ref_price != null && row.ref_price > 0 ? fmtPrice(row.ref_price) : '-'}
          </span>
          <span className="text-t4">최우선 매수/매도</span>
          <span className="text-t2 text-right">{midStr}</span>
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
