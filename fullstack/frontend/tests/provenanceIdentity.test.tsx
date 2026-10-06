import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { api, type CodebookColumn } from '../src/api/client'
import { datasetLoaded, datasetValuesUpdated, focusSelected, selectionApplied, selectionReducer, globalVariablesSlice, variablesInitialized, activeEntitiesSet, weightColumnSet } from '../src/app/store'
import { codebookSlice, codebookReceived, draftColumnUpdated, fetchCodebookThunk, saveCodebookThunk } from '../src/features/dataset/codebookSlice'
import { fetchProvenanceThunk, provenanceReducer, provenanceReset } from '../src/features/dataset/provenanceSlice'
import ProvenanceHistoryPanel from '../src/features/dataset/ProvenanceHistoryPanel'

vi.mock('../src/features/pcp/useDatasetColumns', () => ({ invalidateColumnarCache: vi.fn(), useColumnarData: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function columns(id: string, label = `${id} saved`): CodebookColumn[] {
  return [{ columnId: `${id}-q`, name: `${id}-q`, label, role: 'question', scaleType: 'nominal',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }]
}
function history(id: string, dataRevision = 2, schemaRevision = 2) {
  return { datasetId: id, dataRevision, schemaRevision, currentOperationId: `${id}-2`, cursorOperationId: `${id}-2`,
    canUndo: true, canRedo: true, rawDataRevision: 1, maskRevision: 0,
    steps: [1, 2].map(revision => ({ operationId: `${id}-${revision}`, operation: `operation-${id}-${revision}`,
      parentOperationId: revision === 1 ? null : `${id}-1`, outputDataRevision: revision,
      timestamp: '2026-10-05', algorithmVersion: 'test-1', onCursorPath: true, inEffect: true })) }
}
function makeStore() {
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer, provenance: provenanceReducer, globalVariables: globalVariablesSlice.reducer },
    middleware: get => get({ serializableCheck: false }) })
  install(local, 'a')
  return local
}
type LocalStore = ReturnType<typeof makeStore>
function install(local: LocalStore, id: string, dataRevision = 2, schemaRevision = 2) {
  local.dispatch(datasetLoaded({ datasetId: id, name: id, rowIds: [`${id}-r1`, `${id}-r2`], dataRevision }))
  local.dispatch(variablesInitialized({ datasetId: id, variables: [`${id}-q`] }))
  local.dispatch(codebookReceived({ datasetId: id, schemaRevision, columns: columns(id) }))
  local.dispatch(selectionApplied({ rowIds: [`${id}-r2`], operation: 'replace', label: 'Test selection' }))
  local.dispatch(focusSelected())
}
function mount(local: LocalStore) { return render(<Provider store={local}><ProvenanceHistoryPanel /></Provider>) }
async function ready() { await waitFor(() => expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeEnabled()) }
function mockReads() {
  const server = { a: { dataRevision: 2, schemaRevision: 2 }, b: { dataRevision: 2, schemaRevision: 2 } }
  const get = vi.spyOn(api, 'get').mockImplementation(async path => {
    const id = path.split('/')[2] as 'a' | 'b', revision = server[id]
    if (path.endsWith('/provenance')) return history(id, revision.dataRevision, revision.schemaRevision) as any
    if (path.endsWith('/codebook')) return { datasetId: id, schemaRevision: revision.schemaRevision, columns: columns(id, `${id} refreshed`) } as any
    if (path === `/datasets/${id}`) return { datasetId: id, ...revision } as any
    throw new Error(`Unexpected GET ${path}`)
  })
  return { server, get }
}

it('rejects a foreign codebook fetch before pending can discard the selected draft', async () => {
  const local = makeStore()
  install(local, 'b')
  local.dispatch(draftColumnUpdated({ columnId: 'b-q', patch: { label: 'B unsaved edit' } }))
  const before = local.getState(), get = vi.spyOn(api, 'get')
  const result = await local.dispatch(fetchCodebookThunk('a'))
  expect(fetchCodebookThunk.rejected.match(result) && result.meta.condition).toBe(true)
  expect(get).not.toHaveBeenCalled()
  expect(local.getState()).toBe(before)
})

