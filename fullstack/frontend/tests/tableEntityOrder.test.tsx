import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import TablePage from '../src/features/table/TablePage'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('requests Table entities in shared order without changing off-page selection', async () => {
  const base = store.getState()
  const columns = ['a', 'b', 'x'].map(name => ({ name, columnId: name, label: name, role: 'question', scaleType: 'nominal',
    multiResponseGroup: name === 'x' ? null : 'q', valueLabels: {}, missingCodes: [], categoryOrder: [] }))
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1, selectedRowIds: ['outside'] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'x' }, { kind: 'ma', groupId: 'q' }] },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r1', 'outside'] },
    codebook: { ...base.codebook, datasetId: 'd', columns, multiResponseGroups: [{ groupId: 'q', label: 'Q' }] },
  }
  const local = configureStore({ reducer: () => state as any, middleware: g => g({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const post = vi.spyOn(api, 'post').mockResolvedValue({ rows: [], entities: [], total: 0 })
  render(<Provider store={local}><MemoryRouter><TablePage /></MemoryRouter></Provider>)
  await waitFor(() => expect(post).toHaveBeenCalledWith('/datasets/d/table-view', expect.objectContaining({
    entityIds: [{ kind: 'column', columnId: 'x' }, { kind: 'ma', groupId: 'q' }],
  })))
  expect(dispatch.mock.calls.some(([action]: any) => action?.type === 'selection/selectionApplied')).toBe(false)
  expect(local.getState().selection.selectedRowIds).toEqual(['outside'])
})
