import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { api } from '../src/api/client'
import { datasetValuesUpdated, globalObservationsSlice, observationScopeChanged,
  selectionReducer, store } from '../src/app/store'
import { provenanceReducer } from '../src/features/dataset/provenanceSlice'
import TablePage from '../src/features/table/TablePage'

type MaskEntry = { rowId: string; columnId: string; methodLabel: string }
const rowId = (index: number) => `ROW-${String(index + 1).padStart(6, '0')}`
const mask = (indexes: number[]): MaskEntry[] => indexes.map(index => ({
  rowId: rowId(index), columnId: 'x', methodLabel: 'Mean',
}))
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mountTable({ count = 150, imputed = [0, 50, 100], selected = [], active, initialFilter = 'all', getMask }: {
  count?: number; imputed?: number[]; selected?: number[]; active?: number[]
  initialFilter?: 'all' | 'hasImputed' | 'noImputed'
  getMask?: (path: string) => Promise<unknown>
} = {}) {
  const base = store.getState()
  const rowIds = Array.from({ length: count }, (_, index) => rowId(index))
  const activeRowIds = active?.map(rowId) ?? rowIds
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'iris', dataRevision: 1, allRowIds: rowIds,
      activeRowIds, activeRowIdSet: new Set(activeRowIds), selectedRowIds: selected.map(rowId) },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column' as const, columnId: 'x' }] },
    codebook: { ...base.codebook, datasetId: 'iris', schemaRevision: 1,
      columns: [{ columnId: 'x', name: 'x', label: 'Value', role: 'question', scaleType: 'ratio',
        multiResponseGroup: null, valueLabels: {}, missingCodes: [], categoryOrder: [] }] },
    provenance: { ...base.provenance, maskFilter: initialFilter },
  }
  const local = configureStore({ reducer: (state = initial, action) => ({ ...state,
    selection: selectionReducer(state.selection, action),
    globalObservations: globalObservationsSlice.reducer(state.globalObservations, action),
    provenance: provenanceReducer(state.provenance, action),
  }), middleware: defaults => defaults({ serializableCheck: false }) })
  const get = vi.spyOn(api, 'get').mockImplementation((getMask ?? (async () => ({ entries: mask(imputed) }))) as any)
  // Keep the real UI and Redux state. The transport mirrors table-view's scope ->
  // search -> sort -> paginate contract, including an explicit empty row scope.
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    expect(path).toBe('/datasets/iris/table-view')
    let rows = rowIds.filter(id => body.rowIds.includes(id))
    if (body.search) rows = rows.filter(id => id.includes(body.search.trim()))
    if (body.sort?.order === 'descend') rows = [...rows].reverse()
    return { total: rows.length,
      entities: [{ kind: 'column', columnId: 'x', label: 'Value', sortable: true }],
      rows: rows.slice(body.offset, body.offset + body.limit).map(id => ({ rowId: id,
        cells: [{ value: Number(id.slice(4)), text: id, isMissing: false }] })) } as any
  })
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><MemoryRouter>
    <TablePage />
  </MemoryRouter></Provider></ConfigProvider>)
  return { local, get, post, lastRequest: () => post.mock.calls.at(-1)?.[1] as any }
}
function setMaskFilter(label: RegExp | string) {
  fireEvent.click(within(screen.getByTestId('mask-filter')).getByText(label))
}
const displayedIds = () => screen.queryAllByTestId(/^select-ROW-/).map(node => node.getAttribute('data-testid')!.slice(7))
async function expectRows(ids: string[], total: number, effectiveTotal = 150) {
  await waitFor(() => {
    expect(displayedIds()).toEqual(ids)
    expect(screen.getByText(`表示 ${total} / 総 ${effectiveTotal} 行 · 右クリックで操作`)).toBeVisible()
  })
}
function goToPage(page: number) {
  fireEvent.click(screen.getByTestId('table-page').querySelector(`.ant-pagination-item-${page}`)!)
}

it('filters all 150 rows before pagination and resets to page one on each mask toggle', async () => {
  const { lastRequest } = mountTable()
  await expectRows(Array.from({ length: 100 }, (_, i) => rowId(i)), 150)
  goToPage(2)
  await expectRows(Array.from({ length: 50 }, (_, i) => rowId(i + 100)), 150)

  setMaskFilter(/補完あり/)
  await expectRows([rowId(0), rowId(50), rowId(100)], 3)
  expect(lastRequest()).toMatchObject({ rowIds: [rowId(0), rowId(50), rowId(100)], offset: 0, limit: 100 })
  expect(screen.getByTestId('table-page').querySelector('.ant-pagination-item-2')).toBeNull()

  setMaskFilter('補完なし')
  const nonImputed = Array.from({ length: 150 }, (_, i) => i).filter(i => ![0, 50, 100].includes(i)).map(rowId)
  await expectRows(nonImputed.slice(0, 100), 147)
  goToPage(2)
  await expectRows(nonImputed.slice(100), 147)
  setMaskFilter('全行')
  await expectRows(Array.from({ length: 100 }, (_, i) => rowId(i)), 150)
  expect(lastRequest()).toMatchObject({ offset: 0, limit: 100 })
}, 15000)

