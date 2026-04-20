import { useEffect } from 'react'
import { useMarketStore } from '../stores/marketStore'

export function useWebSocket() {
  useEffect(() => {
    let ws: WebSocket | null = null
    let stopped = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/market`

    function connect() {
      if (stopped) return

      const socket = new WebSocket(wsUrl)
      ws = socket

      socket.onopen = () => {
        if (stopped) { socket.close(); return }
        useMarketStore.getState().setConnected(true)
        socket.send('subscribe')
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          const store = useMarketStore.getState()
          if (msg.type === 'etf_tick') store.updateETFTick(msg.data)
          else if (msg.type === 'stock_tick') store.updateStockTick(msg.data)
          else if (msg.type === 'futures_tick') store.updateFuturesTick(msg.data)
        } catch { /* ignore */ }
      }

      socket.onclose = () => {
        if (ws === socket) ws = null
        useMarketStore.getState().setConnected(false)
        if (!stopped) {
          reconnectTimer = setTimeout(connect, 3000)
        }
      }

      socket.onerror = () => {
        socket.close()
      }
    }

    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onclose = null  // cleanup에서 닫을 때 reconnect 방지
        ws.close()
        ws = null
      }
    }
  }, [])
}
