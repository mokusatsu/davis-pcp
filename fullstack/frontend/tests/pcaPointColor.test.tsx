import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { PcaMatrixPlot } from '../src/features/pca/PcaMatrixPlot'

const fixture = vi.hoisted(() => ({ focused: null as string | null, zoom: null as number | null,
  colors: { getColor: (id: string) => id === 'selected' ? '#bb6600' : '#008855', isSelected: (id: string) => id === 'selected', selectionColor: '#2a78d6' } }))
vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ focused: fixture.focused, zoom: fixture.zoom, isTargetActive: () => Boolean(fixture.focused) }),
  FocusTarget: ({ children }: any) => <div key={`${fixture.focused}:${fixture.zoom}`}>{children}</div>, FocusEnterButton: () => null }))
vi.mock('../src/features/common/CanvasColumnQuestions', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => fixture.colors }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); fixture.focused = null; fixture.zoom = null })

for (const plot of ['biplot', 'matrix']) {
  it(`${plot} preserves resolved L1/L2 fill and highlights selection with a larger outlined point`, () => {
    const fills: { radius: number; color: string }[] = []
    const outlines: { radius: number; color: string }[] = []
    let radius: number | null = null
    const ctx = new Proxy({ fillStyle: '', strokeStyle: '',
      beginPath: () => { radius = null },
      arc: (_x: number, _y: number, r: number) => { radius = r },
      fill: () => { if (radius !== null) fills.push({ radius, color: ctx.fillStyle }) },
      stroke: () => { if (radius !== null) outlines.push({ radius, color: ctx.strokeStyle }) },
    } as any, { get: (target, key) => key in target ? target[key] : () => {} })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx)
    const pcaData = { nComponents: 2, eigenvalues: [1, 1], explainedVarianceRatio: [0.5, 0.5], columns: [], loadings: {}, scores: [
      { rowId: 'selected', pc: [-1, -1] }, { rowId: 'unselected', pc: [1, 1] },
    ] } as any
    const content = () => <Provider store={store}>{plot === 'biplot'
      ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
      : <PcaMatrixPlot pcaData={pcaData} />}</Provider>
    const view = render(content())
    expect(fills).toContainEqual({ radius: plot === 'biplot' ? 5 : 3.5, color: '#bb6600' })
    expect(fills).toContainEqual({ radius: plot === 'biplot' ? 3.5 : 2, color: '#008855' })
    expect(outlines).toContainEqual({ radius: plot === 'biplot' ? 5 : 3.5, color: '#2a78d6' })
    expect(fills.some(fill => fill.color === '#2a78d6')).toBe(false)
    for (const [focused, zoom] of [['pca', null], ['pca', 2], ['pca', null], [null, null]] as const) {
      const previousCanvas = view.container.querySelector('canvas')
      fills.length = 0
      fixture.focused = focused
      fixture.zoom = zoom
      view.rerender(content())
      expect(view.container.querySelector('canvas')).not.toBe(previousCanvas)
      expect(fills).toContainEqual({ radius: plot === 'biplot' ? 5 : 3.5, color: '#bb6600' })
    }
  })
}
