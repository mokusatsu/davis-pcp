import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { store, groupsReplaced, clusterResultStored, selectionApplied } from '../src/app/store'
import { api } from '../src/api/client'
import { graphEngine } from '../src/engine/graphClient'
import ClustersPage from '../src/features/clustering/ClustersPage'
// Controller regressions use deterministic logical coordinates; the ECharts
// adapter has separate rendering and event tests.
vi.mock('../src/features/charts/EChartSurface', async () => {
  const { forwardRef } = await import('react')
  return { default: forwardRef<SVGSVGElement, any>((props, ref) => <svg {...props} ref={ref} />) }
})
vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd([{ columnId: 'A' }])}>MA候補追加</button> }))

vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select data-testid={props['data-testid']} multiple={props.mode === 'multiple'} value={props.value ?? ''}
  onChange={event => props.onChange(props.mode === 'multiple' ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}{props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: (id: string) => id === 'r7' ? '#abcdef' : '#fedcba', isSelected: (id: string) => id === 'r7', selectionColor: '#123456' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('Cluster candidates must not load raw columns') } }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(selectedRowIds: string[] = []) {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, selectedRowIds, activeRowIds: ['r7', 'r14'], clusterResult: null },
    globalObservations: { ...base.globalObservations, activeRowIds: [] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'x' }, { kind: 'column', columnId: 'category' }, { kind: 'ma', groupId: 'g' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns: [
      { name: 'x', columnId: 'x', role: 'question', scaleType: 'ratio' },
      { name: 'hidden', columnId: 'hidden', role: 'question', scaleType: 'ratio' },
      { name: 'category', columnId: 'category', role: 'attribute', scaleType: 'nominal' },
      { name: 'A', columnId: 'A', role: 'question', scaleType: 'nominal', multiResponseGroup: 'g' }] } }
  const local = configureStore({ reducer: (current = state, action: any) => action.type === 'test/scope'
    ? { ...current, globalObservations: { ...current.globalObservations, activeRowIds: action.payload } }
    : action.type === 'test/revision' ? { ...current, selection: { ...current.selection, dataRevision: 4 } }
    : clusterResultStored.match(action) ? { ...current, selection: { ...current.selection, clusterResult: action.payload } } : current,
    middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<Provider store={local}><ClustersPage /></Provider>)
  return { local, dispatch, view }
}
const result = { resultId: 'c', method: 'kmeans', k: 2, rowIds: ['r7', 'r14'], labels: [0, 1], diagnostics: {}, linkageMatrix: null, evidenceClass: 'test' }

it('sends only common ordinary candidates, strict scope and revisions on manual run', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  const { view, dispatch } = setup()
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', expect.objectContaining({
    activeRowIds: [], columns: ['x'], categoricalColumns: undefined, expectedDataRevision: 3, expectedSchemaRevision: 2 })))
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith(clusterResultStored(result)))
  const action = dispatch.mock.calls.find(([action]) => groupsReplaced.match(action))![0] as ReturnType<typeof groupsReplaced>
  expect(action.payload.map(group => group.rowIds)).toEqual([['r7'], ['r14']])
})

it.each(['scope', 'revision', 'unmount'])('does not overwrite linked groups after %s changes', async change => {
  let finish!: (value: any) => void
  vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const success = vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  const { view, dispatch, local } = setup()
  fireEvent.click(view.getByTestId('run-clustering'))
  if (change === 'unmount') view.unmount()
  else act(() => { local.dispatch({ type: `test/${change}`, payload: ['r7'] }) })
  await act(async () => { finish(result) })
  expect(dispatch.mock.calls.some(([action]) => groupsReplaced.match(action) || clusterResultStored.match(action))).toBe(false)
  expect(success).not.toHaveBeenCalled()
})

it.each(['kmeans', 'disc', 'class_variable'])('uses explicitly added MA children in the %s inputs', async method => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  const { view } = setup()
  fireEvent.click(view.getByText('MA候補追加'))
  if (method !== 'kmeans') fireEvent.click(view.getByText(method === 'disc' ? 'DISC (AAAI 2026)' : 'Class変数', { exact: true }))
  if (method === 'class_variable') fireEvent.change(view.getByTestId('class-column'), { target: { value: 'A' } })
  fireEvent.click(view.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', expect.objectContaining({ method,
    columns: method === 'kmeans' ? ['x', 'A'] : method === 'disc' ? ['x'] : [],
    categoricalColumns: method === 'disc' ? ['category', 'A'] : undefined,
    classColumn: method === 'class_variable' ? 'A' : undefined })))
})

it('marks retained results after input changes and clears the notice only for matching results', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  const { view, local } = setup()
  fireEvent.click(view.getByTestId('run-clustering'))
  await view.findByRole('button', { name: 'cluster 0 (1)' })
  expect(view.queryByTestId('cluster-previous-result')).toBeNull()
  act(() => { local.dispatch({ type: 'test/scope', payload: ['r7'] }) })
  expect(view.getByTestId('cluster-previous-result')).toBeVisible()
  expect(view.getByRole('button', { name: 'cluster 0 (1)' })).toBeVisible()
  expect(post).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByTestId('run-clustering'))
  await waitFor(() => expect(view.queryByTestId('cluster-previous-result')).toBeNull())
  expect(post).toHaveBeenCalledTimes(2)
  act(() => { local.dispatch({ type: 'test/revision' }) })
  expect(view.getByTestId('cluster-previous-result')).toBeVisible()
  post.mockRejectedValueOnce(new Error('対象行がありません'))
  fireEvent.click(view.getByTestId('run-clustering'))
  await view.findByText('対象行がありません')
  expect(view.getByTestId('cluster-previous-result')).toBeVisible()
  expect(local.getState().selection.clusterResult).toEqual(result)
})

