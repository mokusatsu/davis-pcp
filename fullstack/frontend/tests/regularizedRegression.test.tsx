import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import * as rrApi from '../src/features/models/rrApi'
import RegularizedRegressionPanel, { categoryKey, formatRegularizedNumber, parseRegularizedCandidates, referenceDisplay, regularizedDeltaEffect } from '../src/features/models/RegularizedRegressionPanel'
import type { RRResponse } from '../src/features/models/rrTypes'

vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select id={props.id} aria-label={props['aria-label']}
  multiple={props.mode === 'multiple'} value={props.value ?? ''} onChange={event => props.onChange(props.mode === 'multiple'
    ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('antd', async importOriginal => ({ ...await importOriginal<any>(), Select: (props: any) => <select
  id={props.id} aria-label={props['aria-label']} value={props.value} onChange={event => props.onChange(event.target.value)}>
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
function state(id = 'd') {
  const base = store.getState()
  return { ...base, selection: { ...base.selection, datasetId: id, dataRevision: 1, activeRowIds: ['r1', 'r2'], allRowIds: ['r1', 'r2'] },
    codebook: { ...base.codebook, datasetId: id, schemaRevision: 1, isLoading: false,
      columns: ['Outcome', 'X', 'Z', 'Group', 'Ordered'].map(name => ({ columnId: name, name, label: name,
        role: 'question', scaleType: name === 'Group' ? 'nominal' : name === 'Ordered' ? 'ordinal' : 'ratio' })) } } as any
}
function mount(initial = state(), openSettings = true) {
  const local = configureStore({ reducer: (s = initial, action: any) => action.type === 'fixture/replace' ? action.payload : s,
    middleware: get => get({ serializableCheck: false }) })
  const view = render(<Provider store={local}><RegularizedRegressionPanel /></Provider>)
  fireEvent.change(screen.getByLabelText('正則化の目的変数'), { target: { value: 'Outcome' } })
  fireEvent.change(screen.getByLabelText('正則化の数値説明変数'), { target: { value: 'X' } })
  if (openSettings) view.container.querySelector('details')!.open = true
  return { local, ...view }
}
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
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
const exported = { fileName: 'model.json', mime: 'application/json', payload: '{}', encoding: 'utf-8' as const,
  modelId: 'model-rr1', modelVersion: '1' as const, contentHash: 'hash-rr1' }
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  vi.spyOn(rrApi, 'runRegularizedRegression').mockResolvedValue(result())
  vi.spyOn(rrApi, 'fetchRegularizedRows').mockResolvedValue({ total: 2, nextOffset: null, rows: [
    { rowId: 'fit-r1', observed: 1, fitted: 1.1, residual: -.1 }, { rowId: 'fit-r2', observed: 2, fitted: 1.9, residual: .1 },
  ] })
  vi.spyOn(rrApi, 'exportRegularizedPredict').mockResolvedValue(exported)
  vi.spyOn(rrApi, 'downloadRegularizedArtifact').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function run() {
  fireEvent.click(screen.getByTestId('rr-run'))
  await screen.findByTestId('rr-model-identity')
  await waitFor(() => expect(screen.getByTestId('rr-run')).not.toHaveClass('ant-btn-loading'))
}

it('runs Ridge with strict main-effect contract and no OLS inference controls or columns', async () => {
  mount(); await run()
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledWith(expect.objectContaining({ target: 'Outcome', algorithm: 'ridge',
    lambdaValue: .1, l1Ratio: .5, selection: 'manual', cv: null, intercept: true, standardize: true,
    context: expect.objectContaining({ datasetId: 'd', weightMode: 'dataset', expectedDataRevision: 1 }),
    predictors: [{ columnId: 'X', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null }] }))
  const headers = within(screen.getByTestId('rr-coefficients')).getAllByRole('columnheader').map(cell => cell.textContent)
  expect(headers).toContain('元単位の係数 / 基準との差')
  expect(headers).not.toEqual(expect.arrayContaining(['SE', 'p', 'CI下限']))
  expect(screen.getByTestId('rr-intercept')).toHaveTextContent('20.4 kg')
  expect(screen.getByText('X が1 cm増加するとき')).toBeInTheDocument()
  expect(screen.getByText('基準「A」からこの水準へ変わるときの差')).toBeInTheDocument()
  expect(screen.queryByText('表示結果の列へ保存')).not.toBeInTheDocument()
  expect(screen.queryByText('診断図')).not.toBeInTheDocument()
})
it('changes display scale and reference without refitting, dirtying, or altering model identity', async () => {
  mount(); await run()
  const identity = screen.getByTestId('rr-model-identity').textContent
  fireEvent.click(screen.getByRole('radio', { name: '両方' }))
  fireEvent.change(screen.getByLabelText('Group の表示基準'), { target: { value: categoryKey({ kind: 'value', code: 'b' }) } })
  expect(screen.getByTestId('rr-intercept')).toHaveTextContent('19.6 kg')
  expect(screen.getByTestId('rr-model-identity')).toHaveTextContent(identity!)
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/対象または設定が変更/)).not.toBeInTheDocument()
  expect(screen.getAllByText(/1e-14/).length).toBeGreaterThan(0)
  expect(screen.getAllByText('学習係数が厳密に 0')).toHaveLength(1)
})
it('freezes the submitted draft and scope while changes during a run mark the completed result dirty', async () => {
  const pending = deferred<RRResponse>(); vi.mocked(rrApi.runRegularizedRegression).mockReturnValueOnce(pending.promise)
  const { local } = mount()
  fireEvent.click(screen.getByTestId('rr-run'))
  fireEvent.change(screen.getByLabelText('正則化強度 λ'), { target: { value: '2' } })
  const previous = local.getState()
  act(() => local.dispatch({ type: 'fixture/replace', payload: { ...previous, selection: { ...previous.selection, activeRowIds: ['r2'] } } }))
  await act(async () => pending.resolve(result()))
  expect(screen.getByText(/対象または設定が変更/)).toBeInTheDocument()
  expect(vi.mocked(rrApi.runRegularizedRegression).mock.calls[0][0].context.activeRowIds).toEqual(['r1', 'r2'])
  expect(screen.getByText(/この結果の対象:.*2行/)).toBeInTheDocument()
})
it('ignores late cancelled run and accepts the next run without replacing completed data', async () => {
  mount(); await run()
  const pending = deferred<RRResponse>(); vi.mocked(rrApi.runRegularizedRegression).mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByTestId('rr-run'))
  fireEvent.click(screen.getByRole('button', { name: '待機をキャンセル' }))
  await act(async () => pending.resolve(result('cancelled')))
  expect(screen.getByTestId('rr-model-identity')).toHaveTextContent('model-rr1')
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(result('next'))
  fireEvent.click(screen.getByTestId('rr-run'))
  await waitFor(() => expect(screen.getByTestId('rr-model-identity')).toHaveTextContent('model-next'))
})
it('ignores a late response on revision change and releases loading', async () => {
  const pending = deferred<RRResponse>(); vi.mocked(rrApi.runRegularizedRegression).mockReturnValueOnce(pending.promise)
  const { local } = mount()
  fireEvent.click(screen.getByTestId('rr-run'))
  const previous = local.getState()
  act(() => local.dispatch({ type: 'fixture/replace', payload: { ...previous, selection: { ...previous.selection, dataRevision: 2 } } }))
  await act(async () => pending.resolve(result()))
  expect(screen.queryByTestId('rr-model-identity')).not.toBeInTheDocument()
  expect(screen.getByTestId('rr-run')).not.toHaveClass('ant-btn-loading')
})
it('retains stale completed results, blocks prediction and exports exact old identity despite dirty draft', async () => {
  const { local } = mount(); await run()
  fireEvent.change(screen.getByLabelText('正則化強度 λ'), { target: { value: '2' } })
  const previous = local.getState()
  act(() => local.dispatch({ type: 'fixture/replace', payload: { ...previous, codebook: { ...previous.codebook, schemaRevision: 2 } } }))
  expect(screen.getByTestId('rr-predict')).toBeDisabled()
  expect(screen.getByText(/古い版の完了モデル/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'model.json' }))
  await waitFor(() => expect(rrApi.downloadRegularizedArtifact).toHaveBeenCalledWith(exported))
  expect(rrApi.exportRegularizedPredict).toHaveBeenCalledWith('rr1', 'python', 'model', '1')
})
it('drops old-dataset results and late exports after switching datasets', async () => {
  const { local } = mount(); await run()
  const pending = deferred(); vi.mocked(rrApi.exportRegularizedPredict).mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'model.json' }))
  act(() => local.dispatch({ type: 'fixture/replace', payload: state('next') }))
  await act(async () => pending.resolve(exported))
  expect(rrApi.downloadRegularizedArtifact).not.toHaveBeenCalled()
  expect(screen.queryByTestId('rr-model-identity')).not.toBeInTheDocument()
  expect(screen.getByTestId('rr-run')).toBeDisabled()
})
it('rejects wrong export identity and allows retry through shared export control', async () => {
  mount(); await run()
  vi.mocked(rrApi.exportRegularizedPredict).mockResolvedValueOnce({ ...exported, contentHash: 'wrong' })
  const exportButton = screen.getByRole('button', { name: 'model.json' })
  fireEvent.click(exportButton)
  await screen.findByText(/保存モデルの識別子・版・ハッシュが一致しません/)
  expect(rrApi.downloadRegularizedArtifact).not.toHaveBeenCalled()
  // AntD clears its internal loading state in a passive effect in the test runtime.
  // The app's error can appear first; retry only once the real button is actionable.
  await waitFor(() => {
    expect(exportButton).toBeEnabled()
    expect(exportButton).not.toHaveClass('ant-btn-loading')
    expect(exportButton).toHaveAttribute('aria-busy', 'false')
    expect(exportButton).toHaveAccessibleName('model.json')
  })
  fireEvent.click(exportButton)
  await waitFor(() => expect(rrApi.downloadRegularizedArtifact).toHaveBeenCalledOnce())
  expect(rrApi.exportRegularizedPredict).toHaveBeenCalledTimes(2)
})
it.each(['survey', 'unexpected'])('blocks %s dataset weights without silently switching modes', async weightType => {
  const initial = state(); initial.codebook.weightConfig = { weightColumnId: 'weight', weightType }
  mount(initial)
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent(weightType === 'survey' ? '調査ウェイト' : '重みの種類が不明')
  fireEvent.click(screen.getByRole('radio', { name: 'なし（明示）' }))
  expect(screen.getByText(/明示的に無加重/)).toBeInTheDocument()
  await run()
  expect(vi.mocked(rrApi.runRegularizedRegression).mock.calls[0][0].context.weightMode).toBe('none')
})
it('requires ordinal acknowledgement and rejects lambda zero before submission', () => {
  mount()
  fireEvent.change(screen.getByLabelText('正則化の数値説明変数'), { target: { value: 'Ordered' } })
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /等間隔仮定/ }))
  expect(screen.getByTestId('rr-run')).not.toBeDisabled()
  fireEvent.change(screen.getByLabelText('正則化強度 λ'), { target: { value: '0' } })
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('λ=0')
  expect(rrApi.runRegularizedRegression).not.toHaveBeenCalled()
})
it('shows row-local prediction failures and never requests intervals', async () => {
  vi.spyOn(rrApi, 'predictRegularizedRegression').mockResolvedValue({ status: 'ok', resultId: 'rr1', predictionId: 'pred1', summary: {
    requestedCount: 2, successfulPredictions: 1, failedPredictions: 1, statusCounts: { ok: 1, unknown_category: 1 }, evaluation: null } })
  vi.spyOn(rrApi, 'fetchRegularizedPredictions').mockResolvedValue({ total: 2, nextOffset: null, rows: [
    { rowId: 'predict-ok', predicted: 4, observed: null, residual: null, predictionStatus: 'ok', warnings: [] },
    { rowId: 'predict-bad', predicted: null, observed: null, residual: null, predictionStatus: 'unknown_category', warnings: [{ code: 'unknown', message: '未知カテゴリです' }] },
  ] })
  mount(); await run(); fireEvent.click(screen.getByTestId('rr-predict'))
  await screen.findByText('predict-bad')
  expect(screen.getByText('未知カテゴリです')).toBeInTheDocument()
  expect(rrApi.predictRegularizedRegression).toHaveBeenCalledWith('rr1', expect.objectContaining({ datasetId: 'd' }), false)
  expect(screen.getByText('対象 2 / 成功 1 / 失敗 1')).toBeInTheDocument()
})
it('does not accept a nonconverged fit and keeps retry available', async () => {
  const unconverged = result(); unconverged.summary.convergence.converged = false
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(unconverged)
  mount(); fireEvent.click(screen.getByTestId('rr-run'))
  await screen.findByText(/収束していない結果は完了/)
  expect(screen.queryByTestId('rr-model-identity')).not.toBeInTheDocument()
  expect(screen.getByTestId('rr-run')).not.toBeDisabled()
})

