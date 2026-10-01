import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import ModelsPage from '../src/features/models/ModelsPage'

vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('raw data forbidden') } }))
vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd([{ columnId: 'a' }])}>MA子Aを追加</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('sends only the explicit MA child and exact scope on manual execution', async () => {
  const base = store.getState()
  const columns = ['a', 'b', 'score'].map(name => ({ name, columnId: name, label: name, role: 'question',
    scaleType: name === 'score' ? 'ratio' : 'nominal', multiResponseGroup: name === 'score' ? null : 'q',
    valueLabels: {}, categoryOrder: [], missingCodes: [] }))
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalVariables: { ...base.globalVariables, allVariables: ['a', 'b', 'score'],
      activeEntities: [{ kind: 'ma', groupId: 'q' }, { kind: 'column', columnId: 'score' }] },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns, multiResponseGroups: [{ groupId: 'q', label: 'Q' }] },
  }
  const local = configureStore({ reducer: () => state as any, middleware: g => g({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const post = vi.spyOn(api, 'post').mockRejectedValue({ message: '学習対象がありません。' })
  const view = render(<Provider store={local}><MemoryRouter><ModelsPage /></MemoryRouter></Provider>)
  expect(post).not.toHaveBeenCalled()
  expect(view.getByTestId('run-model')).toBeDisabled()
  fireEvent.click(view.getByText('MA子Aを追加'))
  fireEvent.click(view.getByTestId('run-model'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models', expect.objectContaining({ features: ['a'], target: 'score',
    rowIds: [], expectedSchemaRevision: 2, expectedDataRevision: 3 })))
  await view.findByText('学習対象がありません。')
  post.mockResolvedValue({ resultId: 'm', modelType: 'decision_tree', taskType: 'regression', features: ['a'], target: 'score',
    trainedRows: 2, scopeCount: 2, ordinaryMissingExcluded: 0, featureImportance: { a: 1 }, diagnostics: {},
    leafMembership: [{ treeIndex: 0, nodeId: 7, rowIds: ['r2', 'r8'] }],
    treeStructures: [{ nodeId: 7, isLeaf: true, count: 2, majority: '12.5', values: [] }],
  })
  fireEvent.click(view.getByTestId('run-model'))
  const leaf = await view.findByRole('button', { name: '葉7の2行を選択' })
  fireEvent.click(leaf)
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'selection/selectionApplied', payload: expect.objectContaining({ rowIds: ['r2', 'r8'] }) }))
  fireEvent.keyDown(leaf, { key: 'Enter' })
  expect(dispatch.mock.calls.filter(([action]: any) => action.type === 'selection/selectionApplied')).toHaveLength(2)
})
