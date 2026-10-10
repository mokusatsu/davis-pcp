import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { useStore } from 'react-redux'
import { selectEffectiveRowIds, selectOrdinaryVariables, type RootState } from '../../app/store'
import { captureAnalysisRunContext, createScopeSnapshot } from '../selection/analysisScope'
import { runCa, type CAContext } from './caApi'
import {
  registerCaController, type CorrespondenceCompleted, type CorrespondenceConfiguration,
  type CorrespondenceController, type CorrespondenceInspection, type CorrespondenceRunOptions,
  type CorrespondenceSetup,
} from './caControllerBridge'

const initialSetup = (): CorrespondenceSetup => ({ inputKind: 'respondents', rowVar: null, colVar: null,
  rowLabelCol: null, valueCols: [], cellSemantics: 'frequency', ack: false, mapScaling: 'symmetric',
  missingPolicy: 'exclude', weightChoice: 'dataset' })
const failure = (code: string) => Object.assign(new Error(code), { code })
const copy = captureAnalysisRunContext
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
  return value
}
type Store = { getState(): RootState; subscribe(listener: () => void): () => void }
type View = { setup: CorrespondenceSetup; completed: CorrespondenceCompleted | null; submittedKey: string;
  loading: boolean; error: string | null; runVersion: number }

function source(state: RootState) {
  const { selection, codebook, globalObservations } = state
  const ordinary = selectOrdinaryVariables(state)
  const columns = codebook.datasetId === selection.datasetId ? codebook.columns : []
  const active = new Set(ordinary.activeVariableIds)
  const inActive = (name: string) => !ordinary.allVariables.length || active.has(name)
  const option = (c: typeof columns[number]) => ({ value: c.name, label: c.name, name: c.name,
    questionName: c.name, questionText: c.label })
  const categoricalOptions = columns.filter(c => !c.multiResponseGroup
    && ['question', 'attribute'].includes(c.role) && ['nominal', 'ordinal', 'binary'].includes(c.scaleType)
    && inActive(c.name)).map(option)
  const rowLabelOptions = columns.filter(c => !c.multiResponseGroup
    && ['nominal', 'ordinal', 'binary', 'text', 'id'].includes(c.scaleType)).map(option)
  const numericOptions = columns.filter(c => !c.multiResponseGroup
    && ['interval', 'ratio'].includes(c.scaleType) && inActive(c.name)).map(option)
  const scope = globalObservations?.scopeMode ?? 'active'
  const snapshot = createScopeSnapshot(scope, selectEffectiveRowIds(state), selection.datasetId,
    selection.dataRevision, codebook.schemaRevision, scope === 'sampled' ? globalObservations.sampling : undefined)
  const ready = Boolean(selection.datasetId && codebook.datasetId === selection.datasetId
    && !codebook.isLoading && columns.length)
  const identityKey = JSON.stringify([selection.datasetId, selection.revision, selection.dataRevision,
    codebook.datasetId, codebook.schemaRevision, columns, codebook.weightConfig])
  const inputContextKey = JSON.stringify([identityKey, ready, snapshot.scopeKey,
    scope === 'sampled' ? globalObservations.sampling : null, state.globalVariables.activeEntities])
  return { selection, codebook, columns, snapshot, ready, identityKey, inputContextKey,
    categoricalOptions, rowLabelOptions, numericOptions }
}

/** Redux inputs are immutable; hover and editor UI changes must not sort/copy the working set. */
function createSourceReader() {
  let previous: readonly unknown[] | null = null
  let cached: ReturnType<typeof source> | null = null
  return (state: RootState): ReturnType<typeof source> => {
    const { selection, codebook, globalObservations, globalVariables } = state
    const scope = globalObservations?.scopeMode ?? 'active'
    const inputs = [selection.datasetId, selection.revision, selection.dataRevision,
      codebook.datasetId, codebook.schemaRevision, codebook.columns, codebook.weightConfig, codebook.isLoading,
      scope, selectEffectiveRowIds(state), scope === 'sampled' ? globalObservations.sampling : null,
      globalVariables.activeEntities]
    const prior = previous
    if (cached && prior && inputs.every((value, index) => Object.is(value, prior[index]))) return cached
    const next = source(state)
    previous = inputs
    cached = next
    return cached
  }
}

