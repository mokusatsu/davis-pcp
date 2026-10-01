import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import FeatureRankingPage from '../src/features/mining/FeatureRankingPage'

vi.mock('../src/app/store', async importOriginal => {
  const variables = { activeVariableIds: ['x', 'y'], allVariables: ['x', 'y'], targetVariableId: 'y' }
  return { ...await importOriginal<any>(), selectOrdinaryVariables: () => variables }
})
vi.mock('../src/features/dataset/useCodebookColumn', () => {
  const columns = [{ name: 'x', role: 'question', scaleType: 'ratio' }, { name: 'y', role: 'attribute', scaleType: 'nominal' }]
  return { useCodebook: () => ({ schemaRevision: 2, columns, getColumn: () => undefined }) }
})
vi.mock('../src/features/pcp/useDatasetColumns', () => {
  return { useColumnarData: () => { throw new Error('Ranking must not load raw columns') } }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('requires explicit execution and preserves an empty scope', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } },
  }), middleware: g => g({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockRejectedValue({ message: '対象データ行が0件です。' })
  const view = render(<Provider store={local}><MemoryRouter><FeatureRankingPage /></MemoryRouter></Provider>)
  await waitFor(() => expect(view.getByTestId('compute-ranking-btn')).not.toBeDisabled())
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('compute-ranking-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith('/mining/feature-ranking', expect.objectContaining({ featureColumns: ['x'],
    targetColumn: 'y', activeRowIds: [], expectedSchemaRevision: 2, expectedDataRevision: 3 }))
  await view.findByText('対象データ行が0件です。')
})
