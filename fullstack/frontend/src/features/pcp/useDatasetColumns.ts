/**
 * Dataset loading + columnar conversion for the engine pipeline.
 * Replaces useDatasetData's per-row object building (O(rows×cols) objects and
 * O(n²) indexOf lookups) with typed column arrays + rowId→index maps.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { api, fetchArrowView, type MaDisplayAxis } from '../../api/client'
import {
  acquireColumnarData, getColumnarCacheGeneration, readColumnarCache,
  retainColumnarCacheScope, subscribeColumnarCacheInvalidation,
} from './columnarCache'

export { invalidateColumnarCache } from './columnarCache'

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

export function useColumnarData(datasetId: string | null, columns?: string[], maAxes?: MaDisplayAxis[]): ColumnarData | null {
  const dataRevision = useSelector((s: RootState) => s.selection.dataRevision ?? 1)
  const schemaRevision = useSelector((s: RootState) => s.codebook.schemaRevision)
  const generation = useSyncExternalStore(subscribeColumnarCacheInvalidation, getColumnarCacheGeneration, getColumnarCacheGeneration)
  const axesKey = maAxes?.length ? JSON.stringify([...maAxes].sort((a, b) => a.key.localeCompare(b.key))) : null
  const axisSchemaRevision = axesKey ? schemaRevision : null
  const columnKey = columns === undefined ? null : JSON.stringify([...new Set(columns)].sort())
  const cacheKey = datasetId ? JSON.stringify([datasetId, dataRevision, columnKey, axesKey, axesKey ? schemaRevision : null]) : null
  const viewKey = cacheKey ? JSON.stringify([generation, cacheKey]) : null
  const [loaded, setLoaded] = useState<{ key: string | null; data: ColumnarData | null }>(() => ({
    key: viewKey, data: cacheKey ? readColumnarCache(cacheKey) : null,
  }))

  useEffect(() => {
    // A null argument can mean this hook uses externally supplied data; it must
    // not flush other mounted consumers. Store lifecycle changes handle clearing
    // the selected dataset even when there are no columnar consumers mounted.
    if (datasetId) retainColumnarCacheScope({ datasetId, dataRevision, schemaRevision })
  }, [datasetId, dataRevision, schemaRevision])

  useEffect(() => {
    if (!datasetId || !cacheKey) { setLoaded({ key: null, data: null }); return }
    const wanted: string[] | undefined = columnKey === null ? undefined : JSON.parse(columnKey)
    const projectedAxes: MaDisplayAxis[] = axesKey ? JSON.parse(axesKey) : []
    setLoaded({ key: viewKey, data: null })
    return acquireColumnarData(cacheKey, {
      datasetId, dataRevision, schemaRevision: axisSchemaRevision,
    }, () => loadColumnarData(datasetId, wanted, projectedAxes, dataRevision, axisSchemaRevision),
    data => setLoaded({ key: viewKey, data }))
  }, [datasetId, cacheKey, columnKey, axesKey, dataRevision, axisSchemaRevision, generation, viewKey])
  return loaded.key === viewKey ? loaded.data : null
}

// Keep the conversion reaction independent of the hook's React state closure.
function loadColumnarData(
  datasetId: string,
  wanted: string[] | undefined,
  projectedAxes: MaDisplayAxis[],
  dataRevision: number,
  schemaRevision: number | null,
): Promise<ColumnarData> {
  return Promise.all([
    api.get<{ schema: SchemaColumn[] }>(`/datasets/${datasetId}`),
    projectedAxes.length ? fetchArrowView(datasetId, wanted, undefined, {
      maAxes: projectedAxes, expectedDataRevision: dataRevision, expectedSchemaRevision: schemaRevision ?? undefined,
    }) : fetchArrowView(datasetId, wanted),
  ]).then(([meta, view]) => buildColumnar(view.__rowId__ as string[],
    [...(wanted === undefined ? meta.schema : meta.schema.filter(column => wanted.includes(column.name))),
      ...projectedAxes.map(axis => ({ name: axis.key, columnId: axis.key, semanticType: 'numeric' }))], view))
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
