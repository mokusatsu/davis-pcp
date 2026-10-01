import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { api } from '../src/api/client'
import FactorAnalysisPage from '../src/features/models/FactorAnalysisPage'
import ConjointPage from '../src/features/models/ConjointPage'
import * as efa from '../src/features/models/efaApi'
import * as conjoint from '../src/features/models/conjointApi'
import { getBrushOp } from '../src/features/selection/SelectionMenu'

vi.mock('../src/features/dataset/useCodebookColumn', () => ({ useCodebook: () => useSelector((s: any) => s.codebook) }))
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select aria-label={props.placeholder} multiple={props.mode === 'multiple'} value={props.value ?? (props.mode === 'multiple' ? [] : '')} disabled={props.disabled}
  onChange={event => props.onChange(props.mode === 'multiple' ? [...event.target.selectedOptions].map(option => option.value) : event.target.value)}>
  <option value="">選択</option>{props.options?.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('../src/features/common/GraphExpansion', () => ({ useGraphExpansion: () => ({ openWhenAvailable: () => {} }) }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: vi.fn(() => 'replace') }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456' }) }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ invalidateColumnarCache: () => {} }))
vi.mock('../src/features/models/EfaScoreFigure', () => ({ default: ({ onToggle, onBrush }: any) => <><button onClick={() => onToggle('r1')}>EFA点を選択</button><button onClick={() => onBrush({ x: [0, 2], y: [0, 3] })}>EFA範囲を選択</button></> }))
vi.mock('../src/features/models/ConjointFigure', () => ({ default: ({ onToggle, onBrush }: any) => <><button onClick={() => onToggle('r1')}>Conjoint点を選択</button><button onClick={() => onBrush({ x: [0, 2], y: [0, 3] })}>Conjoint範囲を選択</button></> }))

const columns = ['respondent', 'task', 'alternative', 'response', 'attribute', 'i1', 'i2', 'i3'].map(name => ({ columnId: name, name, label: name, scaleType: name === 'attribute' ? 'nominal' : 'ratio', role: 'question', multiResponseGroup: null }))
function localStore(scope = 'selected') {
  const base = store.getState()
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 2, allRowIds: ['r1', 'r2', 'r3'], activeRowIds: ['r1', 'r2'], selectedRowIds: ['r1'] },
    globalObservations: { ...base.globalObservations, scopeMode: scope, sampling: { ...base.globalObservations.sampling, sampledRowIds: ['r3'] } },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns, weightConfig: null } }
  return configureStore({ reducer: (current = state, action: any) => action.type === 'test/scope'
    ? { ...current, globalObservations: { ...current.globalObservations, scopeMode: action.payload.scope, sampling: { ...current.globalObservations.sampling, sampledRowIds: action.payload.sampledRowIds ?? current.globalObservations.sampling.sampledRowIds } },
      selection: { ...current.selection, ...(action.payload.selection ?? {}) } } : current,
    middleware: get => get({ serializableCheck: false }) })
}
function efaResult(): any {
  return { resultId: 'efa-1', meta: { datasetId: 'd', dataRevision: 2, schemaRevision: 1, resultState: 'fresh', fitCount: 1 },
    capabilities: { rows: true }, summary: { nFactors: 2, objective: { id: 'objective', value: 0 }, solutionStatus: 'ok', inferenceStatus: 'none' },
    details: { variables: [], factorIds: ['F1', 'F2'], factorLabels: ['F1', 'F2'], pattern: [], structure: [], communality: [], uniqueness: [], factorCorrelation: [], sampleCorrelation: [], factorComparisons: [], distributionProfiles: [], parallelAnalysis: { status: 'disabled', suggestedFactors: null } } }
}
function conjointResult(scope = 'selected'): any {
  return { resultId: 'cj-1', meta: { datasetId: 'd', dataRevision: 2, schemaRevision: 1, resultState: 'fresh', scope, scopeCount: 1, fitCount: 1, excludedCount: 0, exclusionCounts: {}, warnings: [] },
    capabilities: { rows: true, materializeFitFields: ['probability'], materializePredictionFields: ['probability'] },
    summary: { mode: 'choice', respondentCount: 1, taskCount: 1, fitProfileCount: 1, stageCount: 1, covarianceMethod: 'none', inferenceStatus: 'none', fitMetrics: {} },
    details: { coefficients: [], levelUtilities: [], attributeImportance: [], omittedLevels: [], optimizer: {}, wtp: [] }, unavailableReasons: {} }
}
beforeEach(() => {
  vi.mocked(getBrushOp).mockReturnValue('replace')
  vi.spyOn(api, 'get').mockResolvedValue({})
  vi.spyOn(efa, 'runEFA').mockResolvedValue(efaResult())
  vi.spyOn(efa, 'fetchAllEFARows').mockResolvedValue([{ rowId: 'r1', scores: [1, 2] }] as any)
  vi.spyOn(efa, 'selectEFA').mockResolvedValue({ rowIds: ['r1'], matchedCount: 1 } as any)
  vi.spyOn(efa, 'predictEFA').mockResolvedValue({ predictionId: 'efa-prediction' } as any)
  vi.spyOn(efa, 'materializeEFA').mockResolvedValue({ dataRevision: 2 })
  vi.spyOn(conjoint, 'runConjoint').mockResolvedValue(conjointResult())
  vi.spyOn(conjoint, 'fetchConjointRows').mockResolvedValue({ total: 1, nextOffset: null, rows: [{ rowId: 'r1', respondentId: 'person', probability: .8, residual: .2 }] } as any)
  vi.spyOn(conjoint, 'selectConjoint').mockResolvedValue({ rowIds: ['r1'], matchedCount: 1, contextIntersectionCount: 1 } as any)
  vi.spyOn(conjoint, 'predictConjoint').mockResolvedValue({ predictionId: 'cj-prediction', summary: { successfulPredictions: 1, requestedCount: 1 } } as any)
  vi.spyOn(conjoint, 'fetchConjointPredictions').mockResolvedValue({ total: 1, nextOffset: null, rows: [] })
  vi.spyOn(conjoint, 'materializeConjoint').mockResolvedValue({ dataRevision: 2, createdColumns: [{ name: 'new' }] } as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function chooseMultiple(select: HTMLSelectElement, values: string[]) {
  for (const option of select.options) option.selected = values.includes(option.value)
  fireEvent.change(select)
}
function chooseConjoint(view: ReturnType<typeof render>) {
  for (const [testId, value] of [['cj-respondent-col', 'respondent'], ['cj-task-col', 'task'], ['cj-alt-col', 'alternative'], ['cj-response-col', 'response']])
    fireEvent.change(view.getByTestId(testId).querySelector('select')!, { target: { value } })
  chooseMultiple(view.getByTestId('cj-cat-attrs').querySelector('select')!, ['attribute'])
}

it('keeps EFA result selection/save bound to the submitted scope while prediction uses the current shared target', async () => {
  const local = localStore()
  const view = render(<Provider store={local}><FactorAnalysisPage /></Provider>)
  chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
  fireEvent.click(view.getByRole('button', { name: /^実\s*行$/ }))
  await view.findByTestId('efa-result-scope')
  const original = structuredClone(vi.mocked(efa.runEFA).mock.calls[0][0].context)
  expect(original).toMatchObject({ scope: 'selected', selectedRowIds: ['r1'] })
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'sampled' } }) })
  expect(efa.runEFA).toHaveBeenCalledTimes(1)
  expect(view.getByTestId('efa-result-scope')).toHaveTextContent('Selected')
  expect(view.getByText('設定が変更されています。結果は前回実行分です')).toBeTruthy()
  fireEvent.click(view.getByRole('tab', { name: '得点操作' }))
  fireEvent.click(await view.findByRole('button', { name: 'EFA点を選択' }))
  await waitFor(() => expect(efa.selectEFA).toHaveBeenCalled())
  expect(vi.mocked(efa.selectEFA).mock.calls[0][1]).toEqual(original)
  fireEvent.click(view.getByRole('button', { name: /^予\s*測$/ }))
  await waitFor(() => expect(efa.predictEFA).toHaveBeenCalled())
  expect(vi.mocked(efa.predictEFA).mock.calls[0][1]).toMatchObject({ scope: 'sampled', sampledRowIds: ['r3'] })
  fireEvent.click(view.getByRole('button', { name: '派生列保存' }))
  await waitFor(() => expect(efa.materializeEFA).toHaveBeenCalled())
  expect(vi.mocked(efa.materializeEFA).mock.calls[0][1]).toEqual(original)
})

