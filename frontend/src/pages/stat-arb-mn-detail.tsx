import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ResidualHistogram, SpreadChart, ZScoreChart } from '@/components/stat-arb/charts'
import { RelationStabilityPanel } from '@/components/stat-arb/relation-stability-panel'
import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import { classColor, classLabel } from '@/lib/stat-arb/asset-class'
import { groupKindOf, kindLabel } from '@/lib/stat-arb/group-kind'
import { useMarketStore } from '@/stores/marketStore'
import type { ETFTick, StockTick } from '@/types/market'
import type { MnLeg, MnPairDetail, SpreadPoint } from '@/types/stat-arb'

/** detail 로딩 전에도 훅(구독·selector) 의존성이 재생성되지 않도록 고정 빈 배열. */
const NO_LEGS: MnLeg[] = []

/** 평균회귀 deadzone / 표준 진입 임계 — 1:1 상세와 동일 규칙. */
const DEAD_Z = 0.3
const ENTRY_Z = 2.0

/** react-router는 path param을 이미 1회 디코드한다 (`etf%3A278540` → `etf:278540`).
 *  중첩 인코딩·수동 입력 URL도 받도록, 남은 %XX escape가 있을 때만 한 번 더 푼다.
 *  (잘못된 escape면 원문 유지 — URIError로 페이지가 죽지 않게.) */
