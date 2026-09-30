import { getInstanceByDom } from 'echarts'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { store, datasetLoaded, selectionCleared } from '../src/app/store'
import RelationshipCanvas from '../src/features/relationships/RelationshipCanvas'

const operation = vi.hoisted(() => ({ value: 'replace' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ getBrushOp: () => operation.value }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); store.dispatch(selectionCleared()) })

it('uses the central selection operations for Canvas clicks and brushes and cancels stale drags', () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  store.dispatch(datasetLoaded({ datasetId: 'canvas-test', rowIds: ['r1', 'r2', 'r3'], name: 'Canvas' }))
  const data = { rowIds: ['r1', 'r2', 'r3'], x: [0, 1, 2], y: [0, 1, 2] }
  const colorOf = () => '#1677ff'
  const view = render(<Provider store={store}><RelationshipCanvas data={data} labels={['X', 'Y']} colorOf={colorOf} /></Provider>)
  const chartDom = view.getByRole('img', { name: '焦点ペア散布図' })
  const chart = getInstanceByDom(chartDom)!
  act(() => { chart.resize({ width: 600, height: 420 }) })
  const canvas = chartDom.parentElement!
  Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const click = (x: number, y: number) => { fireEvent.pointerDown(canvas, { clientX: x, clientY: y, button: 0 }); fireEvent.pointerUp(canvas, { clientX: x, clientY: y }) }
  const mid = chart.convertToPixel({ gridIndex: 0 }, [1, 1]) as number[], low = chart.convertToPixel({ gridIndex: 0 }, [0, 0]) as number[]
  click(mid[0], mid[1])
  expect(store.getState().selection.selectedRowIds).toEqual(['r2'])
  operation.value = 'add'; click(low[0], low[1])
  expect(new Set(store.getState().selection.selectedRowIds)).toEqual(new Set(['r1', 'r2']))
  operation.value = 'subtract'; click(low[0], low[1])
  expect(store.getState().selection.selectedRowIds).toEqual(['r2'])
  operation.value = 'toggle'; click(mid[0], mid[1])
  expect(store.getState().selection.selectedRowIds).toEqual([])
  operation.value = 'replace'
  fireEvent.pointerDown(canvas, { clientX: 0, clientY: 0, button: 0 })
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 420 })
  expect(store.getState().selection.selectedRowIds).toEqual(['r1', 'r2', 'r3'])
  fireEvent.pointerDown(canvas, { clientX: 0, clientY: 0, button: 0 })
  view.rerender(<Provider store={store}><RelationshipCanvas data={{ rowIds: [], x: [], y: [] }} labels={['X', 'Y']} colorOf={colorOf} /></Provider>)
  fireEvent.pointerUp(canvas, { clientX: 600, clientY: 420 })
  expect(store.getState().selection.selectedRowIds).toEqual(['r1', 'r2', 'r3'])
})

it('maps a compact rendered ECharts hit back to its logical coordinates', () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  store.dispatch(datasetLoaded({ datasetId: 'canvas-compact-test', rowIds: ['r1', 'r2', 'r3'], name: 'Canvas' }))
  const data = { rowIds: ['r1', 'r2', 'r3'], x: [0, 1, 2], y: [0, 1, 2] }
  const view = render(<Provider store={store}><RelationshipCanvas data={data} labels={['X', 'Y']} colorOf={() => '#1677ff'} /></Provider>)
  const chartDom = view.getByRole('img', { name: '焦点ペア散布図' })
  const chart = getInstanceByDom(chartDom)!
  act(() => { chart.resize({ width: 600, height: 420 }) })
  const canvas = chartDom.parentElement!
  Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 210 } as DOMRect)
  const [x, y] = chart.convertToPixel({ gridIndex: 0 }, [1, 1]) as number[]
  fireEvent.pointerDown(canvas, { clientX: x / 2, clientY: y / 2, button: 0 })
  fireEvent.pointerUp(canvas, { clientX: x / 2, clientY: y / 2 })

  expect(store.getState().selection.selectedRowIds).toEqual(['r2'])
})