it('retains prepared installation and current-owner refresh without clearing its newer draft', async () => {
  const local = makeStore()
  install(local, 'b')
  local.dispatch(draftColumnUpdated({ columnId: 'b-q', patch: { label: 'B unsaved edit' } }))
  const { get } = mockReads()
  const result = await local.dispatch(fetchCodebookThunk('b'))
  expect(fetchCodebookThunk.fulfilled.match(result)).toBe(true)
  expect(get).toHaveBeenCalledWith('/datasets/b/codebook')
  expect(local.getState().codebook.columns[0].label).toBe('b refreshed')
  expect(local.getState().codebook.draftColumns[0].label).toBe('B unsaved edit')
  expect(local.getState().codebook.hasChanges).toBe(true)
})

it.each(['resolve', 'reject'] as const)('ignores an old history %s while newer B history is loading', async outcome => {
  const local = makeStore(), old = deferred(), latest = deferred()
  vi.spyOn(api, 'get').mockImplementation(path => (path.includes('/a/') ? old.promise : latest.promise))
  const oldRequest = local.dispatch(fetchProvenanceThunk('a'))
  install(local, 'b')
  const newRequest = local.dispatch(fetchProvenanceThunk('b')), before = local.getState().provenance
  if (outcome === 'resolve') old.resolve(history('a')); else old.reject(new Error('old A error'))
  await oldRequest
  expect(local.getState().provenance).toBe(before)
  expect(local.getState().provenance).toMatchObject({ datasetId: 'b', loading: true, ready: false, error: null })
  latest.resolve(history('b'))
  await newRequest
  expect(local.getState().provenance).toMatchObject({ datasetId: 'b', loading: false, ready: true, error: null })
})

it.each(['resolve', 'reject'] as const)('keeps the latest same-dataset history after an older %s', async outcome => {
  const local = makeStore(), old = deferred()
  vi.spyOn(api, 'get').mockImplementationOnce(() => old.promise).mockResolvedValueOnce(history('a', 3))
  const first = local.dispatch(fetchProvenanceThunk('a'))
  await local.dispatch(fetchProvenanceThunk('a'))
  const latest = local.getState().provenance
  if (outcome === 'resolve') old.resolve(history('a')); else old.reject(new Error('old error'))
  await first
  expect(local.getState().provenance).toBe(latest)
  expect(latest.dataRevision).toBe(3)
})

it.each(['reset', 'switch without fetch'] as const)('invalidates a pending history on %s', async action => {
  const local = makeStore(), old = deferred()
  vi.spyOn(api, 'get').mockReturnValue(old.promise)
  const request = local.dispatch(fetchProvenanceThunk('a'))
  if (action === 'reset') local.dispatch(provenanceReset()); else install(local, 'b')
  const before = local.getState().provenance
  old.resolve(history('a'))
  await request
  expect(local.getState().provenance).toBe(before)
  expect(before).toMatchObject({ datasetId: null, loading: false, ready: false, fetchRequestId: null })
})

it.each(['resolve', 'reject'] as const)('ignores a history %s after a newer same-dataset data revision', async outcome => {
  const local = makeStore(), pending = deferred()
  vi.spyOn(api, 'get').mockReturnValue(pending.promise)
  const request = local.dispatch(fetchProvenanceThunk('a'))
  local.dispatch(datasetValuesUpdated({ datasetId: 'a', dataRevision: 3 }))
  if (outcome === 'resolve') pending.resolve(history('a')); else pending.reject(new Error('obsolete error'))
  await request
  expect(local.getState().provenance).toMatchObject({ ready: false, loading: false, error: null, steps: [] })
})

it('refuses a history response with the wrong dataset identity', async () => {
  const local = makeStore()
  vi.spyOn(api, 'get').mockResolvedValue(history('b'))
  await local.dispatch(fetchProvenanceThunk('a'))
  expect(local.getState().provenance).toMatchObject({ datasetId: 'a', ready: false, loading: false, steps: [], error: '来歴のデータセットが一致しません。' })
})

