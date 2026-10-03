import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit'
import {
  CodebookResponse, CodebookColumn, MultiResponseGroup, SurveyDesignSpec, WeightConfig,
  getCodebook, updateCodebook,
} from '../../api/client'
import type { RootState } from '../../app/store'
import { CodebookPreset } from './codebookPresets'
import { ParsedOption } from './codebookParsers'

export interface CodebookState {
  datasetId: string | null
  fetchRequestId: string | null
  schemaRevision: number
  licenseText: string
  licenseRevision: number
  columns: CodebookColumn[]
  draftColumns: CodebookColumn[]
  multiResponseGroups: MultiResponseGroup[]
  draftMultiResponseGroups: MultiResponseGroup[]
  /** Which weight column this dataset's analyses use, and what it means. */
  weightConfig: WeightConfig | null
  surveyDesign: SurveyDesignSpec | null
  selectedColumnIds: string[]
  activeColumnId: string | null
  viewMode: 'detail' | 'grid'
  isEditorOpen: boolean
  isBulkLabelModalOpen: boolean
  isImportDialogOpen: boolean
  filter: {
    keyword: string
    scaleType: string | null
    role: string | null
  }
  hasChanges: boolean
  isLoading: boolean
  isSaving: boolean
}

const initialState: CodebookState = {
  datasetId: null,
  fetchRequestId: null,
  schemaRevision: 1,
  licenseText: '',
  licenseRevision: 1,
  columns: [],
  draftColumns: [],
  multiResponseGroups: [],
  draftMultiResponseGroups: [],
  weightConfig: null,
  surveyDesign: null,
  selectedColumnIds: [],
  activeColumnId: null,
  viewMode: 'detail',
  isEditorOpen: false,
  isBulkLabelModalOpen: false,
  isImportDialogOpen: false,
  filter: {
    keyword: '',
    scaleType: null,
    role: null,
  },
  hasChanges: false,
  isLoading: false,
  isSaving: false,
}

export const fetchCodebookThunk = createAsyncThunk(
  'codebook/fetch',
  async (datasetId: string, { getState, requestId, rejectWithValue }) => {
    const res = await getCodebook(datasetId)
    // Do not emit a fulfilled action to other slices after a prepared dataset
    // or newer fetch superseded this request. Reducer-only guards are too late.
    const current = (getState() as RootState).codebook
    if (current.fetchRequestId !== requestId || current.datasetId !== datasetId)
      return rejectWithValue('CODEBOOK_FETCH_SUPERSEDED')
    return res
  }
)

export const saveCodebookThunk = createAsyncThunk(
  'codebook/save',
  async (_, { getState }) => {
    const state = (getState() as RootState).codebook
    if (!state.datasetId) throw new Error('No dataset loaded')

    const snapshotColumns = JSON.parse(JSON.stringify(state.draftColumns)) as CodebookColumn[]
    const snapshotGroups = structuredClone(state.draftMultiResponseGroups)
    const patches = snapshotColumns.map((col) => ({
      columnId: col.columnId,
      name: col.name,
      label: col.label,
      scaleType: col.scaleType,
      role: col.role,
      valueLabels: col.valueLabels,
      categoryOrder: col.categoryOrder,
      missingCodes: col.missingCodes,
      missingReasons: col.missingReasons,
      isReversed: col.isReversed,
      multiResponseGroup: col.multiResponseGroup,
      multiResponseOptionLabel: col.multiResponseOptionLabel,
    }))
    const res = await updateCodebook(state.datasetId, patches, {
      multiResponseGroups: snapshotGroups,
      expectedSchemaRevision: state.schemaRevision,
    })
    return {
      ...res,
      datasetId: state.datasetId,
      columns: res.codebook.columns,
      multiResponseGroups: res.codebook.multiResponseGroups ?? [],
      weightConfig: res.codebook.weightConfig ?? null,
      surveyDesign: res.codebook.surveyDesign ?? null,
      submittedColumns: snapshotColumns,
      submittedGroups: snapshotGroups,
    }
  }
)

