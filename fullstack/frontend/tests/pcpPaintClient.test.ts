import { afterEach, describe, expect, it, vi } from 'vitest'
import { PcpPaintClient } from '../src/engine/pcpPaintClient'
import { renderPcp, type PcpRenderSpec } from '../src/engine/pcpRenderer'

vi.mock('../src/engine/pcpRenderer', () => ({ renderPcp: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

function setup() {
  const workers: FakeWorker[] = []
  class FakeWorker {
    onmessage: ((event: any) => void) | null = null
    onerror: (() => void) | null = null
    onmessageerror: (() => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { workers.push(this) }
    frame(id = 1) {
      const frame = { close: vi.fn() }
      this.onmessage?.({ data: { id, ok: true, frame } })
      return frame
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('OffscreenCanvas', class {})
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn() }
  const canvas = { width: 100, height: 80, getContext: () => ctx } as unknown as HTMLCanvasElement
  const spec = { width: 100, height: 80, dpr: 1, points: new Float64Array([1, 2]) } as PcpRenderSpec
  return { workers, canvas, ctx, spec, painter: new PcpPaintClient() }
}

describe('PCP paint ownership and failure lifecycle', () => {
  it('clones reusable inputs without sending any main-thread canvas and closes the returned bitmap after blitting', async () => {
    const { painter, workers, canvas, ctx, spec } = setup()
    const painted = painter.paint(canvas, spec, () => true)
    expect(workers[0].postMessage).toHaveBeenCalledWith({ id: 1, spec })
    expect(painter.pendingCount).toBe(1)
    const frame = workers[0].frame()
    expect(await painted).toBe(true)
    expect(ctx.drawImage).toHaveBeenCalledWith(frame, 0, 0)
    expect(frame.close).toHaveBeenCalledTimes(1)
    expect(spec.points.byteLength).toBe(16)
    expect(painter.pendingCount).toBe(0)
    expect(renderPcp).not.toHaveBeenCalled()
    painter.dispose()
  })

  it('rejects and releases a synchronous send failure, then paints 1,000 times locally without retrying the broken worker', async () => {
    const { painter, workers, canvas, spec } = setup()
    const first = painter.paint(canvas, spec, () => true)
    workers[0].frame()
    await first
    workers[0].postMessage.mockImplementation(() => { throw new DOMException('not cloneable', 'DataCloneError') })
    for (let i = 0; i < 1000; i++) {
      expect(await painter.paint(canvas, spec, () => true)).toBe(true)
      expect(painter.pendingCount).toBe(0)
    }
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
    expect(renderPcp).toHaveBeenCalledTimes(1000)
    expect(workers).toHaveLength(1)
  })

  it.each(['error', 'messageerror', 'reply'] as const)('clears all in-flight requests on %s and switches to local painting', async failure => {
    const { painter, workers, canvas, spec } = setup()
    const requests = [painter.paint(canvas, spec, () => true), painter.paint(canvas, spec, () => true)]
    if (failure === 'error') workers[0].onerror?.()
    else if (failure === 'messageerror') workers[0].onmessageerror?.()
    else workers[0].onmessage?.({ data: { id: 1, ok: false, error: 'no offscreen support' } })
    expect(await Promise.all(requests)).toEqual([true, true])
    expect(painter.pendingCount).toBe(0)
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
    expect(await painter.paint(canvas, spec, () => true)).toBe(true)
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
  })

  it.each(['stale', 'dispose'] as const)('closes a late frame after %s without painting or leaving callbacks', async state => {
    const { painter, workers, canvas, ctx, spec } = setup()
    let current = true
    const painted = painter.paint(canvas, spec, () => current)
    if (state === 'stale') current = false
    else painter.dispose()
    const frame = workers[0].frame()
    expect(await painted).toBe(false)
    expect(frame.close).toHaveBeenCalledTimes(1)
    expect(ctx.drawImage).not.toHaveBeenCalled()
    expect(renderPcp).not.toHaveBeenCalled()
    expect(painter.pendingCount).toBe(0)
  })

  it('closes the frame and preserves the supported local fallback if blitting throws', async () => {
    const { painter, workers, canvas, ctx, spec } = setup()
    ctx.drawImage.mockImplementation(() => { throw new Error('draw failed') })
    const painted = painter.paint(canvas, spec, () => true)
    const frame = workers[0].frame()
    expect(await painted).toBe(true)
    expect(frame.close).toHaveBeenCalledTimes(1)
    expect(renderPcp).toHaveBeenCalledWith(ctx, spec)
  })

  it('uses local painting without constructing a worker when OffscreenCanvas is unavailable', async () => {
    const { painter, workers, canvas, spec } = setup()
    vi.stubGlobal('OffscreenCanvas', undefined)
    expect(await painter.paint(canvas, spec, () => true)).toBe(true)
    expect(workers).toHaveLength(0)
    expect(renderPcp).toHaveBeenCalledTimes(1)
    painter.dispose()
    expect(await painter.paint(canvas, spec, () => true)).toBe(false)
  })
})
