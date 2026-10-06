import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { api, type CodebookColumn } from '../src/api/client'
import { datasetLoaded, datasetValuesUpdated, selectionApplied, globalObservationsSlice, globalVariablesSlice, observationScopeChanged,
  selectionReducer, store, variablesInitialized } from '../src/app/store'
import { codebookReadAccepted, codebookReceived, codebookSlice,
  fetchCodebookThunk } from '../src/features/dataset/codebookSlice'
import { provenanceReducer } from '../src/features/dataset/provenanceSlice'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'
import FactorAnalysisPage from '../src/features/models/FactorAnalysisPage'
import type { EFAResponse, EFAMaterializeResponse } from '../src/features/models/efaApi'
import { getColumnarCacheGeneration } from '../src/features/pcp/columnarCache'

// Committed-save recovery through real OLS/EFA controls, reducers and thunk.
// Actual page controls/messages, API wrappers, lifecycle, Redux and codebook
// thunk remain real. The transport commits a synthetic server before replying.
// This does not execute a statistical backend or establish physical storage.
vi.mock('../src/features/common/GraphPanel', async original => ({ ...await original<any>(),
  default: ({ children, controls }: any) => <div>{controls}{children}</div>,
  useGraphViewport: () => ({ logicalWidth: 600, logicalHeight: 400, scale: 1, zoom: null, dpr: 1, revision: 0 }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))
vi.mock('../src/features/models/LinearRegressionFigure', () => ({ default: () => null }))
vi.mock('../src/features/models/EfaScoreFigure', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))

const cases = [
  { name: 'OLS', Page: LinearRegressionPage, path: '/models/linear-regression',
    tab: '保存・出力', save: '表示結果の列へ保存', destination: 'LR_FITTED', sourceField: 'fitted',
    stale: '古い版の結果です（stale）。保存・予測・選択はできません。',
    fields: [['目的変数', ['Outcome']], ['数値説明変数', ['X1']]] },
  { name: 'EFA', Page: FactorAnalysisPage, path: '/models/factor-analysis',
    tab: '得点操作', save: '派生列保存', destination: 'efa_f1', sourceField: 'score:1',
    stale: '古い版の結果です。保存・予測・選択はできません。',
    fields: [['項目（必須・3つ以上）', ['X1 (X1)', 'X2 (X2)', 'X3 (X3)', 'X4 (X4)']]] },
] as const
type Case = typeof cases[number]
const rowIds = Array.from({ length: 12 }, (_, i) => `r${i + 1}`)
const scoreValues = rowIds.map((_, i) => (i - 5.5) / 4)
const readFailure = 'Only the post-commit codebook GET failed'
const postFailure = 'Materialization rejected before commit'
const committedNotice = (test: Case, name: string = test.destination, count = rowIds.length) =>
  `${name}は保存済みです${test.name === 'OLS' ? `（${count}行）` : ''}。`
const savedNotice = (test: Case, name: string = test.destination, count = rowIds.length) =>
  `${name}を保存しました${test.name === 'OLS' ? `（${count}行）` : ''}。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。`
const retryButton = () => {
  const button = screen.getByLabelText('コードブックを再取得', { selector: 'button' })
  expect(button).toBeVisible()
  return button
}
const setName = (test: Case, name: string) => fireEvent.change(screen.getByPlaceholderText(
  test.name === 'OLS' ? 'LR_FITTED' : '保存列名'), { target: { value: name } })
// Locate the real controls by their text without rescanning unrelated table cells.
const saveButton = (test: Case) => screen.getByText(test.save, { exact: true }).closest('button') as HTMLButtonElement
const runButton = () => within(document.querySelector('.analysis-run-row') as HTMLElement).getByRole('button', { name: /^実\s*行$/ })
// Each fixture mounts one analysis page; use its visible result navigation.
const resultTab = (name: string) => within(document.querySelector('.ant-tabs-nav') as HTMLElement)
  .getByRole('tab', { name, exact: true })

function column(name: string): CodebookColumn {
  return { columnId: `${name}-id`, name, label: name, scaleType: 'ratio', role: 'question',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function fitResponse(test: Case, body: any, fit: number) {
  const context = body.context
  const meta = { datasetId: context.datasetId, dataRevision: context.expectedDataRevision,
    schemaRevision: context.expectedSchemaRevision, resultState: 'current', scope: context.scope,
    scopeCount: rowIds.length, fitCount: rowIds.length, effectiveN: rowIds.length,
    excludedCount: 0, exclusionCounts: {}, weightApplied: false, weightType: null,
    weightColumn: null, algorithmVersion: 'synthetic-frontend-fixture', warnings: [] }
  if (test.name === 'OLS') {
    expect(body).toMatchObject({ target: 'Outcome-id', predictors: [{ columnId: 'X1-id', kind: 'numeric' }], intercept: true })
    return { status: 'success', method: 'linear_regression', resultId: `fit-${fit}`, meta, config: body,
      summary: { modelFormula: 'Outcome ~ X1', nDesignColumns: 2, rank: 2, conditionNumber: 2,
        covarianceMethod: 'classical', referenceDf: 10, residualDf: 10, rSquared: .9,
        rSquaredType: 'centered', adjustedRSquared: .89, rmse: .1 },
      details: { coefficients: [], vif: [] },
      capabilities: { rows: true, materialize: true, projection: true,
        materializeFitFields: ['fitted', 'residual'], materializePredictionFields: ['predicted'] }, unavailableReasons: {} }
  }
  // Explicit regression scores, four continuous items, identified one-factor
  // Pearson solution, and admissible non-boundary uniqueness. This does not use
  // the scoreMethod=none / rows=false setup fixture to manufacture a save path.
  expect(body).toMatchObject({ correlation: 'pearson', nFactors: 1, scoreMethod: 'regression',
    extraction: 'minres', parallelAnalysis: { enabled: false }, context: { weightMode: 'dataset' } })
  expect(body.variables).toEqual(['X1', 'X2', 'X3', 'X4'].map(name => ({
    columnId: `${name}-id`, measurement: 'continuous', treatment: 'continuous',
    categoryOrder: null, reverse: false, approximationAcknowledged: false })))
  const correlation = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => i === j ? 1 : .49))
  const response: EFAResponse = { status: 'success', method: 'efa', resultId: `fit-${fit}`, meta, config: body,
    capabilities: { rows: true, projection: true, materialize: true,
      selectionKinds: ['rectangle', 'row_ids'], exportTables: ['manifest', 'variables', 'rows'],
      materializeFitFields: ['score:1'], materializePredictionFields: ['score:1'] },
    summary: { computationStatus: 'converged', solutionStatus: 'admissible', nVariables: 4, nFactors: 1,
      modelDf: 2, objective: { id: 'minres', value: 0, offDiagonalSse: 0 }, rmsr: 0,
      totalCommunalityRatio: .49, inferenceStatus: 'not_implemented', scoreMethod: 'regression' },
    details: { variables: ['X1', 'X2', 'X3', 'X4'].map(name => ({ columnId: `${name}-id`, label: name })),
      factorIds: ['F1'], factorLabels: ['F1'], pattern: [[.7], [.7], [.7], [.7]],
      structure: [[.7], [.7], [.7], [.7]], factorCorrelation: [[1]], communality: [.49, .49, .49, .49],
      uniqueness: [.51, .51, .51, .51], sampleCorrelation: correlation, reproducedCorrelation: correlation,
      residualCorrelation: correlation.map(row => row.map(() => 0)), thresholds: null,
      parallelAnalysis: { status: 'disabled', observedEigenvalues: null, referenceQuantiles: null,
        suggestedFactors: null, reasonCode: null }, factorComparisons: [], distributionProfiles: [],
      sensitivityAnalysis: null, solutionDiagnostics: [] }, unavailableReasons: {} }
  return response
}

function mount(test: Case, options: { rejectPost?: boolean; postGate?: ReturnType<typeof deferred<void>>;
  receiptGate?: ReturnType<typeof deferred<void>> } = {}) {
  const initialColumns = ['Outcome', 'X1', 'X2', 'X3', 'X4'].map(column)
  let server = { dataRevision: 1, schemaRevision: 1, columns: initialColumns }
  const committedScores = new Map<string, number[]>()
  const transportEvents: string[] = []
  const actions: any[] = []
  const pendingReads: ReturnType<typeof deferred<any>>[] = []
  let fit = 0
  const receipts: unknown[] = []
  const codebook = () => structuredClone({ datasetId: 'synthetic', schemaRevision: server.schemaRevision,
    licenseText: '', licenseRevision: 1, columns: server.columns, multiResponseGroups: [],
    weightConfig: null, surveyDesign: null })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    if (path === test.path) return fitResponse(test, body, ++fit) as any
    if (path.endsWith('/predict')) return { predictionId: 'prediction-1',
      summary: { requestedCount: 2, successfulPredictions: 2 }, meta: {} } as any
    if (path.endsWith('/materialize')) {
      transportEvents.push('POST materialize received')
      if (options.postGate) await options.postGate.promise
      expect(body.context).toMatchObject({ datasetId: 'synthetic', expectedDataRevision: server.dataRevision,
        expectedSchemaRevision: server.schemaRevision })
      const resultId = path.split('/')[2]
      const field = body.source === 'fit' ? test.sourceField : 'predicted'
      expect(body.columns).toEqual([test.name === 'OLS'
        ? { sourceField: field, name: body.columns[0].name }
        : { source: field, name: body.columns[0].name }])
      expect(body.idempotencyKey).toBe(test.name === 'OLS'
        ? `lr-${resultId}-${body.source}-${field}-${body.columns[0].name}` : `efa-${resultId}-${field}`)
      if (options.rejectPost) {
        transportEvents.push('POST materialize rejected without commit')
        throw new Error(postFailure)
      }
      const name = body.columns[0].name
      if (server.columns.some(c => c.name === name)) throw new Error('COLUMN_ALREADY_EXISTS')
      const saved = { ...column(name), scaleType: 'interval' as const, role: 'other' as const }
      const writtenRowIds = body.context.scope === 'selected' ? body.context.selectedRowIds : rowIds
      committedScores.set(name, writtenRowIds.map((id: string) => scoreValues[rowIds.indexOf(id)]))
      // Commit both revisions and values before exposing the receipt to the UI.
      server = { dataRevision: server.dataRevision + 1, schemaRevision: server.schemaRevision + 1,
        columns: [...server.columns, saved] }
      transportEvents.push('POST materialize committed data=2 schema=2')
      const receipt = test.name === 'EFA' ? {
        status: 'success', resultId, idempotentReplay: false,
        columns: [{ source: field, name }], datasetId: 'synthetic',
        dataRevision: server.dataRevision, schemaRevision: server.schemaRevision,
      } satisfies EFAMaterializeResponse : {
        operationId: 'synthetic-operation', datasetId: 'synthetic', idempotentReplay: false,
        createdColumns: [{ columnId: saved.columnId, name, label: name, sourceField: field }],
        writtenRowCount: writtenRowIds.length, dataRevision: server.dataRevision, schemaRevision: server.schemaRevision,
      }
      receipts.push(receipt)
      if (options.receiptGate) await options.receiptGate.promise
      return receipt as any
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
    if (path === '/datasets/synthetic/provenance') return { datasetId: 'synthetic', dataRevision: server.dataRevision,
      schemaRevision: server.schemaRevision, maskRevision: 0, steps: [], canUndo: false, canRedo: false,
      currentOperationId: null, cursorOperationId: null, rawDataRevision: 1 } as any
    if (path === '/datasets/synthetic') return { dataRevision: server.dataRevision, schemaRevision: server.schemaRevision } as any
    if (path.startsWith('/analysis-results/') && path.includes('/rows?')) return {
      rows: rowIds.map((rowId, index) => test.name === 'EFA' ? { rowId, scores: [scoreValues[index]] }
        : { rowId, predicted: scoreValues[index], predictionStatus: 'ok', fitted: scoreValues[index], observed: scoreValues[index] + .1, residual: .1,
          leverageTotal: 1 / 6, leveragePerReplica: 1 / 6, studentizedResidual: .1, cooksDistance: .01 }),
      total: rowIds.length, nextOffset: null,
    } as any
    throw new Error(`Unexpected GET ${path}`)
  })
  const base = store.getState()
  const local = configureStore({ reducer: {
    selection: selectionReducer, codebook: codebookSlice.reducer,
    globalVariables: globalVariablesSlice.reducer, globalObservations: globalObservationsSlice.reducer,
    pcp: () => base.pcp, provenance: provenanceReducer,
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
    pendingReads, receipts, transportEvents, saves: () => post.mock.calls.filter(([path]) => path.endsWith('/materialize')),
    reads: () => get.mock.calls.filter(([path]) => path === '/datasets/synthetic/codebook') }
}

// Actual AntD portal options, without native-select substitution.
async function chooseInline(label: string, names: readonly string[]) {
  const input = screen.getByLabelText(label, { selector: 'input[role="combobox"]', exact: true })
  expect(input).toHaveAccessibleName(label)
  expect(input).toBeEnabled()
  // AntD may hide its native input; the actual selector must remain visible.
  expect(input.closest('.ant-select-selector')).toBeVisible()
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
function savePanel(test: Case) {
  return document.getElementById(resultTab(test.tab).getAttribute('aria-controls')!)!
}
function expectSelected(input: HTMLElement, value: string) {
  expect(input.closest('.ant-select')!.querySelector('.ant-select-selection-item')).toHaveTextContent(value)
}
async function chooseSavedOption(input: HTMLElement, current: string, next: string, steps = 1) {
  expect(input).toBeInstanceOf(HTMLInputElement)
  expect(input).toBeEnabled()
  expect(input.closest('.ant-select-selector')).toBeVisible()
  fireEvent.mouseDown(input)
  // rc-select reuses TEST_OR_SSR IDs in JSDOM; ignore earlier hidden portals.
  const activeOption = () => document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    ?.querySelector(`[id="${input.getAttribute('aria-activedescendant')}"]`)
  await waitFor(() => expect(activeOption()).toHaveAccessibleName(current))
  for (let step = 0; step < steps; step++) {
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, which: 40 })
    fireEvent.keyUp(input, { key: 'ArrowDown', keyCode: 40, which: 40 })
  }
  expect(activeOption()).toHaveAccessibleName(next)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 })
  fireEvent.keyUp(input, { key: 'Enter', keyCode: 13, which: 13 })
  await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'))
  expectSelected(input, next)
}
async function prepare(test: Case, options: Parameters<typeof mount>[1] = {}) {
  const fixture = mount(test, options)
  for (const [label, names] of test.fields) await chooseInline(label, names)
  if (test.name === 'EFA') {
    const settings = screen.getByText('分析方法・詳細設定', { selector: '.analysis-settings-title' }).closest('details')!
    fireEvent.click(settings.querySelector('summary')!)
    await chooseInline('得点', ['regression'])
    fireEvent.click(within(settings).getByRole('checkbox', { name: /平行分析を行う/ }))
  }
  const run = runButton()
  expect(run).toBeEnabled()
  fireEvent.click(run)
  await waitFor(() => expect(fixture.post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1))
  await waitFor(() => expect(run).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(resultTab(test.tab))
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
  // AntD static messages have a separate React root and scheduled destruction.
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
})


