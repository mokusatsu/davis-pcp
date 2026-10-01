import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import SubgroupMiningPage from '../src/features/mining/SubgroupMiningPage'
import ModernSubgroupMiningView from '../src/features/mining/ModernSubgroupMiningView'

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
  return {
    useCodebook: () => ({
      schemaRevision: 2, columns,
      getColumn: () => undefined,
      formatValueLabel: (_column: string, value: unknown) => String(value),
    }),
  }
})
const stableRowIds = ['r1', 'r2']
vi.mock('../src/app/store', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    selectOrdinaryVariables: () => ({ activeVariableIds: ['seg', 'score'], allVariables: ['seg', 'score'], targetVariableId: 'score' }),
    selectEffectiveRowIds: () => stableRowIds,
  }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function localStore() {
  const base = store.getState()
  return configureStore({
    reducer: () => ({
      ...base,
      selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
      globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: stableRowIds } },
    }),
    middleware: (g) => g({ serializableCheck: false }),
  })
}

const explorationPayload = {
  run_id: 'run1',
  summary: {
    n_subgroup_vars: 1, n_questions: 1, n_tests_run: 1, n_significant_fdr: 0,
    n_significant_bonferroni: 0, n_insights_after_filters: 1,
  },
  insights: [{
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
  }],
  analysisMode: 'exploration',
  isExploratory: true,
  candidateSetHash: 'sha256:abc123',
  candidates: [{ candidateId: 'ins_001', displayLabel: 'seg:b vs a × score', estimand: { type: 'mean_difference' } }],
  explorationNote: 'この結果は全データ上の探索であり、母集団への確証ではありません',
}

/** The real response nests the estimate under `effect` and the p-values under `test`. */
const replicatedItem = {
  candidateId: 'ins_001',
  estimand: { type: 'mean_difference', numerator: 'b', denominator: 'a', unit: 'question_value' },
  testable: true,
  reason: null,
  effect: {
    estimate: 10.0, ci95: [9.5, 10.5], meanA: 20, meanB: 10, nA: 30, nB: 30,
    varA: 2, varB: 2, cohensD: 5, weighted: false,
    groupStats: [
      { label: 'b', n: 30, mean: 20, sd: 1.41 },
      { label: 'a', n: 30, mean: 10, sd: 1.41 },
    ],
  },
  test: {
    name: 'welch_two_sample', statistic: 38.7, pValue: 0.0004, df: 58,
    permutations: null, pAdjusted: 0.0004, significant: true,
  },
  n: { evaluation: 60, used: 60 },
  directionConsistent: true,
  replicationStatus: 'replicated',
  warnings: [],
}

const untestableItem = {
  candidateId: 'ins_001',
  estimand: { type: 'mean_difference', numerator: 'b', denominator: 'a' },
  testable: false,
  reason: 'INSUFFICIENT_GROUP_SIZE',
  detail: { minGroupSize: 10 },
  effect: null,
  test: null,
  n: { evaluation: 60, used: 0 },
  directionConsistent: null,
  replicationStatus: 'not_testable',
  warnings: [{
    code: 'INSUFFICIENT_GROUP_SIZE',
    message: '評価データ内の群サイズが最小群サイズに達しないため検定できません。',
  }],
}

function verificationPayload(item: typeof replicatedItem | typeof untestableItem) {
  return {
    ...explorationPayload,
    analysisMode: 'verification',
    isExploratory: false,
    verification: {
      method: 'holdout', testUsed: ['welch_two_sample'], estimand: 'per_candidate',
      alpha: 0.05, correction: 'bh-fdr', mHypotheses: 1, mExcluded: 0,
      excludedCandidateIds: [], seed: 42, nSelection: 140, nEvaluation: 60,
      selectionScopeHash: 'sha256:sel', evaluationScopeHash: 'sha256:eval',
      analysisDatasetId: 'd', evaluationDatasetId: 'd', rowIdNamespace: 'dataset-scoped',
      candidateSetHash: 'sha256:abc123', pinnedCandidateIds: ['ins_001'],
      pinnedCandidateCount: 1, explorationScopeHash: 'sha256:scope',
      explorationDataRevision: 3, minGroupSize: 10,
      note: '候補は探索時のスコープで固定し、評価は分割した評価側のみで行いました。',
    },
    results: [item],
  }
}

