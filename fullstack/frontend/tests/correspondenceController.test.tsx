import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import {
  store, selectionReducer, globalVariablesSlice, globalObservationsSlice, datasetLoaded,
  datasetValuesUpdated, selectionApplied, observationScopeChanged, hovered, activeEntitiesSet,
} from '../src/app/store'
import { codebookSlice, codebookReceived } from '../src/features/dataset/codebookSlice'
import CorrespondenceAnalysisPage from '../src/features/models/CorrespondenceAnalysisPage'
import { getCaController, subscribeCaController, waitForCaController } from '../src/features/models/caControllerBridge'
import type { CorrespondenceController } from '../src/features/models/caControllerBridge'
import type { CodebookColumn } from '../src/api/client'
import type { CAResponse } from '../src/features/models/caTypes'
import * as ca from '../src/features/models/caApi'
import * as analysisScope from '../src/features/selection/analysisScope'
import { createCorrespondenceWorkflow } from '../src/integrations/siwc/correspondenceWorkflow'
import { createDavisRevisionMonitor } from '../src/integrations/siwc/davisAdapter'
import type { JSONValue, OperationContext } from '../src/integrations/siwc/sdk/page-bridge.js'

function SelectInput(p: any) {
  return <select id={p.id} aria-label={p['aria-label']} multiple={p.mode === 'multiple'} disabled={p.disabled}
    value={p.value ?? (p.mode === 'multiple' ? [] : '')}
    onChange={e => p.onChange(p.mode === 'multiple' ? [...e.target.selectedOptions].map(o => o.value) : e.target.value)}>
    {p.mode !== 'multiple' && <option value="">選択</option>}
    {p.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
}
vi.mock('../src/features/common/ColumnSelect', () => ({ default: SelectInput }))
vi.mock('antd', async original => ({ ...await original<any>(), Select: SelectInput }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('../src/features/models/caFigure', () => ({ default: ({ scaling, onToggle }: any) =>
  <div><output data-testid="normal-ca-map">{scaling}</output><button onClick={() => onToggle('row-category')}>選択カテゴリ</button></div> }))
vi.mock('../src/features/models/caTables', () => ({ EigenvalueTable: () => <div>通常の固有値表</div>, CategoryTable: () => null }))
vi.mock('../src/features/models/useAnalysisResultLifecycle', () => ({
  useAnalysisResultLifecycle: () => ({ liveRevisions: null, linkedCategoryIds: new Set() }),
}))

const columns = [
  { columnId: 'id-a', name: 'A', scaleType: 'nominal' },
  { columnId: 'id-b', name: 'B', scaleType: 'ordinal' },
  { columnId: 'id-c', name: 'C', scaleType: 'nominal' },
  { columnId: 'id-label', name: 'label', scaleType: 'text' },
  { columnId: 'id-x', name: 'x', scaleType: 'ratio' },
  { columnId: 'id-y', name: 'y', scaleType: 'interval' },
  { columnId: 'id-z', name: 'z', scaleType: 'ratio' },
].map(c => ({ ...c, label: c.name, role: 'question', multiResponseGroup: null,
  valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false })) as CodebookColumn[]

function result(resultId = 'ca-result', overrides: Partial<CAResponse['meta']> = {}): CAResponse {
  return { status: 'success', resultId, method: 'ca', config: { input: { kind: 'respondents' } },
    meta: { datasetId: 'd', dataRevision: 1, schemaRevision: 1, resultState: 'current', scope: 'active',
      scopeCount: 3, fitCount: 3, effectiveN: 3, excludedCount: 0, exclusionCounts: {}, analysisUnit: 'respondent_row',
      weightApplied: false, weightType: null, weightColumn: null, algorithmVersion: 'test', warnings: [], ...overrides },
    capabilities: { selectionKinds: ['categories'], exportTables: ['manifest', 'eigenvalues', 'categories', 'table'] },
    summary: { rank: 1, totalInertia: 1, eigenvalues: [1], inertiaRatio: [1], cumulativeInertiaRatio: [1],
      discardedNumericalInertia: 0, tableTotal: 3, activeRowCategoryCount: 2, activeColumnCategoryCount: 2,
      pearson: { status: 'not_applicable', reason: 'test', statistic: null, df: null, pValue: null,
        smallExpectedCellsLt1: null, smallExpectedCellsLt5: null, fractionExpectedLt5: null } },
    details: { rowCategories: [], columnCategories: [], omittedCategories: [], table: [[1, 0], [0, 2]],
      physicalTable: null, tableRowCategoryIds: [], tableColumnCategoryIds: [], mapScaling: 'symmetric' } }
}
function mount(strict = false) {
  const base = store.getState()
  const rows = ['r1', 'r2', 'r3']
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer,
    globalVariables: globalVariablesSlice.reducer, globalObservations: globalObservationsSlice.reducer,
    pcp: (s = base.pcp) => s, provenance: (s = base.provenance) => s },
  preloadedState: { ...base,
    selection: { ...base.selection, datasetId: 'd', datasetName: 'Dataset', dataRevision: 1,
      allRowIds: rows, activeRowIds: rows, activeRowIdSet: new Set(rows) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns, isLoading: false },
    globalVariables: { ...base.globalVariables, datasetId: 'd', activeEntities: null },
  }, middleware: get => get({ serializableCheck: false }) })
  const page = <Provider store={local}><CorrespondenceAnalysisPage /></Provider>
  return { local, ...render(strict ? <StrictMode>{page}</StrictMode> : page) }
}
function controller(): CorrespondenceController {
  const current = getCaController()
  expect(current).not.toBeNull()
  return current!
}
function configureRespondents(port = controller()) {
  act(() => { port.configure({ inputKind: 'respondents', rowVar: 'A', colVar: 'B' }) })
  return port
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { vi.spyOn(ca, 'runCa').mockResolvedValue(result()) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); expect(getCaController()).toBeNull() })