it('OLS names real saved-result INPUTs through field selection and destination restore without saving', async () => {
  const test = cases[0]
  const { post, saves, reads, local, server, initialColumns, cacheBefore } = await prepare(test)
  const panel = savePanel(test)
  expect(panel).toBeVisible()
  const source = within(panel).queryByRole('combobox', { name: '重回帰の保存元', exact: true })
  const field = within(panel).queryByRole('combobox', { name: '重回帰の保存項目', exact: true })
  const destination = within(panel).queryByRole('textbox', { name: '重回帰の保存列名', exact: true })
  // Report every missing name on the unchanged production baseline in one fit.
  expect.soft(source, '重回帰の保存元 reaches its actual INPUT').toBeInstanceOf(HTMLInputElement)
  expect.soft(field, '重回帰の保存項目 reaches its actual INPUT').toBeInstanceOf(HTMLInputElement)
  expect.soft(destination, '重回帰の保存列名 reaches its actual INPUT').toBeInstanceOf(HTMLInputElement)
  if (!source || !field || !destination) return
  expect(source).toHaveAccessibleName('重回帰の保存元')
  expect(field).toHaveAccessibleName('重回帰の保存項目')
  expect(destination).toHaveAccessibleName('重回帰の保存列名')
  expect(destination).toBeVisible(); expect(destination).toBeEnabled()
  expect(destination).toHaveValue('LR_FITTED')
  expect(destination).toHaveAttribute('placeholder', 'LR_FITTED')
  expectSelected(source, 'fit'); expectSelected(field, 'fitted')
  await chooseSavedOption(source, 'fit', 'fit', 0)
  await chooseSavedOption(field, 'fitted', 'residual')
  fireEvent.change(destination, { target: { value: 'OLS_residual_draft' } })
  expect(destination).toHaveValue('OLS_residual_draft')
  expect(destination).toHaveAccessibleName('重回帰の保存列名')
  await chooseSavedOption(field, 'residual', 'fitted')
  fireEvent.change(destination, { target: { value: 'LR_FITTED' } })
  expect(destination).toHaveValue('LR_FITTED')
  expect(within(panel).getByRole('combobox', { name: '重回帰の保存元', exact: true })).toBe(source)
  expect(within(panel).getByRole('combobox', { name: '重回帰の保存項目', exact: true })).toBe(field)
  expect(within(panel).getByRole('textbox', { name: '重回帰の保存列名', exact: true })).toBe(destination)
  expectSelected(source, 'fit'); expectSelected(field, 'fitted')
  expect(saveButton(test)).toBeEnabled()
  expect(post.mock.calls.map(([path]) => path)).toEqual([test.path])
  expect(saves()).toHaveLength(0); expect(reads()).toHaveLength(0)
  expect(server()).toEqual({ dataRevision: 1, schemaRevision: 1, columns: initialColumns })
  expect(local.getState().selection.dataRevision).toBe(1)
  expect(local.getState().codebook.schemaRevision).toBe(1)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore)
})

