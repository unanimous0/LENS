import { useMemo } from 'react'

import { LP_DOWN, LP_UP } from '@/lib/lp-desk'
import { cn } from '@/lib/utils'
import { CONTRACT_LABEL, type LpDeskFill, type LpDeskHedgeFill } from '@/types/lp-desk'

/** 체결 원장 한 줄 (ETF·헤지 통합 뷰). */
type Entry = {
  key: string
  kind: 'etf' | 'hedge'
  id: number
  ts: string
  label: string
  sub: string
  qty: number
  price: number
  extra: string
}

/**
 * 체결 내역 (§14.6 `lp_desk_fills` / `lp_desk_hedge_fills`).
 *
 * 원라인 입력은 오타 위험이 있는데 포지션은 fills 합산이라, 잘못 넣은 줄을 지울 통로가
 * 화면에 없으면 원장이 그대로 오염된다. §14.9의 DELETE 계약을 그 용도로만 노출.
 */
export function FillsPanel({
  fills,
  hedgeFills,
  loading,
  error,
  onDelete,
  onRefresh,
  onClose,
  nameOf,
}: {
  fills: LpDeskFill[]
  hedgeFills: LpDeskHedgeFill[]
  loading: boolean
  error: string
  onDelete: (kind: 'etf' | 'hedge', id: number) => void
  onRefresh: () => void
  onClose: () => void
  nameOf: (code: string) => string
}) {
  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = []
    for (const f of fills) {
      list.push({
        key: `e${f.id}`,
        kind: 'etf',
        id: f.id,
        ts: f.ts,
        label: nameOf(f.etf_code),
        sub: f.etf_code,
        qty: f.qty,
        price: f.price,
        extra: [
          f.entry_inav != null && f.entry_inav > 0
            ? `iNAV ${f.entry_inav.toLocaleString(undefined, { maximumFractionDigits: 1 })} · 진입괴리 ${(((f.price - f.entry_inav) / f.entry_inav) * 10000).toFixed(1)}bp`
            : 'iNAV 미첨부',
          // 진입 선물가는 헤지 상대성과(edge)의 기준점 — 없으면 그 포지션 edge가 '—'가 된다.
          f.entry_k200 != null && f.entry_kq150 != null
            ? `K200 ${f.entry_k200.toFixed(2)} · KQ150 ${f.entry_kq150.toFixed(2)}`
            : '선물 미첨부',
        ].join(' / '),
      })
    }
    for (const h of hedgeFills) {
      list.push({
        key: `h${h.id}`,
        kind: 'hedge',
        id: h.id,
        ts: h.ts,
        label: CONTRACT_LABEL[h.contract] ?? h.contract,
        sub: '헤지',
        qty: h.qty,
        price: h.price,
        extra: '',
      })
    }
    // 최신순. ts는 ISO 문자열 가정이라 문자열 비교로 충분.
    list.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id))
    return list
  }, [fills, hedgeFills, nameOf])

  return (
    <div className="mx-2 mb-1 rounded-sm bg-[#0d0d0f] border border-white/[0.05]">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-white/[0.05] text-[11px]">
        <span className="text-[13px] text-white">체결 내역</span>
        <span className="text-[#8b8b8e]">
          ETF <span className="text-white tabular-nums">{fills.length}</span> · 헤지{' '}
          <span className="text-white tabular-nums">{hedgeFills.length}</span>
        </span>
        {loading && <span className="text-blue">로딩…</span>}
        {error && <span className="text-down">조회 실패: {error}</span>}
        <span className="text-[10px] text-[#5a5a5e]">포지션 = 체결 합산 — 오입력 줄은 여기서 삭제</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onRefresh}
            className="h-[24px] rounded bg-[#1e1e22] px-2.5 text-[11px] text-[#d1d1d6] hover:bg-[#2e2e32] hover:text-white transition-colors"
          >
            새로고침
          </button>
          <button
            onClick={onClose}
            className="h-[24px] rounded bg-[#1e1e22] px-2.5 text-[11px] text-[#8b8b8e] hover:bg-[#2e2e32] hover:text-white transition-colors"
          >
            닫기
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="px-3 py-4 text-[11px] text-[#5a5a5e]">{loading ? '로딩…' : '체결 없음'}</div>
      ) : (
        <div className="max-h-[280px] overflow-y-auto">
          <table className="w-full tabular-nums">
            <thead className="sticky top-0 bg-[#16161a] text-[10px] text-[#a8a8ae]">
              <tr>
                <th className="py-1.5 pl-3 text-left font-normal">시각</th>
                <th className="py-1.5 text-left font-normal">대상</th>
                <th className="py-1.5 pr-3 text-right font-normal">수량</th>
                <th className="py-1.5 pr-3 text-right font-normal">가격</th>
                <th className="py-1.5 text-left font-normal">비고</th>
                <th className="py-1.5 pr-3 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.key} className="border-b border-white/[0.03] hover:bg-white/[0.04]">
                  <td className="py-[5px] pl-3 text-left text-[10px] text-[#8b8b8e]">{fmtTs(e.ts)}</td>
                  <td className="py-[5px] text-left text-[11px]">
                    <span className={e.kind === 'hedge' ? 'text-blue' : 'text-white'}>{e.label}</span>
                    <span className="ml-1.5 text-[10px] text-[#5a5a5e]">{e.sub}</span>
                  </td>
                  <td className={cn('py-[5px] pr-3 text-right text-[11px]', e.qty >= 0 ? LP_UP : LP_DOWN)}>
                    {e.qty > 0 ? '+' : ''}{e.qty.toLocaleString()}
                  </td>
                  <td className="py-[5px] pr-3 text-right text-[11px] text-[#d1d1d6]">
                    {e.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </td>
                  <td className="py-[5px] text-left text-[10px] text-[#5a5a5e]">{e.extra}</td>
                  <td className="py-[5px] pr-3 text-right">
                    <button
                      onClick={() => onDelete(e.kind, e.id)}
                      className="rounded px-1.5 text-[11px] text-[#5a5a5e] hover:text-down transition-colors"
                      title="이 체결 삭제"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** ISO ts → MM-DD HH:MM. 파싱 실패하면 원문 그대로. */
function fmtTs(ts: string): string {
  if (!ts) return '-'
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(ts)
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ts
}
