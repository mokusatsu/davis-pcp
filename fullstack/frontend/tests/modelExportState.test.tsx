import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
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
const pendingObjectURLs = new Set<string>()
let nextObjectURL = 0
beforeAll(() => {
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:export-${++nextObjectURL}`
      pendingObjectURLs.add(url)
      return url
    },
    revokeObjectURL: (url: string) => { pendingObjectURLs.delete(url) },
  })
})
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(560)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
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
afterAll(async () => {
  try {
    // Table/chart downloads release URLs after 1s/30s. Let those real timers finish
    // before restoring URL; per-test restoration leaks callbacks into later tests.
    await waitFor(() => expect(pendingObjectURLs.size).toBe(0), { timeout: 35_000 })
  } finally {
    vi.unstubAllGlobals()
  }
}, 40_000)

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


// Real AntD lazy Tabs, real figure/EChart renderers and common export controls.
for (const test of cases.filter(c => ['MCA', 'FAMD'].includes(c.name))) it(`${test.name} routes a first category export to its mounted chart with one SVG entry`, async () => {
  const { view, run } = setup(test); await run()
  await waitFor(() => expect(view.getByTestId(test.point)).toBeInTheDocument())
  const categoryId = test.name === 'MCA' ? 'mca-category-svg' : 'famd-category-svg'
  expect(view.queryByTestId(categoryId)).toBeNull()
  fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  expect(view.queryByRole('button', { name: 'カテゴリ図SVG' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'カテゴリ図を開く' }))
  const chart = await view.findByTestId(categoryId)
  expect(chart).toBeVisible()
  const button = view.getByRole('button', { name: /：カテゴリ図 SVGを保存$/ })
  expect(view.getAllByRole('button', { name: /：カテゴリ図 SVGを保存$/ })).toHaveLength(1)
  fireEvent.click(button)
  await waitFor(() => expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1))
  expect(button).toBeEnabled()
  fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  fireEvent.click(view.getByRole('button', { name: 'カテゴリ図を開く' }))
  expect(view.getByRole('button', { name: /：カテゴリ図 SVGを保存$/ })).toBe(button)
})

for (const test of cases) it(`${test.name} table download exposes pending and rejection, suppresses double clicks, and retries`, async () => {
  const { view, run } = setup(test); await run()
  if (test.name !== 'CA') fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  const label = test.name === 'LR' ? 'coefficients CSV' : '固有値CSV'
  const button = await view.findByRole('button', { name: label })
  let reject!: (error: unknown) => void
  post.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  const initial = post.mock.calls.length
  fireEvent.click(button); fireEvent.click(button)
  expect(button).toBeDisabled()
  expect(view.getByRole('status')).toHaveTextContent('準備中')
  expect(post.mock.calls.length - initial).toBe(1)
  await act(async () => reject({ message: 'offline export' }))
  expect(await view.findByText(`${label}を保存できませんでした: offline export`)).toHaveAttribute('role', 'alert')
  expect(button).toBeEnabled()
  post.mockResolvedValueOnce({ payload: 'name,value\na,1', fileName: 'result.csv', nextOffset: null })
  fireEvent.click(button)
  await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('ダウンロードを開始'))
  expect(post.mock.calls.length - initial).toBe(2)
})
