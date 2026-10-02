import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

it.each(['status', 'error'])('rejects pending and future requests after worker %s without restarting it', async kind => {
  let worker: FakeWorker
  class FakeWorker {
    onmessage: ((event: any) => void) | null = null
    onerror: ((event: any) => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { worker = this }
  }
  const constructor = vi.fn(function () { return new FakeWorker() })
  vi.stubGlobal('Worker', constructor)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { pyodideClient } = await import('../src/engine/pyodideClient')
  const ready = pyodideClient.init()
  worker!.onmessage!({ data: { type: 'STATUS', stage: 'ready', progress: 1, message: 'ready' } })
  await ready
  const requests = [pyodideClient.request('/one'), pyodideClient.request('/two')]
  const failures = requests.map(request => expect(request).rejects.toThrow('runtime failed'))
  await vi.waitFor(() => expect(worker!.postMessage).toHaveBeenCalledTimes(3))
  if (kind === 'status') worker!.onmessage!({ data: { type: 'STATUS', stage: 'error', message: 'runtime failed' } })
  else worker!.onerror!({ message: 'runtime failed' })
  await Promise.all(failures)
  await expect(pyodideClient.request('/later')).rejects.toThrow('runtime failed')
  expect(worker!.postMessage).toHaveBeenCalledTimes(3)
  expect(worker!.terminate).toHaveBeenCalledTimes(1)
  expect(constructor).toHaveBeenCalledTimes(1)
})

it.each(['request', 'upload'] as const)('removes all 1,000 %s callbacks when postMessage throws synchronously, without failing unrelated analyses', async kind => {
  let worker: FakeWorker
  class FakeWorker {
    onmessage: ((event: any) => void) | null = null
    onerror: ((event: any) => void) | null = null
    onmessageerror: ((event: any) => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { worker = this }
  }
  vi.stubGlobal('Worker', FakeWorker)
  const { pyodideClient } = await import('../src/engine/pyodideClient')
  const ready = pyodideClient.init()
  worker!.onmessage!({ data: { type: 'STATUS', stage: 'ready', progress: 1, message: 'ready' } })
  await ready
  const analysis = pyodideClient.request('/analysis')
  await vi.waitFor(() => expect(worker!.postMessage).toHaveBeenCalledTimes(2))
  const analysisId = worker!.postMessage.mock.calls.at(-1)![0].id
  worker!.postMessage.mockImplementation(() => { throw new DOMException('not cloneable', 'DataCloneError') })
  for (let i = 0; i < 1000; i++) {
    const request = kind === 'request'
      ? pyodideClient.request('/cannot-send')
      : pyodideClient.upload('/upload', { name: 'data.csv', arrayBuffer: async () => new ArrayBuffer(8) } as File)
    await expect(request).rejects.toThrow('not cloneable')
  }
  expect((pyodideClient as any).pending.size).toBe(1)
  worker!.onmessage!({ data: { type: 'RESPONSE', id: analysisId, status: 200, data: 'complete' } })
  expect(await analysis).toBe('complete')
  expect((pyodideClient as any).pending.size).toBe(0)
  expect(worker!.terminate).not.toHaveBeenCalled()
})

it('rejects initialization and terminates the worker if the initial message cannot be sent', async () => {
  const terminate = vi.fn()
  vi.stubGlobal('Worker', class {
    postMessage() { throw Error('init send failed') }
    terminate = terminate
  })
  const { pyodideClient } = await import('../src/engine/pyodideClient')
  await expect(pyodideClient.init()).rejects.toThrow('init send failed')
  await expect(pyodideClient.request('/later')).rejects.toThrow('init send failed')
  expect(terminate).toHaveBeenCalledTimes(1)
  expect((pyodideClient as any).pending.size).toBe(0)
})
