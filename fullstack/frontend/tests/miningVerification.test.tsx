import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import SubgroupMiningPage from '../src/features/mining/SubgroupMiningPage'
import ModernSubgroupMiningView from '../src/features/mining/ModernSubgroupMiningView'
import { VerificationFindings, VerificationSummary } from '../src/features/mining/VerificationResults'
import type { VerificationInfo, VerificationResultItem } from '../src/features/mining/verification'

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
beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({ datasets: [
    { datasetId: 'd', name: '探索用', rowCount: 200 },
    { datasetId: 'd2', name: '独立評価用', rowCount: 60 },
  ] } as never)
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
const replicatedItem: VerificationResultItem = {
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

const untestableItem: VerificationResultItem = {
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

function verificationPayload(item: VerificationResultItem, info: Partial<VerificationInfo> = {}) {
  return {
    ...explorationPayload,
    analysisMode: 'verification',
    isExploratory: false,
    verification: {
      method: 'independent', testUsed: ['welch_two_sample'], estimand: 'per_candidate',
      alpha: 0.05, correction: 'bh-fdr', mHypotheses: 1, mExcluded: 0,
      excludedCandidateIds: [], seed: 42, nSelection: 140, nEvaluation: 60,
      selectionScopeHash: 'sha256:sel', evaluationScopeHash: 'sha256:eval',
      analysisDatasetId: 'd', evaluationDatasetId: 'd2', rowIdNamespace: 'dataset-scoped',
      candidateSetHash: 'sha256:abc123', pinnedCandidateIds: ['ins_001'],
      pinnedCandidateCount: 1, explorationScopeHash: 'sha256:scope',
      explorationDataRevision: 3, minGroupSize: 10,
      note: '候補は探索時のスコープで固定し、評価は独立データセットで行いました。',
      ...info,
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
  expect(view.getByTestId('verification-replication').textContent).toContain('探索と方向一致')
  expect(view.getByTestId('verification-replication').textContent).toContain('補正後も有意')
  // The exploration badge is replaced by the verified one.
  expect(view.queryByTestId('exploration-badge')).toBeNull()
  expect(view.getByTestId('verification-badge').textContent).toContain('独立データ')
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
  expect(view.getByTestId('modern-verification-replication').textContent).toContain('探索と方向一致')
  // The insight list itself is still an exploration; only the pinned candidates
  // have verified numbers, so both banners are correct at once.
  expect(view.getByTestId('modern-exploration-badge')).toBeTruthy()
})

async function completeResult(kind: 'classic' | 'modern', item: VerificationResultItem, info: Partial<VerificationInfo> = {}) {
  const prefix = kind === 'classic' ? 'verification' : 'modern-verification'
  let current: Awaited<ReturnType<typeof renderClassicAndExplore>>
  if (kind === 'classic') {
    current = await renderClassicAndExplore()
  } else {
    const local = localStore()
    const post = vi.spyOn(api, 'post').mockResolvedValue(modernExplorationPayload as never)
    const view = render(<Provider store={local}><MemoryRouter><ModernSubgroupMiningView /></MemoryRouter></Provider>)
    fireEvent.click(await view.findByRole('button', { name: /指定対象で実行/ }))
    await view.findByTestId('modern-to-verification-btn')
    current = { view, post, local }
  }
  const { view, post } = current
  const candidateId = kind === 'classic' ? 'ins_001' : 'msd_001'
  const response = verificationPayload({ ...item, candidateId }, info)
  post.mockResolvedValue(response as never)
  fireEvent.click(view.getByTestId(kind === 'classic' ? 'mining-to-verification-btn' : 'modern-to-verification-btn'))
  // Deliberately leave settings at holdout: presentation must use the completed
  // response, not the current draft settings (CV and independent differ here).
  await clickModalRun()
  await view.findByTestId(`${prefix}-badge`)
  const actions = kind === 'classic'
    ? ['select-subgroup-pcp', 'focus-pcp-pair', 'send-to-robustness-btn']
    : ['modern-to-verification-btn', 'modern-send-to-robustness-btn']
  for (const id of actions) expect(view.getByTestId(id)).toHaveStyle({ whiteSpace: 'normal', height: 'auto', maxWidth: '100%' })
  return { view, prefix }
}

for (const kind of ['classic', 'modern'] as const) {
  it.each([
    ['holdout', 'posthoc_stability', null],
    ['holdout', undefined, undefined],
    ['cross_validation', 'posthoc_stability', null],
    ['cross_validation', undefined, undefined],
  ] as const)(`${kind} renders %s stability (%s/%s) without null-driven inference`, async (method, stabilityMode, missing) => {
    const candidateId = kind === 'classic' ? 'ins_001' : 'msd_001'
    const stabilityItem = { ...replicatedItem,
      test: { ...replicatedItem.test!, pValue: missing, pAdjusted: missing, significant: missing },
      replicationStatus: missing,
    }
    const { view, prefix } = await completeResult(kind, stabilityItem, {
      method, stabilityMode, alpha: 0.1, mHypotheses: 0, testUsed: [], evaluationDatasetId: 'd',
      nSelection: method === 'holdout' ? 390 : 600, nEvaluation: method === 'holdout' ? 210 : 600,
      note: undefined,
      folds: method === 'cross_validation' ? [
        { fold: 0, nEvaluation: 150, testableCount: 1, effects: [
          { candidateId: 'other', effect: 77, testable: true },
          { candidateId, effect: 8.5, testable: true, n: { evaluation: 150, used: 120 } },
        ] },
        { fold: 1, nEvaluation: 150, testableCount: 0, effects: [
          { candidateId, effect: null, testable: false, n: { evaluation: 150, used: 0 }, reason: 'INSUFFICIENT_GROUP_SIZE' },
        ] },
      ] : undefined,
    })
    const badge = view.getByTestId(`${prefix}-badge`).textContent ?? ''
    expect(badge).toContain('探索後の安定性確認（参考）')
    expect(badge).toContain(method === 'holdout' ? 'ホールドアウト分割' : '交差検証')
    expect(badge).toContain(method === 'holdout' ? 'nSelection=390／nEvaluation=210' : 'nSelection=600／nEvaluation=600')
    expect(badge).not.toMatch(/検証済み|補正:|family=|α=/)
    expect(view.queryByTestId(`${prefix}-p-value`)).toBeNull()
    expect(view.queryByTestId(`${prefix}-p-adjusted`)).toBeNull()
    expect(view.queryByTestId(`${prefix}-replication`)).toBeNull()
    expect(view.getByTestId(`${prefix}-ci`).textContent).toContain('差の90% CI（参考）')
    expect(view.getByTestId(`${prefix}-ci`).textContent).toContain('9.500')
    expect(view.getByTestId(`${prefix}-estimate`).textContent).toContain('10.0000（60行）')
    expect(view.getByTestId(`${prefix}-group-stats`).textContent).toContain('1.410')
    expect(view.container.textContent).not.toMatch(/補正後は非有意|補正後も有意|FDR有意発見数|Bonferroni有意|p=null|adj=null|undefined/)
    if (kind === 'classic') {
      expect(view.getByTestId('verification-list-summary').textContent).toContain('安定性確認: 点推定 10.0000／評価 60行')
    }
    if (method === 'cross_validation') {
      const folds = view.getByTestId(`${prefix}-folds`)
      expect(folds.textContent).toContain('8.5000')
      expect(folds.textContent).toContain('120')
      expect(folds.textContent).toContain('算出不可')
      expect(folds.textContent).toContain('INSUFFICIENT_GROUP_SIZE')
      expect(folds.textContent).not.toContain('77.0000')
      expect(folds.querySelectorAll('tbody tr.ant-table-row')).toHaveLength(2)
      expect(folds.querySelector('.ant-table-content')).toHaveStyle({ overflowX: 'auto' })
    } else expect(view.queryByTestId(`${prefix}-folds`)).toBeNull()
  })

  it.each([null, undefined])(`${kind} keeps an independent estimate without inventing a non-significant result (%s)`, async (missing) => {
    const item = { ...replicatedItem, test: { ...replicatedItem.test!, pValue: missing, pAdjusted: missing, significant: false } }
    const { view, prefix } = await completeResult(kind, item, { method: 'independent', mHypotheses: 0, testUsed: [] })
    expect(view.getByTestId(`${prefix}-inference-unavailable`).textContent).toContain('推測統計を算出できません')
    expect(view.getByTestId(`${prefix}-estimate`).textContent).toContain('10.0000（60行）')
    expect(view.queryByTestId(`${prefix}-p-value`)).toBeNull()
    expect(view.queryByTestId(`${prefix}-p-adjusted`)).toBeNull()
    expect(view.queryByTestId(`${prefix}-replication`)).toBeNull()
    expect(view.container.textContent).not.toContain('補正後は非有意')
    expect(view.getByTestId(`${prefix}-badge`).textContent).toContain('推測統計を算出できた候補: 0')
    if (kind === 'classic') expect(view.getByTestId('verification-list-summary').textContent).not.toMatch(/null|undefined|p=/)
  })

  it(`${kind} preserves the independent missing-column reason without showing a successful verification`, async () => {
    const item = { ...untestableItem, reason: 'COLUMN_NOT_FOUND', warnings: [{ code: 'COLUMN_NOT_FOUND', message: '評価データに必要な列がありません。' }] }
    const { view, prefix } = await completeResult(kind, item, { mHypotheses: 0, mExcluded: 1, testUsed: [] })
    expect(view.getByTestId(`${prefix}-untestable`).textContent).toContain('評価データに必要な列がありません。')
    expect(view.getByTestId(`${prefix}-untestable`).textContent).toContain('COLUMN_NOT_FOUND')
    expect(view.queryByTestId(`${prefix}-estimate`)).toBeNull()
    expect(view.queryByTestId(`${prefix}-p-value`)).toBeNull()
    expect(view.queryByTestId(`${prefix}-replication`)).toBeNull()
    expect(view.getByTestId(`${prefix}-badge`).textContent).not.toContain('検証済み')
  })

  it(`${kind} shows valid independent inference, its actual confidence level and result-based significant count`, async () => {
    const { view, prefix } = await completeResult(kind, replicatedItem, { method: 'independent', alpha: 0.01 })
    expect(view.getByTestId(`${prefix}-badge`).textContent).toContain('独立データでの評価結果')
    expect(view.getByTestId(`${prefix}-badge`).textContent).toContain('補正後有意=1')
    expect(view.getByTestId(`${prefix}-badge`).textContent).toContain('補正: bh-fdr（α=0.01）')
    expect(view.getByTestId(`${prefix}-p-value`).textContent).toContain('0.0004')
    expect(view.getByTestId(`${prefix}-p-adjusted`).textContent).toContain('0.0004')
    expect(view.getByTestId(`${prefix}-replication`).textContent).toContain('探索と方向一致')
    expect(view.getByTestId(`${prefix}-replication`).textContent).toContain('補正後も有意')
    expect(view.getByTestId(`${prefix}-ci`).textContent).toContain('差の99% CI')
    expect(view.getByTestId(`${prefix}-ci`).textContent).not.toContain('参考')
    expect(view.container.textContent).not.toMatch(/FDR有意発見数|Bonferroni有意/)
  })
}


it.each([false, null, undefined])('only explicit independent significance decisions become significance labels (%s)', (significant) => {
  const item = { ...replicatedItem, test: { ...replicatedItem.test!, pValue: 0.4, pAdjusted: 0.4, significant }, replicationStatus: undefined }
  const info = verificationPayload(item).verification
  const view = render(<><VerificationSummary info={info} results={[item]} prefix="result" />
    <VerificationFindings info={info} item={item} candidateId={item.candidateId} prefix="result" /></>)
  expect(view.getByTestId('result-replication').textContent).toBe(significant === false ? '補正後は非有意' : '有意性判定なし')
  expect(view.getByTestId('result-estimate').textContent).toContain('10.0000（60行）')
  expect(view.container.textContent).not.toContain('undefined')
  if (significant == null) expect(view.getByTestId('result-badge').textContent).not.toContain('補正後有意=')
})

it.each([
  { method: 'holdout' }, { method: 'cross_validation' },
  { method: 'independent', stabilityMode: 'posthoc_stability' as const },
  { method: 'unknown' },
])('suppresses inference when completed response metadata disallows it: %j', (overrides) => {
  const info = verificationPayload(replicatedItem, overrides).verification
  const view = render(<><VerificationSummary info={info} results={[replicatedItem]} prefix="result" />
    <VerificationFindings info={info} item={replicatedItem} candidateId={replicatedItem.candidateId} prefix="result" /></>)
  expect(view.queryByTestId('result-p-value')).toBeNull()
  expect(view.queryByTestId('result-p-adjusted')).toBeNull()
  expect(view.queryByTestId('result-replication')).toBeNull()
  expect(view.getByTestId('result-estimate').textContent).toContain('10.0000（60行）')
  expect(view.getByTestId('result-badge').textContent).not.toMatch(/補正:|補正後有意|family=/)
})

it.each([null, undefined, NaN, Infinity])('does not infer significance when an independent adjusted p is invalid (%s)', (pAdjusted) => {
  const item = { ...replicatedItem, test: { ...replicatedItem.test!, pAdjusted } }
  const info = verificationPayload(item).verification
  const view = render(<VerificationFindings info={info} item={item} candidateId={item.candidateId} prefix="result" />)
  expect(view.getByTestId('result-p-value').textContent).toContain('0.0004')
  expect(view.queryByTestId('result-p-adjusted')).toBeNull()
  expect(view.queryByTestId('result-replication')).toBeNull()
  expect(view.getByTestId('result-inference-unavailable')).toBeTruthy()
})

it('retains descriptive effects with a missing test and handles an empty interval safely', () => {
  const item = { ...replicatedItem, test: null, effect: { ...replicatedItem.effect!, ci95: [] as unknown as [number, number] } }
  const view = render(<VerificationFindings info={null} item={item} candidateId={item.candidateId} prefix="result" />)
  expect(view.getByTestId('result-estimate').textContent).toContain('10.0000（60行）')
  expect(view.getByTestId('result-ci').textContent).toContain('差の区間推定（参考）')
  expect(view.queryByTestId('result-untestable')).toBeNull()
  expect(view.queryByTestId('result-replication')).toBeNull()
})
