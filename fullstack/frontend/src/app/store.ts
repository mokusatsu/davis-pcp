import { configureStore, createSelector, createSlice, PayloadAction } from '@reduxjs/toolkit'
import { entityKey, reconcileEntities, variableCatalog, type VariableEntity } from '../features/selection/variableEntities'

export interface GroupDef {
  groupId: string
  name: string
  rowIds: string[]
  color: string
  source: string
  evidenceClass: string
}

export interface ClusterResult {
  resultId: string
  method: string
  k: number
  evidenceClass: string
  rowIds: string[]
  labels: number[]
  diagnostics: Record<string, unknown>
  linkageMatrix: number[][] | null
  silhouette?: { byRow: number[]; mean: number; byCluster: { label: number; mean: number; count: number }[] } | null
  pcaProjection?: { pc1: number[]; pc2: number[]; varianceRatio: number[] } | null
  conceptTree?: any | null
  categoryMatrices?: Record<string, Record<string, { categories: string[]; matrix: number[][] }>> | null
}

export interface SelectionState {
  datasetId: string | null
  datasetName: string
  revision: number
  dataRevision: number
  allRowIds: string[]
  activeRowIds: string[]
  /** Derived O(1) membership set over activeRowIds (kept in sync by reducers). */
  activeRowIdSet: Set<string>
  selectedRowIds: string[]
  hiddenRowIds: string[]
  hoveredRowId: string | null
  identifiedRowId: string | null
  groups: GroupDef[]
  clusterResult: ClusterResult | null
  /** L2 color-coding (analysis groups) enabled. Groups come from Clusters etc.;
   *  per AGENTS.md the render settings only offer enable/disable, not creation. */
  l2ColorEnabled: boolean
  /** Statistics page scope: active rows or selected rows only. */
  statsScope: 'active' | 'selected'
  /** Persisted Models result so switching tabs doesn't lose it. */
  modelResult: unknown | null
  history: { label: string; at: string }[]
  futureCount: number
}

const initialState: SelectionState = {
  datasetId: null,
  datasetName: '',
  revision: 0,
  dataRevision: 1,
  allRowIds: [],
  activeRowIds: [],
  activeRowIdSet: new Set<string>(),
  selectedRowIds: [],
  hiddenRowIds: [],
  hoveredRowId: null,
  identifiedRowId: null,
  groups: [],
  clusterResult: null,
  l2ColorEnabled: false,
  statsScope: 'active',
  modelResult: null,
  history: [],
  futureCount: 0,
}

