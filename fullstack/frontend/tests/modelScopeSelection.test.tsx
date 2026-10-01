import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import CorrespondenceAnalysisPage from '../src/features/models/CorrespondenceAnalysisPage'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import FamdPage from '../src/features/models/FamdPage'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'

function SelectInput(props: any) {
  return <select aria-label={props['aria-label'] ?? props.placeholder ?? `setting-${props.value}`} multiple={props.mode === 'multiple'}
    value={props.value ?? (props.mode === 'multiple' ? [] : '')} onChange={event => props.onChange?.(props.mode === 'multiple'
      ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
    {props.mode !== 'multiple' && <option value="">選択</option>}
    {props.options?.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}
vi.mock('antd', async original => ({ ...await original<any>(), Select: (props: any) => <SelectInput {...props} />,
  Table: () => <div data-testid="result-table" /> }))
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <SelectInput {...props} /> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children, controls }: any) => <div>{controls}{children}</div>,
  useGraphViewport: () => ({ logicalWidth: 600, logicalHeight: 400, scale: 1, zoom: null, dpr: 1, revision: 0 }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff' }) }))
const brushSelection = vi.hoisted(() => ({ operation: 'add' as 'add' | 'replace' | 'subtract' | 'toggle' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: () => brushSelection.operation }))
vi.mock('../src/features/models/caFigure', () => ({ default: ({ onToggle }: any) => <button data-testid="ca-point" onClick={() => onToggle('cat-a')}>CA point</button> }))
vi.mock('../src/features/models/McaFigure', async original => ({ ...await original<any>(), default: ({ onToggle, testId, points }: any) =>
  <button data-testid={testId} onClick={() => onToggle(points[0]?.id ?? 'r2')}>MCA point</button> }))
vi.mock('../src/features/models/FamdFigure', async original => ({ ...await original<any>(), default: ({ onToggle, testId, points }: any) =>
  <button data-testid={testId} onClick={() => onToggle(points[0]?.id ?? 'r2')}>FAMD point</button> }))
vi.mock('../src/features/models/LinearRegressionFigure', () => ({ default: ({ onToggle, onBrush, points }: any) => <div>
  <button data-testid="lr-point" onClick={() => onToggle(points[0]?.rowId ?? 'r2')}>LR point</button>
  <button data-testid="lr-brush" onClick={() => onBrush({ x: [-2, 2], y: [-2, 2] })}>LR brush</button>
</div> }))

const rowIds = Array.from({ length: 12 }, (_, i) => `r${i + 1}`)
const scopes = { all: rowIds, active: rowIds.slice(0, 8), selected: ['r2', 'r4'], sampled: ['r1', 'r5', 'r9'] }
const cases = [
  { name: 'CA', Page: CorrespondenceAnalysisPage, path: '/models/ca', run: 'ca-run', point: 'ca-point', columns: [['行変数', ['A']], ['列変数', ['B']]] },
  { name: 'MCA', Page: MultipleCorrespondencePage, path: '/models/mca', run: 'mca-run', point: 'mca-individual-svg', columns: [['nominal/ordinalを選択', ['A', 'B']]] },
  { name: 'FAMD', Page: FamdPage, path: '/models/famd', run: 'famd-run', point: 'famd-individual-svg', columns: [['interval/ratioを選択', ['X']], ['nominal/ordinalを選択', ['A']]] },
  { name: 'LR', Page: LinearRegressionPage, path: '/models/linear-regression', run: 'lr-run', point: 'lr-point', columns: [['目的変数を選択', ['Outcome']], ['数値を選択', ['X']]] },
] as const
function response(path: string, body: any, id = 'fit-1'): any {
  const c = body.context, members = c.scope === 'all' ? rowIds : c.activeRowIds ?? c.selectedRowIds ?? c.sampledRowIds ?? []
  return { status: 'ready', resultId: id, method: path, config: { input: body.input },
    meta: { datasetId: c.datasetId, dataRevision: c.expectedDataRevision, schemaRevision: c.expectedSchemaRevision, resultState: 'ready',
      scope: c.scope, scopeCount: members.length, fitCount: members.length, effectiveN: members.length, excludedCount: 0,
      exclusionCounts: {}, analysisUnit: 'respondent', warnings: [], weightApplied: false },
    summary: { rank: 2, totalInertia: 1, eigenvalues: [.6, .4], inertiaRatio: [.6, .4], cumulativeInertiaRatio: [.6, 1],
      rawInertiaRatio: [.6, .4], rawCumulativeInertiaRatio: [.6, 1], nVariables: 2, nCategories: 2, nNumericVariables: 1, nCategoricalVariables: 1,
      pearson: { statistic: 1, df: 1, pValue: .3, status: 'available' }, tableTotal: members.length,
      modelFormula: 'Outcome ~ X', rSquared: .9, rmse: .1 },
    details: { rowCategories: [], columnCategories: [], omittedCategories: [], table: [], mapScaling: 'symmetric',
      variables: [], categories: [], numericVariables: [], categoricalVariables: [], variableRelation: [], maDiagnostics: [],
      coefficients: [], vif: [] },
    capabilities: { materializeFitFields: ['fitted'], materializePredictionFields: ['predicted'] }, unavailableReasons: {},
  }
}
const post = vi.fn(), get = vi.fn()
beforeEach(() => {
  brushSelection.operation = 'add'
  post.mockReset(); get.mockReset()
  vi.spyOn(api, 'post').mockImplementation(post); vi.spyOn(api, 'get').mockImplementation(get)
  post.mockImplementation(async (path: string, body: any) => {
    if (path.startsWith('/models/')) return response(path, body)
    if (path.endsWith('/select')) return { rowIds: ['r2'], matchedCount: 1, contextIntersectionCount: 1, selectionLabel: 'original result' }
    if (path.endsWith('/export')) return { payload: '{"rows":[]}', nextOffset: null }
    if (path.endsWith('/predict')) return { predictionId: 'prediction-1', summary: { requestedCount: body.context.scope === 'all' ? 12 : 2,
      successfulPredictions: body.context.scope === 'all' ? 12 : 2 }, meta: {} }
    if (path.endsWith('/materialize')) throw new Error('captured-save-context')
    throw new Error(`Unexpected POST ${path}`)
  })
  get.mockImplementation(async (path: string) => path.startsWith('/datasets/')
    ? { dataRevision: 1, schemaRevision: 1 }
    : { rows: [{ rowId: 'r2', coordinates: [1, 2], fitted: 1, observed: 1, residual: 0, predictionStatus: 'ok' }], total: 1, nextOffset: null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function setup(test: typeof cases[number], scope: keyof typeof scopes = 'selected') {
  const base = store.getState(), columns = ['Outcome', 'X', 'A', 'B'].map(name => ({ name, columnId: name, label: name,
    role: 'question', scaleType: ['A', 'B'].includes(name) ? 'nominal' : 'ratio', valueLabels: {}, categoryOrder: [] }))
  const initial: any = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1,
    allRowIds: rowIds, activeRowIds: scopes.active, selectedRowIds: scopes.selected },
    globalObservations: { ...base.globalObservations, totalRowIds: rowIds, activeRowIds: scopes.active, selectedRowIds: scopes.selected,
      scopeMode: scope, sampling: { ...base.globalObservations.sampling, sampledRowIds: scopes.sampled } },
    globalVariables: { ...base.globalVariables, allVariables: columns.map(c => c.name), activeEntities: columns.map(c => ({ kind: 'column', columnId: c.name })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, isLoading: false, columns },
  }
  const local = configureStore({ reducer: (state = initial, action: any) => {
    if (action.type === 'test/scope') return { ...state, globalObservations: { ...state.globalObservations, scopeMode: action.payload } }
    if (action.type === 'test/selection' || action.type === 'selection/selectionApplied') {
      const next = action.type === 'test/selection' ? action.payload : [...new Set([...state.selection.selectedRowIds, ...action.payload.rowIds])]
      return { ...state, selection: { ...state.selection, selectedRowIds: next }, globalObservations: { ...state.globalObservations, selectedRowIds: next } }
    }
    if (action.type === 'test/dataset') return { ...state, selection: { ...state.selection, datasetId: action.payload },
      codebook: { ...state.codebook, datasetId: action.payload } }
    if (action.type === 'test/revision') return { ...state, selection: { ...state.selection, dataRevision: 2 } }
    if (action.type === 'test/variables') return { ...state, globalVariables: { ...state.globalVariables,
      activeEntities: action.payload.map((columnId: string) => ({ kind: 'column', columnId })) } }
    return state
  }, middleware: m => m({ serializableCheck: false }) })
  const view = render(<Provider store={local}><test.Page /></Provider>)
  for (const [label, values] of test.columns) {
    const select = view.getByLabelText(label) as HTMLSelectElement
    Array.from(select.options).forEach(option => { option.selected = (values as readonly string[]).includes(option.value) })
    fireEvent.change(select)
  }
  const run = async () => {
    fireEvent.click(view.getByTestId(test.run))
    await waitFor(() => expect(post.mock.calls.some(([path]) => path === test.path)).toBe(true))
    await waitFor(() => expect(view.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
  }
  return { view, local, run }
}
const contextFor = (path: string) => post.mock.calls.find(([p]) => p === path)![1].context
const selectCalls = () => post.mock.calls.filter(([path]) => path.endsWith('/select'))

for (const test of cases) {
  for (const scope of Object.keys(scopes) as (keyof typeof scopes)[]) it(`${test.name} uses only shared ${scope} rows on Run`, async () => {
    const { view, run } = setup(test, scope)
    expect(post).not.toHaveBeenCalled()
    await run()
    const context = contextFor(test.path)
    expect(context.scope).toBe(scope)
    const fields = Object.keys(context).filter(key => key.endsWith('RowIds') || key === 'rowIds')
    expect(fields).toEqual(scope === 'all' ? [] : [`${scope}RowIds`])
    if (scope !== 'all') expect(context[`${scope}RowIds`]).toEqual(scopes[scope])
    expect(view.queryByRole('radio', { name: 'Selected' })).toBeNull()
    expect(view.queryByRole('option', { name: 'Sampled' })).toBeNull()
  })
  it(`${test.name} keeps empty Selected explicit instead of expanding to All`, async () => {
    const { local, run } = setup(test)
    act(() => local.dispatch({ type: 'test/selection', payload: [] }))
    await run()
    expect(contextFor(test.path)).toMatchObject({ scope: 'selected', selectedRowIds: [] })
  })
  it(`${test.name} marks equal-count membership changes dirty and resolves selections against the saved population`, async () => {
    const { view, local, run } = setup(test)
    await run()
    if (test.name !== 'CA') await waitFor(() => expect(get.mock.calls.some(([path]) => path.includes('/rows?'))).toBe(true))
    const dispatch = vi.spyOn(local, 'dispatch')
    act(() => local.dispatch({ type: 'test/selection', payload: ['r3', 'r6'] }))
    expect(view.getByText(/対象または設定が変更されています/)).toBeInTheDocument()
    for (let i = 0; i < 2; i++) {
      if (test.name !== 'CA' || i === 0) fireEvent.click(view.getByTestId(test.point))
      if (test.name === 'CA') fireEvent.click(view.getByRole('button', { name: /原行IDへ解決して選択/ }))
      await waitFor(() => expect(selectCalls()).toHaveLength(i + 1))
      // A recorded request is only the start of selection. Wait for its result
      // to apply before trying again; CA intentionally ignores clicks while its
      // resolve button is loading (including Ant Design's internal effect).
      await waitFor(() => expect(dispatch.mock.calls.filter(([action]: any) =>
        action.type === 'selection/selectionApplied')).toHaveLength(i + 1))
      if (test.name === 'CA') await waitFor(() => expect(view.getByRole('button', {
        name: /原行IDへ解決して選択/,
      })).not.toHaveClass('ant-btn-loading'))
    }
    for (const [path, body] of selectCalls()) {
      expect(path).toBe('/analysis-results/fit-1/select')
      expect(body.context).toMatchObject({ scope: 'selected', selectedRowIds: ['r2', 'r4'] })
    }
    expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1)
  })
  it(`${test.name} blocks execution when a used analysis column leaves shared selection`, async () => {
    const { view, local } = setup(test)
    act(() => local.dispatch({ type: 'test/variables', payload: [] }))
    expect(view.getByTestId(test.run)).toBeDisabled()
    expect(view.getByText('使用列が共通選択から外れました。再指定してください。')).toBeInTheDocument()
    expect(post).not.toHaveBeenCalled()
  })
}

function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: any) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
it('CA blocks duplicate pending resolve clicks and allows repeated completed selections against the saved population', async () => {
  const pending = [deferred(), deferred()], fallback = post.getMockImplementation()!
  let resolution = 0
  post.mockImplementation((path, body) => path.endsWith('/select') ? pending[resolution++].promise : fallback(path, body))
  const { view, local, run } = setup(cases[0])
  await run()
  const dispatch = vi.spyOn(local, 'dispatch')
  act(() => local.dispatch({ type: 'test/selection', payload: ['r3', 'r6'] }))
  fireEvent.click(view.getByTestId('ca-point'))
  const resolveButton = () => view.getByRole('button', { name: /原行IDへ解決して選択/ })
  for (let i = 0; i < pending.length; i++) {
    fireEvent.click(resolveButton())
    await waitFor(() => expect(resolveButton()).toHaveClass('ant-btn-loading'))
    expect(selectCalls()).toHaveLength(i + 1)
    fireEvent.click(resolveButton())
    expect(selectCalls()).toHaveLength(i + 1)
    expect(dispatch.mock.calls.filter(([action]: any) => action.type === 'selection/selectionApplied')).toHaveLength(i)
    const selectedRow = i === 0 ? 'r2' : 'r4'
    await act(async () => pending[i].resolve({ rowIds: [selectedRow], matchedCount: 1,
      contextIntersectionCount: 1, selectionLabel: 'original result' }))
    await waitFor(() => expect(resolveButton()).not.toHaveClass('ant-btn-loading'))
    expect(dispatch.mock.calls.filter(([action]: any) => action.type === 'selection/selectionApplied')).toHaveLength(i + 1)
    expect(local.getState().selection.selectedRowIds).toContain(selectedRow)
  }
  expect(local.getState().selection.selectedRowIds).toEqual(['r3', 'r6', 'r2', 'r4'])
  for (const [path, body] of selectCalls()) {
    expect(path).toBe('/analysis-results/fit-1/select')
    expect(body.context).toMatchObject({ scope: 'selected', selectedRowIds: ['r2', 'r4'] })
    expect(body.selector).toMatchObject({ kind: 'categories', categoryIds: ['cat-a'] })
  }
  expect(post.mock.calls.filter(([path]) => path === cases[0].path)).toHaveLength(1)
})

const operations = ['add', 'replace', 'subtract', 'toggle'] as const
for (const test of cases) {
  const interactions = test.name === 'LR'
    ? [{ point: test.point, label: 'point', kind: 'row_ids' }, { point: 'lr-brush', label: 'brush', kind: 'diagnostic_rectangle' }]
    : [{ point: test.point, label: 'point', kind: test.name === 'CA' ? 'categories' : 'row_ids' }]
  for (const interaction of interactions) it.each(operations)(`${test.name} ${interaction.label} captures the %s operation before a pending selection reply`, async operation => {
    const pending = deferred(), fallback = post.getMockImplementation()!
    post.mockImplementation((path, body) => path.endsWith('/select') ? pending.promise : fallback(path, body))
    const { view, local, run } = setup(test)
    const dispatch = vi.spyOn(local, 'dispatch')
    await run()
    if (test.name !== 'CA') await waitFor(() => expect(get.mock.calls.some(([path]) => path.includes('/rows?'))).toBe(true))
    brushSelection.operation = operation
    fireEvent.click(view.getByTestId(interaction.point))
    if (test.name === 'CA') fireEvent.click(view.getByRole('button', { name: /原行IDへ解決して選択/ }))
    await waitFor(() => expect(selectCalls()).toHaveLength(1))
    brushSelection.operation = operations[(operations.indexOf(operation) + 1) % operations.length]
    await act(async () => pending.resolve({ rowIds: ['r2'], matchedCount: 1,
      contextIntersectionCount: 1, selectionLabel: 'captured operation' }))
    await waitFor(() => expect(dispatch.mock.calls.filter(([action]: any) => action.type === 'selection/selectionApplied')).toHaveLength(1))
    const action = dispatch.mock.calls.find(([action]: any) => action.type === 'selection/selectionApplied')![0] as any
    expect(action.payload).toMatchObject({ operation, rowIds: ['r2'] })
    expect(selectCalls()[0][1]).toMatchObject({ context: { scope: 'selected', selectedRowIds: ['r2', 'r4'] },
      selector: { kind: interaction.kind } })
    expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1)
  })
}

for (const test of cases) {
  it(`${test.name} accepts a started fit after live scope changes and keeps its original snapshot`, async () => {
    const pending = deferred(), fallback = post.getMockImplementation()!
    post.mockImplementation((path, body) => path === test.path ? pending.promise : fallback(path, body))
    const { view, local } = setup(test)
    fireEvent.click(view.getByTestId(test.run))
    await waitFor(() => expect(contextFor(test.path)).toMatchObject({ scope: 'selected' }))
    const body = post.mock.calls.find(([path]) => path === test.path)![1]
    act(() => local.dispatch({ type: 'test/scope', payload: 'all' }))
    await act(async () => pending.resolve(response(test.path, body)))
    await waitFor(() => expect(view.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
    expect(view.getAllByTestId('analysis-scope-summary')[0]).toHaveTextContent('全体 (All) 12行')
    expect(view.getAllByTestId('analysis-scope-summary')[0]).toHaveTextContent('この結果: 選択中の行 (Selected) 2行')
    expect(view.getByText(/対象または設定が変更されています/)).toBeInTheDocument()
    expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1)
  })
  it(`${test.name} rejects a fit response from an earlier data revision`, async () => {
    const pending = deferred(), fallback = post.getMockImplementation()!
    post.mockImplementation((path, body) => path === test.path ? pending.promise : fallback(path, body))
    const { view, local } = setup(test)
    fireEvent.click(view.getByTestId(test.run))
    await waitFor(() => expect(contextFor(test.path)).toBeTruthy())
    const body = post.mock.calls.find(([path]) => path === test.path)![1]
    act(() => local.dispatch({ type: 'test/revision' }))
    await act(async () => pending.resolve(response(test.path, body)))
    await waitFor(() => expect(view.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
    expect(view.queryByTestId(test.point)).toBeNull()
    expect(view.getAllByTestId('analysis-scope-summary')[0]).not.toHaveTextContent('この結果:')
  })
}

for (const test of cases.filter(test => ['MCA', 'FAMD', 'LR'].includes(test.name))) {
  it(`${test.name} materializes the fit population after the common scope changes`, async () => {
    const { view, local, run } = setup(test)
    await run()
    act(() => local.dispatch({ type: 'test/scope', payload: 'all' }))
    fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
    fireEvent.click(view.getByRole('button', { name: test.name === 'LR' ? '表示結果の列へ保存' : new RegExp(`${test.name}1を派生列へ保存`) }))
    await waitFor(() => expect(post.mock.calls.some(([path]) => path.endsWith('/materialize'))).toBe(true))
    const [path, body] = post.mock.calls.find(([path]) => path.endsWith('/materialize'))!
    expect(path).toBe('/analysis-results/fit-1/materialize')
    expect(body.context).toMatchObject({ scope: 'selected', selectedRowIds: ['r2', 'r4'] })
    expect(body.source).toBe('fit')
  })
}
for (const test of cases.filter(test => ['FAMD', 'LR'].includes(test.name))) {
  const tabLabel = test.name === 'FAMD' ? '射影' : '予測・評価'
  const predictLabel = test.name === 'FAMD' ? '射影を実行' : '予測・評価'
  it(`${test.name} predicts current shared All with a Sampled fit and retains prediction scope while fetching rows`, async () => {
    const { view, local, run } = setup(test, 'sampled')
    await run()
    act(() => local.dispatch({ type: 'test/scope', payload: 'all' }))
    fireEvent.click(view.getByRole('tab', { name: tabLabel }))
    const pending = deferred(), fallback = get.getMockImplementation()!
    get.mockImplementation((path: string) => path.includes('/predictions/') ? pending.promise : fallback(path))
    fireEvent.click(view.getByRole('button', { name: predictLabel }))
    await waitFor(() => expect(get.mock.calls.some(([path]) => path.includes('/predictions/prediction-1/rows'))).toBe(true))
    expect(post.mock.calls.find(([path]) => path.endsWith('/predict'))![1].context).toMatchObject({ scope: 'all' })
    expect(contextFor(test.path)).toMatchObject({ scope: 'sampled', sampledRowIds: ['r1', 'r5', 'r9'] })
    act(() => local.dispatch({ type: 'test/scope', payload: 'selected' }))
    await act(async () => pending.resolve({ rows: [{ rowId: 'r12', coordinates: [4, 5], predicted: 3, observed: 2, predictionStatus: 'ok' }], total: 12, nextOffset: null }))
    await waitFor(() => expect(view.getByRole('button', { name: predictLabel })).not.toHaveClass('ant-btn-loading'))
    const scopeText = view.getAllByTestId('analysis-scope-summary').map(el => el.textContent).join('\n')
    expect(scopeText).toContain('この結果: 標本 (Sampled) 3行')
    expect(scopeText).toContain('この結果: 全体 (All) 12行')
    expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1)
    if (test.name === 'LR') {
      fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
      fireEvent.click(view.getByRole('button', { name: '表示結果の列へ保存' }))
      await waitFor(() => expect(post.mock.calls.some(([path]) => path.endsWith('/materialize'))).toBe(true))
      const [path, body] = post.mock.calls.find(([path]) => path.endsWith('/materialize'))!
      expect(path).toBe('/analysis-results/fit-1/materialize')
      expect(body.source).toBe('prediction-1')
      expect(body.context.scope).toBe('all')
      expect(body.context.selectedRowIds).toBeUndefined()
    }
  })
  it(`${test.name} does not cancel a pending prediction when selecting fitted rows`, async () => {
    const { view, run } = setup(test)
    await run()
    const pending = deferred(), fallback = post.getMockImplementation()!
    post.mockImplementation((path, body) => path.endsWith('/predict') ? pending.promise : fallback(path, body))
    fireEvent.click(view.getByRole('tab', { name: tabLabel }))
    fireEvent.click(view.getByRole('button', { name: predictLabel }))
    await waitFor(() => expect(post.mock.calls.some(([path]) => path.endsWith('/predict'))).toBe(true))
    fireEvent.click(view.getByRole('tab', { name: test.name === 'LR' ? '診断図' : /個体図/ }))
    fireEvent.click(view.getByTestId(test.point))
    await waitFor(() => expect(selectCalls()).toHaveLength(1))
    await act(async () => pending.resolve({ predictionId: 'prediction-1', summary: { requestedCount: 2, successfulPredictions: 2 }, meta: {} }))
    fireEvent.click(view.getByRole('tab', { name: tabLabel }))
    await waitFor(() => expect(view.getByRole('button', { name: predictLabel })).not.toHaveClass('ant-btn-loading'))
    expect(view.getByText(test.name === 'LR' ? '成功2/2' : '成功 2/2')).toBeInTheDocument()
  })
  it(`${test.name} ignores prediction rows from an older revision`, async () => {
    const { view, local, run } = setup(test)
    await run()
    const pending = deferred(), fallback = get.getMockImplementation()!
    get.mockImplementation((path: string) => path.includes('/predictions/') ? pending.promise : fallback(path))
    fireEvent.click(view.getByRole('tab', { name: tabLabel }))
    fireEvent.click(view.getByRole('button', { name: predictLabel }))
    await waitFor(() => expect(get.mock.calls.some(([path]) => path.includes('/predictions/'))).toBe(true))
    act(() => local.dispatch({ type: 'test/revision' }))
    await act(async () => pending.resolve({ rows: [], total: 2, nextOffset: null }))
    expect(view.queryByText(test.name === 'LR' ? '成功2/2' : '成功 2/2')).toBeNull()
  })
}

for (const test of cases) it(`${test.name} never applies a delayed selection after unmount into another dataset with identical row IDs`, async () => {
  const { view, local, run } = setup(test)
  await run()
  const pending = deferred(), fallback = post.getMockImplementation()!
  post.mockImplementation((path, body) => path.endsWith('/select') ? pending.promise : fallback(path, body))
  fireEvent.click(view.getByTestId(test.point))
  if (test.name === 'CA') fireEvent.click(view.getByRole('button', { name: /原行IDへ解決して選択/ }))
  await waitFor(() => expect(selectCalls()).toHaveLength(1))
  view.unmount()
  act(() => local.dispatch({ type: 'test/dataset', payload: 'new-dataset-same-row-ids' }))
  render(<Provider store={local}><test.Page /></Provider>)
  const dispatch = vi.spyOn(local, 'dispatch')
  await act(async () => pending.resolve({ rowIds: ['r1'], matchedCount: 1, contextIntersectionCount: 1, selectionLabel: 'late' }))
  expect(dispatch.mock.calls.some(([action]: any) => action.type === 'selection/selectionApplied')).toBe(false)
  expect(local.getState().selection.datasetId).toBe('new-dataset-same-row-ids')
  expect(local.getState().selection.selectedRowIds).toEqual(['r2', 'r4'])
})

for (const test of cases.filter(test => ['MCA', 'FAMD', 'LR'].includes(test.name))) it(`${test.name} never refreshes a new dataset from a delayed materialization`, async () => {
  const { view, local, run } = setup(test)
  await run()
  const pending = deferred(), fallback = post.getMockImplementation()!
  post.mockImplementation((path, body) => path.endsWith('/materialize') ? pending.promise : fallback(path, body))
  fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  fireEvent.click(view.getByRole('button', { name: test.name === 'LR' ? '表示結果の列へ保存' : new RegExp(`${test.name}1を派生列へ保存`) }))
  await waitFor(() => expect(post.mock.calls.some(([path]) => path.endsWith('/materialize'))).toBe(true))
  view.unmount()
  act(() => local.dispatch({ type: 'test/dataset', payload: 'new-dataset-same-row-ids' }))
  render(<Provider store={local}><test.Page /></Provider>)
  const dispatch = vi.spyOn(local, 'dispatch')
  await act(async () => pending.resolve({ createdColumns: [{ name: 'saved' }], dataRevision: 2, schemaRevision: 2, writtenRowCount: 2 }))
  expect(dispatch).not.toHaveBeenCalled()
})

it('CA contingency keeps a structural row-label column while restricting analysis cell columns to the shared selection', async () => {
  const { view, local } = setup(cases[0], 'active')
  fireEvent.click(view.getByRole('radio', { name: '分割表' }))
  const choose = (label: string, values: string[]) => {
    const select = view.getByLabelText(label) as HTMLSelectElement
    Array.from(select.options).forEach(option => { option.selected = values.includes(option.value) })
    fireEvent.change(select)
  }
  choose('行ラベル', ['A'])
  choose('数値セル列（2列以上）', ['Outcome', 'X'])
  fireEvent.click(view.getByRole('radio', { name: 'mass' }))
  act(() => local.dispatch({ type: 'test/variables', payload: ['Outcome', 'X'] }))
  expect(view.getByTestId('ca-run')).not.toBeDisabled()
  expect(view.getByLabelText('行ラベル')).toHaveValue('A')
  fireEvent.click(view.getByTestId('ca-run'))
  await waitFor(() => expect(post.mock.calls.some(([path]) => path === cases[0].path)).toBe(true))
  const body = post.mock.calls.find(([path]) => path === cases[0].path)![1]
  expect(body.input).toMatchObject({ kind: 'contingency', rowLabelColumn: 'A', valueColumns: ['Outcome', 'X'] })
  expect(body.context).toMatchObject({ scope: 'active', activeRowIds: scopes.active })
  expect(view.getByText('分割表の対象件数はカテゴリ行数です（回答者数ではありません）。')).toBeInTheDocument()
  await waitFor(() => expect(view.getByTestId('ca-run')).not.toHaveClass('ant-btn-loading'))
  act(() => local.dispatch({ type: 'test/variables', payload: ['Outcome'] }))
  expect(view.getByTestId('ca-run')).toBeDisabled()
})

for (const test of cases) it(`${test.name} reports Active-excluded context rows accurately without changing the fit population`, async () => {
  const fallbackPost = post.getMockImplementation()!, fallbackGet = get.getMockImplementation()!
  post.mockImplementation((path, body) => path.endsWith('/select')
    ? Promise.resolve({ rowIds: ['r9'], matchedCount: 1, contextIntersectionCount: 1, selectionLabel: 'outside active' })
    : fallbackPost(path, body))
  get.mockImplementation((path: string) => path.includes('/rows?')
    ? Promise.resolve({ rows: [{ rowId: 'r9', coordinates: [1, 2], fitted: 1, residual: 0 }], total: 1, nextOffset: null })
    : fallbackGet(path))
  const { view, local, run } = setup(test, 'all')
  await run()
  fireEvent.click(view.getByTestId(test.point))
  if (test.name === 'CA') fireEvent.click(view.getByRole('button', { name: /原行IDへ解決して選択/ }))
  await waitFor(() => expect(view.getByText(/Active外 1行/)).toBeInTheDocument())
  expect(view.getByText(/適用\s*0/)).toBeInTheDocument()
  expect(local.getState().selection.selectedRowIds).toEqual(['r2', 'r4'])
  expect(selectCalls()[0][1].context.scope).toBe('all')
  expect(post.mock.calls.filter(([path]) => path === test.path)).toHaveLength(1)
})
