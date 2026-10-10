// SPDX-License-Identifier: GPL-3.0-or-later
// DAVIS host integration for the vendored siwc-bridge page-commands/1 SDK.
import {
  activeEntitiesSet, focusSelected, pcpStateChanged, resetWorkingSet, selectionCleared,
  selectEffectiveRowIds, targetVariableSet, type RootState, type store as appStore,
} from '../../app/store'
import type { CodebookColumn } from '../../api/client'
import { assert, throwIfAborted } from './extension/core/common.js'
import type { CommandDefinition, JSONSchema, JSONValue, OperationContext, PageBridgeOptions } from './sdk/page-bridge.js'

export const DAVIS_ROUTES = [
  'pcp', 'table', 'distribution', 'likert', 'relationships', 'clusters', 'models', 'pca', 'touring',
  'mosaic', 'overview', 'statistics', 'ranking', 'subgroups', 'associations', 'robustness',
  'key-drivers', 'penalty-reward', 'fedf', 'barchart', 'loess', 'covariance', 'logistic', 'discriminant',
  'models/ca', 'models/mca', 'models/famd', 'models/linear-regression', 'models/factor-analysis',
  'models/conjoint', 'crosstab',
] as const

export type DavisStore = Pick<typeof appStore, 'getState' | 'dispatch' | 'subscribe'>
export interface DavisRouterPort {
  getPath(): string
  /** Must notify synchronously on every committed location, including Back/Forward. */
  subscribe(listener: () => void): () => void
  navigate(path: string): void | Promise<void>
}
export interface DavisRevisionMonitor {
  getRevision(): string
  getAnalysisRevision(): string
  assertCurrent(expectedRevision: string): void
  /** Workflow/question changes invalidate transport snapshots, never source bindings. */
  bump(): void
  subscribe(listener: () => void): () => void
  dispose(): void
}
export interface DavisWorkflowPort {
  commands: CommandDefinition[]
  handlers: PageBridgeOptions['handlers']
  /** Only bounded workflow metadata belongs here, never the full result or row payload. */
  getContext(): JSONValue
}
export interface DavisAdapterPorts {
  store: DavisStore
  router: DavisRouterPort
  monitor: DavisRevisionMonitor
  workflow?: DavisWorkflowPort
}

const MAX_COLUMN_ID_LENGTH = 256
const MAX_CONTEXT_COLUMNS = 200
const MAX_CONTEXT_ENTITIES = 200
const idSchema: JSONSchema = { type: 'string', minLength: 1, maxLength: MAX_COLUMN_ID_LENGTH }
const objectSchema = (properties: Record<string, JSONSchema>): JSONSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const emptySchema = objectSchema({})

export const DAVIS_FOUNDATION_COMMANDS: CommandDefinition[] = [
  { name: 'state.inspect', description: '列情報、行数、共通分析対象と表示状態を確認する。個票は返さない。', effect: 'read', inputSchema: emptySchema },
  { name: 'view.navigate', description: '指定した分析・表示画面を開く。画面の移動だけで分析は実行しない。', effect: 'write', inputSchema: objectSchema({ view: { type: 'string', enum: [...DAVIS_ROUTES] } }) },
  { name: 'variables.select', description: '通常の列IDで全体の分析対象変数を選ぶ。複数回答の親や子は選択しない。', effect: 'write', inputSchema: objectSchema({ columnIds: { type: 'array', items: idSchema, minItems: 1, maxItems: 100 } }) },
  { name: 'variables.setTarget', description: '通常の列IDで目的変数を設定する。nullで解除する。', effect: 'write', inputSchema: objectSchema({ columnId: { type: ['string', 'null'], minLength: 1, maxLength: MAX_COLUMN_ID_LENGTH } }) },
  { name: 'selection.clear', description: '行の選択を解除する。共通対象のモードと元データは変更しない。', effect: 'write', inputSchema: emptySchema },
  { name: 'selection.focus', description: '選択行を作業中の行にする。共通対象のモードは保持するため、AllやSampledの分析対象は変わらない。', effect: 'write', inputSchema: emptySchema },
  { name: 'selection.reset', description: '作業中の行を全行に戻す。選択・標本を解除し、共通対象をActiveに戻す。', effect: 'write', inputSchema: emptySchema },
  { name: 'pcp.configure', description: '平行座標表示の向き、文脈線、透明度を設定する。', effect: 'write', inputSchema: objectSchema({
    orientation: { type: 'string', enum: ['horizontal', 'vertical'] }, showContext: { type: 'boolean' },
    lineOpacity: { type: 'number', minimum: 0, maximum: 1 },
  }) },
]

