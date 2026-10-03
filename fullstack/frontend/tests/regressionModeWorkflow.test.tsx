import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import * as lrApi from '../src/features/models/lrApi'
import * as rrApi from '../src/features/models/rrApi'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import type { RRResponse } from '../src/features/models/rrTypes'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'

vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select aria-label={props['aria-label'] ?? props.placeholder}
  multiple={props.mode === 'multiple'} value={props.value ?? ''} onChange={event => props.onChange(props.mode === 'multiple'
    ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/features/models/LinearRegressionFigure', () => ({ default: () => <div>diagnostic figure</div> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children, controls }: any) => <div>{controls}{children}</div> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: () => 'replace' }))
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => { vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element)) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1 },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, isLoading: false,
      columns: ['Outcome', 'X', 'Z'].map(name => ({ columnId: name, name, role: 'question', scaleType: 'ratio' })) } }
  const local = configureStore({ reducer: (s = state) => s, middleware: get => get({ serializableCheck: false }) })
  const app = (active: boolean) => <Provider store={local}><AnalysisViewActivityContext.Provider value={active}><LinearRegressionPage /></AnalysisViewActivityContext.Provider></Provider>
  const view = render(app(true))
  fireEvent.change(view.getByLabelText('目的変数を選択'), { target: { value: 'Outcome' } })
  fireEvent.change(view.getByLabelText('数値を選択'), { target: { value: 'X' } })
  const button = view.getByRole('button', { name: '実 行' })
  return { view, button, app }
}

const fit: any = { resultId: 'lr1', meta: { dataRevision: 1, schemaRevision: 1, warnings: [] },
  summary: { modelFormula: 'Outcome ~ X', rSquared: .98, rmse: .72 },
  capabilities: { materializeFitFields: ['fitted'], materializePredictionFields: ['predicted'] },
  details: { coefficients: [], vif: [] }, unavailableReasons: {} }

function result(resultId = 'rr1'): RRResponse {
  const coefficient = (designColumnId: string, estimate: number, rest: any = {}) => ({ designColumnId, columnId: designColumnId,
    label: designColumnId, kind: 'numeric' as const, category: null, estimate, estimateReason: null,
    standardizedEstimate: .8, standardizedReason: null, comparisonSd: 2, exactZero: estimate === 0, unit: 'kg / cm', ...rest })
  return { status: 'ok', resultId, method: 'regularized_regression', config: {} as any,
    meta: { datasetId: 'd', dataRevision: 1, schemaRevision: 1, resultState: 'current', scope: 'active', scopeCount: 2,
      fitCount: 2, effectiveN: 2, excludedCount: 0, exclusionCounts: {}, weightApplied: false, weightType: null,
      weightColumn: null, algorithmVersion: '1', warnings: [] },
    summary: { targetLabel: 'Outcome', nDesignColumns: 3, algorithm: 'ridge', lambdaValue: .1, l1Ratio: 0,
      fitRmse: 1.2, fitMae: 1, fitRSquared: .9, convergence: { converged: true, iterations: null, dualGap: null }, cv: null },
    details: { coefficients: [coefficient('X', .4), coefficient('Tiny', 1e-14), coefficient('Zero', 0),
      coefficient('Group:a', .4, { columnId: 'Group', kind: 'categorical', category: { kind: 'value', code: 'a' }, standardizedEstimate: null, standardizedReason: 'カテゴリ' }),
      coefficient('Group:b', -.4, { columnId: 'Group', kind: 'categorical', category: { kind: 'value', code: 'b' }, standardizedEstimate: null, standardizedReason: 'カテゴリ' })],
      intercept: { estimate: 20, reason: null }, cv: null, categoryReferences: [{ columnId: 'Group', reference: { kind: 'value', code: 'a' },
        levels: [{ kind: 'value', code: 'a', label: 'A' }, { kind: 'value', code: 'b', label: 'B' }] }] },
    capabilities: { rows: true, projection: true, materialize: false, selectionKinds: [], exportTables: ['manifest', 'coefficients', 'rows'], predictionIntervals: ['none'], exportPredict: true },
    portableModel: { schemaVersion: 'davis.regularized-regression/1', identity: { modelId: `model-${resultId}`, modelVersion: '1', algorithmVersion: '1', exporterVersion: '1', runtimeVersion: '1', createdAt: '2026-10-02', contentHash: `hash-${resultId}` }, inputs: ['X', 'Tiny', 'Zero', 'Group'].map(name => ({ columnId: name, key: name, name, label: name, kind: name === 'Group' ? 'categorical' : 'numeric', unit: name === 'Group' ? null : 'cm' })), display: { targetLabel: 'Outcome', targetUnit: 'kg' } } }
}

