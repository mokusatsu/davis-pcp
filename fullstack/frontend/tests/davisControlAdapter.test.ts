import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  store, datasetLoaded, datasetValuesUpdated, variablesInitialized, activeEntitiesSet,
  targetVariableSet, weightColumnSet, selectionApplied, selectionCleared, hovered, observationScopeChanged,
  samplingApplied, pcpStateChanged, rangeSelectionApplied,
} from '../src/app/store'
import {
  codebookReceived, codebookReset, draftColumnUpdated, fetchCodebookThunk, licenseMetadataReceived,
  saveCodebookThunk, saveWeightConfigThunk,
} from '../src/features/dataset/codebookSlice'
import type { CodebookColumn } from '../src/api/client'
import {
  DAVIS_ROUTES, DAVIS_FOUNDATION_COMMANDS, createDavisOptions, createDavisRevisionMonitor,
  assertDavisCanonicalState, type DavisRevisionMonitor, type DavisWorkflowPort,
} from '../src/integrations/siwc/davisAdapter'
import type { JSONValue, OperationContext } from '../src/integrations/siwc/sdk/page-bridge.js'
import { boundedJSON } from '../src/integrations/siwc/extension/core/common.js'
import { checkSchema, validate } from '../src/integrations/siwc/extension/core/schema.js'

const rows = ['private-row-1', 'private-row-2', 'private-row-3', 'private-row-4']
function column(columnId: string, name: string, patch: Partial<CodebookColumn> = {}): CodebookColumn {
  return { columnId, name, label: `Label ${name}`, role: 'question', scaleType: 'nominal',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null, ...patch }
}
const columns = [column('id-a', 'raw A'), column('id-b', '__proto__'),
  column('id-value', 'value', { scaleType: 'ratio' }), column('id-weight', 'weight', { role: 'weight', scaleType: 'ratio' }),
  column('id-ma-1', 'option 1', { multiResponseGroup: 'ma-group' }),
  column('id-ma-2', 'option 2', { multiResponseGroup: 'ma-group' })]
const groups = [{ groupId: 'ma-group', label: 'Multiple answers', selectedCodes: ['1'], unselectedCodes: ['0'],
  allUnselectedMeaning: 'valid' as const, maxSelections: null, optionOrder: ['id-ma-1', 'id-ma-2'] }]
function installDataset(datasetId = 'dataset-1') {
  store.dispatch(datasetLoaded({ datasetId, name: 'Survey', rowIds: rows, dataRevision: 7 }))
  store.dispatch(variablesInitialized({ datasetId, variables: columns.map(item => item.name),
    meta: Object.fromEntries(columns.map(item => [item.name, { name: item.name, columnId: item.columnId,
      semanticType: 'nominal', physicalType: 'string', missingCount: 0, isTargetCandidate: true }])) }))
  store.dispatch(codebookReceived({ datasetId, schemaRevision: 3, columns, multiResponseGroups: groups,
    weightConfig: { weightColumnId: 'id-weight', weightType: 'survey' } }))
  store.dispatch(pcpStateChanged({ orientation: 'horizontal', showContext: true, lineOpacity: 0.2 }))
}
function makeRouter() {
  let path = '/pcp'
  const listeners = new Set<() => void>()
  const change = (next: string) => { path = next; for (const listener of [...listeners]) listener() }
  return { getPath: () => path, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  }, navigate: vi.fn(change), change, listeners }
}
const monitors: DavisRevisionMonitor[] = []
function setup(workflow?: DavisWorkflowPort) {
  const router = makeRouter(), monitor = createDavisRevisionMonitor({ store, router })
  monitors.push(monitor)
  const options = createDavisOptions({ store, router, monitor, workflow })
  const context = (expectedRevision = monitor.getRevision(), signal = new AbortController().signal): OperationContext => ({
    signal, expectedRevision, runId: 'run', planId: 'plan', operationId: 'operation',
  })
  const call = (name: string, args: Record<string, JSONValue> = {}, operationContext = context()) =>
    options.handlers[name](args, operationContext)
  return { router, monitor, options, call, context }
}
beforeEach(() => installDataset())
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.dispose(); vi.restoreAllMocks() })

