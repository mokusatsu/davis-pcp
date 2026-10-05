import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import ImputationModal from '../src/features/dataset/ImputationModal'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Keep the real modal, inputs, target controls and column picker. Chart rendering
// has its own tests; this suite checks whether a current preview is presented.
vi.mock('../src/features/charts/EChart', () => ({ default: ({ testId }: any) => <div data-testid={testId} /> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div>, useGraphPopupContainer: () => undefined }))

const columns = [
  { name: 'alpha', label: '対象の質問A' },
  { name: 'beta', label: '対象の質問B' },
  { name: 'gamma', label: '説明の質問C' },
  { name: 'delta', label: '説明の質問D' },
].map(column => ({ ...column, columnId: column.name, scaleType: 'ratio', role: 'question', multiResponseGroup: null }))
const missing = columns.slice(0, 2).map(column => ({ name: column.name, missing: 2, total: 10 }))
const baseBody = { columns: ['alpha', 'beta'], predictorColumns: undefined, strategy: 'tabdiff',
  options: { seed: 42, num_steps: 20, temperature: 1 } }
const staleText = '設定が変更されています。「プレビュー更新」で現在の設定の分布を確認できます。'

function preview(planHash = 'current-plan', targets = ['alpha', 'beta']) {
  return { planHash, strategy: 'tabdiff', targetColumns: targets, predictorColumns: ['gamma'],
    excludedColumns: [{ column: 'EXCLUDED_COLUMN', columnId: null, reason: 'PREDICTOR_WEIGHT_EXCLUDED' }],
    warnings: [{ code: 'PREVIEW_WARNING', message: `warning for ${planHash}` }],
    perColumn: targets.map(column => ({ column, valuesHash: `${planHash}-${column}`,
      beforeStats: { totalCount: 10, missingCount: 2, missingPercent: 20, mean: 2, std: 1, median: 2 },
      afterStats: { totalCount: 10, missingCount: 0, missingPercent: 0, mean: 3, std: 2, median: 3 },
      histogram: [{ binLabel: '1–5', beforeCount: 8, afterCount: 10, imputedAdded: 2 }],
    })),
  }
}
function deferred() {
  let resolve!: (value: any) => void
  let reject!: (error: any) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function mount() {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns, isLoading: false },
  }
  const local = configureStore({ reducer: () => state, middleware: get => get({ serializableCheck: false }) })
  const close = vi.fn(), success = vi.fn()
  const ui = (datasetId = 'd', active = true) => <ConfigProvider theme={{ token: { motion: false } }}>
    <Provider store={local}><AnalysisViewActivityContext.Provider value={active}>
      <ImputationModal open datasetId={datasetId} columnsWithMissing={missing} onClose={close} onSuccess={success} />
    </AnalysisViewActivityContext.Provider></Provider>
  </ConfigProvider>
  return { ...render(ui()), close, success, ui }
}
function chooseStrategy(name: string) { fireEvent.click(screen.getByRole('radio', { name, exact: true })) }
function numberDraft(name: string, value: string) {
  const input = screen.getByRole('spinbutton', { name, exact: true })
  act(() => { input.focus() })
  fireEvent.change(input, { target: { value } })
  return input
}
function activateAfterBlur(name: string, input: HTMLElement) {
  const button = screen.getByRole('button', { name, exact: true })
  fireEvent.mouseDown(button); fireEvent.blur(input); fireEvent.mouseUp(button); fireEvent.click(button)
}
function target(name: string) {
  return within(screen.getByRole('group', { name: '補完対象の検索結果' })).getByRole('checkbox', { name: new RegExp(name) })
}
async function getPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'プレビュー更新' }))
  const chart = await screen.findByTestId('imputation-histogram')
  await waitFor(() => expect(chart).toBeVisible())
}
function expectNoOldPreview() {
  expect(screen.queryByTestId('imputation-histogram')).toBeNull()
  expect(screen.queryByText('欠損数 変化')).toBeNull()
  expect(screen.queryByText('平均値 (Mean)')).toBeNull()
  expect(screen.queryByText(/EXCLUDED_COLUMN:/)).toBeNull()
  expect(screen.queryByText(/PREVIEW_WARNING:/)).toBeNull()
}
async function openPredictors() {
  fireEvent.click(screen.getByRole('button', { name: '補完の説明変数を選択' }))
  const search = await screen.findByRole('textbox', { name: '補完の説明変数を変数名・質問文で絞り込み' })
  const dialog = search.closest('[role="dialog"]') as HTMLElement
  const results = within(dialog).getByRole('group', { name: '補完の説明変数の検索結果' })
  return { search, dialog, results }
}
async function commitPredictors(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}
function selectedPredictorNames() {
  const picker = screen.getByTestId('impute-predictors').closest('.column-select-multi-wrap')!
  return Array.from(picker.querySelectorAll('.ant-tag')).map(tag => tag.textContent)
}

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  for (const kind of ['success', 'warning', 'error'] as const) vi.spyOn(message, kind).mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('imputation preview identity and Apply contract', () => {
  it('applies defaults directly without requiring a preview and blocks duplicate committed mutations', async () => {
    const pending = deferred(), post = vi.spyOn(api, 'post').mockReturnValue(pending.promise)
    const view = mount()
    const apply = screen.getByRole('button', { name: '補完を適用' })
    fireEvent.click(apply); fireEvent.click(apply)
    expect(post).toHaveBeenCalledOnce()
    expect(post).toHaveBeenCalledWith('/datasets/d/impute', { ...baseBody, inPlace: true, planHash: undefined })
    expect(apply).toBeDisabled()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'プレビュー更新' })).toBeDisabled()
    for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeDisabled()
    view.rerender(view.ui('new-dataset'))
    fireEvent.click(screen.getByTestId('btn-execute-imputation'))
    expect(post).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve({}); await pending.promise })
    expect(view.success).toHaveBeenCalledWith('d')
    expect(view.close).not.toHaveBeenCalled()
  })

  it('keeps an unchanged completed preview and sends its exact plan hash', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); await getPreview()
    expect(screen.getByText('欠損数 変化')).toBeVisible()
    expect(screen.getByText(/PREVIEW_WARNING: warning for current-plan/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', { ...baseBody, inPlace: true, planHash: 'current-plan' }))
  })

  it.each([
    ['Constant (定数)', '補完定数値', '99', 'constant', { seed: 42, constant_value: '99' }],
    ['実験的条件付き補完', '温度 (Temperature)', '0.35', 'tabdiff', { seed: 42, num_steps: 20, temperature: 0.35 }],
    ['実験的条件付き補完', 'シード', '7', 'tabdiff', { seed: 7, num_steps: 20, temperature: 1 }],
    ['実験的条件付き補完', '逆拡散ステップ数 T', '30', 'tabdiff', { seed: 42, num_steps: 30, temperature: 1 }],
    ['KNN (k近傍)', '近傍数 k', '6', 'knn', { seed: 42, knn_neighbors: 6 }],
  ])('hides obsolete preview details after editing %s / %s and applies the current settings', async (method, label, value, strategy, options) => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); chooseStrategy(method); await getPreview()
    const input = label === '補完定数値' ? screen.getByRole('textbox', { name: label }) : screen.getByRole('spinbutton', { name: label })
    act(() => { input.focus() }); fireEvent.change(input, { target: { value } })
    expectNoOldPreview(); expect(screen.getByText(staleText)).toBeVisible()
    activateAfterBlur('補完を適用', input)
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', {
      ...baseBody, strategy, options, inPlace: true, planHash: undefined,
    }))
  })

  it('invalidates a completed preview when target membership changes', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); await getPreview(); fireEvent.click(target('beta'))
    expectNoOldPreview(); expect(screen.getByText(staleText)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', {
      ...baseBody, columns: ['alpha'], inPlace: true, planHash: undefined,
    }))
  })

  it('keeps completed previews and hidden targets when only the target search changes', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); await getPreview()
    fireEvent.change(screen.getByRole('textbox', { name: '補完対象を変数名・質問文で検索' }), { target: { value: '質問B' } })
    expect(screen.getByRole('status')).toHaveTextContent('2件選択中（検索結果外 1件）')
    expect(screen.getByTestId('imputation-histogram')).toBeVisible()
    expect(screen.queryByText(staleText)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', { ...baseBody, inPlace: true, planHash: 'current-plan' }))
  })

  it('ignores an in-flight response superseded by edited settings', async () => {
    const old = deferred()
    vi.spyOn(api, 'post').mockReturnValueOnce(old.promise).mockResolvedValue(preview('fresh-plan'))
    mount(); fireEvent.click(screen.getByRole('button', { name: 'プレビュー更新' }))
    numberDraft('温度 (Temperature)', '0.5')
    await act(async () => { old.resolve(preview('old-plan')); await old.promise })
    expectNoOldPreview()
    await getPreview()
    expect(screen.getByText(/PREVIEW_WARNING: warning for fresh-plan/)).toBeVisible()
    expect(screen.queryByText(/old-plan/)).toBeNull()
  })

  it('does not revive a late preview after its view is deactivated and reopened', async () => {
    const pending = deferred()
    vi.spyOn(api, 'post').mockReturnValue(pending.promise)
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: 'プレビュー更新' }))
    view.rerender(view.ui('d', false))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(view.close).toHaveBeenCalled()
    await act(async () => { pending.resolve(preview('closed-view-plan')); await pending.promise })
    view.rerender(view.ui())
    await screen.findByRole('dialog')
    expectNoOldPreview()
    expect(view.success).not.toHaveBeenCalled()
  })

  it('refreshes a rejected stale server plan and sends the replacement hash on retry', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(preview('old-plan'))
      .mockRejectedValueOnce({ code: 'IMPUTATION_PLAN_STALE', message: 'changed dataset revision' })
      .mockResolvedValueOnce(preview('revised-plan')).mockResolvedValue({})
    mount(); await getPreview()
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await screen.findByText(/PREVIEW_WARNING: warning for revised-plan/)
    await waitFor(() => expect(screen.getByRole('button', { name: '補完を適用' })).toBeEnabled())
    expect(post.mock.calls[1]).toEqual(['/datasets/d/impute', { ...baseBody, inPlace: true, planHash: 'old-plan' }])
    expect(post.mock.calls[2]).toEqual(['/datasets/d/impute/preview', baseBody])
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', { ...baseBody, inPlace: true, planHash: 'revised-plan' }))
  })
})

