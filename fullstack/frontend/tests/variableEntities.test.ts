import { expect, it } from 'vitest'
import type { CodebookColumn } from '../src/api/client'
import { activeEntitiesSet, globalVariablesSlice, selectOrdinaryVariables, selectVariableManagerState, selectVariableEntities, store } from '../src/app/store'
import { fetchCodebookThunk } from '../src/features/dataset/codebookSlice'
import { reconcileEntities, variableCatalog } from '../src/features/selection/variableEntities'

const columns: CodebookColumn[] = ['a', 'b', 'x'].map(name => ({
  columnId: name, name, label: name, role: 'question', scaleType: 'nominal',
  categoryOrder: [], valueLabels: {}, missingCodes: [], missingReasons: {}, isReversed: false,
  multiResponseGroup: name === 'x' ? null : 'q',
}))

it('has one parent entry, without storing duplicate memberships', () => {
  const catalog = variableCatalog(columns, [])
  expect(catalog.map(item => item.entity)).toEqual([{ kind: 'ma', groupId: 'q' }, { kind: 'column', columnId: 'x' }])
  expect(reconcileEntities([{ kind: 'column', columnId: 'a' }, { kind: 'column', columnId: 'b' }], columns, [])).toEqual([{ kind: 'ma', groupId: 'q' }])
  expect(reconcileEntities([], columns, [])).toEqual([])
})

it('keeps an MA-only selection out of ordinary analysis candidates', () => {
  const base = store.getState()
  const variables = globalVariablesSlice.reducer(undefined, activeEntitiesSet([{ kind: 'ma', groupId: 'q' }]))
  const state = { ...base, globalVariables: variables, codebook: { ...base.codebook, columns } }
  expect(selectOrdinaryVariables(state).activeVariableIds).toEqual([])
  expect(selectVariableManagerState(state).activeVariableIds).toHaveLength(1)
  const empty = { ...state, globalVariables: globalVariablesSlice.reducer(variables, activeEntitiesSet([])) }
  expect(selectOrdinaryVariables(empty).activeVariableIds).toEqual([])
  expect(selectVariableManagerState(empty).activeVariableIds).toEqual([])
})

it('ignores codebook completion for another dataset', () => {
  const initial = { ...globalVariablesSlice.getInitialState(), datasetId: 'new', activeEntities: [{ kind: 'column' as const, columnId: 'x' }] }
  const result = globalVariablesSlice.reducer(initial, fetchCodebookThunk.fulfilled({ datasetId: 'old', schemaRevision: 2, columns: [] }, 'request', 'old'))
  expect(result.activeEntities).toEqual(initial.activeEntities)
})

it('orders selected parents and ordinary columns by the shared selection order', () => {
  const base = store.getState()
  const variables = globalVariablesSlice.reducer(undefined, activeEntitiesSet([{ kind: 'column', columnId: 'x' }, { kind: 'ma', groupId: 'q' }]))
  const state = { ...base, globalVariables: variables, codebook: { ...base.codebook, columns } }
  expect(selectVariableEntities(state).items.map(item => item.name)).toEqual(['x', 'q'])
  expect(selectOrdinaryVariables(state).activeVariableIds).toEqual(['x'])
  expect(state.selection.selectedRowIds).toEqual(base.selection.selectedRowIds)
})
