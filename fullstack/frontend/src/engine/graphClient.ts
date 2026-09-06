/**
 * Main-thread client for the shared graph compute worker.
 * Implements GraphEngine by proxying every call over postMessage RPC with
 * transferable typed arrays (zero copy). Falls back to an in-thread
 * LocalEngine when Worker construction is unavailable (jsdom tests).
 */
import { LocalEngine } from './local'
import type {
  GeometryResult, GraphEngine, PcpGeometryRequest, Rect,
} from './types'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let workerBroken = false
let requestCounter = 0
const pending = new Map<number, Pending>()
const local = new LocalEngine()

export let activeEngineKind: 'wasm' | 'local' = 'local'

function ensureWorker(): Worker | null {
  if (worker) return worker
  if (workerBroken) return null
  try {
    worker = new Worker(new URL('./graph.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { id: number; ok: boolean; result?: unknown; error?: string; engineKind?: 'wasm' | 'local' }
      const entry = pending.get(data.id)
      if (!entry) return
      pending.delete(data.id)
      if (data.engineKind) activeEngineKind = data.engineKind
      if (data.ok) entry.resolve(data.result)
      else entry.reject(new Error(data.error ?? 'worker error'))
    }
    worker.onerror = () => {
      // Network/module failure: degrade permanently to local engine.
      workerBroken = true
      worker = null
      for (const [, entry] of pending) entry.reject(new Error('graph worker failed'))
      pending.clear()
    }
    return worker
  } catch {
    workerBroken = true
    return null
  }
}

function call(op: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
  const w = ensureWorker()
  if (!w) return runLocal(op, payload)
  const id = ++requestCounter
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, op, ...payload }, transfer)
  })
}

async function runLocal(op: string, payload: Record<string, unknown>): Promise<unknown> {
  activeEngineKind = 'local'
  switch (op) {
    case 'ping': return 'pong'
    case 'pcpGeometry': return local.pcpGeometry(payload.req as PcpGeometryRequest)
    case 'polylineHit': return local.polylineHit(
      payload.points as Float64Array, payload.nRows as number, payload.nAxes as number,
      payload.rect as Rect, payload.mode as 'legacyVertex' | 'segment', payload.active as Uint8Array)
    case 'scatterHit': return local.scatterHit(payload.values as Float64Array, payload.nRows as number, payload.rect as Rect, payload.active as Uint8Array)
    case 'bandHit': return local.bandHit(payload.values as Float64Array, payload.nRows as number, payload.lo as number, payload.hi as number, payload.active as Uint8Array)
    case 'nearest': return local.nearest(
      payload.points as Float64Array, payload.nRows as number, payload.nAxes as number,
      payload.px as number, payload.py as number, payload.threshold as number, payload.active as Uint8Array)
    case 'histogram': return local.histogram(payload.values as Float64Array, payload.n as number, payload.min as number, payload.max as number, payload.bins as number)
    case 'histogramGrouped': return local.histogramGrouped(
      payload.values as Float64Array, payload.groupOf as ArrayLike<number>, payload.n as number,
      payload.min as number, payload.max as number, payload.bins as number, payload.nGroups as number)
    case 'boxStats': return local.boxStats(payload.values as Float64Array)
    case 'silhouetteOrder': return local.silhouetteOrder(payload.labels as Int32Array, payload.sil as Float64Array)
    case 'finiteMinMax': return local.finiteMinMax(payload.values as Float64Array)
    case 'describeNumeric': return local.describeNumeric(payload.values as Float64Array)
    case 'correlationMatrix': return local.correlationMatrix(payload.values as Float64Array, payload.n as number, payload.k as number)
    case 'kMedoids': return local.kMedoids(
      payload.values as Float64Array, payload.n as number, payload.d as number,
      payload.targetK as number, payload.sampleSize as number, payload.swapRounds as number,
      payload.seed as number, payload.specs as Float64Array)
    default: throw new Error(`unknown op ${op}`)
  }
}

/** Client-side GraphEngine. All typed arrays are copied into the message
 *  (structured clone), keeping the main thread free of compute loops. */
export const graphEngine: GraphEngine = {
  get kind() {
    return activeEngineKind
  },

  pcpGeometry(req: PcpGeometryRequest): Promise<GeometryResult> {
    // Transfer req.values (Float64Array) zero-copy — buildValues() creates a
    // fresh array per call, so the main thread never reuses it afterward.
    const transfer: Transferable[] = req.values instanceof Float64Array ? [req.values.buffer] : []
    return call('pcpGeometry', { req }, transfer) as Promise<GeometryResult>
  },

  polylineHit(points, nRows, nAxes, rect, mode, active) {
    // No transfer list: `points` (geometry.points) is reused by later calls
    // (hover/brush), and structured clone copies it into the message anyway.
    return call('polylineHit', { points, nRows, nAxes, rect, mode, active }) as Promise<number[]>
  },
  scatterHit(values, nRows, rect, active) {
    return call('scatterHit', { values, nRows, rect, active }) as Promise<number[]>
  },
  bandHit(values, nRows, lo, hi, active) {
    return call('bandHit', { values, nRows, lo, hi, active }) as Promise<number[]>
  },
  nearest(points, nRows, nAxes, px, py, threshold, active) {
    return call('nearest', { points, nRows, nAxes, px, py, threshold, active }) as Promise<number>
  },
  histogram(values, n, min, max, bins) {
    return call('histogram', { values, n, min, max, bins }) as Promise<number[]>
  },
  histogramGrouped(values, groupOf, n, min, max, bins, nGroups) {
    return call('histogramGrouped', { values, groupOf, n, min, max, bins, nGroups }) as Promise<number[]>
  },
  boxStats(values) {
    return call('boxStats', { values }) as Promise<[number, number, number, number, number] | null>
  },
  silhouetteOrder(labels, sil) {
    return call('silhouetteOrder', { labels, sil }) as Promise<number[]>
  },
  finiteMinMax(values) {
    return call('finiteMinMax', { values }) as Promise<{ min: number; max: number } | null>
  },
  describeNumeric(values) {
    return call('describeNumeric', { values }) as Promise<number[] | null>
  },
  correlationMatrix(values, n, k) {
    return call('correlationMatrix', { values, n, k }) as Promise<Float64Array>
  },
  kMedoids(values, n, d, targetK, sampleSize, swapRounds, seed, specs) {
    return call('kMedoids', { values, n, d, targetK, sampleSize, swapRounds, seed, specs }) as Promise<{ medoidIndexes: number[]; sizes: number[]; assignment: number[] }>
  },
}