it('keeps Conjoint fit and prediction materialization bound to their respective execution snapshots', async () => {
  const local = localStore()
  const view = render(<Provider store={local}><ConjointPage /></Provider>)
  chooseConjoint(view)
  fireEvent.click(view.getByTestId('cj-run'))
  await view.findByRole('button', { name: 'Conjoint点を選択' })
  const original = structuredClone(vi.mocked(conjoint.runConjoint).mock.calls[0][0])
  expect(original).toMatchObject({ scope: 'selected', selectedRowIds: ['r1'] })
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'sampled' } }) })
  fireEvent.click(view.getByRole('button', { name: 'Conjoint点を選択' }))
  await waitFor(() => expect(conjoint.selectConjoint).toHaveBeenCalled())
  expect(vi.mocked(conjoint.selectConjoint).mock.calls[0][1]).toEqual(original)
  expect(conjoint.runConjoint).toHaveBeenCalledTimes(1)
  expect(view.getByTestId('conjoint-result-scope')).toHaveTextContent('Selected')
  fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  fireEvent.click(view.getByRole('button', { name: '表示結果の列へ保存' }))
  await waitFor(() => expect(conjoint.materializeConjoint).toHaveBeenCalledTimes(1))
  expect(vi.mocked(conjoint.materializeConjoint).mock.calls[0][1]).toEqual(original)
  fireEvent.click(view.getByRole('tab', { name: '予測・評価' }))
  fireEvent.click(view.getByRole('button', { name: '予測・評価' }))
  await waitFor(() => expect(conjoint.predictConjoint).toHaveBeenCalledTimes(1))
  const predictionContext = structuredClone(vi.mocked(conjoint.predictConjoint).mock.calls[0][1])
  expect(predictionContext).toMatchObject({ scope: 'sampled', sampledRowIds: ['r3'] })
  await view.findByText(/この予測の対象:/)
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'all' } }) })
  fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  fireEvent.click(view.getByRole('button', { name: '表示結果の列へ保存' }))
  await waitFor(() => expect(conjoint.materializeConjoint).toHaveBeenCalledTimes(2))
  expect(vi.mocked(conjoint.materializeConjoint).mock.calls[1].slice(1, 3)).toEqual([predictionContext, 'cj-prediction'])
})

