/**
 * PCP compute pipeline hook — bridges the React page to the engine.
 * Owns: axis metadata, active-row filtering (O(active) not O(all²)), the
 * engine geometry call, and the OffscreenCanvas render dispatch.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import type { RootState } from '../../app/store'
import { graphEngine } from '../../engine/graphClient'
import { useColumnarData, type ColumnarData, type SchemaColumn } from './useDatasetColumns'

export interface PcpAxis {
  key: string
  label: string
  type: 'numeric' | 'categorical'
  min: number
  max: number
  categories?: string[]
}

export function buildAxes(data: ColumnarData): PcpAxis[] {
  return data.schema.map((column: SchemaColumn) => {
    if (column.semanticType === 'numeric') {
      const mm = data.minMax[column.name] ?? { min: 0, max: 0 }
      return { key: column.name, label: column.name, type: 'numeric' as const, min: mm.min, max: mm.max }
    }
    const categories = data.categories[column.name] ?? []
    return {
      key: column.name,
      label: column.name,
      type: 'categorical' as const,
      min: 0,
      max: Math.max(0, categories.length - 1),
      categories,
    }
  })
}

export function l1CandidatesOf(axes: PcpAxis[]): PcpAxis[] {
  return axes.filter((a) => a.type === 'categorical' && (a.categories?.length ?? 0) >= 2 && (a.categories?.length ?? 0) <= 15)
}

import { selectEffectiveRowIds } from '../../app/store'

/** Active row indexes aligned with the effective row scope (Active / Selected / Sampled / All). */
export function useActiveRows(): number[] {
  const selection = useSelector((s: RootState) => s.selection)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)
  return useMemo(() => {
    if (!data) return []
    const out: number[] = []
    for (const id of effectiveRowIds) {
      const index = data.rowIndex.get(id)
      if (index !== undefined) out.push(index)
    }
    return out
  }, [data, effectiveRowIds])
}

export interface GeometryState {
  points: Float64Array
  nRows: number
  nAxes: number
  axisPos: number[]
  bounds: { left: number; right: number; top: number; bottom: number }
  /** active row ids in the same order as geometry rows */
  rowIds: string[]
}

/** Build the [row][axis] value matrix the engine consumes (numeric raw or
 *  categorical t∈[0,1]) for the given source row indexes. Shared by
 *  usePcpGeometry and usePcpSimplification so both see identical inputs.
 *  Missing cells become NaN in BOTH kinds — geometry clamps them to the axis
 *  top, and the K-Medoids distance treats one-sided NaN as a mismatch
 *  penalty. (Coercing missing categories to t=0 instead made 88%-sparse
 *  survey rows nearly identical and collapsed all clusters into one.) */
function buildValues(
  data: ColumnarData,
  axes: PcpAxis[],
  rowIndexes: number[],
): { values: Float64Array; rowIds: string[] } {
  const nAxes = axes.length
  const nRows = rowIndexes.length
  const values = new Float64Array(nRows * nAxes)
  const rowIds = new Array<string>(nRows)
  // Pre-build category → index maps for O(1) lookup instead of O(cats) indexOf
  const catMaps: (Map<string, number> | null)[] = axes.map(axis => {
    if (axis.type !== 'categorical') return null
    const map = new Map<string, number>()
    ;(axis.categories ?? []).forEach((cat, i) => map.set(cat, i))
    return map
  })
  for (let r = 0; r < nRows; r += 1) {
    const srcIndex = rowIndexes[r]
    rowIds[r] = data.rowIds[srcIndex]
    for (let a = 0; a < nAxes; a += 1) {
      const axis = axes[a]
      if (axis.type === 'categorical') {
        const catMap = catMaps[a]!
        const raw = data.columns[axis.key]?.[srcIndex]
        // Arrow nulls / empty strings are missing values. (String(null) is
        // the literal "null" — checking the raw value first is mandatory or
        // 88%-sparse survey columns collapse every row onto one category.)
        const rawStr = raw === undefined || raw === null ? '' : String(raw).trim()
        const idx = rawStr ? (catMap.get(rawStr) ?? -1) : -1
        const cats = axis.categories ?? []
        values[r * nAxes + a] = idx < 0
          ? NaN
          : cats.length <= 1 ? 0.5 : idx / (cats.length - 1)
      } else {
        values[r * nAxes + a] = data.numeric[axis.key]?.[srcIndex] ?? NaN
      }
    }
  }
  return { values, rowIds }
}

