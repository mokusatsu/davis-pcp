import { afterEach, expect, it, vi } from 'vitest'
import { renderPcp } from '../src/engine/pcpRenderer'

vi.mock('../src/engine/pcpRenderer', () => ({ renderPcp: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

async function setup() {
  const frames: Array<{ close: ReturnType<typeof vi.fn> }> = []
  const canvases: any[] = []
  const ctx = { setTransform: vi.fn(), clearRect: vi.fn() }
  class Canvas {
    constructor(public width: number, public height: number) { canvases.push(this) }
    getContext() { return ctx }
    transferToImageBitmap() { const frame = { close: vi.fn() }; frames.push(frame); return frame }
  }
  const worker = { onmessage: null as ((event: any) => void) | null, postMessage: vi.fn() }
  vi.stubGlobal('OffscreenCanvas', Canvas)
  vi.stubGlobal('self', worker)
  await import('../src/engine/pcpPaint.worker')
  const paint = (id = 1, width = 100, height = 80) => worker.onmessage!({ data: { id, spec: { width, height, dpr: 2 } } })
  return { frames, canvases, ctx, worker, paint }
}

it('owns one reusable offscreen canvas and transfers only completed bitmap frames', async () => {
  const { paint, frames, canvases, ctx, worker } = await setup()
  paint()
  expect(canvases).toHaveLength(1)
  expect([canvases[0].width, canvases[0].height]).toEqual([200, 160])
  expect(renderPcp).toHaveBeenCalledWith(ctx, { width: 100, height: 80, dpr: 2 })
  expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, ok: true, frame: frames[0] }, [frames[0]])
  expect(frames[0].close).not.toHaveBeenCalled()
  paint(2, 150, 90)
  expect(canvases).toHaveLength(1)
  expect([canvases[0].width, canvases[0].height]).toEqual([300, 180])
  expect(frames).toHaveLength(2)
})
it('closes an untransferred bitmap when the response send throws', async () => {
  const { paint, frames, worker } = await setup()
  worker.postMessage.mockImplementationOnce(() => { throw Error('send failed') })
  paint()
  expect(frames[0].close).toHaveBeenCalledTimes(1)
  expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 1, ok: false, error: 'Error: send failed' })
})
it('reports a rendering failure without creating or retaining a bitmap', async () => {
  const { paint, frames, worker } = await setup()
  vi.mocked(renderPcp).mockImplementationOnce(() => { throw Error('render failed') })
  paint()
  expect(frames).toHaveLength(0)
  expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, ok: false, error: 'Error: render failed' })
})