// Keep the uninterrupted commit/failure/retry flow within its measured 5–6s
// runtime plus runner variation; other cases retain the ordinary budget.
it.each(cases)('$name keeps the captured committed receipt through failed GET retries and sends no second POST', async test => {
  const gate = deferred<void>()
  const { local, pendingReads, server, codebook, actions, reads, saves, committedScores,
    initialColumns, cacheBefore, receipts } = await prepare(test, { postGate: gate })
  const submittedName = `${test.name}_committed`
  setName(test, submittedName)
  // Saving still uses the completed fit scope even after the shared scope changes.
  act(() => {
    local.dispatch(selectionApplied({ rowIds: ['r2', 'r4'], operation: 'replace' }))
    local.dispatch(observationScopeChanged('selected'))
  })
  act(() => { fireEvent.click(saveButton(test)); fireEvent.click(saveButton(test)) })
  expect(saves()).toHaveLength(1)
  expect(saveButton(test)).toBeDisabled()
  expect(saveButton(test)).toHaveClass('ant-btn-loading')
  setName(test, 'Next_score')
  await act(async () => { gate.resolve() })
  await waitFor(() => expect(reads()).toHaveLength(1))
  expect(saves()[0][1]).toMatchObject({ source: 'fit', context: { scope: 'all',
    expectedDataRevision: 1, expectedSchemaRevision: 1 }, columns: [test.name === 'OLS'
    ? { sourceField: 'fitted', name: submittedName } : { source: 'score:1', name: submittedName }],
    idempotencyKey: test.name === 'OLS' ? `lr-fit-1-fit-fitted-${submittedName}` : 'efa-fit-1-score:1' })
  expect(server()).toMatchObject({ dataRevision: 2, schemaRevision: 2 })
  expect(committedScores.get(submittedName)).toEqual(scoreValues)
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, columns: initialColumns, isLoading: true })
  expect(screen.getByText(committedNotice(test, submittedName))).toBeVisible()
  if (test.name === 'EFA') {
    expect(receipts[0]).not.toHaveProperty('writtenRowCount')
    expect(receipts[0]).not.toHaveProperty('createdColumns')
    expect(receipts[0]).toHaveProperty('columns', [{ source: 'score:1', name: submittedName }])
  }
  expect(document.querySelector('.ant-message-success')).toBeNull()
  expect(retryButton()).toBeDisabled()
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)

  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(screen.getByText(new RegExp(readFailure))).toBeVisible()
  expect(actions.find(fetchCodebookThunk.rejected.match)).toMatchObject({ error: { message: readFailure },
    meta: { rejectedWithValue: false, aborted: false } })
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(0)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, columns: initialColumns, isLoading: false })
  expect(screen.getByText(committedNotice(test, submittedName))).toBeVisible()
  expect(document.querySelector('.ant-message-error')).toBeNull()
  expect(saveButton(test)).toBeDisabled()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
  expect(screen.getByText(test.stale)).toBeVisible()

  // Recovery remains outside the result tabs, including EFA's score tab.
  fireEvent.click(resultTab(test.name === 'OLS' ? '係数' : '負荷量・残差'))
  expect(retryButton()).toBeVisible()
  act(() => { fireEvent.click(retryButton()); fireEvent.click(retryButton()) })
  expect(reads()).toHaveLength(2)
  expect(retryButton()).toBeDisabled()
  await act(async () => { pendingReads[1].reject(new Error('Retry GET failed')) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(screen.getByText(/Retry GET failed/)).toBeVisible()
  expect(screen.getByText(committedNotice(test, submittedName))).toBeVisible()
  fireEvent.click(retryButton())
  expect(reads()).toHaveLength(3)
  await act(async () => { pendingReads[2].resolve(codebook()) })
  await waitFor(() => expect(screen.getByText(savedNotice(test, submittedName))).toBeVisible())
  expect(screen.queryByLabelText('コードブックを再取得', { selector: 'button' })).toBeNull()
  expect(screen.queryByText(committedNotice(test, submittedName))).toBeNull()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isLoading: false })
  expect(local.getState().codebook.columns.map(c => c.name)).toContain(submittedName)
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
  expect(saves()).toHaveLength(1)
  expect(committedScores.get(submittedName)).toEqual(scoreValues)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  fireEvent.click(resultTab(test.tab))
  expect(saveButton(test)).toBeDisabled()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
  expect(screen.getByText(test.stale)).toBeVisible()
}, 10000)