it('reuses the captured source across hover/editor noise and repeated inspection, but refreshes real analysis inputs', () => {
  const buildScope = vi.spyOn(analysisScope, 'createScopeSnapshot')
  const { local } = mount(), port = configureRespondents()
  const initialKey = port.inspect().inputContextKey
  buildScope.mockClear()
  act(() => {
    for (let i = 0; i < 20; i++) {
      local.dispatch(hovered(i % 2 ? 'r1' : 'r2'))
      local.dispatch(codebookSlice.actions.filterChanged({ keyword: `editor-filter-${i}` }))
      port.inspect(); port.inspect()
    }
  })
  expect(buildScope).not.toHaveBeenCalled()
  expect(port.inspect().inputContextKey).toBe(initialKey)
  act(() => { local.dispatch(observationScopeChanged('selected')); port.inspect(); port.inspect() })
  expect(buildScope).toHaveBeenCalledTimes(1)
  expect(port.inspect().scopeKey).toContain('selected')
  buildScope.mockClear()
  act(() => { local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 })); port.inspect(); port.inspect() })
  expect(buildScope).toHaveBeenCalledTimes(1)
  expect(port.inspect().dataRevision).toBe(2)
  buildScope.mockClear()
  act(() => { local.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'id-a' }])); port.inspect(); port.inspect() })
  expect(buildScope).toHaveBeenCalledTimes(1)
  expect(port.inspect().canRun).toBe(false)
})

