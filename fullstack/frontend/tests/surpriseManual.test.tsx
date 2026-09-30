import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import SurpriseAssociationView from '../src/features/relationships/SurpriseAssociationView'

vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd(['a', 'b'].map(columnId => ({ kind: 'maOption', groupId: 'q', columnId })))}>Choose options</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('runs only on explicit execution with selected columns, scope and revisions', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'manual', dataRevision: 3, selectedRowIds: ['r'] },
    globalObservations: { ...base.globalObservations, scopeMode: 'selected', selectedRowIds: ['r'], activeRowIds: ['r'], totalRowIds: ['r'] },
    codebook: { ...base.codebook, datasetId: 'manual', schemaRevision: 2, columns: ['a', 'b'].map(name => ({
      columnId: name, name, role: 'question', scaleType: 'nominal', multiResponseGroup: 'q',
    })) }, globalVariables: { ...base.globalVariables, activeEntities: null },
  }) as any, middleware: g => g({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ run_id: 'run', pairs: [], pair_matrix: { columns: [], matrix: [] } })
  const view = render(<Provider store={local}><MemoryRouter><SurpriseAssociationView /></MemoryRouter></Provider>)
  expect(post).not.toHaveBeenCalled()
  expect(view.getByTestId('refresh-surprise-btn')).toBeDisabled()
  fireEvent.click(view.getByText('Choose options'))
  expect(post).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByRole('slider'), { key: 'ArrowRight', keyCode: 39 })
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('refresh-surprise-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith('/relationships/surprise', expect.objectContaining({ datasetId: 'manual', columns: ['a', 'b'], rowIds: ['r'],
    expectedSchemaRevision: 2, expectedDataRevision: 3 }))
})
