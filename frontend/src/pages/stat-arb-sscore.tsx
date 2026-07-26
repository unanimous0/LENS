import { useEffect, useMemo, useState } from 'react'

import { keyToCode } from '@/lib/stat-arb-keys'
import { classColor, classLabel } from '@/lib/stat-arb/asset-class'
import { cn } from '@/lib/utils'

/**
 * 팩터중립 s-score (Avellaneda-Lee 2010) 화면.
 *
 * 1:1 / M:N 발굴과 독립된 별도 트랙 — "A vs B"가 아니라 "A vs A의 팩터 노출"을 본다.
 * 엔진(`stat-arb-engine/src/sscore.rs`)이 recompute 사이클마다 1회 계산해 보관한 결과를
 * 필터·정렬만 해서 받아온다.
 */
type FactorBeta = {
  factor_idx: number
  /** 총노출 1 eigenportfolio 대비 회귀계수(= 그 팩터 포트폴리오에 대한 헤지비율). */
  beta: number
  /** β × σ_F — 팩터 1σ 이동당 종목 일간수익률 기여. 정렬 기준(β 단독은 저변동 팩터 착시). */
  contrib: number
}

type SScoreItem = {
  key: string
  code: string
  name: string
  asset_class: string
  s_score: number
  /** 영업일 단위 */
  half_life: number
  /** 연율 (1/년) */
  kappa: number
  r_squared: number
  /** 잔차 일간 변동성 (수익률 단위) */
  resid_vol: number
  top_factors: FactorBeta[]
  sample_size: number
  updated_ms: number
}

type FactorInfo = {
  n_factors: number
  explained_variance_ratio: number[]
  /** 팩터별 일간 변동성 σ_F (회귀창 기준). */
  factor_vol: number[]
  corr_window: number
  reg_window: number
  universe_size: number
}

type SScoresResp = {
  total: number
  filtered: number
  returned: number
  last_run_ms: number
  duration_ms: number
  factors: FactorInfo
  items: SScoreItem[]
}

type AssetFilter = 'any' | 'stock' | 'etf'
type SortKey = 's' | 'hl' | 'r2' | 'vol' | 'name'

const COL_TOOLTIPS: Record<string, string> = {
  s: 's-score — 팩터로 설명되는 부분을 걷어낸 고유 잔차가 평형 대비 몇 σ 떨어져 있는지. 음수=쌈(매수 후보) / 양수=비쌈(매도 후보)',
  hl: '고유 잔차가 평형으로 절반쯤 되돌아오는 데 걸리는 기간 (영업일)',
  kappa: '평균회귀 속도 κ (연율). half-life = ln2 ÷ (κ/252) 일',
  r2: '팩터 회귀 결정계수 — 이 종목 움직임이 공통 팩터로 얼마나 설명되나. 높을수록 고유 알파가 적다',
  vol: '잔차 일간 변동성 σ_ε — 팩터 제거 후 남는 자기 변동성',
  factors:
    '이 종목을 가장 크게 움직이는 팩터. 값 = 팩터가 1σ 움직일 때 종목 일간수익률 기여(%p). 호버하면 회귀계수 β. F1은 시장 팩터',
  sample: '팩터 회귀에 쓰인 표본 수 (영업일)',
}

