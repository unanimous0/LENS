import { useEffect } from 'react'
import { useMarketStore } from '../stores/marketStore'

const FLUSH_MS = 100

export function useWebSocket() {
  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/market`

    // 틱 버퍼: 100ms마다 한번에 store 반영
    const buf: Record<string, Record<string, any>> = { etf: {}, stock: {}, futures: {} }
    let dirty = false

    const flush = setInterval(() => {
      if (!dirty) return
      dirty = false
      const store = useMarketStore.getState()
      const eKeys = Object.keys(buf.etf)
      if (eKeys.length) { for (const k of eKeys) store.updateETFTick(buf.etf[k]); buf.etf = {} }
      const sKeys = Object.keys(buf.stock)
      if (sKeys.length) { for (const k of sKeys) store.updateStockTick(buf.stock[k]); buf.stock = {} }
      const fKeys = Object.keys(buf.futures)
      if (fKeys.length) { for (const k of fKeys) store.updateFuturesTick(buf.futures[k]); buf.futures = {} }
    }, FLUSH_MS)

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
          if (msg.type === 'etf_tick') buf.etf[msg.data.code] = msg.data
          else if (msg.type === 'stock_tick') buf.stock[msg.data.code] = msg.data
          else if (msg.type === 'futures_tick') buf.futures[msg.data.code] = msg.data
          dirty = true
        } catch {}
      }

      socket.onclose = () => {
        if (ws === socket) ws = null
        useMarketStore.getState().setConnected(false)
        if (!stopped) setTimeout(connect, 3000)
      }

      socket.onerror = () => socket.close()
    }

    connect()
    return () => {
      stopped = true
      clearInterval(flush)
      if (ws) { ws.onclose = null; ws.close() }
    }
  }, [])
}
