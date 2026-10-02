import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
function setup() {
  const workers: any[] = []
  class FakeWorker {
    onmessage: ((event: any) => void) | null = null
    onerror: (() => void) | null = null
    onmessageerror: (() => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { workers.push(this) }
  }
  vi.stubGlobal('Worker', FakeWorker)
  return workers
}
it.each(['send', 'error', 'messageerror'])('settles graph requests after %s failure and latches local fallback', async kind => {
  const workers = setup()
  const { graphEngine } = await import('../src/engine/graphClient')
  const first = graphEngine.finiteMinMax(new Float64Array([1, 3]))
  const checkFirst = expect(first).rejects.toThrow()
  let second: Promise<unknown> | undefined
  if (kind === 'send') {
    workers[0].postMessage.mockImplementation(() => { throw Error('send failed') })
    second = expect(graphEngine.finiteMinMax(new Float64Array([2, 4]))).rejects.toThrow('send failed')
  } else workers[0][kind === 'error' ? 'onerror' : 'onmessageerror']()
  await checkFirst
  await second
  expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  expect(await graphEngine.finiteMinMax(new Float64Array([1, 3]))).toEqual({ min: 1, max: 3 })
  expect(workers).toHaveLength(1)
})
it.each(['send', 'error', 'terminate'])('settles legacy brush requests on %s instead of abandoning callbacks', async kind => {
  const workers = setup()
  const { computeHits, terminateWorker } = await import('../src/workers/brushClient')
  const rect = { x1: 0, y1: 0, x2: 5, y2: 5 }
  const payload = { activeIds: ['r'], points: { r: [{ x: 1, y: 1 }] } }
  const first = computeHits(rect, 'legacyVertex', payload)
  const checkFirst = expect(first).rejects.toThrow()
  let second: Promise<unknown> | undefined
  if (kind === 'send') {
    workers[0].postMessage.mockImplementation(() => { throw Error('send failed') })
    second = expect(computeHits(rect, 'legacyVertex', payload)).rejects.toThrow('send failed')
  } else if (kind === 'error') workers[0].onerror()
  else terminateWorker()
  await checkFirst
  await second
  expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  if (kind !== 'terminate') expect(await computeHits(rect, 'legacyVertex', payload)).toEqual(['r'])
})