it.each([false, true])('never shows late A history or enables B controls from it (remount=%s)', async remount => {
  const local = makeStore(), old = deferred(), latest = deferred()
  vi.spyOn(api, 'get').mockImplementation(path => (path.includes('/a/') ? old.promise : latest.promise))
  const post = vi.spyOn(api, 'post').mockReturnValue(new Promise(() => {}))
  const view = mount(local)
  if (remount) view.unmount()
  act(() => install(local, 'b'))
  if (remount) mount(local)
  await act(async () => { old.resolve(history('a')) })
  expect(screen.queryByText('1. operation-a-1 (rev 1)')).not.toBeInTheDocument()
  for (const name of ['Undo', 'Redo', 'Revert to Raw']) expect(screen.getByRole('button', { name })).toBeDisabled()
  await act(async () => { latest.resolve(history('b')) })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  expect(post).toHaveBeenCalledWith('/datasets/b/undo', { expectedDataRevision: 2, expectedSchemaRevision: 2 })
})

it.each(['Undo', 'Redo', 'Revert to Raw', 'この履歴へ戻す'])('keeps the normal %s payload and reconciles values without changing the working set', async name => {
  const local = makeStore(), { server } = mockReads(), pending = deferred()
  const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise)
  mount(local)
  await ready()
  const before = local.getState().selection
  fireEvent.click(screen.getByRole('button', { name }))
  if (name.includes('Revert') || name === 'この履歴へ戻す') fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
  const endpoint = name === 'Undo' ? 'undo' : name === 'Redo' ? 'redo' : 'revert'
  const target = name === 'Revert to Raw' ? { targetDataRevision: 1 } : name === 'この履歴へ戻す' ? { targetOperationId: 'a-1' } : {}
  expect(post).toHaveBeenCalledWith(`/datasets/a/${endpoint}`, { ...target, expectedDataRevision: 2, expectedSchemaRevision: 2 })
  server.a = { dataRevision: 3, schemaRevision: 1 }
  await act(async () => { pending.resolve({ currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] }) })
  await ready()
  expect(local.getState().selection).toEqual({ ...before, dataRevision: 3 })
  expect(local.getState().codebook).toMatchObject({ datasetId: 'a', schemaRevision: 1, isLoading: false })
  expect(local.getState().codebook.columns[0].label).toBe('a refreshed')
  expect(local.getState().provenance).toMatchObject({ datasetId: 'a', dataRevision: 3, schemaRevision: 1, ready: true })
  expect(screen.getByText('復元時の注意')).toBeInTheDocument()
})

it.each([false, true].flatMap(remount => ['mutation', 'metadata', 'codebook'].map(stage => ({ remount, stage }))))(
  'preserves B saved values, draft and working set after late A $stage (remount=$remount)', async ({ remount, stage }) => {
    const local = makeStore(), { server, get } = mockReads(), mutation = deferred(), metadata = deferred(), codebook = deferred()
    const normalGet = get.getMockImplementation()!
    get.mockImplementation(path => {
      if (stage === 'metadata' && path === '/datasets/a') return metadata.promise
      if (stage === 'codebook' && path === '/datasets/a/codebook') return codebook.promise
      return normalGet(path)
    })
    vi.spyOn(api, 'post').mockReturnValue(mutation.promise)
    const view = mount(local)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
    server.a.dataRevision = 3
    if (stage !== 'mutation') {
      await act(async () => { mutation.resolve({ currentDataRevision: 3, maskRevision: 1 }) })
      await waitFor(() => expect(get).toHaveBeenCalledWith(stage === 'metadata' ? '/datasets/a' : '/datasets/a/codebook'))
    }
    if (remount) view.unmount()
    act(() => {
      install(local, 'b')
      local.dispatch(draftColumnUpdated({ columnId: 'b-q', patch: { label: 'B unsaved edit' } }))
    })
    if (remount) mount(local)
    await ready()
    const before = local.getState()
    get.mockClear()
    await act(async () => {
      if (stage === 'mutation') mutation.resolve({ currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] })
      if (stage === 'metadata') metadata.resolve({ dataRevision: 3 })
      if (stage === 'codebook') codebook.resolve({ datasetId: 'a', schemaRevision: 2, columns: columns('a') })
    })
    expect(local.getState()).toBe(before)
    expect(local.getState().codebook.draftColumns[0].label).toBe('B unsaved edit')
    expect(local.getState().codebook.hasChanges).toBe(true)
    expect(get.mock.calls.every(([path]) => !path.startsWith('/datasets/a'))).toBe(true)
    expect(screen.queryByText('復元時の注意')).not.toBeInTheDocument()
  },
)

