import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import OverviewPage from '../src/features/dataset/OverviewPage'

vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ImputationModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('counts MA once as a question and folds physical options without changing row selection', async () => {
  const base = store.getState()
  const columns = ['A', 'B', 'Score', 'Area'].map(name => ({ columnId: name, name, label: name, role: name === 'Area' ? 'attribute' : 'question',
    scaleType: 'ratio', missingCodes: [], multiResponseGroup: ['A', 'B'].includes(name) ? 'services' : null }))
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1, selectedRowIds: ['original-row'] },
    codebook: { ...base.codebook, datasetId: 'd', columns, multiResponseGroups: [{ groupId: 'services', label: '利用サービス' }] } } as any
  const local = configureStore({ reducer: () => state, middleware: g => g({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  vi.spyOn(api, 'get').mockResolvedValue({ datasetId: 'd', name: 'Survey', rowCount: 10, columnCount: 4, dataRevision: 1, schemaRevision: 1, fingerprint: 'abc',
    schema: columns.map(column => ({ ...column, semanticType: 'numeric' })) } as any)
  vi.spyOn(api, 'post').mockResolvedValue({ rowCount: 10, columns: Object.fromEntries(columns.map(column => [column.name, { count: 10, missing: 0, mean: 0.5 }])) })
  const view = render(<Provider store={local}><OverviewPage /></Provider>)
  await waitFor(() => expect(view.getByText('利用サービス')).toBeVisible())
  expect(view.getByText('物理列数').closest('tr')).toHaveTextContent('4')
  expect(view.getByText('設問数（question）').closest('tr')).toHaveTextContent('2')
  expect(view.queryByTestId('btn-bin-A')).toBeNull()
  const parent = view.getByText('利用サービス').closest('tr')!
  expect(parent).not.toHaveTextContent('0.50')
  fireEvent.click(view.getByRole('button', { name: 'Expand row' }))
  expect(view.getByTestId('btn-bin-A')).toBeVisible()
  expect(view.getByTestId('btn-bin-B')).toBeVisible()
  expect(dispatch).not.toHaveBeenCalled()
  expect(local.getState().selection.selectedRowIds).toEqual(['original-row'])
})

it('ignores a previous dataset response without resetting the new dataset selection', async () => {
  const base = store.getState()
  const initial = { ...base, selection: { ...base.selection, datasetId: 'old', dataRevision: 1, selectedRowIds: ['old-row'] },
    codebook: { ...base.codebook, datasetId: 'old', schemaRevision: 1 } }
  const local = configureStore({ reducer: (state = initial, action: any) => action.type === 'switch'
    ? { ...state, selection: { ...state.selection, datasetId: 'new', selectedRowIds: ['new-row'] },
      codebook: { ...state.codebook, datasetId: 'new', schemaRevision: 1 } } : state,
    middleware: g => g({ serializableCheck: false }) })
  let finishOld!: (value: any) => void
  vi.spyOn(api, 'get').mockImplementation(async (path) => path.endsWith('/old')
    ? await new Promise(resolve => { finishOld = resolve })
    : { datasetId: 'new', name: 'New Survey', dataRevision: 1, schemaRevision: 1, fingerprint: 'new', schema: [] } as any)
  vi.spyOn(api, 'post').mockResolvedValue({ rowCount: 1, columns: {} })
  const view = render(<Provider store={local}><OverviewPage /></Provider>)
  await waitFor(() => expect(finishOld).toBeDefined())
  act(() => { local.dispatch({ type: 'switch' }) })
  await waitFor(() => expect(view.getByText('New Survey')).toBeVisible())
  const dispatch = vi.spyOn(local, 'dispatch')
  await act(async () => { finishOld({ datasetId: 'old', name: 'Old Survey', dataRevision: 2, schemaRevision: 2, fingerprint: 'old', schema: [] }) })
  expect(view.getByText('New Survey')).toBeVisible()
  expect(view.queryByText('Old Survey')).toBeNull()
  expect(dispatch).not.toHaveBeenCalled()
  expect(local.getState().selection.selectedRowIds).toEqual(['new-row'])
})

it('refreshes summaries on data or dictionary revisions but not on highlight changes', async () => {
  const base = store.getState()
  const initial = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1 }, codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1 } }
  const local = configureStore({ reducer: (state = initial, action: any) => {
    if (action.type === 'highlight') return { ...state, selection: { ...state.selection, selectedRowIds: ['r1'] } }
    if (action.type === 'data') return { ...state, selection: { ...state.selection, dataRevision: 2 } }
    if (action.type === 'dictionary') return { ...state, codebook: { ...state.codebook, schemaRevision: 2 } }
    return state
  }, middleware: g => g({ serializableCheck: false }) })
  vi.spyOn(api, 'get').mockImplementation(async () => ({ datasetId: 'd', name: 'Survey', dataRevision: local.getState().selection.dataRevision, schemaRevision: local.getState().codebook.schemaRevision, fingerprint: 'f', schema: [] }) as any)
  const summaries = vi.spyOn(api, 'post').mockResolvedValue({ rowCount: 1, columns: {} })
  render(<Provider store={local}><OverviewPage /></Provider>)
  await waitFor(() => expect(summaries).toHaveBeenCalledTimes(1))
  act(() => { local.dispatch({ type: 'highlight' }) })
  expect(summaries).toHaveBeenCalledTimes(1)
  act(() => { local.dispatch({ type: 'data' }) })
  await waitFor(() => expect(summaries).toHaveBeenCalledTimes(2))
  act(() => { local.dispatch({ type: 'dictionary' }) })
  await waitFor(() => expect(summaries).toHaveBeenCalledTimes(3))
  expect(local.getState().selection.selectedRowIds).toEqual(['r1'])
})

it('shows a failed summary request and retries without changing shared selection', async () => {
  const base = store.getState()
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1, selectedRowIds: ['keep'] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 5 } }
  const local = configureStore({ reducer: () => state, middleware: g => g({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  vi.spyOn(api, 'get').mockResolvedValue({ datasetId: 'd', name: 'Recovered Survey', dataRevision: 1, schemaRevision: 5, fingerprint: 'f', schema: [] } as any)
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('summary unavailable')).mockResolvedValue({ rowCount: 1, columns: {} })
  const view = render(<Provider store={local}><OverviewPage /></Provider>)
  await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('summary unavailable'))
  fireEvent.click(view.getByRole('button', { name: '再試行' }))
  await waitFor(() => expect(view.getByText('Recovered Survey')).toBeVisible())
  expect(post).toHaveBeenCalledTimes(2)
  expect(post).toHaveBeenLastCalledWith('/summaries', { datasetId: 'd', expectedDataRevision: 1, expectedSchemaRevision: 5 })
  expect(view.queryByRole('alert')).toBeNull()
  expect(dispatch).not.toHaveBeenCalled()
  expect(local.getState().selection.selectedRowIds).toEqual(['keep'])
})
