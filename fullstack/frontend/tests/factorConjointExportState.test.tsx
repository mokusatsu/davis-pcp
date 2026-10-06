import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
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
  vi.spyOn(efa, 'materializeEFA').mockResolvedValue({ status: 'success', resultId: 'efa-1',
    idempotentReplay: false, columns: [{ source: 'score:1', name: 'efa_f1' }],
    datasetId: 'd', dataRevision: 3, schemaRevision: 2 })
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


const exportCases = [
  ...['変数CSV', '診断CSV', 'PA CSV'].map(label => ({ page: 'efa' as const, label })),
  ...['coefficients CSV', 'coefficients JSON', 'diagnostics CSV', 'diagnostics JSON', 'rows CSV', 'rows JSON', 'utilities CSV', 'utilities JSON', 'モデルJSON']
    .map(label => ({ page: 'conjoint' as const, label })),
]
// Each button owns independent async state. Give each format a fresh page and the
// normal per-test deadline instead of accumulating nine accessible-query cycles.
it.each(exportCases)('$page exports $label with progress, error and retry protection', async ({ page, label }) => {
  const view = render(<Provider store={localStore()}>{page === 'efa' ? <FactorAnalysisPage /> : <ConjointPage />}</Provider>)
  if (page === 'efa') {
    chooseMultiple(view.getByLabelText('項目を選択') as HTMLSelectElement, ['i1', 'i2', 'i3'])
    fireEvent.click(view.getByRole('button', { name: /^実\s*行$/ }))
    await view.findByTestId('efa-result-scope')
    fireEvent.click(view.getByRole('tab', { name: '得点操作' }))
  } else {
    chooseConjoint(view)
    fireEvent.click(view.getByTestId('cj-run'))
    await view.findByRole('button', { name: 'Conjoint点を選択' })
    fireEvent.click(view.getByRole('tab', { name: '保存・出力' }))
  }
  // Keep repeated export queries inside the active panel instead of scanning the full model form.
  const exportPanel = within(view.getByRole('tabpanel', { name: page === 'efa' ? '得点操作' : '保存・出力' }))
  const exportTable = page === 'efa' ? vi.spyOn(efa, 'exportEFATable') : vi.spyOn(conjoint, 'exportConjointTable')
  let reject!: (error: unknown) => void
  exportTable.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
  const initial = exportTable.mock.calls.length, button = exportPanel.getByRole('button', { name: label })
  fireEvent.click(button); fireEvent.click(button)
  expect(exportTable.mock.calls.length - initial).toBe(1)
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
  await act(async () => reject(new Error('export offline')))
  expect(await exportPanel.findByText(`${label}を保存できませんでした: export offline`)).toHaveAttribute('role', 'alert')
  expect(button).toBeEnabled()
  exportTable.mockResolvedValueOnce(undefined)
  fireEvent.click(button)
  await waitFor(() => expect(exportPanel.getByText(`${label}のダウンロードを開始しました`)).toHaveAttribute('role', 'status'))
  expect(exportTable.mock.calls.length - initial).toBe(2)
})