export function usePcpGeometry(params: {
  width: number
  height: number
  orderedVisibleAxes: PcpAxis[]
  activeRowIndexes: number[]
}): GeometryState | null {
  const selection = useSelector((s: RootState) => s.selection)
  const pcp = useSelector((s: RootState) => s.pcp)
  const data = useColumnarData(selection.datasetId)
  const [state, setState] = useState<GeometryState | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const seq = ++seqRef.current
    const { width, height, orderedVisibleAxes, activeRowIndexes } = params
    // width/height may be 0 on a hidden viewport at mount; computing with the
    // 1px minimum instead of bailing keeps the pipeline alive so the frame
    // lands as soon as real layout is measured (audit #1: a permanent
    // "描画準備中" state was worse than a brief mis-sized frame).
    const effWidth = Math.max(1, width)
    const effHeight = Math.max(1, height)
    if (!data || !orderedVisibleAxes.length || !activeRowIndexes.length) {
      setState(null)
      return
    }
    ;(async () => {
      const nAxes = orderedVisibleAxes.length
      const nRows = activeRowIndexes.length
      const { values, rowIds } = buildValues(data, orderedVisibleAxes, activeRowIndexes)
      const result = await graphEngine.pcpGeometry({
        width: effWidth,
        height: effHeight,
        orientation: pcp.orientation,
        axes: orderedVisibleAxes.map((a) => ({ key: a.key, min: a.min, max: a.max, isCategorical: a.type === 'categorical' })),
        reversed: pcp.reversed,
        jitterEnabled: pcp.jitterEnabled,
        jitterMode: pcp.jitterMode,
        jitterAmount: pcp.jitterAmount,
        jitterSeed: pcp.jitterSeed,
        rowIds,
        values,
      })
      if (!cancelled && seq === seqRef.current) {
        setState({ ...result, nRows, nAxes, rowIds })
      }
    })().catch(() => undefined)
    return () => { cancelled = true }
  }, [data, params.width, params.height, params.orderedVisibleAxes, params.activeRowIndexes, pcp.orientation, pcp.reversed, pcp.jitterEnabled, pcp.jitterMode, pcp.jitterAmount, pcp.jitterSeed])

  return state
}

// ---------------------------------------------------------------------------
// K-Medoids draw simplification — cluster representative rows only
// ---------------------------------------------------------------------------

export const SIMPLIFY_THRESHOLD = 500
export const SIMPLIFY_TARGET_K = 300
/** Swap rounds for the CLARA-style refinement phase. */
const KMEDOIDS_SWAP_ROUNDS = 3
/** Deterministic seed (xorshift32 nonzero). */
const KMEDOIDS_SEED = 0x5eed1234

