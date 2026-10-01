import { getInstanceByDom } from 'echarts'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { store, datasetLoaded, selectionApplied } from '../src/app/store'
import { BiplotView } from '../src/features/pca/BiplotView'
import { PcaMatrixPlot } from '../src/features/pca/PcaMatrixPlot'

const fixture = vi.hoisted(() => ({
  colors: { getColor: (id: string) => id === 'selected' ? '#bb6600' : '#008855', isSelected: (id: string) => id === 'selected', selectionColor: '#2a78d6' } }))
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
vi.mock('../src/features/common/CanvasColumnQuestions', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => fixture.colors }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

for (const plot of ['biplot', 'matrix']) {
  it(`${plot} preserves resolved L1/L2 fill and highlights selection with a larger outlined point`, () => {
    store.dispatch(datasetLoaded({ datasetId: 'pca-color', rowIds: ['selected', 'unselected'], name: 'color' }))
    store.dispatch(selectionApplied({ rowIds: ['selected'], operation: 'replace', label: 'test' }))
    const pcaData = { nComponents: 2, eigenvalues: [1, 1], explainedVarianceRatio: [0.5, 0.5], columns: [], loadings: {}, scores: [
      { rowId: 'selected', pc: [-1, -1] }, { rowId: 'unselected', pc: [1, 1] },
    ] } as any
    const content = () => <Provider store={store}><GraphExpansionProvider>{plot === 'biplot'
      ? <BiplotView pcaData={pcaData} selectedX={0} selectedY={1} onSelectX={() => {}} onSelectY={() => {}} />
      : <PcaMatrixPlot pcaData={pcaData} />}</GraphExpansionProvider></Provider>
    const view = render(content())
    const assertColors = () => {
      const chart = getInstanceByDom(view.getByTestId(plot === 'biplot' ? 'pca-biplot-canvas' : 'pca-matrix-canvas'))!
      const scatter = (chart.getOption().series as any[]).find(series => series.type === 'scatter')
      const selected = scatter.data.find((d: any) => d.rowId === 'selected'), unselected = scatter.data.find((d: any) => d.rowId === 'unselected')
      expect(selected.itemStyle.color).toBe('#bb6600')
      expect(unselected.itemStyle.color).toBe('#008855')
      expect(selected.itemStyle.borderColor).toBe('#2a78d6')
      expect(selected.symbolSize).toBe(9)
      expect(unselected.symbolSize).toBe(6)
      expect(selected.emphasis.scale).toBe(false)
    }
    assertColors()
    const chartDom = view.getByTestId(plot === 'biplot' ? 'pca-biplot-canvas' : 'pca-matrix-canvas')
    const chart = getInstanceByDom(chartDom)
    fireEvent.click(screen.getByTestId(`graph-expand-pca/${plot}`))
    for (const action of ['zoom-in', 'fit', 'exit']) {
      fireEvent.click(screen.getByTestId(`graph-expansion-${action}`))
      expect(view.getByTestId(plot === 'biplot' ? 'pca-biplot-canvas' : 'pca-matrix-canvas')).toBe(chartDom)
      expect(getInstanceByDom(chartDom)).toBe(chart)
      assertColors()
    }
  })
}
