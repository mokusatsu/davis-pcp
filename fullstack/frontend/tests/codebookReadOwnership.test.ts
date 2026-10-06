import { configureStore } from '@reduxjs/toolkit'
import { expect, it, vi, afterEach } from 'vitest'
import { api, type CodebookColumn } from '../src/api/client'
import { selectionReducer, datasetLoaded, variablesInitialized, globalVariablesSlice } from '../src/app/store'
import { codebookSlice, codebookReceived, draftMultiResponseGroupUpdated, saveCodebookThunk, fetchCodebookThunk, codebookSaveAccepted, codebookReadAccepted, draftColumnUpdated, codebookReset, saveLicenseTextThunk } from '../src/features/dataset/codebookSlice'
afterEach(() => vi.restoreAllMocks())
function deferred() { let resolve!: (x: any) => void; const promise = new Promise<any>(r => { resolve = r }); return { promise, resolve } }
it.each([0, 1, 2, 3, 4, 5, 6])('preserves the accepted MA selection across valid GET-before-PUT ordering at depth %s', async depth => {
  const actions: any[] = []
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer, globalVariables: globalVariablesSlice.reducer },
    middleware: get => get({ serializableCheck: false }).concat(() => next => action => { actions.push(action); return next(action) }) })
  const column: CodebookColumn = { columnId: 'q', name: 'q', label: 'Q', scaleType: 'nominal', role: 'question', valueLabels: {},
    categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
  let server = { datasetId: 'a', schemaRevision: 1, columns: [column], multiResponseGroups: [] as any[] }
  local.dispatch(datasetLoaded({ datasetId: 'a', name: 'A', rowIds: ['r'] }))
  local.dispatch(variablesInitialized({ datasetId: 'a', variables: ['q'], meta: { q: { columnId: 'q', name: 'q', semanticType: 'numeric', physicalType: 'Float64', missingCount: 0, isTargetCandidate: false } } }))
  local.dispatch(codebookReceived(server))
  const group = { groupId: 'ma', label: 'MA', selectedCodes: ['1'], unselectedCodes: ['0'], allUnselectedMeaning: 'valid' as const, maxSelections: null, optionOrder: ['q'] }
  local.dispatch(draftMultiResponseGroupUpdated({ group, columnIds: ['q'] }))
  const put = deferred(), get = deferred()
  let body: any
  vi.spyOn(api, 'put').mockImplementation((_path, payload) => { body = payload; return put.promise })
  vi.spyOn(api, 'get').mockReturnValue(get.promise)
  const save = local.dispatch(saveCodebookThunk())
  const read = local.dispatch(fetchCodebookThunk('a'))
  // GET reaches server before pending PUT commits; this is a valid old read.
  const readSnapshot = structuredClone(server)
  expect(body.expectedSchemaRevision).toBe(server.schemaRevision)
  server = { ...server, schemaRevision: 2, columns: body.columns, multiResponseGroups: body.multiResponseGroups }
  get.resolve(readSnapshot)
  for (let i = 0; i < depth; i++) await Promise.resolve()
  put.resolve({ status: 'success', datasetId: 'a', schemaRevision: 2, updatedColumns: 1, codebook: server })
  const [saved, fetched] = await Promise.all([save, read])
  const result = { depth, actionOrder: actions.filter(x => codebookSaveAccepted.match(x) || codebookReadAccepted.match(x)).map(x => x.type),
    saveOutcome: saved.type, fetchOutcome: fetched.type, savedColumns: local.getState().codebook.columns,
    entities: local.getState().globalVariables.activeEntities, schema: local.getState().codebook.schemaRevision }
  expect(result.saveOutcome).toBe('codebook/save/fulfilled')
  expect(result.savedColumns[0].multiResponseGroup).toBe('ma')
  expect(result.entities).toEqual([{ kind: 'ma', groupId: 'ma' }])
})

function makeReadStore() {
  const actions: any[] = []
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer, globalVariables: globalVariablesSlice.reducer },
    middleware: get => get({ serializableCheck: false }).concat(() => next => action => { actions.push(action); return next(action) }) })
  const book = (id: string, revision = 1) => ({ datasetId: id, schemaRevision: revision,
    columns: [{ columnId: `${id}-q`, name: `${id}-q`, label: `${id} saved`, role: 'question' as const, scaleType: 'nominal' as const,
      valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }],
    multiResponseGroups: [], weightConfig: null, surveyDesign: null })
  const install = (id: string) => {
    local.dispatch(datasetLoaded({ datasetId: id, name: id, rowIds: [`${id}-r`] }))
    local.dispatch(variablesInitialized({ datasetId: id, variables: [`${id}-q`] }))
    local.dispatch(codebookReceived(book(id)))
  }
  install('a')
  return { local, book, install, actions }
}

