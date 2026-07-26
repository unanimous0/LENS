import { useCallback, useEffect, useRef, useState } from 'react'

import {
  DEFAULT_TARGET_Z,
  createAlert,
  deleteAlert,
  fetchAlerts,
  markTriggered,
  pairKey,
  patchAlert,
} from '@/lib/stat-arb/alerts'
import type { AlertDirection, StatArbAlert } from '@/lib/stat-arb/alerts'

/**
 * 목표 z 알림(워치리스트) 목록 + CRUD.
 *
 * 목록 페이지(🔔 토글)와 워치리스트 패널이 같은 상태를 공유하도록 페이지 루트에서 1회 호출하고
 * 패널에 내려준다. 상세 페이지는 별도 탭(별도 React 트리)이라 자체 인스턴스를 쓴다.
 *
 * 콜백은 전부 stable(useCallback with no deps) — 500행 테이블의 행 useMemo를 깨지 않기 위함.
 */
export function useStatArbAlerts() {
  const [alerts, setAlerts] = useState<StatArbAlert[]>([])
  const [error, setError] = useState<string | null>(null)
  // 콜백 안에서 최신 목록을 참조하되 콜백 identity는 고정 (500행 테이블 memo 보존).
  const alertsRef = useRef<StatArbAlert[]>([])
  useEffect(() => {
    alertsRef.current = alerts
  }, [alerts])

  // setState는 전부 promise 콜백 안에서만 — effect 본문 동기 setState(cascading render) 회피.
  const reload = useCallback(
    () =>
      fetchAlerts()
        .then((items) => {
          setAlerts(items)
          setError(null)
        })
        .catch((e) => setError(String(e))),
    []
  )

  useEffect(() => {
    void reload()
  }, [reload])

  /** 서버가 돌려준 row로 목록 갱신 (같은 id면 교체, 없으면 앞에 추가). */
  const upsertLocal = useCallback((row: StatArbAlert) => {
    setAlerts((prev) => {
      const i = prev.findIndex((a) => a.id === row.id)
      if (i < 0) return [row, ...prev]
      const next = [...prev]
      next[i] = row
      return next
    })
  }, [])

  const add = useCallback(
    async (input: {
      left_key: string
      right_key: string
      left_name?: string
      right_name?: string
      target_z?: number
      direction?: AlertDirection
      note?: string
    }) => {
      try {
        const row = await createAlert({
          ...input,
          target_z: input.target_z ?? DEFAULT_TARGET_Z,
        })
        upsertLocal(row)
        setError(null)
        return row
      } catch (e) {
        setError(String(e))
        return null
      }
    },
    [upsertLocal]
  )

  const remove = useCallback(async (id: number) => {
    // 낙관적 제거 — 실패 시 reload로 복구.
    setAlerts((prev) => prev.filter((a) => a.id !== id))
    try {
      await deleteAlert(id)
    } catch (e) {
      setError(String(e))
      fetchAlerts().then(setAlerts).catch(() => {})
    }
  }, [])

  const update = useCallback(
    async (id: number, fields: { target_z?: number; enabled?: boolean; note?: string }) => {
      try {
        const row = await patchAlert(id, fields)
        upsertLocal(row)
        setError(null)
      } catch (e) {
        setError(String(e))
      }
    },
    [upsertLocal]
  )

  /** 목록 테이블 🔔 버튼 — 이미 있으면 해제, 없으면 기본 목표(2.0·abs)로 등록. */
  const toggle = useCallback(
    (input: { left_key: string; right_key: string; left_name?: string; right_name?: string }) => {
      const k = pairKey(input.left_key, input.right_key)
      const found = alertsRef.current.find((a) => pairKey(a.left_key, a.right_key) === k)
      if (found) return remove(found.id)
      return add(input)
    },
    [add, remove]
  )

  /** 발화 기록 — last_triggered_at은 서버 응답으로 덮되, 실패해도 화면은 유지. */
  const recordTrigger = useCallback(
    (id: number) => {
      markTriggered(id)
        .then(upsertLocal)
        .catch(() => {
          /* 발화 자체는 이미 됨 — 기록 실패는 무시 */
        })
    },
    [upsertLocal]
  )

  return { alerts, error, reload, add, remove, update, toggle, recordTrigger }
}

export type StatArbAlertsApi = ReturnType<typeof useStatArbAlerts>
