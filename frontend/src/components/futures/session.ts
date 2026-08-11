import type { IChartApi, Time, UTCTimestamp } from 'lightweight-charts'

/**
 * "선물" 탭 공통 — 당일 세션(09:00~15:45 KST) 시간축 유틸.
 *
 * 컴포넌트 파일(charts.tsx)에서 값을 export하면 react-refresh가 깨지므로 별도 모듈.
 * 메인 차트(DepthChart)와 하단 미니 차트(OI·베이시스), 그리고 통계 스트립(pages/futures.tsx)이
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

/** 지수선물 정규장 (KST). 시간축은 데이터 양과 무관하게 항상 이 구간으로 고정. */
const SESSION_OPEN_MIN = 9 * 60
const SESSION_CLOSE_MIN = 15 * 60 + 45
/** 틱 모드 그리드 = 서버 샘플 주기와 동일. */
export const TICK_STEP_SEC = 10

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

/** 당일 09:00 KST(= 같은 날짜 00:00 UTC)와 15:45 KST의 epoch 초. */
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
  // KST = UTC+9 → 09:00 KST는 같은 날짜 00:00 UTC. (개장 시각을 바꿔도 식이 유지되게 명시)
  const from = Date.UTC(y, mo - 1, da) / 1000 + (SESSION_OPEN_MIN - 9 * 60) * 60
  return { from, to: from + (SESSION_CLOSE_MIN - SESSION_OPEN_MIN) * 60 }
}

export type Grid = { from: number; to: number; step: number; sessionMode: boolean }

/**
 * 세션 밖 표본 처리 — 두 갈래:
 *  · 세션 내 표본이 하나라도 있으면 **세션 고정 모드**: 09:00~15:45 밖 데이터는 차트에서 제외.
 *    (서버는 WindDown 16:00까지 샘플하는데, 15:45 넘는 버킷이 새 슬롯으로 붙으면
 *     shiftVisibleRangeOnNewBar 때문에 축이 우측으로 조금씩 밀린다.)
 *  · 세션 내 표본이 0이면(mock을 장 외에 돌리는 경우) 고정 모드를 끄고 데이터에 맞춘다.
 *    안 그러면 전부 필터링돼 완전 빈 차트가 된다.
 */
export function resolveGrid(points: DepthPoint[], date: string, step: number) {
  const { from, to } = sessionRange(date)
  const inSession = points.filter((p) => p.t >= from && p.t <= to)
  const sessionMode = inSession.length > 0
  return { grid: { from, to, step, sessionMode } as Grid, src: sessionMode ? inSession : points }
}

/** 버킷 정렬 (세션 시작 기준). */
export const bucketOf = (g: Grid, t: number) => g.from + Math.floor((t - g.from) / g.step) * g.step

/** 세션 고정 모드에서 09:00~15:45 밖 라이브 틱은 차트에 올리지 않는다 (축 우측 밀림 방지). */
export const liveInSession = (g: Grid, t: number) => !(g.sessionMode && (t < g.from || t > g.to))

/**
 * 세션 고정 축 적용 — **모든 series setData 이후**에 호출할 것.
 * lightweight-charts의 setVisibleRange는 데이터 없는 구간으로 확장이 안 되므로(index 기반),
 * 세션 전 구간 슬롯을 whitespace로 채운 보이지 않는 spacer 시리즈를 깔고 범위를 지정한다.
 * spacer는 별도 시리즈라 실데이터 시리즈의 `update()` 제약(마지막 시각 이후만)을 안 건드린다.
 */
export function applySessionAxis(chart: IChartApi, g: Grid) {
  if (!g.sessionMode) {
    chart.timeScale().fitContent()
    return
  }
  const spacer = chart.addLineSeries({
    priceScaleId: 'spacer',
    lastValueVisible: false,
    priceLineVisible: false,
  })
  const slots: { time: Time }[] = []
  let t = g.from
  for (; t <= g.to; t += g.step) slots.push({ time: t as UTCTimestamp })
  // to가 버킷 경계에 안 떨어지는 단위(30·60분)에서도 축 우측이 15:45까지 닿게 한 칸 더.
  if (t - g.step < g.to) slots.push({ time: t as UTCTimestamp })
  spacer.setData(slots)
  chart.timeScale().setVisibleRange({ from: g.from as UTCTimestamp, to: g.to as UTCTimestamp })
}