function fnv1a(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

interface SimplificationResult {
  drawRowIndexes: number[]
  clusterSizes: Uint32Array
  /** Number of medoids the engine actually chose (≤ target k; fewer when
   *  many rows are duplicates — farthest-insert stops at distance 0). */
  medoidCount: number
  /** Retroactive hit mapping: geometry row (drawn line) → every active-row
   *  index it represents. A brush/click on a representative line selects the
   *  whole cluster so other views see the full member set. */
  membersOfDrawnRow: number[][]
}

interface SimplificationCacheEntry {
  promise: Promise<SimplificationResult>
  result: SimplificationResult | null
}

/** Module-level memo: selection toggles hit the cache and only re-merge the
 *  selected rows into drawRowIndexes (no K-Medoids rerun). Keyed by dataset +
 *  axis set + target k + active-row fingerprint. Bounded to the latest 4. */
const simplifyCache = new Map<string, SimplificationCacheEntry>()

export function usePcpSimplification(params: {
  orderedVisibleAxes: PcpAxis[]
  activeRowIndexes: number[]
}): SimplificationResult | null {
  const selection = useSelector((s: RootState) => s.selection)
  const pcp = useSelector((s: RootState) => s.pcp)
  const data = useColumnarData(selection.datasetId)
  const [state, setState] = useState<SimplificationResult | null>(null)
  const seqRef = useRef(0)

  const enabled = pcp.simplifyMode !== 'off'
    && params.activeRowIndexes.length > SIMPLIFY_THRESHOLD
    && params.orderedVisibleAxes.length > 0

  const cacheKey = useMemo(() => {
    if (!enabled || !data) return null
    const axisKeys = params.orderedVisibleAxes.map((a) => a.key).join(',')
    // Axes must belong to THIS dataset: a switch race can pair new axes with
    // the previous dataset object, and every columns[key] lookup would miss
    // (all-NaN values → one degenerate cluster → cached forever).
    const axesMatchDataset = params.orderedVisibleAxes.every((a) => a.key in data.columns)
    if (!axesMatchDataset) return null
    const rowFingerprint = fnv1a(selection.activeRowIds.join('|'))
    return `${selection.datasetId}|${axisKeys}|${SIMPLIFY_TARGET_K}|${KMEDOIDS_SEED}|${rowFingerprint}`
  }, [enabled, data, params.orderedVisibleAxes, selection.datasetId, selection.activeRowIds])

  useEffect(() => {
    if (!enabled || !cacheKey || !data) {
      setState(null)
      return
    }
    let cancelled = false
    const seq = ++seqRef.current
    // Keep the previous frame visible while a fresh K-Medoids runs — matches
    // the paint semantics of geometry (no blank flash between states).
    let entry = simplifyCache.get(cacheKey)
    if (!entry) {
      const rowIndexes = params.activeRowIndexes
      const axes = params.orderedVisibleAxes
      const promise = (async () => {
        const n = rowIndexes.length
        const d = axes.length
        const { values } = buildValues(data, axes, rowIndexes)
        const specs = new Float64Array(d * 3)
        axes.forEach((a, i) => {
          specs[i * 3] = a.type === 'categorical' ? 1 : 0
          specs[i * 3 + 1] = a.min
          specs[i * 3 + 2] = a.max
        })
        // Dataset-switch races can pair NEW axes with a STALE dataset object
        // (columns lookup misses → every value NaN). All-NaN input makes
        // every pairwise L1 distance 0, the medoid search collapses to one
        // cluster, and that degenerate result would be cached permanently —
        // so reject it here instead of computing.
        let finiteCount = 0
        for (let i = 0; i < values.length; i += 1) {
          if (Number.isFinite(values[i])) finiteCount += 1
        }
        if (finiteCount < n) {
          throw new Error(`kMedoids: degenerate input (${finiteCount} finite of ${values.length}) — dataset/axes mismatch`)
        }
        const res = await graphEngine.kMedoids(
          values, n, d, SIMPLIFY_TARGET_K, 0, KMEDOIDS_SWAP_ROUNDS, KMEDOIDS_SEED, specs,
        )
        // Merge: medoids ∪ selected rows (selection must always be visible),
        // ascending unique — geometry rows are index-ordered.
        const selectedSet = new Set<string>(selection.selectedRowIds)
        const drawSet = new Set<number>(res.medoidIndexes)
        for (let r = 0; r < n; r += 1) {
          if (selectedSet.has(data.rowIds[rowIndexes[r]])) drawSet.add(r)
        }
        const drawRowIndexes = [...drawSet].sort((a, b) => a - b).map((r) => rowIndexes[r])
        // Cluster size per drawn row: medoids carry their cluster size;
        // extra (non-medoid) selected rows carry their owning cluster's size.
        const clusterSizes = new Uint32Array(drawRowIndexes.length)
        // Retroactive hit mapping in the same order: drawn row → all active
        // rows assigned to its cluster (brush/click expand to full members).
        const clusterMembers = new Map<number, number[]>()
        for (let r = 0; r < n; r += 1) {
          const c = res.assignment[r]
          let list = clusterMembers.get(c)
          if (!list) { list = []; clusterMembers.set(c, list) }
          list.push(rowIndexes[r])
        }
        const membersOfDrawnRow: number[][] = new Array(drawRowIndexes.length)
        let out = 0
        for (let r = 0; r < n; r += 1) {
          if (!drawSet.has(r)) continue
          clusterSizes[out] = res.sizes[res.assignment[r]]
          membersOfDrawnRow[out] = clusterMembers.get(res.assignment[r]) ?? [rowIndexes[r]]
          out += 1
        }
        return { drawRowIndexes, clusterSizes, medoidCount: res.medoidIndexes.length, membersOfDrawnRow }
      })()
      entry = { promise, result: null }
      simplifyCache.set(cacheKey, entry)
      void promise.then((result) => {
        const e = simplifyCache.get(cacheKey)
        if (e && e.promise === (promise as unknown)) e.result = result
      })
      // Bound the cache: drop oldest beyond 4 entries.
      while (simplifyCache.size > 4) {
        const oldest = simplifyCache.keys().next().value
        if (oldest === undefined) break
        simplifyCache.delete(oldest)
      }
    }
    entry.promise.then((result) => {
      if (!cancelled && seq === seqRef.current) setState(result)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [enabled, cacheKey, data])

  exposeSimplificationForDebug(state)
  return state
}

/** Debug/e2e access to the latest simplification result. */
declare global {
  interface Window { __simplification__?: SimplificationResult | null }
}
export function exposeSimplificationForDebug(state: SimplificationResult | null) {
  if (typeof window !== 'undefined') window.__simplification__ = state
}