async function renderClassicAndExplore() {
  const local = localStore()
  const post = vi.spyOn(api, 'post').mockResolvedValue(explorationPayload as never)
  const view = render(<Provider store={local}><MemoryRouter><SubgroupMiningPage /></MemoryRouter></Provider>)
  const tabs = view.container.querySelectorAll('.ant-tabs-tab')
  fireEvent.click(tabs[1])
  fireEvent.click(await view.findByTestId('mining-run-button'))
  await waitFor(() => expect(view.queryByTestId('verification-badge')).toBeNull())
  await waitFor(() => expect(view.getByTestId('mining-to-verification-btn')).toBeTruthy())
  return { view, post, local }
}

/**
 * antd pads a two-CJK-character button label ("実 行"), so the footer's primary
 * button is located by role rather than by its text.
 */
async function clickModalRun() {
  const execute = await waitFor(() => {
    const match = document.querySelector('.ant-modal-footer .ant-btn-primary')
    if (!match) throw new Error('modal ok button not rendered')
    return match as Element
  })
  fireEvent.click(execute)
}

async function runVerificationFromModal(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByTestId('mining-to-verification-btn'))
  await clickModalRun()
}

it('verifies the pinned candidate set by hash alone and reads the new result shape', async () => {
  const { view, post } = await renderClassicAndExplore()
  post.mockResolvedValue(verificationPayload(replicatedItem) as never)
  await runVerificationFromModal(view)

  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  const body = post.mock.calls[1][1] as any
  // Only the hash identifies the set: listing ids would fail for any insight
  // that produced no pinned contrast, and invites re-discovery.
  expect(body.candidateSetHash).toBe('sha256:abc123')
  expect(body.candidateIds).toBeUndefined()
  expect(body.analysisMode).toBe('verification')

  await waitFor(() => expect(view.getByTestId('verification-p-value')).toBeTruthy())
  expect(view.getByTestId('verification-p-value').textContent).toContain('0.0004')
  expect(view.getByTestId('verification-p-adjusted').textContent).toContain('0.0004')
  expect(view.getByTestId('verification-ci').textContent).toContain('9.5000')
  expect(view.getByTestId('verification-replication').textContent).toContain('再現')
  expect(view.getByTestId('verification-replication').textContent).toContain('補正後も有意')
  // The exploration badge is replaced by the verified one.
  expect(view.queryByTestId('exploration-badge')).toBeNull()
  expect(view.getByTestId('verification-badge').textContent).toContain('ホールドアウト分割')
})

it('explains an untestable candidate instead of leaving the p-value blank', async () => {
  const { view, post } = await renderClassicAndExplore()
  post.mockResolvedValue(verificationPayload(untestableItem) as never)
  await runVerificationFromModal(view)

  await waitFor(() => expect(view.getByTestId('verification-untestable')).toBeTruthy())
  expect(view.getByTestId('verification-untestable').textContent)
    .toContain('評価データ内の群サイズが最小群サイズに達しないため検定できません。')
  expect(view.queryByTestId('verification-p-value')).toBeNull()
  expect(view.queryByTestId('verification-p-adjusted')).toBeNull()
})

it('discards a previous verification when exploration is run again', async () => {
  const { view, post } = await renderClassicAndExplore()
  post.mockResolvedValue(verificationPayload(replicatedItem) as never)
  await runVerificationFromModal(view)
  await waitFor(() => expect(view.getByTestId('verification-p-value')).toBeTruthy())

  post.mockResolvedValue(explorationPayload as never)
  fireEvent.click(view.getByTestId('mining-run-button'))
  // The pinned set changed, so the old verification no longer describes it.
  await waitFor(() => expect(view.queryByTestId('verification-p-value')).toBeNull())
  await waitFor(() => expect(view.getByTestId('exploration-badge')).toBeTruthy())
})

