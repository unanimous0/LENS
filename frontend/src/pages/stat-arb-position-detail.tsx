import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ResidualHistogram, SpreadChart, ZScoreChart } from '@/components/stat-arb/charts'
import { PositionCloseModal } from '@/components/stat-arb/position-close-modal'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import {
  LABEL_META,
  deriveLabel,
  estimateLoanPnL,
  holdDays,
  regressionPct,
} from '@/lib/position-labels'
import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import { useMarketStore } from '@/stores/marketStore'
import type { Position } from '@/types/positions'
import type { PairDetail } from '@/types/stat-arb'

/** 일봉 spread_series mean/std (PR15b 와 동일 로직) */
function spreadStats(series: { spread: number }[]): { mean: number; std: number } {
  const n = series.length
  if (n < 2) return { mean: 0, std: 0 }
  let sum = 0
  for (const p of series) sum += p.spread
  const mean = sum / n
  let sq = 0
  for (const p of series) {
    const d = p.spread - mean
    sq += d * d
  }
  return { mean, std: Math.sqrt(sq / (n - 1)) }
}

export function StatArbPositionDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [position, setPosition] = useState<Position | null>(null)
  const [detail, setDetail] = useState<PairDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingNote, setSavingNote] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('')
  const [closeModalOpen, setCloseModalOpen] = useState(false)

  // 포지션 + 페어 상세 병렬 로딩
  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    fetch(`/api/positions/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`position HTTP ${r.status}`)
        return r.json() as Promise<Position>
      })
      .then((pos) => {
        setPosition(pos)
        setNoteDraft(pos.note ?? '')
        setLabelDraft(pos.label ?? '')
        const params = new URLSearchParams({ left: pos.left_key, right: pos.right_key })
        return fetch(`/api/stat-arb/pairs/detail?${params}`).then(async (r) => {
          if (!r.ok) throw new Error(`detail HTTP ${r.status}`)
          return r.json() as Promise<PairDetail>
        })
      })
      .then((d) => setDetail(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [id])

  // 양쪽 leg 실시간 구독
  const leftCode = position ? keyToCode(position.left_key) : ''
  const rightCode = position ? keyToCode(position.right_key) : ''
  const leftType = position ? keyType(position.left_key) : 'unknown'
  const rightType = position ? keyType(position.right_key) : 'unknown'
  const subCodes = useMemo(() => [leftCode, rightCode].filter(Boolean), [leftCode, rightCode])
  usePageStockSubscriptions(subCodes)
  // ETF는 etfTicks에서 lookup (realtime이 t1102 시점부터 EtfTick으로 분기 emit).
  const leftTick = useMarketStore((s) =>
    leftType === 'E' ? s.etfTicks[leftCode] : s.stockTicks[leftCode]
  )
  const rightTick = useMarketStore((s) =>
    rightType === 'E' ? s.etfTicks[rightCode] : s.stockTicks[rightCode]
  )

  if (loading) return <div className="p-4 text-sm text-t3">로딩 중…</div>
  if (error || !position || !detail) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Link to="/stat-arb/positions" className="text-xs text-accent hover:underline">
          ← 포지션 리스트
        </Link>
        <div className="text-sm text-down">로딩 실패: {error ?? 'unknown'}</div>
      </div>
    )
  }

  const stat1d = detail.timeframes.find((t) => t.timeframe === '1d')
  const entry = position.entry_stats ?? {}

  // 실시간 spread/z
  const leftPrice = leftTick?.price ?? 0
  const rightPrice = rightTick?.price ?? 0
  const hasLive = leftPrice > 0 && rightPrice > 0 && stat1d != null
  const { mean: spMean, std: spStd } = spreadStats(detail.spread_series)
  const liveSpread = hasLive
    ? rightPrice - stat1d!.alpha - stat1d!.hedge_ratio * leftPrice
    : null
  const liveZ = hasLive && spStd > 0 ? (liveSpread! - spMean) / spStd : null

  // DB 마지막 점 (실시간 없을 때 fallback)
  const dbLast = detail.spread_series.length
    ? detail.spread_series[detail.spread_series.length - 1]
    : null
  const currentZ = liveZ ?? dbLast?.z ?? null
  const currentSpread = liveSpread ?? dbLast?.spread ?? 0

  // Leg 매칭
  const legs = position.legs ?? []
  const leftLeg = legs.find((l) => l.code === leftCode)
  const rightLeg = legs.find((l) => l.code === rightCode)

  // 진입 시점 spread (양쪽 진입가 + 진입 시점 freeze α, β)
  const entryAlpha = entry.alpha ?? stat1d?.alpha ?? 0
  const entryBeta = entry.beta ?? stat1d?.hedge_ratio ?? 0
  const entrySpread =
    leftLeg && rightLeg
      ? rightLeg.entry_price - entryAlpha - entryBeta * leftLeg.entry_price
      : null

  // 정밀 평가손익 — 청산되면 exit_price 우선, 아니면 실시간 가격
  const isClosed = position.status === 'closed'
  const leftMarkPrice = leftLeg?.exit_price ?? leftPrice
  const rightMarkPrice = rightLeg?.exit_price ?? rightPrice
  const leftPnL =
    leftLeg && leftMarkPrice > 0
      ? (leftMarkPrice - leftLeg.entry_price) * leftLeg.side * leftLeg.qty
      : null
  const rightPnL =
    rightLeg && rightMarkPrice > 0
      ? (rightMarkPrice - rightLeg.entry_price) * rightLeg.side * rightLeg.qty
      : null
  const markPnL = leftPnL != null && rightPnL != null ? leftPnL + rightPnL : null
  const loanPnL = estimateLoanPnL(position)
  const totalPnL = (markPnL ?? 0) + loanPnL

  // 자동 라벨 — closed는 라벨 안 보여줌 (별도 "청산" 뱃지가 명확)
  const halfLife = entry.half_life ?? stat1d?.half_life ?? null
  const label = !isClosed ? deriveLabel(position, currentZ, halfLife) : null
  const labelMeta = label ? LABEL_META[label] : null
  const regress = regressionPct(position.entry_z, currentZ)
  const days = holdDays(position.opened_at)

  // 예상 청산 도달일 — half-life × log2(|currentZ|/0.3). closed면 의미 없음.
  let projectedExitDays: number | null = null
  if (
    !isClosed &&
    halfLife &&
    halfLife > 0 &&
    currentZ != null &&
    Math.abs(currentZ) > 0.3
  ) {
    projectedExitDays = halfLife * (Math.log(Math.abs(currentZ) / 0.3) / Math.log(2))
  }

  const saveNote = async () => {
    setSavingNote(true)
    try {
      const r = await fetch(`/api/positions/${position.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteDraft, label: labelDraft || null }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const updated = (await r.json()) as Position
      setPosition(updated)
    } catch (e) {
      alert(`저장 실패: ${e}`)
    } finally {
      setSavingNote(false)
    }
  }

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 헤더 */}
      <div className="panel flex items-center gap-3 p-3">
        <Link to="/stat-arb/positions" className="text-xs text-accent hover:underline">
          ← 포지션 리스트
        </Link>
        <div className="flex flex-1 items-center gap-2">
          <span className="text-sm font-medium text-t1">
            {detail.left_name} ↔ {detail.right_name}
          </span>
          {labelMeta && (
            <span className={`rounded-sm px-2 py-0.5 text-[10px] ${labelMeta.cls}`}>
              {labelMeta.ko}
            </span>
          )}
          {isClosed && (
            <span className="rounded-sm bg-t4/15 px-2 py-0.5 text-[10px] text-t3">청산</span>
          )}
          <span className="text-[10px] text-t4">
            {new Date(position.opened_at).toLocaleString('ko-KR')} 진입 · {days}d 보유
            {isClosed && position.closed_at && (
              <> · {new Date(position.closed_at).toLocaleString('ko-KR')} 청산</>
            )}
          </span>
        </div>
        {!isClosed && (
          <button
            type="button"
            onClick={() => setCloseModalOpen(true)}
            className="rounded-sm bg-down/20 px-3 py-1 text-xs text-down hover:bg-down/30"
          >
            청산 기록
          </button>
        )}
        <span className={`text-sm font-semibold tabular-nums ${pnlCls(totalPnL)}`}>
          {fmtPnL(totalPnL)}
        </span>
      </div>

      {/* KPI 카드 */}
      <div className="panel grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
        <Kpi
          label="진입 z → 현재 z"
          value={
            position.entry_z != null && currentZ != null
              ? `${position.entry_z.toFixed(2)} → ${currentZ.toFixed(2)}`
              : '—'
          }
        />
        <Kpi label="회귀" value={regress != null ? `${regress.toFixed(0)}%` : '—'} />
        <Kpi
          label={isClosed ? '확정 보유' : '예상 청산'}
          value={
            isClosed
              ? `${days}d`
              : projectedExitDays != null
              ? `${projectedExitDays.toFixed(1)}d 후`
              : Math.abs(currentZ ?? 0) <= 0.3
              ? '도달 (|z|<0.3)'
              : '—'
          }
        />
        <Kpi label="평가 + 대여" value={`${fmtPnL(markPnL)} + ${fmtPnL(loanPnL)}`} />
      </div>

      {/* 차트 3개 */}
      <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
        <div className="panel p-3">
          <div className="mb-2 text-xs text-t3">
            스프레드 시계열 · 진입 {entrySpread != null ? Math.round(entrySpread).toLocaleString() : '—'}{' '}
            → 현재 {Math.round(currentSpread).toLocaleString()}
          </div>
          <div className="h-[260px]">
            <SpreadChart
              data={detail.spread_series}
              entry={
                entrySpread != null
                  ? { ts: position.opened_at, spread: entrySpread }
                  : null
              }
            />
          </div>
        </div>
        <div className="panel p-3">
          <div className="mb-2 text-xs text-t3">
            z-score · 진입 {position.entry_z?.toFixed(2) ?? '—'} → 현재{' '}
            {currentZ?.toFixed(2) ?? '—'}
          </div>
          <div className="h-[260px]">
            <ZScoreChart
              data={detail.spread_series}
              entry={
                position.entry_z != null
                  ? { ts: position.opened_at, z: position.entry_z }
                  : null
              }
            />
          </div>
        </div>
        <div className="panel p-3 lg:col-span-2">
          <div className="mb-2 text-xs text-t3">잔차 분포 · 현재 위치 빨강</div>
          <div className="h-[200px]">
            <ResidualHistogram bins={detail.histogram} currentSpread={currentSpread} />
          </div>
        </div>
      </div>

      {/* Leg 테이블 + 통계 변화 */}
      <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
        {/* Leg 테이블 */}
        <div className="panel p-3">
          <div className="mb-2 text-xs text-t3">Leg</div>
          <table className="w-full text-xs tabular-nums">
            <thead className="text-t3">
              <tr>
                <th className="text-left font-normal">종목</th>
                <th className="text-right font-normal">방향</th>
                <th className="text-right font-normal">수량</th>
                <th className="text-right font-normal">진입가</th>
                <th className="text-right font-normal">현재가</th>
                <th className="text-right font-normal">PnL</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => {
                const tick = l.code === leftCode ? leftTick : rightTick
                const livePrice = tick?.price ?? 0
                // 청산되어 exit_price 있으면 확정값, 아니면 실시간
                const price = l.exit_price ?? livePrice
                const isFixed = l.exit_price != null
                const pnl =
                  price > 0 ? (price - l.entry_price) * l.side * l.qty : null
                const chg = price > 0 ? ((price - l.entry_price) / l.entry_price) * 100 : null
                return (
                  <tr key={l.id} className="border-t border-bg-surface/40">
                    <td className="py-1 text-t1">
                      {l.code}{' '}
                      <span className="text-[10px] text-t4">
                        [{l.asset_type}]
                      </span>
                    </td>
                    <td className={`py-1 text-right ${l.side > 0 ? 'text-up' : 'text-down'}`}>
                      {l.side > 0 ? '매수' : '매도'}
                    </td>
                    <td className="py-1 text-right text-t2">{l.qty.toLocaleString()}</td>
                    <td className="py-1 text-right text-t2">{l.entry_price.toLocaleString()}</td>
                    <td className="py-1 text-right text-t1">
                      {price > 0 ? price.toLocaleString() : '—'}
                      {isFixed && <span className="ml-1 text-[10px] text-t4">청산</span>}
                      {chg != null && (
                        <span
                          className={`ml-1 text-[10px] ${
                            chg > 0 ? 'text-up' : chg < 0 ? 'text-down' : 'text-t3'
                          }`}
                        >
                          ({chg > 0 ? '+' : ''}
                          {chg.toFixed(1)}%)
                        </span>
                      )}
                    </td>
                    <td className={`py-1 text-right ${pnlCls(pnl)}`}>{fmtPnL(pnl)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {position.loans && position.loans.length > 0 && (
            <div className="mt-2 border-t border-bg-surface/40 pt-2 text-[10px] text-t3">
              대여 송출:{' '}
              {position.loans
                .map((ln) => {
                  const leg = legs.find((l) => l.id === ln.leg_id)
                  return `${leg?.code ?? '?'} ${ln.qty.toLocaleString()}주 @ ${ln.rate_pct}%`
                })
                .join(', ')}
            </div>
          )}
        </div>

        {/* 통계 변화 */}
        <div className="panel p-3">
          <div className="mb-2 text-xs text-t3">통계량 변화 (진입 freeze vs 현재 1d)</div>
          <table className="w-full text-xs tabular-nums">
            <thead className="text-t3">
              <tr>
                <th className="text-left font-normal">지표</th>
                <th className="text-right font-normal">진입</th>
                <th className="text-right font-normal">현재</th>
                <th className="text-right font-normal">Δ</th>
              </tr>
            </thead>
            <tbody>
              <StatRow
                label="hedge ratio β"
                entry={entry.beta}
                current={stat1d?.hedge_ratio}
                fmt={(v) => v.toFixed(4)}
              />
              <StatRow
                label="α"
                entry={entry.alpha}
                current={stat1d?.alpha}
                fmt={(v) => v.toFixed(1)}
              />
              <StatRow
                label="half-life (d)"
                entry={entry.half_life}
                current={stat1d?.half_life}
                fmt={(v) => v.toFixed(2)}
              />
              <StatRow
                label="ADF t-stat"
                entry={entry.adf}
                current={stat1d?.adf_tstat}
                fmt={(v) => v.toFixed(2)}
              />
              <StatRow
                label="R²"
                entry={entry.r2}
                current={stat1d?.r_squared}
                fmt={(v) => v.toFixed(3)}
              />
            </tbody>
          </table>
        </div>
      </div>

      {/* 노트 + 라벨 편집 */}
      <div className="panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-t3">메모 / 라벨</span>
          <button
            type="button"
            onClick={saveNote}
            disabled={savingNote}
            className="rounded-sm bg-accent/20 px-3 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {savingNote ? '저장 중…' : '저장'}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs lg:col-span-1">
            <span className="text-t3">라벨</span>
            <input
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder="예: 반도체 페어 1차"
              className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs lg:col-span-2">
            <span className="text-t3">메모</span>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={2}
              placeholder="진입 근거, 청산 계획 등"
              className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t4 focus:outline-none"
            />
          </label>
        </div>
      </div>

      {/* 청산 모달 */}
      <PositionCloseModal
        open={closeModalOpen}
        onClose={() => setCloseModalOpen(false)}
        position={position}
        livePriceByLegId={Object.fromEntries(
          legs.map((l) => [l.id, l.code === leftCode ? leftPrice : rightPrice])
        )}
        onClosed={(updated) => setPosition(updated)}
      />
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm bg-bg-surface px-3 py-2">
      <div className="text-[10px] text-t3">{label}</div>
      <div className="text-base font-semibold tabular-nums text-t1">{value}</div>
    </div>
  )
}

function StatRow({
  label,
  entry,
  current,
  fmt,
}: {
  label: string
  entry: number | undefined | null
  current: number | undefined | null
  fmt: (v: number) => string
}) {
  const delta = entry != null && current != null ? current - entry : null
  const deltaCls = delta == null ? 'text-t4' : Math.abs(delta) > 0 ? 'text-warning' : 'text-t3'
  return (
    <tr className="border-t border-bg-surface/40">
      <td className="py-1 text-t3">{label}</td>
      <td className="py-1 text-right text-t2">{entry != null ? fmt(entry) : '—'}</td>
      <td className="py-1 text-right text-t1">{current != null ? fmt(current) : '—'}</td>
      <td className={`py-1 text-right ${deltaCls}`}>{delta != null ? fmt(delta) : '—'}</td>
    </tr>
  )
}

function pnlCls(v: number | null): string {
  if (v == null) return 'text-t4'
  if (v > 0) return 'text-up'
  if (v < 0) return 'text-down'
  return 'text-t3'
}

function fmtPnL(v: number | null): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}`
}
