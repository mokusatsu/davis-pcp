import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef } from 'react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import PcaPage from '../src/features/pca/PcaPage'
import CovariancePage from '../src/features/covariance/CovariancePage'
import FedfPage from '../src/features/fedf/FedfPage'
import LoessPlotPage from '../src/features/loess/LoessPlotPage'
import QQPlotView from '../src/features/qqplot/QQPlotView'

const fixtures = vi.hoisted(() => ({ data: {} as Record<string, any> }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: (id: string) => fixtures.data[id] ?? null }))
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (p: any) => <select
  data-testid={p['data-testid'] ?? 'columns'} aria-label={p['data-testid'] ?? '対象列'} multiple={p.mode === 'multiple'}
  value={p.value} onChange={e => p.onChange(p.mode === 'multiple' ? [...e.target.selectedOptions].map(o => o.value) : e.target.value)}>
  {p.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
</select> }))
vi.mock('../src/features/common/ColumnQuestionTooltip', () => ({ default: ({ children }: any) => children, useQuestionText: () => (name: string) => name }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children, controls }: any) => <>{controls}{children}</>, useGraphPopupContainer: () => () => document.body }))
vi.mock('../src/features/charts/MatrixHeatmap', () => ({ default: ({ onSelect }: any) => <button onClick={() => onSelect(1, 2)}>select y z</button> }))
vi.mock('../src/features/charts/EChartSurface', () => ({ default: forwardRef(({ children, ...p }: any, ref: any) => <svg ref={ref} data-testid={p['data-testid']}>{children}</svg>) }))
vi.mock('../src/features/charts/RowScatter', () => ({ default: () => <div data-testid="qq-result" /> }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ useBrushOp: () => ['replace'] }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff' }) }))
vi.mock('../src/features/pca/ScreePlot', () => ({ ScreePlot: ({ onSelectComponent }: any) => <>{[0, 1, 2].map(i => <button key={i} onClick={() => onSelectComponent(i)}>PC{i + 1} bar</button>)}</> }))
vi.mock('../src/features/pca/LoadingTable', () => ({ LoadingTable: () => null }))
vi.mock('../src/features/pca/PcaMatrixPlot', () => ({ PcaMatrixPlot: () => null }))
vi.mock('../src/features/pca/BiplotView', () => ({ BiplotView: ({ selectedX, selectedY }: any) => <div data-testid="pca-axes">{selectedX},{selectedY}</div> }))

function dataset(id = 'd', names = ['x', 'y', 'z']) {
  const base = store.getState()
  const columns = names.map(name => ({ columnId: name, name, label: name, role: 'question', scaleType: name === 'ordinal' ? 'ordinal' : 'ratio' }))
  fixtures.data[id] = { schema: names.map(name => ({ name, semanticType: 'numeric' })) }
  return { ...base, selection: { ...base.selection, datasetId: id, dataRevision: 1, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'], selectedRowIds: [] },
    codebook: { ...base.codebook, datasetId: id, columns, isLoading: false },
    globalVariables: { ...base.globalVariables, activeEntities: names.map(columnId => ({ kind: 'column', columnId })) } }
}
function local(initial = dataset()) {
  return configureStore({ reducer: (state = initial, action: any) => action.type === 'fixture/replace' ? action.payload : state,
    middleware: getDefaultMiddleware => getDefaultMiddleware({ serializableCheck: false }) })
}
function replace(localStore: ReturnType<typeof local>, state: ReturnType<typeof dataset>) {
  act(() => { localStore.dispatch({ type: 'fixture/replace', payload: state }) })
}
function choose(testId: string, names: string[]) {
  const input = screen.getByTestId(testId) as HTMLSelectElement
  for (const option of input.options) option.selected = names.includes(option.value)
  fireEvent.change(input)
}
function chosen(testId: string) { return [...(screen.getByTestId(testId) as HTMLSelectElement).selectedOptions].map(option => option.value) }
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function response(url: string, body: any) {
  if (url === '/statistics/covariance') {
    const matrix = body.columns.map((_: string, i: number) => body.columns.map((__: string, j: number) => i === j ? 1 : .25))
    return { columns: body.columns, covariance: matrix, correlation: matrix, precision: matrix, partialCorrelation: matrix, diagnostics: { generalizedVariance: 1, totalVariance: 3, conditionNumber: 1 } }
  }
  if (url === '/distribution/fedf') return { columns: body.columns, profiles: Object.fromEntries(body.columns.map((name: string) => [name, { curve: [], minVal: 0, maxVal: 1 }])), statistics: {}, rowCoords: {}, totalRows: 2, mode: body.mode }
  if (url === '/regression/loess') return { xCol: body.xCol, yCol: body.yCol, xRange: [0, 1], yRange: [0, 1], curve: [], points: [], outlierRowIds: [], outlierCount: 0 }
  if (url === '/summaries/qqplot') return { column: body.column, count: 2, points: [], minZ: -1, maxZ: 1, normalityTest: { shapiroWilkW: 1, pValue: .5, isNormalAlpha05: true, skewness: 0, kurtosis: 0 }, referenceLine: { slope: 1, intercept: 0 } }
  return { columns: body.columns, nComponents: 3, eigenvalues: [2, 1, .5], explainedVarianceRatio: [.57, .29, .14], loadings: {}, scores: [] }
}
function mount(Page: any, localStore = local(), entry: any = '/loess') {
  return { localStore, ...render(<Provider store={localStore}><MemoryRouter initialEntries={[entry]}><Page /></MemoryRouter></Provider>) }
}
beforeEach(() => {
  fixtures.data = {}
  vi.spyOn(api, 'post').mockImplementation(async (url, body: any) => response(url, body) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('I14 keeps scree axes distinct when clicking X, Y, or another component and resets after a new run', async () => {
  mount(PcaPage)
  fireEvent.click(screen.getByTestId('pca-run-button'))
  await waitFor(() => expect(screen.getByTestId('pca-run-button')).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(screen.getByText('PC1 bar'))
  expect(screen.getByTestId('pca-axes')).toHaveTextContent('0,1')
  fireEvent.click(screen.getByText('PC2 bar'))
  expect(screen.getByTestId('pca-axes')).toHaveTextContent('1,0')
  fireEvent.click(screen.getByText('PC3 bar'))
  expect(screen.getByTestId('pca-axes')).toHaveTextContent('2,0')
  fireEvent.click(screen.getByTestId('pca-run-button'))
  await waitFor(() => expect(screen.getByTestId('pca-axes')).toHaveTextContent('0,1'))
})

describe.each([
  ['FEDF', FedfPage, 'fedf-columns-select', '/distribution/fedf', '1つ以上の数値列を選択してください。'],
  ['covariance', CovariancePage, 'covariance-columns-select', '/statistics/covariance', '最低2つの数値列を選択してください。'],
] as const)('S08 %s selection', (_name, Page, selector, endpoint, emptyMessage) => {
  it('keeps an explicit empty selection through unrelated updates and initializes a different dataset', async () => {
    const { localStore } = mount(Page)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, expect.anything()))
    choose(selector, [])
    expect(chosen(selector)).toEqual([])
    expect(screen.getByText(emptyMessage)).toBeVisible()
    const calls = vi.mocked(api.post).mock.calls.length
    const state = localStore.getState()
    replace(localStore, { ...state, selection: { ...state.selection, selectedRowIds: ['r1'] } })
    expect(chosen(selector)).toEqual([])
    expect(api.post).toHaveBeenCalledTimes(calls)
    replace(localStore, dataset('next', ['a', 'b']))
    await waitFor(() => expect(chosen(selector)).toEqual(['a', 'b']))
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({ datasetId: 'next', columns: ['a', 'b'], rowIds: ['r1', 'r2'] })))
  })
  it('clears a pending request when the last column is removed and ignores its late failure', async () => {
    const pending = deferred()
    vi.mocked(api.post).mockImplementationOnce(() => pending.promise)
    mount(Page)
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, expect.anything()))
    choose(selector, [])
    await act(async () => { pending.reject(new Error('obsolete failure')) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(emptyMessage)).toBeVisible()
    expect(chosen(selector)).toEqual([])
  })
})

it('S09 applies one covariance eligibility set to options, pruning and requests, retaining active ordinals', async () => {
  const initial = dataset('d', ['x', 'y', 'z', 'ordinal'])
  initial.globalVariables.activeEntities = ['x', 'y', 'ordinal'].map(columnId => ({ kind: 'column', columnId }))
  const { localStore } = mount(CovariancePage, local(initial))
  const selector = 'covariance-columns-select'
  expect([...(screen.getByTestId(selector) as HTMLSelectElement).options].map(o => o.value)).toEqual(['x', 'y', 'ordinal'])
  choose(selector, ['x', 'ordinal'])
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/statistics/covariance', expect.objectContaining({ columns: ['x', 'ordinal'] })))
  replace(localStore, { ...initial, globalVariables: { ...initial.globalVariables, activeEntities: ['x', 'z', 'ordinal'].map(columnId => ({ kind: 'column', columnId })) } })
  expect(chosen(selector)).toEqual(['x', 'ordinal'])
  replace(localStore, { ...initial, globalVariables: { ...initial.globalVariables, activeEntities: [{ kind: 'column', columnId: 'x' }] } })
  expect(chosen(selector)).toEqual(['x'])
  expect(screen.getByText('最低2つの数値列を選択してください。')).toBeVisible()
  const count = vi.mocked(api.post).mock.calls.length
  replace(localStore, initial)
  expect(chosen(selector)).toEqual(['x'])
  expect(api.post).toHaveBeenCalledTimes(count)
  for (const [, body] of vi.mocked(api.post).mock.calls) expect((body as any).columns).not.toContain('z')
})

function LocationInspector() { const location = useLocation(); return <div data-testid="location">{JSON.stringify(location.state)}</div> }
it('I15 sends the exact selected covariance pair and dataset in navigation state', async () => {
  mount(() => <><CovariancePage /><LocationInspector /></>, local(), '/covariance')
  fireEvent.click(await screen.findByText('select y z'))
  fireEvent.click(screen.getByRole('button', { name: /Loess散布図で開く/ }))
  expect(screen.getByTestId('location')).toHaveTextContent(JSON.stringify({ datasetId: 'd', xCol: 'y', yCol: 'z' }))
})
function CachedLoess() {
  const location = useLocation(), navigate = useNavigate()
  return <><button onClick={() => navigate('/covariance')}>Leave</button>
    <button onClick={() => navigate('/loess', { state: { datasetId: 'd', xCol: 'z', yCol: 'x' } })}>Open z x</button>
    <button onClick={() => navigate('/loess')}>Return without pair</button>
    <AnalysisViewActivityContext.Provider value={location.pathname === '/loess'}><LoessPlotPage /></AnalysisViewActivityContext.Provider></>
}
it('I15 consumes the pair on first entry and each cached re-entry without overwriting later manual choices', async () => {
  mount(CachedLoess, local(), { pathname: '/loess', state: { datasetId: 'd', xCol: 'y', yCol: 'z' } })
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/regression/loess', expect.objectContaining({ xCol: 'y', yCol: 'z' })))
  expect(vi.mocked(api.post).mock.calls.every(([, body]) => (body as any).xCol === 'y' && (body as any).yCol === 'z')).toBe(true)
  choose('loess-x-select', ['x'])
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/regression/loess', expect.objectContaining({ xCol: 'x', yCol: 'z' })))
  fireEvent.click(screen.getByText('Leave'))
  const beforeReturn = vi.mocked(api.post).mock.calls.length
  fireEvent.click(screen.getByText('Open z x'))
  await waitFor(() => expect(chosen('loess-x-select')).toEqual(['z']))
  expect(chosen('loess-y-select')).toEqual(['x'])
  expect(vi.mocked(api.post).mock.calls.slice(beforeReturn).every(([, body]) => (body as any).xCol === 'z' && (body as any).yCol === 'x')).toBe(true)
  choose('loess-y-select', ['y'])
  fireEvent.click(screen.getByText('Leave'))
  fireEvent.click(screen.getByText('Return without pair'))
  expect(chosen('loess-x-select')).toEqual(['z'])
  expect(chosen('loess-y-select')).toEqual(['y'])
})
it('I15 waits for route-pair candidates, ignores another dataset, and never sends an unavailable column', async () => {
  const localStore = local()
  const data = fixtures.data.d
  fixtures.data.d = null
  const view = mount(LoessPlotPage, localStore, { pathname: '/loess', state: { datasetId: 'd', xCol: 'y', yCol: 'z' } })
  expect(api.post).not.toHaveBeenCalled()
  fixtures.data.d = data
  replace(localStore, { ...localStore.getState(), selection: { ...localStore.getState().selection, dataRevision: 2 } })
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/regression/loess', expect.objectContaining({ xCol: 'y', yCol: 'z' })))
  view.unmount()
  vi.mocked(api.post).mockClear()
  mount(LoessPlotPage, local(dataset('next', ['a', 'b'])), { pathname: '/loess', state: { datasetId: 'd', xCol: 'y', yCol: 'z' } })
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/regression/loess', expect.objectContaining({ datasetId: 'next', xCol: 'a', yCol: 'b' })))
})

it.each([
  ['FEDF', FedfPage, '/distribution/fedf', 'fedf-svg'],
  ['Loess', LoessPlotPage, '/regression/loess', 'loess-svg'],
  ['QQ', QQPlotView, '/summaries/qqplot', 'qqplot-diagnostics'],
  ['covariance', CovariancePage, '/statistics/covariance', undefined],
] as const)('I16 %s exposes an accessible failure and retries exactly the same analysis', async (_name, Page, endpoint, resultId) => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error('network is offline'))
  mount(Page)
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('network is offline')
  expect(screen.queryByText('1つ以上の数値列を選択してください。')).not.toBeInTheDocument()
  expect(screen.queryByText('最低2つの数値列を選択してください。')).not.toBeInTheDocument()
  expect(screen.queryByText('有効な2つの数値列を選択してください。')).not.toBeInTheDocument()
  const first = vi.mocked(api.post).mock.calls[0]
  expect(first[0]).toBe(endpoint)
  // The alert can render before request cleanup and Ant Design's loading state settle.
  const retry = await waitFor(() => {
    const button = screen.getByRole('button', { name: '再試行', exact: true })
    expect(button).toBeEnabled()
    expect(button).not.toHaveClass('ant-btn-loading')
    return button
  })
  retry.focus()
  expect(retry).toHaveFocus()
  fireEvent.click(retry)
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(first)
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  if (resultId) await screen.findByTestId(resultId)
  else await screen.findByText('select y z')
})