it.each(cases)('$name reports canonical availability only after the accepted canonical GET', async test => {
  const { local, pendingReads, codebook, actions, reads, saves, cacheBefore } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  expect(screen.getByText(committedNotice(test))).toBeVisible()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(saveButton(test)).toHaveClass('ant-btn-loading')
  await act(async () => { pendingReads[0].resolve(codebook()) })
  await waitFor(() => expect(screen.getByText(savedNotice(test))).toBeVisible())
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isLoading: false })
  expect(local.getState().codebook.columns.map(c => c.name)).toContain(test.destination)
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(1)
  expect(actions.filter(fetchCodebookThunk.rejected.match)).toHaveLength(0)
  expect(screen.queryByLabelText('コードブックを再取得', { selector: 'button' })).toBeNull()
  expect(saves()).toHaveLength(1)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(saveButton(test)).toBeDisabled()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
  expect(screen.getByText(test.stale)).toBeVisible()
})

it.each(cases)('$name rejected POST preserves state and releases Save without offering committed recovery', async test => {
  const { local, server, actions, reads, saves, committedScores, initialColumns, cacheBefore } =
    await prepare(test, { rejectPost: true })
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
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(screen.queryByLabelText('コードブックを再取得', { selector: 'button' })).toBeNull()
  expect(screen.queryByText(test.stale)).toBeNull()
  expect(saveButton(test)).toBeEnabled()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
})

