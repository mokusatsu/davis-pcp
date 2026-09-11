import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit'
import { api } from '../../api/client'

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

export interface ProvenanceState {
  datasetId: string | null
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

export const fetchProvenanceThunk = createAsyncThunk(
  'provenance/fetch',
  async (datasetId: string) => {
    return await api.get<ProvenanceResponse>(`/datasets/${datasetId}/provenance`)
  },
)

const provenanceSlice = createSlice({
  name: 'provenance',
  initialState,
  reducers: {
    maskFilterChanged(state, action: PayloadAction<ProvenanceState['maskFilter']>) {
      state.maskFilter = action.payload
    },
    provenanceReset(state) {
      state.datasetId = null
      state.dataRevision = null
      state.schemaRevision = null
      state.currentOperationId = null
      state.cursorOperationId = null
      state.canUndo = false
      state.canRedo = false
      state.rawDataRevision = null
      state.maskRevision = 0
      state.steps = []
      state.maskFilter = 'all'
      state.loading = false
      state.error = null
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchProvenanceThunk.pending, (state) => {
        state.loading = true
        state.error = null
      })
      .addCase(fetchProvenanceThunk.fulfilled, (state, action) => {
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
        state.loading = false
        state.error = action.error.message ?? '来歴の取得に失敗しました。'
      })
  },
})

export const { maskFilterChanged, provenanceReset } = provenanceSlice.actions
export const provenanceReducer = provenanceSlice.reducer
