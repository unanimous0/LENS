import { useEffect, useMemo, useState } from 'react'

/**
 * 수급 — 외국인/기관 순매수 기반 종목 랭킹.
 *
 * 설계 원칙 (memory project_supply_demand — 4관점 제로베이스 설계 통합안):
 *  - 지표는 백엔드 정본(services/flow_metrics.py) 하나뿐. 프론트는 포맷팅만.
 *  - 정렬 키 = 외인 20D/유통시총(bp) 단일. 매수 = 내림차순, 매도 = 오름차순 토글.
 *  - 합성 점수 없음 — 모든 컬럼이 HTS로 검산 가능한 raw 산수.
 *  - 뱃지: NEW(전일 상위권에 없던 신규 진입) · 동시(외인·기관 20D 둘 다 순매수).
 */

type FlowRow = {
  code: string
  name: string
  market: string
  sector: string | null
  float_date: string
  mcap_eok: number | null
  float_mcap_eok: number
  f_streak: number
  f_5d_eok: number
  f_20d_eok: number
  f_60d_eok: number
  i_5d_eok: number
  i_20d_eok: number
  f_5d_bp: number
  f_20d_bp: number
  f_60d_bp: number
  i_20d_bp: number
  absorb_5d_pct: number | null
  ret_20d_pct: number | null
  y_f_eok: number
  y_i_eok: number
  adv_20d_eok: number
  both_20d: boolean
  entry_ok: boolean
  exit_ok: boolean
  is_new: boolean
}

type RankingResp = {
  as_of: string
  is_partial: boolean
  preset: string
  count: number
  rows: FlowRow[]
}

const PRESET_LABELS: Record<string, string> = {
  default: '기본 (거래대금 10억·유통 500억↑)',
  large: '대형주 (유통 1조↑)',
  all: '전체',
}

const SHOW_LIMIT = 100

