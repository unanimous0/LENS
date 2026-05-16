import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { keyToCode } from '@/lib/stat-arb-keys'
import {
  LABEL_META,
  deriveLabel,
  estimateLoanPnL,
  estimateMarkPnL,
  holdDays,
  regressionPct,
} from '@/lib/position-labels'
import type { Position, PositionListResp } from '@/types/positions'
import type { PairRow } from '@/types/stat-arb'

/** 페어 매칭 키: left_key|right_key */
function pairKey(left: string, right: string): string {
  return `${left}|${right}`
}

export function StatArbPositionsPage() {
  const navigate = useNavigate()
  const [positions, setPositions] = useState<Position[]>([])
  const [pairMap, setPairMap] = useState<Map<string, PairRow>>(new Map())
  const [statusFilter, setStatusFilter] = useState<'open' | 'closed' | 'all'>('open')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      fetch('/api/stat-arb/pairs?limit=500').then(async (r) => {
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

  const rows = useMemo(() => {
    return positions.map((pos) => {
      const pair = pairMap.get(pairKey(pos.left_key, pos.right_key)) ?? null
      const currentZ = pair?.z_score ?? null
      const halfLife = pos.entry_stats?.half_life ?? pair?.half_life ?? null
      const label = deriveLabel(pos, currentZ, halfLife)
      const regress = regressionPct(pos.entry_z, currentZ)
      const days = holdDays(pos.opened_at)
      const markPnL = estimateMarkPnL(pos, pair)
      const loanPnL = estimateLoanPnL(pos)
      const totalPnL = (markPnL ?? 0) + loanPnL
      return { pos, pair, currentZ, label, regress, days, markPnL, loanPnL, totalPnL }
    })
  }, [positions, pairMap])

  const activeRows = rows.filter((r) => r.pos.status === 'open')

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
        {error && <span className="text-xs text-down">{error}</span>}
      </div>

      {/* z 산점도 — 활성 포지션만 */}
      {activeRows.length > 0 && (
        <div className="panel p-3">
          <div className="mb-2 text-xs text-t3">
            진입 z (x) ↔ 현재 z (y) — 대각선 위는 발산, 원점 근처는 청산권장
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
              <th className="px-3 py-2 font-normal text-right">현재 z</th>
              <th className="px-3 py-2 font-normal text-right">회귀</th>
              <th className="px-3 py-2 font-normal">상태</th>
              <th className="px-3 py-2 font-normal text-right">평가</th>
              <th className="px-3 py-2 font-normal text-right">대여</th>
              <th className="px-3 py-2 font-normal text-right">종합</th>
              <th className="px-3 py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ pos, pair, currentZ, label, regress, days, markPnL, loanPnL, totalPnL }) => {
              const meta = LABEL_META[label]
              const leftName = pair?.left_name ?? keyToCode(pos.left_key)
              const rightName = pair?.right_name ?? keyToCode(pos.right_key)
              return (
                <tr
                  key={pos.id}
                  onClick={() => navigate(`/stat-arb/positions/${pos.id}`)}
                  className="cursor-pointer border-b border-bg-surface/40 hover:bg-bg-surface/50"
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
                  <td className="px-3 py-2 text-right text-t2">{days}d</td>
                  <td className="px-3 py-2 text-right text-t2">
                    {pos.entry_z != null
                      ? `${pos.entry_z >= 0 ? '+' : ''}${pos.entry_z.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-t1">
                    {currentZ != null
                      ? `${currentZ >= 0 ? '+' : ''}${currentZ.toFixed(2)}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-t2">
                    {regress != null ? `${regress.toFixed(0)}%` : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded-sm px-2 py-0.5 text-[10px] ${meta.cls}`}>
                      {meta.ko}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right ${pnlCls(markPnL)}`}>
                    {fmtPnL(markPnL)}
                  </td>
                  <td className={`px-3 py-2 text-right ${pnlCls(loanPnL)}`}>
                    {fmtPnL(loanPnL)}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${pnlCls(totalPnL)}`}>
                    {fmtPnL(totalPnL)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(pos.id)
                      }}
                      className="text-[10px] text-t4 hover:text-down"
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
        ※ 평가손익은 통계차익 *부분 회귀 모델* 기반 단순 추정. PR18에서 실시간 가격 기반 정밀
        계산으로 교체 예정.
      </div>
    </div>
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

// ---------------------------------------------------------------------------
// z 산점도 SVG (recharts 안 가져옴 — 단순한 점/축/대각선/원점밴드)
// ---------------------------------------------------------------------------

const SCATTER_PAD = 28
const SCATTER_W = 480
const SCATTER_H = 280

function ZScatter({
  rows,
}: {
  rows: Array<{ pos: Position; currentZ: number | null; label: string }>
}) {
  // x/y 범위 자동 — |z| max에서 + 0.5 마진 (최소 ±3)
  const zMax = Math.max(
    3,
    ...rows.flatMap((r) => [
      Math.abs(r.pos.entry_z ?? 0),
      Math.abs(r.currentZ ?? 0),
    ])
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
        ↑ 현재 z
      </text>

      {/* 점 */}
      {rows.map((r) => {
        if (r.pos.entry_z == null || r.currentZ == null) return null
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
        return (
          <circle
            key={r.pos.id}
            cx={xToPx(r.pos.entry_z)}
            cy={yToPx(r.currentZ)}
            r={4}
            fill={color}
            opacity={0.85}
          >
            <title>
              {r.pos.left_key} ↔ {r.pos.right_key}
              {'\n'}진입 {r.pos.entry_z.toFixed(2)} → 현재 {r.currentZ.toFixed(2)}
            </title>
          </circle>
        )
      })}
    </svg>
  )
}
