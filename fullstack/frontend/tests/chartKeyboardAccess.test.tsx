import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { getInstanceByDom } from 'echarts'
import { datasetLoaded, selectionApplied, selectionCleared, store } from '../src/app/store'
import EChart from '../src/features/charts/EChart'
import EChartSurface from '../src/features/charts/EChartSurface'
import RowScatter from '../src/features/charts/RowScatter'
import CategoryBars from '../src/features/charts/CategoryBars'
import MatrixHeatmap from '../src/features/charts/MatrixHeatmap'
import ModelScatter from '../src/features/models/ModelScatter'

const operation = vi.hoisted(() => ({ value: 'replace' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ getBrushOp: () => operation.value }))

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420)
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number
    constructor(type: string, init?: PointerEventInit) { super(type, init); this.pointerId = init?.pointerId ?? 1 }
  })
  store.dispatch(datasetLoaded({ datasetId: 'keyboard-test', rowIds: ['r1', 'r2'], name: 'Keyboard' }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); store.dispatch(selectionCleared()) })

it('I11 pairs each keyboard mark entry with exit on navigation, Escape, blur and unmount', () => {
  const calls: string[] = []
  const draw = () => <EChartSurface data-testid="surface" width={600} height={420}>
    {['r1', 'r2'].map((id, index) => <circle key={id} cx={100 + index * 60} cy={120} r={4}
      onMouseEnter={() => calls.push(`enter ${id}`)} onMouseLeave={() => calls.push(`leave ${id}`)}><title>{id}</title></circle>)}
  </EChartSurface>
  const view = render(draw()), host = view.getByTestId('surface')
  fireEvent.focus(host)
  fireEvent.keyDown(host, { key: 'ArrowRight' })
  expect(calls).toEqual(['enter r1', 'leave r1', 'enter r2'])
  fireEvent.keyDown(host, { key: 'Escape' })
  expect(calls.at(-1)).toBe('leave r2')
  expect(view.queryByRole('tooltip')).toBeNull()
  fireEvent.blur(host)
  expect(calls).toHaveLength(4)
  fireEvent.focus(host)
  fireEvent.blur(host, { relatedTarget: document.body })
  expect(calls.slice(-2)).toEqual(['enter r2', 'leave r2'])
  fireEvent.focus(host)
  view.unmount()
  expect(calls.slice(-2)).toEqual(['enter r2', 'leave r2'])
})

