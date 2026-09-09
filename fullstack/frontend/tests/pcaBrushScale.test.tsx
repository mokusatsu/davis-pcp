import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { PcaMatrixPlot } from '../src/features/pca/PcaMatrixPlot'

vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ isTargetActive: () => false }), FocusTarget: ({ children }: any) => children, FocusEnterButton: () => null }))
vi.mock('../src/features/common/CanvasColumnQuestions', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff', isSelected: () => false, selectionColor: '#000' }) }))
const fixture = vi.hoisted(() => ({ operation: 'replace' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ getBrushOp: () => fixture.operation }))
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
        const view = render(<Provider store={local}>{plot === 'biplot'
          ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
          : <PcaMatrixPlot pcaData={pcaData} />}</Provider>)
        const canvas = view.container.querySelector('canvas')!
        canvas.setPointerCapture = vi.fn()
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 70, top: 90, width: canvas.width * scale, height: canvas.height * scale } as DOMRect)
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
