// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const baseUrl = 'https://offline.invalid/pyodide/'
const packageNames = ['numpy', 'scipy', 'scikit-learn', 'polars', 'pyarrow', 'pydantic', 'anyio', 'sqlite3', 'idna']
interface FixtureResponse { status?: number; data?: unknown; binary?: number[]; throwDispatch?: boolean; throwConversion?: boolean }
interface Scenario {
  populateError?: boolean
  mountError?: boolean
  missingIdbfs?: boolean
  throwFlush?: boolean
  flushErrors?: boolean[]
  responses?: FixtureResponse[]
}

/** Actual worker modules, with only runtime/network/Python modeled. Not a browser IDB test. */
async function startWorker(scenario: Scenario = {}) {
  const messages: any[] = []
  const transfers: Array<{ id: number; buffers: ArrayBuffer[] }> = []
  const syncCalls: boolean[] = []
  const dispatchCalls: Array<{ method: string; path: string }> = []
  let flushIndex = 0
  const lock = Object.fromEntries(packageNames.map(name => [name, { name, depends: [] }]))
  const loadedPackages: Record<string, string> = {}
  const runtime = {
    _api: { lockfile_packages: lock }, loadedPackages,
    FS: {
      mkdir: vi.fn(),
      mount: vi.fn(() => { if (scenario.mountError) throw new Error('modeled mount failure') }),
      filesystems: scenario.missingIdbfs ? {} : { IDBFS: {} },
      syncfs(populate: boolean, done: (error?: Error) => void) {
        syncCalls.push(populate)
        if (!populate && scenario.throwFlush) throw new Error('synchronous flush failure')
        const fails = populate ? scenario.populateError : scenario.flushErrors?.[flushIndex++]
        queueMicrotask(() => done(fails ? new Error(`modeled ${populate ? 'populate' : 'flush'} failure`) : undefined))
      },
    },
    loadPackage: async (names: string[]) => { names.forEach(name => { loadedPackages[name] = 'fixture' }) },
    unpackArchive: vi.fn(), runPython: vi.fn(),
    globals: { get: () => async (method: string, path: string) => {
      const fixture = scenario.responses?.[dispatchCalls.length] ?? {}
      dispatchCalls.push({ method, path })
      if (fixture.throwDispatch) throw new Error('modeled Python failure')
      const fields: Record<string, unknown> = {
        status_code: fixture.status ?? 200,
        headers: { toJs: () => ({ 'content-type': fixture.binary ? 'application/octet-stream' : 'application/json' }) },
        is_binary: Boolean(fixture.binary),
        content: { toJs: () => new Uint8Array(fixture.binary ?? []) },
        text: fixture.binary ? null : JSON.stringify(fixture.data ?? { ok: true }),
      }
      return { get: (key: string) => { if (fixture.throwConversion) throw new Error('conversion failure'); return fields[key] }, destroy: vi.fn() }
    } },
  }
  const self = {
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
    postMessage: (message: any, buffers: ArrayBuffer[] = []) => { messages.push(message); if (buffers.length) transfers.push({ id: message.id, buffers }) },
  }
  const context = createContext({
    self, URL, ArrayBuffer, Uint8Array, TextEncoder,
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => [], arrayBuffer: async () => new ArrayBuffer(0) }),
  })
  const modules = new Map<string, { exports: Record<string, unknown> }>()
  function loadModule(name: string): Record<string, unknown> {
    if (modules.has(name)) return modules.get(name)!.exports
    const module = { exports: {} }
    modules.set(name, module)
    const source = readFileSync(new URL(`../src/engine/${name}.ts`, import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      fileName: `${name}.ts`, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const execute = runInContext(`(function(require, module, exports) { ${compiled}\n})`, context)
    execute((specifier: string) => {
      if (specifier === `${baseUrl}pyodide.mjs`) return { loadPyodide: async () => runtime }
      if (specifier.startsWith('./')) return loadModule(specifier.slice(2))
      throw new Error(`Unexpected worker dependency: ${specifier}`)
    }, module, module.exports)
    return module.exports
  }
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(predicate(), 'worker response did not settle').toBe(true)
  }
  loadModule('pyodide.worker')
  self.onmessage!({ data: { type: 'INIT', pyodideBaseUrl: baseUrl } })
  await settle(() => messages.some(message => message.stage === 'ready' || message.stage === 'error'))
  expect(messages.some(message => message.stage === 'ready')).toBe(true)
  let nextId = 0
  async function send(message: Record<string, unknown>) {
    const id = ++nextId
    self.onmessage!({ data: { ...message, id } })
    await settle(() => messages.some(item => item.type === 'RESPONSE' && item.id === id))
    return messages.find(item => item.type === 'RESPONSE' && item.id === id)
  }
  const request = (method: string, path: string) => send({ type: 'REQUEST', method, path })
  const flush = () => send({ type: 'FLUSH' })
  return { messages, transfers, syncCalls, dispatchCalls, request, flush }
}

