import { useLpStore } from '@/stores/lpStore'
import { useBasisZscore } from '@/hooks/useBasisZscore'
import type { BasisZFamily, IndexBasisExposure, StockBasisPair } from '@/types/lp'
import { cn } from '@/lib/utils'

/**
 * 베이시스 북 패널 (§13.4 Phase 4).
 *
 * 북 4층 분해(방향/지수 베이시스/종목 베이시스/잔차) 요약 스트립 + 종목 베이시스 페어
 * 테이블 + 지수 베이시스 가족별 행. Rust 8200이 1초 주기로 보내는 basis_book WS를
 * lpStore.basisBook에서 구독. 만기 알림은 패널 내 warning 배지로 (별도 알림 시스템 없이 v1).
 *
 * 배치: BookFourNumbers 바로 아래 (4대 숫자의 확장).
 */

/** 원화 축약 (부호 有). 억/만 단위. */
function fmtKrw(krw: number): string {
  const abs = Math.abs(krw)
  const sign = krw > 0 ? '+' : krw < 0 ? '−' : ''
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}억`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(0)}만`
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`
}

/** 부호 없는 크기 (억/만). */
function fmtSize(krw: number): string {
  const abs = Math.abs(krw)
  if (abs >= 1e8) return `${(abs / 1e8).toFixed(1)}억`
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(0)}만`
  return Math.round(abs).toLocaleString('ko-KR')
}

const fmtBasis = (n: number) =>
  `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}`

const FAMILY_LABEL: Record<string, string> = { k200: 'K200', kq150: 'KQ150' }

const signClass = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-t3')

/** z-score 셀 — |z|≥2 warning 하이라이트. */
function ZCell({ zf }: { zf: BasisZFamily | undefined }) {
  if (!zf || zf.z == null) {
    return <span className="text-t4" title={zf ? `분포 표본 ${zf.n}일` : '데이터 없음'}>-</span>
  }
  const hot = Math.abs(zf.z) >= 2
  return (
    <span
      className={cn(
        hot ? 'text-warning font-medium' : zf.z > 0 ? 'text-up' : 'text-down',
        hot && 'px-1 rounded-sm bg-warning/15',
      )}
      title={`excess ${zf.current_excess?.toFixed(1)} (실측 ${zf.current?.toFixed(1)} − 이론 ${zf.theory_now?.toFixed(1)}) vs 60일 excess ${zf.mean?.toFixed(1)}±${zf.std?.toFixed(1)} (n=${zf.n}, D-${zf.days_to_expiry})`}
    >
      {zf.z >= 0 ? '+' : '−'}
      {Math.abs(zf.z).toFixed(2)}σ
    </span>
  )
}

