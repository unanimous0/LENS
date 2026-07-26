import { useState } from 'react'

import type { KalmanStat } from '@/types/stat-arb'

/** 관계 안정성 (Kalman 시변 β 드리프트) 패널 — 항상 일봉 기준.
 *  정적 OLS β(3년 고정) vs Kalman 적응 β_t 비교로 "관계가 흔들리는지" 자동 감지.
 *
 *  1:1 페어 상세 / M:N 페어 상세 공용. 판정·임계는 엔진 `detail::classify_stability` 1벌이고
 *  여기는 표시 규칙만 (M:N 은 합성 로그가격 공간이지만 β·z 의 *의미*는 동일해 화면도 동일). */
export function RelationStabilityPanel({ k }: { k: KalmanStat }) {
  const driftPct = k.beta_drift_pct * 100
  const betaShaking = k.beta_drift_pct > 0.1
  const zStale = k.z_gap > 2.0
  const [showHelp, setShowHelp] = useState(false)

  // 판정 배지 톤
  const badge =
    k.stability === 'drift'
      ? { label: '드리프트', cls: 'bg-down/15 text-down' }
      : k.stability === 'caution'
      ? { label: '주의', cls: 'bg-warning/15 text-warning' }
      : { label: '안정', cls: 'bg-accent/15 text-accent' }

  // 경고 문구 — 어느 신호가 승격을 유발했는지에 맞춤
  let msg: string
  let msgCls: string
  if (k.stability === 'drift') {
    msgCls = 'text-down'
    msg = betaShaking
      ? `헤지비율 β가 최근 ${driftPct.toFixed(1)}% 변함 — 두 종목 관계가 구조적으로 흔들리는 중. 3년 평균 회귀 가정이 약화됐습니다. 진입 주의.`
      : `정적 z(${k.z_static.toFixed(2)})는 크지만 적응모델은 균형 근처(${k.z_adaptive.toFixed(2)})로 봅니다 — 관계가 최근 재레벨링됨. 3년 평균 회귀 가정이 약화됐습니다. 진입 주의.`
  } else if (k.stability === 'caution') {
    msgCls = 'text-warning'
    msg = betaShaking
      ? `헤지비율 β가 최근 ${driftPct.toFixed(1)}% 변함 — 관계 기울기가 서서히 바뀌는 중. 헤지비율·포지션 사이즈 재점검 권장.`
      : `정적 z와 적응 z 괴리(${k.z_gap.toFixed(2)}) — 3년 평균 대비 현재 편차가 다소 stale. 진입 신중.`
  } else {
    msgCls = 'text-t3'
    msg = zStale
      ? '헤지비율 β 안정. 다만 스프레드 레벨은 다소 이동 — 대체로 평균 회귀 가정 유효.'
      : 'β·스프레드 관계가 안정적. 평균 회귀 가정 유효.'
  }

  return (
    <div className="panel p-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-sm font-medium text-t1">관계 안정성</span>
        <span className="text-[10px] text-t3">β 드리프트 · 일봉 기준</span>
        <button
          onClick={() => setShowHelp((v) => !v)}
          className={`ml-auto rounded-sm px-1.5 py-0.5 text-[11px] ${
            showHelp ? 'bg-blue/20 text-blue' : 'bg-bg-surface text-t3 hover:text-t1'
          }`}
          title="이 패널 읽는 법"
        >
          설명 {showHelp ? '▴' : '▾'}
        </button>
        <span className={`rounded-sm px-1.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      <div className="space-y-1.5 tabular-nums">
        <div className="flex items-baseline justify-between">
          <span
            className="cursor-help text-t3 underline decoration-t4 decoration-dotted underline-offset-2"
            title="정적 β = 3년 전체로 구한 고정 헤지비율. 현재 β = Kalman이 최근까지 갱신한 헤지비율. 드리프트 = 둘의 차이(관계 비율이 얼마나 변했나). 10%↑ 주의 · 20%↑ 드리프트."
          >
            정적 β → 현재 β
          </span>
          <span className="text-t1">
            {k.beta_static.toFixed(4)} <span className="text-t3">→</span> {k.beta_current.toFixed(4)}{' '}
            <span
              className={
                betaShaking ? (k.beta_drift_pct > 0.2 ? 'text-down' : 'text-warning') : 'text-t3'
              }
            >
              (드리프트 {driftPct.toFixed(1)}%)
            </span>
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span
            className="cursor-help text-t3 underline decoration-t4 decoration-dotted underline-offset-2"
            title="정적 z = 3년 고정선 대비 현재 편차. 적응 z = 최근 갱신선 대비 현재 편차. 괴리 = 둘의 차이(스프레드 레벨이 재정착했나). 2.0↑ 주의 · 3.0↑ 드리프트."
          >
            정적 z vs 적응 z
          </span>
          <span className="text-t1">
            {k.z_static >= 0 ? '+' : ''}
            {k.z_static.toFixed(2)} <span className="text-t3">vs</span>{' '}
            {k.z_adaptive >= 0 ? '+' : ''}
            {k.z_adaptive.toFixed(2)}{' '}
            <span className={zStale ? 'text-warning' : 'text-t3'}>(괴리 {k.z_gap.toFixed(2)})</span>
          </span>
        </div>
      </div>

      {/* β_t 스파크라인 — 정적 β 기준선(점선) 대비 적응 β 추이 */}
      {k.beta_series.length >= 2 && (
        <div className="mt-2">
          <BetaSparkline series={k.beta_series} betaStatic={k.beta_static} stability={k.stability} />
        </div>
      )}

      <div className={`mt-2 leading-relaxed ${msgCls}`}>{msg}</div>
      <div className="mt-1.5 leading-relaxed text-t4">
        β = 두 종목의 헤지비율. 최근 β가 얼마나 변했나 = 관계가 흔들리는지. 적응 z = 관계 변화를 반영한
        현재 편차 (정적 z와 크게 다르면 3년 평균 신호가 stale).
      </div>

      {showHelp && (
        <div className="mt-2.5 space-y-2.5 rounded-sm bg-bg-base/60 p-2.5 text-[11px] leading-relaxed">
          {/* ① 두 잣대 */}
          <div>
            <div className="mb-1 font-medium text-t2">① 두 개의 잣대</div>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-sm bg-bg-surface p-1.5">
                <div className="font-medium text-t1">정적</div>
                <div className="text-t3">
                  3년 전체를 <span className="text-t2">고정된 자</span> 하나로 측정
                </div>
                <div className="text-t4">= 내 3년 평균 체중</div>
              </div>
              <div className="rounded-sm bg-bg-surface p-1.5">
                <div className="font-medium text-t1">적응</div>
                <div className="text-t3">
                  최근까지 <span className="text-t2">계속 갱신</span>하는 자로 측정
                </div>
                <div className="text-t4">= 요즘 몇 주 체중</div>
              </div>
            </div>
          </div>

          {/* ② 배지 기준표 */}
          <div>
            <div className="mb-1 font-medium text-t2">
              ② 배지 판정 기준 <span className="text-t4">(둘 중 나쁜 쪽으로 결정)</span>
            </div>
            <div className="overflow-hidden rounded-sm border border-bg-surface">
              <table className="w-full text-[11px] tabular-nums">
                <thead className="bg-bg-surface">
                  <tr>
                    <th className="px-1.5 py-1 text-left font-normal text-t3">지표</th>
                    <th className="px-1.5 py-1 text-center font-normal text-accent">안정</th>
                    <th className="px-1.5 py-1 text-center font-normal text-warning">주의</th>
                    <th className="px-1.5 py-1 text-center font-normal text-down">드리프트</th>
                  </tr>
                </thead>
                <tbody className="text-t2">
                  <tr className="border-t border-bg-surface">
                    <td className="px-1.5 py-1">
                      β 드리프트 <span className="text-t4">(비율 변화)</span>
                    </td>
                    <td className="px-1.5 py-1 text-center">≤10%</td>
                    <td className="px-1.5 py-1 text-center">10~20%</td>
                    <td className="px-1.5 py-1 text-center">&gt;20%</td>
                  </tr>
                  <tr className="border-t border-bg-surface">
                    <td className="px-1.5 py-1">
                      z 괴리 <span className="text-t4">(레벨 재정착)</span>
                    </td>
                    <td className="px-1.5 py-1 text-center">≤2.0</td>
                    <td className="px-1.5 py-1 text-center">2.0~3.0</td>
                    <td className="px-1.5 py-1 text-center">&gt;3.0</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* ③ 판정 읽는 법 */}
          <div>
            <div className="mb-1 font-medium text-t2">③ 판정 읽는 법</div>
            <ul className="space-y-1">
              <li className="flex gap-1.5">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <span className="text-t3">
                  <span className="text-accent">안정</span> — 관계 튼튼 + 정적·적응 z 동의 →{' '}
                  <span className="text-t2">진짜 회귀 기회</span>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-warning" />
                <span className="text-t3">
                  <span className="text-warning">주의</span> — 관계가 약간 흔들림 →{' '}
                  <span className="text-t2">다른 지표 더 확인</span>
                </span>
              </li>
              <li className="flex gap-1.5">
                <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-down" />
                <span className="text-t3">
                  <span className="text-down">드리프트</span> — 관계 재정착 중 →{' '}
                  <span className="text-t2">z 커도 진입 보류</span>
                </span>
              </li>
            </ul>
          </div>

          {/* ④ 활용 */}
          <div className="rounded-sm bg-accent/10 px-2 py-1.5 text-t2">
            💡 메인 화면 z가 커도, 이 배지가 <span className="font-medium text-accent">안정</span>일 때만
            믿고 진입하세요.
          </div>
        </div>
      )}
    </div>
  )
}

/** β_t 스파크라인 — 순수 SVG (차트 라이브러리 불필요). 정적 β는 점선 기준선. */
function BetaSparkline({
  series,
  betaStatic,
  stability,
}: {
  series: { ts: number; beta: number }[]
  betaStatic: number
  stability: KalmanStat['stability']
}) {
  const W = 100
  const H = 28
  const betas = series.map((p) => p.beta)
  let lo = Math.min(...betas, betaStatic)
  let hi = Math.max(...betas, betaStatic)
  if (hi - lo < 1e-9) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.12
  lo -= pad
  hi += pad
  const n = series.length
  const x = (i: number) => (n === 1 ? 0 : (i / (n - 1)) * W)
  const y = (b: number) => H - ((b - lo) / (hi - lo)) * H
  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)} ${y(p.beta).toFixed(2)}`).join(' ')
  const yStatic = y(betaStatic)
  const stroke =
    stability === 'drift' ? 'var(--color-down)' : stability === 'caution' ? 'var(--color-warning)' : 'var(--color-accent)'

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-7 w-full">
      {/* 정적 β 기준선 */}
      <line x1={0} y1={yStatic} x2={W} y2={yStatic} stroke="var(--color-t4)" strokeWidth={0.5} strokeDasharray="2 2" />
      {/* 적응 β_t */}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
