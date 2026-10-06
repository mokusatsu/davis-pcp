import { createSlice, createAsyncThunk, createAction, PayloadAction } from '@reduxjs/toolkit'
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
  /** Pending owner, retained after settlement as the editor completion receipt. */
  saveRequestId: string | null
  /** One canonical read may precede the save response; a second change supersedes it. */
  saveSnapshotAdvanced: boolean
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
  saveRequestId: null,
  saveSnapshotAdvanced: false,
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

/** Shared by ordinary reads and the already-guarded restore refresh. */
export const codebookReadAccepted = createAction('codebook/readAccepted',
  (payload: CodebookResponse, requestId: string) => ({ payload, meta: { requestId } }))

export const fetchCodebookThunk = createAsyncThunk(
  'codebook/fetch',
  async (datasetId: string, { getState, dispatch, requestId, rejectWithValue, signal }) => {
    const started = getState() as RootState
    const ownsRead = () => {
      const current = getState() as RootState
      return !signal.aborted && current.codebook.fetchRequestId === requestId
        && current.codebook.datasetId === datasetId && current.selection.datasetId === datasetId
        && current.selection.revision === started.selection.revision
        && current.selection.dataRevision === started.selection.dataRevision
        && sameSavedSnapshot(current.codebook, started.codebook)
    }
    let res: CodebookResponse
    try { res = await getCodebook(datasetId) }
    catch (error) {
      if (!ownsRead()) return rejectWithValue('CODEBOOK_FETCH_SUPERSEDED')
      throw error
    }
    if (!ownsRead()) return rejectWithValue('CODEBOOK_FETCH_SUPERSEDED')
    if (res.datasetId !== datasetId) throw new Error('コードブックのデータセットが一致しません。')
    // State fanout is synchronous with the live ownership check. The delayed
    // RTK fulfilled action only acknowledges this accepted read.
    dispatch(codebookReadAccepted(res, requestId))
    return res
  },
  // Dataset installation uses codebookReceived; fetches only refresh the
  // selected workspace. Reject foreign callbacks before pending clears drafts.
  { condition: (datasetId, { getState }) => (getState() as RootState).selection.datasetId === datasetId },
)

type SavedSnapshot = Pick<CodebookResponse, 'schemaRevision' | 'columns' | 'multiResponseGroups' | 'weightConfig' | 'surveyDesign'>
function savedSnapshotKey(snapshot: SavedSnapshot): string {
  // Object insertion order is not codebook content; array/column/group order is.
  return JSON.stringify([snapshot.schemaRevision, snapshot.columns, snapshot.multiResponseGroups ?? [],
    snapshot.weightConfig ?? null, snapshot.surveyDesign ?? null], (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
    }
    return value
  })
}
export function sameSavedSnapshot(left: SavedSnapshot, right: SavedSnapshot): boolean {
  return savedSnapshotKey(left) === savedSnapshotKey(right)
}

type CodebookSaveResult = Awaited<ReturnType<typeof updateCodebook>> & {
  columns: CodebookColumn[]
  multiResponseGroups: MultiResponseGroup[]
  weightConfig: WeightConfig | null
  surveyDesign: SurveyDesignSpec | null
  submittedColumns: CodebookColumn[]
  submittedGroups: MultiResponseGroup[]
}

/** Only the live save producer may publish this synchronous installation. */
export const codebookSaveAccepted = createAction('codebook/saveAccepted',
  (payload: CodebookSaveResult, requestId: string) => ({ payload, meta: { requestId } }))

