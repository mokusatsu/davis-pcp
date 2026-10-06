import { configureStore, type Middleware } from '@reduxjs/toolkit'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type CodebookColumn, type CodebookResponse, type SurveyDesignSpec, type WeightConfig } from '../src/api/client'
import { datasetLoaded, datasetValuesUpdated, selectionReducer, globalVariablesSlice, variablesInitialized,
  weightColumnSet, weightColumnCleared, activeEntitiesSet, analysisWorkspaceRestored } from '../src/app/store'
import { codebookSlice, codebookReceived, draftColumnUpdated, draftMultiResponseGroupUpdated, licenseMetadataReceived,
  codebookWeightAccepted, fetchCodebookThunk, saveCodebookThunk, saveWeightConfigThunk } from '../src/features/dataset/codebookSlice'

afterEach(() => vi.restoreAllMocks())
const clone = <T,>(value: T): T => structuredClone(value)
const weight = (id = 'a-w1'): WeightConfig => ({ weightColumnId: id, weightType: 'survey' })
const design = (id = 'a-w1'): SurveyDesignSpec => ({ weightColumnId: id, strataColumnId: null, psuColumnId: null })
function column(id: string): CodebookColumn {
  return { columnId: id, name: id, label: id, role: id.includes('-w') ? 'weight' : 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }
}
function book(id: string): CodebookResponse {
  return { datasetId: id, schemaRevision: 10, columns: ['q', 'w1', 'w2', 'w3', 'strata', 'psu'].map(name => column(`${id}-${name}`)),
    multiResponseGroups: [], weightConfig: null, surveyDesign: null, licenseText: '', licenseRevision: 1 }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
function makeStore() {
  const actions: any[] = []
  const record: Middleware = () => next => action => { actions.push(action); return next(action) }
  const local = configureStore({ reducer: { selection: selectionReducer, codebook: codebookSlice.reducer,
    globalVariables: globalVariablesSlice.reducer }, middleware: get => get({ serializableCheck: false }).concat(record) })
  return Object.assign(local, { actions })
}
type Store = ReturnType<typeof makeStore>
function install(local: Store, response: CodebookResponse) {
  local.dispatch(datasetLoaded({ datasetId: response.datasetId, name: response.datasetId, rowIds: ['r1', 'r2'], dataRevision: 7 }))
  initialize(local, response)
  local.dispatch(codebookReceived(clone(response)))
}
function initialize(local: Store, response: CodebookResponse) {
  local.dispatch(variablesInitialized({ datasetId: response.datasetId, variables: response.columns.map(c => c.name),
    meta: Object.fromEntries(response.columns.map(c => [c.name, { columnId: c.columnId, name: c.name,
      semanticType: 'numeric' as const, physicalType: 'Float64', missingCount: 0, isTargetCandidate: false }])) }))
}
function harness() {
  const snapshots: Record<string, CodebookResponse> = { a: book('a'), b: book('b') }
  const pending: Array<{ response: any; finish(): void; fail(): void }> = []
  const revisions: number[] = []
  vi.spyOn(api, 'get').mockImplementation(async path => clone(snapshots[path.split('/')[2]]) as any)
  vi.spyOn(api, 'put').mockImplementation((path, body: any) => {
    const id = path.split('/')[2], before = snapshots[id]
    if (body.expectedSchemaRevision !== before.schemaRevision) return Promise.reject({ code: 'ANALYSIS_INPUT_STALE', message: 'stale schema' })
    revisions.push(body.expectedSchemaRevision)
    const next = clone(before)
    next.schemaRevision++
    next.columns = next.columns.map(c => ({ ...c, ...body.columns.find((patch: CodebookColumn) => patch.columnId === c.columnId) }))
    if ('multiResponseGroups' in body) next.multiResponseGroups = clone(body.multiResponseGroups)
    if ('weightConfig' in body) next.weightConfig = clone(body.weightConfig)
    if ('surveyDesign' in body) next.surveyDesign = clone(body.surveyDesign)
    snapshots[id] = next // Commit under CAS before deferred response delivery.
    const response = { status: 'success', datasetId: id, schemaRevision: next.schemaRevision, updatedColumns: body.columns.length, codebook: clone(next) }
    const wire = deferred<any>()
    pending.push({ response, finish: () => wire.resolve(clone(response)), fail: () => wire.reject(new Error('response lost after commit')) })
    return wire.promise
  })
  return { snapshots, pending, revisions }
}
function start() {
  const local = makeStore(), server = harness()
  install(local, server.snapshots.a)
  local.dispatch(weightColumnSet({ columnId: 'a-w2', datasetId: 'a' }))
  const request = local.dispatch(saveWeightConfigThunk({ weightConfig: weight(), surveyDesign: design() }))
  expect(server.snapshots.a.schemaRevision).toBe(11)
  return { local, server, request }
}
async function superseded(request: ReturnType<ReturnType<typeof saveWeightConfigThunk>>, committed: 'confirmed' | 'unknown') {
  const action = await request
  expect(saveWeightConfigThunk.rejected.match(action)).toBe(true)
  expect(action.payload).toEqual({ code: 'CODEBOOK_WEIGHT_SUPERSEDED', committed })
  await expect(request.unwrap()).rejects.toEqual(action.payload)
}

it.each(['finish', 'fail', 'abort'] as const)('protects B and its pending weight owner from old A %s', async outcome => {
  const { local, server, request } = start()
  install(local, server.snapshots.b)
  const newer = local.dispatch(saveWeightConfigThunk({ weightConfig: weight('b-w2'), surveyDesign: design('b-w2') }))
  const before = local.getState()
  if (outcome === 'abort') { request.abort(); await expect(request.unwrap()).rejects.toMatchObject({ name: 'AbortError' }) }
  else { server.pending[0][outcome](); await superseded(request, outcome === 'finish' ? 'confirmed' : 'unknown') }
  expect(local.getState()).toBe(before)
  server.pending[1].finish(); await newer.unwrap()
  expect(local.getState().codebook).toMatchObject({ isWeightSaving: false, weightNeedsRefresh: false, schemaRevision: 11 })
})

it.each(['finish', 'fail', 'abort'] as const)('protects A→B→canonical A and a newer weight write on old %s', async outcome => {
  const { local, server, request } = start()
  install(local, server.snapshots.b); install(local, server.snapshots.a)
  local.dispatch(weightColumnSet({ columnId: 'a-w2' }))
  const newer = local.dispatch(saveWeightConfigThunk({ weightConfig: weight('a-w2'), surveyDesign: design('a-w2') }))
  const before = local.getState()
  if (outcome === 'abort') { request.abort(); await request }
  else { server.pending[0][outcome](); await superseded(request, outcome === 'finish' ? 'confirmed' : 'unknown') }
  expect(local.getState()).toBe(before)
  server.pending[1].finish(); await newer.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 12, weightConfig: weight('a-w2') })
  expect(local.getState().globalVariables.weightColumnId).toBe('a-w2')
  expect(server.revisions).toEqual([10, 11])
})

