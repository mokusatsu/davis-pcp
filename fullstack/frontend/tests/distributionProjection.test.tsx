import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import DistributionPage from '../src/features/distribution/DistributionPage'

const load = vi.hoisted(() => vi.fn(() => null))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: load }))
vi.mock('../src/features/common/FocusMode', () => ({ useFocusMode: () => ({ focused: false }), FocusTarget: ({ children }: any) => children, FocusEnterButton: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); load.mockClear() })

it('renders cards without Arrow data and uses canonical server matches for selection', async () => {
  const state = store.getState()
  const selected = ['r1']
  const local = configureStore({ reducer: () => ({ ...state,
    selection: { ...state.selection, datasetId: 'ds', allRowIds: selected, activeRowIds: selected, selectedRowIds: selected },
    globalObservations: { ...state.globalObservations, activeRowIds: selected, totalRowIds: selected },
    codebook: { ...state.codebook, datasetId: 'ds', schemaRevision: 2, columns: [{ columnId: 'q', name: 'Q', label: '満足度', role: 'question', scaleType: 'nominal', valueLabels: { '1': '満足' }, missingCodes: [], categoryOrder: ['1'] }] },
  }) as any })
  const dispatch = vi.spyOn(local, 'dispatch')
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => {
    if (path.endsWith('/column-matches')) return { schemaRevision: 2, rowIds: ['r1'], count: 1 } as any
    return { columns: { Q: { denominators: { total: 1, target: 1, valid: 1, missing: 0, notApplicable: 0 }, distribution: [{ code: '1', label: '満足', count: 1, percentageValid: 100, percentageTotal: 100 }] } }, selectedCountByCode: { Q: { '1': 1 } } } as any
  })
  render(<Provider store={local}><MemoryRouter><DistributionPage /></MemoryRouter></Provider>)
  expect(await screen.findByText('1選択中')).toBeInTheDocument()
  expect(load.mock.calls.every(args => args[0] === null)).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'sliders PCP' }))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/datasets/ds/column-matches', expect.objectContaining({ columnId: 'q', code: '1', rowIds: ['r1'] })))
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: ['r1'] }) })))
})