it('offers the other datasets for independent verification', async () => {
  const { view } = await renderClassicAndExplore()
  const get = vi.spyOn(api, 'get').mockResolvedValue({
    datasets: [
      { datasetId: 'd', name: '検証元', rowCount: 200 },
      { datasetId: 'd2', name: '検証用データ', rowCount: 50 },
    ],
  } as never)

  fireEvent.click(view.getByTestId('mining-to-verification-btn'))
  await waitFor(() => expect(get).toHaveBeenCalledWith('/datasets'))

  const radio = document.querySelector('input[value="independent"]') as HTMLInputElement
  fireEvent.click(radio)
  fireEvent.mouseDown(document.querySelector('[data-testid="verification-independent-dataset"] .ant-select-selector') as Element)
  const option = await waitFor(() => {
    const el = document.querySelector('.ant-select-item-option[title="検証用データ（50行）"]')
    if (!el) throw new Error('dataset option not rendered')
    return el as Element
  })
  expect(option).toBeTruthy()
  // The dataset being analysed cannot verify itself.
  expect(document.querySelector('.ant-select-item-option[title="検証元（200行）"]')).toBeNull()
})

const modernExplorationPayload = {
  run_id: 'mrun1',
  mode: 'standard',
  inferenceMode: 'exploration',
  algorithmMode: 'standard',
  candidateSetHash: 'sha256:modern1',
  candidates: [{ candidateId: 'msd_001', displayLabel: 'seg=high → score', estimand: { type: 'mean_difference' } }],
  explorationNote: 'この結果は全データ上の探索であり、母集団への確証ではありません',
  summary: { total_candidates_explored: 4, non_redundant_insights_count: 1 },
  insights: [{
    id: 'msd_001',
    target_question: 'score',
    target_pair: null,
    rule: { conditions: [{ column: 'seg', operator: '>', value: 3, label: 'seg > 3' }], complexity: 1, text: 'seg > 3' },
    coverage: { n: 80, ratio: 0.4, row_ids: ['r1'] },
    target_stats: { subgroup_mean: 20, complement_mean: 10, delta_mean: 10, subgroup_sd: 1.4, complement_sd: 1.4 },
    ranking_reason: { primary_driver: 'delta_mean', description: '差が大きい' },
    score: 0.9,
    narrative: 'seg が高い回答者は score が高い傾向があります',
  }],
}

it('runs modern verification through the pinned candidate set and shows the findings', async () => {
  const local = localStore()
  const post = vi.spyOn(api, 'post').mockResolvedValue(modernExplorationPayload as never)
  const view = render(<Provider store={local}><MemoryRouter><ModernSubgroupMiningView /></MemoryRouter></Provider>)

  fireEvent.click(await view.findByRole('button', { name: /指定対象で実行/ }))
  await waitFor(() => expect(view.getByTestId('modern-to-verification-btn')).toBeTruthy())

  post.mockResolvedValue({
    verification: (verificationPayload(replicatedItem) as any).verification,
    results: [{ ...replicatedItem, candidateId: 'msd_001' }],
  } as never)
  fireEvent.click(view.getByTestId('modern-to-verification-btn'))
  await clickModalRun()

  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  const [path, body] = post.mock.calls[1] as [string, any]
  expect(path).toBe('/mining/subgroups')
  expect(body.candidateSetHash).toBe('sha256:modern1')
  expect(body.candidateIds).toBeUndefined()
  expect(body.analysisMode).toBe('verification')
  // The scope hash must match exploration, so the same rows are sent.
  expect(body.rowIds).toEqual(stableRowIds)

  await waitFor(() => expect(view.getByTestId('modern-verification-badge')).toBeTruthy())
  expect(view.getByTestId('modern-verification-p-value').textContent).toContain('0.0004')
  expect(view.getByTestId('modern-verification-replication').textContent).toContain('再現')
  // The insight list itself is still an exploration; only the pinned candidates
  // have verified numbers, so both banners are correct at once.
  expect(view.getByTestId('modern-exploration-badge')).toBeTruthy()
})