it('invalidates Conjoint task expansion when the common source membership changes without silently re-expanding', async () => {
  const local = localStore()
  vi.spyOn(conjoint, 'expandConjointScope').mockResolvedValue({ status: 'ok', originalRowCount: 1, expandedRowCount: 2, addedRowCount: 1, expandedRowIds: ['r1', 'r2'] })
  const view = render(<Provider store={local}><ConjointPage /></Provider>)
  chooseConjoint(view)
  fireEvent.click(view.getByRole('button', { name: 'タスク全体へ拡張' }))
  const run = await view.findByRole('button', { name: '明示スコープで再実行' })
  fireEvent.click(run)
  await waitFor(() => expect(conjoint.runConjoint).toHaveBeenCalledTimes(1))
  expect(vi.mocked(conjoint.runConjoint).mock.calls[0][0]).toMatchObject({ scope: 'explicit', rowIds: ['r1', 'r2'] })
  await view.findByTestId('conjoint-result-scope')
  expect(view.getByTestId('conjoint-result-scope')).toHaveTextContent('選択中の行 (Selected)からタスク全体へ拡張 2行（実行時）')
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'selected', selection: { selectedRowIds: ['r2'] } } }) })
  expect(view.queryByRole('button', { name: '明示スコープで再実行' })).toBeNull()
  expect(view.getByText(/この拡張結果は失効しました/)).toBeTruthy()
  expect(conjoint.expandConjointScope).toHaveBeenCalledTimes(1)
  expect(conjoint.runConjoint).toHaveBeenCalledTimes(1)
})

it.each(['all', 'active', 'sampled'])('runs both EFA and Conjoint on shared %s rows without adding another scope field', async scope => {
  const expectedIds = scope === 'active' ? ['r1', 'r2'] : ['r3']
  for (const page of ['efa', 'conjoint']) {
    const local = localStore(scope)
    const view = render(<Provider store={local}>{page === 'efa' ? <FactorAnalysisPage /> : <ConjointPage />}</Provider>)
    if (page === 'efa') {
      chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
      fireEvent.click(view.getByRole('button', { name: /^実\s*行$/ }))
      await waitFor(() => expect(efa.runEFA).toHaveBeenCalledTimes(1))
    } else {
      chooseConjoint(view)
      fireEvent.click(view.getByTestId('cj-run'))
      await waitFor(() => expect(conjoint.runConjoint).toHaveBeenCalledTimes(1))
    }
    const context: any = page === 'efa' ? vi.mocked(efa.runEFA).mock.calls[0][0].context : vi.mocked(conjoint.runConjoint).mock.calls[0][0]
    expect(context.scope).toBe(scope)
    const fields = ['rowIds', 'activeRowIds', 'selectedRowIds', 'sampledRowIds'].filter(field => field in context)
    expect(fields).toEqual(scope === 'all' ? [] : [`${scope}RowIds`])
    if (scope !== 'all') expect(context[fields[0]]).toEqual(expectedIds)
    view.unmount()
  }
})

