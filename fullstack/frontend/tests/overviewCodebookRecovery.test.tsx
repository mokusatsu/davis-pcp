import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { notification } from 'antd'
import { api, type CodebookColumn, type CodebookResponse } from '../src/api/client'
import {
  datasetLoaded, datasetValuesUpdated, focusSelected, globalObservationsSlice, globalVariablesSlice,
  observationScopeChanged, selectionApplied, selectionReducer, store, variablesInitialized,
} from '../src/app/store'
import {
  codebookReadAccepted, codebookReceived, codebookSlice, draftColumnUpdated, fetchCodebookThunk,
} from '../src/features/dataset/codebookSlice'
import { provenanceReducer } from '../src/features/dataset/provenanceSlice'
import OverviewPage from '../src/features/dataset/OverviewPage'
import CodebookEditorModal from '../src/features/dataset/CodebookEditorModal'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Preserve actual Overview, OneHotModal, ActiveModal, ColumnTable, editor, reducers,
// mutation event and codebook thunk. Other transformation controls are source-only.
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ImputationModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function column(name: string): CodebookColumn {
  return {
    columnId: `id-${name}`, name, label: name === 'q1_color' ? 'Favorite color' : name,
    role: 'question', scaleType: name === 'q1_color' ? 'nominal' : 'ratio',
    valueLabels: name === 'q1_color' ? { blue: 'blue', red: 'red' } : {},
    categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null, multiResponseOptionLabel: '',
  }
}