/** Save attribution independently, leaving numerical revisions and open column drafts intact. */
export const saveLicenseTextThunk = createAsyncThunk(
  'codebook/saveLicenseText',
  async (payload: { datasetId: string; licenseText: string; expectedLicenseRevision: number }) => {
    const res = await updateCodebook(payload.datasetId, [], {
      licenseText: payload.licenseText,
      expectedLicenseRevision: payload.expectedLicenseRevision,
    })
    return { datasetId: payload.datasetId, licenseText: res.codebook.licenseText ?? '',
      licenseRevision: res.codebook.licenseRevision ?? 1 }
  }
)

/**
 * Save only the weight declaration, without touching any column.
 *
 * The type is dataset-level on purpose: "what this weight means" is a property
 * of the data, not of one crosstab. Declaring it bumps the schema revision, so
 * a cached result computed under the old meaning can never be reused.
 */
export const saveWeightConfigThunk = createAsyncThunk(
  'codebook/saveWeightConfig',
  async (
    payload: { weightConfig: WeightConfig | null; surveyDesign?: SurveyDesignSpec | null },
    { getState }
  ) => {
    const state = (getState() as RootState).codebook
    if (!state.datasetId) throw new Error('No dataset loaded')
    const res = await updateCodebook(state.datasetId, [], {
      weightConfig: payload.weightConfig,
      ...(payload.surveyDesign !== undefined ? { surveyDesign: payload.surveyDesign } : {}),
      expectedSchemaRevision: state.schemaRevision,
    })
    return {
      ...res,
      datasetId: state.datasetId,
      weightConfig: res.codebook.weightConfig ?? null,
      surveyDesign: res.codebook.surveyDesign ?? null,
    }
  }
)