function decodeParam(v: string | undefined): string {
  if (!v) return ''
  if (!/%[0-9a-fA-F]{2}/.test(v)) return v
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

/** leg 실시간 tick — 1:1 상세와 같은 규칙 (E:만 ETF 스트림, 나머지는 주식 스트림). */
function legTick(
  leg: MnLeg,
  stockTicks: Record<string, StockTick>,
  etfTicks: Record<string, ETFTick>
): StockTick | ETFTick | undefined {
  const code = keyToCode(leg.key)
  return keyType(leg.key) === 'E' ? etfTicks[code] : stockTicks[code]
}

/** 합성 로그가격 Σ w·ln(P). 한 leg라도 가격이 없거나 ≤0이면 null (라이브 미표시).
 *  zustand selector로 쓰므로 반환은 항상 원시값 — 결과가 안 바뀌면 리렌더 없음. */
function synthLogPrice(
  legs: MnLeg[],
  stockTicks: Record<string, StockTick>,
  etfTicks: Record<string, ETFTick>
): number | null {
  if (legs.length === 0) return null
  let sum = 0
  for (const leg of legs) {
    const price = legTick(leg, stockTicks, etfTicks)?.price ?? 0
    if (!(price > 0)) return null
    sum += leg.weight * Math.log(price)
  }
  return Number.isFinite(sum) ? sum : null
}

/** 가격이 들어온 leg 수 — "실시간 3/5" 표기용. */
function countLive(
  legs: MnLeg[],
  stockTicks: Record<string, StockTick>,
  etfTicks: Record<string, ETFTick>
): number {
  let n = 0
  for (const leg of legs) {
    if ((legTick(leg, stockTicks, etfTicks)?.price ?? 0) > 0) n += 1
  }
  return n
}

function fmtDate(tsMs: number): string {
  const d = new Date(tsMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** M:N (Sparse CCA) 페어 상세 — **일봉 전용**.
 *
 *  1:1 상세와 달리 공간이 합성 로그가격이다: X=Σwᵢ·ln Pᵢ, Y=Σvⱼ·ln Pⱼ, 잔차 = Y − α − β·X.
 *  → 스프레드는 원(₩)이 아니라 로그 편차(×100 ≈ % 편차)로 표기하고, 인트라데이 토글이 없다
 *    (leg 3~10개 × 순차 t8412가 실용 불가 — 엔진 `mn_detail.rs` 주석 참조). */
export function StatArbMnDetailPage() {
  const params = useParams<{ group: string; component: string }>()
  const group = decodeParam(params.group)
  const componentIdx = Math.max(1, Number.parseInt(params.component ?? '1', 10) || 1)

  const [detail, setDetail] = useState<MnPairDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!group) {
      setError('group 파라미터가 없습니다')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const qs = new URLSearchParams({ group, component: String(componentIdx) })
    fetch(`/api/stat-arb/mn-pairs/detail?${qs}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text()
          throw new Error(`HTTP ${r.status}: ${body}`)
        }
        return r.json() as Promise<MnPairDetail>
      })
      .then((d) => setDetail(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [group, componentIdx])

  // --- 실시간 구독 · 라이브 z (훅은 early return 앞에 모두) ---
  const xLegs = detail?.x_legs ?? NO_LEGS
  const yLegs = detail?.y_legs ?? NO_LEGS
  const allLegs = useMemo(() => [...xLegs, ...yLegs], [xLegs, yLegs])
  const subCodes = useMemo(() => allLegs.map((l) => keyToCode(l.key)).filter(Boolean), [allLegs])
  usePageStockSubscriptions(subCodes)

  const liveX = useMarketStore(
    useCallback((s) => synthLogPrice(xLegs, s.stockTicks, s.etfTicks), [xLegs])
  )
  const liveY = useMarketStore(
    useCallback((s) => synthLogPrice(yLegs, s.stockTicks, s.etfTicks), [yLegs])
  )
  const liveLegs = useMarketStore(
    useCallback((s) => countLive(allLegs, s.stockTicks, s.etfTicks), [allLegs])
  )

  // 스프레드 차트용 — 로그 잔차를 ×100 (≈ 균형 대비 % 편차)해 축이 0으로 뭉개지지 않게.
  const spreadPct = useMemo<SpreadPoint[]>(
    () => (detail?.spread_series ?? []).map((p) => ({ ...p, spread: p.spread * 100 })),
    [detail]
  )

  if (loading) {
    return <div className="p-4 text-sm text-t3">로딩 중…</div>
  }
  if (error || !detail) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <Link to="/stat-arb/mn" className="text-xs text-accent hover:underline">
          ← M:N 페어 목록
        </Link>
        <div className="text-sm text-down">상세 로딩 실패: {error ?? 'unknown'}</div>
      </div>
    )
  }

  // 라이브 잔차 = Y_live − α − β·X_live. 한 leg라도 가격 없으면 liveX/liveY가 null → 미표시.
  const liveResid =
    liveX != null && liveY != null ? liveY - detail.alpha - detail.hedge_ratio * liveX : null
  const liveZ =
    liveResid != null && detail.resid_std > 0
      ? (liveResid - detail.resid_mean) / detail.resid_std
      : null

  const series = detail.spread_series
  const lastPoint = series.length ? series[series.length - 1] : null
  const dbZ = lastPoint ? lastPoint.z : detail.z_score
  const dbResid = lastPoint ? lastPoint.spread : detail.resid_mean
  const displayZ = liveZ ?? dbZ
  const displayResid = liveResid ?? dbResid
  const zCls =
    Math.abs(displayZ) >= 2.5 ? 'text-warning' : Math.abs(displayZ) >= 1.5 ? 'text-t1' : 'text-t3'

  // 평균회귀 방향 — 잔차 = Y − α − β·X 이므로 z>0 = Y 바스켓이 비쌈 → 숏 Y / 롱 X.
  const neutral = Math.abs(displayZ) < DEAD_Z
  const longSide = displayZ >= DEAD_Z ? 'X' : 'Y'
  const shortSide = displayZ >= DEAD_Z ? 'Y' : 'X'
  const atEntry = Math.abs(displayZ) >= ENTRY_Z

  const kind = groupKindOf(detail.group_id)
  const lastDate = lastPoint ? fmtDate(lastPoint.ts) : '—'

  return (
    <div className="flex flex-col gap-1 p-1">
      {/* 헤더 */}
      <div className="panel flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
        <Link to="/stat-arb/mn" className="text-xs text-accent hover:underline">
          ← M:N 페어 목록
        </Link>
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <span className="rounded-sm bg-bg-surface px-1.5 py-0.5 text-[11px] text-t3">
            {kindLabel(kind)}
          </span>
          <span className="text-sm font-medium text-t1">{detail.group_name}</span>
          <span
            className="rounded-sm bg-bg-surface px-1.5 py-0.5 text-[11px] text-t3"
            title={`같은 그룹의 ${detail.component_idx}번째 성분 — 앞 성분이 쓴 종목을 후보에서 뺀 뒤 다시 찾은 축`}
          >
            #{detail.component_idx}
          </span>
          {detail.split_factor > 0 && (
            <span
              className="rounded-sm bg-blue/15 px-1.5 py-0.5 text-[11px] text-blue"
              title={`PCA factor ${detail.split_factor} 부호로 양변 분할 (시장 공통 팩터 제거 축)`}
            >
              F{detail.split_factor}
            </span>
          )}
          <span className="text-[11px] text-t4">{detail.group_id}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-t3 tabular-nums">
          <span
            className="rounded-sm bg-bg-surface px-1.5 py-0.5"
            title="M:N 상세는 일봉 전용 — leg가 3~10개라 인트라데이(순차 t8412)는 레이턴시상 불가. 판단 지평(half-life 수일~수십일)도 일봉과 정합."
          >
            일봉 기준
          </span>
          <span>최종 {lastDate}</span>
          {liveZ != null ? (
            <span className="text-accent">
              실시간 {liveLegs}/{allLegs.length}
            </span>
          ) : (
            <span
              className="text-t4"
              title="leg 중 하나라도 현재가가 없으면(장외·미연결·거래정지) 라이브 z를 계산하지 않는다 — DB 마지막 일봉 z로 표시."
            >
              장외/미연결 · 실시간 {liveLegs}/{allLegs.length}
            </span>
          )}
        </div>
      </div>

      {/* KPI 4개 */}
      <div className="panel grid grid-cols-2 gap-2 p-3 md:grid-cols-4">
        <KpiCard
          label={`현재 z · 일봉 (${liveZ != null ? '실시간' : 'DB 마지막'})`}
          value={`${displayZ >= 0 ? '+' : ''}${displayZ.toFixed(2)}`}
          cls={zCls}
        />
        <KpiCard
          label="ADF (잔차 정상성)"
          value={detail.adf_tstat.toFixed(2)}
          cls={detail.adf_tstat <= -3 ? 'text-up' : 'text-t3'}
        />
        <KpiCard
          label="R² (합성 회귀 설명력)"
          value={detail.r_squared.toFixed(3)}
          cls={detail.r_squared >= 0.9 ? 'text-up' : 'text-t1'}
        />
        <KpiCard
          label="half-life (거래일)"
          value={detail.half_life > 0 ? `${detail.half_life.toFixed(1)}일` : '—'}
          cls={detail.half_life > 0 && detail.half_life <= 30 ? 'text-t1' : 'text-t3'}
        />
      </div>

      <div className="grid grid-cols-1 gap-1 lg:grid-cols-5">
        {/* 좌측 — 바스켓 · 안정성 · 통계 */}
        <div className="flex flex-col gap-1 lg:col-span-2">
          {/* 바스켓 구성 */}
          <div className="panel p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-t1">바스켓 구성</span>
              <span className="text-[11px] text-t3">
                잔차 = Y − α − β·X (합성 로그가격)
              </span>
              <span className="ml-auto">
                {neutral ? (
                  <span className="rounded-sm bg-bg-surface px-1.5 py-0.5 text-[11px] text-t3">
                    중립 · 평균 근처
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-bg-surface px-1.5 py-0.5 text-[11px]">
                    <span className="font-semibold text-up">롱 {longSide} 바스켓</span>
                    <span className="text-t3">/</span>
                    <span className="font-semibold text-down">숏 {shortSide} 바스켓</span>
                    {atEntry && <span className="ml-0.5 font-semibold text-warning">진입권</span>}
                  </span>
                )}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <BasketPanel title="X · 헤지측 (×β)" legs={xLegs} live={liveX} last={lastPoint?.left} />
              <BasketPanel title="Y · 기준측" legs={yLegs} live={liveY} last={lastPoint?.right} />
            </div>
            <div className="mt-2 leading-relaxed text-t4 text-[11px]">
              weight는 <span className="text-t3">CCA 가중치(로그가격 계수)</span>이지{' '}
              <span className="font-medium text-t2">주수가 아니다</span>.
              실행 시 명목금액 비중 ∝ Y측 vⱼ : X측 β·wᵢ (β = {detail.hedge_ratio.toFixed(4)}) — 로그
              공간이라 &ldquo;금액 비중&rdquo;으로 읽는다.
            </div>
          </div>

          {/* 관계 안정성 (Kalman) — 없으면 숨김 */}
          {detail.kalman && <RelationStabilityPanel k={detail.kalman} />}

          {/* 통계 요약 */}
          <div className="panel p-3 text-xs">
            <div className="mb-2 text-sm font-medium text-t1">통계 요약</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 tabular-nums">
              <StatRow label="표본 (일봉)" value={`${detail.sample_size}봉`} />
              <StatRow
                label="제외 봉"
                value={`${detail.skipped_bars}봉`}
                cls={detail.skipped_bars > 0 ? 'text-warning' : 'text-t2'}
                title="leg 공통 거래일 중 가격 결측(adj_close ≤ 0)으로 회귀에서 제외된 봉 수. Finance_Data 수정주가는 2024-04-23 이전이 NULL이라 그 구간이 통째로 빠질 수 있다. 발굴(목록)은 이 봉을 ln(0)→0으로 그냥 쓰므로 목록과 상세의 R²·ADF가 다를 수 있고, 상세 쪽이 실데이터 기준이다."
              />
              <StatRow
                label="corr (합성 Δ)"
                value={detail.corr.toFixed(3)}
                title="합성 X·Y의 일간 로그수익률(=차분) Pearson 상관 — 상세에서 재계산한 값."
              />
              <StatRow
                label="CCA corr"
                value={detail.cca_correlation.toFixed(3)}
                title="발굴 시점 Sparse CCA canonical correlation (양변 가중치를 뽑은 그 축의 상관)."
              />
              <StatRow label="α" value={detail.alpha.toFixed(4)} />
              <StatRow label="β (헤지비율)" value={detail.hedge_ratio.toFixed(4)} />
              <StatRow
                label="잔차 σ"
                value={detail.resid_std.toFixed(4)}
                title="로그 공간 잔차 표준편차. z = (잔차 − μ) / σ. ×100 ≈ % 편차."
              />
              <StatRow
                label="현재 잔차"
                value={`${displayResid >= 0 ? '+' : ''}${(displayResid * 100).toFixed(2)}%`}
                cls={Math.abs(displayZ) >= 2 ? 'text-warning' : 'text-t2'}
                title="균형(Y = α + β·X) 대비 Y 바스켓의 편차. 로그 잔차 ×100 ≈ % 프리미엄."
              />
            </div>
          </div>
        </div>

        {/* 우측 — 차트 3개 */}
        <div className="flex flex-col gap-1 lg:col-span-3">
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              z-score 시계열 + ±1·±2σ 밴드 · 현재{' '}
              <span className={zCls}>
                {displayZ >= 0 ? '+' : ''}
                {displayZ.toFixed(2)}
              </span>
              {liveZ != null && <span className="ml-1 text-[11px] text-accent">실시간</span>}
              {!neutral && (
                <span className="ml-2">
                  → <span className="font-semibold text-up">롱 {longSide}</span>
                  <span className="text-t3"> / </span>
                  <span className="font-semibold text-down">숏 {shortSide}</span>
                  {atEntry && <span className="ml-1 text-warning">· 진입권</span>}
                </span>
              )}
            </div>
            <div className="h-[260px]">
              <ZScoreChart data={series} live={liveZ} daily />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              스프레드 (로그 잔차 ×100 ≈ 균형 대비 % 편차) · Y − α − β·X
            </div>
            <div className="h-[260px]">
              <SpreadChart
                data={spreadPct}
                live={liveResid != null ? liveResid * 100 : null}
                daily
                precision={2}
                unit="%"
              />
            </div>
          </div>
          <div className="panel p-3">
            <div className="mb-2 text-xs text-t3">
              잔차 분포 (σ 단위) · 평균 0 · ±1σ/±2σ · 현재 빨강
            </div>
            <div className="h-[260px]">
              <ResidualHistogram
                bins={detail.histogram}
                center={detail.spread_center}
                scale={detail.spread_scale}
                currentZ={displayZ}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 한쪽 바스켓 leg 목록 — 종목명·코드·class 배지·가중치 + 실시간 가격.
 *  헤더에 합성값 Σw·ln(P) — 실시간(전 leg 수신)이면 accent, 아니면 마지막 일봉 값. */
function BasketPanel({
  title,
  legs,
  live,
  last,
}: {
  title: string
  legs: MnLeg[]
  live: number | null
  last?: number
}) {
  const synth = live ?? last
  return (
    <div className="rounded-sm bg-bg-surface/40 p-2">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]">
        <span className="text-t3">
          {title} <span className="text-t4 tabular-nums">· {legs.length} leg</span>
        </span>
        <span
          className={`tabular-nums ${live != null ? 'text-accent' : 'text-t4'}`}
          title="합성 로그가격 Σ w·ln(P). 실시간은 전 leg 현재가 수신 시에만, 아니면 마지막 일봉 값."
        >
          Σw·lnP {synth != null ? synth.toFixed(4) : '—'}
        </span>
      </div>
      {legs.length === 0 ? (
        <div className="py-1 text-[11px] text-t4">leg 없음</div>
      ) : (
        <ul className="space-y-0.5 text-xs tabular-nums">
          {legs.map((l) => (
            <LegRow key={l.key} leg={l} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** leg 한 줄 — 실시간 가격은 이 행만 리렌더 (leg별 selector). */
function LegRow({ leg }: { leg: MnLeg }) {
  const code = keyToCode(leg.key)
  const isEtf = keyType(leg.key) === 'E'
  const tick = useMarketStore((s) => (isEtf ? s.etfTicks[code] : s.stockTicks[code]))
  const price = tick?.price ?? 0
  const prev = tick?.prev_close
  const hasChg = prev != null && prev > 0 && price > 0
  const chgPct = hasChg ? ((price - prev) / prev) * 100 : 0

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 border-b border-bg-surface/60 py-1 last:border-0">
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="text-t4">{code}</span>
        <span className="text-t1">{leg.name}</span>
        {leg.class && (
          <span className={`rounded-sm bg-bg-base px-1 py-px text-[11px] ${classColor(leg.class)}`}>
            {classLabel(leg.class)}
          </span>
        )}
      </span>
      <span className="flex items-baseline gap-2 whitespace-nowrap">
        <span className="text-t3">{price > 0 ? price.toLocaleString() : '—'}</span>
        {hasChg && (
          <span className={chgPct > 0 ? 'text-up' : chgPct < 0 ? 'text-down' : 'text-t3'}>
            {chgPct > 0 ? '▲' : chgPct < 0 ? '▼' : ''}
            {Math.abs(chgPct).toFixed(2)}%
          </span>
        )}
        <span className={leg.weight >= 0 ? 'text-up' : 'text-down'} title="CCA 가중치 (주수 아님)">
          {leg.weight >= 0 ? '+' : ''}
          {leg.weight.toFixed(3)}
        </span>
      </span>
    </li>
  )
}

function KpiCard({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="rounded-sm bg-bg-surface px-3 py-2">
      <div className="text-[11px] text-t3">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  )
}

/** 통계 요약 한 줄 — 라벨(툴팁 있으면 점선 밑줄) + 값. */
function StatRow({
  label,
  value,
  cls = 'text-t2',
  title,
}: {
  label: string
  value: string
  cls?: string
  title?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span
        className={
          title
            ? 'cursor-help text-t3 underline decoration-t4 decoration-dotted underline-offset-2'
            : 'text-t3'
        }
        title={title}
      >
        {label}
      </span>
      <span className={cls}>{value}</span>
    </div>
  )
}
