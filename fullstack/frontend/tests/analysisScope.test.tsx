import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionReducer, globalObservationsSlice, datasetLoaded, selectionApplied, selectionCleared,
  observationScopeChanged, samplingApplied, rangeSelectionApplied, datasetValuesUpdated } from '../src/app/store'
import { createScopeSnapshot, useAnalysisScope, useScopedRun } from '../src/features/selection/analysisScope'

afterEach(cleanup)
function setup() {
  const base = store.getState()
  const local = configureStore({ reducer: (state = base, action: any) => ({ ...state,
    selection: selectionReducer(state.selection, action),
    globalObservations: globalObservationsSlice.reducer(state.globalObservations, action),
  }), middleware: get => get({ serializableCheck: false }) })
  local.dispatch(datasetLoaded({ datasetId: 'd', name: 'D', rowIds: ['r1', 'r2', 'r3', 'r4'] }))
  const wrapper = ({ children }: any) => <Provider store={local}>{children}</Provider>
  return { local, wrapper }
}

describe('one canonical common target', () => {
  it('resolves all four sources and never expands an empty selection', () => {
    const { local, wrapper } = setup()
    local.dispatch(rangeSelectionApplied({ from: 1, to: 3, rowIds: ['r1', 'r2', 'r3'] }))
    local.dispatch(selectionApplied({ rowIds: ['r2'], operation: 'replace', label: 'test' }))
    const { result } = renderHook(() => useAnalysisScope(), { wrapper })
    expect(result.current.rowIds).toEqual(['r1', 'r2', 'r3'])
    act(() => { local.dispatch(observationScopeChanged('selected')) })
    expect(result.current.contextRows).toEqual({ scope: 'selected', selectedRowIds: ['r2'] })
    act(() => { local.dispatch(selectionCleared()) })
    expect(result.current.contextRows).toEqual({ scope: 'selected', selectedRowIds: [] })
    act(() => { local.dispatch(samplingApplied({ sampledRowIds: ['r1', 'r4'] })) })
    expect(result.current.rowIds).toEqual(['r1', 'r4'])
    act(() => { local.dispatch(observationScopeChanged('all')) })
    expect(result.current.rowIds).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(result.current.contextRows).toEqual({ scope: 'all' })
    expect(local.getState().globalObservations).not.toHaveProperty('activeRowIds')
    expect(local.getState().globalObservations).not.toHaveProperty('selectedRowIds')
  })
  it('updates range and selected eligibility atomically in the canonical selection slice', () => {
    const { local } = setup()
    local.dispatch(selectionApplied({ rowIds: ['r1', 'r4'], operation: 'replace', label: 'test' }))
    local.dispatch(rangeSelectionApplied({ from: 1, to: 2, rowIds: ['r1', 'r2', 'foreign'] }))
    expect(local.getState().selection.activeRowIds).toEqual(['r1', 'r2'])
    expect(local.getState().selection.activeRowIdSet).toEqual(new Set(['r1', 'r2']))
    expect(local.getState().selection.selectedRowIds).toEqual(['r1'])
    local.dispatch(rangeSelectionApplied({ from: 1, to: 4, rowIds: ['r2', 'r4'], asSelected: true }))
    expect(local.getState().selection.selectedRowIds).toEqual(['r2'])
  })
  it('copies rows and keys membership rather than count or ordering', () => {
    const rows = ['r1', 'r2']
    const snapshot = createScopeSnapshot('selected', rows, 'd', 1, 1)
    rows[0] = 'r3'
    expect(snapshot.contextRows.selectedRowIds).toEqual(['r1', 'r2'])
    expect(snapshot.scopeKey).not.toEqual(createScopeSnapshot('selected', rows, 'd', 1, 1).scopeKey)
    expect(snapshot.scopeKey).toEqual(createScopeSnapshot('selected', ['r2', 'r1'], 'd', 1, 1).scopeKey)
  })
})

describe('explicit analysis run snapshot', () => {
  it('finishes against its original rows after a scope change and marks the result dirty', () => {
    const { local, wrapper } = setup()
    const { result } = renderHook(() => useScopedRun('settings'), { wrapper })
    const ticket = result.current.begin()
    act(() => { local.dispatch(observationScopeChanged('selected')) })
    expect(ticket.isCurrent()).toBe(true)
    act(() => { ticket.commit() })
    expect(result.current.snapshot?.rowIds).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(result.current.scope.rowIds).toEqual([])
    expect(result.current.dirty).toBe(true)
  })
  it('rejects older runs, data revisions and actual unmounts', () => {
    const { local, wrapper } = setup()
    const hook = renderHook(() => useScopedRun(), { wrapper })
    const old = hook.result.current.begin(), latest = hook.result.current.begin()
    expect(old.isCurrent()).toBe(false)
    expect(latest.isCurrent()).toBe(true)
    act(() => { local.dispatch(datasetValuesUpdated({ datasetId: 'd', dataRevision: 2 })) })
    expect(latest.isCurrent()).toBe(false)
    const pending = hook.result.current.begin()
    hook.unmount()
    local.dispatch(datasetLoaded({ datasetId: 'other', name: 'Other', rowIds: ['r1', 'r2'] }))
    expect(pending.isCurrent()).toBe(false)
  })
})
