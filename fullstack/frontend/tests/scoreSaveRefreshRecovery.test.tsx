import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { Button, ConfigProvider, message } from 'antd'
import { api, type CodebookColumn } from '../src/api/client'
import { datasetLoaded, datasetValuesUpdated, globalObservationsSlice, globalVariablesSlice, observationScopeChanged,
  selectionReducer, store, variablesInitialized } from '../src/app/store'
import { codebookReadAccepted, codebookReceived, codebookSlice,
  fetchCodebookThunk } from '../src/features/dataset/codebookSlice'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import FamdPage from '../src/features/models/FamdPage'
import { useScoreSaveRefresh, type ScoreSaveReceipt } from '../src/features/models/useScoreSaveRefresh'
import { getColumnarCacheGeneration } from '../src/features/pcp/columnarCache'

// Real pages, AntD controls/messages, lifecycle, thunk and reducers. Only transport
// and unrelated charts are replaced. The fake serializes writes against expected
// revisions; it proves client recovery, not backend storage or browser rendering.
vi.mock('../src/features/common/GraphPanel', async original => ({ ...await original<any>(),
  default: ({ children, controls }: any) => <div>{controls}{children}</div>,
  useGraphViewport: () => ({ logicalWidth: 600, logicalHeight: 400, scale: 1, zoom: null, dpr: 1, revision: 0 }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))
vi.mock('../src/features/models/McaFigure', async original => ({ ...await original<any>(), default: () => null }))
vi.mock('../src/features/models/FamdFigure', async original => ({ ...await original<any>(), default: () => null }))

const cases = [
  { name: 'MCA', Page: MultipleCorrespondencePage, path: '/models/mca', run: 'mca-run',
    fields: [['分析変数（2つ以上）', ['A', 'B']]] },
  { name: 'FAMD', Page: FamdPage, path: '/models/famd', run: 'famd-run',
    fields: [['数値列', ['X']], ['カテゴリ列', ['A']]] },
] as const
type Case = typeof cases[number]
const rowIds = ['r1', 'r2', 'r3']
const scoreValues = [.25, -.5, .75]
const staleNotice = 'データ版が更新されました。表示は旧版のままです。選択・保存・予測はできません。'
const readFailure = 'Only the post-commit codebook GET failed'
const postFailure = 'Materialization rejected before commit'
const savedNotice = (test: Case) => `${test.name}1を保存しました（3行）。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。`
const saveButton = (test: Case) => screen.getByRole('button', { name: `${test.name}1を派生列へ保存`, exact: true })

function column(name: string, scaleType: CodebookColumn['scaleType']): CodebookColumn {
  return { columnId: `${name}-id`, name, label: name, scaleType, role: 'question',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fitResponse(test: Case, context: any, fit: number) {
  return { status: 'success', method: test.name.toLowerCase(), resultId: `fit-${fit}`,
    meta: { datasetId: context.datasetId, dataRevision: context.expectedDataRevision,
      schemaRevision: context.expectedSchemaRevision, resultState: 'ready', scope: context.scope,
      scopeCount: rowIds.length, fitCount: rowIds.length, effectiveN: rowIds.length,
      excludedCount: 0, exclusionCounts: {}, analysisUnit: 'respondent', warnings: [], weightApplied: false },
    summary: { rank: 2, totalInertia: 1, eigenvalues: [.6, .4], inertiaRatio: [.6, .4],
      cumulativeInertiaRatio: [.6, 1], rawInertiaRatio: [.6, .4], rawCumulativeInertiaRatio: [.6, 1],
      nVariables: 2, nCategories: 4, nNumericVariables: 1, nCategoricalVariables: 1 },
    details: { variables: [], categories: [], numericVariables: [], categoricalVariables: [],
      variableRelation: [], omittedCategories: [], maDiagnostics: [] },
    capabilities: { materializeFitFields: ['coordinate:1', 'coordinate:2'], materializePredictionFields: [] },
    unavailableReasons: {} }
}

function mount(test: Case, options: { rejectPost?: boolean; postGate?: ReturnType<typeof deferred<void>>; receiptGate?: ReturnType<typeof deferred<void>> } = {}) {
  const initialColumns = [column('A', 'nominal'), column('B', 'nominal'), column('X', 'ratio')]
  let server = { dataRevision: 1, schemaRevision: 1, columns: initialColumns }
  const committedScores = new Map<string, number[]>()
  const transportEvents: string[] = []
  const actions: any[] = []
  const pendingReads: ReturnType<typeof deferred<any>>[] = []
  let fit = 0
  const codebook = () => structuredClone({ datasetId: 'synthetic', schemaRevision: server.schemaRevision,
    licenseText: '', licenseRevision: 1, columns: server.columns, multiResponseGroups: [],
    weightConfig: null, surveyDesign: null })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    if (path === test.path) return fitResponse(test, body.context, ++fit) as any
    if (path.endsWith('/materialize')) {
      transportEvents.push('POST materialize received')
      if (options.postGate) await options.postGate.promise
      expect(body.context).toMatchObject({ datasetId: 'synthetic', expectedDataRevision: server.dataRevision,
        expectedSchemaRevision: server.schemaRevision })
      if (options.rejectPost) {
        transportEvents.push('POST materialize rejected without commit')
        throw new Error(postFailure)
      }
      const name = body.columns[0].name
      if (server.columns.some(c => c.name === name)) throw new Error('COLUMN_ALREADY_EXISTS')
      const saved = { ...column(name, 'interval'), role: 'other' as const }
      committedScores.set(name, [...scoreValues])
      // Both revisions advance atomically before delivery of the success receipt.
      server = { dataRevision: server.dataRevision + 1, schemaRevision: server.schemaRevision + 1,
        columns: [...server.columns, saved] }
      transportEvents.push('POST materialize committed data=2 schema=2')
      if (options.receiptGate) await options.receiptGate.promise
      return { createdColumns: [{ columnId: saved.columnId, name, sourceField: 'coordinate:1' }],
        writtenRowCount: rowIds.length, dataRevision: server.dataRevision, schemaRevision: server.schemaRevision } as any
    }
    throw new Error(`Unexpected POST ${path}`)
  })
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/datasets/synthetic/codebook') {
      transportEvents.push(`GET codebook ${pendingReads.length + 1}`)
      const pending = deferred<any>()
      pendingReads.push(pending)
      return pending.promise
    }
    if (path === '/datasets/synthetic') return { dataRevision: server.dataRevision, schemaRevision: server.schemaRevision } as any
    if (path.startsWith('/analysis-results/') && path.includes('/rows?')) return {
      rows: rowIds.map((rowId, index) => ({ rowId, coordinates: [scoreValues[index], 0] })),
      total: rowIds.length, nextOffset: null,
    } as any
    throw new Error(`Unexpected GET ${path}`)
  })
  const base = store.getState()
  const local = configureStore({ reducer: {
    selection: selectionReducer, codebook: codebookSlice.reducer,
    globalVariables: globalVariablesSlice.reducer, globalObservations: globalObservationsSlice.reducer,
    pcp: () => base.pcp, provenance: () => base.provenance,
  }, middleware: defaults => defaults({ serializableCheck: false }).concat(() => next => action => {
    actions.push(action)
    return next(action)
  }) })
  local.dispatch(datasetLoaded({ datasetId: 'synthetic', name: 'Synthetic frontend fixture', rowIds, dataRevision: 1 }))
  local.dispatch(variablesInitialized({ datasetId: 'synthetic', variables: initialColumns.map(c => c.name),
    meta: Object.fromEntries(initialColumns.map(c => [c.name, { columnId: c.columnId, name: c.name,
      semanticType: 'numeric' as const, physicalType: 'Float64', missingCount: 0, isTargetCandidate: false }])) }))
  local.dispatch(codebookReceived(codebook()))
  local.dispatch(observationScopeChanged('all'))
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    <test.Page />
  </Provider></ConfigProvider>)
  return { local, view, post, get, server: () => server, codebook, initialColumns, committedScores, actions,
    pendingReads, transportEvents, saves: () => post.mock.calls.filter(([path]) => path.endsWith('/materialize')),
    reads: () => get.mock.calls.filter(([path]) => path === '/datasets/synthetic/codebook') }
}