const selectionSlice = createSlice({
  name: 'selection',
  initialState,
  reducers: {
    datasetValuesUpdated(state, action: PayloadAction<{ datasetId: string; dataRevision: number }>) {
      if (state.datasetId !== action.payload.datasetId || action.payload.dataRevision <= state.dataRevision) return
      state.dataRevision = action.payload.dataRevision
    },
    datasetLoaded(state, action: PayloadAction<{ datasetId: string; name: string; rowIds: string[]; dataRevision?: number }>) {
      state.datasetId = action.payload.datasetId
      state.datasetName = action.payload.name
      state.revision = (state.revision || 0) + 1
      state.dataRevision = action.payload.dataRevision ?? 1
      state.allRowIds = action.payload.rowIds
      state.activeRowIds = action.payload.rowIds
      state.activeRowIdSet = new Set(action.payload.rowIds)
      state.selectedRowIds = []
      state.hiddenRowIds = []
      state.groups = []
      state.clusterResult = null
      state.modelResult = null
      state.l2ColorEnabled = false
      state.statsScope = 'active'
      state.history = []
      state.futureCount = 0
    },
    selectionApplied(state, action: PayloadAction<{ rowIds: string[]; operation: 'add' | 'replace' | 'subtract' | 'toggle'; label: string }>) {
      const { rowIds, operation, label } = action.payload
      const hits = new Set(rowIds.filter((id) => state.activeRowIds.includes(id)))
      const current = new Set(state.selectedRowIds)
      if (operation === 'replace') state.selectedRowIds = [...hits]
      else if (operation === 'add') hits.forEach((id) => current.add(id))
      else if (operation === 'subtract') hits.forEach((id) => current.delete(id))
      else hits.forEach((id) => (current.has(id) ? current.delete(id) : current.add(id)))
      if (operation !== 'replace') state.selectedRowIds = [...current]
      state.history.unshift({ label: `${label}（${hits.size}行）`, at: new Date().toISOString() })
      state.futureCount = 0
    },
    selectionCleared(state) {
      state.selectedRowIds = []
      state.history.unshift({ label: '選択を解除', at: new Date().toISOString() })
    },
    hovered(state, action: PayloadAction<string | null>) {
      state.hoveredRowId = action.payload
    },
    focusSelected(state) {
      const selected = new Set(state.selectedRowIds)
      state.activeRowIds = state.activeRowIds.filter((id) => selected.has(id))
      state.activeRowIdSet = new Set(state.activeRowIds)
      state.history.unshift({ label: `Focus selected（${selected.size}行）`, at: new Date().toISOString() })
    },
    deleteSelected(state) {
      const selected = new Set(state.selectedRowIds)
      state.activeRowIds = state.activeRowIds.filter((id) => !selected.has(id))
      state.activeRowIdSet = new Set(state.activeRowIds)
      state.selectedRowIds = []
      state.history.unshift({ label: 'Delete selected', at: new Date().toISOString() })
    },
    resetWorkingSet(state) {
      state.activeRowIds = [...state.allRowIds]
      state.activeRowIdSet = new Set(state.activeRowIds)
      state.selectedRowIds = []
      state.history.unshift({ label: 'Reset to Base Data', at: new Date().toISOString() })
    },
    groupsReplaced(state, action: PayloadAction<GroupDef[]>) {
      state.groups = action.payload
      // Groups exist now; enabling L2 is the natural default (disable-only rule).
      if (action.payload.length) state.l2ColorEnabled = true
    },
    l2ColorToggled(state, action: PayloadAction<boolean>) {
      state.l2ColorEnabled = action.payload
    },
    statsScopeSet(state, action: PayloadAction<'active' | 'selected'>) {
      state.statsScope = action.payload
    },
    modelResultStored(state, action: PayloadAction<unknown>) {
      state.modelResult = action.payload
    },
    clusterResultStored(state, action: PayloadAction<ClusterResult>) {
      state.clusterResult = action.payload
    },
    undoDone(state, action: PayloadAction<{ label: string }>) {
      state.history.unshift({ label: action.payload.label, at: new Date().toISOString() })
    },
  },
})

export const {
  datasetLoaded, datasetValuesUpdated, selectionApplied, selectionCleared, hovered,
  focusSelected, deleteSelected, resetWorkingSet, groupsReplaced, clusterResultStored, l2ColorToggled, statsScopeSet, modelResultStored, undoDone,
} = selectionSlice.actions

export interface PcpState {
  maAxes?: import('../api/client').MaDisplayAxis[]
  orientation: 'horizontal' | 'vertical'
  orderMode: string
  order: string[]
  visibleColumns: string[]
  reversed: Record<string, boolean>
  jitterEnabled: boolean
  jitterMode: 'pixel' | 'legacyRaw'
  jitterAmount: number
  jitterSeed: number
  hitMode: 'legacyVertex' | 'segment'
  brushOperation: 'add' | 'replace' | 'subtract' | 'toggle'
  showContext: boolean
  /** Row coloring: null = single context hue; a categorical column name = color by that column. */
  colorBy: string | null
  highQuality: boolean
  lineOpacity: number
  lineWidth: number
  /** K-Medoids draw simplification: cluster representatives only (>500 rows). */
  simplifyMode: 'kmedoids' | 'off'
}

const initialPcp: PcpState = {
  orientation: 'horizontal',
  orderMode: 'database',
  order: [],
  visibleColumns: [],
  reversed: {},
  jitterEnabled: false,
  jitterMode: 'pixel',
  jitterAmount: 6,
  jitterSeed: 20020801,
  hitMode: 'legacyVertex',
  brushOperation: 'add',
  showContext: true,
  colorBy: null,
  highQuality: true,
  lineOpacity: 0.22,
  lineWidth: 1,
  simplifyMode: 'kmedoids',
}