it.each(['strataColumnId', 'psuColumnId'] as const)('cannot resurrect a later cleared %s', async key => {
  const local = makeStore(), server = harness()
  install(local, server.snapshots.a)
  const old = local.dispatch(saveWeightConfigThunk({ weightConfig: weight(), surveyDesign: { ...design(), [key]: `a-${key === 'strataColumnId' ? 'strata' : 'psu'}` } }))
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const newer = local.dispatch(saveWeightConfigThunk({ weightConfig: weight(), surveyDesign: design() }))
  server.pending[1].finish(); await newer.unwrap()
  const before = local.getState()
  server.pending[0].finish(); await superseded(old, 'confirmed')
  expect(local.getState()).toBe(before)
  expect(local.getState().codebook.surveyDesign?.[key]).toBeNull()
})

it('accepts current weight with one atomic fanout, retaining drafts, groups, active entities and license', async () => {
  const local = makeStore(), server = harness()
  install(local, server.snapshots.a)
  local.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'a-q' }]))
  local.dispatch(weightColumnSet({ columnId: 'a-w2' }))
  local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'Unsaved label' } }))
  local.dispatch(draftMultiResponseGroupUpdated({ group: { groupId: 'g', label: 'Unsaved group', selectedCodes: ['1'],
    unselectedCodes: ['0'], allUnselectedMeaning: 'valid', maxSelections: null, optionOrder: ['a-q'] }, columnIds: ['a-q'] }))
  const request = local.dispatch(saveWeightConfigThunk({ weightConfig: weight(), surveyDesign: design() }))
  local.dispatch(licenseMetadataReceived({ datasetId: 'a', licenseText: 'Newest license', licenseRevision: 4 }))
  const before = local.getState()
  server.pending[0].finish(); await request.unwrap()
  const after = local.getState()
  expect(after.codebook).toMatchObject({ schemaRevision: 11, weightConfig: weight(), surveyDesign: design(), isWeightSaving: false,
    weightNeedsRefresh: false, weightRequestId: request.requestId, hasChanges: true, licenseText: 'Newest license', licenseRevision: 4 })
  expect(after.codebook.columns).toEqual(before.codebook.columns)
  expect(after.codebook.draftColumns).toEqual(before.codebook.draftColumns)
  expect(after.codebook.draftMultiResponseGroups).toEqual(before.codebook.draftMultiResponseGroups)
  expect(after.globalVariables.activeEntities).toEqual(before.globalVariables.activeEntities)
  expect(after.globalVariables.weightColumnId).toBe('a-w1')
  expect(local.actions.filter(codebookWeightAccepted.match)).toHaveLength(1)
})