it('paginates more than one page of imputed rows, then applies sorting and search to the entire filtered scope', async () => {
  const imputed = Array.from({ length: 125 }, (_, i) => i * 2)
  const { lastRequest } = mountTable({ count: 250, imputed })
  await waitFor(() => expect(screen.getByText('補完あり (125)')).toBeVisible())
  setMaskFilter(/補完あり/)
  await expectRows(imputed.slice(0, 100).map(rowId), 125, 250)
  goToPage(2)
  await expectRows(imputed.slice(100).map(rowId), 125, 250)

  fireEvent.click(screen.getByRole('columnheader', { name: /Value/ }))
  await expectRows(imputed.slice(0, 100).map(rowId), 125, 250)
  fireEvent.click(screen.getByRole('columnheader', { name: /Value/ }))
  await expectRows([...imputed].reverse().slice(0, 100).map(rowId), 125, 250)
  expect(lastRequest()).toMatchObject({ offset: 0, sort: { entityIndex: 0, order: 'descend' } })
  goToPage(2)
  await expectRows([...imputed].reverse().slice(100).map(rowId), 125, 250)

  fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: '00024' } })
  await expectRows([240, 242, 244, 246, 248].map(rowId), 5, 250)
  expect(lastRequest()).toMatchObject({ offset: 0, search: '00024' })
  fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: 'not-present' } })
  await expectRows([], 0, 250)
  fireEvent.change(screen.getByPlaceholderText('検索'), { target: { value: '' } })
  await expectRows(imputed.slice(0, 100).map(rowId), 125, 250)
}, 15000)

it('intersects imputation with effective and selected scope without changing hidden selections', async () => {
  const { local, lastRequest } = mountTable({ selected: [0, 100, 149], active: [0, 50, 100, 149] })
  await waitFor(() => expect(screen.getByText('補完あり (3)')).toBeVisible())
  setMaskFilter(/補完あり/)
  await expectRows([0, 50, 100].map(rowId), 3, 4)
  expect(local.getState().selection.selectedRowIds).toEqual([0, 100, 149].map(rowId))
  fireEvent.click(screen.getByTestId(`select-${rowId(50)}`))
  expect(local.getState().selection.selectedRowIds).toEqual([0, 100, 149, 50].map(rowId))
  fireEvent.click(within(screen.getByTestId('scope-filter')).getByText(/選択のみ/))
  await expectRows([0, 50, 100].map(rowId), 3, 4)
  setMaskFilter('補完なし')
  await expectRows([rowId(149)], 1, 4)
  expect(lastRequest().rowIds).toEqual([rowId(149)])
  fireEvent.click(screen.getByTestId(`select-${rowId(149)}`))
  await expectRows([], 0, 4)
  expect(lastRequest().rowIds).toEqual([])
  expect(local.getState().selection.selectedRowIds).toEqual([0, 100, 50].map(rowId))

  act(() => { local.dispatch(observationScopeChanged('selected')) })
  await expectRows([], 0, 3)
}, 10000)

it('returns an empty filtered result when the current mask has no imputed rows', async () => {
  const { lastRequest } = mountTable({ imputed: [] })
  await expectRows(Array.from({ length: 100 }, (_, i) => rowId(i)), 150)
  setMaskFilter(/補完あり/)
  await expectRows([], 0)
  expect(lastRequest()).toMatchObject({ rowIds: [], offset: 0 })
  setMaskFilter('補完なし')
  await expectRows(Array.from({ length: 100 }, (_, i) => rowId(i)), 150)
})

it('waits for the current revision mask instead of treating a pending or old mask as an empty one', async () => {
  let resolveMask!: (value: unknown) => void
  const { local, post } = mountTable({ initialFilter: 'noImputed', getMask: () => new Promise(resolve => { resolveMask = resolve }) })
  expect(post).not.toHaveBeenCalled()
  await act(async () => { resolveMask({ entries: mask([0, 50, 100]) }) })
  await expectRows(Array.from({ length: 150 }, (_, i) => i).filter(i => ![0, 50, 100].includes(i)).slice(0, 100).map(rowId), 147)
  post.mockClear()
  act(() => { local.dispatch(datasetValuesUpdated({ datasetId: 'iris', dataRevision: 2 })) })
  expect(post).not.toHaveBeenCalled()
  await act(async () => { resolveMask({ entries: mask([1]) }) })
  await expectRows(Array.from({ length: 150 }, (_, i) => i).filter(i => i !== 1).slice(0, 100).map(rowId), 149)
  expect(post).toHaveBeenLastCalledWith('/datasets/iris/table-view', expect.objectContaining({ expectedDataRevision: 2 }))
})

it('reports mask load errors instead of claiming that all rows are non-imputed', async () => {
  const { post } = mountTable({ initialFilter: 'noImputed', getMask: async () => { throw new Error('Mask unavailable') } })
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Mask unavailable'))
  expect(post).not.toHaveBeenCalled()
  expect(displayedIds()).toEqual([])
  setMaskFilter('全行')
  await expectRows(Array.from({ length: 100 }, (_, i) => rowId(i)), 150)
})
