import { hitRows, type Rect, type HitMode } from '../features/pcp/brush'
import type { BrushResponse } from './brush.worker'

let worker: Worker | null = null
let requestCounter = 0
const pending = new Map<number, (hits: string[]) => void>()

function ensureWorker(): Worker | null {
  if (worker) return worker
  try {
    worker = new Worker(new URL('./brush.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<BrushResponse>) => {
      const resolver = pending.get(event.data.requestId)
      if (resolver) {
        pending.delete(event.data.requestId)
        resolver(event.data.hits)
      }
    }
    return worker
  } catch {
    return null
  }
}

export interface BrushPayload {
  activeIds: string[]
  points: Record<string, { x: number; y: number }[]>
}

/** Compute brush hits in a Web Worker; falls back to the main thread. */
export function computeHits(rect: Rect, mode: HitMode, payload: BrushPayload): Promise<string[]> {
  const w = ensureWorker()
  if (!w) {
    const pointsById = new Map(Object.entries(payload.points))
    return Promise.resolve(hitRows(pointsById, payload.activeIds, rect, mode))
  }
  const requestId = ++requestCounter
  return new Promise((resolve) => {
    pending.set(requestId, resolve)
    w.postMessage({ type: 'brush', requestId, rect, mode, ...payload })
  })
}

export function terminateWorker(): void {
  worker?.terminate()
  worker = null
  pending.clear()
}
