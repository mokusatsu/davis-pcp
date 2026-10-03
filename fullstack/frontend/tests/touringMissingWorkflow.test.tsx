import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import TgtPage from '../src/features/tgt/TgtPage'

const f = vi.hoisted(() => ({ data: null as any, captured: null as any }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => f.data }))
vi.mock('../src/features/tgt/TgtCanvas', () => ({ TgtCanvas: (props: any) => {
  f.captured = props
  return <div data-testid="projection-data">{JSON.stringify(props.dataMatrix)}</div>
} }))
vi.mock('../src/features/tgt/ProjectionCircle', () => ({ ProjectionCircle: () => null }))
vi.mock('../src/features/tgt/TgtControlPanel', () => ({ TgtControlPanel: (props: any) =>
  <button onClick={() => props.onColumnsChange(['Y', 'Z'])}>Y and Z only</button> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div> }))
afterEach(() => { cleanup(); f.captured = null })

function mount(x: unknown[], missingCodes: string[] = [], scope = ['r1', 'r2', 'r3']) {
  const rowIds = ['r1', 'r2', 'r3']
  const columns = { X: x, Y: [1, 2, 3], Z: [5, 6, 7] }
  f.data = { rowIds, rowIndex: new Map(rowIds.map((id, index) => [id, index])),
    schema: ['X', 'Y', 'Z'].map(name => ({ name, columnId: name, semanticType: 'numeric' })), columns,
    numeric: Object.fromEntries(Object.entries(columns).map(([name, values]) =>
      [name, Float64Array.from(values, value => value == null ? NaN : Number(value))])) }
  const base = store.getState()
  const state: any = { ...base, selection: { ...base.selection, datasetId: 'd', allRowIds: rowIds, activeRowIds: scope,
    selectedRowIds: ['r3'], groups: [{ id: 'cluster', rowIds: ['r3'] }] },
    globalVariables: { ...base.globalVariables, activeEntities: ['X', 'Y', 'Z'].map(columnId => ({ kind: 'column', columnId })) },
    codebook: { ...base.codebook, datasetId: 'd', columns: ['X', 'Y', 'Z'].map(name => ({ name, columnId: name,
      role: 'question', scaleType: 'ratio', missingCodes: name === 'X' ? missingCodes : [], categoryOrder: [], valueLabels: {}, multiResponseGroup: null })) } }
  const local = configureStore({ reducer: () => state, middleware: get => get({ serializableCheck: false }) })
  return { local, ...render(<Provider store={local}><MemoryRouter initialEntries={['/touring']}><TgtPage /></MemoryRouter></Provider>) }
}

it('WF-10 excludes the missing row and standardizes complete cases without inventing zeros', () => {
  const view = mount([10, null, 30])
  expect(f.captured.rowIds).toEqual(['r1', 'r3'])
  expect(f.captured.dataMatrix).toHaveLength(2)
  f.captured.dataMatrix[0].forEach((value: number) => expect(value).toBeCloseTo(-1 / Math.sqrt(2)))
  f.captured.dataMatrix[1].forEach((value: number) => expect(value).toBeCloseTo(1 / Math.sqrt(2)))
  expect(view.getByTestId('touring-missing-policy')).toHaveTextContent('投影 2行 / 欠損・無効値による除外 1行')
  expect(view.getByTestId('touring-missing-policy')).toHaveTextContent('完全ケース')
  expect(view.local.getState().selection.selectedRowIds).toEqual(['r3'])
  expect(f.captured.rowIds[1]).toBe(view.local.getState().selection.groups[0].rowIds[0])
})

it.each([null, undefined, NaN, Infinity, '', ' '])('excludes invalid numeric value %s', value => {
  mount([10, value, 30])
  expect(f.captured.rowIds).toEqual(['r1', 'r3'])
  expect(f.captured.dataMatrix.every((row: number[]) => row.every(Number.isFinite))).toBe(true)
})

it('excludes configured finite missing codes and keeps reordered row IDs/matrix aligned', () => {
  mount([10, 99, 30], ['99'], ['r3', 'r2', 'r1'])
  expect(f.captured.rowIds).toEqual(['r3', 'r1'])
  expect(f.captured.dataMatrix[0][0]).toBeCloseTo(1 / Math.sqrt(2))
  expect(f.captured.dataMatrix[1][0]).toBeCloseTo(-1 / Math.sqrt(2))
})

it('positive control: complete rows retain expected ddof1 coordinates including observed zero', () => {
  const view = mount([-10, 0, 10])
  expect(f.captured.rowIds).toEqual(['r1', 'r2', 'r3'])
  expect(f.captured.dataMatrix.map((row: number[]) => row[0])).toEqual([-1, 0, 1])
  expect(view.getByTestId('touring-missing-policy')).toHaveTextContent('除外 0行')
})

it('recovers excluded rows when the missing dimension is removed', () => {
  const view = mount([10, null, 30])
  fireEvent.click(view.getByText('Y and Z only'))
  expect(f.captured.rowIds).toEqual(['r1', 'r2', 'r3'])
  f.captured.dataMatrix.forEach((row: number[], i: number) => row.forEach(value => expect(value).toBeCloseTo(i - 1)))
})

it('shows an explicit empty state if every row is incomplete', () => {
  const view = mount([null, null, null])
  expect(view.queryByTestId('projection-data')).toBeNull()
  expect(view.getByText(/投影できる有効行がありません/)).toBeInTheDocument()
  expect(view.getByTestId('touring-missing-policy')).toHaveTextContent('投影 0行 / 欠損・無効値による除外 3行')
})

it('keeps finite extreme numeric values finite through standardization', () => {
  mount([-1e308, 0, 1e308])
  expect(f.captured.dataMatrix.map((row: number[]) => row[0])).toEqual([-1, 0, 1])
  expect(f.captured.rowIds).toEqual(['r1', 'r2', 'r3'])
})