/** Readiness uses canonical state only; unsaved editor drafts are never analytical inputs. */
export function assertDavisCanonicalState(state: RootState): CodebookColumn[] {
  const { selection, codebook, globalVariables } = state
  assert(!!selection.datasetId, 'NO_DATASET')
  assert(codebook.datasetId === selection.datasetId && globalVariables.datasetId === selection.datasetId,
    'DATASET_NOT_READY')
  assert(!codebook.isLoading && !codebook.isSaving && !codebook.isWeightSaving && !codebook.weightNeedsRefresh,
    'CODEBOOK_NOT_READY')
  assert(codebook.columns.length > 0, 'CODEBOOK_NOT_READY')
  assert(new Set(codebook.columns.map(column => column.columnId)).size === codebook.columns.length
    && new Set(codebook.columns.map(column => column.name)).size === codebook.columns.length,
  'AMBIGUOUS_CODEBOOK')
  return codebook.columns
}

export function lookupDavisOrdinaryColumn(state: RootState, columnId: string): CodebookColumn {
  assert(typeof columnId === 'string' && columnId.length > 0 && columnId.length <= MAX_COLUMN_ID_LENGTH, 'INVALID_COLUMN_ID')
  const column = assertDavisCanonicalState(state).find(candidate => candidate.columnId === columnId)
  assert(column, 'UNKNOWN_COLUMN')
  assert(!column.multiResponseGroup, 'ORDINARY_COLUMN_REQUIRED')
  return column
}

/** Arbitrary column names are values in arrays, never dictionary keys. */
export function describeDavisColumn(column: CodebookColumn): Record<string, JSONValue> {
  return {
    columnId: column.columnId, name: column.name.slice(0, 256), label: column.label.slice(0, 512),
    scaleType: column.scaleType, role: column.role,
    multiResponseGroup: column.multiResponseGroup?.slice(0, 256) ?? null,
    ordinary: !column.multiResponseGroup,
    displayTruncated: column.name.length > 256 || column.label.length > 512,
  }
}

/**
 * Redux is immutable. Comparing relevant field identities is synchronous and avoids
 * hashing row arrays on every hover or async acknowledgment. A new canonical
 * installation may conservatively invalidate even if its values are identical.
 */
function analysisProjection(state: RootState): readonly unknown[] {
  const { selection, codebook, globalVariables, globalObservations } = state
  return [
    selection.datasetId, selection.revision, selection.dataRevision, selection.allRowIds,
    codebook.datasetId, codebook.schemaRevision, codebook.columns, codebook.multiResponseGroups,
    codebook.weightConfig, codebook.surveyDesign, codebook.isLoading, codebook.isSaving,
    codebook.isWeightSaving, codebook.weightNeedsRefresh, globalVariables.datasetId,
    globalObservations.scopeMode, selectEffectiveRowIds(state),
    // Includes sample identity, source hashes, replacement multiplicities and revisions.
    // These fields stay local; ordinary analysis inputs use unique row membership.
    globalObservations.scopeMode === 'sampled' ? globalObservations.sampling : null,
  ]
}
function transportProjection(state: RootState, path: string): readonly unknown[] {
  const { selection, globalVariables, globalObservations } = state
  return [
    ...analysisProjection(state), selection.datasetName, selection.activeRowIds, selection.selectedRowIds,
    globalVariables.allVariables, globalVariables.activeEntities, globalVariables.variableOrder,
    globalVariables.targetVariableId, globalVariables.weightColumnId, globalVariables.weightSelectionRevision,
    globalObservations.sampling, state.pcp, path,
  ]
}
const equalProjection = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
let monitorSequence = 0