function rowPage() { return { total: 0, nextOffset: null, rows: [] } }
const deferred = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(yes => { resolve = yes }), resolve: (value: any) => resolve(value) } }

it('WF-08 preserves both real panels, completed fits and drafts across repeated round trips', async () => {
  const olsRun = vi.spyOn(lrApi, 'runLinearRegression').mockResolvedValue(fit)
  const olsRows = vi.spyOn(lrApi, 'fetchLinearRegressionRows').mockResolvedValue(rowPage())
  const rrRun = vi.spyOn(rrApi, 'runRegularizedRegression').mockResolvedValue(result())
  const rrRows = vi.spyOn(rrApi, 'fetchRegularizedRows').mockResolvedValue(rowPage())
  const { view, button } = setup()
  expect(view.queryByTestId('regularized-panel')).toBeNull()
  fireEvent.click(button)
  await view.findByText('結果: Outcome ~ X')
  await waitFor(() => expect(olsRows).toHaveBeenCalledTimes(1))
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  expect(view.getByTestId('ols-panel')).not.toBeVisible()
  fireEvent.change(view.getByLabelText('正則化の目的変数'), { target: { value: 'Outcome' } })
  fireEvent.change(view.getByLabelText('正則化の数値説明変数'), { target: { value: 'Z' } })
  fireEvent.click(view.getByTestId('rr-run'))
  await view.findByTestId('rr-model-identity')
  await waitFor(() => expect(rrRows).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 2; i++) {
    fireEvent.click(view.getByText('通常の重回帰（OLS）'))
    expect(view.getByLabelText('目的変数を選択')).toHaveValue('Outcome')
    expect(view.getByLabelText('数値を選択')).toHaveValue(['X'])
    expect(view.getByText('結果: Outcome ~ X')).toBeVisible()
    expect(view.getByTestId('regularized-panel')).not.toBeVisible()
    fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
    expect(view.getByLabelText('正則化の数値説明変数')).toHaveValue(['Z'])
    expect(view.getByTestId('rr-model-identity')).toBeVisible()
  }
  expect(olsRun).toHaveBeenCalledTimes(1)
  expect(rrRun).toHaveBeenCalledTimes(1)
  expect(olsRows).toHaveBeenCalledTimes(1)
  expect(rrRows).toHaveBeenCalledTimes(1)
})

it('defers OLS rows if the fit finishes hidden and pauses unfinished pagination', async () => {
  const pendingFit = deferred(), pendingRows = deferred()
  vi.spyOn(lrApi, 'runLinearRegression').mockReturnValue(pendingFit.promise)
  const fetchRows = vi.spyOn(lrApi, 'fetchLinearRegressionRows').mockReturnValueOnce(pendingRows.promise).mockResolvedValue(rowPage())
  const { view, button } = setup()
  fireEvent.click(button)
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  await act(async () => pendingFit.resolve(fit))
  expect(fetchRows).not.toHaveBeenCalled()
  fireEvent.click(view.getByText('通常の重回帰（OLS）'))
  await waitFor(() => expect(fetchRows).toHaveBeenCalledTimes(1))
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  await act(async () => pendingRows.resolve({ total: 6000, nextOffset: 5000, rows: [] }))
  expect(fetchRows).toHaveBeenCalledTimes(1)
  fireEvent.click(view.getByText('通常の重回帰（OLS）'))
  await waitFor(() => expect(fetchRows).toHaveBeenCalledTimes(2))
  expect(view.getByText('結果: Outcome ~ X')).toBeVisible()
})