describe('worker persistence and computation isolation', () => {
  it('defers only the two exact query routes and retains possibly-dirty state', async () => {
    const worker = await startWorker()
    for (const path of ['/summaries', '/statistics/covariance']) {
      const response = await worker.request('POST', path)
      expect(response.status).toBe(200)
      expect(response.data).toEqual({ ok: true })
      expect(response.persistence.pending).toBe(true)
    }
    expect(worker.syncCalls).toEqual([true])
    for (const [method, path] of [['POST', '/summaries/unknown'], ['POST', '/statistics/covariance/unknown'], ['PUT', '/summaries'], ['POST', '/unknown'], ['POST', '/summaries/'], ['POST', '/summaries?extra=1']]) {
      await worker.request(method, path)
    }
    expect(worker.syncCalls).toEqual([true, false, false, false, false, false, false])
  })

  it('preserves deferred-query business errors without attempting a flush', async () => {
    const data = { error: { code: 'INVALID_COLUMNS', message: 'original validation error' } }
    const worker = await startWorker({ responses: [{ status: 422, data }] })
    const response = await worker.request('POST', '/statistics/covariance')
    expect(response.status).toBe(422)
    expect(response.data).toEqual(data)
    expect(response.persistence.pending).toBe(true)
    expect(worker.syncCalls).toEqual([true])
  })

  it('returns successful JSON mutation receipt despite flush failure, and does not replay it', async () => {
    const receipt = { sessionId: 'sess-fixture', revision: 2, versionToken: 'new-token', state: { datasetId: 'dataset-fixture' } }
    const worker = await startWorker({ flushErrors: [true, false], responses: [{ data: receipt }] })
    const response = await worker.request('PUT', '/sessions/sess-fixture')
    expect(response.status).toBe(200)
    expect(response.data).toEqual(receipt)
    expect(response.persistence).toMatchObject({ mode: 'persistent', pending: true })
    expect(response.persistence.error).toContain('flush')
    const retry = await worker.flush()
    expect(retry.status).toBe(200)
    expect(retry.data).toMatchObject({ mode: 'persistent', pending: false, error: null })
    expect(worker.dispatchCalls).toEqual([{ method: 'PUT', path: '/sessions/sess-fixture' }])
    expect(worker.syncCalls).toEqual([true, false, false])
    expect(worker.messages.some(message => message.type === 'STATUS' && message.stage === 'error')).toBe(false)
  })

  it('preserves original business error status/data despite a failed flush', async () => {
    const error = { code: 'SESSION_CONFLICT', message: 'fixture conflict', details: { serverVersionToken: 'current' } }
    const worker = await startWorker({ flushErrors: [true], responses: [{ status: 409, data: error }] })
    const response = await worker.request('PUT', '/sessions/sess-fixture')
    expect(response.status).toBe(409)
    expect(response.data).toEqual(error)
    expect(response.error?.code).not.toBe('WASM_DISPATCH_ERROR')
    expect(response.persistence.pending).toBe(true)
  })

  it('isolates synchronous syncfs throws and continues processing queued requests', async () => {
    const worker = await startWorker({ throwFlush: true })
    expect((await worker.request('POST', '/unknown')).status).toBe(200)
    const next = await worker.request('GET', '/health')
    expect(next.status).toBe(200)
    expect(next.persistence).toMatchObject({ pending: true, error: 'synchronous flush failure' })
  })

  it('keeps failed response conversion an API error, preserving pending changes and queue progress', async () => {
    const worker = await startWorker({ responses: [{ throwConversion: true }] })
    const failed = await worker.request('POST', '/unknown')
    expect(failed.status).toBe(500)
    expect(failed.error.code).toBe('WASM_DISPATCH_ERROR')
    const next = await worker.request('GET', '/health')
    expect(next.status).toBe(200)
    expect(next.persistence.pending).toBe(true)
    expect(worker.syncCalls).toEqual([true])
  })

  it('preserves original binary response after a failed flush', async () => {
    const worker = await startWorker({ flushErrors: [true], responses: [{ binary: [0, 128, 255, 13] }] })
    const response = await worker.request('POST', '/exports')
    expect(response.status).toBe(200)
    expect(Array.from(new Uint8Array(response.data))).toEqual([0, 128, 255, 13])
    expect(worker.transfers).toEqual([{ id: response.id, buffers: [response.data] }])
    expect(response.persistence.pending).toBe(true)
  })

  it('keeps failed-flush warning and pending state through GET and deferred queries', async () => {
    const worker = await startWorker({ flushErrors: [true, true, false] })
    const first = await worker.request('POST', '/mutation')
    for (const [method, path] of [['GET', '/datasets/example'], ['POST', '/summaries'], ['POST', '/statistics/covariance']]) {
      const response = await worker.request(method, path)
      expect(response.status).toBe(200)
      expect(response.persistence).toMatchObject({ pending: true, error: first.persistence.error })
    }
    expect(worker.syncCalls).toEqual([true, false])
    const failedRetry = await worker.flush()
    expect(failedRetry.data.pending).toBe(true)
    expect(failedRetry.data.error).toBeTruthy()
    const success = await worker.flush()
    expect(success.data).toMatchObject({ pending: false, error: null })
    expect(worker.dispatchCalls).toHaveLength(4)
  })

  it('does not turn a Python computation failure into successful data', async () => {
    const worker = await startWorker({ responses: [{ throwDispatch: true }] })
    const failed = await worker.request('POST', '/summaries')
    expect(failed.status).toBe(500)
    expect(failed.error.code).toBe('WASM_DISPATCH_ERROR')
    const next = await worker.request('GET', '/health')
    expect(next.status).toBe(200)
  })

  it.each([
    ['populate callback', { populateError: true }],
    ['mount', { mountError: true }],
    ['missing IDBFS', { missingIdbfs: true }],
  ] as const)('never flushes an unsafe startup workspace after %s failure', async (_name, scenario) => {
    const worker = await startWorker(scenario)
    const result = await worker.request('POST', '/models/pca')
    expect(result.status).toBe(200)
    expect(result.persistence.mode).toBe('temporary')
    expect(result.persistence.pending).toBe(true)
    const retried = await worker.flush()
    expect(retried.data.mode).toBe('temporary')
    expect(retried.data.pending).toBe(true)
    expect(worker.syncCalls.filter(populate => !populate)).toHaveLength(0)
    expect(worker.messages.some(message => message.type === 'STATUS' && message.stage === 'error')).toBe(false)
  })

  it('rejects explicit session writes before Python when storage is temporary', async () => {
    const worker = await startWorker({ populateError: true })
    for (const [method, path] of [['POST', '/sessions'], ['PUT', '/sessions/sess-fixture']]) {
      const response = await worker.request(method, path)
      expect(response.status).toBe(503)
      expect(response.error.code).toBe('PERSISTENCE_UNAVAILABLE')
    }
    expect(worker.dispatchCalls).toHaveLength(0)
    expect(worker.syncCalls).toEqual([true])
  })
})
