import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import PcaPage from '../src/features/pca/PcaPage'

vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ focused: false, isTargetActive: () => false }) }))
vi.mock('../src/features/pca/BiplotView', () => ({ BiplotView: () => null }))
vi.mock('../src/features/pca/PcaMatrixPlot', () => ({ PcaMatrixPlot: () => null }))
vi.mock('../src/features/pca/ScreePlot', () => ({ ScreePlot: () => null }))
vi.mock('../src/features/pca/LoadingTable', () => ({ LoadingTable: () => null }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('raw data forbidden') } }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('runs PCA manually with ordinary columns and preserves empty scope', async () => {
  const base = store.getState()
  const columns = ['x', 'y', 'ma'].map(name => ({ name, columnId: name, label: name, role: 'question',
    scaleType: 'ratio', multiResponseGroup: name === 'ma' ? 'q' : null, valueLabels: {}, categoryOrder: [], missingCodes: [] }))
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalVariables: { ...base.globalVariables, allVariables: ['x', 'y', 'ma'], activeEntities: null },
    globalObservations: { ...base.globalObservations, activeRowIds: [] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns },
  }
  const local = configureStore({ reducer: () => state as any, middleware: g => g({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockRejectedValue({ message: '対象行がありません。' })
  const view = render(<Provider store={local}><MemoryRouter><PcaPage /></MemoryRouter></Provider>)
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByTestId('pca-run-button'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/pca', expect.objectContaining({ columns: ['x', 'y'], rowIds: [],
    expectedSchemaRevision: 2, expectedDataRevision: 3 })))
  await view.findByText('対象行がありません。')
})