it('reconciles a remounted A after A → B → A before its original mutation completes', async () => {
  const local = makeStore(), { server } = mockReads(), mutation = deferred()
  vi.spyOn(api, 'post').mockReturnValue(mutation.promise)
  let view = mount(local)
  await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  view.unmount(); act(() => install(local, 'b')); view = mount(local)
  await ready()
  view.unmount(); act(() => install(local, 'a')); mount(local)
  await ready()
  const before = local.getState().selection
  server.a = { dataRevision: 3, schemaRevision: 1 }
  await act(async () => { mutation.resolve({ currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] }) })
  await waitFor(() => expect(local.getState().codebook.schemaRevision).toBe(1))
  await ready()
  expect(local.getState().selection).toEqual({ ...before, dataRevision: 3 })
  expect(local.getState().codebook.columns[0].label).toBe('a refreshed')
  expect(local.getState().provenance).toMatchObject({ datasetId: 'a', dataRevision: 3, schemaRevision: 1, ready: true })
  expect(screen.getByText('復元時の注意')).toBeInTheDocument()
})

it.each([false, true])('does not let old A failure/finally report an error or unlock newer B Undo (remount=%s)', async remount => {
  const local = makeStore(), a = deferred(), b = deferred()
  mockReads()
  const notice = vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  vi.spyOn(api, 'post').mockImplementation(path => path.includes('/a/') ? a.promise : b.promise)
  const view = mount(local)
  await ready(); fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  if (remount) view.unmount()
  act(() => install(local, 'b'))
  if (remount) mount(local)
  await ready(); fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await act(async () => { a.reject(new Error('old A failed')) })
  expect(notice).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ })).toBeDisabled()
  await act(async () => { b.reject(new Error('current B failed')) })
  await ready()
  expect(notice).toHaveBeenCalledWith('current B failed')
})

it('preserves the existing same-dataset draft policy for edits made after Undo starts', async () => {
  const local = makeStore(), { server } = mockReads(), mutation = deferred()
  vi.spyOn(api, 'post').mockReturnValue(mutation.promise)
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  act(() => local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'newer unsaved A edit' } })))
  server.a.dataRevision = 3
  await act(async () => { mutation.resolve({ currentDataRevision: 3, maskRevision: 1 }) })
  await ready()
  expect(local.getState().codebook.columns[0].label).toBe('a refreshed')
  expect(local.getState().codebook.draftColumns[0].label).toBe('newer unsaved A edit')
  expect(local.getState().codebook.hasChanges).toBe(true)
})

it('supersedes only the restore-driven codebook refresh when a newer same-A save takes ownership', async () => {
  const local = makeStore(), { server, get } = mockReads(), codebook = deferred()
  const normalGet = get.getMockImplementation()!
  get.mockImplementation(path => path === '/datasets/a/codebook' ? codebook.promise : normalGet(path))
  vi.spyOn(api, 'post').mockImplementation(async () => { server.a.dataRevision = 3; return { currentDataRevision: 3, maskRevision: 1 } as any })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(local.getState().codebook.isLoading).toBe(true))
  act(() => local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'new saved A label' } })))
  vi.spyOn(api, 'put').mockResolvedValue({ datasetId: 'a', schemaRevision: 3,
    codebook: { datasetId: 'a', schemaRevision: 3, columns: columns('a', 'new saved A label') } })
  server.a.schemaRevision = 3
  await act(async () => { await local.dispatch(saveCodebookThunk()) })
  await waitFor(() => expect(local.getState().codebook.isLoading).toBe(false))
  const before = local.getState().codebook
  await act(async () => { codebook.resolve({ datasetId: 'a', schemaRevision: 2, columns: columns('a', 'obsolete refresh') }) })
  expect(local.getState().codebook).toBe(before)
  expect(before).toMatchObject({ schemaRevision: 3, isLoading: false, isSaving: false, hasChanges: false })
  expect(before.columns[0].label).toBe('new saved A label')
  await ready()
})

