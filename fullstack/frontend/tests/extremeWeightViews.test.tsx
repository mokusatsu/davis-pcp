import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import DistributionPage from '../src/features/distribution/DistributionPage'
import LikertComparisonPage from '../src/features/distribution/LikertComparisonPage'

vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const warning = { code: 'WEIGHT_TOTAL_OUT_OF_RANGE', message: '範囲外の絶対加重件数は表示できません。比率・平均は正規化したウェイトで計算しています。' }
const response = {
  weightStatus: 'applied', weightApplied: true, weightColumn: 'w', unweightedN: 8,
  weightedN: null, weightedNStatus: 'out_of_range', warnings: [warning],
  columns: { Q: {
    denominators: { total: 8, target: 8, valid: 8, missing: 0, notApplicable: 0 },
    distribution: [
      { code: '1', label: 'low', count: 3, percentageValid: 37.5, percentageTotal: 37.5 },
      { code: '2', label: 'middle', count: 3, percentageValid: 37.5, percentageTotal: 37.5 },
      { code: '3', label: 'high', count: 2, percentageValid: 25, percentageTotal: 25 },
    ],
    auxiliaryStats: { mean: 1.875 },
    weighted: { weightedN: null, weightedNStatus: 'out_of_range', weightedMean: 1.875,
      weightMissingCount: 0, warnings: [warning], distribution: [
        { code: '1', weightedCount: null, weightedCountStatus: 'out_of_range', weightedPct: 37.5 },
        { code: '2', weightedCount: null, weightedCountStatus: 'out_of_range', weightedPct: 37.5 },
        { code: '3', weightedCount: null, weightedCountStatus: 'out_of_range', weightedPct: 25 },
      ] },
  } },
}

function mount(node: React.ReactElement) {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'extreme', dataRevision: 1, allRowIds: ['r1'], activeRowIds: ['r1'] },
    globalVariables: { ...base.globalVariables, datasetId: 'extreme', weightColumnId: 'w', activeEntities: [{ kind: 'column', columnId: 'Q' }] },
    codebook: { ...base.codebook, datasetId: 'extreme', schemaRevision: 2, isLoading: false, columns: [
      { columnId: 'Q', name: 'Q', role: 'question', scaleType: 'ordinal', categoryOrder: ['1', '2', '3'] },
      { columnId: 'w', name: 'w', role: 'weight', scaleType: 'ratio' },
    ] },
  }
  const local = configureStore({ reducer: (s = state) => s, middleware: g => g({ serializableCheck: false }) })
  return render(<Provider store={local}><MemoryRouter>{node}</MemoryRouter></Provider>)
}

it('transports serialized range status and warnings through DistributionPage', async () => {
  vi.spyOn(api, 'post').mockResolvedValue(JSON.parse(JSON.stringify(response)))
  const view = mount(<DistributionPage />)
  await waitFor(() => expect(view.getByTestId('weight-note')).toHaveTextContent('加重Σw=範囲外'))
  expect(view.getByTestId('weight-range-warning')).toHaveTextContent(warning.message)
  expect(view.getByTestId('category-Q-1')).toHaveTextContent('加重37.5% (範囲外)')
  expect(view.container).toHaveTextContent('加重平均: 1.88')
})

it('transports range status to Likert and never changes an unavailable count to zero', async () => {
  vi.spyOn(api, 'post').mockResolvedValue(JSON.parse(JSON.stringify(response)))
  const view = mount(<LikertComparisonPage />)
  await waitFor(() => expect(view.getByTestId('likert-weight-meta')).toHaveTextContent('加重Σw=範囲外'))
  expect(view.getByText(warning.message)).toBeInTheDocument()
  fireEvent.click(view.getByRole('radio', { name: '加重', exact: true }))
  await waitFor(() => expect(view.getByRole('button', { name: 'low: 範囲外 (37.5%)', exact: true })).toBeInTheDocument())
  expect(view.getByRole('button', { name: 'high: 範囲外 (25.0%)', exact: true })).toBeInTheDocument()
})
