import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPageAdapter } from '../src/integrations/siwc/sdk/page-bridge.js'
import type { CommandDefinition, JSONSchema, JSONValue, PageBridgeOptions } from '../src/integrations/siwc/sdk/page-bridge.js'
import { digest } from '../src/integrations/siwc/extension/core/common.js'
import { normalizeCommands } from '../src/integrations/siwc/extension/core/schema.js'
import { commandRole, pendingWorkflow, workflowCommand, workflowFromExecution } from '../src/integrations/siwc/extension/core/workflow.js'

type Workflow = Record<string, JSONValue>
type Command = { op: string; args: Record<string, JSONValue> }
type Snapshot = { contractRevision: number; snapshotId: string; schemaHash: string; revision: string; commands: CommandDefinition[]; workflow: Workflow | null }
type Result = { status: string; results: Array<{ op: string; status: string; result?: unknown }>; error?: { code: string } }
const object = (properties: Record<string, JSONSchema>): JSONSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const binding = { requestId: { type: 'string' }, draftRevision: { type: 'integer' } }
const answerSchema: JSONSchema = object({ questionId: { type: 'string' }, value: { anyOf: [
  { type: 'string' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } },
] } })
const names = { prepare: 'document.begin', resume: 'input.accept', run: 'job.finish', cancel: 'draft.abandon' }
const definitions = (): CommandDefinition[] => [
  { name: names.prepare, workflowRole: 'prepare', description: 'Prepare', effect: 'write', inputSchema: object({}) },
  { name: names.resume, workflowRole: 'resume', description: 'Answer', effect: 'write', inputSchema: object({ ...binding, answers: { type: 'array', items: answerSchema } }) },
  { name: names.run, workflowRole: 'run', description: 'Run', effect: 'write', inputSchema: object(binding) },
  { name: names.cancel, workflowRole: 'cancel', description: 'Cancel', effect: 'write', inputSchema: object(binding) },
  // Even this name has no lifecycle meaning without a declared role.
  { name: 'analysis.run', description: 'Ordinary metadata', effect: 'read', inputSchema: object({}) },
]
const questions = [{ id: 'choice', type: 'single', prompt: 'Which item?', required: true,
  options: [{ value: 'item-a', label: 'Item A' }, { value: 'item-b', label: 'Item B' }] }]