export function BasisBookPanel() {
  const bb = useLpStore((s) => s.basisBook)
  const zscore = useBasisZscore()

  return (
    <div className="bg-bg-primary">
      {/* 헤더 + 만기 배지 */}
      <div className="px-3 py-2 border-b border-bg-base flex items-center justify-between">
        <div>
          <div className="text-[13px] text-t2 font-medium">베이시스 북 (§13.4)</div>
          <div className="text-[11px] text-t2">북 4층 분해 + 종목·지수 베이시스 추적</div>
        </div>
        {bb?.any_expiry_action && (
          <span className="text-[11px] px-2 py-0.5 rounded-sm bg-warning/15 text-warning font-medium">
            ⚠ 만기 액션 필요
          </span>
        )}
      </div>

      {!bb ? (
        <div className="px-3 py-4 text-xs text-t4">대기 중...</div>
      ) : (
        <>
          {/* ── 4층 분해 요약 스트립 ── */}
          <div className="px-3 py-2.5 flex flex-wrap items-stretch gap-x-5 gap-y-2 border-b border-bg-base">
            <Layer label="① 방향 델타" hint="오버레이 후 잔여">
              <span className={cn('text-[15px] font-mono tabular-nums', signClass(bb.directional_delta_krw))}>
                {fmtKrw(bb.directional_delta_krw)}
              </span>
            </Layer>

            <Layer label="② 지수 베이시스" hint="ETF vs 지수선물">
              {bb.index_basis.filter((e) => e.net_basis_notional_krw !== 0).length === 0 ? (
                <span className="text-[13px] text-t3">-</span>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {bb.index_basis
                    .filter((e) => e.net_basis_notional_krw !== 0)
                    .map((e) => (
                      <div key={e.family} className="text-[13px] font-mono tabular-nums leading-tight">
                        <span className="text-t2">{FAMILY_LABEL[e.family] ?? e.family}</span>{' '}
                        <span className={signClass(e.net_basis_notional_krw)}>
                          {fmtSize(e.net_basis_notional_krw)} {e.net_basis_notional_krw > 0 ? '롱' : '숏'}
                        </span>{' '}
                        <span className="text-t4 text-[11px]">
                          (10bp당 {fmtKrw(e.sensitivity_per_10bp_krw)})
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </Layer>

            <Layer label="③ 종목 베이시스" hint="현물 vs 주식선물">
              <span className="text-[15px] font-mono tabular-nums text-t2">
                {bb.stock_basis_total_krw > 0 ? fmtSize(bb.stock_basis_total_krw) : '-'}
              </span>
            </Layer>

            <Layer label="④ 잔차 1σ" hint="시장 헤지 후 일변동">
              <span className="text-[15px] font-mono tabular-nums text-warning">
                ±{fmtSize(bb.residual_risk_krw)}
              </span>
            </Layer>
          </div>

          {/* ── 지수 베이시스 가족별 ── */}
          {bb.index_basis.length > 0 && (
            <div className="px-3 py-2">
              <div className="text-[11px] text-t3 uppercase tracking-wide mb-1">
                지수 베이시스 (가족별)
                <span className="text-t3 normal-case ml-2">· z-score: 만기 정규화 excess 60일 분포 대비 (월물 혼합 무해)</span>
              </div>
              <table className="w-full text-[11px]">
                <thead className="text-t4 text-[11px]">
                  <tr>
                    <th className="text-left py-1 font-normal">가족</th>
                    <th className="text-right py-1 font-normal">ETF leg</th>
                    <th className="text-right py-1 font-normal">선물 leg</th>
                    <th className="text-right py-1 font-normal">순 베이시스</th>
                    <th className="text-right py-1 font-normal">10bp당</th>
                    <th className="text-right py-1 font-normal">z-score</th>
                    <th className="text-right py-1 font-normal">만기</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {bb.index_basis.map((e) => (
                    <IndexRow key={e.family} e={e} zf={zscore?.families[e.family]} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 종목 베이시스 페어 ── */}
          <div className="px-3 py-2 border-t border-bg-base">
            <div className="text-[11px] text-t3 uppercase tracking-wide mb-1">종목 베이시스 페어</div>
            {bb.stock_basis.length === 0 ? (
              <div className="text-[11px] text-t3 py-2">종목 베이시스 페어 없음 (현물 ↔ 주식선물 반대 포지션 시 자동 인식)</div>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="text-t4 text-[11px]">
                  <tr>
                    <th className="text-left py-1 font-normal">종목</th>
                    <th className="text-right py-1 font-normal">겹침(주)</th>
                    <th className="text-right py-1 font-normal">진입→현재</th>
                    <th className="text-right py-1 font-normal">excess</th>
                    <th className="text-right py-1 font-normal">수렴손익</th>
                    <th className="text-right py-1 font-normal">연환산</th>
                    <th className="text-right py-1 font-normal">만기</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {bb.stock_basis.map((p) => (
                    <StockRow key={p.fut_code} p={p} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Layer({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-between min-w-[120px]">
      <div className="text-[11px] text-t3">{label}</div>
      <div className="my-0.5">{children}</div>
      <div className="text-[10px] text-t3">{hint}</div>
    </div>
  )
}

function IndexRow({ e, zf }: { e: IndexBasisExposure; zf: BasisZFamily | undefined }) {
  const hasPos = e.net_basis_notional_krw !== 0
  return (
    <tr className="border-t border-bg-base/40">
      <td className="py-1 text-t1">{FAMILY_LABEL[e.family] ?? e.family}</td>
      <td className={cn('py-1 text-right', signClass(e.etf_leg_krw))}>{fmtKrw(e.etf_leg_krw)}</td>
      <td className={cn('py-1 text-right', signClass(e.fut_leg_krw))}>{fmtKrw(e.fut_leg_krw)}</td>
      <td className="py-1 text-right">
        {hasPos ? (
          <span className={signClass(e.net_basis_notional_krw)}>
            {fmtSize(e.net_basis_notional_krw)} {e.net_basis_notional_krw > 0 ? '롱' : '숏'}
          </span>
        ) : (
          <span className="text-t4">- (방향)</span>
        )}
      </td>
      <td className={cn('py-1 text-right', signClass(e.sensitivity_per_10bp_krw))}>
        {hasPos ? fmtKrw(e.sensitivity_per_10bp_krw) : '-'}
      </td>
      <td className="py-1 text-right">
        <ZCell zf={zf} />
      </td>
      <td className="py-1 text-right">
        {e.futures_code ? (
          <span className={e.roll_needed ? 'text-warning' : 'text-t3'}>
            D-{e.days_to_expiry}
            {e.roll_needed && <span className="ml-1 text-[10px]">롤</span>}
          </span>
        ) : (
          <span className="text-t4">-</span>
        )}
      </td>
    </tr>
  )
}

function StockRow({ p }: { p: StockBasisPair }) {
  return (
    <tr className="border-t border-bg-base/40">
      <td className="py-1 text-t2">
        <span className="text-t1">{p.base_code}</span>
        {p.name && <span className="text-t4 ml-1 text-[11px]">{p.name}</span>}
        <div className="text-t4 text-[10px] leading-tight">
          현물 {p.spot_qty.toLocaleString('ko-KR')} / 선물 {p.fut_qty.toLocaleString('ko-KR')}
        </div>
      </td>
      <td className="py-1 text-right text-t2">{p.matched_shares.toLocaleString('ko-KR')}</td>
      <td className="py-1 text-right">
        {!p.usable ? (
          <span className="text-t4" title={p.reason}>
            {p.reason || '-'}
          </span>
        ) : (
          <span className="text-t2">
            {p.entry_basis != null ? fmtBasis(p.entry_basis) : '—'}
            <span className="text-t4"> → </span>
            <span className="text-t1">{fmtBasis(p.basis_now)}</span>
          </span>
        )}
      </td>
      <td className={cn('py-1 text-right', p.usable ? signClass(p.excess_now) : 'text-t4')}>
        {p.usable ? fmtBasis(p.excess_now) : '-'}
      </td>
      <td className="py-1 text-right">
        {/* 표시 일관성: 진입→현재를 숨기는 stale/결측이면 수렴손익도 숨김 */}
        {!p.usable || p.convergence_pnl == null ? (
          <span className="text-t4">-</span>
        ) : (
          <span className={signClass(p.convergence_pnl)}>{fmtKrw(p.convergence_pnl)}</span>
        )}
      </td>
      <td className={cn('py-1 text-right', p.usable ? signClass(p.annualized_bp) : 'text-t4')}>
        {p.usable && p.expiry_known
          ? `${p.annualized_bp >= 0 ? '+' : '−'}${Math.abs(p.annualized_bp).toFixed(0)}bp`
          : '-'}
      </td>
      <td className="py-1 text-right">
        {!p.expiry_known ? (
          <span className="text-t4" title="futures_master에 계약 코드 없음 — 만기 확인 불가">
            만기 미상
          </span>
        ) : p.expiry_action_needed ? (
          <span className="text-warning" title="현금결제 — 만기일 현물 leg 처리 필요">
            D-{p.days_to_expiry}
            <div className="text-[10px] leading-tight">현물 leg 처리</div>
          </span>
        ) : (
          <span className="text-t3">D-{p.days_to_expiry}</span>
        )}
      </td>
    </tr>
  )
}
