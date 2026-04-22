import { useEffect, useCallback } from 'react'
import { useMarketStore } from '@/stores/marketStore'
import { cn } from '@/lib/utils'
import type { OrderbookTick } from '@/types/market'

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
    fetch('/realtime/orderbook/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spot_code: spotCode, futures_code: futuresCode }),
    }).catch(() => {})

    return () => {
      fetch('/realtime/orderbook/unsubscribe', { method: 'POST' }).catch(() => {})
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
        className="bg-[#111111] rounded-sm border border-white/[0.06] shadow-2xl w-[900px] h-[70vh] flex flex-col"
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

        {/* 호가 패널 */}
        <div className="flex flex-1 min-h-0">
          {/* 선물 */}
          <div className="flex-1 flex flex-col min-h-0 border-r border-white/[0.06]">
            <div className="px-4 py-2 border-b border-white/[0.06] flex-shrink-0">
              <span className="text-[11px] text-white/60">선물</span>
              <span className="ml-2 text-[12px] text-white tabular-nums">{futuresTick?.price ? futuresTick.price.toLocaleString() : '-'}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <OrderbookPanel data={futuresOb} maxLevels={5} />
            </div>
          </div>
          {/* 현물 */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 py-2 border-b border-white/[0.06] flex-shrink-0">
              <span className="text-[11px] text-white/60">현물</span>
              <span className="ml-2 text-[12px] text-white tabular-nums">{spotTick?.price ? spotTick.price.toLocaleString() : '-'}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <OrderbookPanel data={spotOb} maxLevels={10} />
            </div>
          </div>
        </div>

        {/* 하단 총잔량 */}
        <div className="flex border-t border-white/[0.06] text-[10px] tabular-nums flex-shrink-0">
          <div className="flex-1 flex justify-between px-4 py-2 border-r border-white/[0.06]">
            <span className="text-[#bb4a65]">매도 {futuresOb ? futuresOb.total_ask_qty.toLocaleString() : '-'}</span>
            <span className="text-[#00b26b]">매수 {futuresOb ? futuresOb.total_bid_qty.toLocaleString() : '-'}</span>
          </div>
          <div className="flex-1 flex justify-between px-4 py-2">
            <span className="text-[#bb4a65]">매도 {spotOb ? spotOb.total_ask_qty.toLocaleString() : '-'}</span>
            <span className="text-[#00b26b]">매수 {spotOb ? spotOb.total_bid_qty.toLocaleString() : '-'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function OrderbookPanel({ data, maxLevels }: { data?: OrderbookTick; maxLevels: number }) {
  if (!data || (data.asks.length === 0 && data.bids.length === 0)) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <span className="text-[11px] text-[#5a5a5e]">호가 대기 중...</span>
      </div>
    )
  }

  // 최대 잔량 (바 비율 계산용)
  const allQty = [...data.asks.map((l) => l.quantity), ...data.bids.map((l) => l.quantity)]
  const maxQty = Math.max(...allQty, 1)

  // asks: 높은가→낮은가 순서로 표시 (위에서 아래로), 최우선 매도가 맨 아래
  const asks = data.asks.slice(0, maxLevels)
  const bids = data.bids.slice(0, maxLevels)

  // asks를 역순 (높은 가격이 위)
  const reversedAsks = [...asks].reverse()

  // asks 빈 줄 패딩 (maxLevels에 맞추기)
  const askPad = maxLevels - reversedAsks.length

  return (
    <div className="flex flex-col text-[11px] tabular-nums">
      {/* 헤더 */}
      <div className="flex px-4 py-1 text-[9px] text-white/50 border-b border-white/[0.04]">
        <span className="flex-1 text-left">잔량</span>
        <span className="w-[80px] text-center">가격</span>
        <span className="flex-1 text-right">잔량</span>
      </div>
      {/* 매도 (asks) */}
      {Array.from({ length: askPad }).map((_, i) => (
        <div key={`pad-${i}`} className="flex px-4 py-[5px] h-[26px]" />
      ))}
      {reversedAsks.map((level, i) => (
        <div key={`a-${i}`} className="flex items-center px-4 py-[5px] relative">
          <div
            className="absolute right-0 top-0 bottom-0 bg-[#bb4a65]/10"
            style={{ width: `${(level.quantity / maxQty) * 50}%` }}
          />
          <span className="flex-1 text-left text-[#bb4a65] relative z-10">{level.quantity.toLocaleString()}</span>
          <span className="w-[80px] text-center text-[#bb4a65] relative z-10">{level.price.toLocaleString()}</span>
          <span className="flex-1" />
        </div>
      ))}
      {/* 구분선 — 현재가 */}
      <div className="flex items-center px-4 py-[3px] border-y border-white/[0.06]">
        <span className="flex-1" />
        <span className="w-[80px] text-center text-[10px] text-white">
          {bids.length > 0 && asks.length > 0
            ? ((asks[0].price + bids[0].price) / 2).toLocaleString(undefined, { maximumFractionDigits: 0 })
            : '-'}
        </span>
        <span className="flex-1" />
      </div>
      {/* 매수 (bids) */}
      {bids.map((level, i) => (
        <div key={`b-${i}`} className="flex items-center px-4 py-[5px] relative">
          <div
            className="absolute left-0 top-0 bottom-0 bg-[#00b26b]/10"
            style={{ width: `${(level.quantity / maxQty) * 50}%` }}
          />
          <span className="flex-1" />
          <span className="w-[80px] text-center text-[#00b26b] relative z-10">{level.price.toLocaleString()}</span>
          <span className="flex-1 text-right text-[#00b26b] relative z-10">{level.quantity.toLocaleString()}</span>
        </div>
      ))}
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
    fetch('/realtime/orderbook/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spread_code: spreadCode }),
    }).catch(() => {})

    return () => {
      fetch('/realtime/orderbook/unsubscribe', { method: 'POST' }).catch(() => {})
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
        className="bg-[#111111] rounded-sm border border-white/[0.06] shadow-2xl w-[480px] h-[60vh] flex flex-col"
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
          <OrderbookPanel data={spreadOb} maxLevels={5} />
        </div>

        {/* 하단 */}
        <div className="flex justify-between px-4 py-2 border-t border-white/[0.06] text-[10px] tabular-nums flex-shrink-0">
          <span className="text-[#bb4a65]">매도 {spreadOb ? spreadOb.total_ask_qty.toLocaleString() : '-'}</span>
          <span className="text-[#00b26b]">매수 {spreadOb ? spreadOb.total_bid_qty.toLocaleString() : '-'}</span>
        </div>
      </div>
    </div>
  )
}
