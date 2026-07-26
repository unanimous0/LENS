import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { usePageStockSubscriptions } from '@/hooks/usePageStockSubscriptions'
import type { StatArbAlertsApi } from '@/hooks/useStatArbAlerts'
import { keyToCode, keyType } from '@/lib/stat-arb-keys'
import {
  DIRECTION_LABELS,
  REARM_RATIO,
  distanceToTarget,
  isHit,
  isRearmed,
  liveZ,
  pairKey,
} from '@/lib/stat-arb/alerts'
import type { StatArbAlert } from '@/lib/stat-arb/alerts'
import { STABILITY_BADGES } from '@/lib/stat-arb/stability'
import { useMarketStore } from '@/stores/marketStore'
import type { PairRow } from '@/types/stat-arb'

/**
 * 목표 z 도달 알림 워치리스트.
 *
 * 감시 원리 — 발굴은 일봉 OLS라 페어의 α·β·μ·σ가 곧 일봉 기준이다. 장중 실시간 가격을
 * 그 회귀식에 넣어 같은 μ·σ로 정규화하면 "일봉 기준 z를 장중에 본 값"이 된다
 * (상세 페이지 '장중' 뷰와 동일 척도).
 *
 * 발화는 **탭이 열려 있는 동안만** — 서버 푸시 아님. 히스테리시스(목표×0.8 안쪽 복귀 시
 * 재무장)로 경계 연타를 막는다.
 */

const SOUND_KEY = 'statarb.alerts.sound'
const OPEN_KEY = 'statarb.alerts.open'
const TICK_MS = 300 // 시세 스냅샷 주기 — 알림 감시엔 충분, 목록 렌더와 분리됨
const TOAST_MS = 15000
const MAX_TOASTS = 4

type ToastItem = { key: number; title: string; body: string }

/** 짧은 2톤 비프 (WebAudio). 오디오 불가 환경·차단은 조용히 무시. */
function beep(ctxRef: { current: AudioContext | null }) {
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    if (!Ctor) return
    if (!ctxRef.current) ctxRef.current = new Ctor()
    const ctx = ctxRef.current
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    const gain = ctx.createGain()
    // 시끄럽지 않게 — peak 0.07, 0.3초.
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3)
    gain.connect(ctx.destination)
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, t0)
    osc.frequency.setValueAtTime(1320, t0 + 0.15)
    osc.connect(gain)
    osc.start(t0)
    osc.stop(t0 + 0.32)
  } catch {
    /* 오디오 정책·미지원 환경 — 토스트/브라우저 알림으로 충분 */
  }
}

/** Notification API 가용 여부 (비보안 origin·구형 브라우저면 없음). */
const canNotify = typeof window !== 'undefined' && 'Notification' in window

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

type WatchRow = {
  alert: StatArbAlert
  stat: PairRow | undefined
  z: number | null
  isLive: boolean
  hit: boolean
  distance: number | null
  leftName: string
  rightName: string
}