export function createDavisRevisionMonitor({ store, router }: Pick<DavisAdapterPorts, 'store' | 'router'>): DavisRevisionMonitor {
  const instance = ++monitorSequence
  let revision = 0n, analysisRevision = 0n, disposed = false
  let lastAnalysis = analysisProjection(store.getState())
  let lastTransport = transportProjection(store.getState(), router.getPath())
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of [...listeners]) listener() }
  const refresh = () => {
    if (disposed) return
    const state = store.getState()
    const nextAnalysis = analysisProjection(state)
    const nextTransport = transportProjection(state, router.getPath())
    const analysisChanged = !equalProjection(lastAnalysis, nextAnalysis)
    const transportChanged = !equalProjection(lastTransport, nextTransport)
    // Install both projections before listeners can dispatch or request another snapshot.
    lastAnalysis = nextAnalysis
    lastTransport = nextTransport
    if (analysisChanged) analysisRevision++
    if (transportChanged) { revision++; notify() }
  }
  const unsubscribeStore = store.subscribe(refresh)
  const unsubscribeRouter = router.subscribe(refresh)
  const getRevision = () => { refresh(); return `davis:${instance}:${revision}` }
  return {
    getRevision,
    getAnalysisRevision: () => { refresh(); return `davis-analysis:${instance}:${analysisRevision}` },
    assertCurrent: expectedRevision => {
      assert(!disposed, 'BRIDGE_DISPOSED')
      assert(expectedRevision === getRevision(), 'STALE_STATE')
    },
    bump: () => { assert(!disposed, 'BRIDGE_DISPOSED'); refresh(); revision++; notify() },
    subscribe: listener => {
      assert(!disposed, 'BRIDGE_DISPOSED')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribeStore(); unsubscribeRouter(); listeners.clear()
    },
  }
}

function scopeCounts(state: RootState): Record<string, JSONValue> {
  return {
    activeRowCount: new Set(state.selection.activeRowIds).size,
    selectedRowCount: new Set(state.selection.selectedRowIds).size,
    effectiveScope: state.globalObservations.scopeMode,
    effectiveRowCount: new Set(selectEffectiveRowIds(state)).size,
  }
}

