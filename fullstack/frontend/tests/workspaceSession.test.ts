import { configureStore } from '@reduxjs/toolkit'
import { expect, it } from 'vitest'
import { store, selectionReducer, globalObservationsSlice, globalVariablesSlice, datasetLoaded,
  variablesInitialized, selectionApplied, samplingApplied, observationScopeChanged, rangeSelectionApplied,
  activeEntitiesSet, analysisWorkspaceRestored, datasetValuesUpdated } from '../src/app/store'
import { createAnalysisWorkspaceSnapshot, readAnalysisWorkspaceSnapshot } from '../src/features/selection/workspaceSession'

function setup() {
  const base = store.getState()
  const initial = { ...base, codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1,
    columns: [{ columnId: 'x', name: 'x' }, { columnId: 'y', name: 'y' }] as any } }
  const local = configureStore({ reducer: (state = initial, action: any) => ({ ...state,
    selection: selectionReducer(state.selection, action),
    globalObservations: globalObservationsSlice.reducer(state.globalObservations, action),
    globalVariables: globalVariablesSlice.reducer(state.globalVariables, action),
  }), middleware: get => get({ serializableCheck: false }) })
  local.dispatch(datasetLoaded({ datasetId: 'd', name: 'D', rowIds: ['r1', 'r2', 'r3'] }))
  local.dispatch(variablesInitialized({ datasetId: 'd', variables: ['x', 'y'] }))
  return local
}
it('restores rows, variables and sampled provenance in one notification without live mutation of the save', () => {
  const local = setup()
  local.dispatch(rangeSelectionApplied({ from: 1, to: 2, rowIds: ['r1', 'r2'] }))
  local.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'replace', label: 'selection' }))
  local.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'x' }]))
  local.dispatch(samplingApplied({ sampledRowIds: ['r1', 'r3'], datasetId: 'd', seed: 42,
    sourceScope: 'all', sourceScopeHash: 'source', sourceOrderHash: 'order', sourceRowCount: 3, dataRevision: 1, schemaRevision: 1 }))
  const saved = createAnalysisWorkspaceSnapshot(local.getState())
  local.dispatch(observationScopeChanged('all'))
  local.dispatch(activeEntitiesSet([{ kind: 'column', columnId: 'y' }]))
  local.dispatch(rangeSelectionApplied({ from: 1, to: 1, rowIds: ['r1'] }))
  expect(saved.globalObservations.scopeMode).toBe('sampled')
  expect(saved.activeRowIds).toEqual(['r1', 'r2'])
  let updates = 0
  const stop = local.subscribe(() => { updates++ })
  local.dispatch(analysisWorkspaceRestored(readAnalysisWorkspaceSnapshot(saved, local.getState())))
  stop()
  expect(updates).toBe(1)
  expect(local.getState().selection.activeRowIds).toEqual(['r1', 'r2'])
  expect(local.getState().selection.selectedRowIds).toEqual(['r2'])
  expect(local.getState().globalVariables.activeEntities).toEqual([{ kind: 'column', columnId: 'x' }])
  expect(local.getState().globalObservations.scopeMode).toBe('sampled')
  expect(local.getState().globalObservations.sampling.seed).toBe(42)
})
it('rejects stale/foreign/incomplete snapshots before dispatch and keeps the current workspace unchanged', () => {
  const local = setup()
  const saved = createAnalysisWorkspaceSnapshot(local.getState())
  const original = local.getState()
  expect(() => readAnalysisWorkspaceSnapshot({ activeRowIds: ['r1'] }, original)).toThrow(/完全な記録/)
  expect(() => readAnalysisWorkspaceSnapshot({ ...saved, activeRowIds: ['foreign'] }, original)).toThrow(/対象行/)
  expect(() => readAnalysisWorkspaceSnapshot({ ...saved, datasetId: 'other' }, original)).toThrow(/世代/)
  expect(local.getState()).toBe(original)
  local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 }))
  expect(() => readAnalysisWorkspaceSnapshot(saved, local.getState())).toThrow(/世代/)
})

it.each(['allVariables', 'variableOrder', 'variableMeta', 'targetVariableId', 'weightColumnId'])('rejects missing %s before restoring variable state', field => {
  const local = setup()
  const saved = createAnalysisWorkspaceSnapshot(local.getState())
  delete (saved.globalVariables as any)[field]
  expect(() => readAnalysisWorkspaceSnapshot(saved, local.getState())).toThrow(/使用変数/)
})
it('rejects unknown saved weight and malformed metadata instead of installing an unusable workspace', () => {
  const local = setup()
  const saved = createAnalysisWorkspaceSnapshot(local.getState())
  saved.globalVariables.weightColumnId = 'foreign-weight'
  expect(() => readAnalysisWorkspaceSnapshot(saved, local.getState())).toThrow(/重み変数/)
  saved.globalVariables.weightColumnId = null
  saved.globalVariables.variableMeta = { x: null } as any
  expect(() => readAnalysisWorkspaceSnapshot(saved, local.getState())).toThrow(/使用変数/)
  expect(local.getState().globalVariables.weightColumnId).toBe(null)
})
