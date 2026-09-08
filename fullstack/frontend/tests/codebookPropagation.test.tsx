import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { codebookSlice, fetchCodebookThunk } from '../src/features/dataset/codebookSlice'
import { buildAxes, buildValues } from '../src/features/pcp/usePcpPipeline'
import { normalizeCode, useCodebookColumn } from '../src/features/dataset/useCodebookColumn'
import TablePage from '../src/features/table/TablePage'
import type { CodebookColumn } from '../src/api/client'

const fixture = vi.hoisted(() => ({
  rowIds: ['r1', 'r2', 'r3'], rowIndex: new Map([['r1', 0], ['r2', 1], ['r3', 2]]),
  schema: [{ columnId: 'q', name: 'Q', semanticType: 'numeric' }],
  columns: { Q: [1, 3, 99] }, numeric: { Q: new Float64Array([1, 3, 99]) },
  minMax: { Q: { min: 1, max: 99 } }, categories: {},
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => fixture }))
vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ focused: false }), FocusTarget: ({ children }: any) => children, FocusEnterButton: () => null }))

const spec: CodebookColumn = { columnId: 'q', name: 'Q', label: '満足度', role: 'question', scaleType: 'ordinal', categoryOrder: ['3', '2', '1'], valueLabels: { '1': '満足', '3': '不満' }, missingCodes: ['99'], missingReasons: { '99': '無回答' }, isReversed: true, multiResponseGroup: null }
function testStore() {
  const state = store.getState()
  return configureStore({ reducer: () => ({ ...state,
    selection: { ...state.selection, datasetId: 'ds', allRowIds: fixture.rowIds, activeRowIds: fixture.rowIds },
    globalObservations: { ...state.globalObservations, activeRowIds: fixture.rowIds, totalRowIds: fixture.rowIds },
    codebook: { ...state.codebook, datasetId: 'ds', columns: [spec] },
  }) })
}
afterEach(cleanup)

describe('codebook propagation', () => {
  it('uses codebook order, zero-count categories and missing mask in PCP geometry', () => {
    const axes = buildAxes(fixture, [spec])
    expect(axes[0]).toMatchObject({ type: 'categorical', label: '満足度', categories: ['3', '2', '1'], isReversed: true })
    const { values } = buildValues(fixture, axes, [0, 1, 2])
    expect(values[0]).toBe(1)
    expect(values[1]).toBe(0)
    expect(values[2]).toBeNaN()
    expect(normalizeCode(1.0)).toBe('1')
    expect(normalizeCode('01')).toBe('01')
  })
  it('switches table labels and keeps raw code in tooltip', () => {
    render(<Provider store={testStore()}><TablePage /></Provider>)
    expect(screen.getByText('満足 (1)')).toBeInTheDocument()
    const cell = screen.getByText('満足 (1)')
    expect(cell.closest('[title]')?.getAttribute('title')).toContain('生コード')
    fireEvent.click(within(screen.getByTestId('table-value-display')).getByText('生値'))
    expect(screen.queryByText('満足 (1)')).not.toBeInTheDocument()
  })
  it('ignores a late response from the previous dataset', () => {
    let state = codebookSlice.reducer(undefined, fetchCodebookThunk.pending('old', 'old-ds'))
    state = codebookSlice.reducer(state, fetchCodebookThunk.pending('new', 'new-ds'))
    state = codebookSlice.reducer(state, fetchCodebookThunk.fulfilled({ datasetId: 'old-ds', schemaRevision: 8, columns: [spec] }, 'old', 'old-ds'))
    expect(state.datasetId).toBe('new-ds')
    expect(state.columns).toEqual([])
  })
  it('provides reversed labeled ticks through the common hook', () => {
    function Probe() { const c = useCodebookColumn('Q'); return <div>{JSON.stringify(c?.getTickLabels())}</div> }
    render(<Provider store={testStore()}><Probe /></Provider>)
    expect(screen.getByText(/満足/).textContent).toContain('"value":"1"')
  })
})
