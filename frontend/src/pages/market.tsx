import { useMarketStore } from '../stores/marketStore'

export function MarketPage() {
  const etfTicks = useMarketStore((s) => s.etfTicks)
  const futuresTicks = useMarketStore((s) => s.futuresTicks)
  const etfList = Object.values(etfTicks)
  const futuresList = Object.values(futuresTicks)

  return (
    <div className="flex flex-col gap-1 bg-bg-base h-full">
      {/* ETF Spread Heatmap */}
      <div className="panel p-4">
        <h3 className="text-sm font-semibold text-t1 mb-3">ETF 괴리 히트맵 (bp)</h3>
        {etfList.length === 0 ? (
          <p className="text-sm text-t3 text-center py-8">데이터 수신 대기 중...</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {etfList.map((tick) => {
              let bg = 'bg-bg-surface-2 text-t2'
              if (tick.spread_bp > 10) bg = 'bg-up text-white'
              else if (tick.spread_bp > 5) bg = 'bg-up-bg text-up'
              else if (tick.spread_bp > 0) bg = 'bg-up-bg text-up'
              else if (tick.spread_bp < -10) bg = 'bg-blue text-white'
              else if (tick.spread_bp < -5) bg = 'bg-down-bg text-down'
              else if (tick.spread_bp < 0) bg = 'bg-down-bg text-down'
              return (
                <div key={tick.code} className={`rounded p-2.5 text-center ${bg}`}>
                  <div className="text-xs font-medium truncate opacity-80">{tick.name}</div>
                  <div className="text-base font-bold font-mono">
                    {tick.spread_bp > 0 ? '+' : ''}{tick.spread_bp.toFixed(1)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Two column: ETF Table + Futures Table */}
      <div className="flex gap-1 flex-1 min-h-0">
        {/* ETF Real-time Table */}
        <div className="flex-1 panel flex flex-col">
          <div className="px-4 py-3 border-b border-border-light">
            <span className="text-sm font-semibold text-t1">ETF 실시간 현황</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {etfList.length === 0 ? (
              <p className="text-sm text-t3 text-center py-8">데이터 수신 대기 중...</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface">
                  <tr className="text-xs text-t3 border-b border-border-light">
                    <th className="text-left px-4 py-2 font-medium">종목</th>
                    <th className="text-right px-4 py-2 font-medium">현재가</th>
                    <th className="text-right px-4 py-2 font-medium">NAV</th>
                    <th className="text-right px-4 py-2 font-medium">괴리(bp)</th>
                    <th className="text-right px-4 py-2 font-medium">거래량</th>
                  </tr>
                </thead>
                <tbody>
                  {etfList.map((tick) => (
                    <tr key={tick.code} className="border-b border-border hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="text-t1 font-medium">{tick.name}</div>
                        <div className="font-mono text-[11px] text-t4">{tick.code}</div>
                      </td>
                      <td className="text-right px-4 py-2.5 font-mono text-t1">
                        {tick.price.toLocaleString()}
                      </td>
                      <td className="text-right px-4 py-2.5 font-mono text-t2">
                        {tick.nav.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="text-right px-4 py-2.5">
                        <SpreadBadge bp={tick.spread_bp} />
                      </td>
                      <td className="text-right px-4 py-2.5 font-mono text-t3">
                        {tick.volume.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Futures Basis Table */}
        <div className="w-[480px] panel flex flex-col">
          <div className="px-4 py-3 border-b border-border-light">
            <span className="text-sm font-semibold text-t1">선물 베이시스 현황</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {futuresList.length === 0 ? (
              <p className="text-sm text-t3 text-center py-8">데이터 수신 대기 중...</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-bg-surface">
                  <tr className="text-xs text-t3 border-b border-border-light">
                    <th className="text-left px-4 py-2 font-medium">선물</th>
                    <th className="text-right px-4 py-2 font-medium">선물가</th>
                    <th className="text-right px-4 py-2 font-medium">현물가</th>
                    <th className="text-right px-4 py-2 font-medium">베이시스(bp)</th>
                    <th className="text-right px-4 py-2 font-medium">거래량</th>
                  </tr>
                </thead>
                <tbody>
                  {futuresList.map((tick) => (
                    <tr key={tick.code} className="border-b border-border hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="text-t1 font-medium">{tick.name}</div>
                        <div className="font-mono text-[11px] text-t4">{tick.code}</div>
                      </td>
                      <td className="text-right px-4 py-2.5 font-mono text-t1">
                        {tick.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="text-right px-4 py-2.5 font-mono text-t2">
                        {tick.underlying_price.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="text-right px-4 py-2.5">
                        <BasisBadge bp={tick.basis_bp} />
                      </td>
                      <td className="text-right px-4 py-2.5 font-mono text-t3">
                        {tick.volume.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SpreadBadge({ bp }: { bp: number }) {
  let color = 'text-t2 bg-bg-surface-2'
  if (bp > 5) color = 'text-up bg-up-bg'
  else if (bp < -5) color = 'text-blue bg-bg-surface-2'
  return (
    <span className={`inline-block px-2 py-0.5 rounded font-mono text-xs font-semibold ${color}`}>
      {bp > 0 ? '+' : ''}{bp.toFixed(1)}
    </span>
  )
}

function BasisBadge({ bp }: { bp: number }) {
  let color = 'text-t2 bg-bg-surface-2'
  if (bp > 10) color = 'text-up bg-up-bg'
  else if (bp > 0) color = 'text-up bg-up-bg'
  else if (bp < -10) color = 'text-down bg-down-bg'
  else if (bp < 0) color = 'text-down bg-down-bg'
  return (
    <span className={`inline-block px-2 py-0.5 rounded font-mono text-xs font-semibold ${color}`}>
      {bp > 0 ? '+' : ''}{bp.toFixed(1)}
    </span>
  )
}
