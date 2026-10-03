import { afterEach, expect, it, vi } from 'vitest'
import { apiErrorFromResponse } from '../src/api/apiError'

const invalid = { detail: [{ loc: ['body', 'seed'], type: 'int_from_float', input: 'SECRET_INPUT',
  msg: 'Do not display SECRET_MESSAGE', ctx: { secret: 'SECRET_CONTEXT' } }] }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

it('translates validation fields and does not copy sensitive input, context or free-form messages', () => {
  const error = apiErrorFromResponse(invalid, 422)
  expect(error).toMatchObject({ code: 'VALIDATION_ERROR', details: { fieldErrors: { seed: '整数で入力してください。' } } })
  expect(error.message).toContain('seed')
  expect(JSON.stringify(error)).not.toContain('SECRET')
})

it('preserves structured BizError fields exactly and falls back for malformed responses', () => {
  const error = { code: 'ANALYSIS_INPUT_STALE', message: '版を確認してください', details: { expected: 1 },
    recoverable: false, suggestedActions: ['再読込'], traceId: 'trace' }
  expect(apiErrorFromResponse({ error }, 409)).toBe(error)
  for (const body of [null, '', { detail: 'unexpected' }, { detail: [null, 'bad', {}] }]) {
    expect(apiErrorFromResponse(body, 422)).toMatchObject({ code: 'HTTP_ERROR', message: 'HTTP 422' })
  }
})

it('keeps useful validation details through the HTTP client', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => invalid }))
  const { api } = await import('../src/api/client')
  await expect(api.post('/datasets/d/observations/sample', { seed: 1.5 })).rejects.toMatchObject({
    code: 'VALIDATION_ERROR', details: { fieldErrors: { seed: '整数で入力してください。' } },
  })
})

it('keeps the same safe field detail through the static Pyodide client', async () => {
  let worker: FakeWorker
  class FakeWorker {
    onmessage: ((event: any) => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { worker = this }
  }
  vi.stubGlobal('Worker', FakeWorker)
  const { pyodideClient } = await import('../src/engine/pyodideClient')
  const ready = pyodideClient.init()
  worker!.onmessage!({ data: { type: 'STATUS', stage: 'ready', progress: 1, message: 'ready' } })
  await ready
  const request = pyodideClient.request('/datasets/d/observations/sample')
  const rejected = expect(request).rejects.toEqual(apiErrorFromResponse(invalid, 422))
  await vi.waitFor(() => expect(worker!.postMessage).toHaveBeenCalledTimes(2))
  const id = worker!.postMessage.mock.calls.at(-1)![0].id
  worker!.onmessage!({ data: { type: 'RESPONSE', id, status: 422, data: invalid } })
  await rejected
})
