import { expect, it } from 'vitest'
import { store, datasetLoaded, datasetValuesUpdated, selectionApplied, focusSelected, samplingApplied } from '../src/app/store'

it('refreshes column values without resetting shared selection, focus, sampling or PCP settings', () => {
  store.dispatch(datasetLoaded({ datasetId: 'column-update', name: 'Survey', rowIds: ['r7', 'r2', 'r99'], dataRevision: 1 }))
  store.dispatch(selectionApplied({ rowIds: ['r7', 'r99'], operation: 'replace', label: 'Chosen rows' }))
  store.dispatch(focusSelected())
  store.dispatch(samplingApplied({ sampledRowIds: ['r99'], sampledRowWeights: { r99: 2 } }))
  const before = store.getState()
  store.dispatch(datasetValuesUpdated({ datasetId: 'column-update', dataRevision: 2 }))
  const after = store.getState()
  expect(after.selection).toEqual({ ...before.selection, dataRevision: 2 })
  expect(after.globalObservations).toBe(before.globalObservations)
  expect(after.pcp).toBe(before.pcp)
  expect(after.globalVariables).toBe(before.globalVariables)
  store.dispatch(datasetValuesUpdated({ datasetId: 'old-dataset', dataRevision: 3 }))
  store.dispatch(datasetValuesUpdated({ datasetId: 'column-update', dataRevision: 1 }))
  expect(store.getState().selection).toBe(after.selection)
})
