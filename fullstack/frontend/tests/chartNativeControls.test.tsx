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
  const icon = chart.getZr().storage.getDisplayList().find(item => (item as any).__title === 'リセット')!
  expect(icon).toBeDefined()
  const rect = icon.getBoundingRect().clone()
  if (icon.transform) rect.applyTransform(icon.transform)
  return { icon, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

it.each([1, 1.425] as const)('keeps SVG button clicks outside plot capture at display scale %s', scale => {
  const view = render(<Provider store={store}><RowScatter points={[{ rowId: 'r1', x: 1, y: 1 }]}
    xName="X" yName="Y" testId="scatter" /></Provider>)
  const host = view.getByTestId('scatter'), wrapper = view.getByRole('group'), chart = getInstanceByDom(host)!
  host.getBoundingClientRect = wrapper.getBoundingClientRect = () => ({ left: 20, top: 100, width: 600 * scale, height: 420 * scale } as DOMRect)
  const capture = vi.fn()
  Object.defineProperty(wrapper, 'setPointerCapture', { value: capture })
  fireEvent.pointerDown(view.getByRole('button', { name: 'X × Y：SVGを保存' }), { clientX: 580 * scale, clientY: 108 * scale, button: 0 })
  expect(capture).not.toHaveBeenCalled()
  expect(store.getState().selection.selectedRowIds).toEqual([])
  expect(chart).toBeDefined()
})

it('keeps plot point capture and selection while exporting a real SVG Blob', () => {
  const view = render(<Provider store={store}><RowScatter points={[{ rowId: 'r1', x: 1, y: 1 }]}
    xName="X" yName="Y" testId="scatter" /></Provider>)
  const host = view.getByTestId('scatter'), wrapper = view.getByRole('group'), chart = getInstanceByDom(host)!
  host.getBoundingClientRect = wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const capture = vi.fn()
  Object.defineProperty(wrapper, 'setPointerCapture', { value: capture })
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [1, 1]) as number[]
  fireEvent.pointerDown(host.querySelector('svg')!, { clientX: x, clientY: y, button: 0 })
  expect(capture).toHaveBeenCalledTimes(1)
  fireEvent.pointerUp(wrapper, { clientX: x, clientY: y, button: 0 })
  expect(store.getState().selection.selectedRowIds).toEqual(['r1'])

  const create = vi.fn(() => 'blob:svg')
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true)
    expect(this.download).toBe('X × Y.svg')
    expect(this.target).toBe('')
  })
  const button = view.getByRole('button', { name: 'X × Y：SVGを保存' })
  capture.mockClear()
  fireEvent.pointerDown(button, { button: 0 })
  fireEvent.pointerUp(button, { button: 0 })
  fireEvent.click(button)
  expect(capture).not.toHaveBeenCalled()
  expect(click).toHaveBeenCalledTimes(1)
  expect((create.mock.calls[0][0] as Blob).type).toBe('image/svg+xml;charset=utf-8')
  expect(store.getState().selection.selectedRowIds).toEqual(['r1'])
})

it('preserves other native toolbox controls under legacy mouse selection wrappers', () => {
  const down = vi.fn()
  const view = render(<div onMouseDown={down}><EChart testId="chart" option={{ series: [], toolbox: { feature: { restore: { title: 'リセット' } } } }} /></div>)
  const host = view.getByTestId('chart'), chart = getInstanceByDom(host)!
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const { x, y } = toolboxHit(chart)
  fireEvent.mouseDown(host.querySelector('svg')!, { clientX: x, clientY: y, button: 0 })
  expect(down).not.toHaveBeenCalled()
})

it('retains the same export button during frame refreshes between pointer down and up', () => {
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:svg', revokeObjectURL: vi.fn() })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const key = vi.fn(), view = render(<div onKeyDown={key}><EChart testId="moving-chart" option={{ series: [] }} /></div>)
  const button = view.getByRole('button', { name: '統計グラフ：SVGを保存' })
  fireEvent.pointerDown(button, { button: 0 })
  view.rerender(<div onKeyDown={key}><EChart testId="moving-chart" option={{ series: [], backgroundColor: '#eee' }} /></div>)
  expect(view.getByRole('button', { name: '統計グラフ：SVGを保存' })).toBe(button)
  fireEvent.pointerUp(button, { button: 0 })
  fireEvent.click(button)
  expect(click).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(key).not.toHaveBeenCalled()
})
