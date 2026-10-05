import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { ConfigProvider, message } from 'antd'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import FeatureRankingPage, { type FeatureRankingResponse } from '../src/features/mining/FeatureRankingPage'

// Preserve the real form controls, variable dialogs, disclosures and run scope.
// The chart data is inspected here; actual chart rendering has separate coverage.
vi.mock('../src/features/charts/EChart', () => ({ default: ({ testId, option }: any) =>
  <div data-testid={testId}>{JSON.stringify(option.series?.[0]?.data ?? [])}</div> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div>, useGraphPopupContainer: () => undefined }))

const columns = [
  ...['x', 'z', 'target', 'inactive', 'identifier'].map(name => ({ name, columnId: name, label: name,
    role: name === 'identifier' ? 'id' : 'question', scaleType: name === 'target' ? 'nominal' : 'ratio', multiResponseGroup: null })),
  ...['A', 'B'].map(name => ({ name, columnId: name, label: `MA child ${name}`, role: 'question', scaleType: 'nominal',
    multiResponseGroup: 'g', multiResponseOptionLabel: `選択肢${name}` })),
]
function mount(empty = false) {
  const base = store.getState()
  const initial: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'] },
    globalVariables: { ...base.globalVariables, targetVariableId: 'target', activeEntities: empty ? [] : [
      ...['x', 'z', 'target', 'identifier'].map(columnId => ({ kind: 'column', columnId })), { kind: 'ma', groupId: 'g' },
    ] },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false, columns,
      multiResponseGroups: [{ groupId: 'g', label: 'MA設問', optionOrder: ['A', 'B'], selectedCodes: ['1'], unselectedCodes: ['0'], allUnselectedMeaning: 'valid', maxSelections: null }] },
  }
  const local = configureStore({ reducer: (state = initial, action: any) => ({ ...state, codebook: codebookSlice.reducer(state.codebook, action) }),
    middleware: get => get({ serializableCheck: false }) })
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><MemoryRouter><FeatureRankingPage /></MemoryRouter></Provider></ConfigProvider>)
  return { ...view, local }
}
function response(overrides: Partial<FeatureRankingResponse> = {}): FeatureRankingResponse {
  return {
    scopeCount: 2, usedRows: 2, ordinaryMissingExcluded: 0, target: 'target', taskType: 'classification',
    evaluatedVariables: ['x', 'z'], redundancyMatrix: [[0, 0], [0, 0]],
    rankings: ['x', 'z'].map((variable, i) => ({ variable, bordaScore: 2 - i, overallRank: i + 1,
      recommendationTier: 'high', meanRedundancy: 0, scores: { relieff: { rawScore: 1 - i, normalizedScore: 1 - i, rank: i + 1 } } })),
    suggestedTopK: 1, executionTimeMs: 5, evidenceClass: 'test',
    importance: { mdi: [], permutation_train: [] },
    importanceMetadata: { mdi: { available: false }, permutation_train: { available: false, reason: '教師ありのみ' } },
    ...overrides,
  }
}
const computedImportance: Pick<FeatureRankingResponse, 'importance' | 'importanceMetadata'> = {
  importance: {
    mdi: [{ featureName: 'x', importance: 1, rank: 1 }, { featureName: 'z', importance: 0, rank: 2 }],
    permutation_train: [{ featureName: 'z', importanceMean: 0, importanceStd: 0, rank: 1 }, { featureName: 'x', importanceMean: -0.2, importanceStd: 0.1, rank: 2 }],
  },
  importanceMetadata: { mdi: { available: true }, permutation_train: { available: true } },
}
function settings() { return screen.getByText('ランキングの詳細設定').closest('details')! }
function toggleSettings(open: boolean) { act(() => { settings().open = open }) }
async function run() {
  fireEvent.click(screen.getByTestId('compute-ranking-btn'))
  await waitFor(() => expect(screen.getByTestId('compute-ranking-btn')).not.toHaveClass('ant-btn-loading'))
  await screen.findByTestId('top-k-action-bar')
}
async function picker(role: '目的変数' | '評価対象') {
  fireEvent.click(screen.getByRole('button', { name: `ランキングの${role}を選択`, exact: true }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  return dialog
}
async function finishPicker(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
async function clearTarget() {
  const dialog = await picker('目的変数')
  fireEvent.click(within(dialog).getByRole('button', { name: '選択解除', exact: true }))
  await finishPicker(dialog)
}
async function selectOption(input: HTMLElement, label: string) {
  if (input.getAttribute('aria-expanded') !== 'true') fireEvent.mouseDown(input)
  const option = await waitFor(() => {
    const match = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content'))
      .find(item => item.textContent === label)
    if (!match) throw new Error(`Missing option ${label}`)
    return match
  })
  fireEvent.click(option)
}
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps variable-first accessible fields and a separate wrapping run row, with unchanged auto-selected defaults', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(response())
  const view = mount()
  const panels = Array.from(view.container.querySelectorAll('details'))
  expect(panels).toHaveLength(2)
  expect(panels.every(panel => !panel.open)).toBe(true)
  expect(screen.getByRole('combobox', { name: 'ランキングの目的変数' })).toHaveAccessibleDescription(/未選択にすると教師なし分析/)
  expect(screen.getByRole('combobox', { name: 'ランキングの評価対象' })).toHaveAccessibleDescription(/同じ列・同じMA/)
  expect(screen.getByRole('combobox', { name: 'ランキングの評価対象' })).toHaveAttribute('aria-required', 'true')
  expect(screen.getByRole('button', { name: 'ランキングの目的変数を選択' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'ランキングの評価対象を選択' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'MA軸を追加' })).toBeVisible()
  const runButton = screen.getByTestId('compute-ranking-btn')
  expect(runButton).toBeEnabled()
  expect(runButton.closest('.analysis-run-row')).toBeTruthy()
  expect(runButton.closest('.analysis-variable-grid')).toBeNull()
  expect(runButton).toHaveStyle({ whiteSpace: 'normal', height: 'auto', minHeight: '32px', maxWidth: '100%' })
  expect(post).not.toHaveBeenCalled()
  await run()
  expect(post).toHaveBeenCalledWith('/mining/feature-ranking', {
    datasetId: 'd', targetColumn: 'target', featureColumns: ['x', 'z'], methods: ['relieff', 'mutual_info', 'random_forest', 'f_statistic'],
    activeRowIds: ['r1', 'r2'], expectedSchemaRevision: 2, expectedDataRevision: 3, usePermutationImportance: true, seed: 42,
  })
  expect(screen.getByRole('slider', { name: '選択する上位Kの変数数' })).toBeVisible()
  expect(screen.getByRole('spinbutton', { name: '上位Kの変数数を入力' })).toBeVisible()
})

it('retains changed method/permutation settings across collapse and submits their exact values while closed', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(response())
  mount(); toggleSettings(true)
  const rf = screen.getByRole('checkbox', { name: 'Random Forest (MDI)' })
  const permutation = screen.getByTestId('ranking-permutation-toggle')
  fireEvent.click(rf); fireEvent.click(permutation)
  fireEvent.click(screen.getByRole('checkbox', { name: 'PCA分散 (Dispersion)' }))
  toggleSettings(false)
  expect(settings().querySelector('summary')).toHaveTextContent('評価手法: ReliefF・相互情報量・F値・PCA分散 / Permutation: 計算しない')
  toggleSettings(true)
  expect(screen.getByRole('checkbox', { name: 'Random Forest (MDI)' })).toBe(rf)
  expect(rf).not.toBeChecked(); expect(permutation).not.toBeChecked()
  toggleSettings(false)
  await run()
  expect(post).toHaveBeenCalledWith('/mining/feature-ranking', expect.objectContaining({
    methods: ['relieff', 'mutual_info', 'f_statistic', 'pca_dispersion'], usePermutationImportance: false,
  }))
})

