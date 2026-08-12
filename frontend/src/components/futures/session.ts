import type { IChartApi } from 'lightweight-charts'

/**
 * "선물" 탭 공통 — 당일 세션(08:45~15:45 KST, 지수선물 정규장) 시간축 유틸.
 *
 * 축 정책은 **"개장~현재" 자동 맞춤(auto-fit)**: 범위 고정이 아니라 세션 내 첫~마지막 데이터를
 * 항상 화면 전체 폭에 채운다. 장초반이든 막판이든 판독 밀도가 유지된다.
 *
 * 컴포넌트 파일(charts.tsx)에서 값을 export하면 react-refresh가 깨지므로 별도 모듈.
 * 메인 차트(DepthChart)와 하단 베이시스 차트, 그리고 통계 스트립(pages/futures.tsx)이
 * **같은 세션 규칙**을 쓰도록 여기 한 벌만 둔다.
 */

// lightweight-charts는 timestamp를 UTC로 다루므로 +9h 후 UTC 필드를 읽어 KST 벽시계로.
export const KST_OFFSET_SEC = 9 * 3600
const pad = (n: number) => String(n).padStart(2, '0')

export function kstHms(timeSec: number) {
  const d = new Date((timeSec + KST_OFFSET_SEC) * 1000)
  return {
    hm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    hms: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  }
}

/** 지수선물 정규장 (KST) — **08:45~15:45**. 주식(09:00)보다 15분 일찍 시작한다.
 *  세션 밖 표본·틱은 차트에서 제외한다 (축은 attachAutoFit이 데이터 범위에 자동 맞춤). */
const SESSION_OPEN_MIN = 8 * 60 + 45
const SESSION_CLOSE_MIN = 15 * 60 + 45
/** 틱 모드 그리드 = 서버 샘플 주기와 동일. */
export const TICK_STEP_SEC = 10

/** 비율 이동평균 선택지(분)와 색. 가격=blue / 비율=accent 초록과 겹치지 않는 뮤트 톤. */
export type MaMin = 5 | 15 | 60
export const MA_COLOR: Record<MaMin, string> = { 5: '#ff9f0a', 15: '#a78bfa', 60: '#64d2ff' }

/**
 * 총잔량 비율의 **부호 스케일** — 화면 전체(차트·카드·통계·툴팁) 공통 표기 체계.
 *
 * 사용자가 보는 값은 `+1.24`(매수가 1.24배) / `-1.35`(매도가 1.35배) — **부호가 방향, 크기가 배율**.
 * 그런데 그 표시값(±1.xx)을 그대로 플롯하면 (−1,+1) 구간이 존재하지 않는 공백이라 균형 근처에서
 * 선이 폭 2로 점프한다 (당일에도 균형 교차가 잦다). 그래서 **내부 플롯 값은 0 중심 연속 스케일**을 쓰고
 * 표시할 때만 ±1.xx로 되돌린다:
 *
 *   v(r) = r − 1        (r ≥ 1, 매수우위)
 *        = −(1/r − 1)   (r < 1, 매도우위)      · r = 매수잔량 ÷ 매도잔량
 *   표시 = v ≥ 0 ? +(1+v) : −(1+|v|)
 *
 * 균형은 v=0 ↔ 표시 1.00. 매수 1.2배 = v +0.2, 매도 1.2배 = v −0.2로 **대칭·연속**이라
 * 이동평균·분포 통계도 방향 중립적이다.
 */
export function ratioValue(bid: number, ask: number): number | null {
  // ask=0(호가 공백)·bid=0(1/r 발산) 둘 다 스킵 — 기존 null 규칙과 동일 취급.
  if (!(ask > 0) || !(bid > 0)) return null
  const r = bid / ask
  return r >= 1 ? r - 1 : -(1 / r - 1)
}

/** 플롯 값 v → 사용자 표시 문자열 (`+1.24` / `-1.35` / 균형 `1.00`). */
export function fmtRatio(v: number): string {
  const mag = (1 + Math.abs(v)).toFixed(2)
  if (mag === '1.00') return '1.00' // 균형 근처는 부호 없이
  return v > 0 ? `+${mag}` : `-${mag}`
}

/** 서버 `/realtime/futures/depth-history` 포인트 (필드명이 짧은 건 하루치 전량 페이로드라서). */
export type DepthPoint = {
  /** epoch 초 (UTC) */
  t: number
  /** 총 매도잔량 */
  a: number
  /** 총 매수잔량 */
  b: number
  /** 선물 현재가 (샘플 시점, 미수신이면 0) */
  p: number
  /** 누적 거래량 (샘플 시점) */
  v: number
  /** 미결제약정 (FC9 openyak). 0 = 미상 — 차트에서 스킵. */
  oi: number
  /** 기초지수 (FC9 k200jisu). 0 = 미상. */
  u: number
  /** 이론가 (FC9 theoryprice). 0 = 미상. */
  th: number
}

/** 차트에 이어 붙일 실시간 최신 점. 부모가 10초 버킷으로 만들어 넘긴다(모양은 히스토리와 동일). */
export type LiveDepthPoint = DepthPoint

