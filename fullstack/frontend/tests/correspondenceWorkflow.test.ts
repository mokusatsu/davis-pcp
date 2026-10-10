import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  store, datasetLoaded, datasetValuesUpdated, variablesInitialized, activeEntitiesSet,
  observationScopeChanged, selectionApplied, samplingApplied, selectEffectiveRowIds,
} from '../src/app/store'
import { codebookReceived } from '../src/features/dataset/codebookSlice'
import type { CodebookColumn } from '../src/api/client'
import { createScopeSnapshot } from '../src/features/selection/analysisScope'
import type { CAResponse } from '../src/features/models/caTypes'
import type {
  CorrespondenceCompleted, CorrespondenceConfiguration, CorrespondenceController,
  CorrespondenceInspection, CorrespondenceRunOptions, CorrespondenceSetup,
} from '../src/features/models/caControllerBridge'
import {
  CORRESPONDENCE_COMMANDS, createCorrespondenceWorkflow, summarizeCorrespondence,
} from '../src/integrations/siwc/correspondenceWorkflow'
import { createDavisOptions, createDavisRevisionMonitor } from '../src/integrations/siwc/davisAdapter'
import { createPageAdapter } from '../src/integrations/siwc/sdk/page-bridge.js'
import type { JSONValue, OperationContext } from '../src/integrations/siwc/sdk/page-bridge.js'
import { BridgeError, boundedJSON } from '../src/integrations/siwc/extension/core/common.js'
import { checkSchema, validate } from '../src/integrations/siwc/extension/core/schema.js'

type WorkflowState = {
  workflow: string; status: string; requestId: string; draftRevision: number; expiresAt: number
  questions: Array<{ id: string; type: string; requiresPageAction?: boolean; options?: Array<{ value: string; label: string }>; minItems?: number; maxItems?: number }>
  preview: Record<string, JSONValue>; summary: Record<string, JSONValue> | null; running: boolean; reason: string | null
}
type Answer = { questionId: string; value: string | string[] | boolean }
const rows = ['PRIVATE_ROW_A', 'PRIVATE_ROW_B', 'PRIVATE_ROW_C', 'PRIVATE_ROW_D']
const cleanups: Array<() => void> = []
function column(columnId: string, name: string, patch: Partial<CodebookColumn> = {}): CodebookColumn {
  return { columnId, name, label: `${name} label`, role: 'question', scaleType: 'nominal',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null, ...patch }
}
const columns = [column('id-a', 'A'), column('id-b', '__proto__'), column('id-c', 'C'),
  column('id-label', 'row label', { scaleType: 'text' }), column('id-x', 'X', { scaleType: 'ratio' }),
  column('id-y', 'Y', { scaleType: 'interval' }), column('id-weight', 'weight', { role: 'weight', scaleType: 'ratio' }),
  column('id-ma', 'MA child', { multiResponseGroup: 'ma-group' })]
const initial = (): CorrespondenceSetup => ({ inputKind: 'respondents', rowVar: null, colVar: null,
  rowLabelCol: null, valueCols: [], cellSemantics: 'frequency', ack: false,
  mapScaling: 'symmetric', missingPolicy: 'exclude', weightChoice: 'dataset' })
