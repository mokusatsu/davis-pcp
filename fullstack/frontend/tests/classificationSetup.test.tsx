import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { editorModalOpened } from '../src/features/dataset/codebookSlice'
import LogisticRegressionPage from '../src/features/models/LogisticRegressionPage'
import DiscriminantAnalysisPage from '../src/features/models/DiscriminantAnalysisPage'

// Keep real fields, pickers, disclosures, radios and the keyboard-operated slider.
// Charts have separate interaction tests.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456', selectionColor: '#abcdef' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div>, useGraphPopupContainer: () => undefined, useGraphViewport: () => ({ scale: 1, zoom: null }) }))
vi.mock('../src/features/models/ModelScatter', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/models/FamdFigure', () => ({ CorrelationCircle: () => null }))

type Page = 'logistic' | 'discriminant'
function mount(page: Page, empty = false) {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'] },
    globalVariables: { ...base.globalVariables, activeEntities: empty ? [] : ['x', 'z', 'y'].map(columnId => ({ kind: 'column', columnId })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false, columns: ['x', 'z', 'y'].map(name => ({
      name, columnId: name, label: name, role: 'question', scaleType: name === 'y' ? 'nominal' : 'ratio', multiResponseGroup: null,
    })) },
  }
  const local = configureStore({ reducer: (current = state, action: any) => action.type === 'test/revision'
    ? { ...current, selection: { ...current.selection, dataRevision: current.selection.dataRevision + 1 } } : current,
    middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>{page === 'logistic' ? <LogisticRegressionPage /> : <DiscriminantAnalysisPage />}</Provider></ConfigProvider>)
  return { ...view, local, dispatch }
}
async function choose(page: Page, field: 'target' | 'features', value: string) {
  const input = document.getElementById(`${page}-${field}`)!
  fireEvent.click(input.closest('.analysis-field')!.querySelector('button')!)
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  fireEvent.click(within(dialog).getByRole(field === 'features' ? 'checkbox' : 'radio', { name: value, exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
async function ready(page: Page) {
  await choose(page, 'target', 'y')
  await choose(page, 'features', 'x')
}
function settings() { return screen.getByText(/^(モデルの詳細設定|判別分析の詳細設定)$/).closest('details')! }
function openSettings() { act(() => { settings().open = true }) }
function result(page: Page): any {
  if (page === 'discriminant') return {
    target: 'y', classes: ['0', '1'], features: ['x'], method: 'lda', excludedRowCount: 0,
    targetDtype: 'Int64', classCategories: { '0': [{ rawValue: '0', code: '0', label: '0' }], '1': [{ rawValue: '1', code: '1', label: '1' }] },
    axes: [{ axisIndex: 1, eigenvalue: 1, explainedVarianceRatio: 1, canonicalCorrelation: 0.8 }], loadings: [],
    samples: [{ rowId: 'r1', actualClass: '0', predictedClass: '0', ld1: 0, ld2: 0, isMisclassified: false, posteriorProbabilities: {}, mahalanobisDistance: 1 }],
    misclassifiedRowIds: [], accuracy: 1, wilksLambdaOverall: 0.2, pOverall: 0.01,
  }
  return {
    target: 'y', classes: ['0', '1'], features: ['x'], excludedRowCount: 0, coefficients: [],
    targetDtype: 'Int64', classCategories: [[{ rawValue: '0', code: '0', label: '0' }], [{ rawValue: '1', code: '1', label: '1' }]],
    diagnostics: { completeSeparation: false, inferenceStatus: 'available' },
    fitMetrics: { logLikelihood: -1, nullLogLikelihood: -2, aic: 4, bic: 5, pseudoR2: 0.5, converged: true },
    samples: [
      { rowId: 'r1', actual: 1, predictedProb: 0.5, predictedClass: 1, isMisclassified: false, featureValues: { x: 1 } },
      { rowId: 'r2', actual: 0, predictedProb: 0.2, predictedClass: 0, isMisclassified: false, featureValues: { x: 2 } },
    ], curves: { x: [{ x: 1, probability: 0.5 }] }, evidenceClass: 'JAR-INITIAL',
  }
}
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['logistic', 'discriminant'] as const)('%s keeps required variables visible, optional panels closed, and request defaults unchanged', async page => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result(page))
  const view = mount(page)
  expect([...view.container.querySelectorAll('details')].every(panel => !panel.open)).toBe(true)
  expect(document.getElementById(`${page}-target`)!.closest('.column-select-multi-wrap')).toBeVisible()
  expect(document.getElementById(`${page}-features`)!.closest('.column-select-multi-wrap')).toBeVisible()
  expect(document.getElementById(`${page}-target`)).toHaveAccessibleName(page === 'logistic' ? 'ロジスティック回帰の目的変数' : '判別分析の目的クラス')
  expect(document.getElementById(`${page}-features`)).toHaveAccessibleDescription(/順序・間隔・比率尺度/)
  const run = screen.getByTestId(`run-${page}-btn`)
  expect(run).toBeDisabled()
  expect(run.closest('.analysis-run-row')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'MA軸を追加' })).toBeVisible()
  await ready(page)
  expect(run).toBeEnabled()
  fireEvent.click(run)
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith(`/models/${page}`, {
    datasetId: 'd', targetColumn: 'y', featureColumns: ['x'], activeRowIds: ['r1', 'r2'], expectedDataRevision: 3, expectedSchemaRevision: 2,
    ...(page === 'logistic' ? { intercept: true, regularization: 'none', cValue: 1, cutoff: 0.5 }
      : { method: 'lda', shrinkage: 'none', priors: 'proportional', stepwiseConfig: undefined }),
  })
})

it('retains changed logistic options across collapsing and submits them from the closed panel', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result('logistic'))
  mount('logistic'); await ready('logistic'); openSettings()
  fireEvent.click(screen.getByRole('radio', { name: 'L2' }))
  const c = screen.getByLabelText('C値 (Inverse Penalty)')
  fireEvent.change(c, { target: { value: '2.5' } }); fireEvent.blur(c)
  fireEvent.click(screen.getByRole('checkbox', { name: '切片項 (Intercept)' }))
  act(() => { settings().open = false })
  expect(c).toHaveValue('2.5')
  expect(settings().querySelector('summary')).toHaveTextContent('正則化: L2 / C値: 2.5 / 切片: なし')
  openSettings()
  expect(screen.getByLabelText('C値 (Inverse Penalty)')).toBe(c)
  expect(screen.getByRole('checkbox', { name: '切片項 (Intercept)' })).not.toBeChecked()
  act(() => { settings().open = false })
  fireEvent.click(screen.getByTestId('run-logistic-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/logistic', expect.objectContaining({ intercept: false, regularization: 'l2', cValue: 2.5, cutoff: 0.5 })))
})

