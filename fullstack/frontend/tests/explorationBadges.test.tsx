import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import SubgroupMiningPage from '../src/features/mining/SubgroupMiningPage'

vi.mock('../src/features/mining/useMiningTargets', () => {
  const React = require('react')
  return {
    useMiningTargets: () => ({
      attributes: ['seg'],
      questions: ['score'],
      ready: true,
      control: React.createElement('div', { 'data-testid': 'mining-targets-mock' }),
    }),
  }
})
vi.mock('../src/features/dataset/useCodebookColumn', () => {
  const columns = [
    { name: 'seg', role: 'attribute', scaleType: 'nominal', label: 'seg' },
    { name: 'score', role: 'question', scaleType: 'ratio', label: 'score' },
  ]
  return { useCodebook: () => ({ schemaRevision: 2, columns, getColumn: () => undefined }) }
})
const stableVariables = { activeVariableIds: ['seg', 'score'], allVariables: ['seg', 'score'], targetVariableId: 'score' }
const stableRowIds: string[] = []
vi.mock('../src/app/store', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    selectOrdinaryVariables: () => stableVariables,
    selectEffectiveRowIds: () => stableRowIds,
  }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const miningPayload = {
  run_id: 'run1',
  summary: { n_subgroup_vars: 1, n_questions: 1, n_tests_run: 1, n_significant_fdr: 0, n_significant_bonferroni: 0, n_insights_after_filters: 1 },
  insights: [
    {
      id: 'ins_001',
      subgroup: { name: 'seg', label: 'seg', type: 'categorical' },
      question: { name: 'score', label: 'score', type: 'numeric' },
      test: { method: 'descriptive_only', statistic: null, p_value: null, q_value: null, significant: false },
      effect: { measure: 'cohens_d', value: 1.2, label: 'large' },
      group_stats: [{ group: 'a', n: 20, mean: 10, sd: 1, median: 10 }],
      direction: { highest_group: 'b', lowest_group: 'a', delta: 10 },
      posthoc: [],
      scores: { stat: 0, effect: 1, practical: 0.5, insight_score: 0.8 },
      narrative: '探索的な差の候補があります',
      warnings: [],
      row_ids: {},
    },
  ],
  analysisMode: 'exploration',
  isExploratory: true,
  candidateSetHash: 'sha256:abc',
  explorationNote: 'この結果は全データ上の探索であり、母集団への確証ではありません',
}

it('classic exploration hides p-values and shows exploration badge with verification entry', async () => {
  const base = store.getState()
  const local = configureStore({
    reducer: () => ({
      ...base,
      selection: { ...base.selection, datasetId: 'd', dataRevision: 1 },
      globalObservations: { ...base.globalObservations, activeRowIds: [] },
    }),
    middleware: (g) => g({ serializableCheck: false }),
  })
  vi.spyOn(api, 'post').mockResolvedValue(miningPayload as any)
  const view = render(<Provider store={local}><MemoryRouter initialEntries={['/mining?tab=classic']}><SubgroupMiningPage /></MemoryRouter></Provider>)
  const { fireEvent, waitFor } = await import('@testing-library/react')
  const tabs = view.container.querySelectorAll('.ant-tabs-tab')
  expect(tabs.length).toBe(2)
  fireEvent.click(tabs[1])
  const runButton = await view.findByTestId('mining-run-button', undefined, { timeout: 8000 })
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(runButton)
  await waitFor(() => expect(api.post).toHaveBeenCalled(), { timeout: 8000 })
  await waitFor(() => expect(view.queryByTestId('exploration-badge')).toBeTruthy(), { timeout: 8000 })
  expect(view.getByTestId('exploration-badge').textContent).toContain('探索的候補')
  expect(view.container.textContent).not.toContain('q=')
  expect(view.getByTestId('mining-to-verification-btn')).toBeTruthy()
})
