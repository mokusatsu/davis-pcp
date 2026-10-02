import { hitRows, type Rect, type HitMode } from '../features/pcp/brush'
import type { BrushResponse } from './brush.worker'

let worker: Worker | null = null
let requestCounter = 0
let workerBroken = false
const pending = new Map<number, { resolve: (hits: string[]) => void; reject: (error: Error) => void }>()

function ensureWorker(): Worker | null {
  if (worker) return worker
  if (workerBroken) return null
  try {
    worker = new Worker(new URL('./brush.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<BrushResponse>) => {
      const resolver = pending.get(event.data.requestId)
      if (resolver) {
        pending.delete(event.data.requestId)
        resolver.resolve(event.data.hits)
      }
    }
    worker.onerror = () => failWorker(new Error('brush worker failed'))
    worker.onmessageerror = () => failWorker(new Error('brush worker response could not be read'))
    return worker
  } catch {
    workerBroken = true
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
  return new Promise<string[]>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    try {
      w.postMessage({ type: 'brush', requestId, rect, mode, ...payload })
    } catch (error) {
      failWorker(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function failWorker(error: Error): void {
  workerBroken = true
  terminateWorker(error)
}

export function terminateWorker(error = new Error('brush worker terminated')): void {
  const stopped = worker
  worker = null
  stopped?.terminate()
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}