it('defers regularized rows while the entire cached page is inactive', async () => {
  const pendingFit = deferred()
  vi.spyOn(rrApi, 'runRegularizedRegression').mockReturnValue(pendingFit.promise)
  const fetchRows = vi.spyOn(rrApi, 'fetchRegularizedRows').mockResolvedValue(rowPage())
  const { view, app } = setup()
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  fireEvent.change(view.getByLabelText('正則化の目的変数'), { target: { value: 'Outcome' } })
  fireEvent.change(view.getByLabelText('正則化の数値説明変数'), { target: { value: 'Z' } })
  fireEvent.click(view.getByTestId('rr-run'))
  view.rerender(app(false))
  await act(async () => pendingFit.resolve(result()))
  expect(fetchRows).not.toHaveBeenCalled()
  view.rerender(app(true))
  await waitFor(() => expect(fetchRows).toHaveBeenCalledTimes(1))
  expect(view.getByLabelText('正則化の数値説明変数')).toHaveValue(['Z'])
  expect(view.getByTestId('rr-model-identity')).toBeInTheDocument()
})

it('pauses OLS prediction row work while hidden and resumes the same prediction', async () => {
  vi.spyOn(lrApi, 'runLinearRegression').mockResolvedValue(fit)
  vi.spyOn(lrApi, 'fetchLinearRegressionRows').mockResolvedValue(rowPage())
  const predicted = deferred()
  vi.spyOn(lrApi, 'predictLinearRegression').mockReturnValue(predicted.promise)
  const rows = vi.spyOn(lrApi, 'fetchLinearRegressionPredictions').mockResolvedValue(rowPage())
  const { view, button } = setup()
  fireEvent.click(button)
  await view.findByText('結果: Outcome ~ X')
  fireEvent.click(view.getByRole('tab', { name: '予測・評価' }))
  fireEvent.click(view.getByRole('button', { name: '予測・評価' }))
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  await act(async () => predicted.resolve({ predictionId: 'pred-1', summary: { successfulPredictions: 0, requestedCount: 0 } }))
  expect(rows).not.toHaveBeenCalled()
  fireEvent.click(view.getByText('通常の重回帰（OLS）'))
  await waitFor(() => expect(rows).toHaveBeenCalledWith('lr1', 'pred-1', 0, 5000))
  expect(view.getByText('成功0/0')).toBeVisible()
})

it('pauses regularized prediction row work while hidden and resumes without a new prediction', async () => {
  vi.spyOn(rrApi, 'runRegularizedRegression').mockResolvedValue(result())
  vi.spyOn(rrApi, 'fetchRegularizedRows').mockResolvedValue(rowPage())
  const predicted = deferred()
  const predict = vi.spyOn(rrApi, 'predictRegularizedRegression').mockReturnValue(predicted.promise)
  const rows = vi.spyOn(rrApi, 'fetchRegularizedPredictions').mockResolvedValue(rowPage())
  const { view } = setup()
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  fireEvent.change(view.getByLabelText('正則化の目的変数'), { target: { value: 'Outcome' } })
  fireEvent.change(view.getByLabelText('正則化の数値説明変数'), { target: { value: 'Z' } })
  fireEvent.click(view.getByTestId('rr-run'))
  await view.findByTestId('rr-model-identity')
  fireEvent.click(view.getByTestId('rr-predict'))
  fireEvent.click(view.getByText('通常の重回帰（OLS）'))
  await act(async () => predicted.resolve({ resultId: 'rr1', predictionId: 'rr-pred',
    summary: { successfulPredictions: 0, requestedCount: 0, failedPredictions: 0, statusCounts: {} }, warnings: [] }))
  expect(rows).not.toHaveBeenCalled()
  fireEvent.click(view.getByText('正則化回帰', { selector: 'span' }))
  await waitFor(() => expect(rows).toHaveBeenCalledWith('rr1', 'rr-pred', 0, 50))
  expect(predict).toHaveBeenCalledTimes(1)
})
