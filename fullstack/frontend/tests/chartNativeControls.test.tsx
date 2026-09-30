import { cleanup, fireEvent, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { getInstanceByDom, type ECharts } from 'echarts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { datasetLoaded, selectionCleared, store } from '../src/app/store'
import RowScatter from '../src/features/charts/RowScatter'
import EChart from '../src/features/charts/EChart'

beforeEach(() => {
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    readonly pointerId: number
    constructor(type: string, init?: PointerEventInit) { super(type, init); this.pointerId = init?.pointerId ?? 1 }
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(420)
  store.dispatch(datasetLoaded({ datasetId: 'native-controls', rowIds: ['r1'], name: 'Native controls' }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); store.dispatch(selectionCleared()) })

function toolboxHit(chart: ECharts) {
  const icon = chart.getZr().storage.getDisplayList().find(item => (item as any).__title === 'SVGを保存')!
  expect(icon).toBeDefined()
  const rect = icon.getBoundingRect().clone()
  if (icon.transform) rect.applyTransform(icon.transform)
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
  expect(chart.getZr().findHover(x, y).target).toBe(icon)
  return { icon, x, y }
}

it.each([1, 1.425] as const)('leaves native SVG export pointer clicks uncaptured at display scale %s', scale => {
  const view = render(<Provider store={store}><RowScatter points={[{ rowId: 'r1', x: 1, y: 1 }]}
    xName="X" yName="Y" testId="scatter" /></Provider>)
  const host = view.getByTestId('scatter'), wrapper = host.parentElement!, chart = getInstanceByDom(host)!
  const rect = { left: 20, top: 100, width: 600 * scale, height: 420 * scale } as DOMRect
  host.getBoundingClientRect = wrapper.getBoundingClientRect = () => rect
  const capture = vi.fn()
  Object.defineProperty(wrapper, 'setPointerCapture', { value: capture })
  const { x, y } = toolboxHit(chart)
  fireEvent.pointerDown(host.querySelector('svg')!, { clientX: 20 + x * scale, clientY: 100 + y * scale, button: 0 })
  expect(capture).not.toHaveBeenCalled()
  expect(store.getState().selection.selectedRowIds).toEqual([])
})

it('keeps plot point capture and selection while exporting through the native toolbox', () => {
  const view = render(<Provider store={store}><RowScatter points={[{ rowId: 'r1', x: 1, y: 1 }]}
    xName="X" yName="Y" testId="scatter" /></Provider>)
  const host = view.getByTestId('scatter'), wrapper = host.parentElement!, chart = getInstanceByDom(host)!
  host.getBoundingClientRect = wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const capture = vi.fn()
  Object.defineProperty(wrapper, 'setPointerCapture', { value: capture })
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [1, 1]) as number[]
  fireEvent.pointerDown(host.querySelector('svg')!, { clientX: x, clientY: y, button: 0 })
  expect(capture).toHaveBeenCalledTimes(1)
  fireEvent.pointerUp(wrapper, { clientX: x, clientY: y, button: 0 })
  expect(store.getState().selection.selectedRowIds).toEqual(['r1'])

  const anchor = document.createElement('a'), dispatch = vi.spyOn(anchor, 'dispatchEvent').mockReturnValue(true)
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) =>
    tagName === 'a' ? anchor : create(tagName, options))
  // Vitest's Window proxy is rejected as UIEvent.view by jsdom; browsers accept
  // document.defaultView. Keep the real event while omitting that harness proxy.
  const NativeMouseEvent = MouseEvent
  vi.stubGlobal('MouseEvent', class extends NativeMouseEvent {
    constructor(type: string, init?: MouseEventInit) { super(type, { ...init, view: null }) }
  })
  const toolbar = toolboxHit(chart), svg = host.querySelector('svg')!
  capture.mockClear()
  const event = { clientX: toolbar.x, clientY: toolbar.y, button: 0 }
  fireEvent.pointerDown(svg, event)
  fireEvent.mouseDown(svg, event)
  // Model browser pointer capture retargeting: only the uncaptured path leaves
  // the native up/click inside ECharts. No chart.trigger shortcut is used here.
  const clickTarget = capture.mock.calls.length ? wrapper : svg
  fireEvent.pointerUp(clickTarget, event)
  fireEvent.mouseUp(clickTarget, event)
  fireEvent.click(clickTarget, event)
  expect(dispatch).toHaveBeenCalledTimes(1)
  expect(anchor.download).toBe('X × Y.svg')
  expect(anchor.href).toMatch(/^data:image\/svg\+xml/)
  expect(decodeURIComponent(anchor.href)).toContain('<svg')
  expect(store.getState().selection.selectedRowIds).toEqual(['r1'])
})

it('also preserves native controls under legacy mouse-based selection wrappers', () => {
  const down = vi.fn()
  const view = render(<div onMouseDown={down}><EChart testId="chart" option={{ series: [] }} /></div>)
  const host = view.getByTestId('chart'), chart = getInstanceByDom(host)!
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const { x, y } = toolboxHit(chart)
  fireEvent.mouseDown(host.querySelector('svg')!, { clientX: x, clientY: y, button: 0 })
  expect(down).not.toHaveBeenCalled()
})