describe('display-only math', () => {
  it('preserves tiny values and never labels rounded small values zero', () => {
    expect(formatRegularizedNumber(1e-200, 3)).toBe('1e-200')
    expect(formatRegularizedNumber(0, 8)).toBe('0')
    expect(formatRegularizedNumber(1.23456, 4, true)).toBe('1.235e+0')
  })
  it('re-expresses full one-hot coefficients and intercept without mutating the source', () => {
    const source = result(), original = JSON.stringify(source)
    const a = referenceDisplay(source, {}), b = referenceDisplay(source, { Group: categoryKey({ kind: 'value', code: 'b' }) })
    expect(a.intercept).toBe(20.4); expect(b.intercept).toBe(19.6)
    expect(a.coefficients.find(row => row.designColumnId === 'Group:b')?.displayEstimate).toBe(-.8)
    expect(b.coefficients.find(row => row.designColumnId === 'Group:a')?.displayEstimate).toBe(.8)
    expect(JSON.stringify(source)).toBe(original)
  })
  it('keeps missing and not-applicable reference keys separate and reports unrepresentable contrasts', () => {
    expect(categoryKey({ code: null, kind: 'missing' })).not.toBe(categoryKey({ code: null, kind: 'not_applicable' }))
    const source = result()
    source.details.coefficients[3].estimate = Number.MAX_VALUE
    source.details.coefficients[4].estimate = -Number.MAX_VALUE
    const view = referenceDisplay(source, {})
    expect(view.coefficients[4].displayEstimate).toBeNull()
    expect(view.coefficients[4].displayReason).toBeTruthy()
  })
})

