import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { getInstanceByDom } from 'echarts'
import { store, type RootState } from '../src/app/store'
import { api } from '../src/api/client'
import { GraphExpansionProvider, useGraphExpansion } from '../src/features/common/GraphExpansion'
import SparsePcaPanel from '../src/features/pca/SparsePcaPanel'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import { makeSparsePcaResult } from './sparsePcaFixture'

// Keep the actual panel, axis selectors, graph host/session and ECharts renderer.
// Only unrelated result tables, variable picker and color-data reads are replaced.
vi.mock('../src/features/common/ColumnSelect', () => ({ default: () => null }))
vi.mock('../src/features/pca/SparsePcaResultTables', () => ({ default: () => null }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#246', selectionColor: '#2a78d6' }) }))

function stateFor(datasetId = 'sparse-expansion') {
  const base = store.getState()
  const columns = ['x', 'y', 'z'].map(name => ({ name, columnId: name, label: name, role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false }))
  return { ...base, selection: { ...base.selection, datasetId, dataRevision: 3,
    allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'], selectedRowIds: [], hoveredRowId: null },
    globalVariables: { ...base.globalVariables, allVariables: columns.map(column => column.name), activeEntities: null },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    codebook: { ...base.codebook, datasetId, schemaRevision: 2, columns, weightConfig: null, surveyDesign: null, isLoading: false } } as RootState
}
function Route({ pageKey }: { pageKey: string }) {
  const { notifyRoute } = useGraphExpansion()
  const datasetId = useSelector((state: RootState) => state.selection.datasetId)
  useEffect(() => notifyRoute(pageKey, datasetId), [notifyRoute, pageKey, datasetId])
  return null
}
function setup() {
  const local = configureStore({ reducer: (state = stateFor(), action: any) => action.type === 'test/replace' ? action.payload : state,
    middleware: getDefault => getDefault({ serializableCheck: false, immutableCheck: false }) })
  const draw = (active = true, pageKey = '/pca') => <Provider store={local}><GraphExpansionProvider>
    <Route pageKey={pageKey} /><AnalysisViewActivityContext.Provider value={active}><SparsePcaPanel /></AnalysisViewActivityContext.Provider>
  </GraphExpansionProvider></Provider>
  return { ...render(draw()), local, draw }
}
function rowsResponse(axes = [1, 2]) {
  return { status: 'success', resultId: 'saved-spca-result', offset: 0, limit: 5000, total: 2, nextOffset: null, axes,
    rows: [{ rowId: 'r1', coordinates: axes.map(axis => axis * 1.1) }, { rowId: 'r2', coordinates: axes.map(axis => axis * 2.2) }], meta: {} }
}
function deferred() {
  let resolve!: (value: any) => void, reject!: (reason: unknown) => void
  const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
async function expand(view: ReturnType<typeof setup>) {
  fireEvent.change(view.getByTestId('sparse-pca-nComponents'), { target: { value: '3' } })
  fireEvent.click(view.getByTestId('sparse-pca-run'))
  await view.findByTestId('sparse-pca-score-plot')
  fireEvent.click(view.getByTestId('graph-expand-pca/sparse-scores'))
  fireEvent.click(view.getByTestId('graph-expansion-zoom-in'))
  const host = view.getByTestId('graph-host-pca/sparse-scores')
  expectExpanded(view, host)
  return host
}
function expectExpanded(view: ReturnType<typeof setup>, host: HTMLElement) {
  expect(view.getByTestId('graph-expansion-dialog')).toHaveAttribute('open')
  expect(view.getByTestId('graph-host-pca/sparse-scores')).toBe(host)
  expect(view.getByTestId('graph-expansion-dock')).toContainElement(host)
  expect(view.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('125%')
  expect(view.getByTestId('graph-surface-pca/sparse-scores')).toHaveAttribute('data-graph-zoom', '1.25')
}
async function changeX(view: ReturnType<typeof setup>, axis: number) {
  fireEvent.mouseDown(within(view.getByTestId('sparse-pca-axis-x')).getByRole('combobox'))
  const popup = view.getByTestId('graph-expansion-popup')
  const option = await waitFor(() => {
    const found = popup.querySelector<HTMLElement>(`.ant-select-item-option[title="SP${axis}"]`)
    expect(found).not.toBeNull()
    return found!
  })
  fireEvent.click(option)
}
function expectPlot(view: ReturnType<typeof setup>, axes: number[]) {
  const chart = getInstanceByDom(view.getByTestId('sparse-pca-score-plot'))!
  const option = chart.getOption() as any
  expect(option.xAxis[0].name).toBe(`SP${axes[0]}`)
  expect(option.yAxis[0].name).toBe(`SP${axes[1]}`)
  expect(option.series[0].data.map((point: any) => point.value)).toEqual(rowsResponse(axes).rows.map(row => row.coordinates))
}
function expectPending(view: ReturnType<typeof setup>, host: HTMLElement) {
  expectExpanded(view, host)
  expect(view.getByTestId('sparse-pca-score-content')).toHaveAttribute('aria-busy', 'true')
  expect(host).toContainElement(view.getByText('得点の全行を取得しています…'))
  expect(view.queryByTestId('sparse-pca-score-plot')).not.toBeInTheDocument()
  expect(view.queryByRole('group', { name: /矢印キーで行を移動/ })).not.toBeInTheDocument()
  expect(view.getByTestId('sparse-pca-selection-menu')).toBeDisabled()
  expect(within(view.getByTestId('sparse-pca-rows')).queryByText('r1')).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(760)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
  const result = makeSparsePcaResult(); result.summary.nComponents = 3
  vi.spyOn(api, 'post').mockResolvedValue(result)
  vi.spyOn(api, 'get').mockResolvedValue(rowsResponse())
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps the expanded host and zoom while swapped-axis rows load, without relabeling stale coordinates', async () => {
  const pending = deferred()
  vi.mocked(api.get).mockResolvedValueOnce(rowsResponse()).mockReturnValueOnce(pending.promise)
  const view = setup(), host = await expand(view)
  const dispatch = vi.spyOn(view.local, 'dispatch')
  expectPlot(view, [1, 2])
  await changeX(view, 2)
  expect(api.get).toHaveBeenLastCalledWith('/analysis-results/saved-spca-result/rows?offset=0&limit=5000&axes=2%2C1')
  expectPending(view, host)
  const pendingContent = view.getByTestId('sparse-pca-score-content')
  fireEvent.pointerDown(pendingContent, { button: 0, clientX: 20, clientY: 20 })
  fireEvent.pointerUp(pendingContent, { clientX: 300, clientY: 300 })
  fireEvent.keyDown(pendingContent, { key: 'Enter' })
  fireEvent.click(view.getByTestId('sparse-pca-selection-menu'))
  expect(dispatch.mock.calls.some(([action]) => action.type.startsWith('selection/'))).toBe(false)
  await act(async () => pending.resolve(rowsResponse([2, 1])))
  expectExpanded(view, host); expectPlot(view, [2, 1])
  expect(view.getByTestId('sparse-pca-score-content')).toHaveAttribute('aria-busy', 'false')
  expect(view.getByTestId('sparse-pca-selection-menu')).toBeEnabled()
  expect(api.post).toHaveBeenCalledTimes(1)
})

it.each(['success', 'failure'])('discards a late axis %s after a newer axis change finishes in the same expanded session', async outcome => {
  const first = deferred(), latest = deferred()
  vi.mocked(api.get).mockResolvedValueOnce(rowsResponse()).mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise)
  const view = setup(), host = await expand(view)
  await changeX(view, 2); expectPending(view, host)
  await changeX(view, 3); expectPending(view, host)
  await act(async () => latest.resolve(rowsResponse([3, 1])))
  expectExpanded(view, host); expectPlot(view, [3, 1])
  await act(async () => outcome === 'success' ? first.resolve(rowsResponse([2, 1])) : first.reject(new Error('stale axis failure')))
  expectExpanded(view, host); expectPlot(view, [3, 1])
  expect(view.queryByTestId('sparse-pca-rows-error')).not.toBeInTheDocument()
})

it('clears an old axis error when requesting a different axis without leaving the expanded session', async () => {
  const next = deferred()
  vi.mocked(api.get).mockResolvedValueOnce(rowsResponse()).mockRejectedValueOnce(new Error('old axis failure')).mockReturnValueOnce(next.promise)
  const view = setup(), host = await expand(view)
  await changeX(view, 2)
  expect(await view.findByTestId('sparse-pca-rows-error')).toHaveTextContent('old axis failure')
  await changeX(view, 3)
  expectPending(view, host)
  expect(view.queryByTestId('sparse-pca-rows-error')).not.toBeInTheDocument()
  await act(async () => next.resolve(rowsResponse([3, 1])))
  expectExpanded(view, host); expectPlot(view, [3, 1])
})

it('keeps error and retry inside the expanded host and recovers with the selected axes and zoom', async () => {
  const failed = deferred(), retry = deferred()
  vi.mocked(api.get).mockResolvedValueOnce(rowsResponse()).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise)
  const view = setup(), host = await expand(view)
  await changeX(view, 2)
  await act(async () => failed.reject(new Error('axis rows unavailable')))
  expectExpanded(view, host)
  expect(host).toContainElement(view.getByTestId('sparse-pca-rows-error'))
  expect(view.getByTestId('sparse-pca-rows-error')).toHaveTextContent('axis rows unavailable')
  expect(view.getByTestId('sparse-pca-selection-menu')).toBeDisabled()
  expect(view.queryByTestId('sparse-pca-score-plot')).not.toBeInTheDocument()
  fireEvent.click(view.getByTestId('sparse-pca-rows-retry'))
  expectPending(view, host)
  await act(async () => retry.resolve(rowsResponse([2, 1])))
  expectExpanded(view, host); expectPlot(view, [2, 1])
  expect(view.queryByTestId('sparse-pca-rows-error')).not.toBeInTheDocument()
})

it.each(['route', 'inactive view', 'dataset', 'revision', 'result close'])('still closes expansion on %s during an axis fetch', async invalidation => {
  const pending = deferred()
  vi.mocked(api.get).mockResolvedValueOnce(rowsResponse()).mockReturnValueOnce(pending.promise)
  const view = setup(), host = await expand(view)
  await changeX(view, 2); expectPending(view, host)
  if (invalidation === 'route') view.rerender(view.draw(false, '/table'))
  else if (invalidation === 'inactive view') view.rerender(view.draw(false))
  else if (invalidation === 'result close') fireEvent.click(view.getByTestId('sparse-pca-close'))
  else {
    const next = stateFor(invalidation === 'dataset' ? 'next-dataset' : undefined)
    if (invalidation === 'revision') next.selection.dataRevision++
    act(() => { view.local.dispatch({ type: 'test/replace', payload: next }) })
  }
  expect(view.getByTestId('graph-expansion-dialog')).not.toHaveAttribute('open')
  expect(view.queryByTestId('graph-expansion-bar')).not.toBeInTheDocument()
  await act(async () => pending.resolve(rowsResponse([2, 1])))
  expect(view.getByTestId('graph-expansion-dialog')).not.toHaveAttribute('open')
  expect(view.queryByTestId('sparse-pca-score-plot')).not.toBeInTheDocument()
})
