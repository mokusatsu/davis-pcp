/**
 * Dataset loading + columnar conversion for the engine pipeline.
 * Replaces useDatasetData's per-row object building (O(rows×cols) objects and
 * O(n²) indexOf lookups) with typed column arrays + rowId→index maps.
 */
import { useEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { api, fetchArrowView } from '../../api/client'

export interface SchemaColumn {
  columnId: string
  name: string
  semanticType: string
}

export interface ColumnarData {
  rowIds: string[]
  /** rowId → row index (O(1) membership/lookup) */
  rowIndex: Map<string, number>
  schema: SchemaColumn[]
  columns: Record<string, unknown[]>
  /** numeric view per column; NaN for missing/non-numeric */
  numeric: Record<string, Float64Array>
  minMax: Record<string, { min: number; max: number }>
  categories: Record<string, string[]>
}

let cache: { key: string | null; data: ColumnarData | null } = { key: null, data: null }
let pending: { key: string; promise: Promise<ColumnarData> } | null = null

export function invalidateColumnarCache() {
  cache = { key: null, data: null }
  pending = null
}

export function useColumnarData(datasetId: string | null): ColumnarData | null {
  const revision = useSelector((s: RootState) => s.selection.revision ?? 0)
  const schemaRevision = useSelector((s: RootState) => s.codebook?.datasetId === datasetId ? s.codebook.schemaRevision : 0)
  const cacheKey = datasetId ? `${datasetId}:${revision}:${schemaRevision}` : null
  const [data, setData] = useState<ColumnarData | null>(() =>
    cache.key === cacheKey ? cache.data : null)
  const loadedKey = useRef(cache.key === cacheKey ? cacheKey : null)

  useEffect(() => {
    if (!datasetId || !cacheKey) {
      setData(null)
      return
    }
    if (cache.key === cacheKey && cache.data) {
      loadedKey.current = cacheKey
      setData(cache.data)
      return
    }
    let cancelled = false
    setData(null)
    if (pending?.key !== cacheKey) {
      const request = {
        key: cacheKey,
        promise: Promise.all([
          api.get<{ schema: SchemaColumn[] }>(`/datasets/${datasetId}`), fetchArrowView(datasetId),
        ]).then(([meta, view]) => buildColumnar(view.__rowId__ as string[], meta.schema, view)),
      }
      pending = request
      void request.promise.then(built => {
        if (pending === request) cache = { key: cacheKey, data: built }
      }).catch(() => undefined).finally(() => { if (pending === request) pending = null })
    }
    void pending.promise.then(built => {
      if (!cancelled) { loadedKey.current = cacheKey; setData(built) }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [datasetId, cacheKey, revision])
  return loadedKey.current === cacheKey ? data : null
}

function buildColumnar(rowIds: string[], schema: SchemaColumn[], view: Record<string, unknown[]>): ColumnarData {
  const rowIndex = new Map<string, number>()
  rowIds.forEach((id, i) => { if (!rowIndex.has(id)) rowIndex.set(id, i) })
  const numeric: Record<string, Float64Array> = {}
  const minMax: Record<string, { min: number; max: number }> = {}
  const categories: Record<string, string[]> = {}
  for (const column of schema) {
    const raw = view[column.name] ?? []
    if (column.semanticType === 'numeric') {
      const arr = new Float64Array(raw.length)
      let min = Infinity
      let max = -Infinity
      let has = false
      for (let i = 0; i < raw.length; i += 1) {
        const v = raw[i] == null ? NaN : typeof raw[i] === 'number' ? raw[i] as number : Number(raw[i])
        arr[i] = Number.isFinite(v) ? v : NaN
        if (Number.isFinite(v)) {
          has = true
          if (v < min) min = v
          if (v > max) max = v
        }
      }
      numeric[column.name] = arr
      minMax[column.name] = has ? { min, max } : { min: 0, max: 0 }
    } else {
      const cats = [...new Set(raw.map((v) => String(v)))].sort()
      categories[column.name] = cats
    }
  }
  return { rowIds, rowIndex, schema, columns: view, numeric, minMax, categories }
}