it('configures the real page and returns only after its normal completed result is rendered', async () => {
  mount()
  const port = configureRespondents()
  expect(port.inspect()).toMatchObject({ ready: true, canRun: true, datasetId: 'd', dataRevision: 1, schemaRevision: 1 })
  expect(screen.getByLabelText('CAの行変数')).toHaveValue('A')
  expect(screen.getByLabelText('CAの列変数')).toHaveValue('B')
  await act(async () => {
    const receipt = await port.run({ beforeCommit: () => true })
    expect(receipt.result.resultId).toBe('ca-result')
    expect(port.inspect().completed).toBe(receipt)
    expect(screen.getByTestId('normal-ca-map')).toBeVisible()
    expect(screen.getByText('通常の固有値表')).toBeVisible()
  })
  expect(screen.getByRole('button', { name: '固有値CSV' })).toBeVisible()
  expect(screen.getByRole('button', { name: '設定JSON' })).toBeVisible()
  expect(ca.runCa).toHaveBeenCalledWith(expect.objectContaining({ scope: 'active', activeRowIds: ['r1', 'r2', 'r3'],
    weightMode: 'dataset', missingPolicy: 'exclude' }), { kind: 'respondents', rowVariable: 'A', columnVariable: 'B' }, 'symmetric')
})

it('completes the real prepare → questions → stable-ID answers → run → normal-page workflow', async () => {
  const { local } = mount()
  act(() => {
    local.dispatch(selectionApplied({ rowIds: ['r1', 'r3'], operation: 'replace', label: 'workflow scope' }))
    local.dispatch(observationScopeChanged('selected'))
  })
  vi.mocked(ca.runCa).mockResolvedValueOnce(result('workflow-result', { scope: 'selected', scopeCount: 2,
    fitCount: 2, effectiveN: 2 }))
  let path = '/pcp'
  const routeListeners = new Set<() => void>()
  const router = { getPath: () => path,
    subscribe: (listener: () => void) => { routeListeners.add(listener); return () => { routeListeners.delete(listener) } },
    navigate: (next: string) => { path = next; for (const listener of [...routeListeners]) listener() },
  }
  const monitor = createDavisRevisionMonitor({ store: local, router })
  // No controller seam: the workflow discovers the real mounted page through its registry.
  const workflow = createCorrespondenceWorkflow({ store: local, router, monitor })
  type Receipt = { status: string; requestId: string; draftRevision: number; resultId?: string;
    questions: { id: string; type: string; options: { value: string; label: string }[] }[];
    summary?: { resultId: string }; preview: { scope: string; scopeCount: number } }
  const invoke = async (operation: string, args: Record<string, JSONValue>): Promise<Receipt> => {
    const context: OperationContext = { expectedRevision: monitor.getRevision(), signal: new AbortController().signal,
      operationId: operation, runId: 'vertical-run', planId: 'vertical-plan' }
    return await workflow.handlers[operation](args, context) as Receipt
  }
  try {
    let prepared!: Receipt
    await act(async () => { prepared = await invoke('analysis.prepare', { method: 'correspondence', answers: [] }) })
    expect(prepared.status).toBe('needs_input')
    expect(path).toBe('/models/ca')
    expect(prepared.questions.map(question => question.id)).toEqual(['rowColumnId', 'columnColumnId'])
    expect(prepared.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rowColumnId', type: 'single', options: expect.arrayContaining([
        expect.objectContaining({ value: 'id-a' }),
      ]) }),
      expect.objectContaining({ id: 'columnColumnId', type: 'single', options: expect.arrayContaining([
        expect.objectContaining({ value: 'id-b' }),
      ]) }),
    ]))
    expect(ca.runCa).not.toHaveBeenCalled()
    const answers = [{ questionId: 'rowColumnId', value: 'id-a' }, { questionId: 'columnColumnId', value: 'id-b' }]
    let ready!: Receipt
    await act(async () => { ready = await invoke('analysis.resume', {
      requestId: prepared.requestId, draftRevision: prepared.draftRevision, answers,
    }) })
    expect(ready.status).toBe('ready')
    expect(ready.questions).toEqual([])
    expect(ready.preview).toMatchObject({ scope: 'selected', scopeCount: 2 })
    expect(screen.getByLabelText('CAの行変数')).toHaveValue('A')
    expect(screen.getByLabelText('CAの列変数')).toHaveValue('B')
    let completed!: Receipt
    await act(async () => { completed = await invoke('analysis.run', {
      requestId: ready.requestId, draftRevision: ready.draftRevision,
    }) })
    expect(completed).toMatchObject({ status: 'completed', resultId: 'workflow-result', summary: { resultId: 'workflow-result' } })
    expect(controller().inspect().completed?.result.resultId).toBe(completed.resultId)
    expect(screen.getByTestId('normal-ca-map')).toBeVisible()
    expect(screen.getByText('通常の固有値表')).toBeVisible()
    expect(screen.getByRole('button', { name: '固有値CSV' })).toBeVisible()
    expect(screen.getByRole('button', { name: '設定JSON' })).toBeVisible()
    expect(ca.runCa).toHaveBeenCalledOnce()
    expect(ca.runCa).toHaveBeenCalledWith({ datasetId: 'd', expectedDataRevision: 1, expectedSchemaRevision: 1,
      scope: 'selected', selectedRowIds: ['r1', 'r3'], weightMode: 'dataset', missingPolicy: 'exclude' },
    { kind: 'respondents', rowVariable: 'A', columnVariable: 'B' }, 'symmetric')
  } finally { workflow.dispose(); monitor.dispose() }
})

