import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { Provider } from 'react-redux'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import ImputationModal from '../src/features/dataset/ImputationModal'

// Keep the real modal, radios, numeric inputs, target checkboxes and picker.
// These assertions cover layout contracts, not pixel dimensions in JSDOM.
// Native radio arrow-key navigation is verified separately in browser QA.
vi.mock('../src/features/charts/EChart', () => ({ default: ({ testId, resetKey }: any) =>
  <div data-testid={testId} data-preview-column={resetKey} /> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children, sizing, intrinsicSize }: any) =>
  <div data-testid="imputation-graph-contract" data-sizing={sizing} data-intrinsic-width={intrinsicSize?.width}>{children}</div>,
useGraphPopupContainer: () => undefined }))

const methods = [
  ['実験的条件付き補完', 'tabdiff'], ['KNN (k近傍)', 'knn'], ['Mean (平均値)', 'mean'],
  ['Median (中央値)', 'median'], ['Mode (最頻値)', 'mode'], ['Constant (定数)', 'constant'],
] as const
const defaultTargets = ['alpha', 'beta']

function preview(targets = defaultTargets) {
  return { planHash: 'responsive-plan', strategy: 'tabdiff', targetColumns: targets, predictorColumns: [],
    excludedColumns: [], perColumn: targets.map((column, index) => ({ column, valuesHash: `values-${column}`,
      beforeStats: { totalCount: 10, missingCount: 2, missingPercent: 20, mean: 101 + index, std: 3, median: 2 },
      afterStats: { totalCount: 10, missingCount: 0, missingPercent: 0, mean: 201 + index, std: 4, median: 3 },
      histogram: [{ binLabel: '1–5', beforeCount: 8, afterCount: 10, imputedAdded: 2 }],
    })),
  }
}

function mount(targets = defaultTargets, instances = 1) {
  const base = store.getState()
  const columns = [...targets, 'predictor'].map(name => ({ name, label: `${name}の質問文`, columnId: name,
    scaleType: 'ratio', role: 'question', multiResponseGroup: null }))
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns, isLoading: false },
  }
  const local = configureStore({ reducer: () => state, middleware: get => get({ serializableCheck: false }) })
  const missing = targets.map(name => ({ name, missing: 2, total: 10 }))
  const close = vi.fn(), success = vi.fn()
  const ui = (firstOpen = true) => <ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    {Array.from({ length: instances }, (_, index) => <ImputationModal key={index} open={index > 0 || firstOpen}
      datasetId="d" columnsWithMissing={missing} onClose={close} onSuccess={success} />)}
  </Provider></ConfigProvider>
  return { ...render(ui()), close, success, ui }
}

