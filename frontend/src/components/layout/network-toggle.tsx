import { useMarketStore } from '../../stores/marketStore'
import type { NetworkMode } from '../../types/market'
import type { FeedState } from '../../stores/marketStore'

const MODES: { value: NetworkMode; label: string }[] = [
  { value: 'internal', label: '내부망' },
  { value: 'external', label: '외부망' },
  { value: 'mock', label: 'Mock' },
]

export function NetworkToggle() {
  const { networkMode, setNetworkMode, connected, feedState, feedAgeSec } = useMarketStore()

  async function handleSwitch(mode: NetworkMode) {
    // 프론트 'external' ↔ Rust 'ls_api' 매핑
    const rustMode = mode === 'external' ? 'ls_api' : mode
    try {
      const res = await fetch(`/realtime/mode/${rustMode}`, { method: 'POST' })
      if (res.ok) setNetworkMode(mode)
      else if (res.status === 429) {
        // 백엔드 쿨다운 — 사용자에게 즉시 알림
        const msg = await res.text()
        alert(`너무 빠른 전환입니다. ${msg}`)
      } else {
        console.error('네트워크 전환 실패:', await res.text())
      }
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
      <FeedHealthBadge state={feedState} ageSec={feedAgeSec} />
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-up' : 'bg-down'}`} />
        <span className="font-mono text-xs text-t3">{connected ? 'Connected' : 'Disconnected'}</span>
      </div>
    </div>
  )
}

function FeedHealthBadge({ state, ageSec }: { state: FeedState; ageSec: number }) {
  const meta = FEED_META[state]
  const ageLabel = formatAge(ageSec)
  // 상세 텍스트: 모든 상태 의미를 한 번에 보여줌 (사용자가 어느 색이 뭔지 학습)
  const tooltip =
    `데이터 수신 상태: ${meta.short}\n` +
    (state === 'fresh' || state === 'quiet' || state === 'stale' ? `마지막 수신: ${ageLabel} 전\n` : '') +
    `\n색 가이드:\n` +
    `🟢 정상   — 30초 이내 데이터 들어옴\n` +
    `🟡 잠잠   — 30초~5분 침묵 (점심·종목 한산할 수도)\n` +
    `🔴 멈춤   — 5분+ 침묵 / LS 차단 의심\n` +
    `⚪ 휴장   — 장 시간 외 (KST 09:00~15:45 외)\n` +
    `⚫ Mock/Internal — LS 미사용 모드`

  return (
    <div
      className="group relative flex items-center gap-1.5 cursor-help"
      title={tooltip}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      <span className={`font-mono text-xs ${meta.text}`}>{meta.short}</span>
    </div>
  )
}

const FEED_META: Record<FeedState, { dot: string; text: string; short: string }> = {
  fresh:    { dot: 'bg-up',         text: 'text-t3', short: '정상' },
  quiet:    { dot: 'bg-warning',    text: 'text-warning', short: '잠잠' },
  stale:    { dot: 'bg-down',       text: 'text-down', short: '멈춤' },
  closed:   { dot: 'bg-t4',         text: 'text-t3', short: '휴장' },
  mock:     { dot: 'bg-t4',         text: 'text-t3', short: 'Mock' },
  internal: { dot: 'bg-blue',       text: 'text-t3', short: 'Internal' },
  unknown:  { dot: 'bg-t4',         text: 'text-t4', short: '...' },
}

function formatAge(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}초`
  if (sec < 3600) return `${Math.floor(sec / 60)}분`
  return `${Math.floor(sec / 3600)}시간`
}