// Real inline AntD options; no native-select shim or eager callback simulation.
async function chooseInline(label: string, names: readonly string[]) {
  const input = screen.getByRole('combobox', { name: label })
  fireEvent.mouseDown(input)
  for (const name of names) {
    const option = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content'))
        .find(item => within(item as HTMLElement).queryByText(name, { exact: true }) !== null)
      expect(found, `inline option ${name} is available`).toBeTruthy()
      return found!
    })
    fireEvent.click(option)
  }
  fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
}

async function prepare(test: Case, options: Parameters<typeof mount>[1] = {}) {
  const fixture = mount(test, options)
  for (const [label, names] of test.fields) await chooseInline(label, names)
  fireEvent.click(screen.getByTestId(test.run))
  await waitFor(() => expect(fixture.post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1))
  await waitFor(() => expect(screen.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(screen.getByRole('tab', { name: '保存・出力' }))
  await act(async () => { message.destroy() })
  expect(saveButton(test)).toBeEnabled()
  expect(fixture.reads()).toHaveLength(0)
  return { ...fixture, cacheBefore: getColumnarCacheGeneration() }
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(async () => {
  cleanup()
  // Static AntD messages own another React root; await cleanup before teardown.
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
})

const retryButton = () => screen.getByRole('button', { name: 'コードブックを再取得', exact: true })
const committedNotice = (name: string) => `${name}は保存済みです（3行）。`
const setName = (name: string) => fireEvent.change(screen.getByRole('textbox', { name: '保存先の列名（任意）' }), { target: { value: name } })
const namedSave = (name: string) => screen.getByRole('button', { name: `${name}を派生列へ保存`, exact: true })

// Preserve the uninterrupted commit/failure/retry sequence under measured
// hosted-runner slowdown; individual waits and other test budgets stay unchanged.
it.each(cases)('$name retains its committed name/receipt through failed GET retries and deduplicates pending retry clicks', async test => {
  const { local, pendingReads, server, codebook, actions, reads, saves, committedScores, initialColumns, cacheBefore } = await prepare(test)
  const submittedName = `${test.name}_committed`
  setName(submittedName)
  fireEvent.click(namedSave(submittedName))
  await waitFor(() => expect(reads()).toHaveLength(1))
  setName('Next_score')
  expect(saves()[0][1]).toMatchObject({ context: { expectedDataRevision: 1, expectedSchemaRevision: 1 },
    columns: [{ sourceField: 'coordinate:1', name: submittedName }], idempotencyKey: `fit-1-fit-1-${submittedName}` })
  expect(server()).toMatchObject({ dataRevision: 2, schemaRevision: 2 })
  expect(committedScores.get(submittedName)).toEqual(scoreValues)
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, columns: initialColumns, isLoading: true })
  expect(namedSave('Next_score')).toBeDisabled()
  expect(retryButton()).toBeDisabled()
  expect(screen.getByText(committedNotice(submittedName))).toBeVisible()
  expect(document.querySelector('.ant-message-success')).toBeNull()

  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(screen.getByText(new RegExp(readFailure))).toBeVisible()
  expect(actions.find(fetchCodebookThunk.rejected.match)).toMatchObject({ error: { message: readFailure }, meta: { rejectedWithValue: false } })
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(0)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, columns: initialColumns, isLoading: false })
  expect(document.querySelector('.ant-message-error')).toBeNull()
  expect(document.querySelector('.ant-message-success')).toBeNull()
  expect(screen.getByText(staleNotice)).toBeVisible()
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)

  act(() => { fireEvent.click(retryButton()); fireEvent.click(retryButton()) })
  await waitFor(() => expect(reads()).toHaveLength(2))
  expect(retryButton()).toBeDisabled()
  await act(async () => { pendingReads[1].reject(new Error('Retry GET failed')) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(screen.getByText(/Retry GET failed/)).toBeVisible()
  expect(screen.getByText(committedNotice(submittedName))).toBeVisible()
  expect(local.getState().codebook.schemaRevision).toBe(1)
  expect(saves()).toHaveLength(1)

  fireEvent.click(retryButton())
  await waitFor(() => expect(reads()).toHaveLength(3))
  await act(async () => { pendingReads[2].resolve(codebook()) })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'コードブックを再取得' })).toBeNull())
  expect(screen.getByText(`${submittedName}を保存しました（3行）。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。`)).toBeVisible()
  expect(screen.queryByText(committedNotice('Next_score'))).toBeNull()
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isLoading: false })
  expect(local.getState().codebook.columns.map(c => c.name)).toContain(submittedName)
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
  expect(saves()).toHaveLength(1)
  expect(server()).toMatchObject({ dataRevision: 2, schemaRevision: 2 })
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(namedSave('Next_score')).toBeDisabled()
}, 10000)

