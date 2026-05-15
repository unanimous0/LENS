import type { TimeframeStat } from '@/types/stat-arb'
import { humanHalfLifeShort } from '@/lib/stat-arb/half-life'

export function TimeframeTable({ rows }: { rows: TimeframeStat[] }) {
  return (
    <table className="w-full text-[11px] tabular-nums">
      <thead>
        <tr className="text-left text-t3 border-b border-bg-surface">
          <th className="px-2 py-1.5 font-normal">TF</th>
          <th className="px-2 py-1.5 text-right font-normal">n</th>
          <th className="px-2 py-1.5 text-right font-normal">β</th>
          <th className="px-2 py-1.5 text-right font-normal">R²</th>
          <th className="px-2 py-1.5 text-right font-normal">ADF</th>
          <th className="px-2 py-1.5 text-right font-normal">half-life</th>
          <th className="px-2 py-1.5 text-right font-normal">z</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const adfClass = r.adf_tstat <= -3 ? 'text-up' : 'text-t3'
          const r2Class = r.r_squared >= 0.9 ? 'text-up' : r.r_squared >= 0.6 ? 'text-t1' : 'text-t3'
          const zAbs = Math.abs(r.z_score)
          const zClass = zAbs >= 2.5 ? 'text-warning font-semibold' : zAbs >= 1.5 ? 'text-t1' : 'text-t3'
          return (
            <tr key={r.timeframe} className="border-b border-bg-surface/30 hover:bg-bg-surface/30">
              <td className="px-2 py-1.5 text-t1">{r.timeframe}</td>
              <td className="px-2 py-1.5 text-right text-t2">{r.sample_size.toLocaleString()}</td>
              <td className="px-2 py-1.5 text-right text-t1">{r.hedge_ratio.toFixed(3)}</td>
              <td className={`px-2 py-1.5 text-right ${r2Class}`}>{r.r_squared.toFixed(2)}</td>
              <td className={`px-2 py-1.5 text-right ${adfClass}`}>{r.adf_tstat.toFixed(2)}</td>
              <td className="px-2 py-1.5 text-right text-t2">
                {humanHalfLifeShort(r.timeframe, r.half_life)}
              </td>
              <td className={`px-2 py-1.5 text-right ${zClass}`}>
                {r.z_score >= 0 ? '+' : ''}
                {r.z_score.toFixed(2)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