it('explains and disables missing methods or features without making a target mandatory', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(response({ taskType: 'unsupervised', target: null }))
  mount(); await clearTarget(); await run()
  expect(post).toHaveBeenCalledWith('/mining/feature-ranking', expect.objectContaining({ targetColumn: undefined, featureColumns: ['x', 'z'] }))
  toggleSettings(true)
  for (const checkbox of within(screen.getByRole('group', { name: 'ランキングの評価手法' })).getAllByRole('checkbox')) {
    if ((checkbox as HTMLInputElement).checked) fireEvent.click(checkbox)
  }
  expect(screen.getByTestId('compute-ranking-btn')).toBeDisabled()
  expect(screen.getByText('詳細設定で評価手法を1つ以上選択してください。')).toBeVisible()
  expect(settings().querySelector('summary')).toHaveTextContent('未選択')
  fireEvent.click(screen.getByRole('checkbox', { name: /ReliefF \/ 分散/ }))
  expect(screen.getByTestId('compute-ranking-btn')).toBeEnabled()
  const dialog = await picker('評価対象')
  fireEvent.click(within(dialog).getByRole('button', { name: /検索結果を全解除/ }))
  await finishPicker(dialog)
  expect(screen.getByTestId('compute-ranking-btn')).toBeDisabled()
  expect(screen.getByText('評価対象の特徴量を1つ以上選択してください。')).toBeVisible()
  expect(post).toHaveBeenCalledTimes(1)
})