it.each(['efa', 'conjoint'])('does not broaden an empty Selected target when running %s', page => {
  const local = localStore()
  local.dispatch({ type: 'test/scope', payload: { scope: 'selected', selection: { selectedRowIds: [] } } })
  const view = render(<Provider store={local}>{page === 'efa' ? <FactorAnalysisPage /> : <ConjointPage />}</Provider>)
  if (page === 'efa') chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
  else chooseConjoint(view)
  expect(page === 'efa' ? view.getByRole('button', { name: /^実\s*行$/ }) : view.getByTestId('cj-run')).toBeDisabled()
  expect(efa.runEFA).not.toHaveBeenCalled()
  expect(conjoint.runConjoint).not.toHaveBeenCalled()
})

it('publishes a pending EFA run as the original input while membership changes only mark the next run dirty', async () => {
  const local = localStore()
  let resolve!: (value: any) => void
  vi.mocked(efa.runEFA).mockImplementation(() => new Promise(done => { resolve = done }))
  const view = render(<Provider store={local}><FactorAnalysisPage /></Provider>)
  chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
  fireEvent.click(view.getByRole('button', { name: /^実\s*行$/ }))
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'selected', selection: { selectedRowIds: ['r2'] } } }) })
  await act(async () => { resolve(efaResult()) })
  expect(view.getByText('設定が変更されています。結果は前回実行分です')).toBeTruthy()
  fireEvent.click(view.getByRole('tab', { name: '得点操作' }))
  fireEvent.click(await view.findByRole('button', { name: 'EFA点を選択' }))
  await waitFor(() => expect(efa.selectEFA).toHaveBeenCalledTimes(1))
  expect(vi.mocked(efa.selectEFA).mock.calls[0][1]).toMatchObject({ scope: 'selected', selectedRowIds: ['r1'] })
  expect(efa.runEFA).toHaveBeenCalledTimes(1)
})

it.each(['efa', 'conjoint'])('rejects a late %s fit after same-dataset revision changes and releases the busy state', async page => {
  const local = localStore()
  let resolve!: (value: any) => void
  if (page === 'efa') vi.mocked(efa.runEFA).mockImplementation(() => new Promise(done => { resolve = done }))
  else vi.mocked(conjoint.runConjoint).mockImplementation(() => new Promise(done => { resolve = done }))
  const view = render(<Provider store={local}>{page === 'efa' ? <FactorAnalysisPage /> : <ConjointPage />}</Provider>)
  if (page === 'efa') chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
  else chooseConjoint(view)
  const button = page === 'efa' ? view.getByRole('button', { name: /^実\s*行$/ }) : view.getByTestId('cj-run')
  fireEvent.click(button)
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'selected', selection: { dataRevision: 3 } } }) })
  await act(async () => { resolve(page === 'efa' ? efaResult() : conjointResult()) })
  expect(view.queryByTestId(page === 'efa' ? 'efa-result-scope' : 'conjoint-result-scope')).toBeNull()
  expect(button).toBeEnabled()
  expect(efa.fetchAllEFARows).not.toHaveBeenCalled()
  expect(conjoint.fetchConjointRows).not.toHaveBeenCalled()
})

it('rejects Conjoint prediction pages that complete after a data revision change', async () => {
  const local = localStore()
  const view = render(<Provider store={local}><ConjointPage /></Provider>)
  chooseConjoint(view)
  fireEvent.click(view.getByTestId('cj-run'))
  await view.findByRole('button', { name: 'Conjoint点を選択' })
  let resolve!: (value: any) => void
  vi.mocked(conjoint.fetchConjointPredictions).mockImplementation(() => new Promise(done => { resolve = done }))
  fireEvent.click(view.getByRole('tab', { name: '予測・評価' }))
  fireEvent.click(view.getByRole('button', { name: '予測・評価' }))
  await waitFor(() => expect(conjoint.fetchConjointPredictions).toHaveBeenCalledTimes(1))
  act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'selected', selection: { dataRevision: 3 } } }) })
  await act(async () => { resolve({ total: 1, nextOffset: null, rows: [] }) })
  expect(view.queryByText(/この予測の対象:/)).toBeNull()
  expect(view.getByTestId('conjoint-result-scope')).toHaveTextContent('Selected')
  expect(view.getByText(/古い版の結果です/)).toBeTruthy()
  expect(view.getByRole('button', { name: '予測・評価' })).toBeDisabled()
})