it.each(cases)('$name current success requires the accepted canonical read and keeps the old fit stale', async test => {
  const { local, pendingReads, codebook, actions, reads, saves, cacheBefore } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  await act(async () => { pendingReads[0].resolve(codebook()) })
  await waitFor(() => expect(screen.getByText(savedNotice(test))).toBeVisible())
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isLoading: false })
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
  expect(actions.filter(fetchCodebookThunk.fulfilled.match)).toHaveLength(1)
  expect(actions.filter(fetchCodebookThunk.rejected.match)).toHaveLength(0)
  expect(saves()).toHaveLength(1)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(saveButton(test)).toBeDisabled()
  expect(screen.getByText(staleNotice)).toBeVisible()
})

it.each(cases)('$name rejected POST leaves state unchanged and never offers committed recovery', async test => {
  const { local, server, actions, reads, saves, committedScores, initialColumns, cacheBefore } = await prepare(test, { rejectPost: true })
  const before = local.getState()
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(screen.getByText(postFailure)).toBeVisible())
  expect(saves()).toHaveLength(1)
  expect(reads()).toHaveLength(0)
  expect(local.getState()).toBe(before)
  expect(server()).toMatchObject({ dataRevision: 1, schemaRevision: 1, columns: initialColumns })
  expect(committedScores.size).toBe(0)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore)
  expect(actions.filter(fetchCodebookThunk.pending.match)).toHaveLength(0)
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(screen.queryByText(staleNotice)).toBeNull()
  expect(screen.queryByRole('button', { name: 'コードブックを再取得' })).toBeNull()
  expect(saveButton(test)).toBeEnabled()
})