it.each(['Lasso', 'Elastic Net'])('submits %s explicitly and keeps manual CV config null', async label => {
  mount(); fireEvent.click(screen.getByRole('radio', { name: label }))
  if (label === 'Elastic Net') fireEvent.change(screen.getByLabelText('L1比率 ρ'), { target: { value: '.7' } })
  await run()
  expect(vi.mocked(rrApi.runRegularizedRegression).mock.calls[0][0]).toMatchObject({ algorithm: label === 'Lasso' ? 'lasso' : 'elasticnet',
    selection: 'manual', cv: null, l1Ratio: label === 'Lasso' ? .5 : .7 })
})
it('requires independent rows for CV and submits frozen finite lambda/rho grids', async () => {
  mount(); fireEvent.click(screen.getByRole('radio', { name: 'Elastic Net' }))
  fireEvent.click(screen.getByRole('radio', { name: '交差検証（CV）' }))
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  fireEvent.change(screen.getByLabelText('CV λ候補'), { target: { value: '.01, .1, 1e1' } })
  fireEvent.change(screen.getByLabelText('CV ρ候補'), { target: { value: '.1, .7' } })
  fireEvent.change(screen.getByLabelText('CV fold数'), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText('CV seed'), { target: { value: '77' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /各行を独立した観測/ }))
  await run()
  expect(vi.mocked(rrApi.runRegularizedRegression).mock.calls[0][0]).toMatchObject({ algorithm: 'elasticnet', selection: 'cv',
    cv: { folds: 3, seed: 77, lambdaValues: [.01, .1, 10], l1Ratios: [.1, .7], independentRowsAcknowledged: true } })
})
it.each([{ psuColumnId: 'group' }, { strataColumnId: 'stratum' }, { replicateWeightColumnIds: ['w1'] }])('blocks incompatible known grouping for CV: %j', design => {
  const initial = state(); initial.codebook.surveyDesign = design
  mount(initial); fireEvent.click(screen.getByRole('radio', { name: '交差検証（CV）' }))
  fireEvent.click(screen.getByRole('checkbox', { name: /各行を独立した観測/ }))
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  expect(screen.getByText(/PSU・層・反復ウェイトの設定/)).toBeInTheDocument()
})
it('shows CV selection evidence and fold failures without inference fields', async () => {
  const fitted = result()
  fitted.config = { ...fitted.config, algorithm: 'elasticnet', selection: 'cv', standardize: true, intercept: true }
  fitted.summary.cv = { folds: 2, seed: 42, assignmentFingerprint: 'split-fingerprint', scoring: 'pooled_weighted_mse',
    bestLambdaValue: .1, bestL1Ratio: .5, weightedMse: 4, rmse: 2, candidateCount: 2, invalidCandidateCount: 1 }
  fitted.details.cv = { summary: fitted.summary.cv, rowUnit: 'prepared_dataset_row', preprocessingScope: 'training_fold_only', upstreamLeakageVerified: false,
    foldAudits: [{ fold: 0, trainCount: 2, features: [{ offset: 7 }] }], candidates: [
      { lambdaValue: .1, l1Ratio: .5, valid: true, weightedMse: 4, rmse: 2, failureCount: 0, folds: [] },
      { lambdaValue: .01, l1Ratio: .5, valid: false, weightedMse: null, rmse: null, failureCount: 1, folds: [
        { fold: 0, trainCount: 2, validationCount: 2, validationWeight: 2, libraryAlpha: .01, weightedSse: null, failedPredictions: 2,
          convergence: { converged: false, iterations: 100, dualGap: null }, failure: { code: 'RR_NONCONVERGENCE', message: '反復上限', details: {} } },
      ] },
    ] }
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(fitted)
  mount(); await run()
  expect(screen.getByText('交差検証の結果（選択用）')).toBeInTheDocument()
  expect(screen.getByText(/split-fingerprint/)).toBeInTheDocument()
  const expand = screen.getAllByRole('button', { name: 'Expand row' })
  fireEvent.click(expand[1])
  await screen.findByText('反復上限 (RR_NONCONVERGENCE)')
})
it('does not download an obsolete language export or an export after unmount', async () => {
  const { unmount } = mount(); await run()
  const pending = deferred(); vi.mocked(rrApi.exportRegularizedPredict).mockReturnValueOnce(pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Predict ソース' }))
  fireEvent.change(screen.getByLabelText('Predict の言語'), { target: { value: 'javascript' } })
  await act(async () => pending.resolve(exported))
  expect(rrApi.downloadRegularizedArtifact).not.toHaveBeenCalled()
  const next = deferred(); vi.mocked(rrApi.exportRegularizedPredict).mockReturnValueOnce(next.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Predict ソース' }))
  unmount(); await act(async () => next.resolve(exported))
  expect(rrApi.downloadRegularizedArtifact).not.toHaveBeenCalled()
})
it('reports failed fit-row fetches and retries without refitting the model', async () => {
  vi.mocked(rrApi.fetchRegularizedRows).mockRejectedValueOnce(new Error('rows offline'))
  mount(); await run(); await screen.findByText('rows offline')
  fireEvent.click(screen.getByRole('button', { name: '再試行' }))
  await screen.findByText('fit-r1')
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledTimes(1)
  expect(rrApi.fetchRegularizedRows).toHaveBeenCalledTimes(2)
})
it('ignores a late prediction after a new fit starts', async () => {
  const pending = deferred(); vi.spyOn(rrApi, 'predictRegularizedRegression').mockReturnValueOnce(pending.promise)
  const rows = vi.spyOn(rrApi, 'fetchRegularizedPredictions')
  mount(); await run(); fireEvent.click(screen.getByTestId('rr-predict'))
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(result('next'))
  fireEvent.click(screen.getByTestId('rr-run'))
  await waitFor(() => expect(screen.getByTestId('rr-model-identity')).toHaveTextContent('model-next'))
  await act(async () => pending.resolve({ resultId: 'rr1', predictionId: 'old', summary: {} }))
  expect(rows).not.toHaveBeenCalled()
})
it('validates candidate lists without deduplicating or interpreting hexadecimal inputs', () => {
  for (const text of ['', '0', '-1', '.1,.10', '0x10', 'Infinity', '1e400']) expect(parseRegularizedCandidates(text, 'lambda').error).toBeTruthy()
  for (const text of ['0', '.001', '1', '.5,.50']) expect(parseRegularizedCandidates(text, 'ratio').error).toBeTruthy()
  expect(parseRegularizedCandidates('1e-4, .1, 10', 'lambda')).toEqual({ values: [.0001, .1, 10], error: null })
})

it('does not retain ordinal-only acknowledgement when a column becomes continuous', async () => {
  const { local } = mount()
  fireEvent.change(screen.getByLabelText('正則化の数値説明変数'), { target: { value: 'Ordered' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /等間隔仮定/ }))
  const previous = local.getState()
  act(() => local.dispatch({ type: 'fixture/replace', payload: { ...previous, codebook: { ...previous.codebook, schemaRevision: 2,
    columns: previous.codebook.columns.map((column: any) => column.columnId === 'Ordered' ? { ...column, scaleType: 'ratio' } : column) } } }))
  fireEvent.click(screen.getByTestId('rr-run'))
  await waitFor(() => expect(rrApi.runRegularizedRegression).toHaveBeenCalled())
  expect(vi.mocked(rrApi.runRegularizedRegression).mock.calls[0][0].predictors).toEqual([
    { columnId: 'Ordered', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null },
  ])
})

it('reviews frozen input mapping and changes Δx without refitting, dirtying, or changing model/hash', async () => {
  const source = result()
  source.portableModel.inputs[0] = { ...source.portableModel.inputs[0], name: 'frozen_name', label: 'Frozen label', key: 'external_x' }
  const original = JSON.stringify(source)
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(source)
  const { local } = mount(); await run()
  const mapping = within(screen.getByTestId('rr-input-mapping'))
  expect(mapping.getByText('frozen_name')).toBeInTheDocument()
  expect(mapping.getByText('Frozen label')).toBeInTheDocument()
  expect(mapping.getByText('external_x')).toBeInTheDocument()
  expect(screen.getByText(/columnId→入力キーを明示/)).toBeInTheDocument()
  expect(screen.getByTestId('rr-delta-X')).toHaveTextContent('0.4 kg')
  fireEvent.change(screen.getByLabelText('表示用の増分 Δx'), { target: { value: '2.5' } })
  expect(screen.getByTestId('rr-delta-X')).toHaveTextContent('1 kg')
  expect(screen.getByTestId('rr-model-identity')).toHaveTextContent('モデル model-rr1 / 版 1 / 結果 rr1')
  expect(screen.getByText('SHA-256: hash-rr1')).toBeInTheDocument()
  expect(screen.queryByText(/対象または設定が変更/)).not.toBeInTheDocument()
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(source)).toBe(original)
  const previous = local.getState()
  act(() => local.dispatch({ type: 'fixture/replace', payload: { ...previous, codebook: { ...previous.codebook, schemaRevision: 2,
    columns: previous.codebook.columns.map((column: any) => column.columnId === 'X' ? { ...column, name: 'new_name', label: 'New label' } : column) } } }))
  expect(mapping.getByText('frozen_name')).toBeInTheDocument()
  expect(mapping.queryByText('new_name')).not.toBeInTheDocument()
})
it('resets each fresh result to original-unit display and Δx=1', async () => {
  mount(); await run()
  fireEvent.click(screen.getByRole('radio', { name: '比較用標準化' }))
  fireEvent.change(screen.getByLabelText('表示用の増分 Δx'), { target: { value: '3' } })
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(result('fresh'))
  fireEvent.click(screen.getByTestId('rr-run'))
  await waitFor(() => expect(screen.getByTestId('rr-model-identity')).toHaveTextContent('model-fresh'))
  expect(screen.getByRole('radio', { name: '元単位' })).toBeChecked()
  await waitFor(() => expect(screen.getByLabelText('表示用の増分 Δx')).toHaveValue('1'))
  expect(screen.getByTestId('rr-delta-X')).toHaveTextContent('0.4 kg')
})
it('shows unavailable Δx products instead of infinity or fabricated zero', async () => {
  const source = result()
  source.details.coefficients[0].estimate = Number.MAX_VALUE
  source.details.coefficients[1].estimate = Number.MIN_VALUE
  vi.mocked(rrApi.runRegularizedRegression).mockResolvedValueOnce(source)
  mount(); await run()
  fireEvent.change(screen.getByLabelText('表示用の増分 Δx'), { target: { value: '2' } })
  expect(screen.getByTestId('rr-delta-X')).toHaveTextContent('オーバーフロー')
  fireEvent.change(screen.getByLabelText('表示用の増分 Δx'), { target: { value: '.1' } })
  expect(screen.getByTestId('rr-delta-Tiny')).toHaveTextContent('アンダーフロー')
  expect(screen.getByTestId('rr-delta-Zero')).toHaveTextContent('0 kg')
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/対象または設定が変更/)).not.toBeInTheDocument()
})
it('computes signed numeric and ordinal increments and distinguishes nonzero underflow', () => {
  const coefficient = { kind: 'numeric' as const, estimate: .4, estimateReason: null, exactZero: false }
  expect(regularizedDeltaEffect(coefficient, -2)).toEqual({ value: -.8, reason: null })
  expect(regularizedDeltaEffect({ ...coefficient, kind: 'ordinal' }, 2)).toEqual({ value: .8, reason: null })
  expect(regularizedDeltaEffect({ ...coefficient, kind: 'ordinal' }, .5).reason).toMatch(/整数/)
  expect(regularizedDeltaEffect({ ...coefficient, estimate: 0 }, 1).reason).toMatch(/アンダーフロー/)
  expect(regularizedDeltaEffect({ ...coefficient, estimate: 0, exactZero: true }, 1)).toEqual({ value: 0, reason: null })
  expect(regularizedDeltaEffect(coefficient, Infinity).value).toBeNull()
  expect(regularizedDeltaEffect(coefficient, null).value).toBeNull()
})

