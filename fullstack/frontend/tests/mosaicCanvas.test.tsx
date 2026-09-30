import { getInstanceByDom } from 'echarts'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { datasetLoaded, selectionCleared, store } from '../src/app/store'
import { LineMosaicCanvas, lineMosaicDimensions } from '../src/features/mosaic/LineMosaicCanvas'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import type { LineMosaicResponse } from '../src/features/mosaic/types'

const operation = vi.hoisted(() => ({ value: 'replace' as string }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ getBrushOp: () => operation.value, useBrushOp: () => [operation.value, (value: string) => { operation.value = value }] }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); operation.value = 'replace' })

function mosaicData(): LineMosaicResponse {
  return {
    evidenceClass: 'test',
    maxCellFrequency: 2,
    target: null,
    grid: {
      nCols: 2, nRows: 1,
      colVariables: ['Area'], rowVariables: ['A'],
      colLabels: [{ path: ['F'], j: 1 }, { path: ['M'], j: 2 }],
      rowLabels: [{ path: ['1'], i: 1 }],
    },
    cells: [
      { i: 1, j: 1, totalCount: 2, colPath: ['F'], rowPath: ['1'], targetCounts: {}, rowIds: ['r1', 'r2'] },
      { i: 1, j: 2, totalCount: 1, colPath: ['M'], rowPath: ['1'], targetCounts: {}, rowIds: ['r3'] },
    ],
  }
}

it('reports the actual outer size including the drawing container padding and border', () => {
  expect(lineMosaicDimensions(mosaicData())).toEqual({ width: 455, height: 176 })
})

function setup() {
  store.dispatch(datasetLoaded({ datasetId: 'mosaic-test', rowIds: ['r1', 'r2', 'r3'], name: 'Mosaic' }))
  store.dispatch(selectionCleared())
  const view = render(<Provider store={store}><LineMosaicCanvas mosaicData={mosaicData()} normalization="global" /></Provider>)
  return { local: store, view }
}

function pointer(view: ReturnType<typeof render>, target: Element, type: 'Down' | 'Move' | 'Up', x: number, y: number) {
  const rect = target.getBoundingClientRect()
  const init = { button: 0, pointerId: 7, clientX: rect.left + x, clientY: rect.top + y }
  if (type === 'Down') fireEvent.pointerDown(target, init)
  else if (type === 'Move') fireEvent.pointerMove(target, init)
  else fireEvent.pointerUp(target, init)
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  ;(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture = vi.fn()
})

it('applies the shared brush operation for cell clicks and real-pointer rectangle selection', () => {
  const { local, view } = setup()
  const canvas = view.getByTestId('mosaic-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 433, bottom: 154, width: 433, height: 154 } as DOMRect)
  const chart = getInstanceByDom(canvas.querySelector('[data-chart-renderer=echarts]') as HTMLElement)!
  act(() => { chart.resize({ width: 433, height: 154 }) })
  canvas.querySelector('svg')!.getBoundingClientRect = canvas.getBoundingClientRect
  fireEvent.click(view.getByRole('button', { name: /1 × F: 2行/ }))
  expect(local.getState().selection.selectedRowIds).toEqual(['r1', 'r2'])
  operation.value = 'add'
  pointer(view, canvas, 'Down', 5, 5)
  pointer(view, canvas, 'Move', 390, 190)
  expect((chart.getOption().graphic as any)[0].elements.some((element: any) => element.name === 'mosaic-brush-rect')).toBe(true)
  pointer(view, canvas, 'Up', 390, 190)
  expect(new Set(local.getState().selection.selectedRowIds)).toEqual(new Set(['r1', 'r2', 'r3']))
  expect((chart.getOption().graphic as any)[0].elements.some((element: any) => element.name === 'mosaic-brush-rect')).toBe(false)
})

it('cancels a stale drag when the result changes instead of applying it', () => {
  const { local, view } = setup()
  const canvas = view.getByTestId('mosaic-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 433, bottom: 154, width: 433, height: 154 } as DOMRect)
  const chart = getInstanceByDom(canvas.querySelector('[data-chart-renderer=echarts]') as HTMLElement)!
  act(() => { chart.resize({ width: 433, height: 154 }) })
  canvas.querySelector('svg')!.getBoundingClientRect = canvas.getBoundingClientRect
  pointer(view, canvas, 'Down', 5, 5)
  view.rerender(<Provider store={local}><LineMosaicCanvas
    mosaicData={{ ...mosaicData(), evidenceClass: 'next' }} normalization="global" /></Provider>)
  pointer(view, view.getByTestId('mosaic-canvas'), 'Up', 390, 190)
  expect(local.getState().selection.selectedRowIds).toEqual([])
})


it('keeps the ECharts instance and cancels a pending mosaic brush during expansion and zoom', () => {
  store.dispatch(datasetLoaded({ datasetId: 'mosaic-expansion', rowIds: ['r1', 'r2', 'r3'], name: 'Mosaic' }))
  store.dispatch(selectionCleared())
  const view = render(<Provider store={store}><GraphExpansionProvider><LineMosaicCanvas
    mosaicData={mosaicData()} normalization="global" /></GraphExpansionProvider></Provider>)
  const canvas = view.getByTestId('mosaic-canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 433, bottom: 154, width: 433, height: 154 } as DOMRect)
  const chartHost = canvas.querySelector('[data-chart-renderer=echarts]') as HTMLElement
  const chart = getInstanceByDom(chartHost)!
  act(() => { chart.resize({ width: 433, height: 154 }) })
  canvas.querySelector('svg')!.getBoundingClientRect = canvas.getBoundingClientRect
  pointer(view, canvas, 'Down', 5, 5)
  fireEvent.click(view.getByTestId('graph-expand-mosaic/main'))
  fireEvent.click(view.getByTestId('graph-expansion-zoom-in'))
  pointer(view, canvas, 'Up', 390, 150)
  expect(store.getState().selection.selectedRowIds).toEqual([])
  expect(getInstanceByDom(chartHost)).toBe(chart)
  const controls = view.getByTestId('graph-controls-mosaic/main')
  expect(controls.querySelector('details')).not.toBeNull()
  expect(view.getByTestId('graph-surface-mosaic/main').querySelector('details')).toBeNull()
  fireEvent.click(view.getByTestId('graph-expansion-exit'))
  expect(getInstanceByDom(chartHost)).toBe(chart)
})
