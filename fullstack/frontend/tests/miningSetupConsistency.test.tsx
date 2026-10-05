import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import SubgroupMiningPage from '../src/features/mining/SubgroupMiningPage'
import VerificationConfigModal from '../src/features/mining/VerificationConfigModal'

// Real fields, variable dialogs, tabs, disclosures and verification controls.
type View = 'modern' | 'classic'
const columns = [
  { name: 'seg', columnId: 'seg', label: '属性A', role: 'attribute', scaleType: 'nominal' },
  { name: 'score', columnId: 'score', label: '質問A', role: 'question', scaleType: 'ratio' },
].map(column => ({ ...column, multiResponseGroup: null }))
function testStore(empty = false) {
  const base = store.getState()
  const initial: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'] },
    globalVariables: { ...base.globalVariables, activeEntities: empty ? [] : null },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false, columns },
  }
  return configureStore({ reducer: (state = initial, action: any) => {
    if (action.type === 'test/scope') return { ...state, selection: { ...state.selection, activeRowIds: action.payload } }
    if (action.type === 'test/revision') return { ...state, selection: { ...state.selection, dataRevision: state.selection.dataRevision + 1 } }
    return { ...state, codebook: codebookSlice.reducer(state.codebook, action) }
  }, middleware: get => get({ serializableCheck: false }) })
}
function wrap(ui: React.ReactNode, local = testStore()) {
  return <ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><MemoryRouter>{ui}</MemoryRouter></Provider></ConfigProvider>
}
async function mount(view: View, empty = false) {
  const local = testStore(empty)
  const rendered = render(wrap(<SubgroupMiningPage />, local))
  if (view === 'classic') fireEvent.click(screen.getByRole('tab', { name: /単変量総当たり/ }))
  return { ...rendered, local }
}
async function choose(role: '属性' | '質問') {
  fireEvent.click(screen.getByRole('button', { name: `マイニングの${role}変数を選択`, exact: true }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  fireEvent.click(within(dialog).getByRole('checkbox', { name: new RegExp(role + 'A') }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
async function ready() { await choose('属性'); await choose('質問') }
function runButton(view: View) { return view === 'classic' ? screen.getByTestId('mining-run-button') : screen.getByRole('button', { name: /指定対象で実行/ }) }
function verificationButton(view: View) { return screen.getByTestId(view === 'classic' ? 'mining-to-verification-btn' : 'modern-to-verification-btn') }
function settings(view: View) { return screen.getByText(view === 'classic' ? '単変量マイニングの詳細設定' : 'サブグループ発見の詳細設定').closest('details')! }
function fixture(view: View): any {
  if (view === 'classic') return { run_id: 'classic', candidateSetHash: 'classic-hash', candidates: [], insights: [],
    summary: { n_subgroup_vars: 1, n_questions: 1, n_tests_run: 1, n_significant_fdr: 0, n_significant_bonferroni: 0, n_insights_after_filters: 0 } }
  return { run_id: 'modern', mode: 'auto', inferenceMode: 'exploration', algorithmMode: 'standard', candidateSetHash: 'modern-hash', candidates: [],
    summary: { total_candidates_explored: 1, non_redundant_insights_count: 1 }, insights: [{ id: 'i1', target_question: 'score',
      rule: { conditions: [], complexity: 1, text: '属性A' }, coverage: { n: 1, ratio: 0.5, row_ids: ['r1'] },
      target_stats: { subgroup_mean: 2, complement_mean: 1, delta_mean: 1 }, ranking_reason: { primary_driver: 'delta_mean', description: '差' }, score: 1, narrative: '候補' }] }
}
function verified() { return { verification: { method: 'holdout', testUsed: [], correction: 'bh-fdr', alpha: 0.05, mHypotheses: 0, mExcluded: 0, nSelection: 1, nEvaluation: 1, seed: 42 }, results: [] } }
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done }); return { promise, resolve } }
function modalRun() { return within(screen.getByRole('dialog')).getByRole('button', { name: /実\s*行$/ }) }
async function explore(view: View, post: ReturnType<typeof vi.spyOn>) {
  post.mockResolvedValue(fixture(view))
  await ready(); fireEvent.click(runButton(view))
  await waitFor(() => expect(verificationButton(view)).toBeEnabled())
}
async function pickIndependent() {
  fireEvent.click(screen.getByRole('radio', { name: '独立データ指定' }))
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '独立検証データセット' }))
  const option = await waitFor(() => {
    const item = document.querySelector('.ant-select-item-option[title="検証用"]')
    if (!item) throw new Error('independent option not rendered')
    return item
  })
  fireEvent.click(option)
}
beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({ datasets: [] } as never)
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['modern', 'classic'] as const)('%s submits unchanged defaults from closed settings with visible role-specific variables', async view => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(fixture(view))
  await mount(view)
  expect(settings(view).open).toBe(false)
  expect(screen.getByRole('combobox', { name: 'Miningの属性変数' }).closest('.column-select-multi-wrap')).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Miningの質問変数' })).toHaveAccessibleDescription(/比較する質問/)
  expect(runButton(view)).toBeDisabled()
  expect(runButton(view).closest('.analysis-run-row')).toBeTruthy()
  await ready(); fireEvent.click(runButton(view))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith(view === 'classic' ? '/mining/subgroups' : '/mining/modern-subgroup', {
    datasetId: 'd', attributeCols: ['seg'], rowIds: ['r1', 'r2'], expectedDataRevision: 3, expectedSchemaRevision: 2,
    ...(view === 'classic' ? { questionCols: ['score'], alpha: 0.05, minGroupSize: 10 } : { targetQuestions: ['score'], mode: 'auto', maxDepth: 2, minGroupSize: 30, topK: 12 }),
  })
})
it.each(['modern', 'classic'] as const)('%s retains edited settings across collapse and submits them while closed', async view => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(fixture(view))
  await mount(view); await ready()
  act(() => { settings(view).open = true })
  const input = screen.getByLabelText(view === 'classic' ? '最小人数 (Min Group Size)' : '最小人数')
  fireEvent.change(input, { target: { value: '40' } }); fireEvent.blur(input)
  act(() => { settings(view).open = false })
  expect(settings(view).querySelector('summary')).toHaveTextContent('最小人数: 40')
  act(() => { settings(view).open = true })
  expect(screen.getByLabelText(view === 'classic' ? '最小人数 (Min Group Size)' : '最小人数')).toBe(input)
  act(() => { settings(view).open = false })
  fireEvent.click(runButton(view))
  await waitFor(() => expect(post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minGroupSize: 40 })))
})
it('offers role-specific empty repair guidance and opens the existing codebook editor', async () => {
  const { local } = await mount('modern', true)
  fireEvent.click(screen.getByRole('button', { name: 'マイニングの属性変数を選択' }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  expect(dialog).toHaveTextContent('属性変数の候補がありません')
  expect(dialog).toHaveTextContent('共通の有効変数とコードブックの属性の役割')
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
  expect(local.getState().codebook.isEditorOpen).toBe(true)
})
it('renders actual split labels, retains closed values, preserves defaults and explains mode-specific inference', async () => {
  const onRun = vi.fn()
  render(wrap(<VerificationConfigModal open pending={false} candidateCount={1} candidateSetHash="hash" datasets={[]} currentDatasetId="d" alpha={0.1} onCancel={() => {}} onRun={onRun} />))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
  fireEvent.click(modalRun())
  expect(onRun).toHaveBeenLastCalledWith({ method: 'holdout', test_size: 0.3, k: 5, seed: 42, correction: 'bh-fdr', alpha: 0.1, independent_dataset_id: null })
  const detail = screen.getByText('分割の詳細設定').closest('details')!
  expect(detail.open).toBe(false)
  act(() => { detail.open = true })
  fireEvent.change(screen.getByLabelText('検証割合'), { target: { value: '0.4' } }); fireEvent.blur(screen.getByLabelText('検証割合'))
  expect(screen.getByRole('radio', { name: 'ホールドアウト分割（学習 60% / 検証 40%）' })).toBeChecked()
  fireEvent.click(screen.getByRole('radio', { name: '交差検証（k=5）' }))
  fireEvent.change(screen.getByLabelText('分割数 k'), { target: { value: '7' } }); fireEvent.blur(screen.getByLabelText('分割数 k'))
  fireEvent.change(screen.getByLabelText('乱数 seed'), { target: { value: '9' } }); fireEvent.blur(screen.getByLabelText('乱数 seed'))
  act(() => { detail.open = false })
  expect(screen.getByRole('radio', { name: '交差検証（k=7）' })).toBeChecked()
  fireEvent.click(modalRun())
  expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'cross_validation', test_size: 0.4, k: 7, seed: 9, alpha: 0.1 }))
  expect(screen.getByText(/FDR補正は行いません/)).toBeVisible()
  fireEvent.click(screen.getByRole('radio', { name: '独立データ指定' }))
  expect(screen.getByText(/この検証には α=0.1 を使用/)).toBeVisible()
  expect(screen.queryByText(/画面上部の FDR/)).toBeNull()
})
it.each(['removed', 'self', 'source_changed'] as const)('rejects independent selection when %s and does not resurrect it', async change => {
  const onRun = vi.fn()
  const options = [{ value: 'd', label: '探索元' }, { value: 'd2', label: '検証用' }]
  const ui = (datasets = options, currentDatasetId = 'd') => wrap(<VerificationConfigModal open pending={false} candidateCount={1} candidateSetHash="hash" datasets={datasets} currentDatasetId={currentDatasetId} alpha={0.05} onCancel={() => {}} onRun={onRun} />)
  const view = render(ui()); await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible()); await pickIndependent()
  expect(modalRun()).toBeEnabled()
  expect(document.querySelector('.ant-select-item-option[title="探索元"]')).toBeNull()
  fireEvent.click(modalRun())
  expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'independent', independent_dataset_id: 'd2' }))
  onRun.mockClear()
  view.rerender(ui(change === 'removed' ? [options[0]] : options, change === 'self' ? 'd2' : change === 'source_changed' ? 'd3' : 'd'))
  await waitFor(() => expect(modalRun()).toBeDisabled())
  fireEvent.click(modalRun()); expect(onRun).not.toHaveBeenCalled()
  view.rerender(ui()); expect(modalRun()).toBeDisabled()
  expect(screen.getByText('現在の候補から独立検証データセットを選択してください。')).toBeVisible()
})
it('distinguishes loading, failure and confirmed empty independent lists', async () => {
  const ui = (loading: boolean, error: string | null) => wrap(<VerificationConfigModal open pending={false} candidateCount={1} candidateSetHash="hash" datasets={[]} datasetsLoading={loading} datasetsError={error} currentDatasetId="d" alpha={0.05} onCancel={() => {}} onRun={() => {}} />)
  const view = render(ui(true, null))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
  fireEvent.click(screen.getByRole('radio', { name: '独立データ指定' }))
  expect(screen.getByText('利用できるデータセットを読み込んでいます…')).toBeVisible()
  expect(screen.queryByText(/別のデータセットを読み込み/)).toBeNull()
  view.rerender(ui(false, 'failed'))
  expect(screen.getByText('接続を確認して設定を開き直してください。')).toBeVisible()
  expect(screen.queryByText(/別のデータセットを読み込み/)).toBeNull()
  view.rerender(ui(false, null))
  expect(screen.getByText(/別のデータセットを読み込み/)).toBeVisible()
})
it.each(['modern', 'classic'] as const)('%s prevents duplicate verification and ignores canceled completion without unlocking a newer request', async view => {
  const post = vi.spyOn(api, 'post')
  const { local } = await mount(view); await explore(view, post)
  act(() => { local.dispatch({ type: 'test/scope', payload: ['r1'] }) })
  const old = deferred(), latest = deferred(); post.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  fireEvent.click(verificationButton(view))
  const submit = modalRun()
  act(() => { fireEvent.click(submit); fireEvent.click(submit) })
  expect(post).toHaveBeenCalledTimes(2)
  expect(submit).toBeDisabled(); expect(submit).toHaveClass('ant-btn-loading')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(verificationButton(view)); fireEvent.click(modalRun())
  expect(post).toHaveBeenCalledTimes(3)
  await act(async () => { old.resolve(verified()); await old.promise })
  expect(modalRun()).toBeDisabled(); expect(modalRun()).toHaveClass('ant-btn-loading')
  expect(screen.queryByTestId(view === 'classic' ? 'verification-badge' : 'modern-verification-badge')).toBeNull()
  await act(async () => { latest.resolve(verified()); await latest.promise })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId(view === 'classic' ? 'verification-badge' : 'modern-verification-badge')).toBeVisible()
  expect(post.mock.calls[1][1]).toEqual(expect.objectContaining({ candidateSetHash: `${view}-hash`, rowIds: ['r1', 'r2'], verificationConfig: expect.objectContaining({ method: 'holdout', test_size: 0.3, k: 5, seed: 42, alpha: 0.05 }) }))
})
it.each(['modern', 'classic'] as const)('%s dismisses pending verification on revision and ignores the stale result', async view => {
  const post = vi.spyOn(api, 'post')
  const { local } = await mount(view); await explore(view, post)
  const pending = deferred(); post.mockReturnValueOnce(pending.promise)
  fireEvent.click(verificationButton(view)); fireEvent.click(modalRun())
  act(() => { local.dispatch({ type: 'test/revision' }) })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await act(async () => { pending.resolve(verified()); await pending.promise })
  expect(screen.queryByTestId(view === 'classic' ? 'verification-badge' : 'modern-verification-badge')).toBeNull()
})
it('keeps provenance within the matching tab and cancels hidden modern verification', async () => {
  const post = vi.spyOn(api, 'post')
  const { local } = await mount('classic'); await explore('classic', post)
  expect(within(screen.getByRole('tabpanel')).getByTestId('analysis-scope-summary')).toHaveTextContent('この結果: 作業中の行 (Active) 2行')
  act(() => { local.dispatch({ type: 'test/scope', payload: ['r1'] }) })
  fireEvent.click(screen.getByRole('tab', { name: /現代的サブグループ/ }))
  const modernPanel = screen.getByRole('tabpanel')
  expect(within(modernPanel).getAllByTestId('analysis-scope-summary')).toHaveLength(1)
  expect(within(modernPanel).getByTestId('analysis-scope-summary')).not.toHaveTextContent('この結果:')
  expect(within(modernPanel).queryByText(/表示中の探索結果と検証母集団/)).toBeNull()
  await explore('modern', post)
  expect(within(modernPanel).getByTestId('analysis-scope-summary')).toHaveTextContent('この結果: 作業中の行 (Active) 1行')
  const pending = deferred(); post.mockReturnValueOnce(pending.promise)
  fireEvent.click(verificationButton('modern')); fireEvent.click(modalRun())
  fireEvent.click(screen.getByRole('tab', { name: /単変量総当たり/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(within(screen.getByRole('tabpanel')).getByTestId('analysis-scope-summary')).toHaveTextContent('この結果: 作業中の行 (Active) 2行')
  await act(async () => { pending.resolve(verified()); await pending.promise })
  fireEvent.click(screen.getByRole('tab', { name: /現代的サブグループ/ }))
  expect(screen.queryByTestId('modern-verification-badge')).toBeNull()
}, 15000)

it.each(['modern', 'classic'] as const)('%s shows verification failures inside the modal and permits a successful retry', async view => {
  const post = vi.spyOn(api, 'post')
  await mount(view); await explore(view, post)
  post.mockRejectedValueOnce(new Error('分割設定を確認してください'))
  fireEvent.click(verificationButton(view)); fireEvent.click(modalRun())
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(within(dialog).getByText('分割設定を確認してください')).toBeVisible())
  expect(modalRun()).toBeEnabled()
  expect(modalRun()).not.toHaveClass('ant-btn-loading')
  post.mockResolvedValueOnce(verified())
  fireEvent.click(modalRun())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId(view === 'classic' ? 'verification-badge' : 'modern-verification-badge')).toBeVisible()
})

it('keeps independent-list failures actionable and does not use a superseded list response', async () => {
  const post = vi.spyOn(api, 'post')
  await mount('classic'); await explore('classic', post)
  const oldList = deferred()
  vi.mocked(api.get).mockReturnValueOnce(oldList.promise).mockRejectedValueOnce(new Error('offline'))
  fireEvent.click(verificationButton('classic'))
  fireEvent.click(screen.getByRole('radio', { name: '独立データ指定' }))
  await waitFor(() => expect(screen.getByText('利用できるデータセットを読み込んでいます…')).toBeVisible())
  expect(modalRun()).toBeDisabled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(verificationButton('classic'))
  await waitFor(() => expect(screen.getByText('接続を確認して設定を開き直してください。')).toBeVisible())
  await act(async () => { oldList.resolve({ datasets: [{ datasetId: 'd2', name: '古い一覧', rowCount: 2 }] }); await oldList.promise })
  expect(screen.getByText('接続を確認して設定を開き直してください。')).toBeVisible()
  expect(modalRun()).toBeDisabled()
})

it('keeps retained classic and modern modal fields uniquely labelled', async () => {
  const post = vi.spyOn(api, 'post')
  await mount('classic'); await explore('classic', post)
  fireEvent.click(verificationButton('classic'))
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible())
  const classicSeed = screen.getByTestId('verification-seed').id
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('tab', { name: /現代的サブグループ/ }))
  await explore('modern', post)
  fireEvent.click(verificationButton('modern'))
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  const modernSeed = within(dialog).getByTestId('verification-seed')
  expect(modernSeed.id).not.toBe(classicSeed)
  expect(within(dialog).getByLabelText('乱数 seed')).toBe(modernSeed)
}, 15000)