function describe(input: ReturnType<typeof source>, setup: CorrespondenceSetup) {
  const { selection, codebook, snapshot, categoricalOptions, rowLabelOptions, numericOptions } = input
  const effectiveMissing = setup.inputKind === 'contingency' ? 'exclude' : setup.missingPolicy
  const savedWeightColumnId = codebook.weightConfig?.weightColumnId ?? null
  const savedWeightType = codebook.weightConfig?.weightType ?? null
  const weightConflict = setup.inputKind === 'contingency' && setup.weightChoice === 'dataset' && Boolean(savedWeightColumnId)
  const unavailableVariables = setup.inputKind === 'respondents'
    ? [setup.rowVar, setup.colVar].filter((name): name is string => Boolean(name) && !categoricalOptions.some(o => o.value === name))
    : setup.valueCols.filter(name => !numericOptions.some(o => o.value === name))
  const canRun = input.ready && !weightConflict && !unavailableVariables.length && (setup.inputKind === 'respondents'
    ? Boolean(setup.rowVar && setup.colVar && setup.rowVar !== setup.colVar)
    : Boolean(setup.rowLabelCol && rowLabelOptions.some(o => o.value === setup.rowLabelCol)
      && setup.valueCols.length >= 2 && new Set(setup.valueCols).size === setup.valueCols.length
      && !setup.valueCols.includes(setup.rowLabelCol) && (setup.cellSemantics === 'mass' || setup.ack)))
  const context: CAContext = { datasetId: selection.datasetId ?? '', expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: codebook.schemaRevision, ...snapshot.contextRows,
    weightMode: setup.weightChoice, missingPolicy: effectiveMissing }
  const draftKey = JSON.stringify([selection.datasetId, setup.inputKind, setup.rowVar, setup.colVar,
    setup.rowLabelCol, setup.valueCols, setup.cellSemantics, setup.ack, snapshot.scopeKey,
    effectiveMissing, setup.weightChoice, selection.dataRevision, codebook.schemaRevision, unavailableVariables])
  return { effectiveMissing, savedWeightColumnId, savedWeightType, weightConflict, unavailableVariables,
    canRun, context, draftKey }
}

function acknowledgementKey(input: ReturnType<typeof source>, setup: CorrespondenceSetup): string {
  return JSON.stringify([input.inputContextKey, setup.inputKind, setup.rowLabelCol, setup.valueCols,
    setup.cellSemantics, setup.weightChoice, setup.missingPolicy])
}