describe('disjoint manual predictor projection', () => {
  it.each(['checkbox', 'filtered bulk'] as const)('removes a newly targeted predictor from visible values and requests via %s', async action => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); fireEvent.click(target('beta'))
    fireEvent.click(screen.getByRole('radio', { name: '個別に指定' }))
    expect(screen.getByRole('combobox', { name: '補完の説明変数' })).toBeInTheDocument()
    let picker = await openPredictors()
    fireEvent.click(within(picker.results).getByRole('checkbox', { name: /beta/ }))
    fireEvent.click(within(picker.results).getByRole('checkbox', { name: /gamma/ }))
    await commitPredictors(picker.dialog)
    expect(selectedPredictorNames()).toEqual(expect.arrayContaining([expect.stringContaining('beta'), expect.stringContaining('gamma')]))
    await getPreview()
    if (action === 'checkbox') fireEvent.click(target('beta'))
    else {
      fireEvent.change(screen.getByRole('textbox', { name: '補完対象を変数名・質問文で検索' }), { target: { value: '質問B' } })
      fireEvent.click(screen.getByRole('button', { name: '検索結果を全選択（1件）' }))
    }
    expectNoOldPreview()
    expect(selectedPredictorNames()).toEqual([expect.stringContaining('gamma')])
    picker = await openPredictors()
    expect(within(picker.results).queryByRole('checkbox', { name: /beta/ })).toBeNull()
    expect(within(picker.results).getByRole('checkbox', { name: /gamma/ })).toBeChecked()
    fireEvent.click(within(picker.dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(picker.dialog).not.toBeVisible())
    await getPreview()
    expect(post).toHaveBeenLastCalledWith('/datasets/d/impute/preview', { ...baseBody, predictorColumns: ['gamma'] })
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', {
      ...baseBody, predictorColumns: ['gamma'], inPlace: true, planHash: 'current-plan',
    }))
  })

  it('preserves explicit empty manual predictors, while automatic mode omits that choice', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); fireEvent.click(target('beta'))
    fireEvent.click(screen.getByRole('radio', { name: '個別に指定' }))
    const picker = await openPredictors()
    fireEvent.click(within(picker.results).getByRole('checkbox', { name: /beta/ }))
    await commitPredictors(picker.dialog); fireEvent.click(target('beta'))
    expect(selectedPredictorNames()).toEqual([])
    await getPreview()
    expect(post).toHaveBeenLastCalledWith('/datasets/d/impute/preview', { ...baseBody, predictorColumns: [] })
    fireEvent.click(screen.getByRole('radio', { name: '自動（目的列以外の全列）' }))
    expectNoOldPreview()
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', { ...baseBody, inPlace: true, planHash: undefined }))
  })

  it('preserves the preview and hidden manual selections across predictor-search-only confirmation', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); fireEvent.click(screen.getByRole('radio', { name: '個別に指定' }))
    let picker = await openPredictors()
    fireEvent.click(within(picker.results).getByRole('checkbox', { name: /gamma/ }))
    fireEvent.click(within(picker.results).getByRole('checkbox', { name: /delta/ }))
    await commitPredictors(picker.dialog); await getPreview()
    picker = await openPredictors()
    fireEvent.change(picker.search, { target: { value: '質問C' } })
    expect(within(picker.results).getAllByRole('checkbox')).toHaveLength(1)
    expect(within(picker.dialog).getByRole('status')).toHaveTextContent('2件選択中（検索結果外 1件）')
    await commitPredictors(picker.dialog)
    expect(selectedPredictorNames()).toHaveLength(2)
    expect(screen.getByTestId('imputation-histogram')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', {
      ...baseBody, predictorColumns: ['gamma', 'delta'], inPlace: true, planHash: 'current-plan',
    }))
  })
})