function isColumnEqual(left: CodebookColumn[], right: CodebookColumn[]): boolean {
  if (left.length !== right.length) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

export const codebookSlice = createSlice({
  name: 'codebook',
  initialState,
  reducers: {
    codebookReceived(_state, action: PayloadAction<CodebookResponse>) {
      // A prepared dataset is committed synchronously; invalidate any old fetch.
      const value = action.payload
      return { ...initialState, datasetId: value.datasetId, schemaRevision: value.schemaRevision,
        licenseText: value.licenseText ?? '', licenseRevision: value.licenseRevision ?? 1,
        columns: value.columns, draftColumns: structuredClone(value.columns),
        multiResponseGroups: value.multiResponseGroups ?? [],
        draftMultiResponseGroups: structuredClone(value.multiResponseGroups ?? []),
        weightConfig: value.weightConfig ?? null, surveyDesign: value.surveyDesign ?? null,
        activeColumnId: value.columns[0]?.columnId ?? null }
    },
    licenseMetadataReceived(state, action: PayloadAction<{ datasetId: string; licenseText: string; licenseRevision: number }>) {
      if (action.payload.datasetId !== state.datasetId || action.payload.licenseRevision < (state.licenseRevision ?? 1)) return
      state.licenseText = action.payload.licenseText
      state.licenseRevision = action.payload.licenseRevision
    },
    codebookReset() {
      return { ...initialState }
    },
    editorModalOpened(state) {
      state.isEditorOpen = true
      if (!state.activeColumnId && state.draftColumns.length > 0) {
        state.activeColumnId = state.draftColumns[0].columnId
      }
    },
    editorModalClosed(state) {
      state.isEditorOpen = false
    },
    bulkLabelModalToggled(state, action: PayloadAction<boolean>) {
      state.isBulkLabelModalOpen = action.payload
    },
    importDialogToggled(state, action: PayloadAction<boolean>) {
      state.isImportDialogOpen = action.payload
    },
    viewModeChanged(state, action: PayloadAction<'detail' | 'grid'>) {
      state.viewMode = action.payload
    },
    activeColumnSelected(state, action: PayloadAction<string>) {
      state.activeColumnId = action.payload
    },
    selectedColumnsChanged(state, action: PayloadAction<string[]>) {
      state.selectedColumnIds = action.payload
    },
    filterChanged(
      state,
      action: PayloadAction<{ keyword?: string; scaleType?: string | null; role?: string | null }>
    ) {
      if (action.payload.keyword !== undefined) state.filter.keyword = action.payload.keyword
      if (action.payload.scaleType !== undefined) state.filter.scaleType = action.payload.scaleType
      if (action.payload.role !== undefined) state.filter.role = action.payload.role
    },
    draftColumnUpdated(state, action: PayloadAction<{ columnId: string; patch: Partial<CodebookColumn> }>) {
      const idx = state.draftColumns.findIndex((c) => c.columnId === action.payload.columnId)
      if (idx !== -1) {
        state.draftColumns[idx] = { ...state.draftColumns[idx], ...action.payload.patch }
        state.hasChanges = true
      }
    },
    bulkLabelsApplied(state, action: PayloadAction<{ columnId: string; label: string }[]>) {
      const labelMap = new Map(action.payload.map((item) => [item.columnId, item.label]))
      state.draftColumns = state.draftColumns.map((col) => {
        if (labelMap.has(col.columnId)) {
          return { ...col, label: labelMap.get(col.columnId)! }
        }
        return col
      })
      state.hasChanges = true
    },
    presetAppliedToColumns(
      state,
      action: PayloadAction<{ columnIds: string[]; preset: CodebookPreset }>
    ) {
      const targets = new Set(action.payload.columnIds)
      const { preset } = action.payload
      const valueLabels: Record<string, string> = {}
      const categoryOrder: string[] = []
      preset.options.forEach((opt) => {
        valueLabels[opt.code] = opt.label
        categoryOrder.push(opt.code)
      })

      state.draftColumns = state.draftColumns.map((col) => {
        if (targets.has(col.columnId)) {
          return {
            ...col,
            scaleType: preset.scaleType,
            valueLabels,
            categoryOrder,
          }
        }
        return col
      })
      state.hasChanges = true
    },
    quickValueLabelsApplied(
      state,
      action: PayloadAction<{ columnIds: string[]; options: ParsedOption[] }>
    ) {
      const targets = new Set(action.payload.columnIds)
      const valueLabels: Record<string, string> = {}
      const categoryOrder: string[] = []
      action.payload.options.forEach((opt) => {
        valueLabels[opt.code] = opt.label
        categoryOrder.push(opt.code)
      })

      state.draftColumns = state.draftColumns.map((col) => {
        if (targets.has(col.columnId)) {
          return {
            ...col,
            valueLabels,
            categoryOrder,
          }
        }
        return col
      })
      state.hasChanges = true
    },
    draftReverted(state) {
      state.draftColumns = JSON.parse(JSON.stringify(state.columns))
      state.draftMultiResponseGroups = JSON.parse(JSON.stringify(state.multiResponseGroups))
      state.hasChanges = false
    },
    draftMultiResponseGroupUpdated(state, action: PayloadAction<{ group: MultiResponseGroup; columnIds: string[] }>) {
      const { group, columnIds } = action.payload
      const ids = new Set(columnIds)
      const index = state.draftMultiResponseGroups.findIndex(g => g.groupId === group.groupId)
      if (index < 0) state.draftMultiResponseGroups.push(group)
      else state.draftMultiResponseGroups[index] = group
      for (const column of state.draftColumns) {
        if (ids.has(column.columnId)) {
          column.multiResponseGroup = group.groupId
          column.scaleType = 'nominal'
        } else if (column.multiResponseGroup === group.groupId) column.multiResponseGroup = null
      }
      state.hasChanges = true
    },
    draftMultiResponseGroupRemoved(state, action: PayloadAction<string>) {
      state.draftMultiResponseGroups = state.draftMultiResponseGroups.filter(g => g.groupId !== action.payload)
      for (const column of state.draftColumns) {
        if (column.multiResponseGroup === action.payload) column.multiResponseGroup = null
      }
      state.hasChanges = true
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchCodebookThunk.pending, (state, action) => {
        const nextDatasetId = action.meta.arg
        const isDifferentDataset = state.datasetId !== nextDatasetId

        state.fetchRequestId = action.meta.requestId
        state.isLoading = true
        state.datasetId = nextDatasetId

        if (isDifferentDataset) {
          state.schemaRevision = 1
          state.licenseText = ''
          state.licenseRevision = 1
          state.columns = []
          state.draftColumns = []
          state.multiResponseGroups = []
          state.draftMultiResponseGroups = []
          state.weightConfig = null
          state.surveyDesign = null
          state.selectedColumnIds = []
          state.activeColumnId = null
          state.hasChanges = false
        }
      })
      .addCase(fetchCodebookThunk.fulfilled, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId) return
        if (action.payload.datasetId !== state.datasetId) return

        state.isLoading = false
        state.schemaRevision = action.payload.schemaRevision
        if ((action.payload.licenseRevision ?? 1) >= (state.licenseRevision ?? 1)) {
          state.licenseText = action.payload.licenseText ?? ''
          state.licenseRevision = action.payload.licenseRevision ?? 1
        }
        state.columns = action.payload.columns
        state.multiResponseGroups = action.payload.multiResponseGroups ?? []
        state.weightConfig = action.payload.weightConfig ?? null
        state.surveyDesign = action.payload.surveyDesign ?? null

        if (!state.hasChanges) {
          state.draftColumns = JSON.parse(JSON.stringify(action.payload.columns))
          state.draftMultiResponseGroups = JSON.parse(JSON.stringify(state.multiResponseGroups))
          state.hasChanges = false
          if (state.draftColumns.length > 0 && !state.activeColumnId) {
            state.activeColumnId = state.draftColumns[0].columnId
          }
        }
      })
      .addCase(fetchCodebookThunk.rejected, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId) return
        state.isLoading = false
      })
      .addCase(saveCodebookThunk.pending, (state) => {
        state.isSaving = true
      })
      .addCase(saveCodebookThunk.fulfilled, (state, action) => {
        if (action.payload.datasetId !== state.datasetId) return

        state.isSaving = false
        state.schemaRevision = action.payload.schemaRevision
        state.columns = JSON.parse(JSON.stringify(action.payload.columns))
        state.multiResponseGroups = action.payload.multiResponseGroups
        state.weightConfig = action.payload.weightConfig
        state.surveyDesign = action.payload.surveyDesign
        // Apply the server's normalization immediately, without discarding
        // edits the user made while this particular save was in flight.
        if (isColumnEqual(state.draftColumns, action.payload.submittedColumns)) {
          state.draftColumns = JSON.parse(JSON.stringify(action.payload.columns))
        }
        if (JSON.stringify(state.draftMultiResponseGroups) === JSON.stringify(action.payload.submittedGroups)) {
          state.draftMultiResponseGroups = JSON.parse(JSON.stringify(action.payload.multiResponseGroups))
        }
        state.hasChanges = !isColumnEqual(state.draftColumns, action.payload.columns)
          || JSON.stringify(state.draftMultiResponseGroups) !== JSON.stringify(action.payload.multiResponseGroups)
      })
      .addCase(saveCodebookThunk.rejected, (state) => {
        state.isSaving = false
      })
      .addCase(saveLicenseTextThunk.fulfilled, (state, action) => {
        if (action.payload.datasetId !== state.datasetId) return
        if (action.payload.licenseRevision < (state.licenseRevision ?? 1)) return
        state.licenseText = action.payload.licenseText
        state.licenseRevision = action.payload.licenseRevision
      })
      .addCase(saveWeightConfigThunk.fulfilled, (state, action) => {
        if (action.payload.datasetId !== state.datasetId) return
        state.schemaRevision = action.payload.schemaRevision
        state.weightConfig = action.payload.weightConfig
        state.surveyDesign = action.payload.surveyDesign
      })
  },
})

export const {
  editorModalOpened,
  editorModalClosed,
  bulkLabelModalToggled,
  importDialogToggled,
  viewModeChanged,
  activeColumnSelected,
  selectedColumnsChanged,
  filterChanged,
  draftColumnUpdated,
  bulkLabelsApplied,
  presetAppliedToColumns,
  quickValueLabelsApplied,
  draftReverted,
  codebookReset,
  codebookReceived,
  licenseMetadataReceived,
  draftMultiResponseGroupUpdated,
  draftMultiResponseGroupRemoved,
} = codebookSlice.actions
