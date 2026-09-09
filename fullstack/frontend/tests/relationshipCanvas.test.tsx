import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { store, datasetLoaded, selectionCleared } from '../src/app/store'
import RelationshipCanvas from '../src/features/relationships/RelationshipCanvas'

const operation = vi.hoisted(() => ({ value: 'replace' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ getBrushOp: () => operation.value }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); store.dispatch(selectionCleared()) })

it('uses the central selection operations for Canvas clicks and brushes and cancels stale drags', () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  store.dispatch(datasetLoaded({ datasetId: 'canvas-test', rowIds: ['r1', 'r2', 'r3'], name: 'Canvas' }))
  const data = { rowIds: ['r1', 'r2', 'r3'], x: [0, 1, 2], y: [0, 1, 2] }
  const colorOf = () => '#1677ff'
  const view = render(<Provider store={store}><RelationshipCanvas data={data} labels={['X', 'Y']} colorOf={colorOf} /></Provider>)
  const canvas = view.getByRole('img', { name: '焦点ペア散布図' })
  Object.defineProperty(canvas, 'setPointerCapture', { value: vi.fn() })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 420 } as DOMRect)
  const click = (x: number, y: number) => { fireEvent.pointerDown(canvas, { clientX: x, clientY: y, button: 0 }); fireEvent.pointerUp(canvas, { clientX: x, clientY: y }) }
  click(315, 200)
  expect(store.getState().selection.selectedRowIds).toEqual(['r2'])
  operation.value = 'add'; click(50, 370)
  expect(new Set(store.getState().selection.selectedRowIds)).toEqual(new Set(['r1', 'r2']))
  operation.value = 'subtract'; click(50, 370)
  expect(store.getState().selection.selectedRowIds).toEqual(['r2'])
  operation.value = 'toggle'; click(315, 200)
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