const pcpSlice = createSlice({
  name: 'pcp',
  initialState: initialPcp,
  reducers: {
    pcpStateChanged(state, action: PayloadAction<Partial<PcpState>>) {
      return { ...state, ...action.payload }
    },
  },
})

export const { pcpStateChanged } = pcpSlice.actions

export interface VariableMetaItem {
  columnId?: string
  name: string
  semanticType: 'numeric' | 'nominal' | 'ordinal' | 'text' | 'categorical' | 'identifier' | 'label' | 'ignored'
  physicalType: string
  missingCount: number
  isTargetCandidate: boolean
}

export interface GlobalVariableState {
  datasetId: string | null
  allVariables: string[]
  activeEntities: VariableEntity[] | null
  variableOrder: string[]
  targetVariableId: string | null
  variableMeta: Record<string, VariableMetaItem>
  /** Survey weight column (columnId) for the active dataset. Null = unweighted. */
  weightColumnId: string | null
}

const initialGlobalVariables: GlobalVariableState = {
  datasetId: null,
  allVariables: [],
  activeEntities: null,
  variableOrder: [],
  targetVariableId: null,
  variableMeta: {},
  weightColumnId: null,
}

export const globalVariablesSlice = createSlice({
  name: 'globalVariables',
  initialState: initialGlobalVariables,
  reducers: {
    variablesInitialized(
      state,
      action: PayloadAction<{ variables: string[]; meta?: Record<string, VariableMetaItem>; target?: string | null; datasetId?: string }>
    ) {
      if (state.datasetId && action.payload.datasetId && state.datasetId !== action.payload.datasetId) {
        state.weightColumnId = null
      }
      state.allVariables = action.payload.variables
      state.datasetId = action.payload.datasetId ?? null
      state.activeEntities = action.payload.variables.map(name => ({ kind: 'column', columnId: action.payload.meta?.[name]?.columnId ?? name }))
      state.variableOrder = action.payload.variables
      state.variableMeta = action.payload.meta ?? {}
      state.targetVariableId = action.payload.target ?? null
    },
    activeVariablesSet(state, action: PayloadAction<string[]>) {
      const allowed = new Set(state.allVariables)
      state.activeEntities = action.payload.filter((id) => allowed.has(id)).map(name => ({ kind: 'column', columnId: state.variableMeta[name]?.columnId ?? name }))
    },
    activeEntitiesSet(state, action: PayloadAction<VariableEntity[]>) {
      state.activeEntities = action.payload
    },
    variableToggled(state, action: PayloadAction<string>) {
      const id = action.payload
      const columnId = state.variableMeta[id]?.columnId ?? id
      if (state.activeEntities?.some(entity => entity.kind === 'column' && entity.columnId === columnId)) {
        state.activeEntities = state.activeEntities.filter(entity => entity.kind !== 'column' || entity.columnId !== columnId)
      } else if (state.allVariables.includes(id)) {
        state.activeEntities = [...(state.activeEntities ?? []), { kind: 'column', columnId }]
      }
    },
    variableOrderReordered(state, action: PayloadAction<string[]>) {
      state.variableOrder = action.payload
    },
    targetVariableSet(state, action: PayloadAction<string | null>) {
      state.targetVariableId = action.payload
    },
    weightColumnSet(state, action: PayloadAction<{ columnId: string | null; datasetId?: string }>) {
      if (action.payload.datasetId && state.datasetId && action.payload.datasetId !== state.datasetId) return
      state.weightColumnId = action.payload.columnId
    },
    weightColumnCleared(state) {
      state.weightColumnId = null
    },
  },
  extraReducers: builder => {
    for (const thunk of [fetchCodebookThunk, saveCodebookThunk]) {
      builder.addCase(thunk.fulfilled, (state, action) => {
        if (state.datasetId && state.datasetId !== action.payload.datasetId) return
        state.activeEntities = reconcileEntities(state.activeEntities, action.payload.columns, action.payload.multiResponseGroups ?? [])
        const ids = new Set((action.payload.columns ?? []).map((c: { columnId: string }) => c.columnId))
        if (state.weightColumnId && !ids.has(state.weightColumnId)) state.weightColumnId = null
      })
    }
  },
})

