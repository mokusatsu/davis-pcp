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
  expect(worker!.terminate).not.toHaveBeenCalled()
  expect(constructor).toHaveBeenCalledTimes(1)
})