it('does not reconcile an old mutation over a newer same-A data revision', async () => {
  const local = makeStore(), { server, get } = mockReads(), mutation = deferred()
  vi.spyOn(api, 'post').mockReturnValue(mutation.promise)
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  server.a.dataRevision = 4
  act(() => local.dispatch(datasetValuesUpdated({ datasetId: 'a', dataRevision: 4 })))
  await waitFor(() => expect(local.getState().provenance.dataRevision).toBe(4))
  const before = local.getState()
  get.mockClear()
  await act(async () => { mutation.resolve({ currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] }) })
  expect(local.getState()).toBe(before)
  expect(get).not.toHaveBeenCalled()
  expect(screen.queryByText('復元時の注意')).not.toBeInTheDocument()
})

it.each(['export', 'import'] as const)('blocks duplicate and overlapping operations during %s, and scopes its late finally to A', async kind => {
  const local = makeStore(), packageRequest = deferred(), mutation = deferred()
  mockReads()
  const notice = vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  const packageApi = kind === 'export' ? vi.spyOn(api, 'downloadBlob').mockReturnValue(packageRequest.promise)
    : vi.spyOn(api, 'upload').mockReturnValue(packageRequest.promise)
  const post = vi.spyOn(api, 'post').mockReturnValue(mutation.promise)
  const view = mount(local); await ready()
  const trigger = () => kind === 'export' ? fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ }))
    : fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['zip'], 'test.zip')] } })
  trigger(); trigger()
  expect(packageApi).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  expect(post).not.toHaveBeenCalled()
  expect(view.container.querySelector('input[type=file]')).toBeDisabled()
  act(() => install(local, 'b'))
  await ready(); fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await act(async () => { packageRequest.reject(new Error('old package error')) })
  expect(notice).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
  await act(async () => { mutation.reject(new Error('current B error')) })
  await ready()
  expect(notice).toHaveBeenCalledWith('current B error')
})

it('offers a current-history retry after a transient fetch failure', async () => {
  const local = makeStore(), { get } = mockReads()
  get.mockRejectedValueOnce(new Error('history temporarily unavailable'))
  mount(local)
  await screen.findByText('history temporarily unavailable')
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '来歴を再取得' }))
  await ready()
  expect(screen.queryByText('history temporarily unavailable')).not.toBeInTheDocument()
})

it.each(['metadata', 'codebook'])('recovers a committed Undo with a failed %s read without posting Undo twice', async stage => {
  const local = makeStore(), { server, get } = mockReads()
  const normalGet = get.getMockImplementation()!
  let fail = true
  get.mockImplementation(path => {
    if (fail && path === (stage === 'metadata' ? '/datasets/a' : '/datasets/a/codebook')) {
      fail = false
      return Promise.reject(new Error('refresh temporarily unavailable'))
    }
    return normalGet(path)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    server.a = { dataRevision: 3, schemaRevision: 1 }
    return { currentDataRevision: 3, maskRevision: 1 } as any
  })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await screen.findByText('操作は完了しましたが、表示の更新に失敗しました。')
  await waitFor(() => expect(screen.getByRole('button', { name: '表示を再取得' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '表示を再取得' }))
  await ready()
  expect(local.getState().selection.dataRevision).toBe(3)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, isLoading: false })
  expect(screen.queryByText('操作は完了しましたが、表示の更新に失敗しました。')).not.toBeInTheDocument()
  expect(post).toHaveBeenCalledTimes(1)
})

it('preserves the intentional mask filter through history ownership changes', async () => {
  const { maskFilterChanged } = await import('../src/features/dataset/provenanceSlice')
  const local = makeStore()
  mockReads()
  local.dispatch(maskFilterChanged('hasImputed'))
  install(local, 'b')
  expect(local.getState().provenance.maskFilter).toBe('hasImputed')
  await local.dispatch(fetchProvenanceThunk('b'))
  expect(local.getState().provenance.maskFilter).toBe('hasImputed')
  local.dispatch(provenanceReset())
  expect(local.getState().provenance.maskFilter).toBe('all')
})