export function createDavisOptions({ store, router, monitor, workflow }: DavisAdapterPorts): PageBridgeOptions {
  const state = () => store.getState()
  const guard = (context: OperationContext) => {
    throwIfAborted(context.signal)
    monitor.assertCurrent(context.expectedRevision)
  }
  const loaded = () => { assert(!!state().selection.datasetId, 'NO_DATASET') }
  const getContext = (): JSONValue => {
    const current = state(), { selection, codebook, globalVariables, pcp } = current
    let canonicalReady = true
    try { assertDavisCanonicalState(current) } catch { canonicalReady = false }
    // Never describe columns or resolve names from the previous dataset during installation.
    const columns = canonicalReady ? codebook.columns : []
    const supportedColumns = columns.filter(column => column.columnId.length > 0 && column.columnId.length <= MAX_COLUMN_ID_LENGTH)
    const visibleColumns = supportedColumns.slice(0, MAX_CONTEXT_COLUMNS)
    const supportedIds = new Set(supportedColumns.map(column => column.columnId))
    const groupIds = new Set(supportedColumns.map(column => column.multiResponseGroup)
      .filter((groupId): groupId is string => !!groupId && groupId.length <= MAX_COLUMN_ID_LENGTH))
    const target = supportedColumns.find(column => column.name === globalVariables.targetVariableId)
    const activeEntities = canonicalReady ? globalVariables.activeEntities : []
    const visibleEntities = activeEntities?.filter(entity => entity.kind === 'column'
      ? supportedIds.has(entity.columnId) : groupIds.has(entity.groupId)).slice(0, MAX_CONTEXT_ENTITIES)
    const safeWeightId = (id: string | null | undefined) => id && supportedIds.has(id) ? id : null
    return {
      dataset: {
        id: selection.datasetId, name: selection.datasetName.slice(0, 512), rowCount: new Set(selection.allRowIds).size,
        ...scopeCounts(current), dataRevision: selection.dataRevision,
        schemaRevision: canonicalReady ? codebook.schemaRevision : null, canonicalReady,
      },
      columns: visibleColumns.map(describeDavisColumn), columnCount: columns.length,
      columnsTruncated: visibleColumns.length !== columns.length,
      activeEntities: visibleEntities === undefined ? null : visibleEntities.map((entity): JSONValue => entity.kind === 'column'
        ? { kind: 'column', columnId: entity.columnId } : { kind: 'ma', groupId: entity.groupId }),
      activeEntitiesTruncated: (activeEntities?.length ?? 0) !== (visibleEntities?.length ?? 0),
      targetVariable: target?.columnId ?? null,
      weight: canonicalReady ? {
        columnId: safeWeightId(globalVariables.weightColumnId),
        savedColumnId: safeWeightId(codebook.weightConfig?.weightColumnId),
        savedType: codebook.weightConfig?.weightType ?? null,
      } : null,
      view: router.getPath(),
      pcp: { orientation: pcp.orientation, showContext: pcp.showContext, lineOpacity: pcp.lineOpacity },
      ...(workflow ? { analysis: { workflow: 'page-workflow/1', availableMethods: ['correspondence'] } } : {}),
    }
  }
  const handlers: PageBridgeOptions['handlers'] = {
    'state.inspect': (_args, context) => { guard(context); return getContext() },
    'view.navigate': async ({ view }, context) => {
      assert(typeof view === 'string' && (DAVIS_ROUTES as readonly string[]).includes(view), 'INVALID_VIEW')
      guard(context)
      await router.navigate('/' + view)
      return { view }
    },
    'variables.select': ({ columnIds }, context) => {
      assert(Array.isArray(columnIds) && columnIds.length >= 1 && columnIds.length <= 100, 'INVALID_COLUMNS')
      assert(new Set(columnIds).size === columnIds.length, 'DUPLICATE_COLUMN')
      const columns = columnIds.map(columnId => {
        assert(typeof columnId === 'string', 'INVALID_COLUMN_ID')
        return lookupDavisOrdinaryColumn(state(), columnId)
      })
      guard(context)
      store.dispatch(activeEntitiesSet(columns.map(column => ({ kind: 'column', columnId: column.columnId }))))
      return { columnIds }
    },
    'variables.setTarget': ({ columnId }, context) => {
      assertDavisCanonicalState(state())
      assert(columnId === null || typeof columnId === 'string', 'INVALID_COLUMN_ID')
      const name = columnId === null ? null : lookupDavisOrdinaryColumn(state(), columnId).name
      guard(context)
      // Despite its historical field name, Redux stores the raw column NAME here.
      store.dispatch(targetVariableSet(name))
      return { columnId }
    },
    'selection.clear': (_args, context) => {
      loaded(); guard(context); store.dispatch(selectionCleared())
      return scopeCounts(state())
    },
    'selection.focus': (_args, context) => {
      loaded()
      assert(state().selection.selectedRowIds.length > 0, 'NO_SELECTED_ROWS')
      guard(context); store.dispatch(focusSelected())
      return scopeCounts(state())
    },
    'selection.reset': (_args, context) => {
      loaded(); guard(context); store.dispatch(resetWorkingSet())
      return scopeCounts(state())
    },
    'pcp.configure': ({ orientation, showContext, lineOpacity }, context) => {
      assert(orientation === 'horizontal' || orientation === 'vertical', 'INVALID_ORIENTATION')
      assert(typeof showContext === 'boolean', 'INVALID_CONTEXT_VISIBILITY')
      assert(typeof lineOpacity === 'number' && Number.isFinite(lineOpacity) && lineOpacity >= 0 && lineOpacity <= 1,
        'INVALID_LINE_OPACITY')
      guard(context)
      const settings = { orientation, showContext, lineOpacity } as const
      store.dispatch(pcpStateChanged(settings))
      return settings
    },
  }
  const commands = [...DAVIS_FOUNDATION_COMMANDS]
  for (const command of workflow?.commands ?? []) {
    assert(['analysis.prepare', 'analysis.resume', 'analysis.run', 'analysis.cancel'].includes(command.name), 'INVALID_WORKFLOW_COMMAND')
    assert(!commands.some(existing => existing.name === command.name), 'DUPLICATE_COMMAND')
    assert(workflow?.handlers[command.name], 'MISSING_HANDLER')
    commands.push(command)
    handlers[command.name] = (args, context) => {
      guard(context)
      return workflow!.handlers[command.name](args, context)
    }
  }
  return {
    appId: 'davis-pcp', appName: 'DAVIS-PCP', commands, handlers, getContext,
    getWorkflow: () => workflow?.getContext() ?? null,
    getRevision: monitor.getRevision, lockName: 'davis-pcp-bridge-operations',
  }
}