function installDataset(datasetId = 'dataset', savedWeight = false) {
  store.dispatch(datasetLoaded({ datasetId, name: 'Survey', rowIds: rows, dataRevision: 7 }))
  store.dispatch(variablesInitialized({ datasetId, variables: columns.map(c => c.name),
    meta: Object.fromEntries(columns.map(c => [c.name, { name: c.name, columnId: c.columnId,
      semanticType: 'nominal', physicalType: 'string', missingCount: 0, isTargetCandidate: true }])) }))
  store.dispatch(codebookReceived({ datasetId, schemaRevision: 3, columns,
    weightConfig: savedWeight ? { weightColumnId: 'id-weight', weightType: 'survey' } : null }))
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function completed(resultId = 'normal-ca-result'): CorrespondenceCompleted {
  const state = store.getState(), scope = state.globalObservations.scopeMode
  const snapshot = createScopeSnapshot(scope, selectEffectiveRowIds(state), state.selection.datasetId,
    state.selection.dataRevision, state.codebook.schemaRevision)
  const result: CAResponse = {
    status: 'success', method: 'ca', resultId,
    config: { internalConfig: 'PRIVATE_CONFIG', rows },
    meta: { datasetId: state.selection.datasetId!, dataRevision: state.selection.dataRevision,
      schemaRevision: state.codebook.schemaRevision, resultState: 'current', scope,
      scopeCount: 4, fitCount: 3, effectiveN: 3, excludedCount: 1, exclusionCounts: { missing: 1 },
      analysisUnit: 'respondent_row', weightApplied: false, weightType: null, weightColumn: null,
      algorithmVersion: 'ca-test-1', warnings: [{ code: 'MISSING_EXCLUDED', message: `PRIVATE_WARNING ${rows[0]}` }] },
    capabilities: { selectionKinds: ['categories'], exportTables: ['manifest', 'eigenvalues', 'table'] },
    summary: { rank: 1, totalInertia: 0.25, eigenvalues: [0.25], inertiaRatio: [1], cumulativeInertiaRatio: [1],
      discardedNumericalInertia: 0, tableTotal: 3, activeRowCategoryCount: 2, activeColumnCategoryCount: 2,
      pearson: { status: 'not_applicable', reason: 'PRIVATE_PEARSON', statistic: null, df: null, pValue: null,
        smallExpectedCellsLt1: null, smallExpectedCellsLt5: null, fractionExpectedLt5: null } },
    details: { rowCategories: [], columnCategories: [], omittedCategories: [], table: [[1, 0], [0, 2]],
      physicalTable: null, tableRowCategoryIds: rows, tableColumnCategoryIds: ['PRIVATE_CATEGORY'], mapScaling: 'symmetric' },
  }
  return { result, snapshot, context: { datasetId: state.selection.datasetId!, expectedDataRevision: state.selection.dataRevision,
    expectedSchemaRevision: state.codebook.schemaRevision, scope, activeRowIds: rows,
    missingPolicy: 'exclude', weightMode: 'dataset' } }
}

function fixture(setupPatch: Partial<CorrespondenceSetup> = {}) {
  let path = '/pcp', setup = { ...initial(), ...setupPatch }, available = true, ready = true, loading = false
  let now = Date.now(), published: CorrespondenceCompleted | null = null
  let runGate: ReturnType<typeof deferred> | null = null
  let response = () => completed(), afterCommit = () => {}
  const enteredRun = deferred<CorrespondenceRunOptions>()
  const routeListeners = new Set<() => void>(), controllerListeners = new Set<() => void>()
  const notify = () => { for (const listener of [...controllerListeners]) listener() }
  const router = {
    getPath: () => path,
    subscribe: (listener: () => void) => { routeListeners.add(listener); return () => { routeListeners.delete(listener) } },
    navigate: vi.fn((next: string) => { if (path !== next) { path = next; for (const listener of [...routeListeners]) listener() } }),
  }
  const inspect = (): CorrespondenceInspection => {
    const state = store.getState()
    const chosen = setup.inputKind === 'respondents' ? [setup.rowVar, setup.colVar] : setup.valueCols
    const active = state.globalVariables.activeEntities
    const selected = chosen.every(name => active === null || active.some(e => e.kind === 'column'
      && state.codebook.columns.find(c => c.columnId === e.columnId)?.name === name))
    const valid = setup.inputKind === 'respondents' ? Boolean(setup.rowVar && setup.colVar && setup.rowVar !== setup.colVar)
      : Boolean(setup.rowLabelCol && setup.valueCols.length >= 2 && (setup.cellSemantics === 'mass' || setup.ack)
        && !(setup.weightChoice === 'dataset' && state.codebook.weightConfig?.weightColumnId))
    return { datasetId: state.selection.datasetId, dataRevision: state.selection.dataRevision,
      schemaRevision: state.codebook.schemaRevision, ready, canRun: ready && selected && valid, loading,
      setup: { ...setup, valueCols: [...setup.valueCols] }, completed: published, error: null,
      scopeKey: `PRIVATE_SCOPE ${rows.join(',')}`, inputContextKey: `PRIVATE_CONTEXT ${rows.join(',')}`,
      draftKey: JSON.stringify(setup) }
  }
  const configure = vi.fn((patch: CorrespondenceConfiguration) => {
    const changed = Object.entries(patch).some(([key, value]) => JSON.stringify(setup[key as keyof CorrespondenceSetup]) !== JSON.stringify(value))
    setup = { ...setup, ...patch, ...(changed ? { ack: false } : {}) }
    notify()
    return inspect()
  })
  const run = vi.fn(async (options: CorrespondenceRunOptions = {}) => {
    loading = true; notify(); enteredRun.resolve(options)
    try {
      if (runGate) await runGate.promise
      if (options.signal?.aborted) throw new BridgeError('CANCELLED')
      const receipt = response()
      if (options.beforeCommit && !options.beforeCommit(receipt)) throw new BridgeError('CA_RUN_SUPERSEDED')
      if (options.signal?.aborted) throw new BridgeError('CANCELLED')
      published = receipt; loading = false; notify()
      afterCommit()
      return receipt
    } finally { loading = false; notify() }
  })
  const controller: CorrespondenceController = { inspect, configure, run,
    subscribe: listener => { controllerListeners.add(listener); return () => { controllerListeners.delete(listener) } } }
  const controllers = { get: () => available ? controller : null, subscribe: controller.subscribe }
  const monitor = createDavisRevisionMonitor({ store, router })
  const workflow = createCorrespondenceWorkflow({ store, router, monitor, controllers, clock: () => now })
  const options = createDavisOptions({ store, router, monitor, workflow })
  cleanups.push(() => { workflow.dispose(); monitor.dispose() })
  const context = (signal = new AbortController().signal): OperationContext => ({ signal, runId: 'workflow-run',
    planId: 'workflow-plan', operationId: 'workflow-operation', expectedRevision: monitor.getRevision() })
  const call = async (name: string, args: Record<string, JSONValue>, signal?: AbortSignal) => {
    validate(CORRESPONDENCE_COMMANDS.find(c => c.name === name)!.inputSchema, args)
    return await options.handlers[name](args, context(signal)) as WorkflowState
  }
  const state = () => workflow.getContext() as WorkflowState | null
  const prepare = (answers: Answer[] = []) => call('analysis.prepare', { method: 'correspondence', answers })
  const binding = () => { const current = state()!; return { requestId: current.requestId, draftRevision: current.draftRevision } }
  return { workflow, monitor, router, controllers, controller, configure, run, call, context, prepare, state, binding, options,
    controllerListeners, routeListeners, enteredRun,
    get published() { return published },
    pageEdit(patch: Partial<CorrespondenceSetup>) { setup = { ...setup, ...patch }; notify() },
    setAvailable(next: boolean) { available = next; notify() },
    setReady(next: boolean) { ready = next; notify() },
    advanceTime(amount: number) { now += amount },
    holdRun() { runGate = deferred(); return runGate },
    respondWith(next: () => CorrespondenceCompleted) { response = next },
    onCommitted(callback: () => void) { afterCommit = callback },
  }
}
const respondentAnswers: Answer[] = [{ questionId: 'rowColumnId', value: 'id-a' }, { questionId: 'columnColumnId', value: 'id-b' }]
const tableAnswers: Answer[] = [{ questionId: 'inputKind', value: 'contingency' }, { questionId: 'rowLabelColumnId', value: 'id-label' },
  { questionId: 'valueColumnIds', value: ['id-x', 'id-y'] }]
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); installDataset() })
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('correspondence intent, questions and bounded answers', () => {
  it('advertises four closed schemas with integer draft bindings and bounded answers', () => {
    expect(CORRESPONDENCE_COMMANDS.map(c => c.name)).toEqual(['analysis.prepare', 'analysis.resume', 'analysis.run', 'analysis.cancel'])
    for (const command of CORRESPONDENCE_COMMANDS) expect(() => checkSchema(command.inputSchema)).not.toThrow()
    const prepare = CORRESPONDENCE_COMMANDS[0].inputSchema, resume = CORRESPONDENCE_COMMANDS[1].inputSchema
    expect(() => validate(prepare, { method: 'pca', answers: [] })).toThrow('SCHEMA_VALIDATION_FAILED')
    expect(() => validate(prepare, { method: 'correspondence', answers: [], run: true })).toThrow('SCHEMA_VALIDATION_FAILED')
    for (const draftRevision of [0, -1, 1.5, '1']) expect(() => validate(resume, { requestId: 'draft', draftRevision, answers: [] })).toThrow('SCHEMA_VALIDATION_FAILED')
    for (const answers of [Array(13).fill({ questionId: 'x', value: true }), [{ questionId: 'x', value: 'a'.repeat(1001) }],
      [{ questionId: 'x', value: Array(101).fill('id') }], [{ questionId: 'x', value: { arbitrary: true } }]])
      expect(() => validate(prepare, { method: 'correspondence', answers })).toThrow('SCHEMA_VALIDATION_FAILED')
  })

  it('opens the normal CA page, discloses current defaults and asks only unresolved targets', async () => {
    installDataset('dataset', true)
    const f = fixture({ missingPolicy: 'include_missing', mapScaling: 'row_principal' })
    expect(f.workflow.getContext()).toBeNull()
    const before = store.getState()
    const draft = await f.prepare()
    expect(draft).toMatchObject({ workflow: 'davis-analysis/1', status: 'needs_input',
      preview: { view: '/models/ca', inputKind: 'respondents', missingPolicy: 'include_missing', mapScaling: 'row_principal',
        weightMode: 'dataset', savedWeightColumnId: 'id-weight', scope: 'active', scopeCount: 4 } })
    expect(draft.questions.map(q => q.id)).toEqual(['rowColumnId', 'columnColumnId'])
    expect(draft.questions[0].options!.map(o => o.value)).toEqual(['id-a', 'id-b', 'id-c'])
    expect(f.router.getPath()).toBe('/models/ca')
    expect(f.run).not.toHaveBeenCalled()
    expect(store.getState()).toBe(before)
    expect(f.options.getContext()).toMatchObject({ pendingAnalysis: { requestId: draft.requestId, draftRevision: draft.draftRevision } })
  })

  it('resumes authoritative questions with stable IDs without choosing the first pair', async () => {
    const f = fixture(), draft = await f.prepare()
    expect(f.controller.inspect().setup).toMatchObject({ rowVar: null, colVar: null })
    expect(draft.questions[0].options).toHaveLength(3)
    const ready = await f.call('analysis.resume', { ...f.binding(), answers: respondentAnswers })
    expect(ready.status).toBe('ready')
    expect(ready).toMatchObject({ run: { command: 'analysis.run' },
      preview: { rowColumnId: 'id-a', columnColumnId: 'id-b' } })
    expect(ready.questions).toEqual([])
    expect(f.controller.inspect().setup).toMatchObject({ rowVar: 'A', colVar: '__proto__' })
    expect(Number.isInteger(ready.draftRevision)).toBe(true)
    expect(ready.draftRevision).toBeGreaterThan(draft.draftRevision)
    expect(() => boundedJSON(ready)).not.toThrow()
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each([
    [{ questionId: 'missingPolicy', value: 'exclude' }],
    [{ questionId: 'independentCounts', value: true }],
    [{ questionId: 'rowColumnId', value: 'A' }],
    [{ questionId: 'rowColumnId', value: 'id-a' }, { questionId: 'columnColumnId', value: 'id-a' }],
    [{ questionId: 'rowColumnId', value: 'id-a' }, { questionId: 'columnColumnId', value: 'id-ma' }],
    [{ questionId: 'rowColumnId', value: 'id-a' }, { questionId: 'rowColumnId', value: 'id-b' }],
  ] as Answer[][])('rejects invalid or unasked answers atomically: %j', async answers => {
    const f = fixture()
    await f.prepare()
    const before = f.state(), setup = f.controller.inspect().setup, redux = store.getState()
    f.configure.mockClear()
    await expect(f.call('analysis.resume', { ...f.binding(), answers })).rejects.toBeDefined()
    expect(f.configure).not.toHaveBeenCalled()
    expect(f.controller.inspect().setup).toEqual(setup)
    expect(store.getState()).toBe(redux)
    expect(f.state()).toEqual(before)
  })

  it('rejects invalid explicit prepare settings before changing controller or Redux values', async () => {
    const f = fixture(), before = store.getState(), setup = f.controller.inspect().setup
    await expect(f.prepare([...respondentAnswers, { questionId: 'missingPolicy', value: 'invented' }])).rejects.toThrow('INVALID_ANALYSIS_ANSWER')
    expect(f.configure).not.toHaveBeenCalled()
    expect(f.controller.inspect().setup).toEqual(setup)
    expect(store.getState()).toBe(before)
  })

  it('requires explicit append for inactive targets and preserves every unrelated active entity', async () => {
    store.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'id-c' }, { kind: 'ma', groupId: 'ma-group' }]))
    const f = fixture(), draft = await f.prepare(respondentAnswers)
    expect(draft.questions.map(q => q.id)).toEqual(['activateColumns'])
    expect(draft.preview.appendColumnIds).toEqual(['id-a', 'id-b'])
    expect(store.getState().globalVariables.activeEntities).toHaveLength(2)
    const ready = await f.call('analysis.resume', { ...f.binding(), answers: [{ questionId: 'activateColumns', value: 'append' }] })
    expect(ready.status).toBe('ready')
    expect(store.getState().globalVariables.activeEntities).toEqual([{ kind: 'column', columnId: 'id-c' },
      { kind: 'ma', groupId: 'ma-group' }, { kind: 'column', columnId: 'id-a' }, { kind: 'column', columnId: 'id-b' }])
  })

  it('asks table semantics, preserves a conflicting saved weight until answered and requires page-only acknowledgement', async () => {
    installDataset('dataset', true)
    const f = fixture(), draft = await f.prepare(tableAnswers)
    expect(draft.questions.map(q => q.id)).toEqual(['cellSemantics', 'weightMode'])
    expect(f.controller.inspect().setup).toMatchObject({ inputKind: 'contingency', weightChoice: 'dataset', ack: false })
    await f.call('analysis.resume', { ...f.binding(), answers: [{ questionId: 'cellSemantics', value: 'frequency' }, { questionId: 'weightMode', value: 'none' }] })
    expect(f.state()!.questions).toEqual([expect.objectContaining({ id: 'independentCounts', type: 'confirmation', requiresPageAction: true })])
    expect(f.state()!.questions[0].options).toBeUndefined()
    await expect(f.call('analysis.resume', { ...f.binding(), answers: [{ questionId: 'independentCounts', value: true }] })).rejects.toThrow()
    expect(f.controller.inspect().setup.ack).toBe(false)
    f.pageEdit({ ack: true })
    expect(f.state()!.status).toBe('ready')
    expect(store.getState().codebook.weightConfig?.weightColumnId).toBe('id-weight')
  })

  it('accepts explicitly known table mass semantics with no independence claim', async () => {
    const f = fixture(), draft = await f.prepare([...tableAnswers, { questionId: 'cellSemantics', value: 'mass' }])
    expect(draft.status).toBe('ready')
    expect(draft.questions).toEqual([])
    expect(f.controller.inspect().setup).toMatchObject({ cellSemantics: 'mass', ack: false })
    expect(draft.preview).toMatchObject({ missingPolicy: 'exclude', cellSemantics: 'mass' })
  })

  it('does not advertise a column identifier that the answer schema cannot accept', async () => {
    const unsupported = column('x'.repeat(257), 'Unsupported identifier')
    store.dispatch(codebookReceived({ datasetId: 'dataset', schemaRevision: 3, columns: [...columns, unsupported] }))
    const f = fixture(), draft = await f.prepare()
    expect(draft.questions.flatMap(question => question.options ?? []).some(option => option.value === unsupported.columnId)).toBe(false)
    expect(draft.questions.flatMap(question => question.options ?? []).every(option => option.value.length <= 256)).toBe(true)
  })

  it('gives an actionable page-only question when no eligible categorical column exists', async () => {
    store.dispatch(codebookReceived({ datasetId: 'dataset', schemaRevision: 3,
      columns: columns.filter(c => c.scaleType === 'ratio' || c.scaleType === 'interval') }))
    const f = fixture(), draft = await f.prepare()
    expect(draft.status).toBe('needs_input')
    expect(draft.questions).toEqual([
      expect.objectContaining({ id: 'rowColumnId', type: 'confirmation', requiresPageAction: true,
        pageAction: { view: '/models/ca', instruction: expect.any(String) } }),
      expect.objectContaining({ id: 'columnColumnId', type: 'confirmation', requiresPageAction: true }),
    ])
    expect(draft.questions.every(q => q.options === undefined && q.minItems === undefined && q.maxItems === undefined)).toBe(true)
    await expect(f.call('analysis.run', f.binding())).rejects.toThrow('ANALYSIS_INPUT_REQUIRED')
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 85])('issues usable table questions for %i numeric choices', async count => {
    const numericColumns = Array.from({ length: count }, (_, i) => column(`numeric-${i}`, `Value ${i}`, { scaleType: 'ratio' }))
    store.dispatch(codebookReceived({ datasetId: 'dataset', schemaRevision: 3,
      columns: [column('id-label', 'row label', { scaleType: 'text' }), ...numericColumns] }))
    store.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'id-label' },
      ...numericColumns.map(c => ({ kind: 'column' as const, columnId: c.columnId }))]))
    const f = fixture(), draft = await f.prepare([{ questionId: 'inputKind', value: 'contingency' }])
    const question = draft.questions.find(q => q.id === 'valueColumnIds')!
    if (count < 2) {
      expect(question).toMatchObject({ type: 'confirmation', requiresPageAction: true })
      expect(question.options).toBeUndefined()
      expect(question.minItems).toBeUndefined()
      expect(question.maxItems).toBeUndefined()
      await expect(f.call('analysis.run', f.binding())).rejects.toThrow('ANALYSIS_INPUT_REQUIRED')
      expect(f.run).not.toHaveBeenCalled()
    } else {
      expect(question).toMatchObject({ type: 'multi', minItems: 2, maxItems: Math.min(80, count) })
      expect(question.options).toHaveLength(Math.min(80, count))
      expect(question.maxItems).toBeLessThanOrEqual(question.options!.length)
      const ready = await f.call('analysis.resume', { ...f.binding(), answers: [
        { questionId: 'rowLabelColumnId', value: 'id-label' },
        { questionId: 'valueColumnIds', value: ['numeric-0', 'numeric-1'] },
        { questionId: 'cellSemantics', value: 'mass' },
      ] })
      expect(ready.status).toBe('ready')
      expect(f.controller.inspect().setup.valueCols).toEqual(['Value 0', 'Value 1'])
    }
    expect(() => boundedJSON(draft, 128 * 1024)).not.toThrow()
  })

  it('omits extension-unsupported stable IDs without truncating or hiding raw hostile names', async () => {
    const excluded = ['x'.repeat(201), '__proto__', 'constructor', 'prototype']
    const supported = 'y'.repeat(200)
    store.dispatch(codebookReceived({ datasetId: 'dataset', schemaRevision: 3,
      columns: [...columns, column(supported, 'Boundary ID'), ...excluded.map((id, i) => column(id, `Unavailable ${i}`))] }))
    const f = fixture(), draft = await f.prepare()
    const values = draft.questions.flatMap(q => q.options ?? []).map(o => o.value)
    expect(values).toContain(supported)
    expect(excluded.every(id => !values.includes(id))).toBe(true)
    expect(draft.preview.columnOptionsTruncated).toBe(true)
    expect(draft.questions[0].options!.find(o => o.value === 'id-b')!.label).toContain('__proto__')
    expect(store.getState().codebook.columns.some(c => c.columnId === excluded[0])).toBe(true)
  })

  it('bounds large Japanese option catalogs and selected descriptors with explicit truncation', async () => {
    const longColumns = Array.from({ length: 85 }, (_, index) => column(`long-${index}`, `項目${index}${'変数'.repeat(100)}`, { label: '日本語の説明'.repeat(100) }))
    longColumns.push(column('x'.repeat(257), '解決できない識別子'))
    store.dispatch(codebookReceived({ datasetId: 'dataset', schemaRevision: 3, columns: longColumns }))
    store.dispatch(activeEntitiesSet(longColumns.map(c => ({ kind: 'column', columnId: c.columnId }))))
    const f = fixture(), draft = await f.prepare()
    expect(draft.questions[0].options).toHaveLength(80)
    expect(draft.questions.flatMap(q => q.options ?? []).every(o => o.label.length <= 96 && o.value.length <= 200)).toBe(true)
    expect(draft.preview).toMatchObject({ columnOptionsTruncated: true, optionLabelsMayBeTruncated: true })
    expect(() => boundedJSON(draft, 256 * 1024)).not.toThrow()
    f.pageEdit({ rowVar: longColumns[0].name, colVar: longColumns[1].name })
    const descriptors = f.state()!.preview.columns as Array<Record<string, JSONValue>>
    expect(descriptors).toHaveLength(2)
    expect(descriptors.every(c => (c.name as string).length <= 64 && (c.label as string).length <= 128 && c.displayTruncated)).toBe(true)
  })

  it('refreshes the integer binding after ordinary page edits and rejects the previous binding', async () => {
    const f = fixture(), draft = await f.prepare(respondentAnswers)
    const old = { requestId: draft.requestId, draftRevision: draft.draftRevision }
    f.pageEdit({ colVar: 'C', mapScaling: 'column_principal' })
    expect(f.state()!.draftRevision).toBeGreaterThan(old.draftRevision)
    expect(Number.isInteger(f.state()!.draftRevision)).toBe(true)
    expect(f.state()!.preview).toMatchObject({ mapScaling: 'column_principal' })
    await expect(f.call('analysis.run', old)).rejects.toThrow('STALE_ANALYSIS_DRAFT')
    expect(f.run).not.toHaveBeenCalled()
  })
})

