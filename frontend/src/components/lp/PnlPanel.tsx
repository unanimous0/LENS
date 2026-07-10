import { useLpStore } from '@/stores/lpStore'
import type { LimitGauge, PnlDecompSnapshot } from '@/types/lp'
import { cn } from '@/lib/utils'

/**
 * P&L 5분해 패널 (§13.3-C Phase 4 PR-E) — 4대 숫자 #4의 상세.
 *
 * 리스크 한도 게이지 4개(상단) + 5분해 막대(스프레드/베이시스/잔차·방향/캐리/헤지) +
 * markout 역선택 통계 + 미귀속·caveats 정직 표기. Rust 1초 주기 pnl_decomp WS 구독.
 * 배치: BasisBookPanel 아래.
 *
 * 완전 분해 항등: total_mtm = 스프레드 + 베이시스(종목) + 잔차·방향 + 캐리 + 헤지비용.
 */

/** 원화 축약 (부호 有). */
function fmtKrw(krw: number): string {
  const abs = Math.abs(krw)
  const sign = krw > 0 ? '+' : krw < 0 ? '−' : ''
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}만`
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`
}

/** 부호 없는 크기 (억/만). */
function fmtSize(krw: number): string {
  const abs = Math.abs(krw)
  if (abs >= 1e8) return `${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(1)}만`
  return Math.round(abs).toLocaleString('ko-KR')
}

const signClass = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3')

/** 5분해 항목 정의 — hint는 산식 근거. */
const COMPONENTS: Array<{ key: keyof PnlDecompSnapshot; label: string; hint: string }> = [
  { key: 'spread', label: '스프레드', hint: 'Σ (FV − 체결가) × 방향' },
  { key: 'basis_stock', label: '베이시스(종목)', hint: '종목 수렴손익 합' },
  { key: 'residual_directional', label: '잔차 · 방향', hint: '총 − 나머지 (역산)' },
  { key: 'carry', label: '캐리', hint: '−r × Σ|노출| × 경과일/365' },
  { key: 'hedge_cost', label: '헤지 비용', hint: '−선물 fill 명목 × fee' },
]

