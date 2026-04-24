import { useEffect, useCallback } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'
import type { OrderbookTick } from '@/types/market'

// 호가 subscribe/unsubscribe fetch를 모듈 레벨 큐로 직렬화.
// 브라우저는 같은 origin이어도 fetch를 최대 6 TCP 연결로 fan-out하기 때문에
// 연달아 쏘면 sub → unsub 도착 순서가 역전되어 방금 띄운 WS 연결을
// 곧바로 취소하는 race가 생긴다. 체인으로 줄 세우면 앞선 요청이 끝난 뒤
// 다음 요청이 발사돼 도착 순서가 보장된다.
let obQueue: Promise<unknown> = Promise.resolve()
function obFetch(path: string, body?: object) {
  const next = obQueue.then(() =>
    fetch(path, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => {}),
  )
  obQueue = next
  return next
}

/** 최우선 매도/매수 호가의 평균 (mid price). 한 쪽이라도 없으면 '-'. */
function midPrice(ob?: OrderbookTick): string {
  const a = ob?.asks[0]?.price
  const b = ob?.bids[0]?.price
  if (a === undefined || b === undefined) return '-'
  return ((a + b) / 2).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

interface OrderbookModalProps {
  spotCode: string
  futuresCode: string
  spotName: string
  onClose: () => void
}

export function OrderbookModal({ spotCode, futuresCode, spotName, onClose }: OrderbookModalProps) {
  const spotOb = useMarketStore((s) => s.orderbookTicks[spotCode])
  const futuresOb = useMarketStore((s) => s.orderbookTicks[futuresCode])
  const clearOrderbook = useMarketStore((s) => s.clearOrderbook)
  const spotTick = useMarketStore((s) => s.stockTicks[spotCode])
  const futuresTick = useMarketStore((s) => s.futuresTicks[futuresCode])

  // 구독
  useEffect(() => {
    obFetch('/realtime/orderbook/subscribe', { spot_code: spotCode, futures_code: futuresCode })

    return () => {
      obFetch('/realtime/orderbook/unsubscribe')
      clearOrderbook(spotCode)
      clearOrderbook(futuresCode)
    }
  }, [spotCode, futuresCode, clearOrderbook])

  // ESC 닫기
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])
  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [handleKey])

  const basis = futuresTick && spotTick
    ? (futuresTick.price - spotTick.price)
    : 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-[#111111] rounded-sm border border-white/[0.06] shadow-2xl w-[900px] max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-4">
            <span className="text-[13px] text-white font-medium">{spotName}</span>
            <span className="text-[10px] text-white/60 tabular-nums">{spotCode} / {futuresCode}</span>
          </div>
          <div className="flex items-center gap-5">
            <div className="text-right">
              <div className="text-[10px] text-white/60">시장B</div>
              <div className={cn('text-[12px] tabular-nums', basis > 0 ? 'text-[#00b26b]' : basis < 0 ? 'text-[#bb4a65]' : 'text-[#e0e0e3]')}>
                {basis !== 0 ? `${basis > 0 ? '+' : ''}${basis.toLocaleString(undefined, { maximumFractionDigits: 1 })}` : '-'}
              </div>
            </div>
            <button onClick={onClose} className="text-[#5a5a5e] hover:text-white text-[16px] transition-colors leading-none">&times;</button>
          </div>
        </div>

        {/* 호가 패널. 선물(5호가)은 위아래 5줄 패딩으로 현물(10호가) 중앙과 정렬. */}
        <div className="flex flex-1 min-h-0">
          {/* 선물 */}
          <div className="flex-1 flex flex-col min-h-0 border-r border-white/[0.06]">
            <div className="px-4 py-2 border-b border-white/[0.06] flex-shrink-0">
              <span className="text-[11px] text-white/60">선물</span>
              <span className="ml-2 text-[12px] text-white tabular-nums">{futuresTick?.price ? futuresTick.price.toLocaleString() : '-'}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <OrderbookPanel data={futuresOb} maxLevels={5} topPad={5} bottomPad={5} currentPrice={futuresTick?.price} />
            </div>
          </div>
          {/* 현물 */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-white/[0.06] flex-shrink-0">
              <span className="text-[11px] text-white/60">현물</span>
              <span className="ml-2 text-[12px] text-white tabular-nums">{spotTick?.price ? spotTick.price.toLocaleString() : '-'}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <OrderbookPanel data={spotOb} maxLevels={10} currentPrice={spotTick?.price} />
            </div>
          </div>
        </div>

        {/* 하단 총잔량 + 중간가. 매도총 | 중간가 | 매수총 */}
        <div className="flex border-t border-white/[0.06] text-[10px] tabular-nums flex-shrink-0">
          <div className="flex-1 flex justify-between items-center px-4 py-2 border-r border-white/[0.06]">
            <span className="text-[#bb4a65]">매도 {futuresOb ? futuresOb.total_ask_qty.toLocaleString() : '-'}</span>
            <span className="text-white/70 text-[11px]">{midPrice(futuresOb)}</span>
            <span className="text-[#00b26b]">매수 {futuresOb ? futuresOb.total_bid_qty.toLocaleString() : '-'}</span>
          </div>
          <div className="flex-1 flex justify-between items-center px-4 py-2">
            <span className="text-[#bb4a65]">매도 {spotOb ? spotOb.total_ask_qty.toLocaleString() : '-'}</span>
            <span className="text-white/70 text-[11px]">{midPrice(spotOb)}</span>
            <span className="text-[#00b26b]">매수 {spotOb ? spotOb.total_bid_qty.toLocaleString() : '-'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

interface OrderbookPanelProps {
  data?: OrderbookTick
  maxLevels: number
  /** 위쪽 빈 줄 수. 선물(5호가)을 현물(10호가) 중앙에 정렬하기 위해 상단 5줄 비워둠. */
  topPad?: number
  /** 아래쪽 빈 줄 수. 선물 하단도 같은 이유로 5줄. */
  bottomPad?: number
  /** 체결가. 호가 레벨 중 같은 가격 행을 하이라이트. */
  currentPrice?: number
}

function OrderbookPanel({ data, maxLevels, topPad = 0, bottomPad = 0, currentPrice }: OrderbookPanelProps) {
  if (!data || (data.asks.length === 0 && data.bids.length === 0)) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <span className="text-[11px] text-[#5a5a5e]">호가 대기 중...</span>
      </div>
    )
  }

  const allQty = [...data.asks.map((l) => l.quantity), ...data.bids.map((l) => l.quantity)]
  const maxQty = Math.max(...allQty, 1)

  const asks = data.asks.slice(0, maxLevels)
  const bids = data.bids.slice(0, maxLevels)
  // asks: 높은가→낮은가 순서로 (위에서 아래로), 최우선 매도가 맨 아래
  const reversedAsks = [...asks].reverse()
  // 비어있는 레벨 패딩 (호가 깊이 부족할 때)
  const askInnerPad = maxLevels - reversedAsks.length
  const bidInnerPad = maxLevels - bids.length

  const padRow = (key: string) => <div key={key} className="h-[26px]" />

  return (
    <div className="flex flex-col text-[11px] tabular-nums">
      {/* 헤더 */}
      <div className="flex px-4 py-1 text-[9px] text-white/50 border-b border-white/[0.04]">
        <span className="flex-1 text-left">잔량</span>
        <span className="w-[80px] text-center">가격</span>
        <span className="flex-1 text-right">잔량</span>
      </div>
      {/* 상단 패딩 (선물 위 맞춤용) */}
      {Array.from({ length: topPad }).map((_, i) => padRow(`tp-${i}`))}
      {/* 매도 레벨 부족분 패딩 */}
      {Array.from({ length: askInnerPad }).map((_, i) => padRow(`ap-${i}`))}
      {/* 매도 (asks) — 그래프를 잔량(왼쪽)과 같은 방향에 둠 */}
      {reversedAsks.map((level, i) => {
        const hi = currentPrice !== undefined && level.price === currentPrice
        return (
          <div key={`a-${i}`} className="flex items-center px-4 py-[5px] relative h-[26px]">
            <div
              className="absolute left-0 top-0 bottom-0 bg-[#bb4a65]/20"
              style={{ width: `${(level.quantity / maxQty) * 50}%` }}
            />
            <span className="flex-1 text-left text-[#bb4a65] relative z-10">{level.quantity.toLocaleString()}</span>
            <span
              className={cn(
                'w-[80px] text-center text-[#bb4a65] relative z-10 py-[1px]',
                hi && 'bg-white/20 ring-1 ring-white/40 rounded-[2px] font-medium',
              )}
            >
              {level.price.toLocaleString()}
            </span>
            <span className="flex-1" />
          </div>
        )
      })}
      {/* 매도/매수 구분선 */}
      <div className="h-px bg-white/[0.1] mx-4" />
      {/* 매수 (bids) — 그래프를 잔량(오른쪽)과 같은 방향에 둠 */}
      {bids.map((level, i) => {
        const hi = currentPrice !== undefined && level.price === currentPrice
        return (
          <div key={`b-${i}`} className="flex items-center px-4 py-[5px] relative h-[26px]">
            <div
              className="absolute right-0 top-0 bottom-0 bg-[#00b26b]/20"
              style={{ width: `${(level.quantity / maxQty) * 50}%` }}
            />
            <span className="flex-1" />
            <span
              className={cn(
                'w-[80px] text-center text-[#00b26b] relative z-10 py-[1px]',
                hi && 'bg-white/20 ring-1 ring-white/40 rounded-[2px] font-medium',
              )}
            >
              {level.price.toLocaleString()}
            </span>
            <span className="flex-1 text-right text-[#00b26b] relative z-10">{level.quantity.toLocaleString()}</span>
          </div>
        )
      })}
      {/* 매수 레벨 부족분 패딩 */}
      {Array.from({ length: bidInnerPad }).map((_, i) => padRow(`bp-${i}`))}
      {/* 하단 패딩 (선물 아래 맞춤용) */}
      {Array.from({ length: bottomPad }).map((_, i) => padRow(`bt-${i}`))}
    </div>
  )
}

// 스프레드 호가창 (단일 패널)
interface SpreadOrderbookModalProps {
  spreadCode: string
  spotName: string
  onClose: () => void
}

export function SpreadOrderbookModal({ spreadCode, spotName, onClose }: SpreadOrderbookModalProps) {
  const spreadOb = useMarketStore((s) => s.orderbookTicks[spreadCode])
  const clearOrderbook = useMarketStore((s) => s.clearOrderbook)
  const spreadTick = useMarketStore((s) => s.futuresTicks[spreadCode])

  useEffect(() => {
    obFetch('/realtime/orderbook/subscribe', { spread_code: spreadCode })

    return () => {
      obFetch('/realtime/orderbook/unsubscribe')
      clearOrderbook(spreadCode)
    }
  }, [spreadCode, clearOrderbook])

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])
  useEffect(() => {
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [handleKey])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-[#111111] rounded-sm border border-white/[0.06] shadow-2xl w-[480px] max-h-[95vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06] flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-white font-medium">{spotName} 스프레드</span>
            <span className="text-[10px] text-white/60 tabular-nums">{spreadCode}</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[12px] text-white tabular-nums">
              {spreadTick?.price ? spreadTick.price.toLocaleString() : '-'}
            </span>
            <button onClick={onClose} className="text-[#5a5a5e] hover:text-white text-[16px] transition-colors leading-none">&times;</button>
          </div>
        </div>

        {/* 호가 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <OrderbookPanel data={spreadOb} maxLevels={5} currentPrice={spreadTick?.price} />
        </div>

        {/* 하단: 매도총 | 중간가 | 매수총 */}
        <div className="flex justify-between items-center px-4 py-2 border-t border-white/[0.06] text-[10px] tabular-nums flex-shrink-0">
          <span className="text-[#bb4a65]">매도 {spreadOb ? spreadOb.total_ask_qty.toLocaleString() : '-'}</span>
          <span className="text-white/70 text-[11px]">{midPrice(spreadOb)}</span>
          <span className="text-[#00b26b]">매수 {spreadOb ? spreadOb.total_bid_qty.toLocaleString() : '-'}</span>
        </div>
      </div>
    </div>
  )
}
