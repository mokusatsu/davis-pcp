import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import ColumnSelect from '../src/features/common/ColumnSelect'
import StatisticsPage from '../src/features/dataset/StatisticsPage'
import BarChartPage from '../src/features/barchart/BarChartPage'
import { graphEngine } from '../src/engine/graphClient'
import type { CodebookColumn } from '../src/api/client'
import { useColumnarData } from '../src/features/pcp/useDatasetColumns'

const fixture = vi.hoisted(() => ({
  rowIds: ['r1', 'r2', 'r3', 'r4'], rowIndex: new Map([['r1', 0], ['r2', 1], ['r3', 2], ['r4', 3]]),
  schema: [{ columnId: 'q', name: 'Q', semanticType: 'numeric' }],
  columns: { Q: [1, 2, 99, null] }, numeric: { Q: new Float64Array([1, 2, 99, NaN]) },
  minMax: { Q: { min: 1, max: 99 } }, categories: {},
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: vi.fn(() => fixture) }))
vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ focused: false, isTargetActive: () => false }), FocusTarget: ({ children }: any) => children, FocusEnterButton: () => null }))
vi.mock('../src/engine/graphClient', () => ({ graphEngine: { describeNumeric: vi.fn(async () => [2, 2, 1.5, .5, 1, 1, 1.5, 2, 2]) } }))
const spec: CodebookColumn = { columnId: 'q', name: 'Q', label: '普段の生活についての長い設問全文', role: 'question', scaleType: 'ordinal', categoryOrder: ['2', '1'], valueLabels: { '1': '同じ表示', '2': '同じ表示', '99': '無回答' }, missingCodes: ['99'], missingReasons: {}, isReversed: false, multiResponseGroup: null }
function setup(scale: CodebookColumn['scaleType'] = 'ordinal') {
  const initial = store.getState()
  const state = { ...initial,
    selection: { ...initial.selection, datasetId: 'ds', allRowIds: fixture.rowIds, activeRowIds: fixture.rowIds, selectedRowIds: [] },
    globalObservations: { ...initial.globalObservations, activeRowIds: fixture.rowIds, totalRowIds: fixture.rowIds },
    globalVariables: { ...initial.globalVariables, activeEntities: [{ kind: 'column', columnId: 'q' }] },
    codebook: { ...initial.codebook, datasetId: 'ds', columns: [{ ...spec, scaleType: scale }] },
  }
  return configureStore({ reducer: (s = state, a: any) => {
    if (a.type === 'test/columns') return { ...s, codebook: { ...s.codebook, columns: a.payload } }
    if (a.type === 'test/entities') return { ...s, globalVariables: { ...s.globalVariables, activeEntities: a.payload } }
    if (a.type === 'test/scope') return { ...s, globalObservations: { ...s.globalObservations, activeRowIds: a.payload } }
    return s
  }, middleware: g => g({ serializableCheck: false }) })
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('saved codebook display', () => {
  it.each([undefined, 'multiple'] as const)('shows name and question with one information control (%s)', async mode => {
    const onChange = vi.fn()
    // 単一選択の選択値面はプレーンテキストのみ（ⓘはドロップダウンの選択肢側）。open で選択肢を開いて検証する。
    const { container } = render(<Provider store={setup()}><ColumnSelect mode={mode} value={mode ? ['Q'] : 'Q'} options={[{ value: 'Q', label: 'Q' }]} onChange={onChange} open={mode ? undefined : true} /></Provider>)
    expect(container.textContent).toContain(`Q — ${spec.label}`)
    if (!mode) {
      expect(within(container).queryByRole('button', { name: 'Qの設問文を表示' })).toBeNull()
    }
    const buttons = screen.getAllByRole('button', { name: 'Qの設問文を表示' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    expect(await screen.findByRole('tooltip')).toHaveTextContent(spec.label)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('filters options by question text and updates saved labels', async () => {
    const testStore = setup()
    render(<Provider store={testStore}><ColumnSelect showSearch open options={[{ value: 'Q', label: 'Q' }, { value: 'other', label: 'other' }]} /></Provider>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '普段の生活' } })
    await waitFor(() => expect(document.querySelectorAll('.ant-select-item-option')).toHaveLength(1))
    act(() => { testStore.dispatch({ type: 'test/columns', payload: [{ ...spec, label: '変更後の設問' }] }) })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '変更後' } })
    await waitFor(() => expect(screen.getByText('Q — 変更後の設問')).toBeInTheDocument())
  })
  it('uses ordinal categories, missing mask and codebook order instead of numeric histograms', async () => {
    render(<Provider store={setup()}><MemoryRouter><StatisticsPage /></MemoryRouter></Provider>)
    const card = await screen.findByTestId('question-card-Q')
    expect(within(card).getByText('順序尺度')).toBeInTheDocument()
    const categories = card.querySelectorAll('[data-testid^="category-Q-"]')
    expect(Array.from(categories, e => e.getAttribute('data-testid'))).toEqual(['category-Q-2', 'category-Q-1'])
    expect(card).toHaveTextContent('50.0% (1)')
    expect(screen.queryByTestId('histogram-Q')).toBeNull()
    expect(graphEngine.describeNumeric).not.toHaveBeenCalled()
    expect(within(card).getByTestId('denominators-bar')).toHaveTextContent('有効: 2')
    expect(within(card).getByTestId('denominators-bar')).toHaveTextContent('無回答: 2')
  })
  it('masks missing codes for numeric summaries and responds to a saved scale change', async () => {
    const testStore = setup('ratio')
    render(<Provider store={testStore}><MemoryRouter><StatisticsPage /></MemoryRouter></Provider>)
    await screen.findByTestId('histogram-Q')
    expect(Array.from(vi.mocked(graphEngine.describeNumeric).mock.calls[0][0])).toEqual([1, 2, NaN, NaN])
    act(() => { testStore.dispatch({ type: 'test/columns', payload: [spec] }) })
    await screen.findByTestId('question-card-Q')
    expect(screen.queryByTestId('histogram-Q')).toBeNull()
  })
  it('labels bars without merging codes that share a label and shows the full question', async () => {
    render(<Provider store={setup()}><BarChartPage /></Provider>)
    const bars = await screen.findAllByTestId(/^barchart-bar-/)
    expect(bars).toHaveLength(4)
    expect(bars[0]).toHaveTextContent('同じ表示')
    expect(bars[1]).toHaveTextContent('同じ表示')
    expect(screen.getByTestId('barchart-questions')).toHaveTextContent(spec.label)
    fireEvent.mouseEnter(bars[0])
    expect(screen.getByRole('status')).toHaveTextContent('同じ表示 (1)')
  })

  it('projects only ordinary chart inputs, follows the shared scope and keeps no variables empty', async () => {
    const local = setup()
    act(() => { local.dispatch({ type: 'test/columns', payload: [spec,
      { ...spec, columnId: 'child', name: 'MAChild', multiResponseGroup: 'services' },
      { ...spec, columnId: 'unused', name: 'Unused' }] }) })
    render(<Provider store={local}><BarChartPage /></Provider>)
    await screen.findAllByTestId(/^barchart-bar-/)
    expect(useColumnarData).toHaveBeenLastCalledWith('ds', ['Q'])
    act(() => { local.dispatch({ type: 'test/scope', payload: ['r2'] }) })
    await waitFor(() => expect(screen.getAllByTestId(/^barchart-bar-/)).toHaveLength(1))
    expect(screen.getByTestId('barchart-bar-0').querySelector('title')).toHaveTextContent('同じ表示 (2)')
    act(() => { local.dispatch({ type: 'test/entities', payload: [] }) })
    await waitFor(() => expect(useColumnarData).toHaveBeenLastCalledWith('ds', []))
    expect(screen.queryAllByTestId(/^barchart-bar-/)).toHaveLength(0)
    act(() => { local.dispatch({ type: 'test/entities', payload: [{ kind: 'column', columnId: 'child' }] }) })
    expect(useColumnarData).toHaveBeenLastCalledWith('ds', [])
    expect(screen.queryAllByTestId(/^barchart-bar-/)).toHaveLength(0)
  })
})
