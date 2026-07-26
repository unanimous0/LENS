// 관계 안정성(Kalman 시변 β) 등급 배지 — 목록/워치리스트 공용 라벨·톤.
// 판정 자체는 엔진 `detail::classify_stability` 1벌. 여기는 표시 규칙만.

export const STABILITY_BADGES: Record<string, { label: string; cls: string }> = {
  stable: { label: '안정', cls: 'bg-accent/15 text-accent' },
  caution: { label: '주의', cls: 'bg-warning/15 text-warning' },
  drift: { label: '드리프트', cls: 'bg-down/15 text-down' },
}

/** 정렬용 등급 랭크 (내림차순 = 드리프트 먼저). 미산출은 -1로 뒤로. */
export const STABILITY_RANK: Record<string, number> = { drift: 2, caution: 1, stable: 0 }