it.each(cases)('$name retains neutral committed recovery when a newer read supersedes a retry, then accepts that current read', async test => {
  const { local, pendingReads, codebook, actions, reads, saves } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  fireEvent.click(retryButton())
  await waitFor(() => expect(reads()).toHaveLength(2))
  let newer!: ReturnType<typeof local.dispatch>
  act(() => { newer = local.dispatch(fetchCodebookThunk('synthetic')) })
  expect(reads()).toHaveLength(3)
  await act(async () => { pendingReads[1].reject(new Error('Displaced transport failure')) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(actions.filter(fetchCodebookThunk.rejected.match).at(-1)).toMatchObject({ payload: 'CODEBOOK_FETCH_SUPERSEDED' })
  expect(screen.getByText('列情報の更新を確認できませんでした。コードブックを再取得してください。')).toBeVisible()
  expect(screen.queryByText(/Displaced transport failure/)).toBeNull()
  expect(screen.getByText(committedNotice(`${test.name}1`))).toBeVisible()
  expect(document.querySelector('.ant-message-success')).toBeNull()
  await act(async () => { pendingReads[2].resolve(codebook()); await newer })
  await waitFor(() => expect(screen.getByText(savedNotice(test))).toBeVisible())
  expect(screen.queryByRole('button', { name: 'コードブックを再取得' })).toBeNull()
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
  expect(saves()).toHaveLength(1)
})

it.each(cases)('$name suppresses pending refresh recovery after installing another dataset', async test => {
  const { local, pendingReads, codebook, actions, reads, saves, initialColumns } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  const previous = codebook()
  act(() => {
    local.dispatch(datasetLoaded({ datasetId: 'replacement', name: 'Replacement fixture', rowIds, dataRevision: 7 }))
    local.dispatch(codebookReceived({ ...previous, datasetId: 'replacement', schemaRevision: 7, columns: initialColumns }))
  })
  await act(async () => { pendingReads[0].reject(new Error('Obsolete failure')) })
  expect(actions.filter(fetchCodebookThunk.rejected.match).at(-1)).toMatchObject({ payload: 'CODEBOOK_FETCH_SUPERSEDED' })
  expect(local.getState().selection).toMatchObject({ datasetId: 'replacement', dataRevision: 7 })
  expect(local.getState().codebook).toMatchObject({ datasetId: 'replacement', schemaRevision: 7, columns: initialColumns })
  expect(screen.queryByRole('button', { name: 'コードブックを再取得' })).toBeNull()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(screen.queryByText(/Obsolete failure|保存済み/)).toBeNull()
  expect(saves()).toHaveLength(1)
})

it.each(cases)('$name retires a failed receipt on same-dataset installation and ignores its pending retry completion', async test => {
  const { local, pendingReads, codebook, reads, saves } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  fireEvent.click(retryButton())
  await waitFor(() => expect(reads()).toHaveLength(2))
  const replacement = codebook()
  act(() => {
    local.dispatch(datasetLoaded({ datasetId: 'synthetic', name: 'New installation', rowIds, dataRevision: 2 }))
    local.dispatch(codebookReceived(replacement))
  })
  await act(async () => { pendingReads[1].resolve(replacement) })
  expect(screen.queryByRole('button', { name: 'コードブックを再取得' })).toBeNull()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(saves()).toHaveLength(1)
})

it.each(cases)('$name preserves workspace recovery across refit while suppressing old-result completion notices', async test => {
  const gate = deferred<void>()
  const { local, post, pendingReads, reads, saves, server, codebook, cacheBefore } = await prepare(test, { postGate: gate })
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(saves()).toHaveLength(1))
  fireEvent.click(screen.getByTestId(test.run))
  await waitFor(() => expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(2))
  await waitFor(() => expect(screen.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
  await act(async () => { gate.resolve() })
  expect(server().dataRevision).toBe(2)
  expect(reads()).toHaveLength(1)
  expect(pendingReads).toHaveLength(1)
  expect(local.getState().selection.dataRevision).toBe(2)
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(screen.getByText(committedNotice(`${test.name}1`))).toBeVisible()
  expect(screen.getByText(new RegExp(readFailure))).toBeVisible()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(local.getState().codebook.schemaRevision).toBe(1)
  fireEvent.click(retryButton())
  await waitFor(() => expect(reads()).toHaveLength(2))
  await act(async () => { pendingReads[1].resolve(codebook()) })
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(saveButton(test)).toBeDisabled()
  expect(screen.getByText(staleNotice)).toBeVisible()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(saves()).toHaveLength(1)
})

it.each(cases)('$name suppresses an obsolete retry notice after unmount', async test => {
  const { view, pendingReads, codebook, reads, saves } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  fireEvent.click(retryButton())
  await waitFor(() => expect(reads()).toHaveLength(2))
  view.unmount()
  await act(async () => { pendingReads[1].resolve(codebook()) })
  expect(document.querySelector('.ant-message-success')).toBeNull()
  expect(document.querySelector('.ant-message-error')).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(saves()).toHaveLength(1)
})

// Both accepted-read orderings keep the same operation alive until its receipt.
it.each(cases.flatMap(test => [false, true].map(advanceData => ({ ...test, advanceData }))))(
  '$name accepts a canonical read that arrives before the matching POST receipt (data already advanced: $advanceData)', async test => {
    const receiptGate = deferred<void>()
    const { local, pendingReads, codebook, actions, reads, saves } = await prepare(test, { receiptGate })
    fireEvent.click(saveButton(test))
    await waitFor(() => expect(saves()).toHaveLength(1))
    let canonical!: ReturnType<typeof local.dispatch>
    act(() => { canonical = local.dispatch(fetchCodebookThunk('synthetic')) })
    expect(reads()).toHaveLength(1)
    await act(async () => { pendingReads[0].resolve(codebook()); await canonical })
    if (test.advanceData) act(() => { local.dispatch(datasetValuesUpdated({ datasetId: 'synthetic', dataRevision: 2 })) })
    expect(local.getState().codebook.schemaRevision).toBe(2)
    expect(screen.queryByText(savedNotice(test))).toBeNull()
    await act(async () => { receiptGate.resolve() })
    await waitFor(() => expect(screen.getByText(savedNotice(test))).toBeVisible())
    expect(local.getState().selection.dataRevision).toBe(2)
    expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
    expect(reads()).toHaveLength(1)
    expect(saves()).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'コードブックを再取得' })).toBeNull()
    expect(saveButton(test)).toBeDisabled()
  })

