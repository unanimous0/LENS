import {
  DIR_COLOR,
  patternDir,
  patternsWithEpisodes,
  type EpisodesResponse,
  type Horizon,
} from './flow-episodes-utils'

/**
 * 수급 태그 **에피소드 히스토리** 하단 섹션 (PR-B) — 패턴 칩 + 에피소드 테이블.
 *
 * `/api/flow/episodes/{code}`(백엔드 `flow_episodes` 정본)를 상세 열릴 때 1회 fetch(부모)해 표시만.
 * 판정은 `flow_verdict` 정본 재호출(공식 1벌 — 화면 태그와 바이트 일치), 성과는 백엔드가
 * look-ahead 차단(onset D+1 시가 진입) + 유니버스 인덱스 대비 초과수익으로 계산. 재계산 없음.
 */

const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`)
const pctCls = (v: number | null | undefined) =>
  v == null ? 'text-t4' : v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3'

export function EpisodeSection({
  data,
  selected,
  setSelected,
}: {
  data: EpisodesResponse
  selected: string | null
  setSelected: (p: string) => void
}) {
  const names = patternsWithEpisodes(data.patterns)
  if (!names.length) {
    return <div className="mt-3 rounded-sm bg-bg-surface/40 p-3 text-xs text-t3">과거 태그 에피소드 없음.</div>
  }
  const sel = selected && data.patterns[selected] ? selected : names[0]
  const block = data.patterns[sel]
  const bench = data.benchmark_available
  const st = block.stats
  const val = (h: Horizon) => (bench ? h?.excess_pct : h?.stock_pct) ?? null

  return (
    <div className="mt-3 rounded-sm bg-bg-surface/40 p-2">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="font-medium text-t2">태그 에피소드 히스토리</span>
        <div className="flex flex-wrap gap-1">
          {names.map((name) => {
            const active = name === sel
            return (
              <button
                key={name}
                onClick={() => setSelected(name)}
                className={`flex items-center gap-1 rounded-sm border px-1.5 py-0.5 ${
                  active ? 'border-transparent bg-accent/20 text-accent' : 'border-bg-surface text-t3 hover:text-t1'
                }`}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: DIR_COLOR[patternDir(name)] }}
                />
                {name}
                <span className={active ? 'text-accent' : 'text-t4'}>{data.patterns[name].episodes.length}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* 요약 줄 */}
      <div className="mb-1.5 text-[11px] text-t3">
        {bench ? (
          <>
            에피소드 <span className="text-t2 tabular-nums">{st.count}</span>회 · h60 평균 초과{' '}
            <span className={`tabular-nums ${pctCls(st.avg_excess_h60)}`}>{fmtPct(st.avg_excess_h60)}</span> · 승률{' '}
            <span className="text-t2 tabular-nums">
              {st.win_rate_h60 == null ? '—' : `${Math.round(st.win_rate_h60 * 100)}%`}
            </span>
          </>
        ) : (
          <>
            에피소드 <span className="text-t2 tabular-nums">{st.count}</span>회 · 절대수익 표시 (벤치마크 미생성 — 서버 주기 갱신 후 초과수익)
          </>
        )}
      </div>

      <div className="max-h-[260px] overflow-y-auto">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="sticky top-0 bg-bg-surface text-t3">
            <tr>
              <th className="px-2 py-1 text-left font-normal">진입일</th>
              <th className="px-2 py-1 text-right font-normal">지속</th>
              <th className="px-2 py-1 text-right font-normal">진입가</th>
              <th className="px-2 py-1 text-right font-normal">+20D</th>
              <th className="px-2 py-1 text-right font-normal">+60D</th>
              <th className="px-2 py-1 text-right font-normal">+120D</th>
              <th className="px-2 py-1 text-right font-normal">상태</th>
            </tr>
          </thead>
          <tbody>
            {block.episodes.map((e) => {
              const v20 = val(e.h20)
              const v60 = val(e.h60)
              const v120 = val(e.h120)
              const pv = e.partial ? (bench ? e.partial.excess_pct : e.partial.stock_pct) : null
              return (
                <tr key={e.onset} className="border-t border-bg-surface/40">
                  <td className="px-2 py-1 text-t2">{e.entry_date.slice(2)}</td>
                  <td className="px-2 py-1 text-right text-t3">{e.duration_days}일</td>
                  <td className="px-2 py-1 text-right text-t3">{Math.round(e.entry_price).toLocaleString()}</td>
                  <td className={`px-2 py-1 text-right ${pctCls(v20)}`}>{fmtPct(v20)}</td>
                  <td className={`px-2 py-1 text-right ${pctCls(v60)}`}>{fmtPct(v60)}</td>
                  <td className={`px-2 py-1 text-right ${pctCls(v120)}`}>{fmtPct(v120)}</td>
                  <td className="px-2 py-1 text-right">
                    {e.ongoing || e.partial ? (
                      <span className="inline-flex items-center gap-1">
                        {e.ongoing && (
                          <span className="rounded-sm bg-warning/20 px-1 text-[10px] text-warning">진행중</span>
                        )}
                        {e.partial && (
                          <span className={`tabular-nums ${pctCls(pv)}`}>
                            {fmtPct(pv)}
                            <span className="text-t4"> ·{e.partial.days}일</span>
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-t4">완료</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 border-t border-bg-surface/50 pt-1.5 text-[10px] leading-relaxed text-t4">
        {bench ? '초과수익 = 유니버스 평균 대비' : '표시치 = 종목 절대수익'} · D+1 시가 체결
        {data.benchmark_as_of ? <> · 벤치마크 기준일 {data.benchmark_as_of}</> : null} · 검증치는 패턴 평균이며 개별
        종목 결과는 편차가 큽니다.
      </div>
    </div>
  )
}