it('I11 clears stale marks after data replacement and retains the caller mouse-leave path', () => {
  const leave = vi.fn(), outerLeave = vi.fn()
  const view = render(<EChartSurface data-testid="surface" onMouseLeave={outerLeave}>
    <circle cx={100} cy={120} r={4} onMouseLeave={leave}><title>old row</title></circle>
  </EChartSurface>)
  const host = view.getByTestId('surface')
  fireEvent.focus(host)
  view.rerender(<EChartSurface data-testid="surface" onMouseLeave={outerLeave}>
    <circle cx={100} cy={120} r={4}><title>new row</title></circle>
  </EChartSurface>)
  expect(leave).toHaveBeenCalledTimes(1)
  expect(view.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseLeave(host)
  expect(outerLeave).toHaveBeenCalledTimes(1)
})

it.each(['add', 'replace', 'subtract', 'toggle'])('I12 uses %s identically for point pointer and keyboard activation', op => {
  operation.value = op
  const points = [{ rowId: 'r1', x: 0, y: 0 }, { rowId: 'r2', x: 1, y: 1 }]
  const view = render(<Provider store={store}><RowScatter testId="rows" points={points} xName="X" yName="Y" clickOperation="menu" /></Provider>)
  const host = view.getByRole('group'), chart = getInstanceByDom(view.getByTestId('rows'))!
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const dispatch = vi.spyOn(store, 'dispatch')
  const reset = () => act(() => { store.dispatch(selectionApplied({ rowIds: ['r1', 'r2'], operation: 'replace' })) })
  reset()
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
  fireEvent.pointerDown(host, { clientX: x, clientY: y, button: 0 })
  fireEvent.pointerUp(host, { clientX: x, clientY: y, button: 0 })
  const pointerSelection = store.getState().selection.selectedRowIds
  reset()
  fireEvent.keyDown(host, { key: 'Enter' })
  expect(store.getState().selection.selectedRowIds).toEqual(pointerSelection)
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection/selectionApplied', payload: expect.objectContaining({ rowIds: ['r1'], operation: op }) }))
  reset()
  fireEvent.keyDown(host, { key: ' ' })
  expect(store.getState().selection.selectedRowIds).toEqual(pointerSelection)
  const live = host.querySelector('[aria-live]')!
  expect(host).toHaveStyle({ position: 'relative' })
  expect(live).toHaveStyle({ position: 'absolute', top: '0px', left: '0px' })
})

it('RowScatter keyboard hover follows finite rows and leaves on Escape or blur without stealing nested control keys', () => {
  const view = render(<Provider store={store}><RowScatter points={[{ rowId: 'r1', x: 0, y: 0 }, { rowId: 'bad', x: NaN, y: 1 }, { rowId: 'r2', x: 1, y: 1 }]} xName="X" yName="Y" /></Provider>)
  const host = view.getByRole('group')
  fireEvent.focus(host)
  expect(store.getState().selection.hoveredRowId).toBe('r1')
  fireEvent.keyDown(host, { key: 'ArrowRight' })
  expect(store.getState().selection.hoveredRowId).toBe('r2')
  fireEvent.keyDown(host, { key: 'Escape' })
  expect(store.getState().selection.hoveredRowId).toBeNull()
  const nested = document.createElement('button'); host.append(nested)
  fireEvent.keyDown(nested, { key: 'Enter' })
  expect(store.getState().selection.selectedRowIds).toEqual([])
  fireEvent.focus(host); fireEvent.blur(host, { relatedTarget: nested })
  expect(store.getState().selection.hoveredRowId).toBeNull()
})

it('RowScatter clears keyboard hover when the data changes and handles an empty replacement', () => {
  const draw = (points: { rowId: string; x: number; y: number }[]) => <Provider store={store}><RowScatter points={points} xName="X" yName="Y" /></Provider>
  const view = render(draw([{ rowId: 'r1', x: 0, y: 0 }]))
  fireEvent.focus(view.getByRole('group'))
  expect(store.getState().selection.hoveredRowId).toBe('r1')
  view.rerender(draw([]))
  expect(store.getState().selection.hoveredRowId).toBeNull()
  fireEvent.keyDown(view.getByRole('group'), { key: 'ArrowRight' })
  fireEvent.keyDown(view.getByRole('group'), { key: 'Enter' })
  expect(store.getState().selection.selectedRowIds).toEqual([])
})

it('I18 exposes shared native-series navigation, symmetric hover, Home/End and current labels', () => {
  const hover = vi.fn(), select = vi.fn()
  const items = [{ id: 'a', label: 'row a detail', seriesIndex: 0, dataIndex: 0 }, { id: 'b', label: 'row b detail', seriesIndex: 0, dataIndex: 1 }]
  const view = render(<EChart testId="series" option={{ aria: { enabled: true }, xAxis: {}, yAxis: {}, series: [{ type: 'scatter', data: [[0, 0], [1, 1]] }] }}
    keyboardNavigation={{ items, onSelect: select, onHover: hover }} />)
  const host = view.getByTestId('series'), chart = getInstanceByDom(host)!, action = vi.spyOn(chart, 'dispatchAction')
  expect(host).toHaveAttribute('tabindex', '0')
  expect(host).toHaveAttribute('role', 'group')
  expect(host).toHaveAccessibleName(/矢印キーでマークを移動/)
  fireEvent.focus(host)
  fireEvent.keyDown(host, { key: 'End' })
  expect(hover.mock.calls.map(args => args[0])).toEqual(['a', null, 'b'])
  expect(view.container.querySelector('[aria-live]')).toHaveTextContent('row b detail')
  expect(action).toHaveBeenCalledWith({ type: 'downplay', seriesIndex: 0, dataIndex: 0 })
  expect(action).toHaveBeenCalledWith({ type: 'highlight', seriesIndex: 0, dataIndex: 1 })
  fireEvent.keyDown(host, { key: ' ' })
  expect(select).toHaveBeenCalledWith('b')
  fireEvent.keyDown(host, { key: 'Home' }); fireEvent.keyDown(host, { key: 'Enter' })
  expect(select).toHaveBeenLastCalledWith('a')
  fireEvent.blur(host)
  expect(hover).toHaveBeenLastCalledWith(null)
  expect(view.container.querySelector('[aria-live]')).toHaveTextContent('')
})

it('I18 invalidates active native-series marks on dataset change, item removal and unmount', () => {
  const hover = vi.fn(), select = vi.fn(), option = { series: [] }
  const draw = (scope: string, items = [{ id: 'a', label: 'A' }]) => <EChart resetKey={scope} testId="series" option={option} keyboardNavigation={{ items, onHover: hover, onSelect: select }} />
  const view = render(draw('first')), host = view.getByTestId('series')
  fireEvent.focus(host)
  view.rerender(draw('second'))
  expect(hover).toHaveBeenLastCalledWith(null)
  fireEvent.focus(host)
  view.rerender(draw('second', []))
  expect(hover).toHaveBeenLastCalledWith(null)
  fireEvent.keyDown(host, { key: 'Enter' })
  expect(select).not.toHaveBeenCalled()
  view.rerender(draw('second'))
  fireEvent.focus(host)
  view.unmount()
  expect(hover).toHaveBeenLastCalledWith(null)
})

it.each(['欠損: 無回答', '無効: 定義範囲外または数値として無効'])('I18 category bars describe %s neutrally with a nonzero valid denominator', reason => {
  const select = vi.fn()
  const view = render(<CategoryBars testId="bars" axisName="Estimate" onSelect={select} items={[
    { id: 'estimate', label: 'Estimate A', value: 1.2345, selected: true },
    { id: 'missing', label: '対象外応答', value: null, detail: `${reason} / 有効回答数: 12` },
  ]} />)
  const host = view.getByTestId('bars'), chart = getInstanceByDom(host)!
  fireEvent.focus(host)
  expect(view.container.querySelector('[aria-live]')).toHaveTextContent('1.2345、選択中')
  fireEvent.keyDown(host, { key: 'ArrowDown' })
  expect(view.container.querySelector('[aria-live]')).toHaveTextContent(`対象外・算出不可。${reason} / 有効回答数: 12`)
  const tooltip = (chart.getOption().tooltip as any[])[0].formatter({ dataIndex: 1 })
  expect(tooltip).toContain('対象外・算出不可')
  expect(tooltip).toContain(reason)
  expect(tooltip).not.toContain('分母0')
  fireEvent.keyDown(host, { key: 'Enter' })
  act(() => { (chart as any).trigger('click', { dataIndex: 1 }) })
  expect(select.mock.calls).toEqual([['missing'], ['missing']])
})

it('I18 matrix navigation preserves row-major cell identity across valid and null series', () => {
  const select = vi.fn()
  const view = render(<MatrixHeatmap testId="matrix" title="Covariance" labels={['X', 'Y']} matrix={[[1, null], [.25, 2]]}
    counts={[[12, 0], [11, 12]]} onSelect={select} />)
  const host = view.getByTestId('matrix'), chart = getInstanceByDom(host)!, action = vi.spyOn(chart, 'dispatchAction')
  fireEvent.focus(host); fireEvent.keyDown(host, { key: 'ArrowRight' })
  expect(view.container.querySelector('[aria-live]')).toHaveTextContent('X × Y: 計算不可、n=0')
  expect(action).toHaveBeenCalledWith({ type: 'highlight', seriesIndex: 1, dataIndex: 0 })
  fireEvent.keyDown(host, { key: 'Enter' })
  expect(select).toHaveBeenLastCalledWith(0, 1)
  fireEvent.keyDown(host, { key: 'ArrowRight' })
  expect(action).toHaveBeenCalledWith({ type: 'highlight', seriesIndex: 0, dataIndex: 1 })
  fireEvent.keyDown(host, { key: ' ' })
  expect(select).toHaveBeenLastCalledWith(1, 0)
})

it('I18 model rows and category points share pointer activation and row-hover ownership', () => {
  const select = vi.fn()
  const view = render(<Provider store={store}><ModelScatter testId="model" xLabel="X" yLabel="Y" onToggle={select}
    extraSeries={[{ type: 'line', data: [] }]} points={[
      { id: 'bad', rowId: 'bad', x: NaN, y: 0, title: 'invalid' },
      { id: 'a', rowId: 'r1', x: 0, y: 0, title: 'row r1 exact detail', misclassified: true },
      { id: 'category', x: 1, y: 1, title: 'category exact detail' },
    ]} /></Provider>)
  const host = view.getByTestId('model'), chart = getInstanceByDom(host)!, action = vi.spyOn(chart, 'dispatchAction')
  fireEvent.focus(host)
  expect(store.getState().selection.hoveredRowId).toBe('r1')
  expect(action).toHaveBeenCalledWith({ type: 'highlight', seriesIndex: 2, dataIndex: 0 })
  fireEvent.keyDown(host, { key: 'Enter' })
  act(() => { (chart as any).trigger('click', { seriesId: 'model-points', data: { id: 'a' } }) })
  expect(select.mock.calls).toEqual([['a'], ['a']])
  fireEvent.keyDown(host, { key: 'ArrowRight' })
  expect(store.getState().selection.hoveredRowId).toBeNull()
  fireEvent.keyDown(host, { key: ' ' })
  expect(select).toHaveBeenLastCalledWith('category')
  fireEvent.keyDown(host, { key: 'Home' }); fireEvent.blur(host)
  expect(store.getState().selection.hoveredRowId).toBeNull()
})

it('I18 one-dimensional model points remain keyboard accessible when y is intentionally null', () => {
  const select = vi.fn()
  const view = render(<ModelScatter testId="one-d" oneDimensional xLabel="X" yLabel="" onToggle={select}
    points={[{ id: 'one', x: 2, y: null, title: 'One dimensional observation' }]} />)
  fireEvent.focus(view.getByTestId('one-d'))
  fireEvent.keyDown(view.getByTestId('one-d'), { key: 'Enter' })
  expect(select).toHaveBeenCalledWith('one')
})