describe('DAVIS foundation commands against the maintained Redux store', () => {
  it('advertises only the eight foundation operations and 31 real navigation destinations', () => {
    const { options } = setup()
    expect((options.commands as typeof DAVIS_FOUNDATION_COMMANDS).map(command => command.name)).toEqual([
      'state.inspect', 'view.navigate', 'variables.select', 'variables.setTarget',
      'selection.clear', 'selection.focus', 'selection.reset', 'pcp.configure',
    ])
    expect(DAVIS_ROUTES).toHaveLength(31)
    expect(new Set(DAVIS_ROUTES).size).toBe(31)
    for (const command of DAVIS_FOUNDATION_COMMANDS) expect(() => checkSchema(command.inputSchema)).not.toThrow()
    expect(options.handlers['analysis.pca']).toBeUndefined()
    expect(options.getContext()).toHaveProperty('pendingAnalysis', null)
    expect(options.getContext()).not.toHaveProperty('analysis')
  })

  it('selects stable ordinary IDs without modifying canonical roles, scales, values or weight', () => {
    const { call } = setup(), before = store.getState()
    call('variables.select', { columnIds: ['id-b', 'id-value'] })
    expect(store.getState().globalVariables.activeEntities).toEqual([
      { kind: 'column', columnId: 'id-b' }, { kind: 'column', columnId: 'id-value' },
    ])
    expect(store.getState().selection).toBe(before.selection)
    expect(store.getState().codebook).toBe(before.codebook)
    expect(store.getState().globalVariables.weightColumnId).toBe(before.globalVariables.weightColumnId)
    expect(() => call('variables.select', { columnIds: ['id-a', 'id-a'] })).toThrow('DUPLICATE_COLUMN')
    expect(() => call('variables.select', { columnIds: ['raw A'] })).toThrow('UNKNOWN_COLUMN')
    expect(() => call('variables.select', { columnIds: ['id-ma-1'] })).toThrow('ORDINARY_COLUMN_REQUIRED')
    expect(() => call('variables.select', { columnIds: ['ma-group'] })).toThrow('UNKNOWN_COLUMN')
    expect(() => call('variables.select', { columnIds: [] })).toThrow('INVALID_COLUMNS')
  })

  it('translates target IDs to raw names and resolves snapshots back to stable IDs, including hostile names', () => {
    const { call, options } = setup()
    call('variables.setTarget', { columnId: 'id-b' })
    expect(store.getState().globalVariables.targetVariableId).toBe('__proto__')
    expect(options.getContext()).toMatchObject({ targetVariable: 'id-b' })
    expect(() => boundedJSON(options.getContext())).not.toThrow()
    expect(() => call('variables.setTarget', { columnId: 'id-ma-1' })).toThrow('ORDINARY_COLUMN_REQUIRED')
    call('variables.setTarget', { columnId: null })
    expect(store.getState().globalVariables.targetVariableId).toBeNull()
    expect(options.getContext()).toMatchObject({ targetVariable: null })
  })

  it('uses canonical columns while leaving unsaved draft role and scale edits untouched', () => {
    const { call } = setup()
    store.dispatch(draftColumnUpdated({ columnId: 'id-a', patch: { role: 'other', scaleType: 'text' } }))
    call('variables.select', { columnIds: ['id-a'] })
    expect(store.getState().codebook.columns[0]).toMatchObject({ role: 'question', scaleType: 'nominal' })
    expect(store.getState().codebook.draftColumns[0]).toMatchObject({ role: 'other', scaleType: 'text' })
  })

  it('blocks variable and target commands during dataset installation and unsettled codebook states', () => {
    const { call, options } = setup()
    store.dispatch(datasetLoaded({ datasetId: 'dataset-2', name: 'Switching', rowIds: rows }))
    expect(() => call('variables.select', { columnIds: ['id-a'] })).toThrow('DATASET_NOT_READY')
    expect(() => call('variables.setTarget', { columnId: null })).toThrow('DATASET_NOT_READY')
    expect(options.getContext()).toMatchObject({ dataset: { canonicalReady: false }, columns: [], targetVariable: null })
    store.dispatch(codebookReceived({ datasetId: 'dataset-2', schemaRevision: 3, columns }))
    expect(() => call('variables.select', { columnIds: ['id-a'] })).toThrow('DATASET_NOT_READY')
    installDataset()
    store.dispatch(fetchCodebookThunk.pending('pending-read', 'dataset-1'))
    expect(() => call('variables.select', { columnIds: ['id-a'] })).toThrow('CODEBOOK_NOT_READY')
    installDataset()
    store.dispatch(saveCodebookThunk.pending('pending-save', undefined))
    expect(() => call('variables.setTarget', { columnId: 'id-a' })).toThrow('CODEBOOK_NOT_READY')
    installDataset()
    store.dispatch(saveWeightConfigThunk.pending('pending-weight', { weightConfig: null }, { dataRevision: 7 }))
    expect(() => call('variables.select', { columnIds: ['id-a'] })).toThrow('CODEBOOK_NOT_READY')
    installDataset()
    store.dispatch(codebookReceived({ datasetId: 'dataset-1', schemaRevision: 3, columns: [] }))
    expect(() => call('variables.select', { columnIds: ['id-a'] })).toThrow('CODEBOOK_NOT_READY')
    store.dispatch(codebookReset())
    expect(() => call('variables.setTarget', { columnId: null })).toThrow('DATASET_NOT_READY')
    expect(() => assertDavisCanonicalState({ ...store.getState(),
      selection: { ...store.getState().selection, datasetId: null } })).toThrow('NO_DATASET')
  })

  it('rejects duplicate canonical IDs and ambiguous raw names before mutating target state', () => {
    const { call } = setup()
    store.dispatch(codebookReceived({ datasetId: 'dataset-1', schemaRevision: 3, columns: [columns[0], columns[0]] }))
    expect(() => call('variables.setTarget', { columnId: 'id-a' })).toThrow('AMBIGUOUS_CODEBOOK')
    store.dispatch(codebookReceived({ datasetId: 'dataset-1', schemaRevision: 3,
      columns: [columns[0], { ...columns[1], name: columns[0].name }] }))
    expect(() => call('variables.select', { columnIds: ['id-a'] })).toThrow('AMBIGUOUS_CODEBOOK')
  })

  it('keeps focus, highlight clearing and effective observation scope distinct', () => {
    const { call } = setup()
    expect(() => call('selection.focus')).toThrow('NO_SELECTED_ROWS')
    store.dispatch(selectionApplied({ rowIds: rows.slice(0, 2), operation: 'replace', label: 'Choose' }))
    store.dispatch(observationScopeChanged('all'))
    expect(call('selection.focus')).toEqual({ activeRowCount: 2, selectedRowCount: 2,
      effectiveScope: 'all', effectiveRowCount: 4 })
    expect(store.getState().selection.activeRowIds).toEqual(rows.slice(0, 2))
    expect(call('selection.clear')).toEqual({ activeRowCount: 2, selectedRowCount: 0,
      effectiveScope: 'all', effectiveRowCount: 4 })
    store.dispatch(samplingApplied({ sampledRowIds: [rows[3]], sampledRowWeights: { [rows[3]]: 7 }, sampleId: 'sample-1' }))
    expect(call('selection.reset')).toEqual({ activeRowCount: 4, selectedRowCount: 0,
      effectiveScope: 'active', effectiveRowCount: 4 })
    expect(store.getState().globalObservations.sampling.enabled).toBe(false)
    expect(store.getState().globalObservations.sampling.sampledRowIds).toEqual([])
  })

  it('exports only metadata and unique scope counts, never row IDs, sample weights or model scores', () => {
    const { call, options } = setup()
    store.dispatch(samplingApplied({ sampledRowIds: [rows[0], rows[0], rows[1]],
      sampledRowWeights: { [rows[0]]: 2, [rows[1]]: 1 }, sampleId: 'private-sample-token' }))
    const snapshot = call('state.inspect')
    expect(snapshot).toMatchObject({ dataset: { rowCount: 4, effectiveRowCount: 2, effectiveScope: 'sampled' },
      weight: { savedColumnId: 'id-weight', savedType: 'survey' } })
    const serialized = JSON.stringify(options.getContext())
    for (const forbidden of [...rows, 'sampledRowWeights', 'private-sample-token', 'scores', 'valueLabels'])
      expect(serialized).not.toContain(forbidden)
    expect(() => boundedJSON(snapshot)).not.toThrow()
  })

  it('bounds large metadata catalogs without truncating a stable identifier into a different one', () => {
    const { options } = setup()
    const manyColumns = Array.from({ length: 205 }, (_, index) => column(`stable-${index}`,
      `変数${index}${'名'.repeat(300)}`, { label: '説明'.repeat(400) }))
    manyColumns.push(column('x'.repeat(257), 'unsupported-long-id'))
    store.dispatch(codebookReceived({ datasetId: 'dataset-1', schemaRevision: 3, columns: manyColumns }))
    store.dispatch(activeEntitiesSet(manyColumns.map(item => ({ kind: 'column', columnId: item.columnId }))))
    const context = options.getContext() as Record<string, JSONValue>
    expect(context.columnCount).toBe(206)
    expect(context.columnsTruncated).toBe(true)
    expect(context.columns).toHaveLength(200)
    expect(context.activeEntities).toHaveLength(200)
    expect(context.activeEntitiesTruncated).toBe(true)
    expect((context.columns as Array<Record<string, JSONValue>>)[0]).toMatchObject({ columnId: 'stable-0', displayTruncated: true })
    expect(JSON.stringify(context)).not.toContain('x'.repeat(257))
    expect(() => boundedJSON(context)).not.toThrow()
  })

  it('keeps column argument cardinality and identifier bounds closed at the protocol boundary', () => {
    const selectSchema = DAVIS_FOUNDATION_COMMANDS.find(command => command.name === 'variables.select')!.inputSchema
    const targetSchema = DAVIS_FOUNDATION_COMMANDS.find(command => command.name === 'variables.setTarget')!.inputSchema
    expect(() => validate(selectSchema, { columnIds: [] })).toThrow('SCHEMA_VALIDATION_FAILED')
    expect(() => validate(selectSchema, { columnIds: Array(101).fill('id-a') })).toThrow('SCHEMA_VALIDATION_FAILED')
    expect(() => validate(selectSchema, { columnIds: ['id-a'], expandMa: true })).toThrow('SCHEMA_VALIDATION_FAILED')
    expect(() => validate(targetSchema, { columnId: 'x'.repeat(257) })).toThrow('SCHEMA_VALIDATION_FAILED')
    expect(() => validate(targetSchema, { columnId: null })).not.toThrow()
  })

  it('restricts navigation and PCP settings through closed schemas and defensive handler validation', async () => {
    const { call, router } = setup()
    await call('view.navigate', { view: 'models/ca' })
    expect(router.navigate).toHaveBeenCalledWith('/models/ca')
    for (const view of ['https://example.com', '/models/ca', '../table', 'models/ca?run=true'])
      await expect(call('view.navigate', { view })).rejects.toThrow('INVALID_VIEW')
    expect(router.navigate).toHaveBeenCalledTimes(1)
    expect(call('pcp.configure', { orientation: 'vertical', showContext: false, lineOpacity: 0 })).toEqual({
      orientation: 'vertical', showContext: false, lineOpacity: 0,
    })
    expect(store.getState().pcp).toMatchObject({ orientation: 'vertical', showContext: false, lineOpacity: 0 })
    for (const lineOpacity of [-1, 1.01, Infinity, NaN])
      expect(() => call('pcp.configure', { orientation: 'horizontal', showContext: true, lineOpacity })).toThrow('INVALID_LINE_OPACITY')
    expect(() => call('pcp.configure', { orientation: 'diagonal', showContext: true, lineOpacity: 0.5 })).toThrow('INVALID_ORIENTATION')
    const schema = DAVIS_FOUNDATION_COMMANDS.find(command => command.name === 'pcp.configure')!.inputSchema
    expect(() => validate(schema, { orientation: 'horizontal', showContext: true, lineOpacity: 1, colorBy: 'private' })).toThrow()
    expect(() => validate(schema, { orientation: 'horizontal', lineOpacity: 1 })).toThrow()
  })
})