it.each([['Loess', LoessPlotPage, '/regression/loess'], ['QQ', QQPlotView, '/summaries/qqplot']] as const)('I16 %s ignores stale failure after changing datasets', async (_name, Page, endpoint) => {
  const pending = deferred()
  vi.mocked(api.post).mockImplementationOnce(() => pending.promise)
  const { localStore } = mount(Page)
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, expect.anything()))
  replace(localStore, dataset('next', ['a', 'b']))
  await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(endpoint, expect.objectContaining({ datasetId: 'next' })))
  await act(async () => { pending.reject(new Error('old dataset failed')) })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it.each([['FEDF', FedfPage, 'fedf-columns-select', '/distribution/fedf'], ['covariance', CovariancePage, 'covariance-columns-select', '/statistics/covariance']] as const)(
  'S08 %s waits for candidates and preserves an empty choice during metadata reload', async (_name, Page, selector, endpoint) => {
    const state = dataset()
    const loaded = fixtures.data.d
    fixtures.data.d = null
    const localStore = local({ ...state, codebook: { ...state.codebook, isLoading: true } })
    mount(Page, localStore)
    expect(api.post).not.toHaveBeenCalled()
    fixtures.data.d = loaded
    replace(localStore, { ...state, selection: { ...state.selection, dataRevision: 2 } })
    await waitFor(() => expect(chosen(selector)).toEqual(['x', 'y', 'z']))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(endpoint, expect.objectContaining({ columns: ['x', 'y', 'z'] })))
    expect(api.post).toHaveBeenCalledTimes(1)
    choose(selector, [])
    fixtures.data.d = null
    replace(localStore, { ...state, selection: { ...state.selection, dataRevision: 3 }, codebook: { ...state.codebook, isLoading: true } })
    fixtures.data.d = loaded
    replace(localStore, { ...state, selection: { ...state.selection, dataRevision: 3 } })
    expect(chosen(selector)).toEqual([])
    expect(api.post).toHaveBeenCalledTimes(1)
  },
)
