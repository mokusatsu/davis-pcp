import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store, selectionApplied } from '../src/app/store'
import { api } from '../src/api/client'
import MultiResponseStatistics from '../src/features/dataset/MultiResponseStatistics'
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('shows server MA denominators, selects canonical matches and preserves an empty scope', async () => {
  const base = store.getState()
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 2, selectedRowIds: ['r2'] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'ma', groupId: 'services' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 3, isLoading: false,
      columns: ['A', 'B'].map(name => ({ columnId: name, name, role: 'question', multiResponseGroup: 'services' })),
      multiResponseGroups: [{ groupId: 'services', label: '利用サービス' }] } } as any
  const local = configureStore({ reducer: () => state, middleware: g => g({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const post = vi.spyOn(api, 'post').mockImplementation(async path => path.endsWith('/matches') ? { rowIds: ['r2', 'r9'] } as any : {
    groups: [{ groupId: 'services', label: '利用サービス', denominators: { total: 4, target: 4, valid: 3, partial: 1, invalid: 0, missing: 0, notApplicable: 0 },
      allUnselectedN: 1, totalResponses: 2, items: [{ columnId: 'A', name: 'A', label: 'サービスA', selectedN: 2, selectedInSelection: 1, pctRespondent: 200 / 3, pctResponse: 100 }] }],
  } as any)
  const content = (rowIds: string[]) => <Provider store={local}><MemoryRouter><MultiResponseStatistics rowIds={rowIds} /></MemoryRouter></Provider>
  const view = render(content(['r1', 'r2', 'r7', 'r9']))
  await waitFor(() => expect(view.getByTestId('ma-card-services')).toHaveTextContent('66.7% (2)'))
  expect(post).toHaveBeenCalledWith('/summaries/multi-response', expect.objectContaining({ groupIds: ['services'], expectedDataRevision: 2, expectedSchemaRevision: 3, selectedRowIds: ['r2'] }))
  fireEvent.click(view.getByRole('button', { name: 'A サービスAの回答者を選択' }))
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: selectionApplied.type, payload: expect.objectContaining({ rowIds: ['r2', 'r9'] }) })))
  expect(post).toHaveBeenCalledWith('/datasets/d/matches', expect.objectContaining({ optionColumnIds: ['A'], predicate: 'any', rowIds: ['r1', 'r2', 'r7', 'r9'] }))
  let finishMatch!: (value: any) => void
  post.mockImplementationOnce(async () => await new Promise(resolve => { finishMatch = resolve }))
  dispatch.mockClear()
  await waitFor(() => expect(view.getByRole('button', { name: 'A サービスAの回答者を選択' })).toBeEnabled())
  fireEvent.click(view.getByRole('button', { name: 'A サービスAの回答者を選択' }))
  await waitFor(() => expect(finishMatch).toBeDefined())
  view.rerender(content([]))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/summaries/multi-response', expect.objectContaining({ rowIds: [] })))
  await act(async () => { finishMatch({ rowIds: ['obsolete'] }) })
  expect(dispatch).not.toHaveBeenCalled()
  post.mockImplementationOnce(async () => await new Promise(resolve => { finishMatch = resolve }))
  await waitFor(() => expect(view.getByRole('button', { name: 'A サービスAの回答者を選択' })).toBeEnabled())
  fireEvent.click(view.getByRole('button', { name: 'A サービスAの回答者を選択' }))
  view.unmount()
  await act(async () => { finishMatch({ rowIds: ['after-unmount'] }) })
  expect(dispatch).not.toHaveBeenCalled()
})
