import { renderPcp, type PcpRenderSpec } from './pcpRenderer'

type PendingFrame = { resolve: (frame: ImageBitmap) => void; reject: (error: Error) => void }

/** One painter per mounted PCP/dataset. Only the worker owns its OffscreenCanvas;
 * the visible canvas and render inputs always stay on the main thread. */
export class PcpPaintClient {
  private worker: Worker | null = null
  private unavailable = false
  private disposed = false
  private nextId = 0
  private pending = new Map<number, PendingFrame>()

  get pendingCount(): number { return this.pending.size }

  private stop(error: Error): void {
    this.unavailable = true
    const worker = this.worker
    this.worker = null
    // Keep the reply handler so a frame already queued before termination is
    // still closed if delivered. No pending promise may outlive this painter.
    worker?.terminate()
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  dispose(): void {
    this.disposed = true
    this.stop(new Error('PCP painter disposed'))
  }

  private ensureWorker(): Worker | null {
    if (this.disposed || this.unavailable) return null
    if (this.worker) return this.worker
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      this.unavailable = true
      return null
    }
    try {
      const worker = new Worker(new URL('./pcpPaint.worker.ts', import.meta.url), { type: 'module' })
      this.worker = worker
      worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; frame?: ImageBitmap; error?: string }>) => {
        const { id, ok, frame, error } = event.data
        const entry = this.pending.get(id)
        if (!entry) { frame?.close(); return }
        this.pending.delete(id)
        if (ok && frame) entry.resolve(frame)
        else {
          frame?.close()
          const failure = new Error(error ?? 'PCP worker returned no frame')
          entry.reject(failure)
          this.stop(failure)
        }
      }
      worker.onerror = () => this.stop(new Error('PCP paint worker failed'))
      worker.onmessageerror = () => this.stop(new Error('PCP paint response could not be read'))
      return worker
    } catch {
      this.stop(new Error('PCP paint worker unavailable'))
      return null
    }
  }

  private requestFrame(spec: PcpRenderSpec): Promise<ImageBitmap> {
    const worker = this.ensureWorker()
    if (!worker) return Promise.reject(new Error('PCP paint worker unavailable'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        // Deliberately clone inputs: geometry/selection are reused for hit
        // testing and export. Never transfer the visible canvas or its mirror.
        worker.postMessage({ id, spec })
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Return whether this spec reached the visible canvas. Stale/unmounted
   * frames are discarded, but released just like successfully drawn frames. */
  async paint(canvas: HTMLCanvasElement, spec: PcpRenderSpec, isCurrent: () => boolean): Promise<boolean> {
    if (this.disposed || !isCurrent()) return false
    let frame: ImageBitmap | undefined
    try {
      frame = await this.requestFrame(spec)
      if (this.disposed || !isCurrent()) return false
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(frame, 0, 0)
      return true
    } catch {
      // Capability/protocol errors latch the local path for this painter.
      if (this.disposed || !isCurrent()) return false
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      renderPcp(ctx, spec)
      return true
    } finally {
      frame?.close()
    }
  }
}