it('starts with collapsed optional settings, visible algorithm and unchanged fixed Ridge preset', async () => {
  const { container } = mount(state(), false)
  const settings = container.querySelector('details')!
  expect(settings).not.toHaveAttribute('open')
  expect(screen.getByRole('radio', { name: 'Ridge' }).closest('label')).toHaveClass('ant-radio-button-wrapper-checked')
  expect(screen.getByLabelText('正則化強度 λ')).not.toBeVisible()
  expect(settings.querySelector('summary')).toHaveTextContent('手動 λ=0.1（固定値・CV未使用）')
  expect(screen.getByTestId('rr-run').closest('.analysis-run-row')).toBeInTheDocument()
  expect(screen.getByTestId('rr-run')).toHaveClass('ant-btn-primary')
  await run()
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'ridge',
    lambdaValue: .1, l1Ratio: .5, selection: 'manual', cv: null, intercept: true, standardize: true,
    tolerance: 1e-8, maxIterations: 10000 }))
})

it('retains hidden tuning and preprocessing after disclosure and algorithm round trips', async () => {
  const { container } = mount(state(), false)
  const settings = container.querySelector('details')!
  fireEvent.click(settings.querySelector('summary')!)
  fireEvent.change(screen.getByLabelText('正則化強度 λ'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('ソルバー許容誤差'), { target: { value: '0.000001' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '説明変数を学習時に標準化' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '切片あり' }))
  fireEvent.click(settings.querySelector('summary')!)
  fireEvent.click(screen.getByRole('radio', { name: 'Elastic Net' }))
  fireEvent.click(screen.getByRole('radio', { name: 'Ridge' }))
  expect(settings).not.toHaveAttribute('open')
  expect(settings.querySelector('summary')).toHaveTextContent('手動 λ=2（固定値・CV未使用） / 標準化なし / 切片なし')
  expect(settings.querySelector('summary')).toHaveTextContent('許容誤差 0.000001')
  fireEvent.click(settings.querySelector('summary')!)
  expect(Number((screen.getByLabelText('正則化強度 λ') as HTMLInputElement).value)).toBe(2)
  expect(screen.getByRole('checkbox', { name: '説明変数を学習時に標準化' })).not.toBeChecked()
  fireEvent.click(settings.querySelector('summary')!)
  await run()
  expect(rrApi.runRegularizedRegression).toHaveBeenCalledWith(expect.objectContaining({ lambdaValue: 2,
    standardize: false, intercept: false, tolerance: .000001, maxIterations: 10000, selection: 'manual', cv: null }))
})

it('keeps invalid hidden solver feedback visible and prevents a request', () => {
  const { container } = mount(state(), false)
  const settings = container.querySelector('details')!
  fireEvent.click(settings.querySelector('summary')!)
  fireEvent.change(screen.getByLabelText('ソルバー許容誤差'), { target: { value: '-1' } })
  fireEvent.click(settings.querySelector('summary')!)
  expect(settings).not.toHaveAttribute('open')
  expect(settings.querySelector('summary')).toHaveTextContent('設定を確認してください')
  expect(screen.getByTestId('rr-settings-issues')).toBeVisible()
  expect(screen.getByTestId('rr-settings-issues')).toHaveTextContent('許容誤差は0より大きく0.1以下')
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  fireEvent.click(screen.getByTestId('rr-run'))
  expect(rrApi.runRegularizedRegression).not.toHaveBeenCalled()
})

it('opens previously hidden weight settings when the dataset gains unsupported weights', () => {
  const { local, container } = mount(state(), false)
  const settings = container.querySelector('details')!
  const previous = local.getState()
  act(() => local.dispatch({ type: 'fixture/replace', payload: { ...previous,
    codebook: { ...previous.codebook, weightConfig: { weightColumnId: 'weight', weightType: 'survey' } } } }))
  expect(settings).toHaveAttribute('open')
  expect(screen.getByTestId('rr-settings-issues')).toHaveTextContent('調査ウェイト')
  expect(screen.getByTestId('rr-run')).toBeDisabled()
  expect(screen.getByRole('radio', { name: 'データ設定' })).toBeChecked()
  expect(rrApi.runRegularizedRegression).not.toHaveBeenCalled()
})