describe('draft source, cancellation and lifecycle boundaries', () => {
  it.each(['dataset', 'dataset-return', 'data', 'scope', 'membership', 'sampling', 'page-unmount'] as const)('invalidates a prepared draft after %s changes', async kind => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    const old = f.binding()
    if (kind === 'dataset') installDataset('other-dataset')
    if (kind === 'dataset-return') { installDataset('other-dataset'); installDataset('dataset') }
    if (kind === 'data') store.dispatch(datasetValuesUpdated({ datasetId: 'dataset', dataRevision: 8 }))
    if (kind === 'scope') { store.dispatch(observationScopeChanged('all')); store.dispatch(observationScopeChanged('active')) }
    if (kind === 'membership') {
      store.dispatch(observationScopeChanged('selected'))
      store.dispatch(selectionApplied({ rowIds: rows.slice(1, 3), operation: 'replace', label: 'Change' }))
    }
    if (kind === 'sampling') store.dispatch(samplingApplied({ sampleId: 'PRIVATE_SAMPLE', sampledRowIds: rows.slice(0, 2), sampledRowWeights: { [rows[0]]: 2, [rows[1]]: 1 } }))
    if (kind === 'page-unmount') f.setAvailable(false)
    expect(f.state()).toMatchObject({ status: 'invalidated', summary: null, questions: [], preview: {} })
    await expect(f.call('analysis.run', old)).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
  })

  it('discloses only unique sampled scope counts and expires a draft without running it', async () => {
    store.dispatch(samplingApplied({ sampleId: 'PRIVATE_SAMPLE', sampledRowIds: [rows[0], rows[0], rows[1]], sampledRowWeights: { [rows[0]]: 2, [rows[1]]: 1 } }))
    const f = fixture(), draft = await f.prepare(respondentAnswers)
    expect(draft.preview).toMatchObject({ scope: 'sampled', scopeCount: 2 })
    expect(JSON.stringify(draft)).not.toMatch(/PRIVATE_ROW|PRIVATE_SAMPLE|sampledRowWeights/)
    f.advanceTime(15 * 60 * 1000)
    expect(f.state()).toMatchObject({ status: 'invalidated', reason: 'DRAFT_EXPIRED' })
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['abort', 'dispose'] as const)('settles preparation waiting for the controller on %s and removes its subscription', async kind => {
    const f = fixture(), abort = new AbortController()
    f.setAvailable(false)
    const pending = f.call('analysis.prepare', { method: 'correspondence', answers: [] }, abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await vi.waitFor(() => expect(f.controllerListeners.size).toBe(2))
    if (kind === 'abort') abort.abort()
    else f.workflow.dispose()
    await rejected
    expect(f.controllerListeners.size).toBe(kind === 'dispose' ? 0 : 1)
    expect(f.configure).not.toHaveBeenCalled()
    expect(f.state()).toBeNull()
  })

  it('clears every workflow subscription on repeated disposal and prevents new work', async () => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    f.workflow.dispose(); f.workflow.dispose()
    expect(f.controllerListeners.size).toBe(0)
    expect(f.state()).toBeNull()
    await expect(f.prepare()).rejects.toThrow('BRIDGE_DISPOSED')
  })

  it.each(['cancel', 'signal', 'dispose', 'source', 'page-edit', 'route-return'] as const)('prevents pending-run publication after %s', async kind => {
    const f = fixture(), abort = new AbortController()
    await f.prepare(respondentAnswers)
    const gate = f.holdRun()
    const pending = f.call('analysis.run', f.binding(), abort.signal)
    const settled = pending.catch(error => error)
    const options = await f.enteredRun.promise
    if (kind === 'cancel') await f.call('analysis.cancel', f.binding())
    if (kind === 'signal') abort.abort()
    if (kind === 'dispose') f.workflow.dispose()
    if (kind === 'source') store.dispatch(datasetValuesUpdated({ datasetId: 'dataset', dataRevision: 8 }))
    if (kind === 'page-edit') f.pageEdit({ colVar: 'C' })
    if (kind === 'route-return') { f.router.navigate('/table'); f.router.navigate('/models/ca') }
    expect(options.signal?.aborted).toBe(true)
    gate.resolve()
    expect((await settled).code).toBe('CANCELLED')
    expect(f.published).toBeNull()
    expect(f.state()?.summary ?? null).toBeNull()
  })
})

