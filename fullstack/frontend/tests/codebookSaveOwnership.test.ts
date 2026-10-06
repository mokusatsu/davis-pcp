import { configureStore, type Middleware } from '@reduxjs/toolkit'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type CodebookColumn, type CodebookResponse, type MultiResponseGroup } from '../src/api/client'
import { datasetLoaded, datasetValuesUpdated, selectionReducer, globalVariablesSlice, variablesInitialized, weightColumnSet, selectionApplied } from '../src/app/store'
import { codebookSlice, codebookReceived, codebookReset, draftColumnUpdated, draftMultiResponseGroupUpdated,
  saveCodebookThunk, codebookSaveAccepted, fetchCodebookThunk, sameSavedSnapshot, saveLicenseTextThunk, saveWeightConfigThunk } from '../src/features/dataset/codebookSlice'

afterEach(() => vi.restoreAllMocks())
const clone = <T,>(value: T): T => structuredClone(value)
function col(id: string, label: string, role: 'question' | 'weight' = 'question'): CodebookColumn {
  return { columnId: id, name: id, label, scaleType: role === 'weight' ? 'ratio' : 'ordinal', role,
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
}
function book(id: string, revision: number, columns: CodebookColumn[], weighted = false): CodebookResponse {
  return { datasetId: id, schemaRevision: revision, columns, multiResponseGroups: [],
    weightConfig: weighted ? { weightColumnId: `${id}-w`, weightType: 'survey' } : null,
    surveyDesign: weighted ? { weightColumnId: `${id}-w` } : null }
}
function makeStore() {
  const actions: any[] = []
  const record: Middleware = () => next => action => { actions.push(action); return next(action) }
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer, globalVariables: globalVariablesSlice.reducer },
    middleware: get => get({ serializableCheck: false }).concat(record) })
  return Object.assign(local, { actions })
}
type Store = ReturnType<typeof makeStore>
function install(local: Store, response: CodebookResponse) {
  const id = response.datasetId
  local.dispatch(datasetLoaded({ datasetId: id, name: id, rowIds: [`${id}-r1`, `${id}-r2`], dataRevision: response.schemaRevision }))
  const meta = Object.fromEntries(response.columns.map(c => [c.name, { columnId: c.columnId, name: c.name,
    semanticType: 'numeric' as const, physicalType: 'Float64', missingCount: 0, isTargetCandidate: false }]))
  local.dispatch(variablesInitialized({ datasetId: id, variables: response.columns.map(c => c.name), meta }))
  local.dispatch(codebookReceived(clone(response)))
  local.dispatch(selectionApplied({ rowIds: [`${id}-r2`], operation: 'replace', label: 'Save ownership selection' }))
  if (response.weightConfig) local.dispatch(weightColumnSet({ datasetId: id, columnId: response.weightConfig.weightColumnId }))
}
function edit(local: Store, label: string) {
  local.dispatch(draftColumnUpdated({ columnId: `${local.getState().codebook.datasetId}-q`, patch: { label } }))
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
// Every successful mutation commits after checking its expected revision.
// Only response delivery is delayed; newer writes never reuse stale revisions.
function serverHarness() {
  const snapshots: Record<string, CodebookResponse> = { a: book('a', 1, [col('a-q', 'A initial')]),
    b: book('b', 1, [col('b-q', 'B initial'), col('b-w', 'B weight', 'weight')], true) }
  const pending: Array<{ finish: () => void; fail: () => void; response: any }> = []
  vi.spyOn(api, 'put').mockImplementation((path, body: any) => {
    const id = path.split('/')[2], before = snapshots[id]
    if (body.expectedSchemaRevision !== before.schemaRevision) throw new Error('ANALYSIS_INPUT_STALE')
    const next = clone(before)
    next.schemaRevision++
    next.columns = next.columns.map(c => ({ ...c, ...body.columns.find((p: CodebookColumn) => p.columnId === c.columnId) }))
    next.columns = next.columns.map(c => c.scaleType === 'ordinal' && c.categoryOrder.length === 0 ? { ...c, categoryOrder: ['1', '2'] } : c)
    next.multiResponseGroups = clone(body.multiResponseGroups)
    snapshots[id] = next
    const response = { status: 'success', datasetId: id, schemaRevision: next.schemaRevision,
      updatedColumns: body.columns.length, codebook: clone(next) }
    const wire = deferred<any>()
    pending.push({ response, finish: () => wire.resolve(response), fail: () => wire.reject(new Error('delayed transport failure')) })
    return wire.promise
  })
  return { snapshots, pending, installNewSnapshot() {
    const next = book('a', snapshots.a.schemaRevision + 1, [col('a-q', 'A newer server snapshot'), col('a-w', 'A new weight', 'weight')], true)
    snapshots.a = next
    return next
  } }
}
function start() {
  const local = makeStore(), server = serverHarness()
  install(local, server.snapshots.a)
  edit(local, 'A submitted')
  const old = local.dispatch(saveCodebookThunk())
  expect(local.getState().codebook.isSaving).toBe(true)
  expect(server.snapshots.a.schemaRevision).toBe(2)
  return { local, server, old }
}
async function superseded(request: ReturnType<ReturnType<typeof saveCodebookThunk>>, committed: string) {
  const action = await request
  expect(saveCodebookThunk.rejected.match(action)).toBe(true)
  expect(action.payload).toEqual({ code: 'CODEBOOK_SAVE_SUPERSEDED', committed })
  await expect(request.unwrap()).rejects.toEqual(action.payload)
}

it.each(['finish', 'fail'] as const)('keeps newer B state and busy ownership after old A %s', async outcome => {
  const { local, server, old } = start()
  install(local, server.snapshots.b); edit(local, 'B submitted')
  const current = local.dispatch(saveCodebookThunk()), before = local.getState()
  server.pending[0][outcome]()
  await superseded(old, outcome === 'finish' ? 'confirmed' : 'unknown')
  expect(local.getState()).toEqual(before)
  expect(local.actions.filter(codebookSaveAccepted.match)).toHaveLength(0)
  server.pending[1].finish(); await expect(current.unwrap()).resolves.toMatchObject({ datasetId: 'b', schemaRevision: 2 })
  expect(local.getState().codebook.isSaving).toBe(false)
})

it.each(['finish', 'fail'] as const)('keeps prepared A→B→A state after old %s', async outcome => {
  const { local, server, old } = start()
  install(local, server.snapshots.b); install(local, server.installNewSnapshot())
  const before = local.getState()
  server.pending[0][outcome]()
  await superseded(old, outcome === 'finish' ? 'confirmed' : 'unknown')
  expect(local.getState()).toEqual(before)
  expect(local.getState().globalVariables.weightColumnId).toBe('a-w')
  expect(local.getState().globalVariables.activeEntities).toHaveLength(2)
})

it.each(['finish', 'fail'] as const)('does not settle a newer same-A save on old %s', async outcome => {
  const { local, server, old } = start()
  install(local, server.installNewSnapshot()); edit(local, 'A newer pending')
  const current = local.dispatch(saveCodebookThunk()), before = local.getState()
  expect(server.snapshots.a.schemaRevision).toBe(4)
  server.pending[0][outcome]()
  await superseded(old, outcome === 'finish' ? 'confirmed' : 'unknown')
  expect(local.getState()).toEqual(before)
  server.pending[1].finish(); await current.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 4, isSaving: false, hasChanges: false })
  expect(local.getState().globalVariables.weightColumnId).toBe('a-w')
  expect(local.getState().globalVariables.activeEntities).toHaveLength(2)
})