// Advance across RTK's payloadCreator → Promise.race → fulfilled-dispatch
// microtasks. Aborting only the transport promise must not leave a commit gap.
it.each([0, 1, 2, 3, 4, 5, 6])('keeps a newer same-A save at codebook completion microtask boundary %s', async microtasks => {
  const local = makeStore(), { server, get } = mockReads(), codebook = deferred()
  const normalGet = get.getMockImplementation()!
  get.mockImplementation(path => path === '/datasets/a/codebook' ? codebook.promise : normalGet(path))
  vi.spyOn(api, 'post').mockImplementation(async () => { server.a.dataRevision = 3; return { currentDataRevision: 3, maskRevision: 1 } as any })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(local.getState().codebook.isLoading).toBe(true))
  const saved = columns('a', 'new saved label')
  server.a.schemaRevision = 3
  await act(async () => {
    codebook.resolve({ datasetId: 'a', schemaRevision: 2, columns: columns('a', 'obsolete refresh') })
    for (let index = 0; index < microtasks; index++) await Promise.resolve()
    local.dispatch(saveCodebookThunk.fulfilled({ datasetId: 'a', schemaRevision: 3, columns: saved,
      multiResponseGroups: [], weightConfig: null, surveyDesign: null, submittedColumns: local.getState().codebook.draftColumns,
      submittedGroups: [], status: 'ok', updatedColumns: 1,
      codebook: { datasetId: 'a', schemaRevision: 3, columns: saved } }, 'new-save', undefined))
  })
  expect(local.getState().codebook.schemaRevision).toBe(3)
  expect(local.getState().codebook.columns[0].label).toBe('new saved label')
  expect(local.getState().codebook.isLoading).toBe(false)
})

it('ignores stale metadata failure while a new B package operation is busy', async () => {
  const local = makeStore(), { server, get } = mockReads(), metadata = deferred(), exportRequest = deferred()
  const normalGet = get.getMockImplementation()!
  get.mockImplementation(path => path === '/datasets/a' ? metadata.promise : normalGet(path))
  vi.spyOn(api, 'post').mockImplementation(async () => { server.a.dataRevision = 3; return { currentDataRevision: 3, maskRevision: 1 } as any })
  vi.spyOn(api, 'downloadBlob').mockReturnValue(exportRequest.promise)
  const notice = vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(get).toHaveBeenCalledWith('/datasets/a'))
  act(() => install(local, 'b')); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ }))
  await act(async () => { metadata.reject(new Error('obsolete metadata error')) })
  expect(notice).not.toHaveBeenCalled()
  expect(screen.queryByText('操作は完了しましたが、表示の更新に失敗しました。')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ })).toBeDisabled()
  await act(async () => { exportRequest.reject(new Error('current export error')) })
  await ready()
  expect(notice).toHaveBeenCalledWith('current export error')
})

it('reports a committed import after unmount without navigating or unlocking the new dataset', async () => {
  const local = makeStore(), imported = deferred(), mutation = deferred()
  mockReads()
  vi.spyOn(api, 'upload').mockReturnValue(imported.promise)
  vi.spyOn(api, 'post').mockReturnValue(mutation.promise)
  const notice = vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  const old = mount(local); await ready()
  fireEvent.change(old.container.querySelector('input[type=file]')!, { target: { files: [new File(['zip'], 'package.zip')] } })
  old.unmount(); act(() => install(local, 'b')); mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  const before = local.getState()
  await act(async () => { imported.resolve({ datasetId: 'newly-imported' }) })
  expect(notice).toHaveBeenCalledWith('新規データセット newly-imported として取り込みました。')
  expect(local.getState()).toBe(before)
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
})

it.each(['export', 'import'] as const)('keeps committed refresh recovery and warnings while %s runs', async kind => {
  const local = makeStore(), { server, get } = mockReads(), packageRequest = deferred()
  const normalGet = get.getMockImplementation()!
  get.mockImplementation(path => path === '/datasets/a' ? Promise.reject(new Error('metadata unavailable')) : normalGet(path))
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    server.a.dataRevision = 3
    return { currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] } as any
  })
  vi.spyOn(api, 'downloadBlob').mockReturnValue(packageRequest.promise)
  vi.spyOn(api, 'upload').mockReturnValue(packageRequest.promise)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  const view = mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await screen.findByText('操作は完了しましたが、表示の更新に失敗しました。')
  await waitFor(() => expect(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ })).toBeEnabled())
  if (kind === 'export') fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ }))
  else fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [new File(['zip'], 'package.zip')] } })
  expect(screen.getByText('操作は完了しましたが、表示の更新に失敗しました。')).toBeInTheDocument()
  expect(screen.getByText('復元時の注意')).toBeInTheDocument()
  await act(async () => { packageRequest.reject(new Error('package failed')) })
  await waitFor(() => expect(screen.getByRole('button', { name: /^(?:loading )?再現パッケージ出力$/ })).toBeEnabled())
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: '表示を再取得' })).toBeEnabled()
  expect(screen.getByText('復元時の注意')).toBeInTheDocument()
  expect(post).toHaveBeenCalledTimes(1)
})