describe('normal-page completion and minimized receipts', () => {
  it('runs only a ready draft, then returns a bounded summary after the controller commits', async () => {
    const f = fixture()
    await f.prepare()
    await expect(f.call('analysis.run', f.binding())).rejects.toThrow('ANALYSIS_INPUT_REQUIRED')
    await f.call('analysis.resume', { ...f.binding(), answers: respondentAnswers })
    const gate = f.holdRun(), submitted = f.binding(), pending = f.call('analysis.run', submitted)
    await f.enteredRun.promise
    expect(f.state()).toMatchObject({ running: true, summary: null })
    expect(f.published).toBeNull()
    gate.resolve()
    const receipt = await pending
    expect(receipt).toMatchObject({ status: 'completed', running: false, resultId: 'normal-ca-result', view: '/models/ca',
      summary: { resultId: 'normal-ca-result', route: '/models/ca', rank: 1, totalInertia: 0.25, fitCount: 3, usedRows: 3 } })
    expect(f.published?.result.resultId).toBe('normal-ca-result')
    expect(f.router.getPath()).toBe('/models/ca')
    const serialized = JSON.stringify(receipt)
    for (const secret of [...rows, 'PRIVATE_', 'activeRowIds', 'inputContextKey', 'scopeKey', 'config', 'details', 'rowCategories', 'coordinates'])
      expect(serialized).not.toContain(secret)
    expect(receipt.summary!.warnings).toEqual([{ code: 'MISSING_EXCLUDED' }])
    expect(() => boundedJSON(receipt)).not.toThrow()
    expect(await f.call('analysis.run', submitted)).toEqual(receipt)
    expect(f.run).toHaveBeenCalledTimes(1)
    expect(await f.call('analysis.cancel', f.binding())).toEqual(receipt)
  })

  it.each(['nonfinite', 'oversize', 'nested-metadata', 'negative-count', 'fractional-count', 'reserved-result-id'] as const)('rejects %s result metadata before normal-page commit', async kind => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    f.respondWith(() => {
      const response = completed()
      if (kind === 'nonfinite') response.result.summary.totalInertia = Infinity
      if (kind === 'oversize') response.result.meta.algorithmVersion = 'x'.repeat(40 * 1024)
      if (kind === 'nested-metadata') (response.result.meta as unknown as Record<string, unknown>).algorithmVersion = { rowIds: rows }
      if (kind === 'negative-count') response.result.meta.fitCount = -1
      if (kind === 'fractional-count') response.result.meta.fitCount = 1.5
      if (kind === 'reserved-result-id') response.result.resultId = 'constructor'
      return response
    })
    await expect(f.call('analysis.run', f.binding())).rejects.toThrow()
    expect(f.published).toBeNull()
    expect(f.state()!.summary).toBeNull()
  })

  it('keeps hostile names as values and rejects structured objects in scalar summary fields', () => {
    const response = completed()
    expect(() => summarizeCorrespondence(response)).not.toThrow()
    for (const field of ['datasetId', 'scope', 'analysisUnit', 'weightApplied', 'weightType', 'algorithmVersion']) {
      const hostile = completed()
      ;(hostile.result.meta as unknown as Record<string, unknown>)[field] = { rowIds: rows }
      expect(() => summarizeCorrespondence(hostile)).toThrow()
    }
  })

  it('rejects impossible count, revision, rank and inertia metadata', () => {
    for (const field of ['dataRevision', 'schemaRevision', 'scopeCount', 'fitCount', 'excludedCount']) {
      for (const invalid of [-1, 1.5, Infinity]) {
        const response = completed()
        ;(response.result.meta as unknown as Record<string, unknown>)[field] = invalid
        expect(() => summarizeCorrespondence(response)).toThrow('INVALID_ANALYSIS_RESULT')
      }
    }
    for (const field of ['rank', 'activeRowCategoryCount', 'activeColumnCategoryCount']) {
      const response = completed()
      ;(response.result.summary as unknown as Record<string, unknown>)[field] = 1.5
      expect(() => summarizeCorrespondence(response)).toThrow('INVALID_ANALYSIS_RESULT')
    }
    for (const field of ['totalInertia', 'tableTotal']) {
      const response = completed()
      ;(response.result.summary as unknown as Record<string, unknown>)[field] = -1
      expect(() => summarizeCorrespondence(response)).toThrow('INVALID_ANALYSIS_RESULT')
    }
  })

  it('invalidates completed snapshot context when the source changes', async () => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    await f.call('analysis.run', f.binding())
    store.dispatch(datasetValuesUpdated({ datasetId: 'dataset', dataRevision: 8 }))
    expect(f.state()).toMatchObject({ status: 'invalidated', summary: null, preview: {} })
    expect(JSON.stringify(f.options.getContext())).not.toContain('normal-ca-result')
  })

  it('invalidates an old completed reference after a manual run replaces the same setup result', async () => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    const binding = f.binding(), setup = f.controller.inspect().setup
    await f.call('analysis.run', binding)
    f.respondWith(() => completed('manual-replacement'))
    await f.controller.run()
    expect(f.controller.inspect().setup).toEqual(setup)
    expect(f.published?.result.resultId).toBe('manual-replacement')
    expect(f.state()).toMatchObject({ status: 'invalidated', reason: 'ANALYSIS_RESULT_REPLACED', summary: null })
    await expect(f.call('analysis.run', binding)).rejects.toThrow()
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it('reports a real commit honestly if cancellation arrives after the controller committed', async () => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    const adapter = createPageAdapter(f.options)
    cleanups.push(adapter.dispose)
    const snapshot = await adapter.snapshot() as { snapshotId: string; schemaHash: string; revision: string }
    const envelope = { snapshotId: snapshot.snapshotId, schemaHash: snapshot.schemaHash, revision: snapshot.revision,
      planId: 'committed_plan_identifier', runId: 'committed_run_identifier', expiresAt: Date.now() + 10000,
      plan: { kind: 'commands', message: 'Run the prepared CA', commands: [{ op: 'analysis.run', args: f.binding() }] } }
    f.onCommitted(() => adapter.cancel(envelope.runId))
    const receipt = await adapter.execute(envelope) as { status: string; results: Array<{ status: string; result: WorkflowState }>; error: { code: string } }
    expect(receipt.status).toBe('partial')
    expect(receipt.error.code).toBe('CANCELLED')
    expect(receipt.results).toHaveLength(1)
    expect(receipt.results[0]).toMatchObject({ status: 'completed', result: { status: 'completed' } })
    expect(f.published?.result.resultId).toBe('normal-ca-result')
  })

  it('does not expose an old-source summary if the source changes just after commit', async () => {
    const f = fixture()
    await f.prepare(respondentAnswers)
    f.onCommitted(() => store.dispatch(datasetValuesUpdated({ datasetId: 'dataset', dataRevision: 8 })))
    const receipt = await f.call('analysis.run', f.binding())
    expect(receipt).toMatchObject({ status: 'invalidated', committed: true, summary: null })
    expect(f.published).not.toBeNull()
    expect(f.state()).toMatchObject({ status: 'invalidated', summary: null })
  })
})