function chooseMethod(name: string) {
  const radio = within(screen.getByRole('radiogroup', { name: '補完アルゴリズム' })).getByRole('radio', { name, exact: true })
  fireEvent.click(radio)
  expect(radio).toBeChecked()
}
function numberDraft(name: string, value: string) {
  const input = screen.getByRole('spinbutton', { name, exact: true })
  act(() => { input.focus() })
  fireEvent.change(input, { target: { value } })
}
async function getPreview() {
  fireEvent.click(screen.getByRole('button', { name: 'プレビュー更新' }))
  const chart = await screen.findByTestId('imputation-histogram')
  await waitFor(() => expect(chart).toBeVisible())
  return chart
}
function radioName(group: HTMLElement) {
  const radios = within(group).getAllByRole('radio', { hidden: true }) as HTMLInputElement[]
  expect(radios[0].name).not.toBe('')
  for (const radio of radios) expect(radio.name).toBe(radios[0].name)
  return radios[0].name
}

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  for (const kind of ['success', 'warning', 'error'] as const) vi.spyOn(message, kind).mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('responsive imputation controls', () => {
  it('exposes all six wrapping native method radios with unchanged labels, values and default', () => {
    mount()
    const group = screen.getByRole('radiogroup', { name: '補完アルゴリズム' })
    const choices = screen.getByTestId('impute-strategy')
    expect(group).toContainElement(choices)
    expect(choices).toHaveStyle({ display: 'flex', flexWrap: 'wrap', maxWidth: '100%', minWidth: '0' })
    expect(within(group).getAllByRole('radio')).toHaveLength(6)
    radioName(group)
    for (const [label, value] of methods) {
      const radio = within(group).getByRole('radio', { name: label, exact: true })
      expect(radio).toHaveAttribute('type', 'radio')
      expect(radio).toHaveAttribute('value', value)
      expect(radio).toBeEnabled()
      expect(radio).not.toHaveAttribute('tabindex', '-1')
      expect(radio.closest('label')).toHaveStyle({ maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' })
      act(() => { radio.focus() })
      expect(radio).toHaveFocus()
    }
    expect(within(group).getByRole('radio', { name: methods[0][0], exact: true })).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: '逆拡散ステップ数 T' })).toHaveValue('20')
    expect(screen.getByRole('spinbutton', { name: '温度 (Temperature)' })).toHaveValue('1.0')
    expect(screen.getByRole('spinbutton', { name: 'シード' })).toHaveValue('42')
    const title = screen.getByRole('heading', { name: '欠損値補完フィルター (Replace Missing Values)' })
    expect(title).toHaveStyle({ flex: '1 1 320px', minWidth: '0' })
    expect(title.parentElement).toHaveStyle({ display: 'flex', flexWrap: 'wrap' })
    expect(screen.getByText('実験的条件付き補完 / Statistical')).toHaveStyle({ whiteSpace: 'normal', maxWidth: '100%' })
    expect(screen.getByTestId('impute-predictor-mode')).toHaveStyle({ display: 'flex', flexWrap: 'wrap' })
    expect(radioName(screen.getByRole('radiogroup', { name: '説明変数の指定方法' }))).not.toBe(radioName(group))
  })

  it('selects every method and retains each method’s edited parameters on return', () => {
    const post = vi.spyOn(api, 'post')
    mount()
    numberDraft('逆拡散ステップ数 T', '30'); numberDraft('温度 (Temperature)', '0.35'); numberDraft('シード', '7')
    chooseMethod('KNN (k近傍)')
    expect(screen.getByRole('spinbutton', { name: '近傍数 k' })).toHaveValue('5')
    numberDraft('近傍数 k', '9')
    chooseMethod('Constant (定数)')
    expect(screen.getByRole('textbox', { name: '補完定数値' })).toHaveValue('0')
    fireEvent.change(screen.getByRole('textbox', { name: '補完定数値' }), { target: { value: '17' } })
    for (const [label] of methods.slice(2, 5)) {
      chooseMethod(label)
      expect(screen.queryByRole('spinbutton')).toBeNull()
    }
    chooseMethod('実験的条件付き補完')
    expect(screen.getByRole('spinbutton', { name: '逆拡散ステップ数 T' })).toHaveValue('30')
    expect(screen.getByRole('spinbutton', { name: '温度 (Temperature)' })).toHaveValue('0.35')
    expect(screen.getByRole('spinbutton', { name: 'シード' })).toHaveValue('7')
    chooseMethod('KNN (k近傍)')
    expect(screen.getByRole('spinbutton', { name: '近傍数 k' })).toHaveValue('9')
    chooseMethod('Constant (定数)')
    expect(screen.getByRole('textbox', { name: '補完定数値' })).toHaveValue('17')
    expect(post).not.toHaveBeenCalled()
  })

  it('switches preview targets without refetching or clearing the current plan and keeps intrinsic chart sizing', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(preview())
    mount(); const chart = await getPreview()
    const group = screen.getByRole('radiogroup', { name: '対象列:' })
    expect(screen.getByText('101.00')).toBeVisible()
    fireEvent.click(within(group).getByRole('radio', { name: 'beta', exact: true }))
    expect(screen.getByTestId('imputation-histogram')).toBe(chart)
    expect(chart).toHaveAttribute('data-preview-column', 'beta')
    expect(screen.getByText('102.00')).toBeVisible()
    expect(screen.getByText('202.00')).toBeVisible()
    expect(screen.queryByText('101.00')).toBeNull()
    expect(screen.queryByText(/設定が変更されています/)).toBeNull()
    expect(post).toHaveBeenCalledOnce()
    expect(screen.getByTestId('imputation-graph-contract')).toHaveAttribute('data-sizing', 'intrinsic')
    expect(screen.getByTestId('imputation-graph-contract')).toHaveAttribute('data-intrinsic-width', '560')
    const stats = screen.getByText('欠損数 変化').parentElement!.parentElement!
    expect(stats).toHaveStyle({ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))' })
    fireEvent.click(screen.getByRole('button', { name: '補完を適用' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/datasets/d/impute', {
      columns: defaultTargets, predictorColumns: undefined, strategy: 'tabdiff',
      options: { seed: 42, num_steps: 20, temperature: 1 }, inPlace: true, planHash: 'responsive-plan',
    }))
  })

  it('allows long target names and preview headers to wrap without truncating the native radio labels', async () => {
    const targets = ['long_target_name_without_spaces_'.repeat(6), '長い対象列の名前'.repeat(10)]
    vi.spyOn(api, 'post').mockResolvedValue(preview(targets))
    mount(targets); await getPreview()
    const group = screen.getByRole('radiogroup', { name: '対象列:' })
    expect(group).toHaveStyle({ flexWrap: 'wrap', minWidth: '0' })
    expect(group.parentElement).toHaveStyle({ flexWrap: 'wrap' })
    expect(group.closest('.ant-card-head-title')).toHaveStyle({ whiteSpace: 'normal', minWidth: '0' })
    const targetChecks = screen.getByRole('group', { name: '補完対象の検索結果' })
    for (const name of targets) {
      const radio = within(group).getByRole('radio', { name, exact: true })
      const label = radio.closest('label')!
      expect(label).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: '100%', minWidth: '0' })
      expect(label.textContent).toBe(name)
      const question = label.querySelector('[data-column-question]') as HTMLElement
      expect(question).toHaveAttribute('tabindex', '0')
      act(() => { question.focus() })
      expect(question).toHaveFocus()
      expect(await screen.findByRole('tooltip')).toHaveTextContent(`${name}の質問文`)
      act(() => { question.blur() })
      expect(within(targetChecks).getByRole('checkbox', { name: `${name} 欠損 2 (20.0%)` }).closest('label'))
        .toHaveStyle({ maxWidth: '100%', overflowWrap: 'anywhere' })
    }
    fireEvent.click(within(group).getByRole('radio', { name: targets[1], exact: true }))
    expect(screen.getByTestId('imputation-histogram')).toHaveAttribute('data-preview-column', targets[1])
  })

  it('disables method, predictor-mode and preview-target radios throughout the committed mutation', async () => {
    let resolve!: (value: unknown) => void
    const pending = new Promise(resolvePromise => { resolve = resolvePromise })
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(preview()).mockReturnValueOnce(pending)
    const view = mount(); await getPreview()
    const apply = screen.getByRole('button', { name: '補完を適用' })
    fireEvent.click(apply); fireEvent.click(apply)
    expect(post).toHaveBeenCalledTimes(2)
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Mean (平均値)', exact: true }))
    fireEvent.click(screen.getByRole('radio', { name: '個別に指定', exact: true }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '対象列:' })).getByRole('radio', { name: 'beta', exact: true }))
    expect(screen.getByRole('radio', { name: '実験的条件付き補完', exact: true })).toBeChecked()
    expect(screen.getByRole('radio', { name: '自動（目的列以外の全列）', exact: true })).toBeChecked()
    expect(screen.getByTestId('imputation-histogram')).toHaveAttribute('data-preview-column', 'alpha')
    await act(async () => { resolve({}); await pending })
    expect(view.success).toHaveBeenCalledWith('d')
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeEnabled()
  })

  it('isolates native radio names and state across simultaneous and retained dialog instances', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(preview())
    const view = mount(defaultTargets, 2)
    const dialogs = screen.getAllByRole('dialog')
    for (const dialog of dialogs) fireEvent.click(within(dialog).getByRole('button', { name: 'プレビュー更新' }))
    await waitFor(() => expect(screen.getAllByRole('radiogroup', { name: '対象列:' })).toHaveLength(2))
    const names = dialogs.flatMap(dialog => ['補完アルゴリズム', '説明変数の指定方法', '対象列:']
      .map(name => radioName(within(dialog).getByRole('radiogroup', { name }))))
    expect(new Set(names).size).toBe(6)
    fireEvent.click(within(dialogs[0]).getByRole('radio', { name: 'beta', exact: true }))
    expect(within(dialogs[1]).getByRole('radio', { name: 'alpha', exact: true })).toBeChecked()
    fireEvent.click(within(dialogs[0]).getByRole('radio', { name: 'Mean (平均値)', exact: true }))
    view.rerender(view.ui(false))
    await waitFor(() => expect(dialogs[0]).not.toBeVisible())
    const retainedMethod = within(dialogs[0]).getByRole('radio', { name: 'Mean (平均値)', hidden: true })
    expect(retainedMethod).toBeChecked()
    fireEvent.click(within(dialogs[1]).getByRole('radio', { name: 'KNN (k近傍)', exact: true }))
    expect(retainedMethod).toBeChecked()
    expect(within(dialogs[1]).getByRole('radio', { name: 'KNN (k近傍)', exact: true })).toBeChecked()
    view.rerender(view.ui())
    await waitFor(() => expect(dialogs[0]).toBeVisible())
    expect(within(dialogs[0]).getByRole('radio', { name: 'Mean (平均値)', exact: true })).toBeChecked()
  })
})
