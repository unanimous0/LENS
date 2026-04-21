import { useEffect } from 'react'
import { useMarketStore } from '../stores/marketStore'

const FLUSH_MS = 100

export function useWebSocket() {
  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/market`

    // 틱 버퍼: 100ms마다 한번에 batch store 반영 (1번의 set() 호출)
    let etfBuf: Record<string, any> = {}
    let stockBuf: Record<string, any> = {}
    let futuresBuf: Record<string, any> = {}
    let dirty = false

    const flush = setInterval(() => {
      if (!dirty) return
      dirty = false
      const store = useMarketStore.getState()

      const hasEtf = Object.keys(etfBuf).length > 0
      const hasStock = Object.keys(stockBuf).length > 0
      const hasFutures = Object.keys(futuresBuf).length > 0

      if (hasEtf) { store.batchUpdateETFs(etfBuf); etfBuf = {} }
      if (hasStock) { store.batchUpdateStocks(stockBuf); stockBuf = {} }
      if (hasFutures) { store.batchUpdateFutures(futuresBuf); futuresBuf = {} }
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
          if (msg.type === 'etf_tick') etfBuf[msg.data.code] = msg.data
          else if (msg.type === 'stock_tick') stockBuf[msg.data.code] = msg.data
          else if (msg.type === 'futures_tick') futuresBuf[msg.data.code] = msg.data
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