it.each([['a-w3'], [null], ['a-w3', 'a-w2'], [null, 'a-w2'], ['a-w2']].map(choices => ({ choices })))('protects explicit common-weight intent $choices', async ({ choices }) => {
  const { local, server, request } = start()
  const generation = local.getState().globalVariables.weightSelectionRevision
  for (const id of choices) local.dispatch(id === null ? weightColumnCleared() : weightColumnSet({ columnId: id }))
  expect(local.getState().globalVariables.weightSelectionRevision).toBeGreaterThan(generation)
  server.pending[0].finish(); await request.unwrap()
  expect(local.getState().globalVariables.weightColumnId).toBe(choices.at(-1))
  expect(local.getState().codebook.weightConfig).toEqual(weight())
})

it.each(['initialize', 'restore'] as const)('never replays captured intent generation through %s roundtrips', async kind => {
  const { local, server, request } = start()
  const initial = clone(local.getState().globalVariables)
  local.dispatch(weightColumnSet({ columnId: 'a-w3' }))
  if (kind === 'initialize') { initialize(local, server.snapshots.a); local.dispatch(weightColumnSet({ columnId: 'a-w2' })) }
  else local.dispatch(analysisWorkspaceRestored({ datasetId: 'a', dataRevision: 7, schemaRevision: 10,
    globalVariables: initial, globalObservations: {} as any, workspaceVersion: 1, activeRowIds: ['r1', 'r2'], selectedRowIds: [], groups: [] }))
  expect(local.getState().globalVariables.weightSelectionRevision).toBeGreaterThan(initial.weightSelectionRevision)
  server.pending[0].finish(); await request.unwrap()
  expect(local.getState().globalVariables.weightColumnId).toBe('a-w2')
})

it('keeps explicit null before submission unweighted', async () => {
  const local = makeStore(), server = harness(); install(local, server.snapshots.a)
  const request = local.dispatch(saveWeightConfigThunk({ weightConfig: weight() }))
  server.pending[0].finish(); await request.unwrap()
  expect(local.getState().globalVariables.weightColumnId).toBeNull()
})

it('lets its own canonical read acknowledge a committed write before response delivery', async () => {
  const { local, server, request } = start()
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 11, isWeightSaving: false, weightRequestId: request.requestId })
  server.pending[0].finish(); await expect(request.unwrap()).resolves.toMatchObject({ schemaRevision: 11 })
  expect(local.getState().globalVariables.weightColumnId).toBe('a-w1')
})

it.each(['baseline', 'own'] as const)('rejects old weight after a changed read and %s snapshot roundtrip', async roundtrip => {
  const { local, server, request } = start()
  const original = book('a'), own = clone(server.snapshots.a)
  server.snapshots.a = { ...own, schemaRevision: 12, weightConfig: weight('a-w3') }
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  server.snapshots.a = roundtrip === 'baseline' ? original : own
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const before = local.getState()
  server.pending[0].finish(); await superseded(request, 'confirmed')
  expect(local.getState()).toBe(before)
})

