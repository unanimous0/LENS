import { useEffect, useRef } from 'react'
import { useMarketStore } from '../stores/marketStore'

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const { updateETFTick, updateStockTick, updateFuturesTick, setConnected } = useMarketStore()

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/market`

    function connect() {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        ws.send('subscribe')
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'etf_tick') updateETFTick(msg.data)
          else if (msg.type === 'stock_tick') updateStockTick(msg.data)
          else if (msg.type === 'futures_tick') updateFuturesTick(msg.data)
        } catch { /* ignore parse errors */ }
      }

      ws.onclose = () => {
        setConnected(false)
        setTimeout(connect, 3000)
      }

      ws.onerror = () => ws.close()
    }

    connect()
    return () => { wsRef.current?.close() }
  }, [updateETFTick, updateStockTick, updateFuturesTick, setConnected])
}
