import { useEffect, useState } from 'react'

import { LoanRatesPanel } from '@/components/stat-arb/loan-rates-panel'

type ArbItem = { base_code: string; base_name: string }
type EtfItem = { code: string; name: string }

export function LoanRatesPage() {
  const [names, setNames] = useState<Map<string, string>>(new Map())

  // 종목명 lookup — 주식선물 마스터(주식) + ETF 마스터 합쳐서 code→name dict.
  // 대여요율 패널이 종목명 표시할 때 사용. fetch 실패해도 (코드만 표시) fail-safe.
  useEffect(() => {
    Promise.all([
      fetch('/api/arbitrage/master').then((r) => (r.ok ? r.json() : { items: [] })),
      fetch('/api/etfs').then((r) => (r.ok ? r.json() : { items: [] })),
    ])
      .then(([arb, etfs]) => {
        const m = new Map<string, string>()
        for (const it of (arb.items ?? []) as ArbItem[]) {
          if (it.base_code) m.set(it.base_code, it.base_name)
        }
        for (const it of (etfs.items ?? []) as EtfItem[]) {
          if (it.code) m.set(it.code, it.name)
        }
        setNames(m)
      })
      .catch(() => {
        /* fail-safe: 빈 Map */
      })
  }, [])

  return (
    <div className="flex flex-col gap-1 p-1">
      <LoanRatesPanel names={names} />
    </div>
  )
}
