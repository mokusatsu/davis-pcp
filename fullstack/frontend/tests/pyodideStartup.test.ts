// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const baseUrl = 'https://offline.invalid/pyodide/'
const requested = ['numpy', 'scipy', 'scikit-learn', 'polars', 'pyarrow', 'pydantic', 'anyio', 'sqlite3', 'idna']
const lock = {
  ...Object.fromEntries(requested.map(name => [name, { name, depends: [] }])),
  pydantic: { name: 'pydantic', depends: ['typing-extensions', 'pydantic_core', 'annotated-types'] },
  'pydantic-core': { name: 'pydantic_core', depends: [] },
  'typing-extensions': { name: 'typing-extensions', depends: [] },
  'annotated-types': { name: 'annotated-types', depends: [] },
}

interface Scenario {
  missing?: 'once' | 'persistent' | 'fulfilled-without-marker'
  nativeReject?: boolean
  manifestStatus?: number
  wheelStatus?: number
  backendStatus?: number
  invalidLock?: boolean
}

// Run the actual worker, queue and package helper in an isolated JS context.
// Only runtime import and I/O are modeled; no network, Python or WASM is run.
async function startWorker(scenario: Scenario = {}) {
  const messages: any[] = []
  const fetched: string[] = []
  const loadCalls: string[][] = []
  let finish!: () => void
  const terminal = new Promise<void>(resolve => { finish = resolve })
  const loadedPackages: Record<string, string> = {}
  const runtime = {
    _api: { lockfile_packages: scenario.invalidLock ? undefined : lock },
    loadedPackages,
    FS: {
      mkdir: vi.fn(), mount: vi.fn(), filesystems: { IDBFS: {} },
      syncfs: vi.fn((_populate: boolean, done: () => void) => done()),
    },
    loadPackage: vi.fn(async (names: string[]) => {
      loadCalls.push([...names])
      if (scenario.nativeReject) throw new Error('modeled native rejection')
      if (loadCalls.length === 1) {
        // Model partial success with the parent installed despite a failed child.
        for (const entry of Object.values(lock)) loadedPackages[entry.name] = 'default channel'
        if (scenario.missing) delete loadedPackages['annotated-types']
      } else if (scenario.missing === 'once' && names.includes('annotated-types')) {
        loadedPackages['annotated-types'] = 'default channel'
      }
      return scenario.missing === 'fulfilled-without-marker' ? [{ name: 'annotated-types' }] : []
    }),
    unpackArchive: vi.fn(),
    runPython: vi.fn(),
    globals: { get: vi.fn(() => () => {}) },
  }
  const loadPyodide = vi.fn(async () => runtime)
  const self = {
    onmessage: undefined as undefined | ((event: { data: unknown }) => void),
    postMessage(message: any) {
      messages.push(message)
      if (message.stage === 'ready' || message.stage === 'error') finish()
    },
  }
  const context = createContext({
    self, URL, ArrayBuffer, Uint8Array, TextEncoder,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url: string) => {
      fetched.push(url)
      let status: number
      if (url === `${baseUrl}wheels/manifest.json`) status = scenario.manifestStatus ?? 200
      else if (url === `${baseUrl}wheels/fastapi-fixture.whl`) status = scenario.wheelStatus ?? 200
      else if (url === `${baseUrl}backend_app.zip`) status = scenario.backendStatus ?? 200
      else throw new Error(`Unexpected fixture request: ${url}`)
      return {
        ok: status >= 200 && status < 300, status,
        json: async () => ['fastapi-fixture.whl'],
        arrayBuffer: async () => new ArrayBuffer(8),
      }
    },
  })
  const modules = new Map<string, { exports: Record<string, unknown> }>()
  function loadModule(name: string): Record<string, unknown> {
    if (modules.has(name)) return modules.get(name)!.exports
    const module = { exports: {} }
    modules.set(name, module)
    const source = readFileSync(new URL(`../src/engine/${name}.ts`, import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      fileName: `${name}.ts`,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const execute = runInContext(`(function(require, module, exports) { ${compiled}\n})`, context)
    execute((specifier: string) => {
      if (specifier === `${baseUrl}pyodide.mjs`) return { loadPyodide }
      if (['./serialQueue', './pythonResponse', './pyodidePackages'].includes(specifier)) return loadModule(specifier.slice(2))
      throw new Error(`Unexpected worker import: ${specifier}`)
    }, module, module.exports)
    return module.exports
  }
  loadModule('pyodide.worker')
  self.onmessage!({ data: { type: 'INIT', pyodideBaseUrl: baseUrl } })
  await terminal
  return { messages, stages: messages.map(message => message.stage), fetched, loadCalls, runtime, loadPyodide }
}

describe('standalone worker startup', () => {
  it('reaches ready after one targeted dependency retry through the actual INIT control flow', async () => {
    const result = await startWorker({ missing: 'once' })
    expect(result.loadCalls).toEqual([requested, ['annotated-types']])
    expect(result.stages.at(-1)).toBe('ready')
    expect(result.runtime.runPython).toHaveBeenCalledTimes(1)
    expect(result.runtime.runPython.mock.calls[0][0]).toContain('from app.main import app')
  })

  it.each(['persistent', 'fulfilled-without-marker'] as const)('stops before wheel fetches or app import when the dependency is %s', async missing => {
    const result = await startWorker({ missing })
    expect(result.loadCalls).toEqual([requested, ['annotated-types']])
    expect(result.stages).toEqual(['loading_runtime', 'mounting_fs', 'loading_packages', 'error'])
    expect(result.messages.at(-1).message).toContain('Failed to load required Pyodide packages: annotated-types')
    expect(result.fetched).toEqual([])
    expect(result.runtime.runPython).not.toHaveBeenCalled()
  })

  it('stops immediately if the required pure-wheel manifest returns a non-OK response', async () => {
    const result = await startWorker({ manifestStatus: 404 })
    expect(result.stages.at(-1)).toBe('error')
    expect(result.messages.at(-1).message).toContain('Failed to fetch required wheels/manifest.json: 404')
    expect(result.fetched).toEqual([`${baseUrl}wheels/manifest.json`])
    expect(result.runtime.unpackArchive).not.toHaveBeenCalled()
    expect(result.runtime.runPython).not.toHaveBeenCalled()
    expect(result.stages).not.toContain('starting_app')
  })

  it('stops before backend fetch or app import if a required pure wheel returns a non-OK response', async () => {
    const result = await startWorker({ wheelStatus: 503 })
    expect(result.stages.at(-1)).toBe('error')
    expect(result.messages.at(-1).message).toContain('Failed to fetch required wheel fastapi-fixture.whl: 503')
    expect(result.fetched).toEqual([`${baseUrl}wheels/manifest.json`, `${baseUrl}wheels/fastapi-fixture.whl`])
    expect(result.runtime.unpackArchive).not.toHaveBeenCalled()
    expect(result.runtime.runPython).not.toHaveBeenCalled()
    expect(result.stages).not.toContain('starting_app')
  })

  it('keeps a rejected native load fatal', async () => {
    const result = await startWorker({ nativeReject: true })
    expect(result.messages.at(-1).message).toContain('modeled native rejection')
    expect(result.loadCalls).toEqual([requested])
    expect(result.fetched).toEqual([])
    expect(result.runtime.runPython).not.toHaveBeenCalled()
  })

  it('keeps the existing backend HTTP failure fatal', async () => {
    const result = await startWorker({ backendStatus: 404 })
    expect(result.messages.at(-1).message).toContain('Failed to fetch backend_app.zip: 404')
    expect(result.runtime.runPython).not.toHaveBeenCalled()
    expect(result.stages).not.toContain('starting_app')
  })

  it('fails closed if the pinned runtime does not expose a usable package lock', async () => {
    const result = await startWorker({ invalidLock: true })
    expect(result.messages.at(-1).message).toContain('Missing or invalid Pyodide package lock')
    expect(result.loadCalls).toEqual([])
    expect(result.fetched).toEqual([])
    expect(result.runtime.runPython).not.toHaveBeenCalled()
  })

  it('preserves successful startup, local assets and workspace hydration', async () => {
    const result = await startWorker()
    expect(result.stages).toEqual([
      'loading_runtime', 'mounting_fs', 'loading_packages', 'loading_pure_wheels', 'loading_backend', 'starting_app', 'ready',
    ])
    expect(result.loadPyodide).toHaveBeenCalledWith({ indexURL: baseUrl })
    expect(result.loadCalls).toEqual([requested])
    expect(result.runtime.FS.mkdir).toHaveBeenCalledWith('/workspace')
    expect(result.runtime.FS.mount).toHaveBeenCalledWith(result.runtime.FS.filesystems.IDBFS, {}, '/workspace')
    expect(result.runtime.FS.syncfs).toHaveBeenCalledTimes(1)
    expect(result.runtime.FS.syncfs).toHaveBeenCalledWith(true, expect.any(Function))
    expect(result.fetched).toEqual([
      `${baseUrl}wheels/manifest.json`, `${baseUrl}wheels/fastapi-fixture.whl`, `${baseUrl}backend_app.zip`,
    ])
    expect(result.runtime.unpackArchive.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ['zip', { extractDir: '/lib/python3.12/site-packages' }], ['zip', { extractDir: '/app' }],
    ])
    expect(result.runtime.runPython).toHaveBeenCalledTimes(1)
    expect(result.runtime.globals.get).toHaveBeenCalledWith('_dispatch_asgi')
  })
})