export const {
  variablesInitialized,
  activeVariablesSet,
  activeEntitiesSet,
  variableToggled,
  variableOrderReordered,
  targetVariableSet,
  weightColumnSet,
  weightColumnCleared,
} = globalVariablesSlice.actions

/** Ordinary analysis candidates never implicitly expand a selected MA parent. */
export const selectOrdinaryVariables = createSelector(
  [(state: RootState) => state.globalVariables, (state: RootState) => state.codebook.columns],
  (variables, columns) => {
    const ordinary = columns.filter(column => !column.multiResponseGroup)
    const selected = variables.activeEntities === null ? null : new Set(variables.activeEntities.filter(entity => entity.kind === 'column').map(entity => entity.columnId))
    return { ...variables,
      allVariables: ordinary.map(column => column.name),
      activeVariableIds: ordinary.filter(column => selected === null || selected.has(column.columnId)).map(column => column.name),
    }
  },
)

export const selectVariableEntities = createSelector(
  [(state: RootState) => state.globalVariables, (state: RootState) => state.codebook],
  (variables, codebook) => {
    const items = variableCatalog(codebook.columns, codebook.multiResponseGroups)
    const selected = new Set((variables.activeEntities ?? items.map(item => item.entity)).map(entityKey))
    const order = new Map([...selected].map((key, index) => [key, index]))
    items.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity))
    return { items, selected }
  },
)

export const selectVariableManagerState = createSelector(
  [selectVariableEntities, (state: RootState) => state.globalVariables.activeEntities],
  ({ items, selected }, activeEntities) => {
    const allVariables = items.map(item => item.key)
    const activeVariableIds = activeEntities === null ? allVariables : activeEntities.map(entityKey).filter(key => selected.has(key) && allVariables.includes(key))
    return {
      allVariables, activeVariableIds, variableOrder: [...activeVariableIds, ...allVariables.filter(key => !selected.has(key))],
      variableMeta: Object.fromEntries(items.map(item => [item.key, { ...item,
        semanticType: ['interval', 'ratio'].includes(item.scaleType) ? 'numeric' : 'categorical' }])),
    }
  },
)

export interface SamplingConfig {
  enabled: boolean
  method: 'without_replacement' | 'with_replacement'
  mode: 'count' | 'ratio'
  size: number
  ratio: number
  seed?: number
  sampledRowIds: string[]
  sampledRowWeights: Record<string, number>
}

export interface GlobalObservationState {
  totalRowIds: string[]
  activeRowIds: string[]
  selectedRowIds: string[]
  scopeMode: 'active' | 'selected' | 'sampled' | 'all'
  sampling: SamplingConfig
  rangeSelection?: { from: number; to: number }
}

const initialSampling: SamplingConfig = {
  enabled: false,
  method: 'without_replacement',
  mode: 'count',
  size: 50,
  ratio: 0.3,
  seed: 42,
  sampledRowIds: [],
  sampledRowWeights: {},
}

const initialGlobalObservations: GlobalObservationState = {
  totalRowIds: [],
  activeRowIds: [],
  selectedRowIds: [],
  scopeMode: 'active',
  sampling: initialSampling,
  rangeSelection: undefined,
}