/** 당일 개장(08:45 KST)과 마감(15:45 KST)의 epoch 초. */
export function sessionRange(ymd: string) {
  let y: number, mo: number, da: number
  if (/^\d{8}$/.test(ymd)) {
    y = +ymd.slice(0, 4)
    mo = +ymd.slice(4, 6)
    da = +ymd.slice(6, 8)
  } else {
    // 히스토리가 비었을 때(빈 응답) 폴백 — 오늘 KST 날짜.
    const now = new Date(Date.now() + KST_OFFSET_SEC * 1000)
    y = now.getUTCFullYear()
    mo = now.getUTCMonth() + 1
    da = now.getUTCDate()
  }
  // KST = UTC+9 → 09:00 KST가 같은 날짜 00:00 UTC. 개장이 08:45면 그보다 15분 이르다.
  const from = Date.UTC(y, mo - 1, da) / 1000 + (SESSION_OPEN_MIN - 9 * 60) * 60
  return { from, to: from + (SESSION_CLOSE_MIN - SESSION_OPEN_MIN) * 60 }
}

export type Grid = { from: number; to: number; step: number; sessionMode: boolean }

/**
 * 세션 밖 표본 처리 — 두 갈래:
 *  · 세션 내 표본이 하나라도 있으면 **세션 모드**: 08:45~15:45 밖 데이터는 차트에서 제외.
 *    (서버는 08:30 WarmUp~16:00 WindDown까지 샘플하는데, 정규장 밖 호가는 판독에 방해된다.)
 *  · 세션 내 표본이 0이면(mock을 장 외에 돌리는 경우) 필터를 끄고 전량 사용한다.
 *    안 그러면 전부 필터링돼 완전 빈 차트가 된다. 축은 어느 쪽이든 auto-fit이라 동일.
 */
export function resolveGrid(points: DepthPoint[], date: string, step: number) {
  const { from, to } = sessionRange(date)
  const inSession = points.filter((p) => p.t >= from && p.t <= to)
  const sessionMode = inSession.length > 0
  return { grid: { from, to, step, sessionMode } as Grid, src: sessionMode ? inSession : points }
}

/** 버킷 정렬 (세션 시작 기준). */
export const bucketOf = (g: Grid, t: number) => g.from + Math.floor((t - g.from) / g.step) * g.step

/** 세션 모드에서 08:45~15:45 밖 라이브 틱은 차트에 올리지 않는다 (히스토리 필터와 같은 규칙). */
export const liveInSession = (g: Grid, t: number) => !(g.sessionMode && (t < g.from || t > g.to))

/** 자동 맞춤 컨트롤러 — 새 버킷마다 `refit()`, 언마운트 시 `dispose()`. */
export type AutoFit = { refit: () => void; dispose: () => void }

/**
 * **"개장~현재" 자동 맞춤** — 모든 series setData 이후에 호출할 것.
 *
 * 즉시 `fitContent()`로 세션 내 첫~마지막 데이터를 화면 폭에 채우고, 이후 새 버킷이 붙을 때마다
 * `refit()`이 다시 맞춘다(데이터가 쌓이면 축이 자연히 넓어짐).
 *
 * **사용자 조작 존중**: 휠 줌 / 드래그 팬 / 터치 이동이 감지되면 auto를 끄고 축을 그대로 둔다.
 * **더블클릭이면 auto 복귀**(즉시 재맞춤). 단순 클릭(이동 없음)으로는 꺼지지 않게 3px 이상
 * 움직인 드래그만 조작으로 본다. auto 상태는 차트 인스턴스 로컬 — 리마운트/재시딩 시 auto로 초기화.
 *
 * capture 단계로 붙여 lightweight-charts 내부 핸들러와 무관하게 관측한다. 15:45 이후 축이
 * 밀려나는 문제는 세션 필터(resolveGrid)가 이미 막으므로 여기서 신경 쓸 게 없다.
 */
export function attachAutoFit(chart: IChartApi, container: HTMLElement): AutoFit {
  let auto = true
  let downX: number | null = null
  const fit = () => chart.timeScale().fitContent()
  const stop = () => {
    auto = false
    downX = null
  }
  const onDown = (e: PointerEvent) => {
    downX = e.clientX
  }
  const onMove = (e: PointerEvent) => {
    if (downX != null && Math.abs(e.clientX - downX) > 3) stop()
  }
  const onUp = () => {
    downX = null
  }
  const onDblClick = () => {
    auto = true
    fit()
  }
  const opts = { capture: true } as const
  container.addEventListener('wheel', stop, { capture: true, passive: true })
  container.addEventListener('pointerdown', onDown, opts)
  container.addEventListener('pointermove', onMove, opts)
  container.addEventListener('pointerup', onUp, opts)
  container.addEventListener('pointercancel', onUp, opts)
  container.addEventListener('touchmove', stop, { capture: true, passive: true })
  container.addEventListener('dblclick', onDblClick, opts)
  fit()
  return {
    refit: () => {
      if (auto) fit()
    },
    dispose: () => {
      container.removeEventListener('wheel', stop, opts)
      container.removeEventListener('pointerdown', onDown, opts)
      container.removeEventListener('pointermove', onMove, opts)
      container.removeEventListener('pointerup', onUp, opts)
      container.removeEventListener('pointercancel', onUp, opts)
      container.removeEventListener('touchmove', stop, opts)
      container.removeEventListener('dblclick', onDblClick, opts)
    },
  }
}
