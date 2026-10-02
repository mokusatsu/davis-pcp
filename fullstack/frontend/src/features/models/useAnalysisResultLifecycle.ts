import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useAnalysisViewActive } from '../selection/analysisScope'

type Task<T> = (isCurrent: () => boolean) => Promise<T>
type Revisions = { data: number; schema: number }

/**
 * One request per mounted consumer, including across task/activity changes.
 * Cleanup invalidates the consumer, not the underlying API/model operation.
 * A superseding task waits for the old request to settle, then runs only the
 * latest task. Poll delays start after settlement, so a blocked worker cannot
 * accumulate another request on every tick.
 */
function useActiveTask<T>(task: Task<T> | null, active: boolean, intervalMs?: number): T | null {
  const [resolved, setResolved] = useState<{ task: Task<T>; value: T } | null>(null)
  const inFlight = useRef(false)
  const wake = useRef<(() => void) | null>(null)
  const current = useRef({ task, active })
  current.current = { task, active }

  useEffect(() => {
    setResolved(previous => previous?.task === task ? previous : null)
    if (!task || !active) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const isCurrent = (): boolean => !cancelled && current.current.task === task
      && current.current.active && document.visibilityState !== 'hidden'
    const run = (): void => {
      if (!isCurrent() || inFlight.current) return
      inFlight.current = true
      void (async () => {
        try {
          const value = await task(isCurrent)
          if (isCurrent()) setResolved({ task, value })
        } catch {
          // Revision failures must not make a result stale. Retry after the
          // normal delay, or immediately when a newer task becomes current.
        } finally {
          inFlight.current = false
          if (isCurrent()) {
            if (intervalMs !== undefined) timer = setTimeout(run, intervalMs)
          } else {
            wake.current?.()
          }
        }
      })()
    }
    wake.current = run
    run()
    return () => {
      cancelled = true
      clearTimeout(timer)
      wake.current = null
    }
  }, [task, active, intervalMs])

  // Never expose a previous result/dataset/selection's resolved value, even
  // during the render before effect cleanup has run.
  return resolved?.task === task ? resolved.value : null
}

interface AnalysisResultIdentity {
  resultId: string
  meta: { datasetId: string }
}

/** Background projections only; Redux selection and user-requested fits remain authoritative. */
export function useAnalysisResultLifecycle(
  result: AnalysisResultIdentity | null,
  datasetId: string | null,
  selectedRowIds: readonly string[],
  dataRevision: number,
  schemaRevision: number,
): { liveRevisions: Revisions | null; linkedCategoryIds: Set<string> } {
  const routeActive = useAnalysisViewActive()
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onVisibility = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  const active = routeActive && visible
  // Dataset reset effects run after rendering, so reject the prior dataset's
  // result before starting any background work for the newly selected dataset.
  const resultId = result?.meta.datasetId === datasetId ? result?.resultId : undefined
  const revisionTask = useMemo<Task<Revisions> | null>(() => {
    if (!datasetId || !resultId) return null
    return async () => {
      const meta = await api.get<{ dataRevision: number; schemaRevision: number }>(`/datasets/${datasetId}`)
      return { data: meta.dataRevision, schema: meta.schemaRevision }
    }
  }, [datasetId, resultId, dataRevision, schemaRevision])
  const membershipTask = useMemo<Task<Set<string>> | null>(() => {
    if (!datasetId || !resultId || selectedRowIds.length === 0) return null
    return async (isCurrent) => {
      const hit = new Set<string>()
      const selected = new Set(selectedRowIds)
      let offset = 0
      try {
        for (;;) {
          const page = await api.post<{ payload: string; nextOffset: number | null }>(
            `/analysis-results/${resultId}/export`,
            { format: 'json', table: 'members', offset, limit: 5000 },
          )
          // Stop pagination on hide or supersession. Already queued requests
          // still settle; no model work or central selection is canceled.
          if (!isCurrent()) return hit
          let rows: [string, string, string][] = []
          try { rows = JSON.parse(page.payload)?.rows ?? [] } catch { /* malformed/empty export */ }
          for (const [categoryId, rowId] of rows) {
            if (selected.has(String(rowId))) hit.add(String(categoryId))
          }
          if (page.nextOffset === null || page.nextOffset === undefined) break
          offset = page.nextOffset
        }
        return hit
      } catch {
        return new Set<string>()
      }
    }
  }, [datasetId, resultId, selectedRowIds, dataRevision, schemaRevision])
  const emptyCategories = useMemo(() => new Set<string>(), [])
  const liveRevisions = useActiveTask(revisionTask, active, 10000)
  const linkedCategoryIds = useActiveTask(membershipTask, active) ?? emptyCategories
  return { liveRevisions, linkedCategoryIds }
}