export function PnlPanel() {
  const pnl = useLpStore((s) => s.pnlDecomp)

  return (
    <div className="bg-bg-primary">
      <div className="px-3 py-2 border-b border-bg-base flex items-center justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">손익 분해 · 리스크 한도 (§13.3-C)</div>
          <div className="text-[11px] text-t2">당일 세션(전일 종가 대비) P&amp;L 5분해 + markout + 한도 4개</div>
        </div>
        {pnl && (
          <span className={cn('text-[15px] font-mono tabular-nums', signClass(pnl.total_mtm))}>
            {fmtKrw(pnl.total_mtm)}
          </span>
        )}
      </div>

      {!pnl ? (
        <div className="px-3 py-4 text-xs text-t4">대기 중...</div>
      ) : (
        <>
          {/* ── 리스크 한도 게이지 4개 ── */}
          <div className="px-3 py-2.5 border-b border-bg-base grid grid-cols-2 md:grid-cols-4 gap-3">
            {pnl.limits.map((g) => (
              <Gauge key={g.name} g={g} />
            ))}
          </div>

          {/* ── 5분해 막대 ── */}
          <div className="px-3 py-2.5 border-b border-bg-base">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-[11px] text-t3 uppercase tracking-wide">당일 P&amp;L 분해</span>
              <span className={cn('text-[13px] font-mono tabular-nums', signClass(pnl.total_mtm))}>
                총 {fmtKrw(pnl.total_mtm)}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {COMPONENTS.map((c) => (
                <DecompRow
                  key={c.key}
                  label={c.label}
                  hint={c.hint}
                  value={pnl[c.key] as number}
                  total={pnl.total_mtm}
                />
              ))}
            </div>
            {/* 지수 베이시스 산출 불가 상태 (정직) */}
            <div className="text-[11px] text-t3 mt-2">지수 베이시스: {pnl.basis_index_status}</div>
          </div>

          {/* ── markout + 미귀속 ── */}
          <div className="px-3 py-2.5 border-b border-bg-base grid grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] text-t3 uppercase tracking-wide mb-1">
                markout (역선택)
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Markout label="5분" n={pnl.markout.n_5m} bp={pnl.markout.avg_5m_bp} />
                <Markout label="30분" n={pnl.markout.n_30m} bp={pnl.markout.avg_30m_bp} />
              </div>
              <div className="text-[10px] text-t3 mt-1">음수 = 역선택 (준 유동성 방향으로 불리)</div>
            </div>
            <div>
              <div className="text-[11px] text-t3 uppercase tracking-wide mb-1">스프레드 미귀속</div>
              <div className="text-[13px] font-mono tabular-nums text-t2">
                {pnl.unattributed.n}건
                <span className="text-t4 text-[11px] ml-2">
                  명목 {pnl.unattributed.n > 0 ? fmtSize(pnl.unattributed.notional_krw) : '-'}
                </span>
              </div>
              <div className="text-[10px] text-t3 mt-1">fv_at_fill 없음 (비ETF·수동 기장) → 잔차 흡수</div>
            </div>
          </div>

          {/* ── caveats ── */}
          {pnl.caveats.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[11px] text-t2 leading-relaxed">
                {pnl.caveats.map((c, i) => (
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

/** 리스크 한도 게이지 바 — 80%↑ warning, 100%↑ down. */
function Gauge({ g }: { g: LimitGauge }) {
  const pct = g.limit > 0 ? Math.min(g.ratio, 1) * 100 : 0
  const over = g.ratio >= 1
  const warn = g.ratio >= 0.8
  const barColor = over ? 'var(--color-down)' : warn ? 'var(--color-warning)' : 'var(--color-accent)'
  const ratioColor = over ? 'text-down' : warn ? 'text-warning' : 'text-t2'
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] text-t3 truncate">{g.name}</span>
        <span className={cn('text-[11px] font-mono tabular-nums', ratioColor)}>
          {g.limit > 0 ? `${(g.ratio * 100).toFixed(0)}%` : '—'}
        </span>
      </div>
      <div className="h-1.5 bg-bg-base mt-1 rounded-sm overflow-hidden">
        <div className="h-full rounded-sm" style={{ width: `${pct}%`, backgroundColor: barColor }} />
      </div>
      <div className="flex items-baseline justify-between mt-0.5">
        <span className="text-[10px] text-t4 font-mono tabular-nums">
          {fmtSize(g.current)} / {g.limit > 0 ? fmtSize(g.limit) : '∞'}
        </span>
        {g.detail && <span className="text-[10px] text-t4 truncate ml-1">{g.detail}</span>}
      </div>
    </div>
  )
}

/** 5분해 한 항목 — 라벨 + 값 + 총액 대비 방향 막대. */
function DecompRow({
  label,
  hint,
  value,
  total,
}: {
  label: string
  hint: string
  value: number
  total: number
}) {
  // 막대 폭: 항목 절대값 / 항목 중 최대 절대값 기준이 아니라 총액 크기 대비 (직관적).
  const denom = Math.max(Math.abs(total), Math.abs(value), 1)
  const pct = Math.min((Math.abs(value) / denom) * 100, 100)
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 shrink-0">
        <div className="text-[11px] text-t2">{label}</div>
        <div className="text-[10px] text-t3 leading-tight">{hint}</div>
      </div>
      <div className="flex-1 h-2 bg-bg-base rounded-sm overflow-hidden">
        <div
          className="h-full rounded-sm"
          style={{
            width: `${pct}%`,
            backgroundColor: value >= 0 ? 'var(--color-up)' : 'var(--color-down)',
          }}
        />
      </div>
      <span className={cn('w-20 text-right text-[13px] font-medium font-mono tabular-nums', signClass(value))}>
        {fmtKrw(value)}
      </span>
    </div>
  )
}

function Markout({ label, n, bp }: { label: string; n: number; bp: number }) {
  const has = n > 0
  return (
    <div className="bg-bg-base/40 px-2 py-1.5 rounded-sm">
      <div className="text-[10px] text-t4">{label} ({n}건)</div>
      <div className={cn('text-[14px] font-mono tabular-nums', has ? signClass(bp) : 'text-t4')}>
        {has ? `${bp >= 0 ? '+' : '−'}${Math.abs(bp).toFixed(1)}bp` : '—'}
      </div>
    </div>
  )
}