it('uses the same controller for ordinary manual input and Run', async () => {
  mount()
  const updates = vi.fn(), unsubscribe = controller().subscribe(updates)
  fireEvent.change(screen.getByLabelText('CAの行変数'), { target: { value: 'A' } })
  fireEvent.change(screen.getByLabelText('CAの列変数'), { target: { value: 'B' } })
  expect(controller().inspect().setup).toMatchObject({ rowVar: 'A', colVar: 'B' })
  fireEvent.click(screen.getByTestId('ca-run'))
  await screen.findByTestId('normal-ca-map')
  expect(updates).toHaveBeenCalled()
  expect(controller().inspect().completed?.result.resultId).toBe('ca-result')
  fireEvent.change(screen.getByLabelText('CAの行変数'), { target: { value: '' } })
  expect(controller().inspect()).toMatchObject({ canRun: false, setup: { rowVar: null } })
  unsubscribe()
})

it('retains the prior result and presents the current error after a failed rerun', async () => {
  mount(); const port = configureRespondents()
  await act(async () => { await port.run() })
  const pending = deferred<CAResponse>()
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise)
  act(() => { port.configure({ colVar: 'C' }) })
  let running!: Promise<unknown>
  act(() => { running = port.run().catch(error => error) })
  expect(port.inspect().loading).toBe(true)
  expect(screen.getByTestId('ca-run')).toHaveClass('ant-btn-loading')
  await act(async () => { pending.reject(new Error('retry failed')); await running })
  expect(port.inspect()).toMatchObject({ loading: false, error: 'retry failed' })
  expect(screen.getByText('retry failed')).toBeVisible()
  expect(screen.getByTestId('normal-ca-map')).toBeVisible()
  expect(screen.getByText(/対象または次回の分析設定が変更されています/)).toBeVisible()
})

it('captures submitted inputs and preserves a live map edit during a pending request', async () => {
  mount(); const port = configureRespondents()
  const pending = deferred<CAResponse>()
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise)
  let running!: ReturnType<CorrespondenceController['run']>
  act(() => { running = port.run() })
  act(() => { port.configure({ mapScaling: 'column_principal' }) })
  await act(async () => { pending.resolve(result()); await running })
  expect(ca.runCa).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'symmetric')
  expect(screen.getByTestId('normal-ca-map')).toHaveTextContent('column_principal')
  expect(screen.queryByText(/対象または次回の分析設定が変更されています/)).not.toBeInTheDocument()
  act(() => { port.configure({ colVar: 'C' }) })
  expect(port.inspect().completed?.result.resultId).toBe('ca-result')
  expect(screen.getByText(/対象または次回の分析設定が変更されています/)).toBeVisible()
})

