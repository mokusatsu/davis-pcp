import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit'
import { api } from '../../api/client'
import type { RootState } from '../../app/store'

export interface ProvenanceStepSummary {
  operationId: string
  operation: string
  parentOperationId: string | null
  outputDataRevision: number
  timestamp: string
  algorithmVersion: string
  /** Whether the operation is an ancestor of the cursor (2回目のUndoの目印). */
  onCursorPath: boolean
  /** Whether the operation still describes the current data. */
  inEffect: boolean
}

export interface RestoreRefresh {
  requestId: string
  datasetId: string
  datasetRevision: number
  committedRevision: number
  warnings: string[]
  dataRevision: number
  loading: boolean
  error: string | null
}

export interface ProvenanceState {
  datasetId: string | null
  fetchRequestId: string | null
  ready: boolean
  restoreRefresh: RestoreRefresh | null
  dataRevision: number | null
  schemaRevision: number | null
  currentOperationId: string | null
  cursorOperationId: string | null
  canUndo: boolean
  canRedo: boolean
  rawDataRevision: number | null
  maskRevision: number
  steps: ProvenanceStepSummary[]
  maskFilter: 'all' | 'hasImputed' | 'noImputed'
  loading: boolean
  error: string | null
}

const initialState: ProvenanceState = {
  datasetId: null,
  fetchRequestId: null,
  ready: false,
  restoreRefresh: null,
  dataRevision: null,
  schemaRevision: null,
  currentOperationId: null,
  cursorOperationId: null,
  canUndo: false,
  canRedo: false,
  rawDataRevision: null,
  maskRevision: 0,
  steps: [],
  maskFilter: 'all',
  loading: false,
  error: null,
}

export interface ProvenanceResponse {
  datasetId: string
  dataRevision: number
  schemaRevision: number
  currentOperationId: string | null
  cursorOperationId: string | null
  canUndo: boolean
  canRedo: boolean
  rawDataRevision: number | null
  maskRevision: number
  steps: ProvenanceStepSummary[]
}

export function selectRestoreRefresh(state: RootState): RestoreRefresh | null {
  const refresh = state.provenance.restoreRefresh
  return refresh && refresh.datasetId === state.selection.datasetId
    && refresh.datasetRevision === state.selection.revision
    && state.selection.dataRevision <= refresh.dataRevision ? refresh : null
}

/** A history from another dataset or revision must never authorize a restore. */
export function isProvenanceReady(state: RootState): boolean {
  const { selection, codebook, provenance } = state
  const refresh = selectRestoreRefresh(state)
  return !!selection.datasetId && provenance.datasetId === selection.datasetId
    && provenance.ready && !provenance.loading && !provenance.error && !refresh?.loading && !refresh?.error
    && provenance.dataRevision === selection.dataRevision
    && codebook.datasetId === selection.datasetId && !codebook.isLoading
    && provenance.schemaRevision === codebook.schemaRevision
}

export const fetchProvenanceThunk = createAsyncThunk(
  'provenance/fetch',
  async (datasetId: string, { getState, requestId, rejectWithValue }) => {
    const started = getState() as RootState
    const ownsRequest = () => {
      const current = getState() as RootState
      return current.selection.datasetId === datasetId
        && current.selection.revision === started.selection.revision
        && current.selection.dataRevision === started.selection.dataRevision
        && current.codebook.datasetId === started.codebook.datasetId
        && current.codebook.schemaRevision === started.codebook.schemaRevision
        && current.provenance.fetchRequestId === requestId
    }
    let response: ProvenanceResponse
    try { response = await api.get<ProvenanceResponse>(`/datasets/${datasetId}/provenance`) }
    catch (error) {
      if (!ownsRequest()) return rejectWithValue('PROVENANCE_FETCH_SUPERSEDED')
      throw error
    }
    if (!ownsRequest()) return rejectWithValue('PROVENANCE_FETCH_SUPERSEDED')
    if (response.datasetId !== datasetId) throw new Error('来歴のデータセットが一致しません。')
    return response
  },
  { condition: (datasetId, { getState }) => (getState() as RootState).selection.datasetId === datasetId },
)

const provenanceSlice = createSlice({
  name: 'provenance',
  initialState,
  reducers: {
    maskFilterChanged(state, action: PayloadAction<ProvenanceState['maskFilter']>) {
      state.maskFilter = action.payload
    },
    restoreRefreshStarted(state, action: PayloadAction<RestoreRefresh>) {
      state.restoreRefresh = action.payload
    },
    restoreRefreshRevisionReceived(state, action: PayloadAction<{ requestId: string; dataRevision: number }>) {
      if (state.restoreRefresh?.requestId === action.payload.requestId)
        state.restoreRefresh.dataRevision = action.payload.dataRevision
    },
    restoreRefreshFailed(state, action: PayloadAction<{ requestId: string; error: string }>) {
      if (state.restoreRefresh?.requestId !== action.payload.requestId) return
      state.restoreRefresh.loading = false
      state.restoreRefresh.error = action.payload.error
    },
    restoreRefreshFinished(state, action: PayloadAction<string>) {
      if (state.restoreRefresh?.requestId !== action.payload) return
      if (state.restoreRefresh.warnings.length) {
        state.restoreRefresh.loading = false
        state.restoreRefresh.error = null
      } else state.restoreRefresh = null
    },
    provenanceReset() {
      return { ...initialState }
    },
  },
  extraReducers: (builder) => {
    builder
      // Invalidate even when the history panel is currently unmounted.
      .addCase('selection/datasetLoaded', state => ({ ...initialState, maskFilter: state.maskFilter }))
      .addCase(fetchProvenanceThunk.pending, (state, action) => {
        if (state.datasetId !== action.meta.arg) Object.assign(state, { ...initialState, maskFilter: state.maskFilter,
          restoreRefresh: state.restoreRefresh?.datasetId === action.meta.arg ? state.restoreRefresh : null })
        state.datasetId = action.meta.arg
        state.fetchRequestId = action.meta.requestId
        state.ready = false
        state.loading = true
        state.error = null
      })
      .addCase(fetchProvenanceThunk.fulfilled, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId || state.datasetId !== action.meta.arg
          || action.payload.datasetId !== action.meta.arg) return
        state.ready = true
        state.loading = false
        state.datasetId = action.payload.datasetId
        state.dataRevision = action.payload.dataRevision
        state.schemaRevision = action.payload.schemaRevision
        state.currentOperationId = action.payload.currentOperationId
        state.cursorOperationId = action.payload.cursorOperationId ?? action.payload.currentOperationId
        state.canUndo = action.payload.canUndo ?? false
        state.canRedo = action.payload.canRedo ?? false
        state.rawDataRevision = action.payload.rawDataRevision
        state.maskRevision = action.payload.maskRevision
        state.steps = action.payload.steps
      })
      .addCase(fetchProvenanceThunk.rejected, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId || state.datasetId !== action.meta.arg) return
        state.ready = false
        state.loading = false
        state.error = action.payload === 'PROVENANCE_FETCH_SUPERSEDED' || action.meta.aborted
          ? null : action.error.message ?? '来歴の取得に失敗しました。'
      })
  },
})

export const { maskFilterChanged, provenanceReset, restoreRefreshStarted, restoreRefreshRevisionReceived, restoreRefreshFailed, restoreRefreshFinished } = provenanceSlice.actions
export const provenanceReducer = provenanceSlice.reducer