it('retains discriminant conditional settings and QDA-disabled shrinkage when changing methods', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result('discriminant'))
  mount('discriminant'); await ready('discriminant'); openSettings()
  fireEvent.click(screen.getByRole('radio', { name: 'Auto' }))
  fireEvent.click(screen.getByRole('radio', { name: '等確率' }))
  fireEvent.click(screen.getByRole('radio', { name: 'QDA' }))
  expect(screen.getByRole('radio', { name: 'Auto' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked()
  fireEvent.click(screen.getByRole('radio', { name: 'Stepwise' }))
  const enter = screen.getByLabelText('投入 F値 (F-Enter)')
  const remove = screen.getByLabelText('除外 F値 (F-Remove)')
  expect(enter).toHaveValue('3.84'); expect(remove).toHaveValue('2.71')
  fireEvent.change(enter, { target: { value: '4.5' } }); fireEvent.blur(enter)
  fireEvent.change(remove, { target: { value: '2' } }); fireEvent.blur(remove)
  act(() => { settings().open = false })
  expect(settings().querySelector('summary')).toHaveTextContent('投入F: 4.5・除外F: 2')
  openSettings()
  expect(screen.getByLabelText('投入 F値 (F-Enter)')).toBe(enter)
  fireEvent.click(screen.getByRole('radio', { name: 'LDA' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Stepwise' }))
  expect(screen.getByLabelText('投入 F値 (F-Enter)')).toHaveValue('4.5')
  act(() => { settings().open = false })
  fireEvent.click(screen.getByTestId('run-discriminant-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/discriminant', expect.objectContaining({
    method: 'stepwise', shrinkage: 'auto', priors: 'uniform', stepwiseConfig: { fEnter: 4.5, fRemove: 2, maxSteps: 20 },
  })))
})

it('uses the keyboard-operated logistic cutoff on the displayed result without refitting or marking the fit dirty', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result('logistic'))
  mount('logistic'); await ready('logistic')
  fireEvent.click(screen.getByTestId('run-logistic-btn'))
  const slider = await screen.findByRole('slider', { name: '表示中の結果の分類閾値' })
  expect(screen.getByTestId('cm-fn-cell')).toHaveTextContent('0')
  expect(slider.closest('.ant-card')).toHaveTextContent('モデルの再学習は行いません')
  expect(slider.closest('.ant-card')).not.toContainElement(screen.getByTestId('run-logistic-btn'))
  act(() => { slider.focus() })
  expect(slider).toHaveFocus()
  fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
  expect(slider).toHaveAttribute('aria-valuenow', '0.51')
  expect(screen.getByTestId('cm-fn-cell')).toHaveTextContent('1')
  expect(screen.queryByText(/表示中の結果は前回実行分/)).toBeNull()
  expect(post).toHaveBeenCalledTimes(1)
  openSettings()
  fireEvent.click(screen.getByRole('checkbox', { name: '切片項 (Intercept)' }))
  expect(screen.getByText(/表示中の結果は前回実行分/)).toBeVisible()
  expect(slider).toBeVisible()
  expect(screen.getByTestId('cm-fn-cell')).toHaveTextContent('1')
  expect(post).toHaveBeenCalledTimes(1)
})

it.each(['logistic', 'discriminant'] as const)('%s never labels an absent result with the previous completed scope after a failed rerun', async page => {
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce(result(page)).mockRejectedValueOnce(new Error('retry failed'))
  mount(page); await ready(page)
  fireEvent.click(screen.getByTestId(`run-${page}-btn`))
  await waitFor(() => expect(screen.getByTestId('analysis-scope-summary')).toHaveTextContent('この結果:'))
  openSettings()
  fireEvent.click(screen.getByRole('radio', { name: page === 'logistic' ? 'L2' : 'QDA' }))
  expect(screen.getByText(/表示中の結果は前回実行分/)).toBeVisible()
  fireEvent.click(screen.getByTestId(`run-${page}-btn`))
  await waitFor(() => expect(message.error).toHaveBeenCalledWith('retry failed'))
  expect(post).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('analysis-scope-summary')).not.toHaveTextContent('この結果:')
  expect(screen.queryByText(/表示中の結果は前回実行分/)).toBeNull()
  expect(screen.queryByText('表示中の結果の操作')).toBeNull()
})

it.each(['logistic', 'discriminant'] as const)('%s provides contextual empty recovery and dispatches the existing Codebook editor action', async page => {
  const { dispatch } = mount(page, true)
  fireEvent.click(document.getElementById(`${page}-features`)!.closest('.analysis-field')!.querySelector('button')!)
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  expect(within(dialog).getByText(/説明変数の候補がありません。/)).toBeVisible()
  expect(within(dialog).getByText(/共通の有効変数・尺度と/)).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
  expect(dispatch).toHaveBeenCalledWith(editorModalOpened())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
