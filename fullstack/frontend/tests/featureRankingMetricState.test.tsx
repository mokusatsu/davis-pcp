import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeEntitiesSet, store, variableOrderReordered } from '../src/app/store'
import { api } from '../src/api/client'
import FeatureRankingPage, { type FeatureRankingResponse, type MetricScoreItem, type VariableRankItem } from '../src/features/mining/FeatureRankingPage'

// Keep real form controls and result projections; chart rendering has separate coverage.
vi.mock('../src/features/charts/EChart', () => ({ default: ({ testId, option }: any) =>
  <div data-testid={testId}>{JSON.stringify(option.yAxis?.data ?? [])}</div> }))

const featureNames = ['alpha', 'beta', 'gamma', 'delta']
const columns = [...featureNames, 'target'].map(name => ({ columnId: name, name, label: name,
  role: 'question', scaleType: name === 'target' ? 'nominal' : 'ratio' }))
const methodDisplay = Object.fromEntries(['relieff', 'mutualInfo', 'randomForest', 'fStatistic', 'pcaDispersion']
  .map(name => [name, { displayName: name, formula: name, scope: 'train', deprecatedAlias: '' }]))
const score = (normalizedScore: number, rank: number): MetricScoreItem => ({ rawScore: normalizedScore, normalizedScore, rank })
function row(variable: string, overallRank: number, scores: VariableRankItem['scores']): VariableRankItem {
  return { variable, overallRank, bordaScore: 10 - overallRank, recommendationTier: 'high', meanRedundancy: 0, scores }
}
function response(rankings = [
  row('alpha', 1, { relieff: score(1, 1), randomForest: score(.2, 2) }),
  row('beta', 2, { relieff: score(.5, 2), randomForest: score(1, 1) }),
  row('gamma', 3, { relieff: score(0, 3), randomForest: score(0, 3) }),
], overrides: Partial<FeatureRankingResponse> = {}): FeatureRankingResponse {
  return { scopeCount: 20, usedRows: 20, ordinaryMissingExcluded: 0, target: 'target', taskType: 'classification',
    evaluatedVariables: rankings.map(r => r.variable), redundancyMatrix: rankings.map(() => rankings.map(() => 0)),
    rankings, methodDisplay, suggestedTopK: 1, executionTimeMs: 5, evidenceClass: 'test', ...overrides }
}
function mount() {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns },
    globalVariables: { ...base.globalVariables, targetVariableId: 'target',
      activeEntities: columns.map(c => ({ kind: 'column', columnId: c.columnId })) },
  }
  const local = configureStore({ reducer: () => state, middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  render(<Provider store={local}><MemoryRouter><FeatureRankingPage /></MemoryRouter></Provider>)
  return { dispatch }
}
async function run() {
  fireEvent.click(screen.getByTestId('compute-ranking-btn'))
  await waitFor(() => expect(screen.getByTestId('compute-ranking-btn')).not.toHaveClass('ant-btn-loading'))
  await screen.findByTestId('top-k-action-bar')
}
function metricSelect() { return screen.getByTestId('ranking-metric-select') }
function openMetrics() {
  fireEvent.mouseDown(within(metricSelect()).getByRole('combobox'))
  return Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content'))
}
function chooseMetric(label: string) {
  const option = openMetrics().find(option => option.textContent === label)
  expect(option, `metric ${label} is available`).toBeTruthy()
  fireEvent.click(option!)
}
function topK() {
  return Array.from(screen.getByTestId('top-k-action-bar').querySelectorAll('.ant-tag')).map(tag => tag.textContent)
}
function expectApplied(dispatch: ReturnType<typeof vi.spyOn>, names: string[]) {
  fireEvent.click(screen.getByTestId('apply-to-active-vars-btn'))
  expect(dispatch).toHaveBeenCalledWith(activeEntitiesSet(names.map(columnId => ({ kind: 'column', columnId }))))
  expect(dispatch).toHaveBeenCalledWith(variableOrderReordered([...names, ...columns.map(c => c.name).filter(name => !names.includes(name))]))
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('completed feature-ranking metric state', () => {
  it('keeps an old RF sort attached to its completed run, then resets it after rerunning without RF and applies Borda Top-K', async () => {
    let finish!: (value: FeatureRankingResponse) => void
    const pending = new Promise<FeatureRankingResponse>(resolve => { finish = resolve })
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(response()).mockReturnValueOnce(pending).mockResolvedValueOnce(response())
    const { dispatch } = mount()
    await run()
    chooseMetric('Random Forest順')
    expect(topK()).toEqual(['beta'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Random Forest (MDI)' }))
    expect(metricSelect()).toHaveTextContent('Random Forest順')
    expect(topK()).toEqual(['beta'])
    expect(screen.getByText('現在の入力と異なる実行済み結果です。再実行すると更新されます。')).toBeVisible()
    fireEvent.click(screen.getByTestId('compute-ranking-btn'))
    expect(post).toHaveBeenLastCalledWith('/mining/feature-ranking', expect.objectContaining({
      methods: ['relieff', 'mutual_info', 'f_statistic'], seed: 42, usePermutationImportance: true,
    }))
    expect(metricSelect()).toHaveTextContent('Random Forest順')
    await act(async () => finish(response([
      row('alpha', 1, { relieff: score(.5, 2) }),
      row('beta', 2, { relieff: score(1, 1) }),
      row('gamma', 3, { relieff: score(0, 3) }),
    ])))
    expect(metricSelect()).toHaveTextContent('統合Borda順')
    expect(topK()).toEqual(['alpha'])
    expect(openMetrics().map(o => o.textContent)).toEqual(['統合Borda順', 'ReliefF順'])
    fireEvent.keyDown(within(metricSelect()).getByRole('combobox'), { key: 'Escape' })
    expectApplied(dispatch, ['alpha'])

    // A discarded invalid choice must not silently reappear when that method returns.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Random Forest (MDI)' }))
    await run()
    expect(metricSelect()).toHaveTextContent('統合Borda順')
    expect(topK()).toEqual(['alpha'])
  })

  it('preserves a valid explicit RF choice when permutation is unavailable and methods are edited before rerun', async () => {
    const next = response([
      row('alpha', 1, { randomForest: score(.2, 2) }),
      row('beta', 2, { randomForest: score(0, 3) }),
      row('gamma', 3, { randomForest: score(1, 1) }),
    ], { importance: { mdi: [], permutation_train: [] }, importanceMetadata: {
      mdi: { available: true }, permutation_train: { available: false, reason: 'insufficient_rows' },
    } })
    vi.spyOn(api, 'post').mockResolvedValueOnce(response()).mockResolvedValueOnce(next)
    const { dispatch } = mount()
    await run()
    chooseMetric('Random Forest順')
    fireEvent.click(screen.getByRole('checkbox', { name: /相互情報量 \/ 平均絶対相関/ }))
    await run()
    expect(metricSelect()).toHaveTextContent('Random Forest順')
    expect(topK()).toEqual(['gamma'])
    expect(openMetrics().map(o => o.textContent)).toEqual(['統合Borda順', 'Random Forest順'])
    fireEvent.keyDown(within(metricSelect()).getByRole('combobox'), { key: 'Escape' })
    expectApplied(dispatch, ['gamma'])
  })

  it('sorts authoritative method ranks despite rounded-score ties, retains true ties, and excludes unavailable rows from Top-K', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(response([
      row('delta', 1, { fStatistic: null }),
      row('alpha', 2, { fStatistic: score(.5, 3) }),
      row('gamma', 3, { fStatistic: score(.5, 1.5) }),
      row('beta', 4, { fStatistic: score(.5, 1.5) }),
    ], { suggestedTopK: 4 }))
    const { dispatch } = mount()
    await run()
    chooseMetric('ANOVA F順')
    expect(topK()).toEqual(['gamma', 'beta', 'alpha'])
    expect(screen.getByTestId('ranking-bars-chart')).toHaveTextContent('["gamma","beta","alpha","delta"]')
    expect(screen.getByTestId('ranking-table-card')).toHaveTextContent('delta')
    expect(screen.getByTestId('top-k-action-bar')).toHaveTextContent('この指標にスコアのある 3 変数のみ選択対象です')
    expectApplied(dispatch, ['gamma', 'beta', 'alpha'])
    chooseMetric('統合Borda順')
    expect(topK()).toEqual(['delta', 'alpha', 'gamma', 'beta'])
  })

  it('offers real zero scores while excluding absent, null and nonfinite metrics even when methodDisplay lists them', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(response([
      row('alpha', 1, { relieff: null, randomForest: score(NaN, 1), fStatistic: score(0, 1), pcaDispersion: score(.5, Infinity) }),
      row('beta', 2, { randomForest: score(Infinity, 2), fStatistic: null }),
    ]))
    mount()
    await run()
    expect(openMetrics().map(o => o.textContent)).toEqual(['統合Borda順', 'ANOVA F順'])
    fireEvent.click(screen.getByText('ANOVA F順', { selector: '.ant-select-item-option-content' }))
    expect(topK()).toEqual(['alpha'])
  })

  it('uses unsupervised proxy labels and completed PCA scores, never teacher-only or permutation sorts', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(response([
      row('alpha', 1, { relieff: score(1, 1), mutualInfo: score(0, 2), pcaDispersion: score(0, 2) }),
      row('beta', 2, { relieff: score(0, 2), mutualInfo: score(1, 1), pcaDispersion: score(1, 1) }),
    ], { taskType: 'unsupervised', importanceMetadata: {
      mdi: { available: false }, permutation_train: { available: false, reason: '教師ありのみ' },
    } }))
    mount()
    await run()
    expect(screen.getByRole('combobox', { name: '上位Kの評価指標' })).toBeInTheDocument()
    expect(metricSelect()).toHaveStyle({ width: '300px', maxWidth: '100%', minWidth: '0' })
    expect(metricSelect().parentElement).toHaveStyle({ display: 'flex', flexWrap: 'wrap' })
    expect(screen.getByTestId('apply-to-active-vars-btn')).toHaveStyle({ whiteSpace: 'normal', height: 'auto', minHeight: '32px', maxWidth: '100%' })
    expect(openMetrics().map(o => o.textContent)).toEqual([
      '統合Borda順', '分散（教師なし代理指標）順', '平均絶対相関（教師なし代理指標）順', 'PCA分散順',
    ])
    fireEvent.click(screen.getByText('平均絶対相関（教師なし代理指標）順', { selector: '.ant-select-item-option-content' }))
    expect(metricSelect()).toHaveAttribute('title', '平均絶対相関（教師なし代理指標）順')
    chooseMetric('PCA分散順')
    expect(topK()).toEqual(['beta'])
  })

  it('keeps Borda as the only sort when every individual metric is unavailable', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(response([
      row('alpha', 1, { randomForest: null, fStatistic: null, pcaDispersion: null }),
      row('beta', 2, {}),
    ]))
    mount()
    await run()
    expect(openMetrics().map(o => o.textContent)).toEqual(['統合Borda順'])
    expect(topK()).toEqual(['alpha'])
  })
})
