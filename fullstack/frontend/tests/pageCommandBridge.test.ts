// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://davis.example.test/"}
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNEL, createPageAdapter, registerPageBridge } from '../src/integrations/siwc/sdk/page-bridge.js'
import type { CommandDefinition, JSONSchema, OperationContext, PageBridgeOptions } from '../src/integrations/siwc/sdk/page-bridge.js'

type Snapshot = { protocol: number; contractRevision: number; workflow: unknown; snapshotId: string; schemaHash: string; revision: string; expiresAt: number; commands: CommandDefinition[]; context: unknown }
type Command = { op: string; args: Record<string, unknown> }
type Receipt = { index: number; op: string; status: string; result?: unknown; error?: { code: string } }
type Result = { status: string; results: Receipt[]; revision?: string; error?: { code: string } }
const object = (properties: Record<string, JSONSchema>): JSONSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const cleanups: Array<() => void> = []
let sequence = 0
const identifier = () => `test_identifier_${String(++sequence).padStart(8, '0')}`

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(overrides: Partial<PageBridgeOptions> = {}) {
  let value = 0, generation = 0, now = Date.now()
  const contexts: OperationContext[] = []
  const commands: CommandDefinition[] = [
    { name: 'add', description: 'Add a bounded value', effect: 'write', inputSchema: object({ n: { type: 'integer', minimum: 1, maximum: 10 } }) },
    { name: 'wait', description: 'Wait without mutation', effect: 'read', inputSchema: object({}) },
  ]
  const add = vi.fn((args: Record<string, unknown>, context: OperationContext) => {
    // The application, rather than the asynchronous SDK, owns the atomic commit guard.
    if (context.signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    if (context.expectedRevision !== String(generation)) throw new Error('stale generation')
    contexts.push(context)
    value += args.n as number
    generation++
    return { value }
  })
  const options: PageBridgeOptions = {
    appId: 'davis-test', appName: 'DAVIS test', commands,
    getContext: () => ({ value }), getRevision: () => String(generation), clock: () => now,
    ...overrides,
    handlers: { add, wait: () => null, ...overrides.handlers },
  }
  const adapter = createPageAdapter(options)
  cleanups.push(adapter.dispose)
  return {
    adapter, options, commands, add, contexts,
    get value() { return value }, get now() { return now },
    setTime(next: number) { now = next },
    changeState() { generation++ },
  }
}

async function envelope(f: ReturnType<typeof fixture>, commands: Command[] = [{ op: 'add', args: { n: 1 } }]) {
  const snapshot = await f.adapter.snapshot() as Snapshot
  return {
    snapshotId: snapshot.snapshotId, schemaHash: snapshot.schemaHash, revision: snapshot.revision,
    runId: identifier(), planId: identifier(), expiresAt: f.now + 10000,
    plan: { kind: 'commands', message: 'Test the ordinary application command', commands },
  }
}

beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup())
  document.querySelectorAll('meta[name="siwc-bridge"],meta[name="siwc-bridge-app"]').forEach(node => node.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('vendored page-command schema and envelope boundaries', () => {
  it('binds each command to its closed schema and passes the current expected revision', async () => {
    const f = fixture()
    expect(await f.adapter.snapshot()).toMatchObject({ protocol: 1, contractRevision: 2, workflow: null })
    const e = await envelope(f, [{ op: 'add', args: { n: 2 } }, { op: 'add', args: { n: 3 } }])
    const result = await f.adapter.execute(e) as Result
    expect(result).toMatchObject({ status: 'completed', revision: '2', results: [{ result: { value: 2 } }, { result: { value: 5 } }] })
    expect(f.contexts.map(context => context.expectedRevision)).toEqual(['0', '1'])
    expect(f.contexts.map(context => context.operationId)).toEqual([`${e.planId}:0`, `${e.planId}:1`])
  })

  it.each([
    { op: 'add', args: { n: 0 } },
    { op: 'add', args: { n: 11 } },
    { op: 'add', args: { n: 1.5 } },
    { op: 'add', args: {} },
    { op: 'add', args: { n: 1, extra: true } },
    { op: 'wait', args: { n: 1 } },
    { op: 'eval', args: {} },
  ])('rejects unknown or invalid operation $op $args', async command => {
    const f = fixture()
    expect(await f.adapter.execute(await envelope(f, [command]))).toMatchObject({ status: 'failed', error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(f.add).not.toHaveBeenCalled()
  })

  it.each(['__proto__', 'constructor', 'prototype'])('rejects dangerous key %s before executing', async key => {
    const f = fixture(), e = await envelope(f)
    e.plan.commands[0].args = JSON.parse(`{"n":1,"${key}":{"polluted":true}}`)
    await expect(f.adapter.execute(e)).rejects.toMatchObject({ code: 'UNSAFE_KEY' })
    expect(f.add).not.toHaveBeenCalled()
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('keeps payload, nesting and plan-length budgets', async () => {
    const f = fixture(), e = await envelope(f)
    await expect(f.adapter.execute({ ...e, padding: 'x'.repeat(1024 * 1024) })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    let nested: unknown = null
    for (let index = 0; index < 33; index++) nested = [nested]
    await expect(f.adapter.execute({ ...e, nested })).rejects.toMatchObject({ code: 'JSON_TOO_COMPLEX' })
    expect(await f.adapter.execute({ ...e, plan: { ...e.plan, commands: Array.from({ length: 13 }, () => ({ op: 'wait', args: {} })) } })).toMatchObject({ error: { code: 'SCHEMA_VALIDATION_FAILED' } })
    expect(f.add).not.toHaveBeenCalled()
  })

  it.each(['pattern', '$ref', 'default'])('rejects unsupported schema keyword %s', async keyword => {
    const f = fixture()
    f.commands[0].inputSchema = object({ n: { type: 'string', [keyword]: 'unsupported' } })
    await expect(f.adapter.snapshot()).rejects.toMatchObject({ code: 'UNSUPPORTED_SCHEMA_KEYWORD' })
  })

  it('rejects open argument schemas and invalid envelope identity/revision', async () => {
    const open = fixture()
    open.commands[0].inputSchema.additionalProperties = true
    await expect(open.adapter.snapshot()).rejects.toMatchObject({ code: 'CLOSED_OBJECT_REQUIRED' })
    const f = fixture(), e = await envelope(f)
    for (const raw of [null, [], { ...e, revision: 1 }, { ...e, revision: 'x'.repeat(2049) }]) {
      await expect(f.adapter.execute(raw)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' })
    }
    await expect(f.adapter.execute({ ...e, planId: 'short' })).rejects.toMatchObject({ code: 'INVALID_PLAN_ID' })
    await expect(f.adapter.execute({ ...e, runId: 'with spaces is invalid' })).rejects.toMatchObject({ code: 'INVALID_RUN_ID' })
    expect(f.add).not.toHaveBeenCalled()
  })
})

describe('single-use snapshots, replay and stale state', () => {
  it('executes simultaneous identical plans once and rejects a changed concurrent replay', async () => {
    const started = deferred(), release = deferred()
    const f = fixture({ authorize: async () => { started.resolve(); await release.promise; return true } })
    const e = await envelope(f)
    const first = f.adapter.execute(e), second = f.adapter.execute(e)
    await started.promise
    await expect(f.adapter.execute({ ...e, plan: { ...e.plan, commands: [{ op: 'add', args: { n: 2 } }] } })).rejects.toMatchObject({ code: 'PLAN_ID_REUSE' })
    release.resolve()
    expect(await first).toEqual(await second)
    expect(f.add).toHaveBeenCalledTimes(1)
    expect(await f.adapter.execute(e)).toEqual(await first)
    expect(f.value).toBe(1)
  })

  it('consumes a snapshot before authorization and cannot reuse it in another plan', async () => {
    const f = fixture({ authorize: () => false }), e = await envelope(f)
    expect(await f.adapter.execute(e)).toMatchObject({ error: { code: 'APP_PERMISSION_DENIED' } })
    expect(await f.adapter.execute({ ...e, planId: identifier() })).toMatchObject({ error: { code: 'UNKNOWN_OR_USED_SNAPSHOT' } })
    expect(f.add).not.toHaveBeenCalled()
  })

  it('rejects a changed state, snapshot binding and changed command schema', async () => {
    const stale = fixture(), staleEnvelope = await envelope(stale)
    stale.changeState()
    expect(await stale.adapter.execute(staleEnvelope)).toMatchObject({ error: { code: 'STALE_STATE' } })
    const mismatched = fixture(), mismatchEnvelope = await envelope(mismatched)
    expect(await mismatched.adapter.execute({ ...mismatchEnvelope, schemaHash: 'incorrect' })).toMatchObject({ error: { code: 'SNAPSHOT_MISMATCH' } })
    const changed = fixture(), changedEnvelope = await envelope(changed)
    changed.commands[0].description = 'Changed definition'
    expect(await changed.adapter.execute(changedEnvelope)).toMatchObject({ error: { code: 'SCHEMA_CHANGED' } })
    expect(stale.add).not.toHaveBeenCalled()
    expect(mismatched.add).not.toHaveBeenCalled()
    expect(changed.add).not.toHaveBeenCalled()
  })

  it('rejects state changes during snapshot capture and while authorization is pending', async () => {
    const entered = deferred(), release = deferred<Record<string, number>>()
    const f = fixture({ getContext: async () => { entered.resolve(); return release.promise } })
    const pending = f.adapter.snapshot()
    await entered.promise
    f.changeState()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'STATE_CHANGED_DURING_SNAPSHOT' })
    release.resolve({ value: 0 })
    await rejected

    const authorizing = deferred(), authorized = deferred<boolean>()
    const g = fixture({ authorize: async () => { authorizing.resolve(); return authorized.promise } })
    const executing = g.adapter.execute(await envelope(g))
    await authorizing.promise
    g.changeState()
    authorized.resolve(true)
    expect(await executing).toMatchObject({ error: { code: 'STALE_STATE' } })
    expect(g.add).not.toHaveBeenCalled()
  })

  it('rejects expired or overlong envelopes and snapshots with a later envelope expiry', async () => {
    const f = fixture(), e = await envelope(f)
    await expect(f.adapter.execute({ ...e, expiresAt: f.now })).rejects.toMatchObject({ code: 'INVALID_PLAN_EXPIRY' })
    await expect(f.adapter.execute({ ...e, expiresAt: f.now + 300001 })).rejects.toMatchObject({ code: 'INVALID_PLAN_EXPIRY' })
    f.setTime(f.now + 300001)
    expect(await f.adapter.execute({ ...e, expiresAt: f.now + 10000 })).toMatchObject({ error: { code: 'PLAN_EXPIRED' } })
    expect(f.add).not.toHaveBeenCalled()
  })

  it('checks expiry again after an asynchronous authorizer', async () => {
    const entered = deferred(), release = deferred<boolean>()
    const f = fixture({ authorize: async () => { entered.resolve(); return release.promise } }), e = await envelope(f)
    const pending = f.adapter.execute(e)
    await entered.promise
    f.setTime(e.expiresAt)
    release.resolve(true)
    expect(await pending).toMatchObject({ error: { code: 'PLAN_EXPIRED' } })
    expect(f.add).not.toHaveBeenCalled()
  })

  it('fails closed when the snapshot cache is full and frees only expired snapshots', async () => {
    const f = fixture()
    const captured = await Promise.allSettled(Array.from({ length: 129 }, () => f.adapter.snapshot()))
    expect(captured.filter(result => result.status === 'fulfilled')).toHaveLength(128)
    expect(captured.filter(result => result.status === 'rejected')).toHaveLength(1)
    await expect(f.adapter.snapshot()).rejects.toMatchObject({ code: 'TOO_MANY_SNAPSHOTS' })
    f.setTime(f.now + 300000)
    expect(await f.adapter.snapshot()).toMatchObject({ protocol: 1 })
  })

  it('never evicts execution receipts to admit a new plan after the cache fills', async () => {
    const f = fixture(), e = await envelope(f)
    const first = await f.adapter.execute(e)
    await Promise.all(Array.from({ length: 1023 }, () => f.adapter.execute({ ...e, planId: identifier() })))
    await expect(f.adapter.execute({ ...e, planId: identifier() })).rejects.toMatchObject({ code: 'EXECUTION_CACHE_FULL' })
    expect(await f.adapter.execute(e)).toEqual(first)
    expect(f.add).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the cancellation cache fills but permits repeated cancellation', () => {
    const f = fixture(), runId = identifier()
    f.adapter.cancel(runId)
    for (let index = 1; index < 1024; index++) f.adapter.cancel(identifier())
    expect(() => f.adapter.cancel(identifier())).toThrow('CANCEL_CACHE_FULL')
    expect(f.adapter.cancel(runId)).toEqual({ cancelled: true })
  })
})

describe('cancellation and honest operation receipts', () => {
  it('does not authorize or execute a run cancelled before it starts', async () => {
    const authorize = vi.fn(() => true), f = fixture({ authorize }), e = await envelope(f)
    f.adapter.cancel(e.runId)
    expect(await f.adapter.execute(e)).toMatchObject({ status: 'failed', results: [], error: { code: 'CANCELLED' } })
    expect(authorize).not.toHaveBeenCalled()
    expect(f.add).not.toHaveBeenCalled()
  })

  it('aborts a cooperative pending operation and does not start later operations', async () => {
    const entered = deferred<OperationContext>()
    const f = fixture({ handlers: { wait: (_args, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
      entered.resolve(context)
    }) } })
    const e = await envelope(f, [{ op: 'wait', args: {} }, { op: 'add', args: { n: 1 } }])
    const pending = f.adapter.execute(e)
    const context = await entered.promise
    f.adapter.cancel(e.runId)
    const result = await pending as Result
    expect(context.signal.aborted).toBe(true)
    expect(result).toMatchObject({ status: 'partial', results: [{ index: 0, status: 'failed', error: { code: 'CANCELLED' } }] })
    expect(result.results).toHaveLength(1)
    expect(f.add).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'expiry'] as const)('keeps one completed receipt when %s follows commit', async kind => {
    const entered = deferred(), release = deferred()
    let f: ReturnType<typeof fixture>
    f = fixture({ handlers: { wait: async () => { f.changeState(); entered.resolve(); await release.promise; return { committed: true } } } })
    const e = await envelope(f, [{ op: 'wait', args: {} }, { op: 'add', args: { n: 1 } }])
    const pending = f.adapter.execute(e)
    await entered.promise
    if (kind === 'cancel') f.adapter.cancel(e.runId)
    else f.setTime(e.expiresAt)
    release.resolve()
    const result = await pending as Result
    expect(result).toEqual({ status: 'partial', results: [{ index: 0, op: 'wait', status: 'completed', result: { committed: true } }], revision: '1', error: { code: kind === 'cancel' ? 'CANCELLED' : 'PLAN_EXPIRED' } })
    expect(f.add).not.toHaveBeenCalled()
    if (kind === 'cancel') expect(await f.adapter.execute(e)).toEqual(result)
    else await expect(f.adapter.execute(e)).rejects.toMatchObject({ code: 'INVALID_PLAN_EXPIRY' })
  })

  it('signals expiration while the actual handler is still pending', async () => {
    const entered = deferred<OperationContext>()
    const f = fixture({ handlers: { wait: (_args, context) => new Promise((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new DOMException('Expired', 'AbortError')), { once: true })
      entered.resolve(context)
    }) } })
    const e = await envelope(f, [{ op: 'wait', args: {} }])
    vi.useFakeTimers()
    const pending = f.adapter.execute(e)
    const context = await entered.promise
    await vi.advanceTimersByTimeAsync(10000)
    expect(context.signal.aborted).toBe(true)
    expect(await pending).toMatchObject({ status: 'partial', results: [{ error: { code: 'CANCELLED' } }] })
  })

  it('retains earlier successful receipts on failure and never retries the plan', async () => {
    const f = fixture({ handlers: { wait: () => { throw new Error('private backend body https://secret.invalid/token') } } })
    const e = await envelope(f, [{ op: 'add', args: { n: 1 } }, { op: 'wait', args: {} }, { op: 'add', args: { n: 2 } }])
    const result = await f.adapter.execute(e) as Result
    expect(result).toMatchObject({ status: 'partial', results: [{ index: 0, status: 'completed' }, { index: 1, status: 'failed', error: { code: 'OPERATION_FAILED' } }] })
    expect(result.results).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('secret.invalid')
    expect(await f.adapter.execute(e)).toEqual(result)
    expect(f.value).toBe(1)
  })

  it('does not absorb an unrelated microtask state change after a synchronous commit', async () => {
    let f: ReturnType<typeof fixture>
    f = fixture({ handlers: { wait: () => {
      f.changeState()
      queueMicrotask(() => f.changeState())
      return { committed: true }
    } } })
    const e = await envelope(f, [{ op: 'wait', args: {} }, { op: 'add', args: { n: 1 } }])
    expect(await f.adapter.execute(e)).toEqual({
      status: 'partial', revision: '2', error: { code: 'STATE_CHANGED_DURING_PLAN' },
      results: [{ index: 0, op: 'wait', status: 'completed', result: { committed: true } }],
    })
    expect(f.add).not.toHaveBeenCalled()
  })
})

describe('adapter disposal', () => {
  it('rejects new calls and is idempotent', async () => {
    const f = fixture(), e = await envelope(f)
    f.adapter.dispose()
    f.adapter.dispose()
    await expect(f.adapter.snapshot()).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' })
    await expect(f.adapter.execute(e)).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' })
    expect(() => f.adapter.cancel(e.runId)).toThrow('ADAPTER_DISPOSED')
    expect(f.add).not.toHaveBeenCalled()
  })

  it('rejects a snapshot whose context finishes after disposal', async () => {
    const entered = deferred(), release = deferred<Record<string, number>>()
    const f = fixture({ getContext: async () => { entered.resolve(); return release.promise } })
    const pending = f.adapter.snapshot()
    await entered.promise
    f.adapter.dispose()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ADAPTER_DISPOSED' })
    release.resolve({ value: 0 })
    await rejected
  })

  it('blocks authorizing and queued work even if authorization subsequently succeeds', async () => {
    const entered = deferred(), release = deferred<boolean>(), authorize = vi.fn(async () => { entered.resolve(); return release.promise })
    const f = fixture({ authorize }), first = await envelope(f), second = await envelope(f)
    const active = f.adapter.execute(first)
    await entered.promise
    // Wait through the real fingerprint boundary so this is specifically queued work.
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const queued = f.adapter.execute(second)
    await digest.mock.results[0].value
    await Promise.resolve()
    await expect(f.adapter.execute({ ...second, plan: { ...second.plan, message: 'changed replay' } })).rejects.toMatchObject({ code: 'PLAN_ID_REUSE' })
    f.adapter.dispose()
    release.resolve(true)
    expect(await active).toMatchObject({ status: 'failed', error: { code: 'ADAPTER_DISPOSED' } })
    expect(await queued).toMatchObject({ status: 'failed', error: { code: 'ADAPTER_DISPOSED' } })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(f.add).not.toHaveBeenCalled()
  })

  it('aborts running work and preserves a completed receipt if a handler already committed', async () => {
    const entered = deferred<OperationContext>(), release = deferred()
    const f = fixture({ handlers: { wait: async (_args, context) => { entered.resolve(context); await release.promise; return { committed: true } } } })
    const pending = f.adapter.execute(await envelope(f, [{ op: 'wait', args: {} }, { op: 'add', args: { n: 1 } }]))
    const context = await entered.promise
    f.adapter.dispose()
    expect(context.signal.aborted).toBe(true)
    release.resolve()
    expect(await pending).toEqual({ status: 'partial', results: [{ index: 0, op: 'wait', status: 'completed', result: { committed: true } }], error: { code: 'ADAPTER_DISPOSED' } })
    expect(f.add).not.toHaveBeenCalled()
  })

  it('blocks work waiting for a Web Lock when its callback arrives after disposal', async () => {
    const entered = deferred(), release = deferred()
    vi.stubGlobal('navigator', { locks: { request: (_name: string, callback: () => Promise<unknown>) => {
      entered.resolve()
      return release.promise.then(callback)
    } } })
    const f = fixture({ lockName: 'davis-test' })
    const pending = f.adapter.execute(await envelope(f))
    await entered.promise
    f.adapter.dispose()
    release.resolve()
    expect(await pending).toMatchObject({ status: 'failed', results: [], error: { code: 'ADAPTER_DISPOSED' } })
    expect(f.add).not.toHaveBeenCalled()
  })
})

describe('page-commands/1 window transport', () => {
  function register(overrides: Partial<PageBridgeOptions> = {}) {
    const f = fixture(overrides)
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const dispose = registerPageBridge(f.options)
    cleanups.push(dispose)
    const send = (data: Record<string, unknown>, source: MessageEventSource | null = window, origin = location.origin) => {
      window.dispatchEvent(new MessageEvent('message', { data, source, origin }))
    }
    return { ...f, post, dispose, send }
  }

  it('advertises exact metadata and replies only in the original channel/direction/origin', async () => {
    const f = register()
    expect(CHANNEL).toBe('siwc-page-commands/1')
    expect(document.querySelectorAll('meta[name="siwc-bridge"]')).toHaveLength(1)
    expect(document.querySelector('meta[name="siwc-bridge"]')).toHaveAttribute('content', 'page-commands/1')
    expect(document.querySelector('meta[name="siwc-bridge-app"]')).toHaveAttribute('content', 'davis-test')
    const request = { channel: CHANNEL, direction: 'to-page', id: 'request-1', method: 'snapshot' }
    f.send(request, null)
    f.send(request, window, 'https://other.example.test')
    f.send({ ...request, channel: 'page-commands/1' })
    f.send({ ...request, direction: 'to-extension' })
    f.send({ ...request, method: 'eval' })
    f.send({ ...request, id: 'x'.repeat(101) })
    f.send({ ...request, id: 1 })
    expect(f.post).not.toHaveBeenCalled()
    f.send(request)
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1))
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ channel: CHANNEL, direction: 'to-extension', id: 'request-1', ok: true, value: expect.objectContaining({ protocol: 1, app: { id: 'davis-test', name: 'DAVIS test' } }) }), location.origin)
  })

  it('rejects another same-origin window and malformed execute with a sanitized error', async () => {
    const f = register(), iframe = document.createElement('iframe')
    document.body.append(iframe)
    const request = { channel: CHANNEL, direction: 'to-page', id: 'request-1', method: 'execute', payload: { padding: 'x'.repeat(1024 * 1024) } }
    f.send(request, iframe.contentWindow)
    expect(f.post).not.toHaveBeenCalled()
    f.send(request)
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1))
    expect(f.post).toHaveBeenCalledWith({ channel: CHANNEL, direction: 'to-extension', id: 'request-1', ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } }, location.origin)
    iframe.remove()
  })

  it.each(['cleanup', 'pagehide'] as const)('suppresses pending replies and listener work after %s', async kind => {
    const entered = deferred(), release = deferred<Record<string, number>>()
    const f = register({ getContext: async () => { entered.resolve(); return release.promise } })
    const request = { channel: CHANNEL, direction: 'to-page', id: 'pending', method: 'snapshot' }
    f.send(request)
    await entered.promise
    if (kind === 'cleanup') f.dispose()
    else window.dispatchEvent(new Event('pagehide'))
    f.dispose()
    release.resolve({ value: 0 })
    await release.promise
    await Promise.resolve()
    f.send({ ...request, id: 'after-dispose' })
    expect(f.post).not.toHaveBeenCalled()
    expect(document.querySelector('meta[name="siwc-bridge"]')).toBeNull()
    expect(document.querySelector('meta[name="siwc-bridge-app"]')).toBeNull()
  })

  it('supports cleanup and fresh registration without duplicate metadata or replies', async () => {
    const f = register()
    f.dispose()
    const disposeAgain = registerPageBridge(f.options)
    cleanups.push(disposeAgain)
    f.send({ channel: CHANNEL, direction: 'to-page', id: 'fresh', method: 'snapshot' })
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1))
    expect(document.querySelectorAll('meta[name="siwc-bridge"]')).toHaveLength(1)
    expect(document.querySelectorAll('meta[name="siwc-bridge-app"]')).toHaveLength(1)
  })

  it('routes a bound execute request and cancellation reply through the original envelope', async () => {
    const f = register()
    f.send({ channel: CHANNEL, direction: 'to-page', id: 'snapshot', method: 'snapshot' })
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(1))
    const snapshot = (f.post.mock.calls[0][0] as { value: Snapshot }).value
    const runId = identifier()
    f.send({ channel: CHANNEL, direction: 'to-page', id: 'execute', method: 'execute', payload: {
      snapshotId: snapshot.snapshotId, schemaHash: snapshot.schemaHash, revision: snapshot.revision,
      runId, planId: identifier(), expiresAt: f.now + 10000,
      plan: { kind: 'commands', message: 'Add one', commands: [{ op: 'add', args: { n: 1 } }] },
    } })
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2))
    expect(f.post.mock.calls[1]).toEqual([{ channel: CHANNEL, direction: 'to-extension', id: 'execute', ok: true, value: {
      status: 'completed', revision: '1', results: [{ index: 0, op: 'add', status: 'completed', result: { value: 1 } }],
    } }, location.origin])
    f.send({ channel: CHANNEL, direction: 'to-page', id: 'cancel', method: 'cancel', payload: { runId } })
    expect(f.post.mock.calls[2]).toEqual([{ channel: CHANNEL, direction: 'to-extension', id: 'cancel', ok: true, value: { cancelled: true } }, location.origin])
    expect(f.add).toHaveBeenCalledTimes(1)
  })

  it('requires HTTPS and a top-level window', () => {
    const f = fixture()
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://davis.example.test' })
    expect(() => registerPageBridge(f.options)).toThrow('HTTPS_TOP_LEVEL_REQUIRED')
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://davis.example.test' })
    vi.stubGlobal('window', { top: {} })
    expect(() => registerPageBridge(f.options)).toThrow('HTTPS_TOP_LEVEL_REQUIRED')
  })

  it.each(['siwc-bridge', 'siwc-bridge-app'])('rejects duplicated %s metadata before registration', name => {
    for (let index = 0; index < 2; index++) {
      const element = document.createElement('meta')
      element.name = name
      document.head.append(element)
    }
    expect(() => registerPageBridge(fixture().options)).toThrow('DUPLICATE_META')
  })
})
