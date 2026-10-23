import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

it('keeps successful receipts and binary data usable after persistence warnings without terminating the worker', async () => {
  let worker: FakeWorker
  class FakeWorker {
    onmessage: ((event: any) => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { worker = this }
  }
  vi.stubGlobal('Worker', FakeWorker)
  const { pyodideClient: client } = await import('../src/engine/pyodideClient')
  const ready = client.init()
  worker!.onmessage!({ data: { type: 'STATUS', stage: 'ready', progress: 1, message: 'ready' } })
  await ready
  const listener = vi.fn()
  const unsubscribe = client.onPersistence(listener)
  const failed = { mode: 'persistent', pending: true, error: 'closed connection' }
  const clean = { mode: 'persistent', pending: false, error: null }
  worker!.onmessage!({ data: { type: 'PERSISTENCE', persistence: failed } })
  expect(client.getStatus().stage).toBe('ready')
  expect(client.getPersistence()).toEqual(failed)
  const saving = client.requestWithPersistence('/sessions', { method: 'POST' })
  await vi.waitFor(() => expect(worker!.postMessage).toHaveBeenCalledTimes(2))
  const saved = { sessionId: 'created-once', revision: 2, versionToken: 'new-token' }
  worker!.onmessage!({ data: { type: 'RESPONSE', id: 1, status: 201, data: saved, persistence: failed } })
  expect(await saving).toEqual({ data: saved, persistence: failed })
  const binary = client.request<ArrayBuffer>('/binary')
  await vi.waitFor(() => expect(worker!.postMessage).toHaveBeenCalledTimes(3))
  const bytes = new Uint8Array([1, 2]).buffer
  worker!.onmessage!({ data: { type: 'RESPONSE', id: 2, status: 200, data: bytes, persistence: failed } })
  expect(await binary).toBe(bytes)
  const flushing = client.flushPersistence()
  await vi.waitFor(() => expect(worker!.postMessage).toHaveBeenCalledTimes(4))
  expect(worker!.postMessage.mock.calls.at(-1)![0]).toEqual({ type: 'FLUSH', id: 3 })
  worker!.onmessage!({ data: { type: 'RESPONSE', id: 3, status: 200, data: clean, persistence: clean } })
  expect(await flushing).toEqual(clean)
  expect(client.getPersistence()).toEqual(clean)
  expect(listener).toHaveBeenLastCalledWith(clean)
  expect(worker!.terminate).not.toHaveBeenCalled()
  unsubscribe()
})

it('retains original API errors alongside independent persistence warnings', async () => {
  let worker: any
  vi.stubGlobal('Worker', class {
    onmessage: any
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { worker = this }
  })
  const { pyodideClient: client } = await import('../src/engine/pyodideClient')
  const ready = client.init()
  worker.onmessage({ data: { type: 'STATUS', stage: 'ready' } })
  await ready
  const request = client.request('/sessions/x', { method: 'PUT' })
  const expected = expect(request).rejects.toMatchObject({ code: 'SESSION_CONFLICT' })
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2))
  const persistence = { mode: 'persistent', pending: true, error: 'disk failed' }
  worker.onmessage({ data: { type: 'RESPONSE', id: 1, status: 409, persistence,
    data: { error: { code: 'SESSION_CONFLICT', message: 'original conflict' } } } })
  await expected
  expect(client.getPersistence()).toEqual(persistence)
  expect(worker.terminate).not.toHaveBeenCalled()
})
