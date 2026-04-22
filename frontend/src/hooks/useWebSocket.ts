import { useEffect } from 'react'
import { useMarketStore } from '../stores/marketStore'

export function useWebSocket() {
  useEffect(() => {
    let stopped = false
    let ws: WebSocket | null = null
    let rafId = 0
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/ws/market`

    // 틱 버퍼: 프레임마다 한 번 flush. setInterval(100ms) 대신 requestAnimationFrame으로
    // 최악 지연을 100ms → ~16ms(60fps)로 단축. 탭 백그라운드에서는 rAF가 느려지므로
    // 기존 100ms 인터벌보다 CPU 덜 먹음.
    let etfBuf: Record<string, any> = {}
    let stockBuf: Record<string, any> = {}
    let futuresBuf: Record<string, any> = {}
    let obBuf: Record<string, any> = {}
    let dirty = false

    const flush = () => {
      rafId = requestAnimationFrame(flush)
      if (!dirty) return
      dirty = false
      const store = useMarketStore.getState()

      const hasEtf = Object.keys(etfBuf).length > 0
      const hasStock = Object.keys(stockBuf).length > 0
      const hasFutures = Object.keys(futuresBuf).length > 0
      const hasOb = Object.keys(obBuf).length > 0

      if (hasEtf) { store.batchUpdateETFs(etfBuf); etfBuf = {} }
      if (hasStock) { store.batchUpdateStocks(stockBuf); stockBuf = {} }
      if (hasFutures) { store.batchUpdateFutures(futuresBuf); futuresBuf = {} }
      if (hasOb) { store.batchUpdateOrderbooks(obBuf); obBuf = {} }
    }
    rafId = requestAnimationFrame(flush)

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
          else if (msg.type === 'orderbook_tick') obBuf[msg.data.code] = msg.data
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
      cancelAnimationFrame(rafId)
      if (ws) { ws.onclose = null; ws.close() }
    }
  }, [])
}
