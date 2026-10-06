import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import MultiResponseCard from '../src/features/distribution/MultiResponseCard'
import { codebookSlice, draftMultiResponseGroupUpdated, draftMultiResponseGroupRemoved, draftReverted, fetchCodebookThunk, codebookReadAccepted } from '../src/features/dataset/codebookSlice'
import type { CodebookColumn, MultiResponseGroup, MultiResponseSummary } from '../src/api/client'

afterEach(cleanup)
const group: MultiResponseGroup = { groupId: 'q', label: '利用サービス', selectedCodes: ['1'], unselectedCodes: ['0'], allUnselectedMeaning: 'valid', maxSelections: null, optionOrder: ['a'] }
const column: CodebookColumn = { columnId: 'a', name: 'A', label: 'サービスA', scaleType: 'nominal', role: 'question', valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, multiResponseGroup: null }

describe('MA editor and card', () => {
  it('keeps membership and parent draft together and reverts both without changing saved columns', () => {
    let state = codebookSlice.reducer(undefined, fetchCodebookThunk.pending('r', 'ds'))
    state = codebookSlice.reducer(state, codebookReadAccepted({ datasetId: 'ds', schemaRevision: 1, columns: [column] }, 'r'))
    state = codebookSlice.reducer(state, draftMultiResponseGroupUpdated({ group, columnIds: ['a'] }))
    expect(state.draftColumns[0].multiResponseGroup).toBe('q')
    expect(state.columns[0].multiResponseGroup).toBeNull()
    expect(state.draftMultiResponseGroups).toEqual([group])
    const removed = codebookSlice.reducer(state, draftMultiResponseGroupRemoved('q'))
    expect(removed.draftColumns[0].multiResponseGroup).toBeNull()
    expect(removed.draftMultiResponseGroups).toEqual([])
    state = codebookSlice.reducer(state, draftReverted())
    expect(state.draftMultiResponseGroups).toEqual([])
    expect(state.hasChanges).toBe(false)
  })
  it('switches denominators and requests selection or status without local row selection state', () => {
    const onSelect = vi.fn()
    const summary: MultiResponseSummary = { groupId: 'q', label: '利用サービス', denominators: { total: 5, target: 4, valid: 3, missing: 0, partial: 1, invalid: 0, notApplicable: 1 }, allUnselectedN: 0, totalResponses: 4,
      items: [{ columnId: 'a', name: 'A', label: 'サービスA', selectedN: 2, selectedInSelection: 1, pctRespondent: 200/3, pctResponse: 50 }] }
    // MultiResponseCard 内の ColumnSelect は useCodebook (redux) を使うため Provider が必要
    const initial = store.getState()
    const testStore = configureStore({ reducer: (s = initial) => s, middleware: g => g({ serializableCheck: false }) })
    render(<Provider store={testStore}><MultiResponseCard summary={summary} onSelect={onSelect} /></Provider>)
    expect(screen.getByText('66.7% (2)')).toBeInTheDocument()
    fireEvent.click(screen.getByText('延べ回答ベース'))
    expect(screen.getByText('50.0% (2)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'A サービスAの回答者を選択' }))
    expect(onSelect).toHaveBeenLastCalledWith(['a'], 'any', undefined, false)
    fireEvent.click(screen.getByRole('button', { name: '部分 1' }))
    expect(onSelect).toHaveBeenLastCalledWith([], 'status', 'partial')
    expect(screen.getByText('選択中人数 1')).toBeInTheDocument()
  })
})