// The fixture owns server state independently of delivery. The transform POST
// commits revision 2 immediately, then holds its real-shaped response until asked.
// Only in-memory API transport is simulated; no backend or HTTP client is run.
function transport(readFailure?: 'metadata' | 'summary', holdAutomaticReload = false) {
  let revision = 1
  let names = ['q1_color']
  let failureRemaining = readFailure ? 1 : 0
  let codebookHealthy = false
  const mutation = deferred<any>()
  const codebookWires: ReturnType<typeof deferred<CodebookResponse>>[] = []
  const automaticMetadata = deferred<any>()
  let metadataReads = 0
  const requests: { method: string; path: string; revision: number; body?: unknown }[] = []
  const book = (): CodebookResponse => ({
    datasetId: 'a', schemaRevision: revision, columns: names.map(column),
    multiResponseGroups: [], weightConfig: null, surveyDesign: null,
    licenseText: '', licenseRevision: 1,
  })
  const metadata = () => ({
    datasetId: 'a', name: 'Colors', format: 'csv', rowCount: 2, columnCount: names.length,
    fingerprint: `q1_colors-revision-${revision}`, revision, dataRevision: revision,
    schemaRevision: revision, rowIdentity: 'generated', createdAt: '2026-10-06T00:00:00Z',
    schema: names.map(name => ({
      columnId: `id-${name}`, name, physicalType: name === 'q1_color' ? 'string' : 'int',
      semanticType: name === 'q1_color' ? 'categorical' : 'numeric',
      role: name === 'q1_color' ? 'categorical_axis' : 'numeric_axis',
      missingCount: 0, uniqueCount: 2,
      categoryOrder: 'imported', manualCategories: [], constant: false, uniqueIdCandidate: true,
      ...(name === 'q1_color' ? { categories: ['blue', 'red'], min: null, max: null } : { categories: null, min: 0, max: 1 }),
    })),
  })
  const summary = () => ({
    datasetId: 'a', dataRevision: revision, schemaRevision: revision,
    fingerprint: `q1_colors-revision-${revision}`, rowCount: 2, cacheHit: false,
    evidenceClass: 'MODERN-EXTENSION', columns: Object.fromEntries(names.map(name => [name, {
      ...(name === 'q1_color'
        ? { count: 2, missing: 0, uniqueCount: 2, frequencies: { blue: 1, red: 1 } }
        : { count: 2, missing: 0, min: 0, max: 1, mean: 0.5, median: 0.5, q1: 0.25, q3: 0.75, iqr: 0.5, std: Math.SQRT1_2 }),
      denominators: { total: 2, notApplicable: 0, missing: 0, target: 2, valid: 2 },
      distribution: (name === 'q1_color' ? ['blue', 'red'] : ['0', '1']).map(code => ({
        code, label: code, count: 1, percentageValid: 50, percentageTotal: 50, isMissing: false, missingReason: null,
      })),
      auxiliaryStats: name === 'q1_color' ? {} : { mean: 0.5, median: 0.5, q1: 0.25, q3: 0.75, iqr: 0.5 },
    }])),
    weightStatus: 'omitted', weightApplied: false, weightColumn: null, weightColumnId: null,
    unweightedN: 2, weightedN: null, weightMissingCount: 0, scopeHash: 'fixture-two-rows',
  })
  let mutationResponse: any
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    requests.push({ method: 'GET', path, revision })
    if (path === '/datasets/a/codebook') {
      if (codebookHealthy) return book() as any
      const wire = deferred<CodebookResponse>()
      codebookWires.push(wire)
      return wire.promise as any
    }
    if (path === '/datasets/b') return { ...metadata(), datasetId: 'b', name: 'Other colors' } as any
    if (path === '/datasets/a') {
      metadataReads++
      if (holdAutomaticReload && metadataReads === 3) return automaticMetadata.promise
      if (revision === 2 && readFailure === 'metadata' && failureRemaining-- > 0) {
        throw new Error('Fixture metadata read unavailable')
      }
      return metadata() as any
    }
    throw new Error(`Unexpected GET: ${path}`)
  })
  vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    requests.push({ method: 'POST', path, body, revision })
    if (path === '/summaries') {
      expect(['a', 'b']).toContain(body.datasetId)
      expect(body).toEqual({ datasetId: body.datasetId, expectedDataRevision: revision, expectedSchemaRevision: revision })
      if (revision === 2 && readFailure === 'summary' && failureRemaining-- > 0) {
        throw new Error('Fixture summary read unavailable')
      }
      return { ...summary(), datasetId: body.datasetId } as any
    }
    if (path === '/datasets/a/transform') {
      expect(revision).toBe(1)
      expect(body).toEqual({ type: 'nominal_to_binary', source_column: 'q1_color', options: { drop_first: false, prefix: 'q1_color' } })
      revision = 2
      names = ['q1_color', 'q1_color_blue', 'q1_color_red']
      // datasets.py returns metadata spread plus createdColumns, binSummaries,
      // and provenance, after commit_data_change has completed.
      mutationResponse = {
        ...metadata(), createdColumns: ['q1_color_blue', 'q1_color_red'], binSummaries: null,
        provenance: { currentOperationId: 'fixture-transform-1', rawDataRevision: 1, operationCount: 1 },
      }
      return mutation.promise
    }
    throw new Error(`Unexpected POST: ${path}`)
  })
  return {
    book, requests, get revision() { return revision },
    deliverMutation: () => mutation.resolve(mutationResponse),
    acceptCodebook: (index = codebookWires.length - 1) => { codebookHealthy = true; codebookWires[index]?.resolve(book()) },
    deliverMismatchedCodebook: () => codebookWires[codebookWires.length - 1].resolve({ ...book(), schemaRevision: revision + 1 }),
    rejectCodebook: (index = codebookWires.length - 1) => codebookWires[index].reject(new Error('Fixture codebook read unavailable')),
    deliverAutomaticMetadata: () => automaticMetadata.resolve(metadata()),
    advance: (nextRevision: number) => { revision = nextRevision },
    mutationCount: () => requests.filter(request => request.path === '/datasets/a/transform').length,
    codebookReadCount: () => requests.filter(request => request.path === '/datasets/a/codebook').length,
  }
}