it('does not overwrite a newer completed same-A save with an old committed response', async () => {
  const { local, server, old } = start()
  install(local, server.installNewSnapshot()); edit(local, 'A newest saved')
  const current = local.dispatch(saveCodebookThunk())
  server.pending[1].finish(); await current.unwrap()
  const before = local.getState()
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState()).toEqual(before)
  expect(before.codebook.schemaRevision).toBe(4)
  expect(before.globalVariables.weightColumnId).toBe('a-w')
})

it.each([false, true])('normalizes the current save and preserves newer draft edits=%s', async edited => {
  const { local, server, old } = start()
  if (edited) edit(local, 'A unsaved next edit')
  const draft = local.getState().codebook.draftColumns
  server.pending[0].finish()
  const action = await old
  expect(saveCodebookThunk.fulfilled.match(action)).toBe(true)
  await expect(old.unwrap()).resolves.toEqual(action.payload)
  const current = local.getState().codebook
  expect(current.columns[0]).toMatchObject({ label: 'A submitted', categoryOrder: ['1', '2'] })
  expect(current.draftColumns).toEqual(edited ? draft : current.columns)
  expect(current).toMatchObject({ schemaRevision: 2, isSaving: false, hasChanges: edited, saveRequestId: old.requestId })
  expect(local.actions.filter(codebookSaveAccepted.match)).toHaveLength(1)
})

