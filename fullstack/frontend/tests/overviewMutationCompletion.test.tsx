import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../src/api/client'
import { datasetValuesUpdated, store } from '../src/app/store'
import { codebookReadAccepted } from '../src/features/dataset/codebookSlice'
import OverviewPage from '../src/features/dataset/OverviewPage'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Keep the actual Overview → AddVariable → ActiveModal → API completion chain.
// Only unrelated dialogs and graph/table rendering are replaced.
vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ImputationModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/features/charts/CategoryBars', () => ({ default: () => null }))
vi.mock('../src/features/common/ColumnTable', () => ({ default: ({ dataSource }: any) => <div data-testid="overview-column-names">{dataSource.map((row: any) => row.name).join(',')}</div> }))

function deferred<T = any>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const idFor = (path: string) => path.split('/')[2]
const servers: Record<string, { revision: number; names: string[] }> = {}
let pending: ReturnType<typeof deferred>
function definitions(id: string) {
  return servers[id].names.map(name => ({ columnId: name, name, label: name, role: 'question', scaleType: 'ratio', multiResponseGroup: null, missingCodes: [], valueLabels: {} }))
}
function stateFor(id: string) {
  const base = store.getState()
  return { ...base,
    selection: { ...base.selection, datasetId: id, dataRevision: 1, selectedRowIds: [`${id}-r2`], activeRowIds: [`${id}-r2`], allRowIds: [`${id}-r1`, `${id}-r2`] },
    codebook: { ...base.codebook, datasetId: id, schemaRevision: 1, columns: definitions(id) },
    globalObservations: { ...base.globalObservations, scopeMode: 'selected' as const },
  }
}
function localStore() {
  return configureStore({ reducer: (state = stateFor('a'), action: any) => {
    if (action.type === 'test/switch-dataset') return stateFor(action.payload)
    if (datasetValuesUpdated.match(action) && action.payload.datasetId === state.selection.datasetId && action.payload.dataRevision > state.selection.dataRevision) {
      return { ...state, selection: { ...state.selection, dataRevision: action.payload.dataRevision } }
    }
    if (codebookReadAccepted.match(action) && action.payload.datasetId === state.selection.datasetId) {
      return { ...state, codebook: { ...state.codebook, schemaRevision: action.payload.schemaRevision, columns: action.payload.columns } }
    }
    return state
  }, middleware: defaults => defaults({ serializableCheck: false }) })
}
function CachedOverview({ remountOnDataset = true }: { remountOnDataset?: boolean }) {
  const location = useLocation(), navigate = useNavigate()
  const datasetId = useSelector((state: any) => state.selection.datasetId)
  return <><button onClick={() => navigate('/pcp')}>Leave overview</button>
    <button onClick={() => navigate('/overview')}>Return to overview</button>
    <div style={{ display: location.pathname === '/overview' ? 'block' : 'none' }}>
      <AnalysisViewActivityContext.Provider value={location.pathname === '/overview'}>
        <OverviewPage key={remountOnDataset ? datasetId : 'same-instance'} />
      </AnalysisViewActivityContext.Provider>
    </div>
  </>
}
function mount(remountOnDataset = true) {
  const local = localStore()
  render(<Provider store={local}><MemoryRouter initialEntries={['/overview']}><CachedOverview remountOnDataset={remountOnDataset} /></MemoryRouter></Provider>)
  return local
}
async function startMutation() {
  fireEvent.click(await screen.findByTestId('btn-open-add-variable'))
  fireEvent.click(screen.getByRole('button', { name: 'プレビュー検証' }))
  await waitFor(() => expect(screen.getByTestId('btn-add-variable-submit')).toBeEnabled())
  fireEvent.click(screen.getByTestId('btn-add-variable-submit'))
  expect(api.post).toHaveBeenCalledWith('/datasets/a/calculate', { expression: 'x / (y + 1e-6)', columnName: 'new_feature', mode: 'create', expectedDataRevision: 1, expectedSchemaRevision: 1 })
}
async function commitA() {
  servers.a = { revision: 2, names: ['x', 'y', 'new_feature'] }
  await act(async () => { pending.resolve({ dataRevision: 2, column: 'new_feature', operation: 'created' }); await pending.promise })
}
beforeEach(() => {
  servers.a = { revision: 1, names: ['x', 'y'] }
  servers.b = { revision: 1, names: ['u', 'v'] }
  pending = deferred()
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    const id = path.split('/')[2]
    if (path.endsWith('/codebook')) return { datasetId: id, schemaRevision: servers[id].revision, columns: definitions(id) } as any
    return { datasetId: id, name: `Dataset ${id}`, format: 'csv', rowCount: 2, columnCount: servers[id].names.length,
      dataRevision: servers[id].revision, schemaRevision: servers[id].revision, fingerprint: `${id}-${servers[id].revision}`,
      rowIdentity: 'stable', createdAt: '2026-10-02', schema: definitions(id).map(column => ({ ...column, semanticType: 'numeric' })) } as any
  })
  vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    if (path === '/summaries') return { rowCount: 2, columns: Object.fromEntries(servers[body.datasetId].names.map(name => [name, { count: 2, missing: 0, mean: 1 }])) } as any
    if (path.endsWith('/calculate/preview')) return { mode: body.mode, targetExists: false, columnId: null, dataRevision: servers[idFor(path)].revision, schemaRevision: servers[idFor(path)].revision, rowCount: 2, previewScope: 'first_rows', previewRowCount: 2, previewRowLimit: 100, valid: true, column: body.columnName, previewValues: [1], stats: { count: 2 }, histogram: [] } as any
    if (path === '/datasets/a/calculate') return pending.promise
    throw new Error(`Unexpected request: ${path}`)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['commit before return', 'return before commit'] as const)('refreshes a completed mutation after leaving its dialog: %s', async order => {
  const local = mount()
  await startMutation()
  const before = local.getState()
  fireEvent.click(screen.getByText('Leave overview'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  if (order === 'return before commit') {
    fireEvent.click(screen.getByText('Return to overview'))
    expect(screen.getByTestId('overview-column-names')).not.toHaveTextContent('new_feature')
  }
  await commitA()
  await waitFor(() => expect(local.getState().selection.dataRevision).toBe(2))
  if (order === 'commit before return') fireEvent.click(screen.getByText('Return to overview'))
  await waitFor(() => expect(screen.getByTestId('overview-column-names')).toHaveTextContent('x,y,new_feature'))
  expect(screen.getByTestId('overview-column-names')).toBeVisible()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(local.getState().selection).toEqual({ ...before.selection, dataRevision: 2 })
  expect(local.getState().globalObservations).toBe(before.globalObservations)
  expect(local.getState().pcp).toBe(before.pcp)
  expect(api.get).toHaveBeenCalledWith('/datasets/a/codebook')
})

it.each([true, false])('ignores an old dataset completion after switching datasets (remount=%s)', async remountOnDataset => {
  const local = mount(remountOnDataset)
  await startMutation()
  fireEvent.click(screen.getByText('Leave overview'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  act(() => { local.dispatch({ type: 'test/switch-dataset', payload: 'b' }) })
  fireEvent.click(screen.getByText('Return to overview'))
  await screen.findByText('Dataset b')
  expect(screen.getByTestId('overview-column-names')).toHaveTextContent('u,v')
  const before = local.getState()
  vi.mocked(api.get).mockClear()
  vi.mocked(api.post).mockClear()
  await commitA()
  expect(api.get).not.toHaveBeenCalled()
  expect(api.post).not.toHaveBeenCalled()
  expect(local.getState()).toBe(before)
  expect(screen.getByTestId('overview-column-names')).toHaveTextContent('u,v')
  expect(screen.getByTestId('overview-column-names')).not.toHaveTextContent('new_feature')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})


it('refreshes a remounted original dataset when its earlier mutation completes after A → B → A', async () => {
  const local = mount(true)
  await startMutation()
  fireEvent.click(screen.getByText('Leave overview'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  act(() => { local.dispatch({ type: 'test/switch-dataset', payload: 'b' }) })
  fireEvent.click(screen.getByText('Return to overview'))
  await screen.findByText('Dataset b')
  expect(screen.getByTestId('overview-column-names')).toHaveTextContent('u,v')

  // Return before the original A request completes, creating a fresh A page.
  act(() => { local.dispatch({ type: 'test/switch-dataset', payload: 'a' }) })
  await screen.findByText('Dataset a')
  expect(screen.getByTestId('overview-column-names')).toHaveTextContent('x,y')
  expect(screen.getByTestId('overview-column-names')).not.toHaveTextContent('new_feature')
  expect(local.getState().selection.dataRevision).toBe(1)
  const before = local.getState()
  vi.mocked(api.get).mockClear()

  await commitA()
  await waitFor(() => expect(local.getState().selection.dataRevision).toBe(2))
  await waitFor(() => expect(screen.getByTestId('overview-column-names')).toHaveTextContent('x,y,new_feature'))
  expect(screen.getByTestId('overview-column-names')).toBeVisible()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(local.getState().selection).toEqual({ ...before.selection, dataRevision: 2 })
  expect(local.getState().globalObservations).toBe(before.globalObservations)
  expect(local.getState().pcp).toBe(before.pcp)
  expect(api.get).toHaveBeenCalledWith('/datasets/a/codebook')
  expect(vi.mocked(api.get).mock.calls.every(([path]) => path.startsWith('/datasets/a'))).toBe(true)
})