describe('synchronous DAVIS generation and internal mutation guards', () => {
  it('observes every A → B → A state and router transition without waiting for a digest', () => {
    const { monitor, router } = setup(), first = monitor.getRevision(), firstAnalysis = monitor.getAnalysisRevision()
    const notices = vi.fn(); monitor.subscribe(notices)
    store.dispatch(observationScopeChanged('selected'))
    const middle = monitor.getRevision()
    store.dispatch(observationScopeChanged('active'))
    expect(new Set([first, middle, monitor.getRevision()]).size).toBe(3)
    expect(monitor.getAnalysisRevision()).not.toBe(firstAnalysis)
    const analysis = monitor.getAnalysisRevision(), beforeRoute = monitor.getRevision()
    router.change('/models/ca'); const onCa = monitor.getRevision(); router.change('/pcp')
    expect(new Set([beforeRoute, onCa, monitor.getRevision()]).size).toBe(3)
    expect(monitor.getAnalysisRevision()).toBe(analysis)
    expect(notices).toHaveBeenCalledTimes(4)
    expect(typeof monitor.getRevision()).toBe('string')
  })

  it('ignores unrelated asynchronous acknowledgments, hover and license/editor activity', async () => {
    const { monitor } = setup(), revision = monitor.getRevision(), analysis = monitor.getAnalysisRevision()
    await store.dispatch(async dispatch => {
      await Promise.resolve()
      dispatch(hovered(rows[0]))
      dispatch(licenseMetadataReceived({ datasetId: 'dataset-1', licenseText: 'Attribution', licenseRevision: 2 }))
      dispatch(draftColumnUpdated({ columnId: 'id-a', patch: { label: 'Unsaved label' } }))
      dispatch(fetchCodebookThunk.fulfilled({ datasetId: 'dataset-1', schemaRevision: 3, columns }, 'unrelated', 'dataset-1'))
    })
    expect(monitor.getRevision()).toBe(revision)
    expect(monitor.getAnalysisRevision()).toBe(analysis)
  })

  it('revises transport for normal variable/target/weight and PCP edits without invalidating analysis source', () => {
    const { monitor } = setup(), analysis = monitor.getAnalysisRevision()
    for (const action of [activeEntitiesSet([{ kind: 'column', columnId: 'id-a' }]),
      targetVariableSet('raw A'), weightColumnSet({ columnId: 'id-weight', datasetId: 'dataset-1' }),
      pcpStateChanged({ orientation: 'vertical' })]) {
      const previous = monitor.getRevision()
      store.dispatch(action)
      expect(monitor.getRevision()).not.toBe(previous)
      expect(monitor.getAnalysisRevision()).toBe(analysis)
    }
    const revision = monitor.getRevision(); monitor.bump()
    expect(monitor.getRevision()).not.toBe(revision)
    expect(monitor.getAnalysisRevision()).toBe(analysis)
  })

  it('binds canonical data, schema, saved weight, readiness and dataset reinstalls', () => {
    const { monitor } = setup()
    const changes = [
      () => store.dispatch(datasetValuesUpdated({ datasetId: 'dataset-1', dataRevision: 8 })),
      () => store.dispatch(codebookReceived({ datasetId: 'dataset-1', schemaRevision: 4, columns })),
      () => store.dispatch(codebookReceived({ datasetId: 'dataset-1', schemaRevision: 4, columns,
        weightConfig: { weightColumnId: 'id-weight', weightType: 'frequency' } })),
      () => store.dispatch(fetchCodebookThunk.pending('read', 'dataset-1')),
      () => installDataset('dataset-2'), () => installDataset('dataset-1'),
    ]
    for (const change of changes) {
      const revision = monitor.getRevision(), analysis = monitor.getAnalysisRevision()
      change()
      expect(monitor.getRevision()).not.toBe(revision)
      expect(monitor.getAnalysisRevision()).not.toBe(analysis)
    }
  })

  it('invalidates equal-count effective membership and sampling multiplicity or identity changes', () => {
    const { monitor } = setup()
    store.dispatch(observationScopeChanged('selected'))
    store.dispatch(selectionApplied({ rowIds: rows.slice(0, 2), operation: 'replace', label: 'First' }))
    let revision = monitor.getAnalysisRevision()
    store.dispatch(selectionApplied({ rowIds: rows.slice(2), operation: 'replace', label: 'Second' }))
    expect(monitor.getAnalysisRevision()).not.toBe(revision)
    store.dispatch(samplingApplied({ sampledRowIds: rows.slice(0, 2), sampledRowWeights: { [rows[0]]: 2, [rows[1]]: 1 }, sampleId: 's1' }))
    revision = monitor.getAnalysisRevision()
    store.dispatch(samplingApplied({ sampledRowIds: rows.slice(0, 2), sampledRowWeights: { [rows[0]]: 1, [rows[1]]: 2 }, sampleId: 's1' }))
    expect(monitor.getAnalysisRevision()).not.toBe(revision)
    revision = monitor.getAnalysisRevision()
    store.dispatch(samplingApplied({ sampledRowIds: rows.slice(0, 2), sampledRowWeights: { [rows[0]]: 1, [rows[1]]: 2 }, sampleId: 's2' }))
    expect(monitor.getAnalysisRevision()).not.toBe(revision)
    store.dispatch(observationScopeChanged('active'))
    revision = monitor.getAnalysisRevision()
    store.dispatch(selectionCleared())
    expect(monitor.getAnalysisRevision()).toBe(revision)
    store.dispatch(rangeSelectionApplied({ from: 1, to: 2, rowIds: rows.slice(0, 2) }))
    expect(monitor.getAnalysisRevision()).not.toBe(revision)
  })

  it('rejects stale and aborted mutations synchronously and tears down all source subscriptions', () => {
    const { call, monitor, router, context } = setup(), stale = context(), dispatch = vi.spyOn(store, 'dispatch')
    store.dispatch(observationScopeChanged('all')); store.dispatch(observationScopeChanged('active'))
    dispatch.mockClear()
    expect(() => call('variables.select', { columnIds: ['id-a'] }, stale)).toThrow('STALE_STATE')
    expect(dispatch).not.toHaveBeenCalled()
    const abort = new AbortController(); abort.abort()
    expect(() => call('selection.reset', {}, context(monitor.getRevision(), abort.signal))).toThrow('CANCELLED')
    expect(dispatch).not.toHaveBeenCalled()
    const revision = monitor.getRevision(), listener = vi.fn(); monitor.subscribe(listener)
    monitor.dispose(); monitor.dispose()
    expect(router.listeners.size).toBe(0)
    router.change('/table'); store.dispatch(observationScopeChanged('all'))
    expect(monitor.getRevision()).toBe(revision)
    expect(listener).not.toHaveBeenCalled()
    expect(() => call('selection.clear', {}, context(revision))).toThrow('BRIDGE_DISPOSED')
    expect(() => monitor.bump()).toThrow('BRIDGE_DISPOSED')
  })

  it('injects only the approved typed workflow commands and protects their entry', () => {
    const run = vi.fn(() => ({ workflow: 'davis-analysis/1', status: 'ready' }))
    const workflow: DavisWorkflowPort = {
      commands: [{ name: 'analysis.prepare', description: 'Prepare CA', effect: 'write',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      handlers: { 'analysis.prepare': run }, getContext: () => ({ requestId: 'request', status: 'needs_input' }),
    }
    const { call, options, monitor, context } = setup(workflow)
    const snapshotContext = options.getContext() as Record<string, JSONValue>
    expect(snapshotContext.pendingAnalysis).toEqual({ requestId: 'request', status: 'needs_input' })
    expect(snapshotContext.analysis).toEqual({ workflow: 'davis-analysis/1', availableMethods: ['correspondence'] })
    const emptyWorkflow = setup({ ...workflow, getContext: () => null })
    expect(emptyWorkflow.options.getContext()).toMatchObject({ pendingAnalysis: null,
      analysis: { workflow: 'davis-analysis/1', availableMethods: ['correspondence'] } })
    call('analysis.prepare')
    expect(run).toHaveBeenCalledOnce()
    const stale = context(); monitor.bump()
    expect(() => call('analysis.prepare', {}, stale)).toThrow('STALE_STATE')
    expect(run).toHaveBeenCalledOnce()
    const { router } = setup()
    expect(() => createDavisOptions({ store, router, monitor, workflow: { ...workflow,
      commands: [{ ...workflow.commands[0], name: 'analysis.pca' }] } })).toThrow('INVALID_WORKFLOW_COMMAND')
  })
})
