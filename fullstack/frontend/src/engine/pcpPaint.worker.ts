/// <reference lib="webworker" />
import { renderPcp, type PcpRenderSpec } from './pcpRenderer'

let canvas: OffscreenCanvas | null = null

self.onmessage = (event: MessageEvent<{ id: number; spec: PcpRenderSpec }>) => {
  const { id, spec } = event.data
  let frame: ImageBitmap | undefined
  try {
    const width = Math.round(spec.width * spec.dpr)
    const height = Math.round(spec.height * spec.dpr)
    if (!canvas) canvas = new OffscreenCanvas(width, height)
    else if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Offscreen 2D context unavailable')
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    renderPcp(ctx, spec)
    frame = canvas.transferToImageBitmap()
    self.postMessage({ id, ok: true, frame }, [frame])
    // The receiving thread owns the frame after a successful transfer.
    frame = undefined
  } catch (error) {
    frame?.close()
    self.postMessage({ id, ok: false, error: String(error) })
  }
}

export {}
