import { getInstanceByDom } from 'echarts'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { PcaMatrixPlot } from '../src/features/pca/PcaMatrixPlot'

import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
vi.mock('../src/features/common/CanvasColumnQuestions', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff', isSelected: () => false, selectionColor: '#000' }) }))
const fixture = vi.hoisted(() => ({ operation: 'replace' }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ getBrushOp: () => fixture.operation, useBrushOp: () => [fixture.operation, (operation: string) => { fixture.operation = operation }] }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

// Ask ECharts for logical point coordinates, independently of the CSS display scale.
const pcaData = { nComponents: 2, eigenvalues: [1, 1], explainedVarianceRatio: [0.5, 0.5], columns: [], loadings: {}, scores: [
  { rowId: 'canonical-center', pc: [0, 0] }, { rowId: 'left', pc: [-1, -1] }, { rowId: 'right', pc: [1, 1] },
] } as any

for (const plot of ['biplot', 'matrix']) {
  for (const scale of [0.5, 1, 2]) {
    for (const operation of ['replace', 'add', 'subtract', 'toggle']) {
      it(`${plot} maps a ${scale}x displayed brush to canonical rows (${operation})`, () => {
        vi.stubGlobal('PointerEvent', MouseEvent)
        fixture.operation = operation
        const local = configureStore({ reducer: () => store.getState(), middleware: g => g({ serializableCheck: false }) })
        const dispatch = vi.spyOn(local, 'dispatch')
        const view = render(<Provider store={local}><GraphExpansionProvider>{plot === 'biplot'
          ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
          : <PcaMatrixPlot pcaData={pcaData} />}</GraphExpansionProvider></Provider>)
        const chartDom = view.getByTestId(plot === 'biplot' ? 'pca-biplot-canvas' : 'pca-matrix-canvas')
        const chart = getInstanceByDom(chartDom)!
        const canvas = chartDom.closest<HTMLElement>('[data-chart-host="echarts"]')!.parentElement!
        const width = plot === 'biplot' ? 720 : 640, height = plot === 'biplot' ? 480 : 640
        act(() => { chart.resize({ width, height }) })
        canvas.setPointerCapture = vi.fn()
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 70, top: 90, width: width * scale, height: height * scale } as DOMRect)
        const [x, y] = chart.convertToPixel({ gridIndex: plot === 'biplot' ? 0 : 1 }, [0, 0]) as number[]
        fireEvent.pointerDown(canvas, { button: 0, clientX: 70 + (x - 20 / scale) * scale, clientY: 90 + (y - 20 / scale) * scale })
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
        fireEvent.pointerDown(canvas, { button: 0, clientX: 70 + (x - 20 / scale) * scale, clientY: 90 + (y - 20 / scale) * scale })
        fireEvent.pointerCancel(canvas)
        fireEvent.pointerUp(canvas, { clientX: 70 + (x + 10) * scale, clientY: 90 + (y + 10) * scale })
        expect(dispatch).not.toHaveBeenCalled()
      })
    }
  }
}

for (const plot of ['biplot', 'matrix']) {
  it(`${plot} preserves the ECharts SVG instance across expansion, zoom and DPR changes and cancels an old brush`, async () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    vi.stubGlobal('devicePixelRatio', 2)
    const local = configureStore({ reducer: () => store.getState(), middleware: g => g({ serializableCheck: false }) })
    const dispatch = vi.spyOn(local, 'dispatch')
    const view = render(<Provider store={local}><GraphExpansionProvider>{plot === 'biplot'
      ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
      : <PcaMatrixPlot pcaData={pcaData} />}</GraphExpansionProvider></Provider>)
    const chartDom = view.getByTestId(plot === 'biplot' ? 'pca-biplot-canvas' : 'pca-matrix-canvas')
    const chart = getInstanceByDom(chartDom)!
    const width = plot === 'biplot' ? 720 : 640, height = plot === 'biplot' ? 480 : 640
    act(() => { chart.resize({ width, height }) })
    const pointerHost = chartDom.closest<HTMLElement>('[data-chart-host="echarts"]')!.parentElement!
    pointerHost.setPointerCapture = vi.fn()
    vi.spyOn(pointerHost, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width, height } as DOMRect)
    const gridIndex = plot === 'biplot' ? 0 : 1
    const [x, y] = chart.convertToPixel({ gridIndex }, [0, 0]) as number[]
    const svg = chartDom.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(chartDom.querySelector('canvas')).toBeNull()
    fireEvent.pointerDown(pointerHost, { button: 0, clientX: x - 20, clientY: y - 20 })
    fireEvent.click(screen.getByTestId(`graph-expand-pca/${plot}`))
    fireEvent.click(await screen.findByTestId('graph-expansion-zoom-in'))
    await waitFor(() => expect(screen.getByTestId(`graph-surface-pca/${plot}`).style.transform).toBe('scale(1.25)'))
    fireEvent.pointerUp(pointerHost, { clientX: x + 10, clientY: y + 10 })
    expect(dispatch.mock.calls.some(([action]) => action.type === selectionApplied.type)).toBe(false)
    expect(getInstanceByDom(chartDom)).toBe(chart)
    expect(chartDom.querySelector('svg')).toBe(svg)
    // SVG stays resolution independent; DPR/zoom never reintroduce a Canvas renderer.
    vi.stubGlobal('devicePixelRatio', 3)
    fireEvent(window, new Event('resize'))
    fireEvent.click(screen.getByTestId('graph-expansion-fit'))
    fireEvent.click(screen.getByTestId('graph-expansion-exit'))
    expect(view.getByTestId(plot === 'biplot' ? 'pca-biplot-canvas' : 'pca-matrix-canvas')).toBe(chartDom)
    expect(getInstanceByDom(chartDom)).toBe(chart)
    expect(chartDom.querySelector('svg')).toBe(svg)
  })
}
