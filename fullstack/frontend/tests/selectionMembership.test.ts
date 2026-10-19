import { createNextState } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
import {
  analysisWorkspaceRestored, datasetLoaded, deleteSelected, focusSelected,
  rangeSelectionApplied, resetWorkingSet, selectionApplied, selectionReducer, store,
  type SelectionState,
} from '../src/app/store'

const loaded = (rowIds = ['a', 'b', 'c', 'd']) => selectionReducer(undefined,
  datasetLoaded({ datasetId: 'test', name: 'Test', rowIds }))
const select = (state: SelectionState, rowIds: string[], operation: 'replace' | 'add' | 'subtract' | 'toggle' = 'replace') =>
  selectionReducer(state, selectionApplied({ rowIds, operation, label: 'Check' }))

function checkScope(state: SelectionState, expected: string[]) {
  expect([...state.activeRowIdSet]).toEqual(expected)
  expect(state.activeRowIds).toEqual(expected)
  const result = select(state, ['a', 'b', 'c', 'd', 'foreign'])
  expect(result.selectedRowIds).toEqual(['a', 'b', 'c', 'd'].filter(id => expected.includes(id)))
  expect(result.activeRowIdSet).toBe(state.activeRowIdSet)
}

describe('selection membership index', () => {
  it.each([
    ['replace', ['c', 'b']], ['add', ['a', 'b', 'c']],
    ['subtract', ['a']], ['toggle', ['a', 'c']],
  ] as const)('preserves %s ordering, deduplication, active filtering, and history', (operation, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
    try {
      const state = select(loaded(), ['a', 'b'])
      const result = select(state, ['c', 'b', 'foreign', 'c'], operation)
      expect(result.selectedRowIds).toEqual(expected)
      expect(result.history[0]).toEqual({ label: 'Check（2行）', at: '2026-10-19T00:00:00.000Z' })
      expect(result.futureCount).toBe(0)
      expect(result.activeRowIdSet).toBe(state.activeRowIdSet)
      expect(state.selectedRowIds).toEqual(['a', 'b'])
    } finally { vi.useRealTimers() }
  })

  it('keeps the index correct after every working-set writer', () => {
    const state = select(loaded(), ['b', 'c'])
    checkScope(state, ['a', 'b', 'c', 'd'])
    checkScope(selectionReducer(state, focusSelected()), ['b', 'c'])
    const deleted = selectionReducer(state, deleteSelected())
    checkScope(deleted, ['a', 'd'])
    checkScope(selectionReducer(deleted, resetWorkingSet()), ['a', 'b', 'c', 'd'])
    checkScope(selectionReducer(state, rangeSelectionApplied({ from: 1, to: 2, rowIds: ['d', 'b', 'foreign', 'd'] })), ['d', 'b'])
    checkScope(selectionReducer(state, rangeSelectionApplied({ from: 1, to: 2, rowIds: ['a'], asSelected: true })), ['a', 'b', 'c', 'd'])
    checkScope(selectionReducer(state, analysisWorkspaceRestored({
      workspaceVersion: 1, datasetId: 'test', dataRevision: 1, schemaRevision: 1,
      activeRowIds: ['c', 'a', 'foreign'], selectedRowIds: ['c'], groups: [],
      globalVariables: store.getState().globalVariables, globalObservations: store.getState().globalObservations,
    })), ['c', 'a'])
    checkScope(selectionReducer(state, datasetLoaded({ datasetId: 'next', name: 'Next', rowIds: ['d'] })), ['d'])
    checkScope(selectionReducer(state, rangeSelectionApplied({ from: 1, to: 0, rowIds: [] })), [])
  })

  it('uses newly assigned membership when invoked inside the same producer', () => {
    const result = createNextState(loaded(), draft => {
      selectionReducer(draft, rangeSelectionApplied({ from: 1, to: 1, rowIds: ['c'] }))
      selectionReducer(draft, selectionApplied({ rowIds: ['a', 'c'], operation: 'replace', label: 'Check' }))
    })
    expect(result.selectedRowIds).toEqual(['c'])
  })

  it('uses current membership after an in-place mutation inside a surrounding producer', () => {
    const result = createNextState(loaded(), draft => {
      draft.activeRowIds.splice(0, 2)
      draft.activeRowIdSet = new Set(draft.activeRowIds)
      selectionReducer(draft, selectionApplied({ rowIds: ['a', 'c'], operation: 'replace', label: 'Check' }))
    })
    expect(result.selectedRowIds).toEqual(['c'])
  })

  it('does not scan the active rows again for a single-point selection', () => {
    const state = loaded(Array.from({ length: 100_000 }, (_, i) => `row-${i}`))
    let largeArrayIterations = 0
    const iterate = Array.prototype[Symbol.iterator]
    const iterator = vi.spyOn(Array.prototype, Symbol.iterator).mockImplementation(function (this: unknown[]) {
      if (this.length === 100_000) largeArrayIterations++
      return iterate.call(this)
    })
    try {
      const result = select(state, ['row-50000', 'foreign'])
      expect(result.selectedRowIds).toEqual(['row-50000'])
      expect(largeArrayIterations).toBe(0)
    } finally { iterator.mockRestore() }
  })
})
