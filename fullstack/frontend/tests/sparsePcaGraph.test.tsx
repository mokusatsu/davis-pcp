import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { getInstanceByDom } from 'echarts'
import { datasetLoaded, groupsReplaced, hovered, l2ColorToggled, pcpStateChanged, selectionApplied, selectionCleared, store } from '../src/app/store'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import SparsePcaScorePlot, { sparsePcaPoints } from '../src/features/pca/SparsePcaScorePlot'
import { makeSparsePcaResult } from './sparsePcaFixture'

const colorData = vi.hoisted(() => ({ rowIds: ['left', 'center', 'right'], rowIndex: new Map([['left', 0], ['center', 1], ['right', 2]]),
  schema: [{ name: 'color', columnId: 'color', semanticType: 'numeric' }], columns: { color: [1, 2, 1] }, numeric: {}, minMax: {}, categories: {} }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => colorData }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
const rows = [{ rowId: 'left', coordinates: [-1, -1] }, { rowId: 'center', coordinates: [0, 0] }, { rowId: 'right', coordinates: [1, 1] }]
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(760)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(450)
  vi.stubGlobal('PointerEvent', class extends MouseEvent { readonly pointerId: number; constructor(type: string, init?: PointerEventInit) { super(type, init); this.pointerId = init?.pointerId ?? 1 } })
  store.dispatch(datasetLoaded({ datasetId: 'sparse-graph', rowIds: colorData.rowIds, name: 'Sparse graph' }))
  store.dispatch(pcpStateChanged({ colorBy: 'color', brushOperation: 'replace' }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); store.dispatch(selectionCleared()) })