it.each(['resolve', 'reject', 'abort'] as const)('keeps the newer A→B→A read busy after old %s', async outcome => {
  const { local, book, install, actions } = makeReadStore()
  let fail!: (reason: Error) => void
  const first = deferred(), second = deferred()
  const oldWire = new Promise<any>((resolve, reject) => { first.promise.then(resolve); fail = reject })
  vi.spyOn(api, 'get').mockReturnValueOnce(oldWire).mockReturnValueOnce(second.promise)
  const old = local.dispatch(fetchCodebookThunk('a'))
  install('b'); install('a')
  const current = local.dispatch(fetchCodebookThunk('a')), before = local.getState()
  if (outcome === 'resolve') first.resolve(book('a', 2))
  else if (outcome === 'reject') fail(new Error('Old read error'))
  else old.abort()
  const action = await old
  expect(fetchCodebookThunk.rejected.match(action)).toBe(true)
  await expect(old.unwrap()).rejects.toBeDefined()
  expect(local.getState()).toEqual(before)
  expect(local.getState().codebook.isLoading).toBe(true)
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(0)
  second.resolve(book('a', 3)); await current.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 3, isLoading: false })
  if (outcome === 'abort') {
    first.resolve(book('a', 2))
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(local.getState().codebook.schemaRevision).toBe(3)
  }
})

it('keeps the newest same-A fetch and rejected unwrap when an older read arrives later', async () => {
  const { local, book } = makeReadStore(), first = deferred(), second = deferred()
  vi.spyOn(api, 'get').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const old = local.dispatch(fetchCodebookThunk('a')), current = local.dispatch(fetchCodebookThunk('a'))
  second.resolve(book('a', 3)); await current.unwrap()
  const before = local.getState()
  first.resolve(book('a', 2))
  await expect(old.unwrap()).rejects.toBe('CODEBOOK_FETCH_SUPERSEDED')
  expect(local.getState()).toBe(before)
})

it('keeps newer drafts and independent license metadata through a current read', async () => {
  const { local, book } = makeReadStore(), wire = deferred()
  vi.spyOn(api, 'get').mockReturnValue(wire.promise)
  const read = local.dispatch(fetchCodebookThunk('a'))
  local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'New draft' } }))
  vi.spyOn(api, 'put').mockResolvedValue({ codebook: { licenseText: 'Latest license', licenseRevision: 2 } })
  await local.dispatch(saveLicenseTextThunk({ datasetId: 'a', licenseText: 'Latest license', expectedLicenseRevision: 1 })).unwrap()
  wire.resolve({ ...book('a', 2), licenseText: 'Old license', licenseRevision: 1 })
  const result = await read
  expect(fetchCodebookThunk.fulfilled.match(result)).toBe(true)
  await expect(read.unwrap()).resolves.toEqual(result.payload)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isLoading: false, hasChanges: true,
    licenseText: 'Latest license', licenseRevision: 2, draftColumns: [expect.objectContaining({ label: 'New draft' })] })
})

it.each(['reset', 'abort'] as const)('does not accept late read after current %s', async kind => {
  const { local, book, actions } = makeReadStore(), wire = deferred()
  vi.spyOn(api, 'get').mockReturnValue(wire.promise)
  const read = local.dispatch(fetchCodebookThunk('a'))
  if (kind === 'reset') local.dispatch(codebookReset()); else read.abort()
  wire.resolve(book('a', 2))
  expect(fetchCodebookThunk.rejected.match(await read)).toBe(true)
  await expect(read.unwrap()).rejects.toBeDefined()
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(0)
  expect(local.getState().codebook.isLoading).toBe(false)
})

it('retains the current read error and settles loading', async () => {
  const { local } = makeReadStore()
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Current read failed'))
  const read = local.dispatch(fetchCodebookThunk('a'))
  await expect(read.unwrap()).rejects.toMatchObject({ message: 'Current read failed' })
  expect(local.getState().codebook.isLoading).toBe(false)
})

it.each([0, 1, 2, 3, 4, 5, 6])('does not reapply read state after a prepared installation at microtask depth %s', async depth => {
  const { local, book, install, actions } = makeReadStore(), wire = deferred()
  vi.spyOn(api, 'get').mockReturnValue(wire.promise)
  const read = local.dispatch(fetchCodebookThunk('a'))
  wire.resolve(book('a', 2))
  for (let i = 0; i < depth; i++) await Promise.resolve()
  install('b'); install('a')
  const before = local.getState(), accepted = actions.filter(codebookReadAccepted.match).length
  const result = await read
  expect(local.getState()).toEqual(before)
  expect(actions.filter(codebookReadAccepted.match)).toHaveLength(accepted)
  if (accepted) {
    expect(fetchCodebookThunk.fulfilled.match(result)).toBe(true)
    await expect(read.unwrap()).resolves.toMatchObject({ schemaRevision: 2 })
  } else await expect(read.unwrap()).rejects.toBe('CODEBOOK_FETCH_SUPERSEDED')
})