it.each(cases)('$name retains workspace recovery after refit but suppresses the old result completion', async test => {
  const gate = deferred<void>()
  const { local, post, pendingReads, reads, saves, codebook, cacheBefore } = await prepare(test, { postGate: gate })
  fireEvent.click(saveButton(test))
  expect(saves()).toHaveLength(1)
  fireEvent.click(runButton())
  await waitFor(() => expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(2))
  await waitFor(() => expect(runButton()).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(resultTab(test.tab))
  await act(async () => { gate.resolve() })
  await waitFor(() => expect(reads()).toHaveLength(1))
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  expect(screen.getByText(committedNotice(test))).toBeVisible()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  fireEvent.click(retryButton())
  await act(async () => { pendingReads[1].resolve(codebook()) })
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(screen.queryByLabelText('コードブックを再取得', { selector: 'button' })).toBeNull()
  expect(saveButton(test)).toBeDisabled()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
  expect(saves()).toHaveLength(1)
})

it.each(cases)('$name retires recovery when the same dataset is reinstalled during retry', async test => {
  const { local, pendingReads, reads, saves, codebook } = await prepare(test)
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  fireEvent.click(retryButton())
  const installation = local.getState().selection.revision
  const replacement = codebook()
  act(() => {
    local.dispatch(datasetLoaded({ datasetId: 'synthetic', name: 'Reinstalled fixture', rowIds, dataRevision: 2 }))
    local.dispatch(codebookReceived(replacement))
  })
  expect(local.getState().selection.revision).toBeGreaterThan(installation)
  await act(async () => { pendingReads[1].resolve(replacement) })
  expect(screen.queryByLabelText('コードブックを再取得', { selector: 'button' })).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(saves()).toHaveLength(1)
})

it.each(cases)('$name ignores a receipt overtaken by an unrelated data revision', async test => {
  const gate = deferred<void>()
  const { local, saves, reads, server, cacheBefore } = await prepare(test, { receiptGate: gate })
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(server().dataRevision).toBe(2))
  act(() => local.dispatch(datasetValuesUpdated({ datasetId: 'synthetic', dataRevision: 3 })))
  await act(async () => { gate.resolve() })
  expect(local.getState().selection.dataRevision).toBe(3)
  expect(reads()).toHaveLength(0)
  expect(saves()).toHaveLength(1)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore)
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
})

