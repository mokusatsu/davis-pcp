import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import MultiResponseStatistics from '../src/features/dataset/MultiResponseStatistics'
import MultiResponseBarChart from '../src/features/barchart/MultiResponseBarChart'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const WEIGHT_COLUMN = { columnId: 'w', name: 'WEIGHT', role: 'weight', scaleType: 'ratio' }

const item = {
  columnId: 'A', name: 'A', label: 'サービスA',
  selectedN: 2, selectedWeighted: 3.5, selectedInSelection: 1,
  pctRespondent: 3.5 / 5.5 * 100, pctRespondentUnweighted: 200 / 3,
  pctResponse: 3.5 / 6.5 * 100, pctResponseUnweighted: 200 / 3,
}

const weightedResponse = {
  weightStatus: 'applied', weightColumn: 'WEIGHT', weightColumnId: 'w',
  weightedN: 6, weightMissingCount: 1, weightZeroCount: 0,
  warnings: [{ code: 'MA_WEIGHT_APPLIED', message: '回答者重みで加重集計しました（設計効果は考慮しません）。' }],
  groups: [{
    groupId: 'services', label: '利用サービス',
    denominators: { total: 4, target: 4, valid: 3, partial: 1, invalid: 0, missing: 0, notApplicable: 0 },
    allUnselectedN: 1, totalResponses: 2, weightedValidN: 5.5, weightedResponses: 6.5, items: [item],
  }],
}

function mount(node: React.ReactElement, weightColumnId: string | null = 'w') {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 2, selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: ['r1', 'r2'] } },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'ma', groupId: 'services' }], weightColumnId },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 3, isLoading: false,
      columns: [
        { columnId: 'A', name: 'A', role: 'question', scaleType: 'nominal', multiResponseGroup: 'services' },
        { columnId: 'B', name: 'B', role: 'question', scaleType: 'nominal', multiResponseGroup: 'services' },
        WEIGHT_COLUMN,
      ],
      multiResponseGroups: [{ groupId: 'services', label: '利用サービス' }] } }
  const local = configureStore({ reducer: (s = state) => s, middleware: g => g({ serializableCheck: false }) })
  return render(<Provider store={local}><MemoryRouter>{node}</MemoryRouter></Provider>)
}

it('sends the shared weight column and shows the weighted ratio beside the plain one', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(weightedResponse as any)
  const view = mount(<MultiResponseStatistics rowIds={['r1', 'r2']} />)
  await waitFor(() => expect(view.getByTestId('ma-card-services')).toHaveTextContent('63.6% (2)'))
  expect(post).toHaveBeenCalledWith('/summaries/multi-response',
    expect.objectContaining({ weightColumn: 'WEIGHT', groupIds: ['services'] }))
  expect(view.getByTestId('ma-weighted-services')).toHaveTextContent('加重')
  expect(view.getByTestId('ma-weighted-denominator-services')).toHaveTextContent('5.5')
  const plain = view.getByTestId('ma-item-unweighted-services-A')
  expect(plain).toHaveTextContent(/非加重 66\.7%/)
  expect(plain).toHaveTextContent('加重計 3.5')
})

it('shows the unsupported alert and the unweighted ratios when the weight cannot be applied', async () => {
  const unweighted = {
    ...weightedResponse, weightStatus: 'unsupported', weightedN: null,
    weightMissingCount: 0, weightedResponses: null,
    warnings: [{ code: 'WEIGHT_UNSUPPORTED', message: 'MA設問はウェイト列に指定できません。' }],
    groups: [{ ...weightedResponse.groups[0], weightedValidN: null,
      items: [{ ...item, selectedWeighted: 2, pctRespondent: item.pctRespondentUnweighted }] }],
  }
  vi.spyOn(api, 'post').mockResolvedValue(unweighted as any)
  const view = mount(<MultiResponseStatistics rowIds={['r1', 'r2']} />)
  await waitFor(() => expect(view.getByTestId('weight-unsupported-alert')).toBeInTheDocument())
  expect(view.queryByTestId('ma-weighted-services')).toBeNull()
  expect(view.queryByTestId('ma-item-unweighted-services-A')).toBeNull()
  expect(view.getByTestId('ma-card-services')).toHaveTextContent('66.7% (2)')
})

it('draws weighted bars with both ratios in the MA bar chart', async () => {
  const strata = [{ code: 'F', label: '女性', summary: weightedResponse.groups[0] }]
  vi.spyOn(api, 'post').mockResolvedValue({ ...weightedResponse, attributeMissingExcluded: 0, strata } as any)
  const view = mount(<MultiResponseBarChart />)
  const label = await view.findByText(/加重3\.5 \/ 2人 \/ 63\.6%/)
  expect(label).toHaveTextContent('非加重 66.7%')
  expect(view.getByText(/加重N 5\.5/)).toBeInTheDocument()
  expect(view.getByText(/回答者重み WEIGHT を適用/)).toBeInTheDocument()
})