function draw(result = makeSparsePcaResult(), data = rows, axes = [1, 2]) {
  return <Provider store={store}><GraphExpansionProvider><SparsePcaScorePlot result={result} rows={data} axes={axes} onAxes={() => {}} /></GraphExpansionProvider></Provider>
}
function setup(scale = 1) {
  const view = render(draw()), element = view.getByTestId('sparse-pca-score-plot'), chart = getInstanceByDom(element)!
  const host = view.getByRole('group', { name: /矢印キーで行を移動/ })
  act(() => chart.resize({ width: 760, height: 450 }))
  host.getBoundingClientRect = () => ({ left: 20, top: 30, width: 760 * scale, height: 450 * scale } as DOMRect)
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
  return { ...view, element, chart, host, cx: 20 + x * scale, cy: 30 + y * scale }
}
it('renders one-dimensional SP1 with no fake SP2 or numeric jitter, preserving duplicate rows', () => {
  const result = makeSparsePcaResult(); result.summary.nComponents = 1
  const data = [{ rowId: 'left', coordinates: [1] }, { rowId: 'right', coordinates: [1] }]
  const view = render(draw(result, data, [1])), chart = getInstanceByDom(view.getByTestId('sparse-pca-score-plot'))!
  const option = chart.getOption() as any
  expect(option.xAxis[0].name).toBe('SP1'); expect(option.yAxis[0].show).toBe(false)
  expect(option.series[0].data.map((point: any) => point.value)).toEqual([[1, 0], [1, 0]])
  expect(view.container.textContent).not.toContain('SP2')
  expect(view.getByText(/意味のある広がり/)).toBeInTheDocument()
  expect(sparsePcaPoints(data, [1])[0].tooltip).toBe('rowId: left\nSP1: 1')
  fireEvent.focus(view.getByRole('group', { name: /SP1（1次元）/ }))
  expect(store.getState().selection.hoveredRowId).toBe('left')
  fireEvent.keyDown(view.getByRole('group', { name: /SP1（1次元）/ }), { key: 'ArrowRight' })
  expect(store.getState().selection.hoveredRowId).toBe('right')
})
it('projects shared L1/L2 colors and central selection/hover into the same chart instance', () => {
  const view = setup()
  const series = () => (view.chart.getOption().series as any[])[0].data
  const original = series().map((point: any) => point.itemStyle.color)
  expect(original[0]).toBe(original[2]); expect(original[0]).not.toBe(original[1])
  act(() => { store.dispatch(groupsReplaced([{ groupId: 'a', label: 'a', rowIds: ['left', 'center'] }, { groupId: 'b', label: 'b', rowIds: ['right'] }] as any)); store.dispatch(l2ColorToggled(true)) })
  expect(series()[0].itemStyle.color).not.toBe(series()[2].itemStyle.color)
  act(() => { store.dispatch(l2ColorToggled(false)); store.dispatch(selectionApplied({ rowIds: ['center'], operation: 'replace' })); store.dispatch(hovered('center')) })
  expect(series().map((point: any) => point.itemStyle.color)).toEqual(original)
  expect(series()[1].symbolSize).toBeGreaterThan(series()[0].symbolSize)
  expect(series()[1].itemStyle.borderColor).toBe('#2a78d6')
  expect(series()[1].itemStyle.opacity).toBe(1)
  expect(getInstanceByDom(view.element)).toBe(view.chart)
})
for (const scale of [.5, 1, 2]) for (const operation of ['replace', 'add', 'subtract', 'toggle'] as const) {
  it(`maps a ${scale}x displayed rectangle to central rows using ${operation}`, () => {
    store.dispatch(pcpStateChanged({ brushOperation: operation }))
    const dispatch = vi.spyOn(store, 'dispatch'), view = setup(scale)
    fireEvent.pointerDown(view.host, { button: 0, clientX: view.cx - 20, clientY: view.cy - 20 })
    fireEvent.pointerMove(view.host, { clientX: view.cx + 10, clientY: view.cy + 10 })
    const graphic = JSON.stringify(view.chart.getOption().graphic)
    expect(graphic).toContain('rgba(42,120,214,0.15)'); expect(graphic).toContain('"z":100')
    fireEvent.pointerUp(view.host, { clientX: view.cx + 10, clientY: view.cy + 10 })
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: selectionApplied.type, payload: expect.objectContaining({ rowIds: ['center'], operation }) }))
    expect(view.host).toHaveStyle({ userSelect: 'none' })
  })
}
it('uses ±8px nearest-point clicks and shared hover; point-down does not start a brush', () => {
  const dispatch = vi.spyOn(store, 'dispatch'), view = setup(2)
  fireEvent.pointerMove(view.host, { clientX: view.cx + 7, clientY: view.cy })
  expect(store.getState().selection.hoveredRowId).toBe('center')
  fireEvent.pointerDown(view.host, { button: 0, clientX: view.cx + 7, clientY: view.cy })
  fireEvent.pointerUp(view.host, { clientX: view.cx + 7, clientY: view.cy })
  expect(store.getState().selection.selectedRowIds).toEqual(['center'])
  dispatch.mockClear()
  fireEvent.pointerDown(view.host, { button: 0, clientX: view.cx, clientY: view.cy })
  fireEvent.pointerMove(view.host, { clientX: view.cx + 100, clientY: view.cy + 100 })
  fireEvent.pointerUp(view.host, { clientX: view.cx + 100, clientY: view.cy + 100 })
  expect(dispatch.mock.calls.some(([action]) => action.type === selectionApplied.type)).toBe(false)
  fireEvent.pointerMove(view.host, { clientX: view.cx + 9, clientY: view.cy })
  expect(store.getState().selection.hoveredRowId).toBeNull()
})
it('cancels brushes on pointer cancel/capture loss and expansion/zoom while retaining the renderer', () => {
  const dispatch = vi.spyOn(store, 'dispatch'), view = setup()
  for (const cancel of [fireEvent.pointerCancel, fireEvent.lostPointerCapture]) {
    fireEvent.pointerDown(view.host, { button: 0, clientX: view.cx - 20, clientY: view.cy - 20 }); cancel(view.host)
    fireEvent.pointerUp(view.host, { clientX: view.cx + 10, clientY: view.cy + 10 })
  }
  fireEvent.pointerDown(view.host, { button: 0, clientX: view.cx - 20, clientY: view.cy - 20 })
  fireEvent.click(view.getByTestId('graph-expand-pca/sparse-scores'))
  fireEvent.click(view.getByTestId('graph-expansion-zoom-in'))
  fireEvent.pointerUp(view.host, { clientX: view.cx + 10, clientY: view.cy + 10 })
  expect(dispatch.mock.calls.some(([action]) => action.type === selectionApplied.type)).toBe(false)
  for (const action of ['fit', 'exit']) fireEvent.click(view.getByTestId(`graph-expansion-${action}`))
  expect(getInstanceByDom(view.element)).toBe(view.chart)
})
