import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { api } from '../src/api/client'
import { datasetLoaded, globalObservationsSlice, hovered, observationScopeChanged, samplingApplied,
  selectionApplied, selectionCleared, selectionReducer, store } from '../src/app/store'
import { provenanceReducer } from '../src/features/dataset/provenanceSlice'
import TablePage from '../src/features/table/TablePage'
import * as rowScope from '../src/features/table/tableRowScope'

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const mask = (ids: string[]) => ({ entries: ids.map(rowId => ({ rowId, columnId: 'x', methodLabel: 'Mean' })) })
const response = (ids: string[]) => ({ total: ids.length,
  entities: [{ kind: 'column', columnId: 'x', label: 'Value', sortable: true }],
  rows: ids.map(rowId => ({ rowId, cells: [{ value: rowId, text: rowId, isMissing: false }] })),
})
function mount({ selected = ['a', 'c'], maskFilter = 'all', getMask, getRows }: {
  selected?: string[]; maskFilter?: 'all' | 'hasImputed' | 'noImputed'
  getMask?: (path: string) => Promise<unknown>
  getRows?: (path: string, body: any) => Promise<unknown>
} = {}) {
  const base = store.getState()
  const rows = ['c', 'a', 'b']
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'first', dataRevision: 1, allRowIds: rows,
      activeRowIds: rows, activeRowIdSet: new Set(rows), selectedRowIds: selected },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column' as const, columnId: 'x' }] },
    codebook: { ...base.codebook, datasetId: 'first', schemaRevision: 1,
      columns: [{ columnId: 'x', name: 'x', label: 'Value', role: 'question', scaleType: 'nominal',
        multiResponseGroup: null, valueLabels: {}, missingCodes: [], categoryOrder: [] }] },
    provenance: { ...base.provenance, maskFilter },
  }
  const local = configureStore({ reducer: (state = initial, action) => ({ ...state,
    selection: selectionReducer(state.selection, action),
    globalObservations: globalObservationsSlice.reducer(state.globalObservations, action),
    provenance: provenanceReducer(state.provenance, action),
    // Dataset loading has a separate codebook fetch in the application. Supply its
    // accepted matching codebook here while retaining the real selection reducer.
    codebook: action.type === datasetLoaded.type
      ? { ...state.codebook, datasetId: action.payload.datasetId } : state.codebook,
  }), middleware: defaults => defaults({ serializableCheck: false }) })
  const get = vi.spyOn(api, 'get').mockImplementation((getMask ?? (async () => mask(['a']))) as any)
  const post = vi.spyOn(api, 'post').mockImplementation((getRows ?? (async (_path, body) => response(body.rowIds))) as any)
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><MemoryRouter>
    <TablePage />
  </MemoryRouter></Provider></ConfigProvider>)
  return { local, get, post }
}
const displayed = () => screen.queryAllByTestId(/^select-/).map(node => node.getAttribute('data-testid')!.slice(7))
const expectRows = async (ids: string[]) => { await waitFor(() => expect(displayed()).toEqual(ids)) }
const selectedOnly = () => fireEvent.click(within(screen.getByTestId('scope-filter')).getByText(/選択のみ/))
const allRows = () => fireEvent.click(within(screen.getByTestId('scope-filter')).getByText('共通対象の全行'))
const select = (rowIds: string[]) => selectionApplied({ rowIds, operation: 'replace', label: 'test selection' })

it('reuses the projection on hover and updates cached checkbox membership after selection changes', async () => {
  const project = vi.spyOn(rowScope, 'projectTableRowIds')
  const { local, post } = mount()
  await expectRows(['c', 'a', 'b'])
  selectedOnly()
  await expectRows(['c', 'a'])
  const projected = project.mock.calls.length
  const requests = post.mock.calls.length
  expect(projected).toBeGreaterThan(0)
  act(() => { local.dispatch(hovered('c')); local.dispatch(hovered('a')) })
  expect(project).toHaveBeenCalledTimes(projected)
  expect(post).toHaveBeenCalledTimes(requests)
  expect(screen.getByTestId('select-c')).toBeChecked()
  expect(screen.getByTestId('select-a')).toBeChecked()

  fireEvent.click(screen.getByTestId('select-c'))
  await expectRows(['a'])
  expect(project.mock.calls.length).toBeGreaterThan(projected)
  expect(local.getState().selection.selectedRowIds).toEqual(['a'])
  act(() => { local.dispatch(select(['b', 'a'])) })
  await expectRows(['a', 'b'])
  expect(screen.getByTestId('select-b')).toBeChecked()
  allRows()
  await expectRows(['c', 'a', 'b'])
  expect(screen.getByTestId('select-c')).not.toBeChecked()
  expect(screen.getByTestId('select-a')).toBeChecked()
  expect(screen.getByTestId('select-b')).toBeChecked()
})