export function AlertWatchlist({ api }: { api: StatArbAlertsApi }) {
  const { alerts, error: alertErr, remove, update, recordTrigger } = api

  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== '0')
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== 'off')
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    canNotify ? Notification.permission : 'unsupported'
  )
  const [toasts, setToasts] = useState<ToastItem[]>([])

  // --- 조인용 페어 통계 (α·β·μ·σ) --------------------------------------------
  // 목록 테이블의 pairs는 필터(basis=exclude 등)가 걸려 있어 워치 페어가 빠질 수 있음 →
  // 알림용은 basis=all로 *별도* 1회 조회. 필터 토글에 재요청되지 않는다.
  // 주기 refetch는 없다 — α·β·μ·σ는 3년 *일봉* 회귀라 장중엔 값이 바뀌지 않는다(엔진 cron이
  // 돌아도 입력 일봉이 동일). 장 마감 후 갱신분은 '통계 새로고침' 버튼 / 페이지 재진입으로.
  const [statMap, setStatMap] = useState<Map<string, PairRow>>(new Map())
  const [statAt, setStatAt] = useState<number>(0)
  const [statErr, setStatErr] = useState<string | null>(null)
  const [statLoading, setStatLoading] = useState(false)
  // 조회를 이미 시도한 알림 키 — 엔진 결과에 없는 페어에서 무한 재요청 방지.
  const attemptedRef = useRef<Set<string>>(new Set())

  // setState는 promise 콜백 안에서만 — effect에서 호출해도 동기 cascading render가 없게.
  // (버튼 경로는 호출 직전에 setStatLoading(true)로 로딩 표시)
  const loadStats = useCallback((list: StatArbAlert[]) => {
    if (list.length === 0) return
    const want = new Set(list.map((a) => pairKey(a.left_key, a.right_key)))
    list.forEach((a) => attemptedRef.current.add(pairKey(a.left_key, a.right_key)))
    // limit은 '전체' 의미 — 워치 페어가 score 하위여도 반드시 조인되게 (엔진 통과 1.1만).
    void fetch('/api/stat-arb/pairs?basis=all&limit=50000')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { pairs: PairRow[] }
      })
      .then((d) => {
        // 알림 대상만 보관 — 3천여 페어 전체를 메모리에 들고 있지 않는다.
        const m = new Map<string, PairRow>()
        for (const p of d.pairs) {
          const k = pairKey(p.left_key, p.right_key)
          if (want.has(k)) m.set(k, p)
        }
        setStatMap(m)
        setStatAt(Date.now())
        setStatErr(null)
      })
      .catch((e) => setStatErr(String(e)))
      .finally(() => setStatLoading(false))
  }, [])

  useEffect(() => {
    const isNew = alerts.some((a) => !attemptedRef.current.has(pairKey(a.left_key, a.right_key)))
    if (isNew) loadStats(alerts)
  }, [alerts, loadStats])

  // --- 실시간 시세 ------------------------------------------------------------
  const subCodes = useMemo(() => {
    const codes = new Set<string>()
    for (const a of alerts) {
      codes.add(keyToCode(a.left_key))
      codes.add(keyToCode(a.right_key))
    }
    return Array.from(codes).filter(Boolean)
  }, [alerts])
  usePageStockSubscriptions(subCodes)

  // store 직접 구독 대신 스냅샷 폴링 — 매 tick 전체 재렌더 방지 (etf-arbitrage 등과 동일 패턴).
  // 참조가 그대로면 setState를 건너뛰어 유휴 시 재렌더 0.
  const [ticks, setTicks] = useState(() => {
    const s = useMarketStore.getState()
    return { stockTicks: s.stockTicks, etfTicks: s.etfTicks }
  })
  useEffect(() => {
    if (alerts.length === 0) return
    const id = setInterval(() => {
      const s = useMarketStore.getState()
      setTicks((prev) =>
        prev.stockTicks === s.stockTicks && prev.etfTicks === s.etfTicks
          ? prev
          : { stockTicks: s.stockTicks, etfTicks: s.etfTicks }
      )
    }, TICK_MS)
    return () => clearInterval(id)
  }, [alerts.length])

  const priceOf = useCallback(
    (key: string): number => {
      const code = keyToCode(key)
      const t = keyType(key) === 'E' ? ticks.etfTicks[code] : ticks.stockTicks[code]
      return t?.price ?? 0
    },
    [ticks]
  )

  // --- 행 계산 ---------------------------------------------------------------
  const rows = useMemo<WatchRow[]>(
    () =>
      alerts.map((a) => {
        const stat = statMap.get(pairKey(a.left_key, a.right_key))
        const lz = liveZ(stat, priceOf(a.left_key), priceOf(a.right_key))
        // 라이브 없으면 발굴 시점 z(전일 종가 기준)를 흐리게 — 감시/발화 대상은 아님.
        const z = lz ?? stat?.z_score ?? null
        return {
          alert: a,
          stat,
          z,
          isLive: lz != null,
          hit: z != null && isHit(z, a.target_z, a.direction),
          distance: z != null ? distanceToTarget(z, a.target_z, a.direction) : null,
          leftName: stat?.left_name ?? a.left_name ?? a.left_key,
          rightName: stat?.right_name ?? a.right_name ?? a.right_key,
        }
      }),
    [alerts, statMap, priceOf]
  )

  // --- 발화 (히스테리시스) -----------------------------------------------------
  // armed=false → 목표 안쪽(×REARM_RATIO)으로 되돌아와야 다시 울림. 경계 진동 시 연타 방지.
  const armedRef = useRef<Map<number, boolean>>(new Map())
  const toastSeq = useRef(0)
  const audioRef = useRef<AudioContext | null>(null)
  // 발화 시점에 최신 소리 설정을 읽되, 토글이 감시 effect를 재실행시키지 않도록 ref 경유.
  const soundRef = useRef(sound)
  useEffect(() => {
    soundRef.current = sound
  }, [sound])

  const toastTimers = useRef<number[]>([])
  const pushToast = useCallback((title: string, body: string) => {
    const key = ++toastSeq.current
    setToasts((prev) => [{ key, title, body }, ...prev].slice(0, MAX_TOASTS))
    toastTimers.current.push(
      window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), TOAST_MS)
    )
  }, [])
  useEffect(() => {
    const timers = toastTimers.current
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    for (const r of rows) {
      const { id, target_z, direction, enabled } = r.alert
      // 라이브 가격이 있어야만 발화 — 전일 종가 z로 장 시작 전에 울리는 오발화 차단.
      if (!enabled || !r.isLive || r.z == null) continue
      const armed = armedRef.current.get(id) ?? true
      if (armed && isHit(r.z, target_z, direction)) {
        armedRef.current.set(id, false)
        const title = `z ${r.z >= 0 ? '+' : ''}${r.z.toFixed(2)} · 목표 ${target_z.toFixed(1)} 도달`
        const body = `${r.leftName} ↔ ${r.rightName}`
        pushToast(title, body)
        if (soundRef.current) beep(audioRef)
        if (canNotify && Notification.permission === 'granted') {
          try {
            // tag = 페어별 1건만 — 같은 페어가 반복 발화해도 알림창이 쌓이지 않음.
            new Notification(`[LENS] ${body}`, { body: title, tag: `statarb-alert-${id}` })
          } catch {
            /* 일부 브라우저는 SW 없이 생성 불가 — 토스트로 대체 */
          }
        }
        recordTrigger(id)
      } else if (!armed && isRearmed(r.z, target_z, direction)) {
        armedRef.current.set(id, true)
      }
    }
  }, [rows, pushToast, recordTrigger])

  // 비활성화된 알림은 재무장 상태로 되돌리고(다시 켰을 때 즉시 감시 재개), 삭제된 id는 정리.
  useEffect(() => {
    const live = new Set(alerts.map((a) => a.id))
    for (const id of armedRef.current.keys()) if (!live.has(id)) armedRef.current.delete(id)
    for (const a of alerts) if (!a.enabled) armedRef.current.set(a.id, true)
  }, [alerts])

  const requestPermission = () => {
    if (!canNotify) return
    Notification.requestPermission()
      .then(setPermission)
      .catch(() => {})
    // 사용자 제스처 시점에 오디오 컨텍스트 준비 (자동재생 정책 회피).
    if (!audioRef.current) beep(audioRef)
  }

  const toggleSound = () => {
    const next = !sound
    setSound(next)
    localStorage.setItem(SOUND_KEY, next ? 'on' : 'off')
    if (next) beep(audioRef) // 제스처 시점 warm-up 겸 미리듣기
  }

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    localStorage.setItem(OPEN_KEY, next ? '1' : '0')
  }

  const watching = rows.filter((r) => r.alert.enabled && r.isLive).length
  const hitCount = rows.filter((r) => r.alert.enabled && r.hit).length

  return (
    <div className="panel p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={toggleOpen}
          className="flex items-center gap-1.5 text-t2 hover:text-t1"
          title="알림 워치리스트 접기/펼치기"
        >
          <span className="text-t4">{open ? '▼' : '▶'}</span>
          <span>🔔 알림 워치리스트</span>
          <span className="text-t3 tabular-nums">{alerts.length}</span>
        </button>
        {alerts.length > 0 && (
          <>
            <span className="text-t4 tabular-nums">
              감시 <span className="text-t2">{watching}</span> / {alerts.length}
            </span>
            {hitCount > 0 && (
              <span className="rounded-sm bg-warning/20 px-1.5 py-0.5 font-semibold text-warning tabular-nums">
                도달 {hitCount}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {alertErr && (
            <span className="text-[11px] text-down" title={alertErr}>
              알림 저장 실패
            </span>
          )}
          {statErr && (
            <span className="text-[11px] text-down" title={statErr}>
              통계 로드 실패
            </span>
          )}
          {statAt > 0 && (
            <span className="text-[11px] text-t4 tabular-nums">
              통계 {new Date(statAt).toLocaleTimeString('ko-KR', { hour12: false })}
            </span>
          )}
          {permission === 'default' && (
            <button
              onClick={requestPermission}
              className="rounded-sm bg-blue/20 px-2 py-1 text-[11px] text-blue hover:bg-blue/30"
              title="도달 시 브라우저 알림(다른 탭·최소화 상태에서도 보임)을 받으려면 허용하세요"
            >
              브라우저 알림 허용
            </button>
          )}
          {permission === 'denied' && (
            <span className="text-[11px] text-t4" title="브라우저 설정에서 알림을 차단했습니다">
              브라우저 알림 차단됨
            </span>
          )}
          {permission === 'unsupported' && (
            <span
              className="text-[11px] text-t4"
              title="비보안(HTTP) 접속이거나 브라우저가 Notification API를 지원하지 않습니다 — 화면 배너·소리로만 알립니다"
            >
              브라우저 알림 미지원
            </span>
          )}
          <button
            onClick={toggleSound}
            className={`rounded-sm px-2 py-1 text-[11px] ${
              sound ? 'bg-bg-surface text-t1' : 'bg-bg-surface text-t4'
            }`}
            title={sound ? '소리 끄기' : '소리 켜기 (미리듣기)'}
          >
            {sound ? '🔊 소리' : '🔇 무음'}
          </button>
          <button
            onClick={() => {
              setStatLoading(true)
              loadStats(alerts)
            }}
            disabled={statLoading || alerts.length === 0}
            className="rounded-sm bg-bg-surface px-2 py-1 text-[11px] text-t2 hover:text-t1 disabled:opacity-40"
            title="페어 통계(α·β·μ·σ) 다시 불러오기"
          >
            {statLoading ? '…' : '통계 새로고침'}
          </button>
        </div>
      </div>

      {alerts.length === 0 ? (
        <div className="mt-1 text-[11px] text-t4">
          걸어둔 알림 없음 — 아래 목록의 🔔 을 누르면 |z| ≥ 2.0 도달 시 알립니다.
        </div>
      ) : (
        open && (
          <>
            <table className="mt-2 w-full table-fixed text-xs tabular-nums">
              <colgroup>
                <col /> {/* 페어 (가변) */}
                <col className="w-24" /> {/* 현재 z */}
                <col className="w-24" /> {/* 목표 z */}
                <col className="w-20" /> {/* 남은 거리 */}
                <col className="w-24" /> {/* 방향 */}
                <col className="w-20" /> {/* 안정성 */}
                <col className="w-24" /> {/* 마지막 발화 */}
                <col className="w-16" /> {/* on/off */}
                <col className="w-12" /> {/* 삭제 */}
              </colgroup>
              <thead>
                <tr className="border-b border-bg-surface text-left text-t3">
                  <th className="px-2 py-1.5 font-normal">페어</th>
                  <th className="px-2 py-1.5 text-right font-normal" title="실시간 가격을 일봉 회귀(α·β)·정규화(μ·σ)에 넣은 z. 목록 z와 같은 척도">
                    현재 z
                  </th>
                  <th className="px-2 py-1.5 text-right font-normal" title="도달 시 알릴 |z| 임계 — 직접 수정 가능">
                    목표 z
                  </th>
                  <th className="px-2 py-1.5 text-right font-normal" title="목표까지 남은 z 거리 (0 이하 = 도달)">
                    남은 거리
                  </th>
                  <th className="px-2 py-1.5 font-normal">방향</th>
                  <th className="px-2 py-1.5 text-right font-normal">안정성</th>
                  <th className="px-2 py-1.5 text-right font-normal" title={`한 번 울리면 |z|가 목표×${REARM_RATIO} 안쪽으로 돌아와야 다시 울립니다`}>
                    마지막 발화
                  </th>
                  <th className="px-2 py-1.5 text-center font-normal">감시</th>
                  <th className="px-2 py-1.5 text-center font-normal"> </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <AlertRow
                    key={r.alert.id}
                    row={r}
                    onTarget={(v) => update(r.alert.id, { target_z: v })}
                    onEnabled={(v) => update(r.alert.id, { enabled: v })}
                    onDelete={() => remove(r.alert.id)}
                  />
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-[11px] leading-relaxed text-t4">
              이 탭이 열려 있는 동안만 감시합니다 (서버 푸시 아님). 실시간 z는 양쪽 leg 체결이 들어올 때만
              계산되고, 값이 없으면 발굴 시점 z(전일 종가)를 흐리게 표시하며 발화하지 않습니다. 한 번 울리면
              |z|가 목표×{REARM_RATIO} 안쪽으로 되돌아와야 재무장됩니다.
            </div>
          </>
        )
      )}

      {/* 도달 배너 — 목록을 스크롤 중이어도 보이도록 화면 우하단 고정 */}
      {toasts.length > 0 && (
        <div className="fixed bottom-3 right-3 z-50 flex w-80 flex-col gap-1.5">
          {toasts.map((t) => (
            <div
              key={t.key}
              className="rounded-sm border-l-2 border-warning bg-bg-surface px-3 py-2 shadow-lg"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-warning tabular-nums">{t.title}</div>
                  <div className="mt-0.5 text-[11px] text-t2">{t.body}</div>
                </div>
                <button
                  onClick={() => setToasts((prev) => prev.filter((x) => x.key !== t.key))}
                  className="text-[11px] text-t4 hover:text-t1"
                  title="닫기"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AlertRow({
  row,
  onTarget,
  onEnabled,
  onDelete,
}: {
  row: WatchRow
  onTarget: (v: number) => void
  onEnabled: (v: boolean) => void
  onDelete: () => void
}) {
  const { alert: a, stat, z, isLive, hit, distance } = row

  // 목표 z 입력은 비제어 — key={a.target_z}로 서버 값이 바뀌면 자연 리셋(동기화 effect 불필요).
  const commitTarget = (el: HTMLInputElement) => {
    const v = parseFloat(el.value)
    if (!isFinite(v) || v <= 0 || v > 10) {
      el.value = String(a.target_z)
      return
    }
    if (Math.abs(v - a.target_z) > 1e-9) onTarget(v)
  }

  const active = a.enabled && hit
  const zCls = !isLive
    ? 'text-t4'
    : active
      ? 'text-warning'
      : Math.abs(z ?? 0) >= a.target_z * 0.8
        ? 'text-t1'
        : 'text-t2'
  const badge = stat?.stability ? STABILITY_BADGES[stat.stability] : undefined
  const detailUrl = `/stat-arb/pair/${encodeURIComponent(a.left_key)}/${encodeURIComponent(a.right_key)}`

  return (
    <tr
      className={`border-b border-bg-surface/50 ${
        active ? 'bg-warning/10' : a.enabled ? 'hover:bg-bg-surface/40' : 'opacity-60'
      }`}
    >
      <td className="px-2 py-1.5">
        <a
          href={detailUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-wrap items-center gap-x-1 gap-y-0.5 hover:underline"
        >
          <span className="text-t1">{row.leftName}</span>
          <span className="text-t3">↔</span>
          <span className="text-t1">{row.rightName}</span>
          {!stat && (
            <span
              className="rounded-sm bg-down/15 px-1 text-[11px] text-down"
              title="현재 발굴 결과에 이 페어가 없습니다 (게이트 탈락 또는 엔진 미기동) — α·β를 몰라 실시간 z를 계산할 수 없습니다"
            >
              페어 없음
            </span>
          )}
        </a>
      </td>
      <td className={`px-2 py-1.5 text-right text-sm font-semibold ${zCls}`}>
        {z != null ? `${z >= 0 ? '+' : ''}${z.toFixed(2)}` : '—'}
        {!isLive && (
          <span className="ml-1 text-[11px] font-normal text-t4" title="실시간 체결 없음 — 발굴 시점(전일 종가) z">
            장외
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right">
        <input
          key={a.target_z}
          type="number"
          step="0.1"
          min="0.1"
          max="10"
          defaultValue={a.target_z}
          onBlur={(e) => commitTarget(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="w-14 rounded-sm bg-bg-surface px-1.5 py-0.5 text-right text-xs text-t1 tabular-nums focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
      </td>
      <td className={`px-2 py-1.5 text-right ${active ? 'font-semibold text-warning' : 'text-t3'}`}>
        {distance == null ? '—' : distance <= 0 ? '도달' : distance.toFixed(2)}
      </td>
      <td className="px-2 py-1.5 text-[11px] text-t3">{DIRECTION_LABELS[a.direction]}</td>
      <td className="px-2 py-1.5 text-right">
        {badge ? (
          <span className={`inline-block rounded-sm px-1.5 py-0.5 text-[11px] ${badge.cls}`}>
            {badge.label}
          </span>
        ) : (
          <span className="text-t4">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right text-[11px] text-t3">{fmtTime(a.last_triggered_at)}</td>
      <td className="px-2 py-1.5 text-center">
        <button
          onClick={() => onEnabled(!a.enabled)}
          className={`rounded-sm px-1.5 py-0.5 text-[11px] ${
            a.enabled ? 'bg-accent/20 text-accent' : 'bg-bg-surface text-t4'
          }`}
          title={a.enabled ? '감시 중 — 클릭하여 일시 중지' : '중지됨 — 클릭하여 감시 재개'}
        >
          {a.enabled ? 'ON' : 'OFF'}
        </button>
      </td>
      <td className="px-2 py-1.5 text-center">
        <button
          onClick={onDelete}
          className="rounded-sm px-1 py-0.5 text-[11px] text-t4 hover:text-down"
          title="알림 삭제"
        >
          ✕
        </button>
      </td>
    </tr>
  )
}
