import { afterEach, expect, it, vi } from 'vitest'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import { cleanup, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { PcaMatrixPlot } from '../src/features/pca/PcaMatrixPlot'

const fixture = vi.hoisted(() => ({
  colors: { getColor: (id: string) => id === 'selected' ? '#bb6600' : '#008855', isSelected: (id: string) => id === 'selected', selectionColor: '#2a78d6' } }))
vi.mock('../src/features/common/CanvasColumnQuestions', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => fixture.colors }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); })

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
    const content = () => <Provider store={store}><GraphExpansionProvider>{plot === 'biplot'
      ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
      : <PcaMatrixPlot pcaData={pcaData} />}</GraphExpansionProvider></Provider>
    const view = render(content())
    expect(fills).toContainEqual({ radius: plot === 'biplot' ? 5 : 3.5, color: '#bb6600' })
    expect(fills).toContainEqual({ radius: plot === 'biplot' ? 3.5 : 2, color: '#008855' })
    expect(outlines).toContainEqual({ radius: plot === 'biplot' ? 5 : 3.5, color: '#2a78d6' })
    expect(fills.some(fill => fill.color === '#2a78d6')).toBe(false)
    // 新方式では拡大・倍率で再マウントしない。同一 canvas のままであることだけ確認する。
    // 再描画の有無は revision 駆動のため、fills の再記録は求めない。
    const previousCanvas = view.container.querySelector('canvas')
    view.rerender(content())
    expect(view.container.querySelector('canvas')).toBe(previousCanvas)
  })
}