it('updates memoized intersections across empty selection and all, selected, and sampled shared scopes', async () => {
  const { local, post } = mount()
  await expectRows(['c', 'a', 'b'])
  selectedOnly()
  await expectRows(['c', 'a'])
  act(() => { local.dispatch(selectionCleared()) })
  await expectRows([])
  expect(post.mock.calls.at(-1)?.[1]).toMatchObject({ rowIds: [] })
  allRows()
  await expectRows(['c', 'a', 'b'])
  act(() => { local.dispatch(observationScopeChanged('selected')) })
  await expectRows([])
  act(() => { local.dispatch(select(['a', 'b'])) })
  await expectRows(['a', 'b'])
  act(() => { local.dispatch(samplingApplied({ sampledRowIds: ['b', 'c', 'a'], sampledRowWeights: { b: 1, c: 1, a: 1 } })) })
  await expectRows(['b', 'c', 'a'])
  selectedOnly()
  await expectRows(['b', 'a'])
  fireEvent.click(within(screen.getByTestId('mask-filter')).getByText(/補完あり/))
  await expectRows(['a'])
  fireEvent.click(within(screen.getByTestId('mask-filter')).getByText('補完なし'))
  await expectRows(['b'])
  act(() => { local.dispatch(samplingApplied({ sampledRowIds: [], sampledRowWeights: {} })) })
  await expectRows([])
  act(() => { local.dispatch(observationScopeChanged('all')) })
  await expectRows(['b'])
  fireEvent.click(within(screen.getByTestId('mask-filter')).getByText('全行'))
  await expectRows(['a', 'b'])
  expect(local.getState().selection.selectedRowIds).toEqual(['a', 'b'])
})

it('ignores an old dataset mask with reused row IDs after the new mask and selection arrive', async () => {
  const pending = new Map<string, (value: unknown) => void>()
  const { local, post } = mount({ maskFilter: 'hasImputed', getMask: path => new Promise(resolve => pending.set(path, resolve)) })
  selectedOnly()
  expect(post).not.toHaveBeenCalled()
  act(() => {
    local.dispatch(datasetLoaded({ datasetId: 'second', name: 'Second', rowIds: ['a', 'b'] }))
    local.dispatch(select(['a', 'b']))
  })
  expect(post).not.toHaveBeenCalled()
  await act(async () => { pending.get('/datasets/second/imputation-mask?expectedDataRevision=1')!(mask(['b'])) })
  await expectRows(['b'])
  expect(post).toHaveBeenLastCalledWith('/datasets/second/table-view', expect.objectContaining({ rowIds: ['b'] }))
  const count = post.mock.calls.length
  await act(async () => { pending.get('/datasets/first/imputation-mask?expectedDataRevision=1')!(mask(['a'])) })
  expect(displayed()).toEqual(['b'])
  expect(post).toHaveBeenCalledTimes(count)
  expect(screen.getByTestId('select-b')).toBeChecked()
})

it('does not restore a late old table response or its cached selection after a dataset switch', async () => {
  let resolveOld!: (value: unknown) => void
  const { local, post } = mount({ getRows: async (path, body) => path.includes('/first/')
    ? new Promise(resolve => { resolveOld = resolve }) : response(body.rowIds) })
  await waitFor(() => expect(post).toHaveBeenCalled())
  act(() => { local.dispatch(datasetLoaded({ datasetId: 'second', name: 'Second', rowIds: ['a', 'b'] })) })
  await expectRows(['a', 'b'])
  expect(screen.getByTestId('select-a')).not.toBeChecked()
  expect(screen.getByTestId('select-b')).not.toBeChecked()
  await act(async () => { resolveOld(response(['c'])) })
  expect(displayed()).toEqual(['a', 'b'])
  selectedOnly()
  await expectRows([])
})