function localStore(initialBook: CodebookResponse, dirtyDraft: boolean) {
  const actions: any[] = []
  const local = configureStore({
    reducer: {
      selection: selectionReducer, codebook: codebookSlice.reducer,
      globalVariables: globalVariablesSlice.reducer, globalObservations: globalObservationsSlice.reducer,
      provenance: provenanceReducer,
      // PCP controls are outside this proof. Keep their initial read-only state.
      pcp: (state = store.getState().pcp) => state,
    },
    middleware: defaults => defaults({ serializableCheck: false }).concat(() => next => action => {
      actions.push(action); return next(action)
    }),
  })
  local.dispatch(datasetLoaded({ datasetId: 'a', name: 'Colors', rowIds: ['r1', 'r2'], dataRevision: 1 }))
  local.dispatch(variablesInitialized({ datasetId: 'a', variables: ['q1_color'] }))
  local.dispatch(codebookReceived(initialBook))
  local.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'replace', label: 'Fixture selection' }))
  local.dispatch(focusSelected())
  local.dispatch(observationScopeChanged('selected'))
  if (dirtyDraft) local.dispatch(draftColumnUpdated({ columnId: 'id-q1_color', patch: { label: 'Unsaved question wording' } }))
  return { local, actions }
}

// A bounded cached-route harness uses the real activity provider. It does not
// claim runtime coverage of AppShell or KeepAliveOutlet routing internals.
function CachedOverview() {
  const location = useLocation(), navigate = useNavigate()
  const [generation, setGeneration] = useState(0)
  const active = location.pathname === '/overview'
  return <>
    <button onClick={() => navigate('/other')}>Leave overview</button>
    <button onClick={() => navigate('/overview')}>Return to overview</button>
    <button onClick={() => setGeneration(value => value + 1)}>Remount overview</button>
    <div style={{ display: active ? 'block' : 'none' }}>
      <AnalysisViewActivityContext.Provider value={active}>
        <OverviewPage key={generation} />
      </AnalysisViewActivityContext.Provider>
    </div>
    <CodebookEditorModal />
  </>
}

function mount(server: ReturnType<typeof transport>, dirtyDraft = false) {
  const state = localStore(server.book(), dirtyDraft)
  render(<Provider store={state.local}><MemoryRouter initialEntries={['/overview']}><CachedOverview /></MemoryRouter></Provider>)
  return state
}

async function startAndDeliverMutation(server: ReturnType<typeof transport>, local: ReturnType<typeof localStore>['local']) {
  fireEvent.click(await screen.findByTestId('btn-onehot-q1_color'))
  fireEvent.click(screen.getByRole('button', { name: '0/1二値列を生成' }))
  expect(server.revision).toBe(2)
  expect(server.mutationCount()).toBe(1)
  expect(local.getState().selection.dataRevision).toBe(1)
  expect(notification.success).not.toHaveBeenCalled()
  await act(async () => { server.deliverMutation() })
  expect(notification.success).toHaveBeenCalledWith({ message: '二値化完了', description: '2個の0/1列を生成しました。' })
  expect(notification.error).not.toHaveBeenCalled()
}

function questionCount() {
  const label = screen.getByText('設問数（question）')
  return label.closest('tr')!.querySelector('.ant-descriptions-item-content')!.textContent
}

function expectWorkspaceRetained(local: ReturnType<typeof localStore>['local'], before: ReturnType<typeof store.getState>) {
  expect(local.getState().selection).toEqual({ ...before.selection, dataRevision: 2 })
  expect(local.getState().globalObservations).toBe(before.globalObservations)
  expect(local.getState().pcp).toBe(before.pcp)
}