export const saveCodebookThunk = createAsyncThunk(
  'codebook/save',
  async (_, { getState, dispatch, requestId, rejectWithValue, signal }) => {
    const started = getState() as RootState
    const state = started.codebook
    if (!state.datasetId) throw new Error('No dataset loaded')
    const ownsSave = (response?: CodebookSaveResult) => {
      const current = getState() as RootState
      return !signal.aborted && current.codebook.saveRequestId === requestId
        && current.selection.datasetId === state.datasetId
        && current.selection.revision === started.selection.revision
        && current.selection.dataRevision === started.selection.dataRevision
        && current.codebook.datasetId === state.datasetId
        && (sameSavedSnapshot(current.codebook, state)
          || (!!response && sameSavedSnapshot(current.codebook, response)))
    }

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
    let res: Awaited<ReturnType<typeof updateCodebook>>
    try {
      res = await updateCodebook(state.datasetId, patches, {
        multiResponseGroups: snapshotGroups,
        expectedSchemaRevision: state.schemaRevision,
      })
    } catch (error) {
      if (!ownsSave()) return rejectWithValue({ code: 'CODEBOOK_SAVE_SUPERSEDED', committed: 'unknown' })
      throw error
    }
    const result: CodebookSaveResult = {
      ...res,
      datasetId: state.datasetId,
      columns: res.codebook.columns,
      multiResponseGroups: res.codebook.multiResponseGroups ?? [],
      weightConfig: res.codebook.weightConfig ?? null,
      surveyDesign: res.codebook.surveyDesign ?? null,
      submittedColumns: snapshotColumns,
      submittedGroups: snapshotGroups,
    }
    // No await between the last live check and the sole state-application action.
    // RTK's later fulfilled acknowledgment has a microtask gap and must not
    // install this snapshot in any slice. Supersession does not undo the PUT.
    if (!ownsSave(result)) return rejectWithValue({ code: 'CODEBOOK_SAVE_SUPERSEDED', committed: 'confirmed' })
    dispatch(codebookSaveAccepted(result, requestId))
    return result
  },
  { condition: (_, { getState }) => {
    const { codebook, selection } = getState() as RootState
    return !!codebook.datasetId && codebook.datasetId === selection.datasetId
      && !codebook.isSaving
  } },
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
      .addCase('selection/datasetLoaded', state => {
        state.fetchRequestId = null
        state.isLoading = false
        state.saveRequestId = null
        state.saveSnapshotAdvanced = false
        state.isSaving = false
      })
      .addCase(fetchCodebookThunk.pending, (state, action) => {
        const nextDatasetId = action.meta.arg
        const isDifferentDataset = state.datasetId !== nextDatasetId

        state.fetchRequestId = action.meta.requestId
        state.isLoading = true
        state.datasetId = nextDatasetId

        if (isDifferentDataset) {
          state.saveRequestId = null
          state.saveSnapshotAdvanced = false
          state.isSaving = false
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
      .addCase(codebookReadAccepted, (state, action) => {
        if (state.fetchRequestId !== action.meta.requestId) return
        if (action.payload.datasetId !== state.datasetId) return

        // A read can acknowledge this save's already-committed canonical
        // snapshot before its PUT response arrives. Retain the request receipt;
        // the producer accepts it only if the full saved snapshot still agrees.
        // Changed reads release busy ownership so a newer save can replace it.
        if (!sameSavedSnapshot(state, action.payload)) {
          if (state.saveSnapshotAdvanced) state.saveRequestId = null
          state.saveSnapshotAdvanced = true
          state.isSaving = false
        }
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
      .addCase(saveCodebookThunk.pending, (state, action) => {
        state.saveRequestId = action.meta.requestId
        state.saveSnapshotAdvanced = false
        state.isSaving = true
      })
      .addCase(codebookSaveAccepted, (state, action) => {
        if (state.saveRequestId !== action.meta.requestId || action.payload.datasetId !== state.datasetId) return

        state.isSaving = false
        state.saveSnapshotAdvanced = true
        state.fetchRequestId = null
        state.isLoading = false
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
      .addCase(saveCodebookThunk.rejected, (state, action) => {
        if (state.saveRequestId === action.meta.requestId) state.isSaving = false
      })
      .addCase(saveLicenseTextThunk.fulfilled, (state, action) => {
        if (action.payload.datasetId !== state.datasetId) return
        if (action.payload.licenseRevision < (state.licenseRevision ?? 1)) return
        state.licenseText = action.payload.licenseText
        state.licenseRevision = action.payload.licenseRevision
      })
      .addCase(saveWeightConfigThunk.fulfilled, (state, action) => {
        if (action.payload.datasetId !== state.datasetId) return
        state.saveRequestId = null
        state.saveSnapshotAdvanced = false
        state.isSaving = false
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
