// leg 분류 태그 표시 규칙 — 1:1 발굴 목록과 s-score 목록 공용.
// 태그 값 자체는 엔진이 정한다 (classify.rs `EtfCategory::as_tag` + `leg_class`).
// 여기는 한글 라벨·배지 톤만. (stability.ts 와 같은 패턴)

export const CLASS_LABELS: Record<string, string> = {
  broad_index: '광범위지수',
  leverage_inverse: '레버리지·인버스',
  sector: '섹터',
  theme: '테마',
  bond_rates: '채권·금리',
  factor: '팩터',
  overseas: '해외',
  commodity: '원자재',
  active: '액티브',
  other: '기타',
  stock: '주식',
  index: '지수',
}

// 배지 색 — 저채도, 과하지 않게. 미지정은 text-t3.
export const CLASS_COLORS: Record<string, string> = {
  broad_index: 'text-blue',
  leverage_inverse: 'text-warning',
  sector: 'text-t2',
  theme: 'text-t2',
  bond_rates: 'text-t2',
  factor: 'text-t2',
  overseas: 'text-t2',
  commodity: 'text-t2',
  active: 'text-t2',
  stock: 'text-t3',
  index: 'text-t3',
}

export function classLabel(cls: string): string {
  return CLASS_LABELS[cls] ?? cls
}

export function classColor(cls: string): string {
  return CLASS_COLORS[cls] ?? 'text-t3'
}
