import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { PositionEditModal } from '@/components/stat-arb/position-edit-modal'
import { keyToCode } from '@/lib/stat-arb-keys'
import { liveZ } from '@/lib/stat-arb/alerts'
import {
  BAND_SHIFT_TOOLTIP,
  BAND_SOURCE_MARK,
  BAND_SOURCE_NOTE,
  NO_BAND_REASON,
  entryZNotice,
  frozenBand,
  frozenZ,
  isBandShiftWarn,
} from '@/lib/stat-arb/frozen-z'
import { fetchQuotes } from '@/lib/stat-arb/live-quote'
import {
  LABEL_META,
  deriveLabel,
  estimateLoanPnL,
  estimateMarkPnL,
  holdDays,
  markPnLFromPrices,
  regressionPct,
} from '@/lib/position-labels'
import type { Position, PositionListResp } from '@/types/positions'
import type { PairRow } from '@/types/stat-arb'

/** 페어 매칭 키: left_key|right_key */
function pairKey(left: string, right: string): string {
  return `${left}|${right}`
}

/** 현재가 갱신 주기 — /realtime/quote 1콜(t8407, 20초 캐시). 포지션은 많아야 수십 건. */
const QUOTE_POLL_MS = 30_000

const NO_PRICE_REASON = '현재가 없음 — 장 시작 전·거래정지 또는 지수/선물 leg'

