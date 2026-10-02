import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import SparsePcaPanel from '../src/features/pca/SparsePcaPanel'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import { makeSparsePcaResult } from './sparsePcaFixture'

vi.mock('../src/features/common/ColumnSelect', () => ({ default: ({ options, value, onChange, ...props }: any) =>
  <select multiple data-testid={props['data-testid']} value={value} onChange={event => onChange(Array.from(event.target.selectedOptions, option => option.value))}>
    {options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))
vi.mock('../src/features/pca/SparsePcaScorePlot', () => ({ default: ({ rows, axes, onAxes }: any) => <div data-testid="score-mock">
  {JSON.stringify({ rows, axes })}<button onClick={() => onAxes([2, 1])}>Swap axes</button></div> }))
vi.mock('../src/features/pca/SparsePcaResultTables', () => ({ default: ({ result }: any) => <div data-testid="result-mock">{result.resultId} saved alpha={result.config.alpha}</div> }))
function stateFor(datasetId = 'd') {
  const base = store.getState()
  const columns = ['x', 'y', 'ordinal', 'ma', 'weight', 'id'].map(name => ({ name, columnId: name, label: name, role: name === 'weight' ? 'weight' : 'question',
    scaleType: name === 'ordinal' ? 'ordinal' : name === 'id' ? 'id' : 'ratio', multiResponseGroup: name === 'ma' ? 'q' : null,
    valueLabels: {}, categoryOrder: ['1', '2'], missingCodes: [], missingReasons: {}, isReversed: false }))
  return { ...base, selection: { ...base.selection, datasetId, dataRevision: 3, allRowIds: ['r1', 'r2', 'r3'], activeRowIds: ['r1', 'r2', 'r3'], selectedRowIds: [] },
    globalVariables: { ...base.globalVariables, allVariables: columns.map(column => column.name), activeEntities: null },
    globalObservations: { ...base.globalObservations, scopeMode: 'active', sampling: { ...base.globalObservations.sampling } },
    codebook: { ...base.codebook, datasetId, schemaRevision: 2, columns, weightConfig: null, surveyDesign: null, isLoading: false } } as any
}
function makeStore(initial = stateFor()) { return configureStore({ reducer: (state = initial, action: any) => action.type === 'test/replace' ? action.payload : state,
  middleware: getDefault => getDefault({ serializableCheck: false, immutableCheck: false }) }) }
function viewFor(local = makeStore()) {
  const draw = (active: boolean) => <Provider store={local}><AnalysisViewActivityContext.Provider value={active}><SparsePcaPanel /></AnalysisViewActivityContext.Provider></Provider>
  return { ...render(draw(true)), local, draw }
}
function rowsResponse(axes = [1, 2]) { return { status: 'success', resultId: 'saved-spca-result', offset: 0, limit: 5000, total: 2, nextOffset: null, axes,
  rows: [{ rowId: 'r1', coordinates: axes.map(a => a * 1.1) }, { rowId: 'r2', coordinates: axes.map(a => a * 2.2) }], meta: {} } }
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(res => { resolve = res }); return { promise, resolve } }
beforeEach(() => { vi.spyOn(api, 'get').mockResolvedValue(rowsResponse()) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('submits explicit empty scope and supported variables to an independent endpoint', async () => {
  const initial = stateFor(); initial.globalObservations.scopeMode = 'sampled'; initial.globalObservations.sampling.sampledRowIds = []
  const post = vi.spyOn(api, 'post').mockRejectedValue({ message: '空の対象', code: 'SPCA_INSUFFICIENT_ROWS' })
  const view = viewFor(makeStore(initial)); expect(post).not.toHaveBeenCalled(); fireEvent.click(view.getByTestId('sparse-pca-run'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/sparse-pca', expect.objectContaining({
    context: { datasetId: 'd', expectedDataRevision: 3, expectedSchemaRevision: 2, scope: 'sampled', sampledRowIds: [], weightMode: 'dataset', missingPolicy: 'exclude', imputationPolicy: 'use_current_values' },
    variables: [{ columnId: 'x', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null }, { columnId: 'y', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null }],
    nComponents: 2, alpha: 1, ridgeAlpha: .01, seed: 0, tolerance: 1e-8, maxIterations: 1000,
  })))
  expect(await view.findByText('空の対象（SPCA_INSUFFICIENT_ROWS）')).toBeInTheDocument()
})
it.each(['frequency', 'survey'])('requires explicit none for %s weights', async weightType => {
  const initial = stateFor(); initial.codebook.weightConfig = { weightColumnId: 'weight', weightType }
  const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('test')), view = viewFor(makeStore(initial))
  expect(view.getByTestId('sparse-pca-run')).toBeDisabled()
  fireEvent.click(view.getByText('明示的に非加重')); fireEvent.click(view.getByTestId('sparse-pca-run'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/sparse-pca', expect.objectContaining({ context: expect.objectContaining({ weightMode: 'none' }) })))
})
it('requires ordinal acknowledgment and sends ordered_rank together', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('test')), view = viewFor(), select = view.getByTestId('sparse-pca-columns') as HTMLSelectElement
  for (const option of select.options) option.selected = ['x', 'ordinal'].includes(option.value)
  fireEvent.change(select); expect(view.getByTestId('sparse-pca-run')).toBeDisabled()
  fireEvent.click(view.getByRole('checkbox', { name: /固定したカテゴリ順/ })); fireEvent.click(view.getByTestId('sparse-pca-run'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/sparse-pca', expect.objectContaining({ variables: [
    { columnId: 'x', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null }, { columnId: 'ordinal', kind: 'numeric', ordinalAsNumericAcknowledged: true, score: 'ordered_rank' },
  ] })))
})
it('ignores double-run and canceled replies without queuing another fit', async () => {
  const pending = deferred(), post = vi.spyOn(api, 'post').mockReturnValueOnce(pending.promise).mockResolvedValue(makeSparsePcaResult())
  const view = viewFor(), run = view.getByTestId('sparse-pca-run'); fireEvent.click(run); fireEvent.click(run)
  expect(post).toHaveBeenCalledTimes(1); fireEvent.click(view.getByTestId('sparse-pca-cancel')); expect(run).toBeDisabled()
  fireEvent.click(run); expect(post).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve(makeSparsePcaResult()))
  expect(view.queryByTestId('result-mock')).not.toBeInTheDocument(); expect(run).not.toBeDisabled()
  fireEvent.click(run); expect(await view.findByTestId('result-mock')).toBeInTheDocument(); expect(post).toHaveBeenCalledTimes(2)
})
it('preserves the pending lane across unmount/remount', async () => {
  const pending = deferred(), post = vi.spyOn(api, 'post').mockReturnValue(pending.promise), first = viewFor()
  fireEvent.click(first.getByTestId('sparse-pca-run')); first.unmount(); const second = viewFor()
  expect(second.getByTestId('sparse-pca-run')).toBeDisabled(); await act(async () => pending.resolve(makeSparsePcaResult()))
  expect(post).toHaveBeenCalledTimes(1); expect(second.queryByTestId('result-mock')).not.toBeInTheDocument(); expect(second.getByTestId('sparse-pca-run')).not.toBeDisabled()
})
it('ignores replies after navigation away and reentry', async () => {
  const pending = deferred(); vi.spyOn(api, 'post').mockReturnValue(pending.promise)
  const view = viewFor(); fireEvent.click(view.getByTestId('sparse-pca-run')); view.rerender(view.draw(false)); view.rerender(view.draw(true))
  expect(view.getByTestId('sparse-pca-run')).toBeDisabled(); await act(async () => pending.resolve(makeSparsePcaResult()))
  expect(view.queryByTestId('result-mock')).not.toBeInTheDocument()
})
it('discards old dataset replies while preserving the in-flight guard', async () => {
  const pending = deferred(); vi.spyOn(api, 'post').mockReturnValue(pending.promise)
  const view = viewFor(); fireEvent.click(view.getByTestId('sparse-pca-run'))
  act(() => { view.local.dispatch({ type: 'test/replace', payload: stateFor('next') }) })
  expect(view.getByTestId('sparse-pca-run')).toBeDisabled(); await act(async () => pending.resolve(makeSparsePcaResult()))
  expect(view.queryByTestId('result-mock')).not.toBeInTheDocument()
})
it('retains immutable submitted settings/scope and marks later inputs dirty', async () => {
  const pending = deferred(), post = vi.spyOn(api, 'post').mockReturnValue(pending.promise), view = viewFor()
  fireEvent.click(view.getByTestId('sparse-pca-run')); const request = post.mock.calls[0][1] as any
  fireEvent.change(view.getByTestId('sparse-pca-alpha'), { target: { value: '9' } })
  const next = stateFor(); next.selection.activeRowIds = ['r2']; act(() => { view.local.dispatch({ type: 'test/replace', payload: next }) })
  expect(request.context.activeRowIds).toEqual(['r1', 'r2', 'r3']); expect(request.alpha).toBe(1)
  await act(async () => pending.resolve(makeSparsePcaResult()))
  expect(await view.findByTestId('sparse-pca-dirty')).toBeInTheDocument(); expect(view.getByTestId('result-mock')).toHaveTextContent('saved alpha=1')
  expect(view.getByRole('button', { name: 'CSV' })).toBeDisabled()
})
it('fetches every score page without truncating the plot or score table', async () => {
  vi.spyOn(api, 'post').mockResolvedValue(makeSparsePcaResult())
  vi.mocked(api.get).mockReset().mockResolvedValueOnce({ ...rowsResponse(), total: 3, nextOffset: 2 })
    .mockResolvedValueOnce({ ...rowsResponse(), offset: 2, total: 3, rows: [{ rowId: 'r3', coordinates: [3, 4] }] })
  const view = viewFor(); fireEvent.click(view.getByTestId('sparse-pca-run'))
  await waitFor(() => expect(view.getByTestId('score-mock')).toHaveTextContent('r3'))
  expect(api.get).toHaveBeenLastCalledWith('/analysis-results/saved-spca-result/rows?offset=2&limit=5000&axes=1%2C2')
  expect(view.getByText('得点一覧（3行・表示軸）')).toBeInTheDocument()
})
it('discards stale rows after axis changes and result Close', async () => {
  vi.spyOn(api, 'post').mockResolvedValue(makeSparsePcaResult()); const first = deferred(), second = deferred()
  vi.mocked(api.get).mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const view = viewFor(); fireEvent.click(view.getByTestId('sparse-pca-run')); await view.findByTestId('result-mock')
  fireEvent.click(view.getByText('Swap axes')); await act(async () => first.resolve(rowsResponse()))
  expect(view.getByTestId('score-mock')).not.toHaveTextContent('r1'); fireEvent.click(view.getByTestId('sparse-pca-close'))
  await act(async () => second.resolve(rowsResponse([2, 1])))
  expect(view.queryByTestId('result-mock')).not.toBeInTheDocument(); expect(view.queryByTestId('score-mock')).not.toBeInTheDocument()
})