/** The page and bridge share this single owner; Redux remains the source of data and scope. */
function createController(store: Store) {
  let view: View = { setup: initialSetup(), completed: null, submittedKey: '', loading: false, error: null, runVersion: 0 }
  let live = false, sequence = 0, identityGeneration = 0
  const readSource = createSourceReader()
  let lastSource = readSource(store.getState())
  let acknowledgement: string | null = null
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const update = (patch: Partial<View>) => {
    view = { ...view, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const syncSource = () => {
    const input = readSource(store.getState())
    if (input.inputContextKey === lastSource.inputContextKey) return input
    const datasetChanged = input.selection.datasetId !== lastSource.selection.datasetId
    if (input.identityKey !== lastSource.identityKey) identityGeneration++
    lastSource = input
    let setup = view.setup
    if (datasetChanged) setup = initialSetup()
    else if (setup.ack && acknowledgement !== acknowledgementKey(input, setup)) setup = { ...setup, ack: false }
    if (!setup.ack) acknowledgement = null
    update({ setup, ...(datasetChanged ? { completed: null, submittedKey: '', loading: false, error: null } : {}) })
    return input
  }
  const effectiveSetup = (input: ReturnType<typeof source>) => view.setup.ack
    && acknowledgement !== acknowledgementKey(input, view.setup) ? { ...view.setup, ack: false } : view.setup
  const inspect = (): CorrespondenceInspection => {
    const input = readSource(store.getState()), setup = effectiveSetup(input), details = describe(input, setup)
    return { datasetId: input.selection.datasetId, dataRevision: input.selection.dataRevision,
      schemaRevision: input.codebook.schemaRevision, scopeKey: input.snapshot.scopeKey,
      setup: copy(setup), ready: live && input.ready, canRun: live && details.canRun,
      loading: view.loading, error: view.error,
      completed: view.completed?.result.meta.datasetId === input.selection.datasetId ? view.completed : null,
      draftKey: details.draftKey, inputContextKey: input.inputContextKey }
  }
  const configure = (patch: CorrespondenceConfiguration) => {
    if (!live) throw failure('CA_CONTROLLER_DISPOSED')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure('CA_CONFIGURATION_INVALID')
    const allowed = ['inputKind', 'rowVar', 'colVar', 'rowLabelCol', 'valueCols', 'cellSemantics', 'mapScaling', 'missingPolicy', 'weightChoice']
    if (Object.hasOwn(patch, 'ack') || Object.getOwnPropertySymbols(patch).length
      || Object.getOwnPropertyNames(patch).some(key => !allowed.includes(key))) throw failure('CA_CONFIGURATION_INVALID')
    const input = syncSource()
    const next = { ...effectiveSetup(input), ...copy(patch) }
    if (!['respondents', 'contingency'].includes(next.inputKind)
      || !['frequency', 'mass'].includes(next.cellSemantics)
      || !['symmetric', 'row_principal', 'column_principal'].includes(next.mapScaling)
      || !['exclude', 'include_missing', 'separate_not_applicable'].includes(next.missingPolicy)
      || !['dataset', 'none'].includes(next.weightChoice)) throw failure('CA_CONFIGURATION_INVALID')
    const known = new Set(input.columns.filter(c => !c.multiResponseGroup).map(c => c.name))
    for (const field of ['rowVar', 'colVar', 'rowLabelCol'] as const) {
      if (!Object.hasOwn(patch, field)) continue
      const name = patch[field]
      if (name !== null && (typeof name !== 'string' || !known.has(name))) throw failure('CA_UNKNOWN_COLUMN')
    }
    if (Object.hasOwn(patch, 'valueCols') && (!Array.isArray(next.valueCols)
      || next.valueCols.some(name => typeof name !== 'string' || !known.has(name))
      || new Set(next.valueCols).size !== next.valueCols.length)) throw failure('CA_CONFIGURATION_INVALID')
    if (acknowledgement !== acknowledgementKey(input, next)) { next.ack = false; acknowledgement = null }
    update({ setup: next })
    return inspect()
  }
  /** Only the ordinary page checkbox receives this setter; it is absent from the bridge port. */
  const setAcknowledged = (value: boolean) => {
    const input = syncSource(), setup = effectiveSetup(input)
    const ack = value && setup.inputKind === 'contingency' && setup.cellSemantics === 'frequency'
    acknowledgement = ack ? acknowledgementKey(input, setup) : null
    update({ setup: { ...setup, ack } })
  }
  const run = async (options: CorrespondenceRunOptions = {}): Promise<CorrespondenceCompleted> => {
    if (!live) throw failure('CA_CONTROLLER_DISPOSED')
    if (options.signal?.aborted) throw failure('CANCELLED')
    const input = syncSource(), setup = copy(effectiveSetup(input)), details = describe(input, setup)
    if (!details.canRun) throw failure('CA_INPUT_REQUIRED')
    const context = copy(details.context), snapshot = copy(input.snapshot)
    const request = setup.inputKind === 'respondents'
      ? { kind: 'respondents' as const, rowVariable: setup.rowVar!, columnVariable: setup.colVar! }
      : { kind: 'contingency' as const, rowLabelColumn: setup.rowLabelCol!, valueColumns: setup.valueCols,
          cellSemantics: setup.cellSemantics, independentCountsAcknowledged: setup.cellSemantics === 'frequency' && setup.ack }
    const seq = ++sequence, generation = identityGeneration
    const isCurrent = () => {
      syncSource()
      return live && sequence === seq && identityGeneration === generation && !options.signal?.aborted
        && readSource(store.getState()).ready
    }
    // Flush the shared state, including the page's selection-reset effects, before starting work.
    flushSync(() => update({ loading: true, error: null, runVersion: view.runVersion + 1 }))
    let removeAbort = () => {}
    try {
      const pending = runCa(context, request, setup.mapScaling)
      const result = options.signal ? await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        const abort = () => reject(failure('CANCELLED'))
        options.signal!.addEventListener('abort', abort, { once: true })
        removeAbort = () => options.signal!.removeEventListener('abort', abort)
        if (options.signal!.aborted) abort()
      })]) : await pending
      if (!isCurrent()) throw failure(options.signal?.aborted ? 'CANCELLED' : 'CA_RUN_SUPERSEDED')
      if (result.meta.datasetId !== context.datasetId || result.meta.dataRevision !== context.expectedDataRevision
        || result.meta.schemaRevision !== context.expectedSchemaRevision) throw failure('CA_RUN_SUPERSEDED')
      const completed = freezeSnapshot(copy({ result, context, snapshot }))
      if (options.beforeCommit && !options.beforeCommit(completed)) throw failure('CA_RUN_SUPERSEDED')
      // No await separates the final signal/ownership check from the normal page's committed render.
      if (!isCurrent()) throw failure(options.signal?.aborted ? 'CANCELLED' : 'CA_RUN_SUPERSEDED')
      flushSync(() => update({ completed, submittedKey: details.draftKey, loading: false }))
      return completed
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (isCurrent() && code !== 'CANCELLED' && code !== 'CA_RUN_SUPERSEDED') {
        const text = (error as { message?: string })?.message || '分析に失敗しました。'
        update({ error: code ? `${text}（${code}）` : text })
      }
      throw error
    } finally {
      removeAbort()
      if (live && seq === sequence && view.loading) update({ loading: false })
    }
  }
  const controller: CorrespondenceController = { inspect, configure, run, subscribe }
  return { controller, setAcknowledged, getSnapshot: () => view, subscribe,
    start: () => {
      live = true
      syncSource()
      const unsubscribe = store.subscribe(syncSource)
      const unregister = registerCaController(controller)
      return () => { live = false; sequence++; identityGeneration++; unsubscribe(); unregister() }
    },
    describe: () => { const input = readSource(store.getState()); return { ...input, ...describe(input, effectiveSetup(input)) } },
  }
}

export function useCorrespondenceController() {
  const store = useStore<RootState>()
  const owner = useMemo(() => createController(store), [store])
  const view = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
  useLayoutEffect(() => owner.start(), [owner])
  const inspection = owner.controller.inspect()
  return { ...inspection, ...owner.describe(), controller: owner.controller,
    setAcknowledged: owner.setAcknowledged, runVersion: view.runVersion,
    dirty: Boolean(inspection.completed && view.submittedKey && inspection.draftKey !== view.submittedKey) }
}