export function StatArbPositionsPage() {
  const navigate = useNavigate()
  const [positions, setPositions] = useState<Position[]>([])
  const [pairMap, setPairMap] = useState<Map<string, PairRow>>(new Map())
  const [statusFilter, setStatusFilter] = useState<'open' | 'closed' | 'all'>('open')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [priceByCode, setPriceByCode] = useState<Record<string, number>>({})
  const [pricedAt, setPricedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<Position | null>(null)
  // 수정 저장 후 서버의 entry_z 처리 결과 (재계산/무시) 안내 — 다음 수정까지 남긴다.
  const [notice, setNotice] = useState<string | null>(null)

  // 포지션 + 페어 통계 병렬 로딩
  useEffect(() => {
    setLoading(true)
    setError(null)
    const posUrl = statusFilter === 'all' ? '/api/positions' : `/api/positions?status=${statusFilter}`
    Promise.all([
      fetch(posUrl).then(async (r) => {
        if (!r.ok) throw new Error(`positions HTTP ${r.status}`)
        return r.json() as Promise<PositionListResp>
      }),
      // limit 전체 — ETF 유니버스 확대(100→304)로 페어가 3.8천→1.1만이 되면서 상위 500만
      // 받으면 저장 포지션 페어가 모집단 밖으로 밀려 z·평가손익이 비었다. 전량 조회로 조인 보장.
      fetch('/api/stat-arb/pairs?limit=50000&basis=all').then(async (r) => {
        if (!r.ok) throw new Error(`pairs HTTP ${r.status}`)
        return r.json() as Promise<{ pairs: PairRow[] }>
      }),
    ])
      .then(([posResp, pairResp]) => {
        // 상세까지 한 번에 fetch — 평가손익 계산에 legs/loans 필요
        return Promise.all(
          posResp.items.map((p) =>
            fetch(`/api/positions/${p.id}`)
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          )
        ).then((details) => {
          const items = details.filter(Boolean) as Position[]
          setPositions(items)
          const m = new Map<string, PairRow>()
          for (const pair of pairResp.pairs) m.set(pairKey(pair.left_key, pair.right_key), pair)
          setPairMap(m)
        })
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [statusFilter])

  // 고정 z·평가손익에 필요한 현재가. leg 코드는 t8407 대상(6자리 주식/ETF)만.
  // 미청산 leg만 조회 — 청산분은 exit_price가 확정값이라 현재가가 필요 없다.
  const quoteCodes = useMemo(() => {
    const set = new Set<string>()
    for (const pos of positions) {
      for (const leg of pos.legs ?? []) {
        if (leg.exit_price != null) continue
        if (leg.asset_type !== 'S' && leg.asset_type !== 'E') continue
        set.add(leg.code)
      }
    }
    return [...set].sort()
  }, [positions])

  useEffect(() => {
    if (quoteCodes.length === 0) {
      setPriceByCode({})
      setPricedAt(null)
      return
    }
    let alive = true
    const load = () => {
      // 숨은 탭에서 LS REST를 계속 두드리지 않는다 — 복귀 시 즉시 1콜로 따라잡는다.
      if (document.visibilityState === 'hidden') return
      fetchQuotes(quoteCodes)
        .then((quotes) => {
          if (!alive) return
          const next: Record<string, number> = {}
          for (const [code, q] of Object.entries(quotes)) {
            // 당일 무거래(stale)면 price가 전일 종가 이월값 — 그래도 마지막 유효가로 쓴다.
            const p = q.price > 0 ? q.price : q.prev_close
            if (p > 0) next[code] = p
          }
          setPriceByCode(next)
          setPricedAt(Date.now())
        })
        .catch(() => {
          /* 현재가 실패는 화면 전체를 막지 않음 — 고정 z만 '—'로 떨어진다 */
        })
    }
    load()
    const timer = window.setInterval(load, QUOTE_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [quoteCodes])

  const rows = useMemo(() => {
    return positions.map((pos) => {
      const pair = pairMap.get(pairKey(pos.left_key, pos.right_key)) ?? null
      // 저장 밴드 우선, 구 기록은 진입 z에서 σ₀ 역산 (source로 구분해 화면에 표기).
      const band = frozenBand(pos)

      // 양쪽 leg 가격 — 청산된 leg는 확정 exit_price, 아니면 현재가 스냅샷.
      const leftCode = keyToCode(pos.left_key)
      const rightCode = keyToCode(pos.right_key)
      const legPrice = (code: string): number => {
        const leg = pos.legs?.find((l) => l.code === code)
        return leg?.exit_price ?? priceByCode[code] ?? 0
      }
      const leftPrice = legPrice(leftCode)
      const rightPrice = legPrice(rightCode)
      const hasPrices = leftPrice > 0 && rightPrice > 0

      // ① 고정 z — 진입 밴드(α₀·β₀·μ₀·σ₀) + 현재가. 청산 판단은 이 자로 한다.
      const frozen = frozenZ(band, leftPrice, rightPrice)
      const frozenReason = band == null ? NO_BAND_REASON : hasPrices ? null : NO_PRICE_REASON
      // ② 오늘 z — 엔진의 롤링 밴드 + *같은 현재가*. 가격 없으면 발굴 사이클 z(전일 종가).
      const todayLive = hasPrices ? liveZ(pair ?? undefined, leftPrice, rightPrice) : null
      const todayZ = todayLive ?? pair?.z_score ?? null
      // 두 z를 같은 가격으로 재놓았으므로 차이는 온전히 밴드 이동분.
      // 단 진입 스냅샷이 10분 자면 목록 z(일봉)와 척도 자체가 달라 비교가 성립하지 않는다.
      const basisMismatch = band?.basis != null && band.basis !== '1d'
      const shift = frozen != null && todayLive != null ? frozen - todayLive : null
      const shiftWarn = isBandShiftWarn(shift, band)

      // 청산 판단·라벨·회귀는 고정 z 우선, 없으면(구 포지션) 롤링 z로 폴백.
      const judgeZ = frozen ?? todayZ
      const halfLife = numOrNull(pos.entry_stats?.half_life) ?? pair?.half_life ?? null
      const label = deriveLabel(pos, judgeZ, halfLife)
      const regress = regressionPct(pos.entry_z, judgeZ)
      const days = holdDays(pos.opened_at)
      const markPnL = markPnLFromPrices(pos, priceByCode) ?? estimateMarkPnL(pos, pair)
      const loanPnL = estimateLoanPnL(pos)
      const totalPnL = (markPnL ?? 0) + loanPnL
      return {
        pos,
        pair,
        band,
        frozen,
        frozenReason,
        todayZ,
        todayLive: todayLive != null,
        basisMismatch,
        shift,
        shiftWarn,
        judgeZ,
        label,
        regress,
        days,
        markPnL,
        loanPnL,
        totalPnL,
      }
    })
  }, [positions, pairMap, priceByCode])

  const activeRows = rows.filter((r) => r.pos.status === 'open')

  /** 수정 대상은 pairMap의 이름과 함께 넘긴다 (모달은 페어 상세를 따로 안 부른다). */
  const editingNames = editing
    ? pairMap.get(pairKey(editing.left_key, editing.right_key)) ?? null
    : null

  const remove = async (id: string) => {
    if (!confirm('이 포지션 기록을 삭제할까요? (CASCADE)')) return
    try {
      const r = await fetch(`/api/positions/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setPositions((prev) => prev.filter((p) => p.id !== id))
    } catch (e) {
      alert(`삭제 실패: ${e}`)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {/* 컨트롤 */}
      <div className="panel flex items-center gap-3 p-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-t3">상태</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'open' | 'closed' | 'all')}
            className="rounded-sm bg-bg-surface px-2 py-1 text-t1 focus:outline-none"
          >
            <option value="open">활성</option>
            <option value="closed">청산</option>
            <option value="all">전체</option>
          </select>
        </div>
        <span className="text-xs text-t3 tabular-nums">
          {loading ? '로딩…' : `${rows.length}건`}
        </span>
        {pricedAt != null && (
          <span className="text-[10px] text-t4 tabular-nums">
            현재가 {new Date(pricedAt).toLocaleTimeString('ko-KR')} 기준 (30초 갱신)
          </span>
        )}
        {error && <span className="text-xs text-down">{error}</span>}
        {notice && (
          <span className="ml-auto max-w-[60%] truncate text-[10px] text-warning" title={notice}>
            {notice}
          </span>
        )}
      </div>

      {/* z 산점도 — 활성 포지션만 */}
      {activeRows.length > 0 && (
        <div className="panel p-3">
          <div className="mb-2 text-xs text-t3">
            진입 z (x) ↔ 고정 z (y) — 대각선 위는 발산, 원점 근처는 청산권장 · 빈 점은 고정 z
            없어 오늘 z로 대체
          </div>
          <ZScatter rows={activeRows} />
        </div>
      )}

      {/* 리스트 */}
      <div className="panel overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-bg-primary">
            <tr className="border-b border-bg-surface text-left text-t3">
              <th className="px-3 py-2 font-normal">페어 (라벨)</th>
              <th className="px-3 py-2 font-normal">진입일</th>
              <th className="px-3 py-2 font-normal text-right">보유일</th>
              <th className="px-3 py-2 font-normal text-right">진입 z</th>
              <th
                className="px-3 py-2 font-normal text-right text-t2"
                title="진입 시점 α·β·μ·σ를 고정하고 현재가만 넣은 z. 손익과 1:1 — 청산 판단 기준."
              >
                고정 z
              </th>
              <th className="px-3 py-2 font-normal text-right" title="진입 z 대비 고정 z 축소율">
                회귀
              </th>
              <th
                className="px-3 py-2 font-normal text-right"
                title="엔진이 오늘 다시 추정한 밴드 기준 z (같은 현재가). 고정 z와 벌어지면 관계가 재추정된 것."
              >
                오늘 z
              </th>
              <th className="px-3 py-2 font-normal">상태</th>
              <th className="px-3 py-2 font-normal text-right">평가</th>
              <th className="px-3 py-2 font-normal text-right">대여</th>
              <th className="px-3 py-2 font-normal text-right">종합</th>
              <th className="px-3 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { pos, pair, band, frozen, frozenReason, todayZ, shift, shiftWarn } = row
              // 저장 밴드는 마커 없음, 재계산/역산만 표시 (§24.8).
              const bandMark = band ? BAND_SOURCE_MARK[band.source] : null
              const meta = LABEL_META[row.label]
              const leftName = pair?.left_name ?? keyToCode(pos.left_key)
              const rightName = pair?.right_name ?? keyToCode(pos.right_key)
              return (
                <tr
                  key={pos.id}
                  onClick={() => navigate(`/stat-arb/positions/${pos.id}`)}
                  className={`cursor-pointer border-b border-bg-surface/40 hover:bg-bg-surface/50 ${
                    shiftWarn ? 'bg-warning/[0.07]' : ''
                  }`}
                >
                  <td className="px-3 py-2">
                    <div className="text-t1">
                      {leftName} <span className="text-t3">↔</span> {rightName}
                    </div>
                    {pos.label && <div className="text-[10px] text-t4">{pos.label}</div>}
                  </td>
                  <td className="px-3 py-2 text-t2">
                    {new Date(pos.opened_at).toLocaleDateString('ko-KR', {
                      month: '2-digit',
                      day: '2-digit',
                    })}
                  </td>
                  <td className="px-3 py-2 text-right text-t2">{row.days}d</td>
                  <td className="px-3 py-2 text-right text-t2">
                    {pos.entry_z != null ? fmtZ(pos.entry_z) : '—'}
                  </td>
                  <td
                    className="px-3 py-2 text-right font-semibold text-t1"
                    title={frozenReason ?? (band ? BAND_SOURCE_NOTE[band.source] : undefined)}
                  >
                    {frozen != null ? fmtZ(frozen) : '—'}
                    {frozen != null && bandMark && (
                      <span className="ml-1 text-[9px] font-normal text-t4">{bandMark}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-t2">
                    {row.regress != null ? `${row.regress.toFixed(0)}%` : '—'}
                  </td>
                  <td
                    className={`px-3 py-2 text-right ${shiftWarn ? 'text-warning' : 'text-t3'}`}
                    title={
                      row.basisMismatch
                        ? `진입 스냅샷은 ${band?.basis} 자 — 일봉 기준 오늘 z와 척도가 달라 직접 비교 불가`
                        : shiftWarn
                        ? BAND_SHIFT_TOOLTIP
                        : row.todayLive
                        ? '엔진 롤링 밴드 + 현재가'
                        : '현재가 없음 — 발굴 사이클 z (전일 종가)'
                    }
                  >
                    {todayZ != null ? fmtZ(todayZ) : '—'}
                    {shiftWarn && shift != null && (
                      <span className="ml-1 text-[10px]">
                        (Δ{shift >= 0 ? '+' : ''}
                        {shift.toFixed(1)})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-sm px-2 py-0.5 text-[10px] ${meta.cls}`}>
                      {meta.ko}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right ${pnlCls(row.markPnL)}`}>
                    {fmtPnL(row.markPnL)}
                  </td>
                  <td className={`px-3 py-2 text-right ${pnlCls(row.loanPnL)}`}>
                    {fmtPnL(row.loanPnL)}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${pnlCls(row.totalPnL)}`}>
                    {fmtPnL(row.totalPnL)}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing(pos)
                      }}
                      className="text-[10px] text-t4 hover:text-accent"
                      title="진입일·수량·진입가 수정"
                    >
                      수정
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(pos.id)
                      }}
                      className="ml-2 text-[10px] text-t4 hover:text-down"
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && !loading && (
          <div className="p-4 text-xs text-t3">기록된 포지션 없음 — 페어 상세에서 진입 기록하세요.</div>
        )}
      </div>

      <div className="px-3 py-1 text-[10px] text-t4">
        ※ <span className="text-t3">고정 z</span> = 진입 시점 α·β·μ·σ에 현재가만 넣은 z (손익과
        1:1). <span className="text-t3">오늘 z</span> = 엔진이 다시 추정한 밴드 기준 — 둘의 차이는
        밴드 이동분(|Δ| ≥ 0.5σ면 행 강조). 밴드를 저장하지 않던 구 기록은 진입 z에서 σ₀를{' '}
        <span className="text-t3">역산</span>해 쓰고(μ₀=0 가정), 역산도 안 되면 고정 z가
        &apos;—&apos;이고 회귀·상태가 오늘 z로 계산된다 — <span className="text-t3">수정</span>에서
        진입일 기준으로 밴드를 <span className="text-t3">재계산</span>하면 제대로 된 자가 박힌다.
        평가손익은 현재가(청산분은 체결가) 기준 실계산, 현재가가 없을 때만 회귀비율 추정으로 폴백.
      </div>

      {/* 기록 수정 모달 — 저장 시 목록 행을 응답(상세)으로 교체해 즉시 갱신 */}
      {editing && (
        <PositionEditModal
          open
          onClose={() => setEditing(null)}
          position={editing}
          leftName={editingNames?.left_name}
          rightName={editingNames?.right_name}
          onSaved={(updated, zUpdate) => {
            setPositions((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
            setNotice(entryZNotice(zUpdate))
          }}
        />
      )}
    </div>
  )
}

function numOrNull(v: number | string | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function fmtZ(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
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

// ---------------------------------------------------------------------------
// z 산점도 SVG (recharts 안 가져옴 — 단순한 점/축/대각선/원점밴드)
// ---------------------------------------------------------------------------

const SCATTER_PAD = 28
const SCATTER_W = 480
const SCATTER_H = 280

type ScatterRow = {
  pos: Position
  /** y축 값 = 고정 z (없으면 오늘 z 폴백). */
  judgeZ: number | null
  /** 고정 z로 그린 점인지 — 폴백이면 빈 점으로 구분. */
  frozen: number | null
  label: string
}

function ZScatter({ rows }: { rows: ScatterRow[] }) {
  // x/y 범위 자동 — |z| max에서 + 0.5 마진 (최소 ±3)
  const zMax = Math.max(
    3,
    ...rows.flatMap((r) => [Math.abs(r.pos.entry_z ?? 0), Math.abs(r.judgeZ ?? 0)])
  )
  const range = Math.ceil(zMax * 2) / 2 + 0.5 // 0.5 단위 올림

  const innerW = SCATTER_W - SCATTER_PAD * 2
  const innerH = SCATTER_H - SCATTER_PAD * 2
  const xToPx = (z: number) => SCATTER_PAD + ((z + range) / (range * 2)) * innerW
  const yToPx = (z: number) => SCATTER_PAD + innerH - ((z + range) / (range * 2)) * innerH

  const gridZs = [-2, -1, 0, 1, 2].filter((z) => Math.abs(z) <= range)

  return (
    <svg
      viewBox={`0 0 ${SCATTER_W} ${SCATTER_H}`}
      className="w-full"
      style={{ maxHeight: SCATTER_H }}
    >
      {/* 그리드 */}
      {gridZs.map((z) => (
        <g key={`x-${z}`}>
          <line
            x1={xToPx(z)}
            y1={SCATTER_PAD}
            x2={xToPx(z)}
            y2={SCATTER_H - SCATTER_PAD}
            stroke="#2a2a2c"
            strokeWidth={z === 0 ? 1 : 0.5}
          />
          <text
            x={xToPx(z)}
            y={SCATTER_H - SCATTER_PAD + 14}
            fontSize={9}
            fill="#8e8e93"
            textAnchor="middle"
          >
            {z}
          </text>
        </g>
      ))}
      {gridZs.map((z) => (
        <g key={`y-${z}`}>
          <line
            x1={SCATTER_PAD}
            y1={yToPx(z)}
            x2={SCATTER_W - SCATTER_PAD}
            y2={yToPx(z)}
            stroke="#2a2a2c"
            strokeWidth={z === 0 ? 1 : 0.5}
          />
          <text
            x={SCATTER_PAD - 6}
            y={yToPx(z) + 3}
            fontSize={9}
            fill="#8e8e93"
            textAnchor="end"
          >
            {z}
          </text>
        </g>
      ))}

      {/* 대각선 y=x (z 변화 없음) */}
      <line
        x1={xToPx(-range)}
        y1={yToPx(-range)}
        x2={xToPx(range)}
        y2={yToPx(range)}
        stroke="#636366"
        strokeDasharray="3 3"
        strokeWidth={0.7}
      />

      {/* 청산권장 영역 박스 ±0.3 */}
      <rect
        x={xToPx(-0.3)}
        y={yToPx(0.3)}
        width={xToPx(0.3) - xToPx(-0.3)}
        height={yToPx(-0.3) - yToPx(0.3)}
        fill="#ff9f0a"
        opacity={0.08}
      />

      {/* 축 라벨 */}
      <text
        x={SCATTER_W - SCATTER_PAD}
        y={SCATTER_H - 6}
        fontSize={9}
        fill="#636366"
        textAnchor="end"
      >
        진입 z →
      </text>
      <text x={6} y={SCATTER_PAD - 8} fontSize={9} fill="#636366">
        ↑ 고정 z
      </text>

      {/* 점 */}
      {rows.map((r) => {
        if (r.pos.entry_z == null || r.judgeZ == null) return null
        const color =
          r.label === 'exit_suggest'
            ? '#ff9f0a'
            : r.label === 'converge'
            ? '#34c759'
            : r.label === 'diverge'
            ? '#ff3b30'
            : r.label === 'stale'
            ? '#636366'
            : '#0a84ff'
        const isFrozen = r.frozen != null
        return (
          <circle
            key={r.pos.id}
            cx={xToPx(r.pos.entry_z)}
            cy={yToPx(r.judgeZ)}
            r={4}
            fill={isFrozen ? color : 'none'}
            stroke={color}
            strokeWidth={isFrozen ? 0 : 1.2}
            opacity={0.85}
          >
            <title>
              {r.pos.left_key} ↔ {r.pos.right_key}
              {'\n'}진입 {r.pos.entry_z.toFixed(2)} → {isFrozen ? '고정' : '오늘'}{' '}
              {r.judgeZ.toFixed(2)}
            </title>
          </circle>
        )
      })}
    </svg>
  )
}