it('cancels bridge publication without pretending that the numerical request stopped', async () => {
  mount(); const port = configureRespondents(), pending = deferred<CAResponse>(), abort = new AbortController()
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise)
  let running!: Promise<any>
  act(() => { running = port.run({ signal: abort.signal }).catch(error => error) })
  await act(async () => { abort.abort(); expect((await running).code).toBe('CANCELLED') })
  expect(port.inspect()).toMatchObject({ loading: false, completed: null, error: null })
  await act(async () => { pending.resolve(result()); await pending.promise })
  expect(screen.queryByTestId('normal-ca-map')).not.toBeInTheDocument()
  expect(ca.runCa).toHaveBeenCalledTimes(1)
})

it('passes an immutable completed receipt to the host guard before publishing it', async () => {
  mount(); const port = configureRespondents()
  const guard = vi.fn(receipt => {
    expect(receipt.result.resultId).toBe('ca-result')
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.context.activeRowIds)).toBe(true)
    expect(port.inspect().completed).toBeNull()
    throw new Error('Summary exceeds the bridge limit')
  })
  await act(async () => {
    await expect(port.run({ beforeCommit: guard })).rejects.toThrow('Summary exceeds the bridge limit')
  })
  expect(guard).toHaveBeenCalledOnce()
  expect(port.inspect().completed).toBeNull()
  expect(screen.queryByTestId('normal-ca-map')).not.toBeInTheDocument()
})

it('does not let an older run overwrite the newer committed result', async () => {
  mount(); const port = configureRespondents(), pending = deferred<CAResponse>()
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result('new-result'))
  let older!: Promise<any>
  act(() => { older = port.run().catch(error => error) })
  await act(async () => { await port.run() })
  await act(async () => { pending.resolve(result('old-result')); expect((await older).code).toBe('CA_RUN_SUPERSEDED') })
  expect(port.inspect().completed?.result.resultId).toBe('new-result')
})

it.each(['data', 'schema', 'dataset'] as const)('rejects a pending run after a %s change', async kind => {
  const { local } = mount(); const port = configureRespondents(), pending = deferred<CAResponse>()
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise)
  let running!: Promise<any>
  act(() => { running = port.run().catch(error => error) })
  act(() => {
    if (kind === 'data') local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 }))
    if (kind === 'schema') local.dispatch(codebookReceived({ datasetId: 'd', schemaRevision: 2, columns }))
    if (kind === 'dataset') local.dispatch(datasetLoaded({ datasetId: 'other', name: 'Other', rowIds: ['r4'] }))
  })
  await act(async () => { pending.resolve(result()); expect((await running).code).toBe('CA_RUN_SUPERSEDED') })
  expect(port.inspect().completed).toBeNull()
  expect(screen.queryByTestId('normal-ca-map')).not.toBeInTheDocument()
})

it('exposes scope changes and honors the final host guard without publishing', async () => {
  const { local } = mount(); const port = configureRespondents(), pending = deferred<CAResponse>()
  const startedKey = port.inspect().inputContextKey
  const startedScope = port.inspect().scopeKey
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise)
  let running!: Promise<any>
  act(() => { running = port.run({ beforeCommit: () => port.inspect().inputContextKey === startedKey }).catch(error => error) })
  act(() => {
    local.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'replace', label: 'one row' }))
    local.dispatch(observationScopeChanged('selected'))
  })
  expect(port.inspect().scopeKey).not.toBe(startedScope)
  await act(async () => { pending.resolve(result()); expect((await running).code).toBe('CA_RUN_SUPERSEDED') })
  expect(port.inspect().completed).toBeNull()
})