describe('validated numeric drafts', () => {
  it.each([
    ['実験的条件付き補完', '逆拡散ステップ数 T', '', '20'],
    ['実験的条件付き補完', '逆拡散ステップ数 T', '4', '5'],
    ['実験的条件付き補完', '逆拡散ステップ数 T', '100.5', '100'],
    ['実験的条件付き補完', '逆拡散ステップ数 T', '20.5', '21'],
    ['実験的条件付き補完', '逆拡散ステップ数 T', 'abc', '20'],
    ['実験的条件付き補完', '温度 (Temperature)', '', '1'],
    ['実験的条件付き補完', '温度 (Temperature)', '0', '0.1'],
    ['実験的条件付き補完', '温度 (Temperature)', '2.1', '2'],
    ['実験的条件付き補完', 'シード', '', '42'],
    ['実験的条件付き補完', 'シード', '-1', '0'],
    ['実験的条件付き補完', 'シード', '42.5', '43'],
    ['実験的条件付き補完', 'シード', '9007199254740992', '9007199254740991'],
    ['KNN (k近傍)', '近傍数 k', '', '5'],
    ['KNN (k近傍)', '近傍数 k', '0', '1'],
    ['KNN (k近傍)', '近傍数 k', '51', '50'],
    ['KNN (k近傍)', '近傍数 k', '5.5', '6'],
  ])('keeps %s / %s invalid draft %j blocked through blur and recovers with %j', async (method, label, invalid, valid) => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); chooseStrategy(method)
    const input = numberDraft(label, invalid)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(/設定を確認してください/)
    expect(screen.getByRole('button', { name: 'プレビュー更新' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '補完を適用' })).toBeDisabled()
    activateAfterBlur('プレビュー更新', input); activateAfterBlur('補完を適用', input)
    expect(post).not.toHaveBeenCalled()
    if (invalid === '') expect(input).toHaveValue('')
    else if (invalid !== 'abc') expect(Number((input as HTMLInputElement).value)).toBe(Number(invalid))
    expect(screen.getByRole('button', { name: '補完を適用' })).toBeDisabled()
    numberDraft(label, valid); fireEvent.blur(input)
    expect(Number((input as HTMLInputElement).value)).toBe(Number(valid))
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: '補完を適用' })).toBeEnabled()
    activateAfterBlur('プレビュー更新', input)
    expect(post).toHaveBeenCalledOnce()
    const key = label === '逆拡散ステップ数 T' ? 'num_steps' : label === 'シード' ? 'seed'
      : label === '温度 (Temperature)' ? 'temperature' : 'knn_neighbors'
    expect(post).toHaveBeenLastCalledWith('/datasets/d/impute/preview', expect.objectContaining({ options: expect.objectContaining({ [key]: Number(valid) }) }))
    await screen.findByTestId('imputation-histogram')
  })

  it('preserves temperature fractions and valid zero seed exactly in preview and Apply', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); numberDraft('シード', '0')
    const temperature = numberDraft('温度 (Temperature)', '0.35')
    activateAfterBlur('プレビュー更新', temperature)
    await screen.findByTestId('imputation-histogram')
    expect(temperature).toHaveValue('0.35')
    const body = { ...baseBody, options: { seed: 0, num_steps: 20, temperature: 0.35 } }
    expect(post).toHaveBeenLastCalledWith('/datasets/d/impute/preview', body)
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', { ...body, inPlace: true, planHash: 'current-plan' }))
  })

  it('does not block other algorithms on hidden invalid drafts or send a null seed', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); numberDraft('シード', ''); numberDraft('逆拡散ステップ数 T', '')
    chooseStrategy('KNN (k近傍)')
    expect(screen.getByRole('spinbutton', { name: '近傍数 k' })).toHaveValue('5')
    await getPreview()
    expect(post).toHaveBeenLastCalledWith('/datasets/d/impute/preview', { ...baseBody, strategy: 'knn', options: { seed: 42, knn_neighbors: 5 } })
    numberDraft('近傍数 k', '')
    chooseStrategy('Constant (定数)')
    expect(screen.getByRole('textbox', { name: '補完定数値' })).toHaveValue('0')
    await getPreview()
    expect(post).toHaveBeenLastCalledWith('/datasets/d/impute/preview', { ...baseBody, strategy: 'constant', options: { seed: 42, constant_value: '0' } })
    chooseStrategy('実験的条件付き補完')
    expect(screen.getByRole('spinbutton', { name: 'シード' })).toHaveValue('')
    expect(screen.getByRole('spinbutton', { name: '逆拡散ステップ数 T' })).toHaveValue('')
    expect(screen.getByRole('button', { name: '補完を適用' })).toBeDisabled()
    chooseStrategy('KNN (k近傍)')
    expect(screen.getByRole('spinbutton', { name: '近傍数 k' })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'プレビュー更新' })).toBeDisabled()
  })
})
