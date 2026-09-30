import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { PcaMatrixPlot } from '../src/features/pca/PcaMatrixPlot'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'

vi.mock('../src/features/common/CanvasColumnQuestions', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff', isSelected: () => false, selectionColor: '#000', selectedSet: new Set() }) }))
const fixture = vi.hoisted(() => ({ operation: 'replace' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({
  getBrushOp: () => fixture.operation,
  useBrushOp: () => [fixture.operation, (operation: typeof fixture.operation) => { fixture.operation = operation }],
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Center lies at (370,230) in the biplot and (467.5,172.5) in matrix cell PC2/PC1.
const pcaData = { nComponents: 2, eigenvalues: [1, 1], explainedVarianceRatio: [0.5, 0.5], columns: [], loadings: {}, scores: [
  { rowId: 'canonical-center', pc: [0, 0] }, { rowId: 'left', pc: [-1, -1] }, { rowId: 'right', pc: [1, 1] },
] } as any

for (const plot of ['biplot', 'matrix']) {
  for (const scale of [0.5, 1, 2]) {
    for (const operation of ['replace', 'add', 'subtract', 'toggle']) {
      it(`${plot} maps a ${scale}x displayed brush to canonical rows (${operation})`, () => {
        vi.stubGlobal('PointerEvent', MouseEvent)
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
        fixture.operation = operation
        const local = configureStore({ reducer: () => store.getState(), middleware: g => g({ serializableCheck: false }) })
        const dispatch = vi.spyOn(local, 'dispatch')
        const view = render(<Provider store={local}><GraphExpansionProvider>{plot === 'biplot'
          ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
          : <PcaMatrixPlot pcaData={pcaData} />}</GraphExpansionProvider></Provider>)
        const canvas = view.container.querySelector('canvas')!
        canvas.setPointerCapture = vi.fn()
        // 論理寸法は固定（biplot 720x480 / matrix 640x640）。属性 width は描画バッファのため使わない。
        const logical = plot === 'biplot' ? { width: 720, height: 480 } : { width: 640, height: 640 }
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 70, top: 90, width: logical.width * scale, height: logical.height * scale } as DOMRect)
        const [x, y] = plot === 'biplot' ? [370, 230] : [467.5, 172.5]
        fireEvent.pointerDown(canvas, { button: 0, clientX: 70 + (x - 10) * scale, clientY: 90 + (y - 10) * scale })
        fireEvent.pointerMove(canvas, { clientX: 70 + (x + 5) * scale, clientY: 90 + (y + 5) * scale })
        fireEvent.pointerUp(canvas, { clientX: 70 + (x + 10) * scale, clientY: 90 + (y + 10) * scale })
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: selectionApplied.type, payload: expect.objectContaining({ rowIds: ['canonical-center'], operation }) }))
        expect(canvas.setPointerCapture).toHaveBeenCalledTimes(1)
        dispatch.mockClear()
        // Point clicks toggle the nearest row even when the rectangle menu uses another operation.
        fireEvent.pointerDown(canvas, { button: 0, clientX: 70 + x * scale + 3, clientY: 90 + y * scale })
        fireEvent.pointerUp(canvas, { clientX: 70 + x * scale + 3, clientY: 90 + y * scale })
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: ['canonical-center'], operation: 'toggle' }) }))
        dispatch.mockClear()
        // Empty rectangle in the same valid cell must still reach the selection reducer.
        fireEvent.pointerDown(canvas, { button: 0, clientX: 70 + (x + 20) * scale, clientY: 90 + (y + 20) * scale })
        fireEvent.pointerUp(canvas, { clientX: 70 + (x + 35) * scale, clientY: 90 + (y + 35) * scale })
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: [], operation }) }))
        dispatch.mockClear()
        fireEvent.pointerDown(canvas, { button: 0, clientX: 70 + (x - 10) * scale, clientY: 90 + (y - 10) * scale })
        fireEvent.pointerCancel(canvas)
        fireEvent.pointerUp(canvas, { clientX: 70 + (x + 10) * scale, clientY: 90 + (y + 10) * scale })
        expect(dispatch).not.toHaveBeenCalled()
      })
    }
  }
}

it('biplot rebuilds its Canvas buffer for the expanded GraphPanel scale and DPR', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('devicePixelRatio', 2)
  const ctx = new Proxy({ setTransform: vi.fn() } as any, {
    get: (target, key) => key in target ? target[key] : () => {},
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
  const local = configureStore({ reducer: () => store.getState(), middleware: g => g({ serializableCheck: false }) })
  const view = render(
    <Provider store={local}>
      <GraphExpansionProvider>
        <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
      </GraphExpansionProvider>
    </Provider>,
  )
  const canvas = view.container.querySelector('canvas')!
  await waitFor(() => expect(canvas.width).toBe(1440))
  expect(canvas.height).toBe(960)

  fireEvent.click(screen.getByTestId('graph-expand-pca/biplot'))
  fireEvent.click(await screen.findByTestId('graph-expansion-zoom-in'))
  await waitFor(() => {
    expect(canvas.width).toBe(1800)
    expect(canvas.height).toBe(1200)
  })
  expect(ctx.setTransform).toHaveBeenLastCalledWith(2.5, 0, 0, 2.5, 0, 0)
})
