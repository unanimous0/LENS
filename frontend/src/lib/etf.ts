/** ETF 공용 타입·유틸 — 대시보드/차익거래 화면 공유. */

export type EtfType = 'derivative' | 'bond' | 'sector' | 'index' | 'other'

export type EtfMaster = {
  code: string
  name: string
  cu_unit: number
  group: string | null
  lp: string | null
  // 차익 거래 대상 여부. false면 fNAV/실집행/차익BP 컬럼 무의미 (레버리지/인버스/채권/혼합 등).
  // 백엔드 _is_arbitrable() 분류. 누락 시 true 폴백 (구 응답 호환).
  arbitrable: boolean
  // 백엔드 _classify_etf() 분류. 누락 시 'other' 폴백.
  type?: EtfType
}

export const TYPE_LABEL: Record<EtfType, string> = {
  sector: '섹터형',
  index: '지수형',
  derivative: '파생형',
  bond: '채권형',
  other: '기타',
}

export const TYPE_ORDER: EtfType[] = ['sector', 'index', 'derivative', 'bond', 'other']

export type PdfStock = { code: string; name: string; qty: number }

export type EtfPdf = {
  code: string
  name: string
  cu_unit: number
  arbitrable: boolean
  as_of: string
  cash: number
  stocks: PdfStock[]
}

/** 원 단위 거래대금을 조/억/만 단위로 축약. */
export function formatTradeValue(won: number): string {
  if (won >= 1_0000_0000_0000) return Math.round(won / 1_0000_0000_0000).toLocaleString() + '조'
  if (won >= 1_0000_0000) return Math.round(won / 1_0000_0000).toLocaleString() + '억'
  if (won >= 1_0000) return Math.round(won / 1_0000).toLocaleString() + '만'
  return won.toLocaleString()
}