async function renderFittedModel(page: string) {
  const local = localStore('all')
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<Provider store={local}>{page === 'efa' ? <FactorAnalysisPage /> : <ConjointPage />}</Provider>)
  if (page === 'efa') chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
  else chooseConjoint(view)
  const run = page === 'efa' ? view.getByRole('button', { name: /^実\s*行$/ }) : view.getByTestId('cj-run')
  fireEvent.click(run)
  await view.findByTestId(page === 'efa' ? 'efa-result-scope' : 'conjoint-result-scope')
  if (page === 'efa') fireEvent.click(view.getByRole('tab', { name: '得点操作' }))
  const brush = await view.findByRole('button', { name: page === 'efa' ? 'EFA範囲を選択' : 'Conjoint範囲を選択' })
  return { local, view, run, brush, dispatch }
}

it.each(['efa', 'conjoint'])('keeps only the latest %s brush response and captures its operation before await', async page => {
  const { view, brush, dispatch } = await renderFittedModel(page)
  const pending: Array<(value: any) => void> = []
  const select = page === 'efa' ? vi.mocked(efa.selectEFA) : vi.mocked(conjoint.selectConjoint)
  select.mockImplementation(() => new Promise<any>(resolve => { pending.push(resolve) }))
  fireEvent.click(brush)
  fireEvent.click(brush)
  expect(select).toHaveBeenCalledTimes(2)
  vi.mocked(getBrushOp).mockReturnValue('subtract')
  await act(async () => { pending[1]({ rowIds: ['r2'], matchedCount: 1, contextIntersectionCount: 1 }) })
  await act(async () => { pending[0]({ rowIds: ['r1'], matchedCount: 1, contextIntersectionCount: 1 }) })
  const actions = dispatch.mock.calls.map(([action]) => action).filter(action => action.type === selectionApplied.type)
  expect(actions).toHaveLength(1)
  expect(actions[0].payload).toMatchObject({ rowIds: ['r2'], operation: 'replace' })
  expect(view.queryByText('選択中…')).toBeNull()
})

it.each(['efa', 'conjoint'])('lets a newer %s point selection supersede a pending brush', async page => {
  const { view, brush, dispatch } = await renderFittedModel(page)
  const pending: Array<(value: any) => void> = []
  const select = page === 'efa' ? vi.mocked(efa.selectEFA) : vi.mocked(conjoint.selectConjoint)
  select.mockImplementation(() => new Promise<any>(resolve => { pending.push(resolve) }))
  fireEvent.click(brush)
  fireEvent.click(view.getByRole('button', { name: page === 'efa' ? 'EFA点を選択' : 'Conjoint点を選択' }))
  expect(select).toHaveBeenCalledTimes(2)
  await act(async () => { pending[1]({ rowIds: ['r2'], matchedCount: 1, contextIntersectionCount: 1 }) })
  await act(async () => { pending[0]({ rowIds: ['r1'], matchedCount: 1, contextIntersectionCount: 1 }) })
  const actions = dispatch.mock.calls.map(([action]) => action).filter(action => action.type === selectionApplied.type)
  expect(actions).toHaveLength(1)
  expect(actions[0].payload).toMatchObject({ rowIds: ['r2'], operation: 'toggle' })
})

it.each(['efa', 'conjoint'].flatMap(page => ['dataset', 'revision', 'unmount', 'fit'].map(change => [page, change])))('invalidates pending %s selections on %s changes', async (page, change) => {
  const { local, view, run, brush, dispatch } = await renderFittedModel(page)
  let resolve!: (value: any) => void
  const select = page === 'efa' ? vi.mocked(efa.selectEFA) : vi.mocked(conjoint.selectConjoint)
  select.mockImplementation(() => new Promise<any>(done => { resolve = done }))
  fireEvent.click(brush)
  expect(select).toHaveBeenCalledTimes(1)
  if (change === 'unmount') view.unmount()
  else if (change === 'fit') fireEvent.click(run)
  else act(() => { local.dispatch({ type: 'test/scope', payload: { scope: 'all', selection: change === 'dataset' ? { datasetId: 'next' } : { dataRevision: 3 } } }) })
  await act(async () => { resolve({ rowIds: ['r2'], matchedCount: 1, contextIntersectionCount: 1 }) })
  expect(dispatch.mock.calls.filter(([action]) => action.type === selectionApplied.type)).toHaveLength(0)
})
