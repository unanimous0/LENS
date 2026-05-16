import { useEffect } from 'react'
import { useMarketStore } from '../stores/marketStore'
import { useLpStore } from '../stores/lpStore'

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

      // 단일 tick 디스패치. batch envelope에서도 재사용.
      // 새 tick 타입 추가 시 marketStore.ts shape + types/market.ts + 여기 분기 세 곳 동시 등록 필요.
      // 미등록 타입은 warn 1회 노출 후 드롭 — 침묵 드롭 회피 (CLAUDE.md "실시간 페이지" 룰 참조).
      const warnedTypes = new Set<string>()
      const dispatchOne = (m: any) => {
        if (m.type === 'etf_tick') {
          etfBuf[m.data.code] = m.data
          // 체결 단위 정보(cgubun + cvolume)가 있으면 즉시 trades에 push.
          // batch buf는 같은 code가 overwrite라 체결 시퀀스 보존이 안 됨 — 별도 store 직접 호출.
          if (m.data.trade_side != null && m.data.last_trade_volume != null && m.data.price > 0) {
            useMarketStore.getState().pushEtfTrade(m.data.code, {
              t: Date.now(),
              price: m.data.price,
              volume: m.data.last_trade_volume,
              side: m.data.trade_side,
            })
          }
        }
        else if (m.type === 'stock_tick') stockBuf[m.data.code] = m.data
        else if (m.type === 'futures_tick') futuresBuf[m.data.code] = m.data
        else if (m.type === 'orderbook_tick') obBuf[m.data.code] = m.data
        // LP 매트릭스 — Rust가 200ms throttle로 보내므로 rAF 묶지 않고 즉시 store 반영
        else if (m.type === 'fair_value_matrix') useLpStore.getState().setMatrix(m.data)
        else if (m.type === 'book_risk') useLpStore.getState().setBookRisk(m.data)
        else if (!warnedTypes.has(m.type)) {
          warnedTypes.add(m.type)
          console.warn('[useWebSocket] unhandled tick type:', m.type, '— register in marketStore + dispatchOne')
        }
      }

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          // 서버가 150ms마다 보내는 batch envelope: {type:'batch', ticks:[...]}.
          // 스냅샷 flush는 개별 tick으로 와서 둘 다 처리.
          if (msg.type === 'batch') {
            const ticks = msg.ticks
            if (Array.isArray(ticks)) {
              for (let i = 0; i < ticks.length; i++) dispatchOne(ticks[i])
            }
          } else {
            dispatchOne(msg)
          }
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
