import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit'

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
    datasetLoaded(state, action: PayloadAction<{ datasetId: string; name: string; rowIds: string[] }>) {
      state.datasetId = action.payload.datasetId
      state.datasetName = action.payload.name
      state.revision = (state.revision || 0) + 1
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
  datasetLoaded, selectionApplied, selectionCleared, hovered,
  focusSelected, deleteSelected, resetWorkingSet, groupsReplaced, clusterResultStored, l2ColorToggled, statsScopeSet, modelResultStored, undoDone,
} = selectionSlice.actions

export interface PcpState {
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
  name: string
  semanticType: 'numeric' | 'nominal' | 'ordinal' | 'text'
  physicalType: string
  missingCount: number
  isTargetCandidate: boolean
}

export interface GlobalVariableState {
  allVariables: string[]
  activeVariableIds: string[]
  variableOrder: string[]
  targetVariableId: string | null
  variableMeta: Record<string, VariableMetaItem>
}

const initialGlobalVariables: GlobalVariableState = {
  allVariables: [],
  activeVariableIds: [],
  variableOrder: [],
  targetVariableId: null,
  variableMeta: {},
}

export const globalVariablesSlice = createSlice({
  name: 'globalVariables',
  initialState: initialGlobalVariables,
  reducers: {
    variablesInitialized(
      state,
      action: PayloadAction<{ variables: string[]; meta?: Record<string, VariableMetaItem>; target?: string | null }>
    ) {
      state.allVariables = action.payload.variables
      state.activeVariableIds = action.payload.variables
      state.variableOrder = action.payload.variables
      state.variableMeta = action.payload.meta ?? {}
      state.targetVariableId = action.payload.target ?? null
    },
    activeVariablesSet(state, action: PayloadAction<string[]>) {
      const allowed = new Set(state.allVariables)
      state.activeVariableIds = action.payload.filter((id) => allowed.has(id))
    },
    variableToggled(state, action: PayloadAction<string>) {
      const id = action.payload
      if (state.activeVariableIds.includes(id)) {
        state.activeVariableIds = state.activeVariableIds.filter((v) => v !== id)
      } else if (state.allVariables.includes(id)) {
        state.activeVariableIds.push(id)
      }
    },
    variableOrderReordered(state, action: PayloadAction<string[]>) {
      state.variableOrder = action.payload
    },
    targetVariableSet(state, action: PayloadAction<string | null>) {
      state.targetVariableId = action.payload
    },
  },
})

export const {
  variablesInitialized,
  activeVariablesSet,
  variableToggled,
  variableOrderReordered,
  targetVariableSet,
} = globalVariablesSlice.actions

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
      const nextScope = action.payload
      if (nextScope === 'selected' && state.selectedRowIds.length === 0) {
        state.scopeMode = 'active'
      } else if (nextScope === 'sampled' && state.sampling.sampledRowIds.length === 0) {
        state.scopeMode = 'active'
      } else {
        state.scopeMode = nextScope
      }
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
        if (state.scopeMode === 'selected') {
          state.scopeMode = 'active'
        }
      })
      .addCase(selectionSlice.actions.focusSelected, (state) => {
        const selected = new Set(state.selectedRowIds)
        state.activeRowIds = state.activeRowIds.filter((id) => selected.has(id))
      })
      .addCase(selectionSlice.actions.deleteSelected, (state) => {
        const selected = new Set(state.selectedRowIds)
        state.activeRowIds = state.activeRowIds.filter((id) => !selected.has(id))
        state.selectedRowIds = []
        if (state.scopeMode === 'selected') {
          state.scopeMode = 'active'
        }
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
    return obs.selectedRowIds.length > 0 ? obs.selectedRowIds : obs.activeRowIds
  }
  if (obs.scopeMode === 'sampled') {
    return obs.sampling.sampledRowIds.length > 0 ? obs.sampling.sampledRowIds : obs.activeRowIds
  }
  if (obs.scopeMode === 'all') {
    return obs.totalRowIds.length > 0 ? obs.totalRowIds : obs.activeRowIds
  }
  return obs.activeRowIds
}

export const store = configureStore({
  reducer: {
    selection: selectionSlice.reducer,
    pcp: pcpSlice.reducer,
    globalVariables: globalVariablesSlice.reducer,
    globalObservations: globalObservationsSlice.reducer,
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
