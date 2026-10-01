import { describe, it, expect } from 'vitest'
import {
  store,
  datasetLoaded,
  selectionApplied,
  selectionCleared,
  variablesInitialized,
  activeVariablesSet,
  variableToggled,
  variableOrderReordered,
  targetVariableSet,
  observationScopeChanged,
  samplingApplied,
  samplingCleared,
  rangeSelectionApplied,
  selectEffectiveRowIds,
} from '../src/app/store'

describe('Feature 15: Global Variable & Observation Selection Suite', () => {
  it('manages global variables state: initialization, set, toggle, reorder, target', () => {
    store.dispatch(
      variablesInitialized({
        variables: ['sepal_length', 'sepal_width', 'petal_length', 'petal_width', 'species'],
        meta: {
          sepal_length: { name: 'sepal_length', semanticType: 'numeric', physicalType: 'Float64', missingCount: 0, isTargetCandidate: false },
          species: { name: 'species', semanticType: 'nominal', physicalType: 'Utf8', missingCount: 0, isTargetCandidate: true },
        },
        target: 'species',
      })
    )

    let state = store.getState().globalVariables
    expect(state.allVariables).toHaveLength(5)
    expect(state.activeEntities?.map(entity => entity.kind === 'column' ? entity.columnId : entity.groupId)).toHaveLength(5)
    expect(state.targetVariableId).toBe('species')

    // Test activeVariablesSet
    store.dispatch(activeVariablesSet(['petal_length', 'petal_width']))
    state = store.getState().globalVariables
    expect(state.activeEntities?.map(entity => entity.kind === 'column' ? entity.columnId : entity.groupId)).toEqual(['petal_length', 'petal_width'])

    // Test variableToggled
    store.dispatch(variableToggled('sepal_length'))
    state = store.getState().globalVariables
    expect(state.activeEntities?.map(entity => entity.kind === 'column' ? entity.columnId : entity.groupId)).toContain('sepal_length')

    store.dispatch(variableToggled('sepal_length'))
    state = store.getState().globalVariables
    expect(state.activeEntities?.map(entity => entity.kind === 'column' ? entity.columnId : entity.groupId)).not.toContain('sepal_length')

    // Test variableOrderReordered
    store.dispatch(variableOrderReordered(['species', 'petal_width', 'petal_length']))
    state = store.getState().globalVariables
    expect(state.variableOrder[0]).toBe('species')

    // Test targetVariableSet
    store.dispatch(targetVariableSet('sepal_length'))
    expect(store.getState().globalVariables.targetVariableId).toBe('sepal_length')
  })

  it('manages global observation scopes and effective rowIds', () => {
    // Load dataset with 10 rows
    const rowIds = Array.from({ length: 10 }, (_, i) => `row_${i}`)
    store.dispatch(datasetLoaded({ datasetId: 'test_ds', name: 'Test', rowIds }))

    let state = store.getState()
    expect(selectEffectiveRowIds(state)).toEqual(rowIds)
    expect(state.globalObservations.scopeMode).toBe('active')

    // Select row_1 and row_2
    store.dispatch(selectionApplied({ rowIds: ['row_1', 'row_2'], operation: 'replace', label: 'Test Select' }))
    state = store.getState()
    expect(state.selection.selectedRowIds).toEqual(['row_1', 'row_2'])

    // Switch scope to 'selected'
    store.dispatch(observationScopeChanged('selected'))
    state = store.getState()
    expect(state.globalObservations.scopeMode).toBe('selected')
    expect(selectEffectiveRowIds(state)).toEqual(['row_1', 'row_2'])

    // Empty selected scope remains empty rather than expanding to active rows
    store.dispatch(selectionCleared())
    state = store.getState()
    expect(state.selection.selectedRowIds).toHaveLength(0)
    expect(state.globalObservations.scopeMode).toBe('selected')

        expect(selectEffectiveRowIds(state)).toEqual([])

    // Apply sampling
    const sampledIds = ['row_0', 'row_4', 'row_8']
    store.dispatch(
      samplingApplied({
        enabled: true,
        method: 'without_replacement',
        mode: 'count',
        size: 3,
        ratio: 0.3,
        sampledRowIds: sampledIds,
        sampledRowWeights: { row_0: 1, row_4: 1, row_8: 1 },
      })
    )
    state = store.getState()
    expect(state.globalObservations.scopeMode).toBe('sampled')
    expect(selectEffectiveRowIds(state)).toEqual(sampledIds)

    // Clear sampling -> scope falls back to 'active'
    store.dispatch(samplingCleared())
    state = store.getState()
    expect(state.globalObservations.scopeMode).toBe('active')
    expect(selectEffectiveRowIds(state)).toEqual(rowIds)

    // Apply range selection
    store.dispatch(
      rangeSelectionApplied({
        from: 1,
        to: 4,
        rowIds: ['row_0', 'row_1', 'row_2', 'row_3'],
        asSelected: false,
      })
    )
    state = store.getState()
    expect(state.selection.activeRowIds).toEqual(['row_0', 'row_1', 'row_2', 'row_3'])
    expect(selectEffectiveRowIds(state)).toEqual(['row_0', 'row_1', 'row_2', 'row_3'])
  })
})