it.each([3, 4])('preserves newer active variables and weight at completion boundary %s', async microtasks => {
  const local = makeStore(), { server, get } = mockReads(), codebook = deferred()
  const normalGet = get.getMockImplementation()!
  get.mockImplementation(path => path === '/datasets/a/codebook' ? codebook.promise : normalGet(path))
  vi.spyOn(api, 'post').mockImplementation(async () => { server.a.dataRevision = 3; return { currentDataRevision: 3, maskRevision: 1 } as any })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(local.getState().codebook.isLoading).toBe(true))
  const saved = [{ ...columns('a')[0], columnId: 'a-new', name: 'a-new' }]
  server.a.schemaRevision = 3
  await act(async () => {
    codebook.resolve({ datasetId: 'a', schemaRevision: 2, columns: columns('a', 'obsolete refresh') })
    for (let index = 0; index < microtasks; index++) await Promise.resolve()
    local.dispatch(saveCodebookThunk.fulfilled({ datasetId: 'a', schemaRevision: 3, columns: saved,
      multiResponseGroups: [], weightConfig: null, surveyDesign: null, submittedColumns: local.getState().codebook.draftColumns,
      submittedGroups: [], status: 'ok', updatedColumns: 1,
      codebook: { datasetId: 'a', schemaRevision: 3, columns: saved } }, 'new-save', undefined))
    local.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'a-new' }]))
    local.dispatch(weightColumnSet({ datasetId: 'a', columnId: 'a-new' }))
  })
  expect(local.getState().globalVariables.activeEntities).toEqual([{ kind: 'column', columnId: 'a-new' }])
  expect(local.getState().globalVariables.weightColumnId).toBe('a-new')
  expect(local.getState().codebook.columns).toEqual(saved)
})

it('retains read-only recovery through Overview-style panel unmount on data revision change', async () => {
  const local = makeStore(), { server, get } = mockReads(), codebook = deferred()
  const normalGet = get.getMockImplementation()!
  let firstRead = true
  get.mockImplementation(path => {
    if (path === '/datasets/a/codebook' && firstRead) { firstRead = false; return codebook.promise }
    return normalGet(path)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    server.a = { dataRevision: 3, schemaRevision: 1 }
    return { currentDataRevision: 3, maskRevision: 1 } as any
  })
  function RevisionRemount() {
    const revision = useSelector((state: ReturnType<LocalStore['getState']>) => state.selection.dataRevision)
    return <ProvenanceHistoryPanel key={revision} />
  }
  render(<Provider store={local}><RevisionRemount /></Provider>)
  await ready()
  const oldPanel = screen.getByTestId('provenance-panel')
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(screen.getByTestId('provenance-panel')).not.toBe(oldPanel))
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('操作後の表示を更新しています')
  await act(async () => { codebook.reject(new Error('read failed after remount')) })
  await screen.findByText('read failed after remount')
  fireEvent.click(screen.getByRole('button', { name: '表示を再取得' }))
  await ready()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, isLoading: false })
  expect(local.getState().provenance.restoreRefresh).toBeNull()
  expect(post).toHaveBeenCalledTimes(1)
})