it.each([false, true])('retains submitted or later multi-response group edits=%s', async edited => {
  const local = makeStore(), server = serverHarness()
  install(local, server.snapshots.a)
  const group: MultiResponseGroup = { groupId: 'ma', label: 'Submitted group', selectedCodes: ['1'], unselectedCodes: ['0'],
    allUnselectedMeaning: 'valid', maxSelections: null, optionOrder: ['a-q'] }
  local.dispatch(draftMultiResponseGroupUpdated({ group, columnIds: ['a-q'] }))
  const saving = local.dispatch(saveCodebookThunk())
  if (edited) local.dispatch(draftMultiResponseGroupUpdated({ group: { ...group, label: 'Later group' }, columnIds: ['a-q'] }))
  server.pending[0].finish(); await saving.unwrap()
  expect(local.getState().codebook.multiResponseGroups).toEqual([group])
  expect(local.getState().codebook.draftMultiResponseGroups[0].label).toBe(edited ? 'Later group' : 'Submitted group')
  expect(local.getState().codebook.hasChanges).toBe(edited)
})

it('rejects a duplicate submission before pending or another PUT', async () => {
  const { local, server, old } = start(), before = local.getState()
  const duplicate = local.dispatch(saveCodebookThunk()), action = await duplicate
  expect(saveCodebookThunk.rejected.match(action) && action.meta.condition).toBe(true)
  await expect(duplicate.unwrap()).rejects.toMatchObject({ name: 'ConditionError' })
  expect(local.getState()).toBe(before)
  expect(api.put).toHaveBeenCalledTimes(1)
  server.pending[0].finish(); await old.unwrap()
})

it('reports the current transport error and settles only its owner', async () => {
  const { local, server, old } = start()
  server.pending[0].fail()
  const action = await old
  expect(saveCodebookThunk.rejected.match(action) && !action.meta.aborted).toBe(true)
  await expect(old.unwrap()).rejects.toMatchObject({ message: 'delayed transport failure' })
  expect(local.getState().codebook).toMatchObject({ isSaving: false, hasChanges: true, schemaRevision: 1, saveRequestId: old.requestId })
})

it.each([false, true])('does not apply an aborted committed response, newer owner=%s', async newer => {
  const { local, server, old } = start()
  let current: typeof old | undefined
  if (newer) { install(local, server.installNewSnapshot()); edit(local, 'New pending'); current = local.dispatch(saveCodebookThunk()) }
  old.abort()
  const action = await old
  expect(saveCodebookThunk.rejected.match(action) && action.meta.aborted).toBe(true)
  await expect(old.unwrap()).rejects.toMatchObject({ name: 'AbortError' })
  const before = local.getState()
  expect(before.codebook.isSaving).toBe(newer)
  server.pending[0].finish()
  for (let index = 0; index < 10; index++) await Promise.resolve()
  expect(local.getState()).toEqual(before)
  expect(local.actions.filter(codebookSaveAccepted.match)).toHaveLength(0)
  if (current) { server.pending[1].finish(); await current.unwrap() }
})