beforeEach(() => {
  // jsdom cannot measure pseudo-elements; preserve ordinary computed styles.
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(notification, 'success').mockImplementation(() => {})
  vi.spyOn(notification, 'error').mockImplementation(() => {})
  // Any unexpected write is a fixture error, rather than a real network request.
  vi.spyOn(api, 'put').mockRejectedValue(new Error('Unexpected PUT in read-only recovery proof'))
  vi.spyOn(api, 'delete').mockRejectedValue(new Error('Unexpected DELETE in read-only recovery proof'))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Overview canonical codebook refresh recovery', () => {
  it('retains a current failure across automatic reload and cached return; retries only reads until success', async () => {
    const server = transport(undefined, true), { local, actions } = mount(server, true)
    const before = local.getState(), draft = before.codebook.draftColumns
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.requests.filter(request => request.path === '/datasets/a')).toHaveLength(3))
    expect(local.getState().selection.dataRevision).toBe(2)
    expect(actions.filter(fetchCodebookThunk.pending.match)).toHaveLength(1)
    await act(async () => { server.rejectCodebook() })
    await waitFor(() => expect(actions.filter(fetchCodebookThunk.rejected.match)).toHaveLength(1))
    const rejected = actions.find(fetchCodebookThunk.rejected.match)
    expect(rejected.error.message).toBe('Fixture codebook read unavailable')
    expect(rejected.payload).toBeUndefined()
    // The automatic metadata reload settles after the canonical failure.
    await act(async () => { server.deliverAutomaticMetadata() })
    await screen.findByTestId('btn-delete-q1_color_blue')
    let alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('コードブックを再読み込みできませんでした')
    expect(alert).toHaveTextContent('Fixture codebook read unavailable')
    expect(actions.filter(codebookReadAccepted.match)).toHaveLength(0)
    expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, isLoading: false, hasChanges: true })
    expect(local.getState().codebook.draftColumns).toBe(draft)
    expect(questionCount()).toBe('1')
    expectWorkspaceRetained(local, before)
    expect(notification.error).not.toHaveBeenCalled()

    const requestsBeforeReturn = server.requests.length
    fireEvent.click(screen.getByRole('button', { name: 'Leave overview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Return to overview' }))
    fireEvent.focus(window)
    expect(screen.getByRole('alert')).toBeVisible()
    expect(server.requests).toHaveLength(requestsBeforeReturn)
    expect(server.codebookReadCount()).toBe(1)

    const retryStart = server.requests.length
    const retry = within(alert).getByRole('button', { name: 'コードブックを再読み込み' })
    expect(retry).toBeVisible()
    expect(retry.closest('.ant-alert-description')).not.toBeNull()
    expect(alert.querySelector('.ant-alert-action')).toBeNull()
    expect(retry).toHaveStyle({ maxWidth: '100%', height: 'auto', whiteSpace: 'normal' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(server.codebookReadCount()).toBe(2)
    expect(retry).toBeDisabled()
    await act(async () => { server.rejectCodebook() })
    alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('コードブックを再読み込みできませんでした')
    expect(local.getState().codebook.draftColumns).toBe(draft)
    fireEvent.click(within(alert).getByRole('button', { name: 'コードブックを再読み込み' }))
    expect(server.codebookReadCount()).toBe(3)
    await act(async () => { server.acceptCodebook() })
    await waitFor(() => expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1))
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(questionCount()).toBe('3')
    expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, hasChanges: true })
    expect(local.getState().codebook.draftColumns).toBe(draft)
    expectWorkspaceRetained(local, before)
    expect(server.requests.slice(retryStart).every(request =>
      request.method === 'GET' || (request.method === 'POST' && request.path === '/summaries'))).toBe(true)
    expect(server.mutationCount()).toBe(1)
    expect(notification.success).toHaveBeenCalledTimes(1)
    expect(notification.error).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
    expect(api.delete).not.toHaveBeenCalled()
  })

  it('recovers on remount when metadata revisions match but saved canonical schema is stale', async () => {
    const server = transport(), { local, actions } = mount(server, true)
    const before = local.getState(), draft = before.codebook.draftColumns
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    await act(async () => { server.rejectCodebook() })
    expect(await screen.findByRole('alert')).toHaveTextContent('コードブックを再読み込みできませんでした')
    fireEvent.click(screen.getByRole('button', { name: 'Remount overview' }))
    await waitFor(() => expect(server.codebookReadCount()).toBe(2))
    await act(async () => { server.acceptCodebook() })
    await waitFor(() => expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1))
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(questionCount()).toBe('3')
    expect(local.getState().codebook.draftColumns).toBe(draft)
    expectWorkspaceRetained(local, before)
    expect(server.mutationCount()).toBe(1)
  })

  it.each([false, true])('publishes a real accepted codebook read after One-Hot success (dirty draft=%s)', async dirtyDraft => {
    const server = transport(), { local, actions } = mount(server, dirtyDraft)
    const before = local.getState(), draft = before.codebook.draftColumns
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    await act(async () => { server.acceptCodebook() })
    await waitFor(() => expect(actions.filter(fetchCodebookThunk.fulfilled.match)).toHaveLength(1))
    expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
    expect(actions.filter(fetchCodebookThunk.rejected.match)).toHaveLength(0)
    expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isLoading: false, hasChanges: dirtyDraft })
    expect(local.getState().codebook.columns.map(value => value.name)).toEqual(['q1_color', 'q1_color_blue', 'q1_color_red'])
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(questionCount()).toBe('3')
    if (dirtyDraft) expect(local.getState().codebook.draftColumns).toBe(draft)
    else expect(local.getState().codebook.draftColumns.map(value => value.name)).toEqual(['q1_color', 'q1_color_blue', 'q1_color_red'])
    expectWorkspaceRetained(local, before)
    expect(server.mutationCount()).toBe(1)
    expect(notification.error).not.toHaveBeenCalled()
  })

  it.each(['metadata', 'summary'] as const)('preserves the existing read-only retry when the post-commit %s read fails', async failure => {
    const server = transport(failure), { local, actions } = mount(server)
    const before = local.getState()
    await startAndDeliverMutation(server, local)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('概要を読み込めませんでした')
    expect(alert).toHaveTextContent(`Fixture ${failure} read unavailable`)
    expect(local.getState().selection.dataRevision).toBe(1)
    expect(server.codebookReadCount()).toBe(0)
    const retryStart = server.requests.length
    fireEvent.click(within(alert).getByRole('button', { name: '再試行' }))
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    await act(async () => { server.acceptCodebook() })
    await waitFor(() => expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1))
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(local.getState().codebook.schemaRevision).toBe(2)
    expect(questionCount()).toBe('3')
    expectWorkspaceRetained(local, before)
    expect(server.mutationCount()).toBe(1)
    expect(server.requests.slice(retryStart).every(request =>
      (request.method === 'GET' && ['/datasets/a', '/datasets/a/codebook'].includes(request.path))
      || (request.method === 'POST' && request.path === '/summaries'))).toBe(true)
    expect(notification.success).toHaveBeenCalledTimes(1)
    expect(notification.error).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
    expect(api.delete).not.toHaveBeenCalled()
  })


  it.each(['different dataset', 'same-ID installation'] as const)('retires a failed target and ignores its pending retry after %s replacement', async replacement => {
    const server = transport(), { local, actions } = mount(server, true)
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    await act(async () => { server.rejectCodebook() })
    const alert = await screen.findByRole('alert')
    fireEvent.click(within(alert).getByRole('button', { name: 'コードブックを再読み込み' }))
    expect(server.codebookReadCount()).toBe(2)
    const id = replacement === 'different dataset' ? 'b' : 'a'
    act(() => {
      local.dispatch(datasetLoaded({ datasetId: id, name: 'Replacement', rowIds: ['new-1'], dataRevision: 2 }))
      local.dispatch(codebookReceived({ ...server.book(), datasetId: id }))
      local.dispatch(draftColumnUpdated({ columnId: 'id-q1_color', patch: { label: 'Replacement draft' } }))
    })
    await screen.findByTestId('btn-delete-q1_color_blue')
    const replacementState = local.getState()
    await act(async () => { server.rejectCodebook() })
    await waitFor(() => expect(actions.filter(fetchCodebookThunk.rejected.match)).toHaveLength(2))
    expect(actions.filter(fetchCodebookThunk.rejected.match)[1].payload).toBe('CODEBOOK_FETCH_SUPERSEDED')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(local.getState()).toBe(replacementState)
    expect(server.codebookReadCount()).toBe(2)
    expect(server.mutationCount()).toBe(1)
  })

  it('distinguishes a superseded read and clears its notice when another accepted read supplies the target', async () => {
    const server = transport(), { local, actions } = mount(server, true)
    const draft = local.getState().codebook.draftColumns
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    let newerRead: ReturnType<typeof local.dispatch>
    act(() => { newerRead = local.dispatch(fetchCodebookThunk('a')) })
    expect(server.codebookReadCount()).toBe(2)
    await act(async () => { server.rejectCodebook(0) })
    expect(await screen.findByRole('alert')).toHaveTextContent('コードブックの再読み込みが必要です')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Fixture codebook read unavailable')
    expect(actions.filter(fetchCodebookThunk.rejected.match)[0].payload).toBe('CODEBOOK_FETCH_SUPERSEDED')
    await act(async () => { server.acceptCodebook(1); await newerRead! })
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
    expect(local.getState().codebook.draftColumns).toBe(draft)
    expect(server.codebookReadCount()).toBe(2)
    expect(server.mutationCount()).toBe(1)
  })

  it('deduplicates the in-flight target during automatic reload and retires it for a newer data target', async () => {
    const server = transport(undefined, true), { local, actions } = mount(server, true)
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.requests.filter(request => request.path === '/datasets/a')).toHaveLength(3))
    await act(async () => { server.deliverAutomaticMetadata() })
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(server.codebookReadCount()).toBe(1)
    act(() => { server.advance(3); local.dispatch(datasetValuesUpdated({ datasetId: 'a', dataRevision: 3 })) })
    await waitFor(() => expect(server.codebookReadCount()).toBe(2))
    await act(async () => { server.rejectCodebook(0) })
    expect(actions.filter(fetchCodebookThunk.rejected.match)[0].payload).toBe('CODEBOOK_FETCH_SUPERSEDED')
    expect(screen.getByRole('button', { name: 'コードブックを再読み込み' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('コードブックを再読み込み中です')
    await act(async () => { server.acceptCodebook(1) })
    await waitFor(() => expect(local.getState().codebook.schemaRevision).toBe(3))
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(server.mutationCount()).toBe(1)
  })

  it('keeps a fulfilled but mismatched canonical read recoverable until the target is accepted', async () => {
    const server = transport(), { local, actions } = mount(server, true)
    const before = local.getState(), draft = before.codebook.draftColumns
    await startAndDeliverMutation(server, local)
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    await act(async () => { server.deliverMismatchedCodebook() })
    await screen.findByTestId('btn-delete-q1_color_blue')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('読み込んだコードブックと概要の更新状態が一致しません')
    expect(actions.filter(fetchCodebookThunk.fulfilled.match)).toHaveLength(1)
    expect(server.codebookReadCount()).toBe(1)
    fireEvent.click(within(alert).getByRole('button', { name: 'コードブックを再読み込み' }))
    expect(server.codebookReadCount()).toBe(2)
    await act(async () => { server.acceptCodebook() })
    await screen.findByTestId('btn-delete-q1_color_blue')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(local.getState().codebook.schemaRevision).toBe(2)
    expect(local.getState().codebook.draftColumns).toBe(draft)
    expectWorkspaceRetained(local, before)
    expect(server.mutationCount()).toBe(1)
  })

  it('refreshes a lower schema target even when the data revision already matches', async () => {
    const server = transport(), { local, actions } = mount(server, true)
    // A restored installation may have lower schema than the old saved book.
    act(() => { local.dispatch(codebookReceived({ ...server.book(), schemaRevision: 2 })) })
    await waitFor(() => expect(server.codebookReadCount()).toBe(1))
    await act(async () => { server.acceptCodebook() })
    await waitFor(() => expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1))
    await screen.findByTestId('btn-onehot-q1_color')
    expect(local.getState().selection.dataRevision).toBe(1)
    expect(local.getState().codebook.schemaRevision).toBe(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(server.mutationCount()).toBe(0)
  })
})