it('keeps a stale post-commit metadata read explicitly retryable', async () => {
  const local = makeStore(), { server, get } = mockReads()
  const normalGet = get.getMockImplementation()!
  let stale = true
  get.mockImplementation(path => {
    if (path === '/datasets/a' && stale) return Promise.resolve({ dataRevision: 2 }) as any
    return normalGet(path)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    server.a = { dataRevision: 3, schemaRevision: 1 }
    return { currentDataRevision: 3, maskRevision: 1 } as any
  })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await screen.findByText('操作後のデータ世代をまだ取得できません。表示を再取得してください。')
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(screen.getByRole('button', { name: /^(?:loading )?Undo$/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '表示を再取得' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '表示を再取得' })).toBeEnabled())
  expect(local.getState().provenance.restoreRefresh?.error).toBeTruthy()
  stale = false
  fireEvent.click(screen.getByRole('button', { name: '表示を再取得' }))
  await ready()
  expect(local.getState().selection.dataRevision).toBe(3)
  expect(post).toHaveBeenCalledTimes(1)
})

it('retries an owned refresh whose metadata is newer than the original commit', async () => {
  const local = makeStore(), { server, get } = mockReads()
  const normalGet = get.getMockImplementation()!
  let fail = true
  get.mockImplementation(path => {
    if (path === '/datasets/a/codebook' && fail) { fail = false; return Promise.reject(new Error('newer snapshot read failed')) }
    return normalGet(path)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    server.a = { dataRevision: 4, schemaRevision: 1 }
    return { currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] } as any
  })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await screen.findByText('newer snapshot read failed')
  expect(local.getState().selection.dataRevision).toBe(4)
  expect(local.getState().provenance.restoreRefresh).toMatchObject({ committedRevision: 3, dataRevision: 4, loading: false })
  expect(screen.queryByText('復元時の注意')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '表示を再取得' }))
  await ready()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 1, isLoading: false })
  expect(screen.queryByText('newer snapshot read failed')).not.toBeInTheDocument()
  expect(post).toHaveBeenCalledTimes(1)
})

it('preserves current restore warnings across the normal revision-driven panel remount', async () => {
  const local = makeStore(), { server } = mockReads()
  vi.spyOn(api, 'post').mockImplementation(async () => {
    server.a = { dataRevision: 3, schemaRevision: 1 }
    return { currentDataRevision: 3, maskRevision: 1, restoreWarnings: ['REVISION_CODEBOOK_BACKFILLED'] } as any
  })
  function RevisionRemount() {
    const revision = useSelector((state: ReturnType<LocalStore['getState']>) => state.selection.dataRevision)
    return <ProvenanceHistoryPanel key={revision} />
  }
  render(<Provider store={local}><RevisionRemount /></Provider>); await ready()
  const oldPanel = screen.getByTestId('provenance-panel')
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(screen.getByTestId('provenance-panel')).not.toBe(oldPanel))
  await ready()
  expect(screen.getByText('復元時の注意')).toBeInTheDocument()
  expect(local.getState().provenance.restoreRefresh).toMatchObject({ datasetId: 'a', committedRevision: 3, loading: false, error: null })
  act(() => install(local, 'b')); await ready()
  expect(screen.queryByText('復元時の注意')).not.toBeInTheDocument()
})

it('keeps a newer B recovery error when old A metadata and finally complete', async () => {
  const local = makeStore(), { server, get } = mockReads(), oldMetadata = deferred()
  const normalGet = get.getMockImplementation()!
  let failB = true
  get.mockImplementation(path => {
    if (path === '/datasets/a') return oldMetadata.promise
    if (path === '/datasets/b' && failB) { failB = false; return Promise.reject(new Error('current B refresh failed')) }
    return normalGet(path)
  })
  vi.spyOn(api, 'post').mockImplementation(async path => {
    server[path.includes('/a/') ? 'a' : 'b'].dataRevision = 3
    return { currentDataRevision: 3, maskRevision: 1 } as any
  })
  mount(local); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await waitFor(() => expect(get).toHaveBeenCalledWith('/datasets/a'))
  act(() => install(local, 'b')); await ready()
  fireEvent.click(screen.getByRole('button', { name: /^(?:loading )?Undo$/ }))
  await screen.findByText('current B refresh failed')
  const before = local.getState().provenance.restoreRefresh
  await act(async () => { oldMetadata.resolve({ dataRevision: 3 }) })
  expect(local.getState().provenance.restoreRefresh).toBe(before)
  expect(screen.getByText('current B refresh failed')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '表示を再取得' }))
  await ready()
  expect(local.getState().selection).toMatchObject({ datasetId: 'b', dataRevision: 3 })
})
