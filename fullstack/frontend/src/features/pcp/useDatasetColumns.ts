/**
 * Dataset loading + columnar conversion for the engine pipeline.
 * Replaces useDatasetData's per-row object building (O(rows×cols) objects and
 * O(n²) indexOf lookups) with typed column arrays + rowId→index maps.
 */
import { useEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { api, fetchArrowView, type MaDisplayAxis } from '../../api/client'

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

const cache = new Map<string, ColumnarData>()
const pending = new Map<string, Promise<ColumnarData>>()

export function invalidateColumnarCache() {
  cache.clear()
  pending.clear()
}

export function useColumnarData(datasetId: string | null, columns?: string[], maAxes?: MaDisplayAxis[]): ColumnarData | null {
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision ?? 1)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const axesKey = maAxes?.length ? JSON.stringify([...maAxes].sort((a, b) => a.key.localeCompare(b.key))) : null
  const columnKey = columns === undefined ? null : JSON.stringify([...new Set(columns)].sort())
  const cacheKey = datasetId ? JSON.stringify([datasetId, dataRevision, columnKey, axesKey, axesKey ? schemaRevision : null]) : null
  const [data, setData] = useState<ColumnarData | null>(() => cacheKey ? cache.get(cacheKey) ?? null : null)
  const loadedKey = useRef(cacheKey && cache.has(cacheKey) ? cacheKey : null)

  useEffect(() => {
    if (!datasetId || !cacheKey) { setData(null); return }
    const cached = cache.get(cacheKey)
    if (cached) { loadedKey.current = cacheKey; setData(cached); return }
    let cancelled = false
    setData(null)
    let request = pending.get(cacheKey)
    if (!request) {
      const wanted: string[] | undefined = columnKey === null ? undefined : JSON.parse(columnKey)
      const projectedAxes: MaDisplayAxis[] = axesKey ? JSON.parse(axesKey) : []
      request = Promise.all([
        api.get<{ schema: SchemaColumn[] }>(`/datasets/${datasetId}`),
        projectedAxes.length ? fetchArrowView(datasetId, wanted, undefined, { maAxes: projectedAxes, expectedDataRevision: dataRevision, expectedSchemaRevision: schemaRevision }) : fetchArrowView(datasetId, wanted),
      ]).then(([meta, view]) => buildColumnar(view.__rowId__ as string[],
        [...(wanted === undefined ? meta.schema : meta.schema.filter(column => wanted.includes(column.name))),
          ...projectedAxes.map(axis => ({ name: axis.key, columnId: axis.key, semanticType: 'numeric' }))], view))
      pending.set(cacheKey, request)
      const shared = request
      void request.then(built => { if (pending.get(cacheKey) === shared) cache.set(cacheKey, built) })
        .catch(() => undefined).finally(() => { if (pending.get(cacheKey) === shared) pending.delete(cacheKey) })
    }
    void request.then(built => {
      if (!cancelled) { loadedKey.current = cacheKey; setData(built) }
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [datasetId, cacheKey, columnKey])
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
