import { useMarketStore } from '../../stores/marketStore'
import type { NetworkMode } from '../../types/market'

const MODES: { value: NetworkMode; label: string }[] = [
  { value: 'internal', label: '내부망' },
  { value: 'external', label: '외부망' },
  { value: 'mock', label: 'Mock' },
]

export function NetworkToggle() {
  const { networkMode, setNetworkMode, connected } = useMarketStore()

  async function handleSwitch(mode: NetworkMode) {
    try {
      const res = await fetch(`/api/network/mode/${mode}`, { method: 'POST' })
      if (res.ok) setNetworkMode(mode)
    } catch (err) {
      console.error('네트워크 전환 실패:', err)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex rounded bg-bg-surface-2 p-0.5">
        {MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => handleSwitch(m.value)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              networkMode === m.value
                ? 'bg-accent text-black'
                : 'text-t3 hover:text-t2'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-up' : 'bg-down'}`} />
        <span className="font-mono text-xs text-t3">{connected ? 'Connected' : 'Disconnected'}</span>
      </div>
    </div>
  )
}
