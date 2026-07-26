// M:N 발굴 그룹 id 유틸 — 목록/상세 공용.
// group_id 포맷은 엔진이 정한다: `<kind>:<name>` (예: `etf:278540`, `sector:화학`).
// 여기는 kind 한글 라벨만 (asset-class.ts / stability.ts 와 같은 패턴).

export const KIND_LABEL: Record<string, string> = {
  index: '지수',
  sector: '섹터',
  etf: 'ETF',
  etf_category: 'ETF 카테고리',
}

/** 'etf:278540' → 'etf'. 콜론 없으면 '?'. */
export function groupKindOf(group_id: string): string {
  const colon = group_id.indexOf(':')
  if (colon < 0) return '?'
  return group_id.slice(0, colon)
}

/** kind 한글 라벨. 미지정 kind는 원문 그대로. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}