it.each(cases)('$name accepts an already reconciled commit without a redundant GET after its delayed receipt', async test => {
  const gate = deferred<void>()
  const { local, pendingReads, reads, saves, server, codebook, cacheBefore } = await prepare(test, { receiptGate: gate })
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(server().dataRevision).toBe(2))
  act(() => local.dispatch(datasetValuesUpdated({ datasetId: 'synthetic', dataRevision: 2 })))
  let canonical!: Promise<unknown>
  act(() => { canonical = local.dispatch(fetchCodebookThunk('synthetic')) })
  await act(async () => { pendingReads[0].resolve(codebook()); await canonical })
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(screen.queryByText(savedNotice(test))).toBeNull()
  await act(async () => { gate.resolve() })
  await waitFor(() => expect(screen.getByText(savedNotice(test))).toBeVisible())
  expect(reads()).toHaveLength(1)
  expect(saves()).toHaveLength(1)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(screen.queryByLabelText('コードブックを再取得', { selector: 'button' })).toBeNull()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
})

it.each(cases)('$name suppresses a rejected POST from the old result and releases its lock after refit', async test => {
  const gate = deferred<void>()
  const { post, reads, saves, cacheBefore } = await prepare(test, { postGate: gate, rejectPost: true })
  fireEvent.click(saveButton(test))
  fireEvent.click(runButton())
  await waitFor(() => expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(2))
  await waitFor(() => expect(runButton()).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(resultTab(test.tab))
  await act(async () => { gate.resolve() })
  expect(screen.queryByText(postFailure)).toBeNull()
  expect(screen.queryByText(/保存済み/)).toBeNull()
  expect(reads()).toHaveLength(0)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore)
  expect(saveButton(test)).toBeEnabled()
  expect(saveButton(test)).not.toHaveClass('ant-btn-loading')
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(saves()).toHaveLength(2))
  await waitFor(() => expect(screen.getByText(postFailure)).toBeVisible())
  expect(saves()[1][0]).toBe('/analysis-results/fit-2/materialize')
})