// Observe the public busy flag directly: the actual pages deliberately keep a
// stale fit disabled, so their button cannot isolate settlement cleanup.
function PendingSaveControls({ owner, materialize }: { owner: object; materialize: () => Promise<ScoreSaveReceipt> }) {
  const save = useScoreSaveRefresh(owner)
  return <><Button disabled={save.saving} onClick={() => { void save.save('Saved_score', materialize, error => String(error)) }}>Save fixture</Button>{save.notice}</>
}

it('releases its own pending lock when a POST rejects after an unrelated revision change, without an obsolete error notice', async () => {
  const pending = deferred<ScoreSaveReceipt>()
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer },
    middleware: defaults => defaults({ serializableCheck: false }) })
  local.dispatch(datasetLoaded({ datasetId: 'synthetic', name: 'Lifecycle fixture', rowIds, dataRevision: 1 }))
  local.dispatch(codebookReceived({ datasetId: 'synthetic', schemaRevision: 1, columns: [column('A', 'nominal')],
    licenseText: '', licenseRevision: 1, multiResponseGroups: [] }))
  const materialize = vi.fn(() => pending.promise)
  render(<Provider store={local}><PendingSaveControls owner={{}} materialize={materialize} /></Provider>)
  const button = screen.getByRole('button', { name: 'Save fixture' })
  fireEvent.click(button)
  expect(button).toBeDisabled()
  act(() => { local.dispatch(datasetValuesUpdated({ datasetId: 'synthetic', dataRevision: 3 })) })
  expect(button).toBeDisabled()
  await act(async () => { pending.reject(new Error('Obsolete POST rejection')) })
  expect(button).toBeEnabled()
  expect(document.querySelector('.ant-message-error')).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(local.getState().selection.dataRevision).toBe(3)
  expect(materialize).toHaveBeenCalledTimes(1)
})