it.each(['reset', 'dataset reinstallation', 'data revision'] as const)('invalidates old ownership after %s', async kind => {
  const { local, server, old } = start()
  if (kind === 'reset') local.dispatch(codebookReset())
  else if (kind === 'dataset reinstallation') local.dispatch(datasetLoaded({ datasetId: 'a', name: 'a', rowIds: ['a-r1'] }))
  else local.dispatch(datasetValuesUpdated({ datasetId: 'a', dataRevision: 9 }))
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState().codebook.isSaving).toBe(false)
  expect(local.actions.filter(codebookSaveAccepted.match)).toHaveLength(0)
})

it('accepts a lower-schema prepared snapshot rather than assuming monotonic schema revisions', async () => {
  const { local, server, old } = start()
  install(local, server.installNewSnapshot())
  const restored = book('a', 1, [col('a-q', 'Restored snapshot'), col('a-w', 'Restored weight', 'weight')], true)
  server.snapshots.a = restored
  install(local, restored)
  const before = local.getState()
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState()).toEqual(before)
})

it('keeps a valid save through an unchanged same-dataset read and independent license save', async () => {
  const { local, server, old } = start()
  const unchanged = book('a', 1, [col('a-q', 'A initial')])
  vi.spyOn(api, 'get').mockResolvedValue(unchanged)
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(local.getState().codebook).toMatchObject({ isSaving: true, saveRequestId: old.requestId })
  vi.mocked(api.put).mockResolvedValueOnce({ codebook: { licenseText: 'Independent attribution', licenseRevision: 2 } })
  await local.dispatch(saveLicenseTextThunk({ datasetId: 'a', licenseText: 'Independent attribution', expectedLicenseRevision: 1 })).unwrap()
  server.pending[0].finish(); await old.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, isSaving: false, hasChanges: false,
    licenseText: 'Independent attribution', licenseRevision: 2 })
  expect(local.getState().codebook.columns[0].categoryOrder).toEqual(['1', '2'])
})

it.each([false, true])('normalizes a save whose own canonical snapshot was already read, later edits=%s', async edited => {
  const { local, server, old } = start()
  if (edited) edit(local, 'A later draft')
  const draft = local.getState().codebook.draftColumns
  vi.spyOn(api, 'get').mockResolvedValue(clone(server.snapshots.a))
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, saveRequestId: old.requestId, isSaving: false })
  server.pending[0].finish(); await old.unwrap()
  const current = local.getState().codebook
  expect(current).toMatchObject({ schemaRevision: 2, isSaving: false, hasChanges: edited })
  expect(current.draftColumns).toEqual(edited ? draft : current.columns)
})

it('keeps one canonical read transition and repeated identical reads eligible for acceptance', async () => {
  const { local, server, old } = start()
  vi.spyOn(api, 'get').mockResolvedValue(clone(server.snapshots.a))
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  server.pending[0].finish(); await old.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, hasChanges: false, isSaving: false })
})

it.each(['baseline', 'own canonical'] as const)('never revives a save after incompatible read then %s snapshot', async returned => {
  const { local, server, old } = start()
  const canonical = clone(server.snapshots.a)
  vi.spyOn(api, 'get').mockResolvedValueOnce(server.installNewSnapshot())
    .mockResolvedValueOnce(returned === 'baseline' ? book('a', 1, [col('a-q', 'A initial')]) : canonical)
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const before = local.getState()
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState()).toEqual(before)
  expect(local.actions.filter(codebookSaveAccepted.match)).toHaveLength(0)
})

it('invalidates a save when a different same-A read installs a newer snapshot', async () => {
  const { local, server, old } = start()
  const latest = server.installNewSnapshot()
  vi.spyOn(api, 'get').mockResolvedValue(latest)
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const before = local.getState()
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState()).toEqual(before)
  expect(before.codebook).toMatchObject({ schemaRevision: 3, isSaving: false, saveRequestId: old.requestId })
})