it('OLS preserves the prediction source, captured selected scope, field, name and full key through recovery', async () => {
  const test = cases[0]
  const { local, post, pendingReads, reads, saves, codebook, committedScores, cacheBefore } = await prepare(test)
  act(() => {
    local.dispatch(selectionApplied({ rowIds: ['r2', 'r4'], operation: 'replace' }))
    local.dispatch(observationScopeChanged('selected'))
  })
  const predictionTab = resultTab('予測・評価')
  fireEvent.click(predictionTab)
  const predictionPanel = document.getElementById(predictionTab.getAttribute('aria-controls')!)!
  expect(predictionPanel).toBeVisible()
  fireEvent.click(within(predictionPanel).getByRole('button', { name: '予測・評価' }))
  await waitFor(() => expect(screen.getByText('成功2/2')).toBeVisible())
  const prediction = post.mock.calls.find(([path]) => path.endsWith('/predict'))![1] as any
  expect(prediction.context).toMatchObject({ datasetId: 'synthetic', expectedDataRevision: 1,
    expectedSchemaRevision: 1, scope: 'selected', selectedRowIds: ['r2', 'r4'] })
  act(() => {
    local.dispatch(selectionApplied({ rowIds: ['r8'], operation: 'replace' }))
    local.dispatch(observationScopeChanged('all'))
  })
  fireEvent.click(resultTab(test.tab))
  const panel = savePanel(test)
  const source = within(panel).getByRole('combobox', { name: '重回帰の保存元', exact: true })
  const field = within(panel).getByRole('combobox', { name: '重回帰の保存項目', exact: true })
  const destination = within(panel).getByRole('textbox', { name: '重回帰の保存列名', exact: true })
  expect(destination).toBeInstanceOf(HTMLInputElement)
  expectSelected(source, '予測:predicti'); expectSelected(field, 'predicted')
  await chooseSavedOption(source, '予測:predicti', 'fit')
  expectSelected(field, 'fitted')
  await chooseSavedOption(source, 'fit', '予測:predicti')
  expectSelected(field, 'predicted')
  expect(within(panel).getByRole('combobox', { name: '重回帰の保存元', exact: true })).toBe(source)
  expect(within(panel).getByRole('combobox', { name: '重回帰の保存項目', exact: true })).toBe(field)
  expect(within(panel).getByRole('textbox', { name: '重回帰の保存列名', exact: true })).toBe(destination)
  expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1)
  expect(post.mock.calls.filter(([path]) => path.endsWith('/predict'))).toHaveLength(1)
  expect(saves()).toHaveLength(0); expect(reads()).toHaveLength(0)
  setName(test, 'OLS_prediction')
  expect(destination).toHaveValue('OLS_prediction')
  expect(destination).toHaveAccessibleName('重回帰の保存列名')
  fireEvent.click(saveButton(test))
  await waitFor(() => expect(reads()).toHaveLength(1))
  setName(test, 'Next_prediction')
  expect(saves()[0]).toEqual(['/analysis-results/fit-1/materialize', {
    context: prediction.context, source: 'prediction-1', columns: [{ sourceField: 'predicted', name: 'OLS_prediction' }],
    idempotencyKey: 'lr-fit-1-prediction-1-predicted-OLS_prediction',
  }])
  expect(committedScores.get('OLS_prediction')).toEqual([scoreValues[1], scoreValues[3]])
  expect(screen.getByText(committedNotice(test, 'OLS_prediction', 2))).toBeVisible()
  await act(async () => { pendingReads[0].reject(new Error(readFailure)) })
  await waitFor(() => expect(retryButton()).toBeEnabled())
  fireEvent.click(retryButton())
  await act(async () => { pendingReads[1].resolve(codebook()) })
  await waitFor(() => expect(screen.getByText(savedNotice(test, 'OLS_prediction', 2))).toBeVisible())
  expect(local.getState().codebook.schemaRevision).toBe(2)
  expect(saves()).toHaveLength(1)
  expect(reads()).toHaveLength(2)
  expect(getColumnarCacheGeneration()).toBe(cacheBefore + 1)
  expect(saveButton(test)).toBeDisabled()
})