export function StatArbSScorePage() {
  const [items, setItems] = useState<SScoreItem[]>([])
  const [meta, setMeta] = useState<{
    total: number
    filtered: number
    last_run_ms: number
    duration_ms: number
  }>({ total: 0, filtered: 0, last_run_ms: 0, duration_ms: 0 })
  const [factors, setFactors] = useState<FactorInfo | null>(null)
  const [minAbsS, setMinAbsS] = useState<string>('0')
  const [maxHl, setMaxHl] = useState<string>('')
  const [asset, setAsset] = useState<AssetFilter>('any')
  const [search, setSearch] = useState<string>('')
  const [sortKey, setSortKey] = useState<SortKey>('s')
  const [sortAsc, setSortAsc] = useState<boolean>(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showGuide, setShowGuide] = useState(false)

  // 서버 필터(|s| 하한 / half-life 상한 / 자산군)가 바뀌면 재요청. 검색·정렬은 클라이언트.
  // 새로고침 버튼은 reloadKey 를 올려 같은 경로를 탄다 (in-flight 요청은 abort).
  const [reloadKey, setReloadKey] = useState(0)
  useEffect(() => {
    const ctrl = new AbortController()
    const run = async () => {
      setLoading(true)
      setError(null)
      const params = new URLSearchParams({ limit: '1000' })
      const minS = Number(minAbsS)
      if (isFinite(minS) && minS > 0) params.set('min_abs_s', String(minS))
      const hl = Number(maxHl)
      if (maxHl.trim() && isFinite(hl) && hl > 0) params.set('max_half_life', String(hl))
      if (asset !== 'any') params.set('asset', asset)
      try {
        const r = await fetch(`/api/stat-arb/s-scores?${params}`, { signal: ctrl.signal })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d: SScoresResp = await r.json()
        setItems(d.items)
        setFactors(d.factors)
        setMeta({
          total: d.total,
          filtered: d.filtered,
          last_run_ms: d.last_run_ms,
          duration_ms: d.duration_ms,
        })
      } catch (e) {
        if (ctrl.signal.aborted) return
        setError(String(e))
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }
    void run()
    return () => ctrl.abort()
  }, [minAbsS, maxHl, asset, reloadKey])

  const visible = useMemo(() => {
    const s = search.trim().toLowerCase()
    const filtered = s
      ? items.filter(
          (it) => it.name.toLowerCase().includes(s) || it.code.toLowerCase().includes(s)
        )
      : items
    const dir = sortAsc ? 1 : -1
    const val = (it: SScoreItem): number => {
      switch (sortKey) {
        case 's':
          return Math.abs(it.s_score)
        case 'hl':
          return it.half_life
        case 'r2':
          return it.r_squared
        case 'vol':
          return it.resid_vol
        default:
          return 0
      }
    }
    const sorted = [...filtered]
    if (sortKey === 'name') {
      sorted.sort((a, b) => dir * a.name.localeCompare(b.name, 'ko'))
    } else {
      sorted.sort((a, b) => dir * (val(a) - val(b)))
    }
    return sorted
  }, [items, search, sortKey, sortAsc])

  const lastRunStr = useMemo(() => {
    if (!meta.last_run_ms) return '—'
    return new Date(meta.last_run_ms).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }, [meta.last_run_ms])

  const signalCount = useMemo(
    () => visible.filter((it) => Math.abs(it.s_score) >= 2).length,
    [visible]
  )

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortAsc((v) => !v)
    else {
      setSortKey(k)
      setSortAsc(k === 'name')
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {/* 컨트롤 */}
      <div className="panel flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-t3" title="|s-score| 하한. 2 이상이 통상 진입 후보">
            |s| 최소
          </span>
          <input
            type="number"
            step="0.5"
            min="0"
            value={minAbsS}
            onChange={(e) => setMinAbsS(e.target.value)}
            className="w-[70px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 tabular-nums focus:outline-none"
          />
          <div className="flex items-center gap-1">
            {/* 1.25 = AL 원논문 진입 임계, 2 = 보수적 컷 */}
            {['0', '1.25', '2'].map((v) => (
              <button
                key={v}
                onClick={() => setMinAbsS(v)}
                className={cn(
                  'rounded-sm px-2 py-1 text-[11px]',
                  minAbsS === v ? 'bg-blue/25 text-blue' : 'bg-bg-surface text-t3 hover:text-t1'
                )}
              >
                {v === '0' ? '전체' : `≥${v}`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-t3" title="half-life 상한 (영업일)">
            half-life 상한
          </span>
          <input
            type="number"
            step="1"
            min="0"
            value={maxHl}
            onChange={(e) => setMaxHl(e.target.value)}
            placeholder="제한 없음"
            className="w-[90px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 tabular-nums placeholder:text-t4 focus:outline-none"
          />
          <span className="text-[11px] text-t4">일</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">자산군</span>
          <div className="flex items-center gap-1">
            {(
              [
                ['any', '전체'],
                ['stock', '주식'],
                ['etf', 'ETF'],
              ] as [AssetFilter, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setAsset(v)}
                className={cn(
                  'rounded-sm px-2 py-1 text-[11px]',
                  asset === v ? 'bg-blue/25 text-blue' : 'bg-bg-surface text-t3 hover:text-t1'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-t3">검색</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="종목명 / 코드"
            className="w-[180px] rounded-sm bg-bg-surface px-2 py-1 text-xs text-t1 placeholder:text-t4 focus:outline-none"
          />
        </div>

        <div className="ml-auto flex items-center gap-3 text-xs text-t3 tabular-nums">
          <span>
            전체 {meta.total} / 표시 <span className="text-t1">{visible.length}</span>
            {signalCount > 0 && <span className="ml-1 text-warning">(|s|≥2 {signalCount})</span>}
          </span>
          <span title={`엔진 계산 소요 ${meta.duration_ms}ms`}>갱신 {lastRunStr}</span>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            className="rounded-sm bg-accent/20 px-3 py-1 text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {loading ? '...' : '새로고침'}
          </button>
          <button
            onClick={() => setShowGuide((v) => !v)}
            className={cn(
              'rounded-sm px-3 py-1',
              showGuide ? 'bg-blue/25 text-blue' : 'bg-bg-surface text-t1'
            )}
            title="s-score를 어떻게 읽는지 설명"
          >
            읽는 법 {showGuide ? '▴' : '▾'}
          </button>
        </div>
      </div>

      {error && <div className="panel p-3 text-xs text-down">{error}</div>}

      {showGuide && <GuidePanel factors={factors} />}

      {/* 팩터 요약 한 줄 */}
      {factors && (
        <div className="panel flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[11px] text-t3 tabular-nums">
          <span>
            팩터 <span className="text-t1">{factors.n_factors}</span>개
          </span>
          <span>
            상관창 <span className="text-t2">{factors.corr_window}</span>일 · 회귀창{' '}
            <span className="text-t2">{factors.reg_window}</span>일
          </span>
          <span>
            대상 <span className="text-t2">{factors.universe_size}</span>종목
          </span>
          <span className="flex items-center gap-1">
            설명력
            {factors.explained_variance_ratio.slice(0, 5).map((v, i) => (
              <span key={i} className="text-t2">
                F{i + 1} {(v * 100).toFixed(1)}%
              </span>
            ))}
            <span className="text-t4">
              · 누적{' '}
              {(factors.explained_variance_ratio.reduce((a, b) => a + b, 0) * 100).toFixed(1)}%
            </span>
          </span>
        </div>
      )}

      {/* 테이블 */}
      <div className="panel overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-bg-primary">
            <tr className="border-b border-bg-surface text-left text-t3">
              <Th onClick={() => toggleSort('name')} active={sortKey === 'name'} asc={sortAsc}>
                종목
              </Th>
              <Th
                onClick={() => toggleSort('s')}
                active={sortKey === 's'}
                asc={sortAsc}
                title={COL_TOOLTIPS.s}
                align="right"
              >
                s-score
              </Th>
              <Th
                onClick={() => toggleSort('hl')}
                active={sortKey === 'hl'}
                asc={sortAsc}
                title={COL_TOOLTIPS.hl}
                align="right"
              >
                half-life
              </Th>
              <Th title={COL_TOOLTIPS.kappa} align="right">
                κ
              </Th>
              <Th
                onClick={() => toggleSort('r2')}
                active={sortKey === 'r2'}
                asc={sortAsc}
                title={COL_TOOLTIPS.r2}
                align="right"
              >
                R²
              </Th>
              <Th
                onClick={() => toggleSort('vol')}
                active={sortKey === 'vol'}
                asc={sortAsc}
                title={COL_TOOLTIPS.vol}
                align="right"
              >
                잔차변동성
              </Th>
              <Th title={COL_TOOLTIPS.factors}>주요 팩터</Th>
              <Th title={COL_TOOLTIPS.sample} align="right">
                표본
              </Th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-t4">
                  조건에 맞는 종목 없음
                </td>
              </tr>
            )}
            {visible.map((it, i) => (
              <Row key={it.key} item={it} zebra={i % 2 === 1} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({
  children,
  onClick,
  active,
  asc,
  title,
  align = 'left',
}: {
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  asc?: boolean
  title?: string
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={cn(
        'px-3 py-2 font-normal',
        align === 'right' && 'text-right',
        onClick && 'cursor-pointer select-none hover:text-t1',
        active && 'text-t1'
      )}
      onClick={onClick}
      title={title}
    >
      {children}
      {active && <span className="ml-0.5 text-t4">{asc ? '▲' : '▼'}</span>}
    </th>
  )
}

function Row({ item, zebra }: { item: SScoreItem; zebra: boolean }) {
  const s = item.s_score
  const strong = Math.abs(s) >= 2
  return (
    <tr
      className={cn(
        'border-b border-bg-surface/40 hover:bg-bg-surface/40',
        zebra && 'bg-bg-surface/15'
      )}
    >
      <td className="px-3 py-2">
        <span className="text-t4">{keyToCode(item.key)}</span>{' '}
        <span className="text-t1">{item.name}</span>
        {item.asset_class && (
          <span
            className={cn(
              'ml-1 rounded-sm bg-bg-surface px-1 text-[11px]',
              classColor(item.asset_class)
            )}
          >
            {classLabel(item.asset_class)}
          </span>
        )}
      </td>
      <td
        className={cn(
          'px-3 py-2 text-right',
          strong ? (s > 0 ? 'font-semibold text-down' : 'font-semibold text-up') : 'text-t2'
        )}
        title={
          strong
            ? s > 0
              ? '팩터 대비 비쌈 — 매도 후보 (헤지: 지수선물/팩터 ETF 매수)'
              : '팩터 대비 쌈 — 매수 후보 (헤지: 지수선물/팩터 ETF 매도)'
            : undefined
        }
      >
        {s >= 0 ? '+' : ''}
        {s.toFixed(2)}
      </td>
      <td className="px-3 py-2 text-right text-t2">{item.half_life.toFixed(1)}일</td>
      <td className="px-3 py-2 text-right text-t3">{item.kappa.toFixed(0)}</td>
      <td
        className={cn(
          'px-3 py-2 text-right',
          item.r_squared >= 0.8 ? 'text-blue' : item.r_squared >= 0.5 ? 'text-t2' : 'text-t3'
        )}
        title={
          item.r_squared >= 0.8
            ? '팩터로 대부분 설명되는 시장 대용형 — 고유 알파가 적다'
            : undefined
        }
      >
        {item.r_squared.toFixed(3)}
      </td>
      <td className="px-3 py-2 text-right text-t3">{(item.resid_vol * 100).toFixed(2)}%</td>
      <td className="px-3 py-2 text-t3">
        {item.top_factors.slice(0, 2).map((f, i) => (
          <span
            key={f.factor_idx}
            className={cn(i > 0 && 'ml-2')}
            title={`β ${f.beta.toFixed(2)} · 팩터 1σ 이동당 기여 ${(f.contrib * 100).toFixed(2)}%p/일${
              f.factor_idx === 0 ? ' (F1 = 시장 팩터)' : ''
            }`}
          >
            <span className="text-t4">F{f.factor_idx + 1}</span>{' '}
            <span className={f.contrib >= 0 ? 'text-t2' : 'text-warning'}>
              {f.contrib >= 0 ? '+' : ''}
              {(f.contrib * 100).toFixed(2)}%
            </span>
          </span>
        ))}
      </td>
      <td className="px-3 py-2 text-right text-t4">{item.sample_size}</td>
    </tr>
  )
}

/** 해석 안내 — 통계 배경 없이도 읽히게. 접이식(기본 접힘). */
function GuidePanel({ factors }: { factors: FactorInfo | null }) {
  return (
    <div className="panel p-5">
      <div className="mb-1 text-base font-semibold text-t1">
        📐 s-score 읽는 법 — 이 종목만의 움직임이 얼마나 벌어졌나
      </div>

      <p className="mt-3 text-sm leading-relaxed text-t2">
        s-score는 이 종목이 <span className="font-semibold text-t1">자기 팩터 노출 대비</span>{' '}
        얼마나 싸거나 비싼가를 나타냅니다. 시장이 다 같이 오르내리는 공통 부분(시장·섹터)을
        걷어내고, <span className="font-semibold text-accent">그 종목만의 움직임</span>이 평소
        수준에서 몇 σ 벌어졌는지 잰 값입니다.
      </p>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <div className="rounded-sm bg-bg-surface p-4">
          <div className="mb-2 text-sm font-semibold text-t1">① 공통 부분을 걷어낸다</div>
          <p className="text-sm leading-relaxed text-t3">
            최근 <span className="text-t2">{factors?.corr_window ?? 252}영업일</span> 수익률로 전
            종목의 공통 움직임을 <span className="text-t2">{factors?.n_factors ?? 15}개 팩터</span>
            로 압축합니다(PCA). F1은 대체로 시장 전체, 그 뒤는 섹터·스타일 축입니다.
          </p>
        </div>
        <div className="rounded-sm bg-bg-surface p-4">
          <div className="mb-2 text-sm font-semibold text-t1">② 남은 것만 본다</div>
          <p className="text-sm leading-relaxed text-t3">
            최근 <span className="text-t2">{factors?.reg_window ?? 60}영업일</span> 동안 종목
            수익률을 팩터로 회귀해 남는 잔차(고유 수익)를 누적합니다. 이 누적 경로가 평소 수준으로
            되돌아오는 성질(평균회귀)을 갖는 종목만 목록에 남깁니다.
          </p>
        </div>
        <div className="rounded-sm bg-bg-surface p-4">
          <div className="mb-2 text-sm font-semibold text-t1">③ 벌어진 정도를 σ로 잰다</div>
          <p className="text-sm leading-relaxed text-t3">
            지금 위치가 평형에서 몇 σ 떨어졌나 = s-score.{' '}
            <span className="text-up">s &lt; −2</span>면 팩터 대비 과도하게 싸고(매수 후보),{' '}
            <span className="text-down">s &gt; +2</span>면 비쌉니다(매도 후보). 원논문 기준 진입은{' '}
            <span className="text-t2">±1.25</span>, 청산은 <span className="text-t2">±0.5~0.75</span>{' '}
            부근입니다.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-sm bg-bg-surface/50 p-4">
          <div className="mb-2 text-sm font-semibold text-t2">컬럼 읽기</div>
          <ul className="space-y-1 text-sm leading-relaxed text-t3">
            <li>
              <span className="text-t2">half-life</span> — 벌어진 게 절반쯤 되돌아오는 데 보통
              걸리는 기간(영업일). 짧을수록 회전이 빠릅니다.
            </li>
            <li>
              <span className="text-t2">R²</span> — 팩터로 설명되는 비율. 높으면 시장 대용형(고유
              알파가 적음), 낮으면 그 종목 고유 움직임이 큽니다.
            </li>
            <li>
              <span className="text-t2">잔차변동성</span> — 팩터 제거 후 남는 일간 변동성. 같은 s라도
              이 값이 크면 실제 가격 괴리 폭이 큽니다.
            </li>
            <li>
              <span className="text-t2">주요 팩터</span> — 이 종목을 가장 크게 움직이는 팩터와, 그
              팩터가 1σ 움직일 때의 일간수익률 기여. 호버하면 회귀계수 β(그 팩터 포트폴리오 대비
              헤지비율)가 나옵니다. F1은 시장 팩터라 헤지 수량 감각을 잡을 때 씁니다.
            </li>
          </ul>
        </div>
        <div className="rounded-sm bg-bg-surface/50 p-4">
          <div className="mb-2 text-sm font-semibold text-t2">1:1 · M:N 발굴과 뭐가 다른가</div>
          <p className="text-sm leading-relaxed text-t3">
            1:1/M:N은 <span className="text-t2">두 자산의 관계</span>(A가 비싸면 B를 반대로)를 찾고,
            헤지 상대가 곧 페어의 반대편입니다. s-score는 상대를 특정하지 않고{' '}
            <span className="text-t2">그 종목의 팩터 노출 자체</span>를 상대로 삼습니다. 그래서 헤지는
            지수선물이나 팩터 ETF로 하고, 여러 종목을 모아 팩터 중립 바스켓으로 운용하는 게 정석입니다.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-t4">
            부수 효과: 시장 대용 바스켓 ETF가 페어 허브로 도배되는 1:1 발굴의 구조적 편향이 원리상
            생기지 않습니다(그런 종목은 R²가 높고 s가 작게 나옴).
          </p>
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-t4">
        근거: Avellaneda &amp; Lee (2010), <i>Statistical Arbitrage in the U.S. Equities Market</i>.
        일봉 수정주가 기준, 평균회귀가 회귀창 대비 너무 느린 종목(half-life 상한)과 팩터로 거의 완전
        복제되는 시리즈(R² 상한)는 목록에서 제외됩니다.
      </p>
    </div>
  )
}