export const globalObservationsSlice = createSlice({
  name: 'globalObservations',
  initialState: initialGlobalObservations,
  reducers: {
    observationScopeChanged(state, action: PayloadAction<'active' | 'selected' | 'sampled' | 'all'>) {
      state.scopeMode = action.payload
    },
    samplingApplied(
      state,
      action: PayloadAction<
        Partial<SamplingConfig> & { sampledRowIds: string[]; sampledRowWeights?: Record<string, number> }
      >
    ) {
      const weights =
        action.payload.sampledRowWeights ??
        Object.fromEntries(action.payload.sampledRowIds.map((id) => [id, 1]))
      state.sampling = {
        ...state.sampling,
        ...action.payload,
        enabled: true,
        sampledRowWeights: weights,
      }
      state.scopeMode = 'sampled'
    },
    samplingCleared(state) {
      state.sampling.enabled = false
      state.sampling.sampledRowIds = []
      state.sampling.sampledRowWeights = {}
      if (state.scopeMode === 'sampled') {
        state.scopeMode = 'active'
      }
    },
    rangeSelectionApplied(
      state,
      action: PayloadAction<{ from: number; to: number; rowIds: string[]; asSelected?: boolean }>
    ) {
      state.rangeSelection = { from: action.payload.from, to: action.payload.to }
      if (action.payload.asSelected) {
        state.selectedRowIds = action.payload.rowIds
      } else {
        state.activeRowIds = action.payload.rowIds
        state.scopeMode = 'active'
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(selectionSlice.actions.datasetLoaded, (state, action) => {
        state.totalRowIds = action.payload.rowIds
        state.activeRowIds = action.payload.rowIds
        state.selectedRowIds = []
        state.scopeMode = 'active'
        state.sampling = initialSampling
        state.rangeSelection = undefined
      })
      .addCase(selectionSlice.actions.selectionApplied, (state, action) => {
        const { rowIds, operation } = action.payload
        const hits = new Set(rowIds.filter((id) => state.activeRowIds.includes(id)))
        const current = new Set(state.selectedRowIds)
        if (operation === 'replace') state.selectedRowIds = [...hits]
        else if (operation === 'add') hits.forEach((id) => current.add(id))
        else if (operation === 'subtract') hits.forEach((id) => current.delete(id))
        else hits.forEach((id) => (current.has(id) ? current.delete(id) : current.add(id)))
        if (operation !== 'replace') state.selectedRowIds = [...current]
      })
      .addCase(selectionSlice.actions.selectionCleared, (state) => {
        state.selectedRowIds = []
      })
      .addCase(selectionSlice.actions.focusSelected, (state) => {
        const selected = new Set(state.selectedRowIds)
        state.activeRowIds = state.activeRowIds.filter((id) => selected.has(id))
      })
      .addCase(selectionSlice.actions.deleteSelected, (state) => {
        const selected = new Set(state.selectedRowIds)
        state.activeRowIds = state.activeRowIds.filter((id) => !selected.has(id))
        state.selectedRowIds = []
      })
      .addCase(selectionSlice.actions.resetWorkingSet, (state) => {
        state.activeRowIds = [...state.totalRowIds]
        state.selectedRowIds = []
        state.sampling = initialSampling
        state.scopeMode = 'active'
      })
  },
})

export const {
  observationScopeChanged,
  samplingApplied,
  samplingCleared,
  rangeSelectionApplied,
} = globalObservationsSlice.actions

export function selectEffectiveRowIds(state: RootState): string[] {
  const obs = state.globalObservations
  if (!obs) return state.selection.activeRowIds
  if (obs.scopeMode === 'selected') {
    return obs.selectedRowIds
  }
  if (obs.scopeMode === 'sampled') {
    return obs.sampling.sampledRowIds
  }
  if (obs.scopeMode === 'all') {
    return obs.totalRowIds
  }
  return obs.activeRowIds
}

import { codebookSlice, fetchCodebookThunk, saveCodebookThunk } from '../features/dataset/codebookSlice'

export const store = configureStore({
  reducer: {
    selection: selectionSlice.reducer,
    pcp: pcpSlice.reducer,
    globalVariables: globalVariablesSlice.reducer,
    globalObservations: globalObservationsSlice.reducer,
    codebook: codebookSlice.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredPaths: ['selection.activeRowIdSet'],
      },
    }),
})

// Debug access from the browser console (e2e verification aid).
declare global {
  interface Window {
    __store__?: typeof store
  }
}
if (typeof window !== 'undefined') window.__store__ = store

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
