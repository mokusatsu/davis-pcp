import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import CobwebTreeViewer from '../src/features/clustering/CobwebTreeViewer'
import DiscCategoryMatrix from '../src/features/clustering/DiscCategoryMatrix'

const charts = vi.hoisted(() => ({ current: new Map<string, any>() }))
vi.mock('../src/features/charts/EChart', () => ({ default: (props: any) => {
  charts.current.set(props.testId, props)
  return <div data-testid={props.testId} />
} }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef', selectionColor: '#2a78d6' }) }))
vi.mock('../src/features/common/ColumnQuestionTooltip', () => ({ default: ({ children }: any) => children }))
afterEach(() => { cleanup(); charts.current.clear() })

it('preserves Cobweb row membership and central selection highlighting in ECharts nodes', () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base, selection: { ...base.selection, selectedRowIds: ['r1'] } }) })
  const select = vi.fn()
  const child = { id: 'leaf', name: 'Leaf', count: 1, rowIndices: [0], stats: { x: { mean: 2 } }, children: [] }
  render(<Provider store={local}><CobwebTreeViewer conceptTree={{ ...child, id: 'root', name: 'Root', count: 2, rowIndices: [0, 1], children: [child] }} rowIds={['r1', 'r2']} onSelectRows={select} /></Provider>)
  const props = charts.current.get('cobweb-tree-chart')
  const point = props.option.series[0].data[0].children[0]
  expect(point.itemStyle.borderColor).toBe('#2a78d6')
  expect(point.itemStyle.borderWidth).toBe(3)
  act(() => { props.onEvents.click({ data: point }) })
  expect(select).toHaveBeenCalledWith(['r1'])
})

it('preserves exact DISC category distances and tooltips in the heatmap', () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => base })
  render(<Provider store={local}><DiscCategoryMatrix clusterCount={1} categoryMatrices={{ '0': { Q: { categories: ['A', 'B'], matrix: [[0, .75], [.75, 0]] } } }} /></Provider>)
  const props = charts.current.get('disc-heatmap-chart')
  expect(props.option.xAxis.data).toEqual(['A', 'B'])
  expect(props.option.series[0].data.map((point: any) => point.value)).toEqual([[0, 0, 0], [1, 0, .75], [0, 1, .75], [1, 1, 0]])
  expect(props.option.series[0].data[1].description).toContain('Distance(A, B) = 0.7500')
})

it('fits the complete Cobweb topology and preserves expansion/row actions through repeated panel expansion', async () => {
  const local = configureStore({ reducer: () => store.getState() })
  const select = vi.fn()
  const leaf = (id: string) => ({ id, name: id, count: 1, rowIndices: [0], stats: {}, children: [] })
  const tree = { ...leaf('root'), children: Array.from({ length: 30 }, (_, i) => leaf(`leaf-${i}`)) }
  const view = render(<Provider store={local}><GraphExpansionProvider><CobwebTreeViewer conceptTree={tree} rowIds={['r1']} onSelectRows={select} /></GraphExpansionProvider></Provider>)
  const original = view.getByTestId('cobweb-tree-chart')
  expect(charts.current.get('cobweb-tree-chart').height).toBe(1090)
  expect(view.getByTestId('graph-surface-clusters/cobweb')).toHaveStyle({ minHeight: '1090px' })
  for (let i = 0; i < 2; i++) {
    fireEvent.click(view.getByTestId('graph-expand-clusters/cobweb'))
    await waitFor(() => expect(view.getByTestId('graph-expansion-dock')).toContainElement(original))
    expect(view.getByTestId('graph-surface-clusters/cobweb')).toHaveStyle({ height: '1090px' })
    fireEvent.click(view.getByTestId('graph-expansion-zoom-in'))
    act(() => charts.current.get('cobweb-tree-chart').onEvents.click({ data: { id: 'leaf-0' } }))
    expect(select).toHaveBeenLastCalledWith(['r1'])
    fireEvent.click(view.getByTestId('graph-expansion-exit'))
    expect(view.getByTestId('cobweb-tree-chart')).toBe(original)
  }
})

it('updates DISC drawing dimensions for all categories and keeps the same native chart on expansion', async () => {
  const local = configureStore({ reducer: () => store.getState() })
  const categories = Array.from({ length: 30 }, (_, i) => `Category ${i}`)
  const matrix = categories.map((_, i) => categories.map((_, j) => i === j ? 0 : .75))
  const view = render(<Provider store={local}><GraphExpansionProvider><DiscCategoryMatrix clusterCount={1} categoryMatrices={{ '0': { Q: { categories, matrix } } }} /></GraphExpansionProvider></Provider>)
  const original = view.getByTestId('disc-heatmap-chart')
  expect(charts.current.get('disc-heatmap-chart')).toMatchObject({ width: 1405, height: 1380 })
  expect(charts.current.get('disc-heatmap-chart').option.series[0].data).toHaveLength(900)
  fireEvent.click(view.getByTestId('graph-expand-clusters/disc'))
  await waitFor(() => expect(view.getByTestId('graph-expansion-dock')).toContainElement(original))
  expect(view.getByTestId('graph-surface-clusters/disc')).toHaveStyle({ height: '1380px', width: '1405px' })
  fireEvent.click(view.getByTestId('graph-expansion-exit'))
  expect(view.getByTestId('disc-heatmap-chart')).toBe(original)
})