it.each(['finish', 'fail', 'abort'] as const)('data revision changes detach old %s without a recovery lock', async outcome => {
  const { local, server, request } = start()
  local.dispatch(datasetValuesUpdated({ datasetId: 'a', dataRevision: 8 }))
  const before = local.getState()
  if (outcome === 'abort') { request.abort(); await request }
  else { server.pending[0][outcome](); await superseded(request, outcome === 'finish' ? 'confirmed' : 'unknown') }
  expect(local.getState()).toBe(before)
  expect(local.getState().codebook).toMatchObject({ isWeightSaving: false, weightNeedsRefresh: false })
})

it('ignores older or foreign data-revision notifications', async () => {
  const { local, server, request } = start()
  local.dispatch(datasetValuesUpdated({ datasetId: 'a', dataRevision: 7 }))
  local.dispatch(datasetValuesUpdated({ datasetId: 'b', dataRevision: 99 }))
  expect(local.getState().codebook.weightRequestId).toBe(request.requestId)
  server.pending[0].finish(); await request.unwrap()
})

it('rejects duplicate requests before another PUT or busy-owner replacement', async () => {
  const { local, server, request } = start(), before = local.getState()
  const duplicate = local.dispatch(saveWeightConfigThunk({ weightConfig: weight('a-w2') }))
  const action = await duplicate
  expect(saveWeightConfigThunk.rejected.match(action) && action.meta.condition).toBe(true)
  await expect(duplicate.unwrap()).rejects.toMatchObject({ name: 'ConditionError' })
  expect(api.put).toHaveBeenCalledTimes(1); expect(local.getState()).toBe(before)
  server.pending[0].finish(); await request.unwrap()
})

it.each(['fail', 'abort'] as const)('requires a new canonical read after current uncertain %s, never repeats its PUT', async outcome => {
  const { local, server, request } = start()
  const oldRead = deferred<any>()
  vi.mocked(api.get).mockReturnValueOnce(oldRead.promise)
  const obsoleteRefresh = local.dispatch(fetchCodebookThunk('a'))
  if (outcome === 'abort') { request.abort(); await expect(request.unwrap()).rejects.toMatchObject({ name: 'AbortError' }) }
  else { server.pending[0].fail(); await expect(request.unwrap()).rejects.toMatchObject({ message: 'response lost after commit' }) }
  expect(local.getState().codebook).toMatchObject({ isWeightSaving: false, weightNeedsRefresh: true })
  oldRead.resolve(book('a')); await obsoleteRefresh
  expect(local.getState().codebook.weightNeedsRefresh).toBe(true)
  const skipped = await local.dispatch(saveWeightConfigThunk({ weightConfig: weight('a-w2') }))
  expect(saveWeightConfigThunk.rejected.match(skipped) && skipped.meta.condition).toBe(true)
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(api.put).toHaveBeenCalledTimes(1)
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 11, weightConfig: weight(), weightNeedsRefresh: false })
  const next = local.dispatch(saveWeightConfigThunk({ weightConfig: weight('a-w2') }))
  server.pending[1].finish(); await next.unwrap()
  expect(server.revisions).toEqual([10, 11])
})

it('keeps the recovery lock when canonical GET fails, then releases it on a successful read', async () => {
  const { local, server, request } = start()
  server.pending[0].fail(); await request
  vi.mocked(api.get).mockRejectedValueOnce(new Error('offline'))
  await local.dispatch(fetchCodebookThunk('a'))
  expect(local.getState().codebook).toMatchObject({ weightNeedsRefresh: true, isLoading: false })
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  expect(local.getState().codebook.weightNeedsRefresh).toBe(false)
  expect(api.put).toHaveBeenCalledTimes(1)
})

it('handles a real CAS conflict with a canonical read and an explicit retry', async () => {
  const local = makeStore(), server = harness(); install(local, server.snapshots.a)
  local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'Editor commit' } }))
  const editor = local.dispatch(saveCodebookThunk()) // server=11, displayed=10
  const conflict = local.dispatch(saveWeightConfigThunk({ weightConfig: weight() }))
  await expect(conflict.unwrap()).rejects.toMatchObject({ code: 'ANALYSIS_INPUT_STALE' })
  expect(local.getState().codebook.weightNeedsRefresh).toBe(true)
  expect(server.pending).toHaveLength(1)
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const retry = local.dispatch(saveWeightConfigThunk({ weightConfig: weight() }))
  const pendingOwner = local.getState().codebook.weightRequestId
  server.pending[0].finish(); await editor.unwrap()
  expect(local.getState().codebook).toMatchObject({ weightRequestId: pendingOwner, isWeightSaving: true })
  server.pending[1].finish(); await retry.unwrap()
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 12, weightNeedsRefresh: false })
  expect(server.revisions).toEqual([10, 11])
})

