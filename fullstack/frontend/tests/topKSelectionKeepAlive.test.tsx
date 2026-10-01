import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store, activeEntitiesSet, variableOrderReordered } from '../src/app/store'
import { api } from '../src/api/client'
import FeatureRankingPage from '../src/features/mining/FeatureRankingPage'
import KeepAliveOutlet from '../src/app/KeepAliveOutlet'

const stableVariables = { activeVariableIds: ['x', 'y'], allVariables: ['x', 'y'], targetVariableId: 'y' }
const stableRowIds: string[] = []

vi.mock('../src/app/store', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, selectOrdinaryVariables: () => stableVariables, selectEffectiveRowIds: () => stableRowIds }
})
const dictionaryColumns = [
  { name: 'x', columnId: 'cx', role: 'question', scaleType: 'ratio', label: 'x' },
  { name: 'y', columnId: 'cy', role: 'attribute', scaleType: 'nominal', label: 'y' },
]
vi.mock('../src/features/dataset/useCodebookColumn', () => {
  return { useCodebook: () => ({ schemaRevision: 2, columns: dictionaryColumns, getColumn: () => undefined }) }
})
vi.mock('../src/features/pcp/useDatasetColumns', () => {
  return { useColumnarData: () => { throw new Error('Ranking must not load raw columns') } }
})

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const payload = {
  scopeCount: 2, usedRows: 2, ordinaryMissingExcluded: 0, taskType: 'classification',
  evaluatedVariables: ['x', 'y'], redundancyMatrix: [[0, 0.1], [0.1, 0]], suggestedTopK: 1, executionTimeMs: 5,
  rankings: [
    {
      variable: 'x', bordaScore: 8, overallRank: 1, recommendationTier: 'high', meanRedundancy: 0.1,
      scores: { randomForest: { rawScore: 0.7, normalizedScore: 1, rank: 1 } },
    },
  ],
  methodDisplay: {},
  importance: { mdi: [{ featureName: 'x', importance: 0.7, rank: 1 }], permutation_train: [] },
  importanceMetadata: {
    mdi: { available: true, scope: 'train', model: 'RandomForest', criterion: 'gini' },
    permutation_train: { available: false, scope: 'train', reason: '教師ありのみ' },
  },
  metadata: { warnings: [] },
}

function localStore() {
  const base = store.getState()
  return configureStore({
    reducer: () => ({
      ...base,
      selection: { ...base.selection, datasetId: 'd', dataRevision: 3, selectedRowIds: ['r1'] },
      globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } },
      globalVariables: {
        ...base.globalVariables,
        datasetId: 'd',
        allVariables: ['x', 'y'],
        activeEntities: [{ kind: 'column', columnId: 'cx' }, { kind: 'column', columnId: 'cy' }],
        variableOrder: ['x', 'y'],
        variableMeta: { x: { columnId: 'cx' }, y: { columnId: 'cy' } },
      },
      codebook: { ...(base as any).codebook, columns: dictionaryColumns },
    }),
    middleware: (g) => g({ serializableCheck: false }),
  })
}

it('Top-K apply keeps rowIds and axis order, and KeepAlive preserves the ranking tab', async () => {
  const local = localStore()
  const snapshots: string[] = []
  const unsubscribe = local.subscribe(() => {
    const state = local.getState() as any
    snapshots.push(JSON.stringify([state.selection?.selectedRowIds, state.globalVariables?.variableOrder]))
  })
  vi.spyOn(api, 'post').mockResolvedValue(payload as any)
  const view = render(
    <Provider store={local}>
      <MemoryRouter initialEntries={['/mining']}>
        <FeatureRankingPage />
        <div style={{ display: 'none' }}><KeepAliveOutlet /></div>
      </MemoryRouter>
    </Provider>,
  )
  const { fireEvent, waitFor } = await import('@testing-library/react')
  fireEvent.click(view.getByTestId('compute-ranking-btn'))
  await waitFor(() => expect(view.getByTestId('apply-to-active-vars-btn')).toBeTruthy())
  const beforeRows = (local.getState() as any).selection.selectedRowIds
  fireEvent.click(view.getByTestId('apply-to-active-vars-btn'))
  await waitFor(() => expect(snapshots.length).toBeGreaterThan(0))
  const after = local.getState() as any
  expect(after.selection.selectedRowIds).toEqual(beforeRows)
  const activeIds = (after.globalVariables.activeEntities ?? []).map((e: any) => e.columnId ?? e.groupId)
  expect(activeIds).toContain('cx')
  expect(after.globalVariables.variableOrder[0]).toBe('x')
  expect(view.getByTestId('keep-alive-outlet-container')).toBeTruthy()
  expect(activeEntitiesSet).toBeTruthy()
  expect(variableOrderReordered).toBeTruthy()
  unsubscribe()
})