it('invalidates an old save after a weight declaration accepted against a newer server revision', async () => {
  const { local, server, old } = start()
  // A newer read acknowledges the first server commit before a second write.
  vi.spyOn(api, 'get').mockResolvedValue(clone(server.snapshots.a))
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const expected = local.getState().codebook.schemaRevision
  vi.mocked(api.put).mockImplementationOnce(async (_path, body: any) => {
    expect(body.expectedSchemaRevision).toBe(expected)
    expect(expected).toBe(server.snapshots.a.schemaRevision)
    return { schemaRevision: expected + 1, codebook: { weightConfig: null, surveyDesign: null } } as any
  })
  await local.dispatch(saveWeightConfigThunk({ weightConfig: null })).unwrap()
  const before = local.getState()
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState()).toEqual(before)
})

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('has one atomic Save acceptance before an installation at microtask depth %s', async depth => {
  const { local, server, old } = start()
  server.pending[0].finish()
  for (let index = 0; index < depth; index++) await Promise.resolve()
  install(local, server.installNewSnapshot())
  const before = local.getState(), acceptedBeforeInstall = local.actions.filter(codebookSaveAccepted.match).length
  const action = await old
  expect(local.getState()).toEqual(before)
  expect(local.actions.filter(codebookSaveAccepted.match)).toHaveLength(acceptedBeforeInstall)
  if (acceptedBeforeInstall) {
    expect(saveCodebookThunk.fulfilled.match(action)).toBe(true)
    await expect(old.unwrap()).resolves.toMatchObject({ schemaRevision: 2 })
  } else await superseded(old, 'confirmed')
  expect(before.globalVariables.weightColumnId).toBe('a-w')
  expect(before.globalVariables.activeEntities).toHaveLength(2)
})

it('keeps delayed automatic fulfilled acknowledgment state-free', async () => {
  const { local, server, old } = start()
  server.pending[0].finish(); const accepted = await old.unwrap()
  install(local, server.installNewSnapshot())
  const before = local.getState()
  local.dispatch(saveCodebookThunk.fulfilled(accepted, old.requestId, undefined))
  expect(local.getState()).toBe(before)
})

it('treats reordered object/value-label/weight keys as benign reads and the same canonical receipt', async () => {
  const local = makeStore(), server = serverHarness()
  server.snapshots.a = book('a', 1, [col('a-q', 'A initial'), col('a-w', 'A weight', 'weight')], true)
  server.snapshots.a.columns[0].valueLabels = { '1': 'One', '2': 'Two', other: 'Other' }
  server.snapshots.a.surveyDesign = { weightColumnId: 'a-w', strataColumnId: 'a-q' }
  const baseline = clone(server.snapshots.a)
  install(local, baseline); edit(local, 'A submitted')
  const save = local.dispatch(saveCodebookThunk())
  function reorder(value: any): any {
    if (Array.isArray(value)) return value.map(reorder)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)]))
    return value
  }
  vi.spyOn(api, 'get').mockResolvedValueOnce(reorder(baseline)).mockResolvedValue(reorder(clone(server.snapshots.a)))
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(local.getState().codebook).toMatchObject({ isSaving: true, saveSnapshotAdvanced: false, saveRequestId: save.requestId })
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(local.getState().codebook).toMatchObject({ isSaving: false, saveSnapshotAdvanced: true, saveRequestId: save.requestId })
  server.pending[0].finish(); await save.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 2, hasChanges: false, isSaving: false })
  expect(local.getState().globalVariables.weightColumnId).toBe('a-w')
})


it('preserves array order and exact values in saved-snapshot ownership comparisons', () => {
  const first = book('a', 1, [col('a-q', 'Q'), col('a-w', 'W', 'weight')], true)
  const reordered = clone(first)
  reordered.columns.reverse()
  expect(sameSavedSnapshot(first, reordered)).toBe(false)
  const changed = clone(first)
  changed.columns[0].label = 'Different label'
  expect(sameSavedSnapshot(first, changed)).toBe(false)
  const ordered = clone(first)
  ordered.columns[0].categoryOrder = ['1', '2']
  const reversed = clone(ordered)
  reversed.columns[0].categoryOrder.reverse()
  expect(sameSavedSnapshot(ordered, reversed)).toBe(false)
})