export function StockFlowPage() {
  const [data, setData] = useState<RankingResp | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preset, setPreset] = useState('default')
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy')
  const [search, setSearch] = useState('')

  // 로딩은 파생값 — 요청한 preset의 응답이 아직 없으면 로딩 중 (effect 내 동기 setState 회피)
  const loading = !error && (!data || data.preset !== preset)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/flow/ranking?preset=${preset}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
        return r.json() as Promise<RankingResp>
      })
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [preset])

  const visible = useMemo(() => {
    if (!data) return []
    let rows = data.rows
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.code.includes(q))
    }
    // 백엔드는 f_20d_bp 내림차순 — 매도 뷰는 뒤집기만 (지표 재계산 없음)
    const sorted = direction === 'buy' ? rows : [...rows].reverse()
    return search.trim() ? sorted : sorted.slice(0, SHOW_LIMIT)
  }, [data, direction, search])

  const floatStale = useMemo(() => {
    if (!data || data.rows.length === 0) return null
    // 유통주식수 기준일이 as_of보다 오래 묵었으면 경고 (Finance_Data 크롤러 이슈 감지)
    const latestFloat = data.rows.reduce((m, r) => (r.float_date > m ? r.float_date : m), '')
    const ageDays = Math.round(
      (new Date(data.as_of).getTime() - new Date(latestFloat).getTime()) / 86_400_000
    )
    return ageDays > 45 ? { date: latestFloat, ageDays } : null
  }, [data])

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 컨트롤 */}
      <div className="panel flex flex-wrap items-center gap-3 p-3 text-xs">
        <span className="text-sm font-medium text-t1">수급 랭킹</span>
        <div className="flex overflow-hidden rounded-sm border border-bg-surface">
          <button
            onClick={() => setDirection('buy')}
            className={`px-3 py-1 ${direction === 'buy' ? 'bg-up/20 text-up' : 'text-t3'}`}
          >
            매수 후보
          </button>
          <button
            onClick={() => setDirection('sell')}
            className={`px-3 py-1 ${direction === 'sell' ? 'bg-down/20 text-down' : 'text-t3'}`}
          >
            매도 후보
          </button>
        </div>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="rounded-sm bg-bg-surface px-2 py-1 text-t1 focus:outline-none"
        >
          {Object.entries(PRESET_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="종목명 / 코드"
          className="rounded-sm bg-bg-surface px-2 py-1 text-t1 placeholder:text-t3 focus:outline-none"
        />
        <div className="ml-auto flex items-center gap-3 text-t3">
          {data && (
            <>
              <span>
                기준일 <span className="text-t1">{data.as_of}</span>
                {data.is_partial && <span className="ml-1 text-warning">· 금일 수집 중 (전일 기준)</span>}
              </span>
              <span>
                {data.count}종목 / 표시 {visible.length}
              </span>
            </>
          )}
        </div>
      </div>

      {/* 데이터 품질 경고 */}
      {floatStale && (
        <div className="panel px-3 py-2 text-xs text-warning">
          ⚠ 유통주식수 기준일 {floatStale.date} ({floatStale.ageDays}일 경과) — Finance_Data
          floating_shares 갱신 지연. bp 지표의 분모가 오래된 값입니다.
        </div>
      )}

      {error && <div className="panel p-3 text-xs text-down">로딩 실패: {error}</div>}
      {loading && <div className="panel p-3 text-xs text-t3">로딩 중…</div>}

      {/* 랭킹 테이블 */}
      {data && !loading && (
        <div className="panel overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-bg-primary">
              <tr className="border-b border-bg-surface text-left text-t3">
                <th className="px-3 py-2 font-normal">#</th>
                <th className="px-3 py-2 font-normal">종목</th>
                <th className="px-3 py-2 text-right font-normal" title="외인 연속 순매수(+)/순매도(−) 영업일 수">
                  연속
                </th>
                <th className="px-3 py-2 text-right font-normal" title="외국인 최근 5일 순매수 합 (억원)">
                  외인 5D
                </th>
                <th
                  className="px-3 py-2 text-right font-normal text-t1"
                  title="외국인 20일 누적 순매수 ÷ 유통시총 (bp) — 정렬 기준"
                >
                  외인 20D bp {direction === 'buy' ? '▼' : '▲'}
                </th>
                <th className="px-3 py-2 text-right font-normal" title="기관 최근 5일 순매수 합 (억원) — 연기금 포함">
                  기관 5D
                </th>
                <th
                  className="px-3 py-2 text-right font-normal"
                  title="흡수율: 최근 5일 (외인+기관) 순매수 ÷ 거래대금 (%) — 높을수록 진성"
                >
                  흡수율
                </th>
                <th className="px-3 py-2 text-right font-normal" title="수정종가 기준 20일 수익률">
                  20D 수익률
                </th>
                <th className="px-3 py-2 text-right font-normal" title="전일 외인/기관 순매수 (억원)">
                  어제 (외/기)
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                const streakCls = r.f_streak > 0 ? 'text-up' : r.f_streak < 0 ? 'text-down' : 'text-t3'
                const retCls =
                  r.ret_20d_pct == null ? 'text-t3' : r.ret_20d_pct > 0 ? 'text-up' : r.ret_20d_pct < 0 ? 'text-down' : 'text-t3'
                return (
                  <tr key={r.code} className="border-t border-bg-surface/40 hover:bg-bg-surface/30">
                    <td className="px-3 py-1.5 text-t3">{i + 1}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-t1">{r.name}</span>
                        {r.is_new && (
                          <span className="rounded-sm bg-blue/20 px-1 text-[10px] text-blue">NEW</span>
                        )}
                        {r.both_20d && (
                          <span
                            className="rounded-sm bg-accent/15 px-1 text-[10px] text-accent"
                            title="외인·기관 20D 동시 순매수"
                          >
                            동시
                          </span>
                        )}
                        {direction === 'buy' && r.entry_ok && (
                          <span
                            className="rounded-sm bg-warning/15 px-1 text-[10px] text-warning"
                            title="진입권: 20D ≥ 15bp + 지속성(연속 3D↑ 또는 5D가 일평균 거래대금의 30%↑) — 이벤트성 스파이크 배제"
                          >
                            진입권
                          </span>
                        )}
                        {direction === 'sell' && r.exit_ok && (
                          <span
                            className="rounded-sm bg-down/15 px-1 text-[10px] text-down"
                            title="매도권: 20D ≤ −15bp + 지속성 — 이벤트성 스파이크 배제"
                          >
                            매도권
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-t3">
                        {r.code} · {r.sector ?? r.market} · 유통 {Math.round(r.float_mcap_eok).toLocaleString()}억
                      </div>
                    </td>
                    <td className={`px-3 py-1.5 text-right ${streakCls}`}>
                      {r.f_streak > 0 ? `+${r.f_streak}D` : r.f_streak < 0 ? `${r.f_streak}D` : '—'}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${signCls(r.f_5d_eok)}`}>{fmtEok(r.f_5d_eok)}</td>
                    <td className={`px-3 py-1.5 text-right font-semibold ${signCls(r.f_20d_bp)}`}>
                      {r.f_20d_bp >= 0 ? '+' : ''}
                      {r.f_20d_bp.toFixed(1)}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${signCls(r.i_5d_eok)}`}>{fmtEok(r.i_5d_eok)}</td>
                    <td className="px-3 py-1.5 text-right text-t2">
                      {r.absorb_5d_pct != null ? `${r.absorb_5d_pct.toFixed(1)}%` : '—'}
                    </td>
                    <td className={`px-3 py-1.5 text-right ${retCls}`}>
                      {r.ret_20d_pct != null ? `${r.ret_20d_pct > 0 ? '+' : ''}${r.ret_20d_pct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right text-t2">
                      <span className={signCls(r.y_f_eok)}>{fmtEok(r.y_f_eok)}</span>
                      <span className="text-t3"> / </span>
                      <span className={signCls(r.y_i_eok)}>{fmtEok(r.y_i_eok)}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="p-4 text-center text-xs text-t3">조건에 맞는 종목이 없습니다</div>
          )}
        </div>
      )}

      {/* 데이터 규약 안내 */}
      <div className="panel px-3 py-2 text-[11px] leading-relaxed text-t3">
        수급강도(bp) = N일 누적 순매수 ÷ (유통주식수 × 종가) × 10,000. 기관에 연기금 포함(별도
        가산 금지). D일 수급은 장 마감 후 확정 — 이 화면의 신호는 <span className="text-t2">D+1 시가부터 실행 가능</span>.
        매도 후보는 같은 지표의 오름차순(별도 공식 없음).
      </div>
    </div>
  )
}

function signCls(v: number): string {
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3'
}

function fmtEok(v: number): string {
  const s = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1)
  return `${v > 0 ? '+' : ''}${s}억`
}