it('keeps a one-dimensional projection selectable without matching empty space', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'post').mockResolvedValue({ ...result, pcaProjection: { pc1: [-1, 1], pc2: [0, 0], varianceRatio: [1, 0] } })
  const hit = vi.spyOn(graphEngine, 'scatterHit').mockResolvedValue([])
  const { view } = setup()
  fireEvent.click(view.getByTestId('run-clustering'))
  const svg = await view.findByTestId('pca-svg')
  const size = Number(svg.getAttribute('width'))
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: size, height: size } as DOMRect)
  for (const circle of svg.querySelectorAll('circle[data-selectable]')) expect(Number(circle.getAttribute('cy'))).toBe(size / 2)
  fireEvent.pointerDown(svg, { clientX: 60, clientY: 60, button: 0 })
  fireEvent.pointerMove(svg, { clientX: size - 60, clientY: 100, button: 0 })
  fireEvent.pointerUp(svg, { clientX: size - 60, clientY: 100, button: 0 })
  await waitFor(() => expect(hit).toHaveBeenCalled())
  const bounds = hit.mock.calls[0][2]
  expect(bounds.y1).toBeGreaterThan(0)
  expect(bounds.y2).toBeGreaterThan(bounds.y1)
})

it.each(['scope', 'revision', 'unmount', 'new-brush'])('ignores delayed rectangle selection after %s', async change => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'post').mockResolvedValue({ ...result, pcaProjection: { pc1: [-1, 1], pc2: [0, 0], varianceRatio: [1, 0] } })
  let finish!: (indices: number[]) => void
  const hit = vi.spyOn(graphEngine, 'scatterHit').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { view, local, dispatch } = setup()
  fireEvent.click(view.getByTestId('run-clustering'))
  const svg = await view.findByTestId('pca-svg')
  const size = Number(svg.getAttribute('width'))
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: size, height: size } as DOMRect)
  fireEvent.pointerDown(svg, { clientX: 20, clientY: 20, button: 0 })
  // Final pointer coordinates define the rectangle, even without a move event.
  fireEvent.pointerUp(svg, { clientX: size-20, clientY: size-20, button: 0 })
  await waitFor(() => expect(hit).toHaveBeenCalledTimes(1))
  if (change === 'unmount') view.unmount()
  else if (change === 'new-brush') {
    fireEvent.pointerDown(svg, { clientX: 50, clientY: 50, button: 0 })
    fireEvent.pointerCancel(svg)
    fireEvent.pointerUp(svg, { clientX: 100, clientY: 100, button: 0 })
    expect(hit).toHaveBeenCalledTimes(1)
  } else act(() => { local.dispatch({ type: `test/${change}`, payload: ['r7'] }) })
  await act(async () => { finish([0]) })
  expect(dispatch.mock.calls.some(([action]) => selectionApplied.match(action))).toBe(false)
})

it('preserves shared row colors and outlines selections in both cluster plots', async () => {
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(graphEngine, 'silhouetteOrder').mockResolvedValue([0, 1])
  vi.spyOn(api, 'post').mockResolvedValue({ ...result,
    pcaProjection: { pc1: [-1, 1], pc2: [0, 0], varianceRatio: [1, 0] },
    silhouette: { byRow: [0.5, 0.4], mean: 0.45, byCluster: [{ label: 0, mean: 0.5, count: 1 }, { label: 1, mean: 0.4, count: 1 }] } })
  const { view } = setup(['r7'])
  fireEvent.click(view.getByTestId('run-clustering'))
  const pca = await view.findByTestId('pca-svg')
  const silhouette = await view.findByTestId('silhouette-svg')
  await waitFor(() => expect(silhouette.querySelectorAll('[data-row-id]')).toHaveLength(2))
  for (const plot of [pca, silhouette]) {
    expect(plot.querySelector('[data-row-id="r7"]')).toHaveAttribute('fill', '#abcdef')
    expect(plot.querySelector('[data-row-id="r14"]')).toHaveAttribute('fill', '#fedcba')
  }
  expect(pca.querySelector('[data-row-id="r7"]')).toHaveAttribute('stroke', '#123456')
  expect(silhouette.querySelector('[data-row-id="r7"]')).toHaveAttribute('stroke', '#123456')
  expect(silhouette.querySelector('[data-row-id="r7"]')).toHaveAttribute('opacity', '1')
})

it('shows the actual input population, dropped columns and numeric imputation separately', async () => {
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'post').mockResolvedValue({ ...result, scopeCount: 3, excludedRowCount: 1, usedColumns: ['x'],
    diagnostics: { droppedColumns: ['constant', 'empty'], imputedCounts: { x: 2, other: 0 } } })
  const { view } = setup()
  fireEvent.click(view.getByTestId('run-clustering'))
  await view.findByText('2行 / 対象 3行')
  expect(view.getByRole('row', { name: '使用列 x' })).toBeVisible()
  expect(view.getByRole('row', { name: 'MA回答状態による行除外 1行' })).toBeVisible()
  expect(view.getByRole('row', { name: '定数・全欠損のため除外した列 constant、empty' })).toBeVisible()
  expect(view.getByRole('row', { name: '数値の欠損補完 x: 2件（対象行の有効値の平均）' })).toBeVisible()
})