it.each(['pending', 'complete'] as const)('old weight cannot settle the newer %s editor Save', async phase => {
  const { local, server, request } = start()
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'New editor commit' } }))
  const editor = local.dispatch(saveCodebookThunk())
  if (phase === 'complete') { server.pending[1].finish(); await editor.unwrap() }
  const before = local.getState()
  server.pending[0].finish()
  if (phase === 'pending') await request.unwrap() // Own canonical snapshot, legitimately accepted.
  else await superseded(request, 'confirmed')
  expect(local.getState().codebook.saveRequestId).toBe(editor.requestId)
  expect(local.getState().codebook.isSaving).toBe(phase === 'pending')
  expect(local.getState().codebook.draftColumns).toEqual(before.codebook.draftColumns)
  if (phase === 'pending') { server.pending[1].finish(); await editor.unwrap() }
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 12, isSaving: false })
  expect(local.getState().codebook.columns[0].label).toBe('New editor commit')
})

it('retires an older editor receipt at weight acceptance even after later matching Undo reads', async () => {
  const local = makeStore(), server = harness(); install(local, server.snapshots.a)
  local.dispatch(draftColumnUpdated({ columnId: 'a-q', patch: { label: 'Old editor commit' } }))
  const editor = local.dispatch(saveCodebookThunk())
  const editorSnapshot = clone(server.snapshots.a)
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const request = local.dispatch(saveWeightConfigThunk({ weightConfig: weight() }))
  server.pending[1].finish(); await request.unwrap()
  expect(local.getState().codebook.saveRequestId).toBeNull()
  server.snapshots.a = editorSnapshot // Canonical lower-revision Undo remains installable.
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const before = local.getState()
  expect(before.codebook.schemaRevision).toBe(11)
  server.pending[0].finish()
  expect((await editor).payload).toEqual({ code: 'CODEBOOK_SAVE_SUPERSEDED', committed: 'confirmed' })
  expect(local.getState()).toBe(before)
})

it.each(['pending', 'failed'] as const)('old editor canonical acknowledgment preserves a newer %s weight owner', async phase => {
  const local = makeStore(), server = harness(); install(local, server.snapshots.a)
  const editor = local.dispatch(saveCodebookThunk())
  await local.dispatch(fetchCodebookThunk('a')).unwrap()
  const request = local.dispatch(saveWeightConfigThunk({ weightConfig: weight() }))
  if (phase === 'failed') { server.pending[1].fail(); await request }
  const before = local.getState().codebook
  server.pending[0].finish(); await editor.unwrap()
  expect(local.getState().codebook).toMatchObject({ weightRequestId: request.requestId,
    isWeightSaving: before.isWeightSaving, weightNeedsRefresh: before.weightNeedsRefresh,
    weightSnapshotAdvanced: before.weightSnapshotAdvanced })
  if (phase === 'pending') { server.pending[1].finish(); await request.unwrap() }
  else { await local.dispatch(fetchCodebookThunk('a')).unwrap() }
  expect(local.getState().codebook.schemaRevision).toBe(12)
})

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('keeps accepted fanout atomic across installation at microtask depth %s', async depth => {
  const { local, server, request } = start()
  server.pending[0].finish()
  for (let index = 0; index < depth; index++) await Promise.resolve()
  install(local, { ...server.snapshots.a, schemaRevision: 12, weightConfig: weight('a-w2'), surveyDesign: design('a-w2') })
  local.dispatch(weightColumnSet({ columnId: 'a-w3' }))
  const before = local.getState(), count = local.actions.filter(codebookWeightAccepted.match).length
  await request
  expect(local.getState()).toBe(before)
  expect(local.actions.filter(codebookWeightAccepted.match)).toHaveLength(count)
  if (!count) await superseded(request, 'confirmed')
})

it('delayed fulfilled acknowledgments cannot mutate any consumer', async () => {
  const { local, server, request } = start()
  server.pending[0].finish(); const result = await request.unwrap()
  install(local, server.snapshots.b)
  const before = local.getState()
  local.dispatch(saveWeightConfigThunk.fulfilled(result, request.requestId, { weightConfig: weight() }))
  expect(local.getState()).toBe(before)
})
