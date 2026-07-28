import { useMemo } from 'react'

import { keyToCode } from '@/lib/stat-arb-keys'
import { cn } from '@/lib/utils'
import type { Johansen, MnLeg } from '@/types/stat-arb'

/** L2=1 정규화 + 첫 비영 성분 양수 (엔진 `johansen.rs::normalize_l2_sign` 과 동일 규약).
 *  두 벡터를 같은 규약으로 맞춰야 방향 비교(내적)가 의미를 갖는다. */
function normalizeVec(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  if (!(norm > 0) || !Number.isFinite(norm)) return v.map(() => 0)
  const u = v.map((x) => x / norm)
  const first = u.find((x) => Math.abs(x) > 1e-12)
  return first != null && first < 0 ? u.map((x) => -x) : u
}

/** Johansen 공적분 검정 패널 (M:N 상세 전용).
 *
 *  발굴은 "CCA 가중치로 만든 합성 스프레드 하나"에 단방향 ADF 를 걸지만, Johansen 은
 *  leg 로그가격 **레벨 시스템 전체**를 어느 쪽이 y 인지 정하지 않고 대칭으로 검정한다.
 *  현 단계는 **측정 전용**이라 발굴 게이팅에는 반영되지 않는다. */
export function JohansenPanel({
  j,
  xLegs,
  yLegs,
  hedgeRatio,
}: {
  j: Johansen
  xLegs: MnLeg[]
  yLegs: MnLeg[]
  hedgeRatio: number
}) {
  const legs = useMemo(() => [...xLegs, ...yLegs], [xLegs, yLegs])

  // 발굴(CCA)이 함의하는 공적분 벡터 — 잔차 = Σvⱼ·lnPⱼ − β·Σwᵢ·lnPᵢ 이므로
  // leg 순서(x→y)로 [−β·wᵢ, …, vⱼ, …]. Johansen 과 같은 규약으로 정규화해 방향만 비교한다.
  const ccaVec = useMemo(
    () =>
      normalizeVec([
        ...xLegs.map((l) => -hedgeRatio * l.weight),
        ...yLegs.map((l) => l.weight),
      ]),
    [xLegs, yLegs, hedgeRatio]
  )

  const comparable = j.coint_vector.length === legs.length && ccaVec.length === legs.length
  // 두 단위벡터 내적 = cos. 1에 가까울수록 "CCA가 찾아낸 결합 = 공적분 벡터".
  const cos = comparable ? j.coint_vector.reduce((s, x, i) => s + x * ccaVec[i], 0) : null

  const rank = j.rank_95
  const badge =
    rank == null
      ? { label: '미판정', cls: 'bg-bg-surface text-t4' }
      : rank >= 1
      ? { label: `공적분 ${rank}개`, cls: 'bg-accent/15 text-accent' }
      : { label: '공적분 없음', cls: 'bg-bg-surface text-t3' }

  return (
    <div className="panel p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-t1">Johansen 공적분 검정</span>
        <span className="text-[10px] text-t3">leg 로그가격 레벨 · trace 검정</span>
        <span className={cn('ml-auto rounded-sm px-1.5 py-0.5 text-[11px] font-semibold', badge.cls)}>
          {badge.label}
        </span>
      </div>

      <div className="leading-relaxed text-t3">
        여러 종목이 장기적으로 함께 묶여 있는지를 <span className="text-t2">방향 구분 없이</span>{' '}
        검정합니다. <span className="text-t2">rank ≥ 1</span> 이면 최소 1개의 안정적 결합(공적분
        관계)이 존재한다는 뜻이고, <span className="text-t2">rank 0</span> 이면 이 바스켓은 통계적으로
        같이 움직인다고 볼 근거가 없습니다.
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-t4 tabular-nums">
        <span title="전 leg 가격이 모두 살아있는 최장 연속 구간의 봉 수. Johansen은 ΔY를 쓰므로 결측일을 개별로 빼면 차분이 구멍을 건너뛴다 — 그래서 끊기지 않는 구간만 쓴다. 수정주가 결측 구간이 있으면 최신에서 끝나지 않을 수 있다.">
          표본 <span className="text-t3">{j.n_obs}</span>봉
        </span>
        <span>
          변수 <span className="text-t3">{j.n_vars}</span>개
        </span>
        <span title="VECM 시차 p. 1이면 ΔY 지연항 없이 상수만.">
          시차 <span className="text-t3">{j.lags}</span>
        </span>
        <span title="99% 유의수준으로 더 보수적으로 판정했을 때의 rank.">
          99% 기준 rank <span className="text-t3">{j.rank_99 ?? '—'}</span>
        </span>
      </div>

      {/* r별 순차 검정표 */}
      <div className="mt-2 overflow-hidden rounded-sm border border-bg-surface">
        <table className="w-full text-[11px] tabular-nums">
          <thead className="bg-bg-surface text-t3">
            <tr>
              <th className="px-1.5 py-1 text-left font-normal">귀무가설</th>
              <th className="px-1.5 py-1 text-right font-normal" title="−T·Σ ln(1−λ)">
                trace
              </th>
              <th className="px-1.5 py-1 text-right font-normal">95%</th>
              <th className="px-1.5 py-1 text-right font-normal">99%</th>
              <th className="px-1.5 py-1 text-right font-normal" title="일반화 고유값 λ">
                λ
              </th>
              <th className="px-1.5 py-1 text-center font-normal">판정</th>
            </tr>
          </thead>
          <tbody>
            {j.trace_stats.map((stat, r) => {
              const c95 = j.trace_crit_95[r]
              const rejected = c95 != null && stat > c95
              return (
                <tr key={r} className="border-t border-bg-surface">
                  <td className="px-1.5 py-1 text-t2">
                    {r === 0 ? '관계 없음 (r=0)' : `관계 ≤ ${r}`}
                  </td>
                  <td className="px-1.5 py-1 text-right text-t1">{stat.toFixed(2)}</td>
                  <td className="px-1.5 py-1 text-right text-t3">{c95?.toFixed(2) ?? '—'}</td>
                  <td className="px-1.5 py-1 text-right text-t3">
                    {j.trace_crit_99[r]?.toFixed(2) ?? '—'}
                  </td>
                  <td className="px-1.5 py-1 text-right text-t4">
                    {j.eigenvalues[r]?.toFixed(4) ?? '—'}
                  </td>
                  <td
                    className={cn(
                      'px-1.5 py-1 text-center',
                      c95 == null ? 'text-t4' : rejected ? 'text-accent' : 'text-t3'
                    )}
                  >
                    {c95 == null ? '미판정' : rejected ? '기각' : '기각 실패'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1 leading-relaxed text-t4 text-[11px]">
        위에서부터 순차 검정 — <span className="text-t3">기각</span>이 이어지다 처음{' '}
        <span className="text-t3">기각 실패</span>한 지점의 r 이 추정 rank입니다. 임계값은
        MacKinnon-Haug-Michelis(1999), 비제약 상수 케이스.
      </div>

      {/* 공적분 벡터 vs CCA 가중치 */}
      {comparable && (
        <div className="mt-2.5">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-t2">공적분 벡터 vs CCA 가중치</span>
            {cos != null && (
              <span
                className={cn(
                  'tabular-nums',
                  Math.abs(cos) >= 0.9 ? 'text-accent' : Math.abs(cos) >= 0.6 ? 'text-t2' : 'text-warning'
                )}
                title="두 벡터(둘 다 L2=1·첫 성분 양수로 정규화)의 내적. 1에 가까울수록 CCA가 찾아낸 결합이 곧 공적분 벡터."
              >
                방향 일치도 {cos.toFixed(3)}
              </span>
            )}
          </div>
          <div className="overflow-hidden rounded-sm border border-bg-surface">
            <table className="w-full text-[11px] tabular-nums">
              <thead className="bg-bg-surface text-t3">
                <tr>
                  <th className="px-1.5 py-1 text-left font-normal">leg</th>
                  <th className="px-1.5 py-1 text-right font-normal" title="Johansen 최대 고유값 대응 공적분 벡터 (L2=1)">
                    Johansen β
                  </th>
                  <th
                    className="px-1.5 py-1 text-right font-normal"
                    title="발굴이 함의하는 공적분 벡터 — X측 −β·wᵢ, Y측 vⱼ 를 같은 규약으로 정규화"
                  >
                    CCA 함의
                  </th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l, i) => {
                  const jb = j.coint_vector[i]
                  const cb = ccaVec[i]
                  // 부호가 갈리면 그 leg 에서 두 방법이 반대 포지션을 함의한다 — 눈에 띄게.
                  const signGap = jb * cb < 0
                  return (
                    <tr key={l.key} className="border-t border-bg-surface">
                      <td className="px-1.5 py-1">
                        <span className="text-t4">{keyToCode(l.key)}</span>{' '}
                        <span className="text-t2">{l.name}</span>
                        <span className="ml-1 text-t4">{i < xLegs.length ? 'X' : 'Y'}</span>
                      </td>
                      <td className={cn('px-1.5 py-1 text-right', jb >= 0 ? 'text-up' : 'text-down')}>
                        {jb >= 0 ? '+' : ''}
                        {jb.toFixed(3)}
                      </td>
                      <td
                        className={cn(
                          'px-1.5 py-1 text-right',
                          signGap ? 'text-warning' : cb >= 0 ? 'text-up' : 'text-down'
                        )}
                        title={signGap ? '두 방법이 이 leg에서 반대 부호 — 결합 구조가 다르다' : undefined}
                      >
                        {cb >= 0 ? '+' : ''}
                        {cb.toFixed(3)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