function state(status: string, now: number): Workflow {
  return { workflow: 'page-workflow/1', method: 'opaque-application-method', status,
    requestId: 'request-one', draftRevision: 3, expiresAt: now + 900000, running: false,
    ...(status === 'needs_input' ? { questions, resume: { command: names.resume } } : {}),
    ...(status === 'ready' ? { run: { command: names.run } } : {}),
    ...(status === 'completed' ? { resultId: 'existing-result', view: '/documents/result' } : {}),
    ...(['needs_input', 'ready', 'completed'].includes(status) ? { cancel: { command: names.cancel } } : {}),
  }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const cleanups: Array<() => void> = []
let sequence = 0
const identifier = () => `workflow_identifier_${++sequence}`
function fixture(overrides: Partial<PageBridgeOptions> = {}) {
  let now = Date.now(), generation = 0, fits = 0
  let current: Workflow | null = state('ready', now)
  let reader: () => JSONValue | Promise<JSONValue> = () => current
  const commands = definitions()
  const commit = (status: string) => {
    current = { ...state(status, now), draftRevision: Number(current?.draftRevision ?? 0) + 1 }
    generation++
    return current
  }
  const prepare = vi.fn(() => commit('needs_input'))
  const resume = vi.fn(() => commit('ready'))
  const run = vi.fn(() => {
    if (current?.status === 'completed') return current
    fits++
    return commit('completed')
  })
  const cancel = vi.fn(() => current?.status === 'completed' ? current : commit('cancelled'))
  const ordinary = vi.fn(() => ({ workflow: 'an opaque ordinary result field', status: 'application-owned' }))
  const authorize = vi.fn(() => true)
  const options: PageBridgeOptions = { appId: 'generic-workflow-test', appName: 'Generic workflow',
    commands, getContext: () => ({ title: 'A document' }), getWorkflow: () => reader(),
    getRevision: () => String(generation), clock: () => now, authorize,
    handlers: { [names.prepare]: prepare, [names.resume]: resume, [names.run]: run,
      [names.cancel]: cancel, 'analysis.run': ordinary }, ...overrides }
  const adapter = createPageAdapter(options)
  cleanups.push(adapter.dispose)
  return { adapter, commands, prepare, resume, run, cancel, ordinary, authorize,
    get now() { return now }, get fits() { return fits }, get workflow() { return current },
    binding: () => ({ requestId: String(current!.requestId), draftRevision: Number(current!.draftRevision) }),
    setWorkflow(value: Workflow | null) { current = value },
    setReader(value: typeof reader) { reader = value },
    changeState() { generation++ }, advanceTime(amount: number) { now += amount },
  }
}
async function envelope(f: ReturnType<typeof fixture>, commands: Command[] = [{ op: names.run, args: f.binding() }]) {
  const snapshot = await f.adapter.snapshot() as Snapshot
  return { snapshotId: snapshot.snapshotId, schemaHash: snapshot.schemaHash, revision: snapshot.revision,
    planId: identifier(), runId: identifier(), expiresAt: f.now + 10000,
    plan: { kind: 'commands', message: 'Apply the requested document operation', commands } }
}
beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('generic revision-two discovery', () => {
  it('discovers arbitrary command names by role and includes the roles in the normalized hash', async () => {
    const f = fixture(), snapshot = await f.adapter.snapshot() as Snapshot
    expect(snapshot.contractRevision).toBe(2)
    expect(snapshot.commands.map(c => c.workflowRole)).toEqual(['prepare', 'resume', 'run', 'cancel', undefined])
    expect(snapshot.schemaHash).toBe(await digest(normalizeCommands(f.commands)))
    expect(commandRole(names.run, snapshot.commands)).toBe('run')
    expect(commandRole('analysis.run', snapshot.commands)).toBeNull()
    expect(workflowCommand(pendingWorkflow(snapshot), 'run', snapshot.commands)).toBe(names.run)
    const withoutRoles = f.commands.map(({ workflowRole: _role, ...rest }) => rest)
    expect(await digest(normalizeCommands(withoutRoles))).not.toBe(snapshot.schemaHash)
    const e = await envelope(f)
    f.commands[2].workflowRole = 'cancel'
    expect(await f.adapter.execute(e)).toMatchObject({ status: 'failed', results: [], error: { code: 'SCHEMA_CHANGED' } })
    expect(f.run).not.toHaveBeenCalled()
  })

  it('keeps absent workflows optional and ordinary result workflow fields opaque', async () => {
    const f = fixture({ getWorkflow: undefined })
    expect(await f.adapter.snapshot()).toMatchObject({ contractRevision: 2, workflow: null })
    const result = await f.adapter.execute(await envelope(f, [{ op: 'analysis.run', args: {} }])) as Result
    expect(result).toMatchObject({ status: 'completed', results: [{ result: { workflow: 'an opaque ordinary result field' } }] })
    expect(workflowFromExecution(result, f.commands)).toBeNull()
    expect(f.ordinary).toHaveBeenCalledOnce()
    expect(await f.adapter.execute(await envelope(f))).toMatchObject({ status: 'failed', results: [], error: { code: 'NO_PENDING_WORKFLOW' } })
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['execute', '', null, 1, {}])('rejects malformed workflow role %j', async role => {
    const commands = definitions()
    Object.assign(commands[0], { workflowRole: role })
    const f = fixture({ commands })
    await expect(f.adapter.snapshot()).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_ROLE' })
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it.each([
    [{ workflow: 'davis-analysis/1' }, 'UNSUPPORTED_WORKFLOW_VERSION'],
    [{ status: 'unrecognized' }, 'UNSUPPORTED_WORKFLOW_STATUS'],
    [{ draftRevision: 1.5 }, 'INVALID_DRAFT_REVISION'],
    [{ run: { command: 'job.finish', extra: true } }, 'UNSUPPORTED_WORKFLOW_COMMAND'],
    [{ preview: { text: 'x'.repeat(128 * 1024) } }, 'PAYLOAD_TOO_LARGE'],
  ])('rejects malformed or oversized workflow %j', async (patch, code) => {
    const f = fixture()
    f.setWorkflow({ ...state('ready', f.now), ...patch } as Workflow)
    await expect(f.adapter.snapshot()).rejects.toMatchObject({ code })
    expect(f.run).not.toHaveBeenCalled()
  })
})

describe('workflow preconditions before all effects', () => {
  it.each(['prepare-run', 'ordinary-run', 'cancel-ordinary'])('rejects the entire %s batch before authorization or mutation', async kind => {
    const f = fixture(), binding = f.binding()
    const commands = kind === 'prepare-run' ? [{ op: names.prepare, args: {} }, { op: names.run, args: binding }]
      : kind === 'ordinary-run' ? [{ op: 'analysis.run', args: {} }, { op: names.run, args: binding }]
        : [{ op: names.cancel, args: binding }, { op: 'analysis.run', args: {} }]
    const before = f.workflow
    expect(await f.adapter.execute(await envelope(f, commands))).toMatchObject({ status: 'failed', results: [], error: { code: 'WORKFLOW_PLAN_MUST_BE_SINGLE' } })
    for (const handler of [f.authorize, f.prepare, f.run, f.cancel, f.ordinary]) expect(handler).not.toHaveBeenCalled()
    expect(f.workflow).toBe(before)
  })

  it('accepts standalone prepare and resolves only current explicit answers', async () => {
    const f = fixture()
    f.setWorkflow(null)
    const prepared = await f.adapter.execute(await envelope(f, [{ op: names.prepare, args: {} }])) as Result
    expect(workflowFromExecution(prepared, f.commands)).toMatchObject({ status: 'needs_input', resume: { command: names.resume } })
    const result = await f.adapter.execute(await envelope(f, [{ op: names.resume, args: { ...f.binding(), answers: [{ questionId: 'choice', value: 'item-b' }] } }]))
    expect(result).toMatchObject({ status: 'completed', results: [{ result: { status: 'ready' } }] })
    expect(f.prepare).toHaveBeenCalledOnce()
    expect(f.resume).toHaveBeenCalledOnce()
    expect(f.fits).toBe(0)
  })

  it.each([
    ['wrong-request', 'STALE_DRAFT'], ['wrong-revision', 'STALE_DRAFT'],
    ['not-ready', 'WORKFLOW_NOT_READY'], ['not-waiting', 'WORKFLOW_NOT_WAITING'],
    ['expired', 'WORKFLOW_EXPIRED'], ['running', 'WORKFLOW_RUNNING'],
    ['wrong-hint', 'UNSUPPORTED_WORKFLOW_COMMAND'], ['wrong-role-hint', 'UNSUPPORTED_WORKFLOW_COMMAND'],
    ['invalidated-cancel', 'UNSUPPORTED_WORKFLOW_COMMAND'], ['cancelled-cancel', 'UNSUPPORTED_WORKFLOW_COMMAND'],
    ['invalid-answer', 'INVALID_USER_ANSWERS'],
  ])('rejects %s without invoking a handler', async (kind, code) => {
    const f = fixture()
    let op = names.run, args: Record<string, JSONValue> = f.binding()
    if (kind === 'wrong-request') args.requestId = 'other-request'
    if (kind === 'wrong-revision') args.draftRevision = 2
    if (kind === 'not-ready') f.setWorkflow(state('needs_input', f.now))
    if (kind === 'not-waiting' || kind === 'invalid-answer') {
      op = names.resume
      args = { ...args, answers: [{ questionId: 'choice', value: 'not-an-option' }] }
      if (kind === 'invalid-answer') f.setWorkflow(state('needs_input', f.now))
    }
    if (kind === 'expired') f.setWorkflow({ ...state('ready', f.now), expiresAt: f.now })
    if (kind === 'running') f.setWorkflow({ ...state('ready', f.now), running: true })
    if (kind === 'wrong-hint') f.setWorkflow({ ...state('ready', f.now), run: { command: names.resume } })
    if (kind === 'wrong-role-hint') f.setWorkflow({ ...state('ready', f.now), run: { command: 'analysis.run' } })
    if (kind === 'invalidated-cancel' || kind === 'cancelled-cancel') {
      op = names.cancel
      f.setWorkflow(state(kind === 'invalidated-cancel' ? 'invalidated' : 'cancelled', f.now))
    }
    expect(await f.adapter.execute(await envelope(f, [{ op, args }]))).toMatchObject({ status: 'failed', results: [], error: { code } })
    for (const handler of [f.prepare, f.resume, f.run, f.cancel]) expect(handler).not.toHaveBeenCalled()
    expect(f.fits).toBe(0)
  })

  it.each(['changed-status', 'malformed'])('reads the current %s workflow instead of trusting the captured snapshot', async kind => {
    const f = fixture(), e = await envelope(f)
    f.setWorkflow({ ...state('needs_input', f.now), ...(kind === 'malformed' ? { workflow: 'broken' } : {}) })
    expect(await f.adapter.execute(e)).toMatchObject({ status: 'failed', results: [], error: {
      code: kind === 'malformed' ? 'UNSUPPORTED_WORKFLOW_VERSION' : 'WORKFLOW_NOT_READY',
    } })
    expect(f.run).not.toHaveBeenCalled()
  })

  it('requires page-only confirmation to be resolved by a page action and fresh snapshot', async () => {
    const f = fixture()
    f.setWorkflow({ ...state('needs_input', f.now), questions: [{ id: 'pageConsent', type: 'confirmation',
      prompt: 'Confirm on the page', required: true, requiresPageAction: true,
      pageAction: { view: '/documents', instruction: 'Use the page control' } }] })
    for (const answers of [[], [{ questionId: 'pageConsent', value: true }]]) {
      expect(await f.adapter.execute(await envelope(f, [{ op: names.resume, args: { ...f.binding(), answers } }]))).toMatchObject({ error: { code: 'INVALID_USER_ANSWERS' }, results: [] })
    }
    expect(f.resume).not.toHaveBeenCalled()
    const old = await envelope(f)
    f.setWorkflow({ ...state('ready', f.now), draftRevision: 4 }); f.changeState()
    expect(await f.adapter.execute(old)).toMatchObject({ error: { code: 'STALE_STATE' }, results: [] })
    expect(await f.adapter.execute(await envelope(f))).toMatchObject({ status: 'completed', results: [{ result: { status: 'completed' } }] })
    expect(f.fits).toBe(1)
  })

  it.each(['needs_input', 'ready', 'completed'])('uses the declared cancel hint for %s without recomputing', async status => {
    const f = fixture()
    f.setWorkflow(state(status, f.now))
    const before = f.workflow
    const result = await f.adapter.execute(await envelope(f, [{ op: names.cancel, args: f.binding() }]))
    expect(result).toMatchObject({ status: 'completed', results: [{ result: { status: status === 'completed' ? 'completed' : 'cancelled' } }] })
    if (status === 'completed') expect(f.workflow).toBe(before)
    else expect(f.workflow).not.toHaveProperty('cancel')
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.fits).toBe(0)
  })

  it('binds completed replay to a fresh current draft or the exact original envelope', async () => {
    const f = fixture(), previousBinding = f.binding(), e = await envelope(f)
    const completed = await f.adapter.execute(e)
    expect(await f.adapter.execute(e)).toEqual(completed)
    expect(f.run).toHaveBeenCalledOnce()
    expect(await f.adapter.execute(await envelope(f, [{ op: names.run, args: previousBinding }]))).toMatchObject({ status: 'failed', results: [], error: { code: 'STALE_DRAFT' } })
    expect(f.run).toHaveBeenCalledOnce()
    expect(await f.adapter.execute(await envelope(f))).toMatchObject({ status: 'completed', results: [{ result: f.workflow }] })
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.fits).toBe(1)
  })
})

describe('asynchronous workflow read boundaries', () => {
  it.each(['generation', 'dispose'])('rejects a snapshot when %s changes during its workflow read', async kind => {
    const entered = deferred(), release = deferred<JSONValue>(), f = fixture()
    f.setReader(async () => { entered.resolve(); return release.promise })
    const pending = f.adapter.snapshot()
    await entered.promise
    if (kind === 'dispose') f.adapter.dispose()
    else f.changeState()
    const rejected = expect(pending).rejects.toMatchObject({ code: kind === 'dispose' ? 'ADAPTER_DISPOSED' : 'STATE_CHANGED_DURING_SNAPSHOT' })
    release.resolve(state('ready', f.now))
    await rejected
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['generation', 'cancel', 'expiry', 'dispose', 'signal-deadline'])('rechecks %s after the current workflow read before mutation', async kind => {
    if (kind === 'signal-deadline') vi.useFakeTimers()
    const entered = deferred(), release = deferred<JSONValue>(), f = fixture(), e = await envelope(f)
    f.setReader(async () => { entered.resolve(); return release.promise })
    const pending = f.adapter.execute(e)
    await entered.promise
    if (kind === 'generation') f.changeState()
    if (kind === 'cancel') f.adapter.cancel(e.runId)
    if (kind === 'expiry') f.advanceTime(10000)
    if (kind === 'dispose') f.adapter.dispose()
    if (kind === 'signal-deadline') await vi.advanceTimersByTimeAsync(10000)
    release.resolve(state('ready', f.now))
    const code = kind === 'generation' ? 'STATE_CHANGED_DURING_PLAN' : kind === 'expiry' ? 'PLAN_EXPIRED'
      : kind === 'dispose' ? 'ADAPTER_DISPOSED' : 'CANCELLED'
    expect(await pending).toMatchObject({ status: 'failed', results: [], error: { code } })
    expect(f.run).not.toHaveBeenCalled()
    expect(f.fits).toBe(0)
  })
})