it('retains explicit MA choice addition and excludes the target column and every sibling from its feature candidates', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(response())
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'MA軸を追加' }))
  const ma = await screen.findByRole('dialog')
  await selectOption(within(ma).getByRole('combobox', { name: 'MA軸の設問' }), 'MA設問')
  const choices = within(ma).getByRole('combobox', { name: '追加するMA軸' })
  await selectOption(choices, '選択肢A')
  await selectOption(choices, '選択肢B')
  expect(document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).not.toHaveTextContent('選択数')
  fireEvent.keyDown(choices, { key: 'Escape' })
  fireEvent.click(within(ma).getByRole('button', { name: /追\s*加$/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const target = await picker('目的変数')
  fireEvent.click(within(target).getByRole('radio', { name: 'A: MA child A', exact: true }))
  await finishPicker(target)
  const features = await picker('評価対象')
  expect(within(features).queryByRole('checkbox', { name: /MA child/ })).toBeNull()
  expect(within(features).queryByRole('checkbox', { name: 'inactive', exact: true })).toBeNull()
  expect(within(features).queryByRole('checkbox', { name: 'identifier', exact: true })).toBeNull()
  await finishPicker(features)
  await run()
  expect(post).toHaveBeenCalledWith('/mining/feature-ranking', expect.objectContaining({ targetColumn: 'A', featureColumns: ['x', 'z'] }))
})

it.each(['目的変数', '評価対象'] as const)('provides role-specific %s empty guidance and opens the existing Codebook editor', async role => {
  const { local } = mount(true)
  const dialog = await picker(role)
  expect(dialog).toHaveTextContent(role === '目的変数' ? '目的変数の候補がありません。' : '評価対象の特徴量の候補がありません。')
  expect(dialog).toHaveTextContent('共通の有効変数')
  if (role === '目的変数') expect(dialog).toHaveTextContent('未選択のまま教師なし分析ができます')
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
  expect(local.getState().codebook.isEditorOpen).toBe(true)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it.each(['classification', 'regression'] as const)('shows truthful not-computed MDI/permutation states for %s even when backend reason says teacher-only', async taskType => {
  vi.spyOn(api, 'post').mockResolvedValue(response({ taskType }))
  mount(); await run()
  expect(screen.getByTestId('ranking-mdi-unavailable')).toHaveTextContent('この実行では未算出です。')
  expect(screen.getByTestId('ranking-permutation-unavailable')).toHaveTextContent('この実行では未算出です。')
  expect(screen.getByTestId('importance-split')).not.toHaveTextContent('教師ありのみ')
  expect(screen.queryByTestId('ranking-mdi-chart')).toBeNull()
  expect(screen.queryByTestId('ranking-permutation-chart')).toBeNull()
  toggleSettings(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Random Forest (MDI)' }))
  fireEvent.click(screen.getByTestId('ranking-permutation-toggle'))
  await clearTarget()
  expect(screen.getByTestId('importance-split')).not.toHaveTextContent('教師ありのみ')
  expect(screen.getByText('現在の入力と異なる実行済み結果です。再実行すると更新されます。')).toBeVisible()
})

it('retains signed and zero completed values through draft edits and failed reruns, then updates only on successful rerun', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce(response(computedImportance))
    .mockRejectedValueOnce(new Error('retry failed')).mockResolvedValueOnce(response())
  mount(); await run()
  const mdi = screen.getByTestId('ranking-mdi-chart').textContent
  const permutation = screen.getByTestId('ranking-permutation-chart').textContent
  expect(mdi).toContain('"value":0')
  expect(permutation).toContain('"value":-0.2')
  expect(permutation).toContain('"value":0')
  expect(permutation!.indexOf('"name":"z"')).toBeLessThan(permutation!.indexOf('"name":"x"'))
  toggleSettings(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Random Forest (MDI)' }))
  fireEvent.click(screen.getByTestId('ranking-permutation-toggle'))
  toggleSettings(false); await clearTarget()
  expect(screen.getByTestId('ranking-mdi-chart')).toHaveTextContent(mdi!)
  expect(screen.getByTestId('ranking-permutation-chart')).toHaveTextContent(permutation!)
  await run()
  expect(await screen.findByText('retry failed')).toBeVisible()
  expect(screen.getByTestId('ranking-permutation-chart')).toHaveTextContent(permutation!)
  expect(screen.getByTestId('analysis-scope-summary')).toHaveTextContent('この結果:')
  await run()
  expect(screen.queryByTestId('ranking-mdi-chart')).toBeNull()
  expect(screen.queryByTestId('ranking-permutation-chart')).toBeNull()
  expect(screen.getByTestId('ranking-permutation-unavailable')).toHaveTextContent('未算出')
  expect(post).toHaveBeenCalledTimes(3)
})

it('distinguishes a trustworthy insufficient-row reason from unsupervised-only availability', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce(response({ ...computedImportance,
    importance: { mdi: computedImportance.importance!.mdi, permutation_train: [] },
    importanceMetadata: { mdi: { available: true }, permutation_train: { available: false, reason: 'insufficient_rows' } },
  })).mockResolvedValueOnce(response({ taskType: 'unsupervised', target: null }))
  mount(); await run()
  expect(screen.getByTestId('ranking-mdi-chart')).toBeVisible()
  expect(screen.getByTestId('ranking-permutation-unavailable')).toHaveTextContent('有効行数が不足')
  await clearTarget()
  expect(screen.getByTestId('ranking-permutation-unavailable')).toHaveTextContent('有効行数が不足')
  await run()
  expect(screen.getByTestId('ranking-mdi-unavailable')).toHaveTextContent('この実行は教師なし分析')
  expect(screen.getByTestId('ranking-permutation-unavailable')).toHaveTextContent('この実行は教師なし分析')
  expect(post).toHaveBeenCalledTimes(2)
})

it('uses neutral empty-result text for available metadata without finite data, and accepts finite data without metadata', async () => {
  vi.spyOn(api, 'post').mockResolvedValueOnce(response({
    importance: { mdi: [{ featureName: 'x', importance: null, rank: 1 }], permutation_train: [{ featureName: 'z', importanceMean: NaN, rank: 1 }] },
    importanceMetadata: { mdi: { available: true }, permutation_train: { available: true } },
  })).mockResolvedValueOnce(response({ ...computedImportance, importanceMetadata: undefined }))
  mount(); await run()
  expect(screen.getByTestId('ranking-mdi-unavailable')).toHaveTextContent('表示できる重要度の結果がありません。')
  expect(screen.getByTestId('ranking-permutation-unavailable')).toHaveTextContent('表示できる重要度の結果がありません。')
  expect(screen.queryByTestId('ranking-mdi-chart')).toBeNull()
  expect(screen.queryByTestId('ranking-permutation-chart')).toBeNull()
  await run()
  expect(screen.getByTestId('ranking-mdi-chart')).toHaveTextContent('"value":0')
  expect(screen.getByTestId('ranking-permutation-chart')).toHaveTextContent('"value":-0.2')
})