it('allows acknowledgement only through the ordinary checkbox and clears it on input/context changes', () => {
  const { local } = mount(), port = controller(), updates = vi.fn(), unsubscribe = port.subscribe(updates)
  act(() => { port.configure({ inputKind: 'contingency', rowLabelCol: 'label', valueCols: ['x', 'y'], weightChoice: 'none' }) })
  expect(port.inspect().canRun).toBe(false)
  expect(() => port.configure({ ack: true } as any)).toThrow('CA_CONFIGURATION_INVALID')
  expect(() => port.configure(Object.defineProperty({}, 'ack', { value: true }))).toThrow('CA_CONFIGURATION_INVALID')
  const checkbox = () => screen.getByRole('checkbox', { name: 'セルが独立した観測の度数であることを確認する' })
  fireEvent.click(checkbox())
  expect(port.inspect()).toMatchObject({ canRun: true, setup: { ack: true } })
  expect(updates).toHaveBeenCalled()
  act(() => { port.configure({ valueCols: ['x', 'z'] }) })
  expect(checkbox()).not.toBeChecked()
  fireEvent.click(checkbox())
  act(() => { local.dispatch(observationScopeChanged('all')) })
  expect(checkbox()).not.toBeChecked()
  fireEvent.click(checkbox())
  act(() => { port.configure({ cellSemantics: 'mass' }) })
  expect(port.inspect()).toMatchObject({ canRun: true, setup: { ack: false } })
  act(() => { port.configure({ cellSemantics: 'frequency' }) })
  expect(checkbox()).not.toBeChecked()
  unsubscribe()
})

it('rejects missing/unknown inputs and never executes an incomplete setup', async () => {
  mount(); const port = controller()
  await expect(port.run()).rejects.toMatchObject({ code: 'CA_INPUT_REQUIRED' })
  expect(() => port.configure({ rowVar: 'unknown' })).toThrow('CA_UNKNOWN_COLUMN')
  configureRespondents(port)
  act(() => { port.configure({ colVar: 'A' }) })
  await expect(port.run()).rejects.toMatchObject({ code: 'CA_INPUT_REQUIRED' })
  expect(ca.runCa).not.toHaveBeenCalled()
})

it('keeps the ordinary category-selection controls connected to central Redux selection', async () => {
  const { local } = mount(); const port = configureRespondents()
  vi.spyOn(ca, 'selectCaCategories').mockResolvedValue({ status: 'success', resultId: 'ca-result', rowIds: ['r2'],
    matchedCount: 1, fitMatchedCount: 1, contextIntersectionCount: 1, selectionLabel: 'one' })
  await act(async () => { await port.run() })
  fireEvent.click(screen.getByRole('button', { name: '選択カテゴリ' }))
  fireEvent.click(screen.getByRole('button', { name: /原行IDへ解決して選択/ }))
  await waitFor(() => expect(local.getState().selection.selectedRowIds).toEqual(['r2']))
})

it('suppresses a pending publication when its normal page is unmounted', async () => {
  const view = mount(), port = configureRespondents(), pending = deferred<CAResponse>()
  vi.mocked(ca.runCa).mockReturnValueOnce(pending.promise)
  let running!: Promise<any>
  act(() => { running = port.run().catch(error => error) })
  view.unmount()
  await act(async () => { pending.resolve(result()); expect((await running).code).toBe('CA_RUN_SUPERSEDED') })
  expect(getCaController()).toBeNull()
  expect(port.inspect()).toMatchObject({ ready: false, canRun: false, completed: null })
})

it('registers once across StrictMode cleanup, resolves mount waiters, and disposes retained ports', async () => {
  const updates = vi.fn(), unsubscribe = subscribeCaController(updates)
  const waiting = waitForCaController()
  const view = mount(true), port = controller()
  expect(await waiting).toBe(port)
  view.unmount()
  expect(getCaController()).toBeNull()
  expect(updates).toHaveBeenCalled()
  expect(() => port.configure({ rowVar: 'A' })).toThrow('CA_CONTROLLER_DISPOSED')
  await expect(port.run()).rejects.toMatchObject({ code: 'CA_CONTROLLER_DISPOSED' })
  const abort = new AbortController(), canceledWait = waitForCaController(abort.signal)
  abort.abort()
  await expect(canceledWait).rejects.toMatchObject({ code: 'CANCELLED' })
  unsubscribe()
})
