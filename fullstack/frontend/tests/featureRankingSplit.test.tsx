import { cleanup, render } from '@testing-library/react'
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

const payload = {
  scopeCount: 60, usedRows: 60, ordinaryMissingExcluded: 0, taskType: 'classification',
  evaluatedVariables: ['x', 'y'], redundancyMatrix: [[0, 0.1], [0.1, 0]], suggestedTopK: 2, executionTimeMs: 5,
  rankings: [
    { variable: 'x', bordaScore: 8, overallRank: 1, recommendationTier: 'high', meanRedundancy: 0.1,
      scores: { randomForest: { rawScore: 0.7, normalizedScore: 1, rank: 1 } } },
    { variable: 'y', bordaScore: 4, overallRank: 2, recommendationTier: 'medium', meanRedundancy: 0.1,
      scores: { randomForest: { rawScore: 0.3, normalizedScore: 0.4, rank: 2 } } },
  ],
  methodDisplay: {
    relieff: { displayName: 'ReliefF', formula: '教師ありReliefF近似', scope: 'train', deprecatedAlias: '' },
    mutualInfo: { displayName: '相互情報量', formula: 'mi', scope: 'train', deprecatedAlias: '' },
  },
  importance: {
    mdi: [{ featureName: 'x', importance: 0.7, rank: 1 }, { featureName: 'y', importance: 0.3, rank: 2 }],
    permutation_train: [{ featureName: 'y', importanceMean: 0.28, importanceStd: 0.02, rank: 1 },
                        { featureName: 'x', importanceMean: 0.19, importanceStd: 0.03, rank: 2 }],
  },
  importanceMetadata: {
    mdi: { available: true, scope: 'train', model: 'RandomForest', criterion: 'gini' },
    permutation_train: { available: true, scope: 'train', repeats: 5, seed: 42 },
  },
  metadata: { warnings: ['訓練データ上の重要度は予測への貢献であり、因果効果ではない', '相関した変数間では重要度が分散する場合がある'] },
}

it('renders MDI and permutation as separate columns with warnings and tooltips', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } },
  }), middleware: g => g({ serializableCheck: false }) })
  vi.spyOn(api, 'post').mockResolvedValue(payload)
  const view = render(<Provider store={local}><MemoryRouter><FeatureRankingPage /></MemoryRouter></Provider>)
  const { fireEvent, waitFor } = await import('@testing-library/react')
  fireEvent.click(view.getByTestId('compute-ranking-btn'))
  await waitFor(() => expect(view.getByTestId('importance-split')).toBeTruthy())
  const chartColumns = view.getByTestId('ranking-chart-stack').children
  expect(chartColumns).toHaveLength(2)
  for (const col of Array.from(chartColumns)) {
    expect(col).toHaveClass('ant-col-24')
    expect(col.className).not.toMatch(/ant-col-(?:xl|lg)-12/)
  }
  expect(view.getByTestId('importance-warnings').textContent).toContain('因果効果ではない')
  expect(view.container.textContent).toContain('Permutation Importance')
  expect(view.container.textContent).toContain('0.280')
  // MDI and permutation orders differ: no mixed ranking
  const split = view.getByTestId('importance-split').textContent ?? ''
  expect(split.indexOf('0.700')).toBeLessThan(split.indexOf('0.300'))
})

it('shows teacher-only notice instead of zero bars when permutation is unavailable', async () => {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } },
  }), middleware: g => g({ serializableCheck: false }) })
  vi.spyOn(api, 'post').mockResolvedValue({
    ...payload,
    importance: { ...payload.importance, permutation_train: [] },
    importanceMetadata: { ...payload.importanceMetadata, permutation_train: { available: false, scope: 'train', reason: '教師ありのみ' } },
  })
  const view = render(<Provider store={local}><MemoryRouter><FeatureRankingPage /></MemoryRouter></Provider>)
  const { fireEvent, waitFor } = await import('@testing-library/react')
  fireEvent.click(view.getByTestId('compute-ranking-btn'))
  await waitFor(() => expect(view.getByTestId('importance-split')).toBeTruthy())
  expect(view.getByTestId('importance-split').textContent).toContain('教師ありのみ')
})
