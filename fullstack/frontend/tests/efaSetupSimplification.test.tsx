import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import FactorAnalysisPage from '../src/features/models/FactorAnalysisPage'
import * as efa from '../src/features/models/efaApi'

vi.mock('../src/features/dataset/useCodebookColumn', () => ({ useCodebook: () => useSelector((state: any) => state.codebook) }))
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select id={props.id} style={props.style} multiple value={props.value}
  onChange={event => props.onChange([...event.target.selectedOptions].map(option => option.value))}>
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('antd', async () => {
  const original = await vi.importActual<typeof import('antd')>('antd')
  return { ...original, Table: () => null, Select: (props: any) => <select id={props.id} aria-describedby={props['aria-describedby']} value={props.value}
    onChange={event => props.onChange(event.target.value)}>
    {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select> }
})
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div> }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: () => 'replace' }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456' }) }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ invalidateColumnarCache: () => {} }))
vi.mock('../src/features/models/EfaScoreFigure', () => ({ default: () => null }))

const columns = [
  ...Array.from({ length: 5 }, (_, i) => ({ columnId: 'c' + (i + 1), name: 'c' + (i + 1), label: '連続' + (i + 1), scaleType: 'ratio', categoryOrder: null })),
  ...Array.from({ length: 5 }, (_, i) => ({ columnId: 'o' + (i + 1), name: 'o' + (i + 1), label: '順序' + (i + 1), scaleType: 'ordinal', categoryOrder: ['1', '2', '3'] })),
  { columnId: 'missing-order', name: 'missing-order', label: '順序未設定', scaleType: 'ordinal', categoryOrder: null },
].map(column => ({ ...column, role: 'question', multiResponseGroup: null }))
function renderPage({ count = 3, weighted = false }: { count?: number; weighted?: boolean } = {}) {
  const base = store.getState()
  const ids = Array.from({ length: count }, (_, index) => 'r' + index)
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1, allRowIds: ids, activeRowIds: ids, selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'all' },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns, weightConfig: weighted ? { weightColumnId: 'c1', weightType: 'survey' } : null },
  }
  const local = configureStore({ reducer: (current = state) => current, middleware: get => get({ serializableCheck: false }) })
  return render(<Provider store={local}><FactorAnalysisPage /></Provider>)
}
function chooseItems(view: ReturnType<typeof render>, ids: string[]) {
  const select = view.getByLabelText('項目（必須・3つ以上）') as HTMLSelectElement
  for (const option of select.options) option.selected = ids.includes(option.value)
  fireEvent.change(select)
}
function panel(view: ReturnType<typeof render>, title: string) {
  return view.getByText(title, { selector: '.analysis-settings-title' }).closest('details') as HTMLDetailsElement
}
function runButton(view: ReturnType<typeof render>) { return view.getByRole('button', { name: /^実\s*行$/ }) }
function result(): any {
  return { resultId: 'efa-setup', meta: { datasetId: 'd', dataRevision: 1, schemaRevision: 1, resultState: 'fresh', fitCount: 3 },
    capabilities: { rows: false }, summary: { nFactors: 1, objective: { id: 'objective', value: 0 } },
    details: { variables: [], factorIds: ['F1'], pattern: [], structure: [], communality: [], uniqueness: [], factorCorrelation: [], sampleCorrelation: [], factorComparisons: [], distributionProfiles: [], parallelAnalysis: { status: 'disabled', suggestedFactors: null } } }
}
beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({})
  vi.spyOn(efa, 'runEFA').mockResolvedValue(result())
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('starts with a full-width required picker, mounted collapsed settings, and a primary run action', () => {
  const view = renderPage()
  expect(view.getByLabelText('項目（必須・3つ以上）')).toHaveStyle({ width: '100%', minWidth: '0' })
  for (const title of ['項目の扱い・逆転', '分析方法・詳細設定', '重み・欠損値']) expect(panel(view, title).open).toBe(false)
  expect(view.container.querySelector('#efa-factor-count')).toHaveValue('2')
  expect(runButton(view)).toBeDisabled()
  expect(runButton(view)).toHaveClass('ant-btn-primary')
  expect(runButton(view).closest('.analysis-run-row')).toHaveTextContent('項目を3つ以上選択してください（現在0項目）')
})

it.each([
  { ids: ['c1', 'c2', 'c3'], correlation: 'pearson', nFactors: 1 },
  { ids: ['c1', 'c2', 'c3', 'c4'], correlation: 'pearson', nFactors: 1 },
  { ids: ['c1', 'c2', 'c3', 'c4', 'c5'], correlation: 'pearson', nFactors: 2 },
  { ids: ['o1', 'o2', 'o3'], correlation: 'polychoric', nFactors: 1 },
  { ids: ['o1', 'o2', 'o3', 'o4', 'o5'], correlation: 'polychoric', nFactors: 2 },
])('runs $ids with compatible correlation=$correlation and identified nFactors=$nFactors', async ({ ids, correlation, nFactors }) => {
  const view = renderPage()
  chooseItems(view, ids)
  expect(panel(view, '分析方法・詳細設定').open).toBe(false)
  expect(runButton(view)).toBeEnabled()
  fireEvent.click(runButton(view))
  await waitFor(() => expect(efa.runEFA).toHaveBeenCalledTimes(1))
  expect(vi.mocked(efa.runEFA).mock.calls[0][0]).toMatchObject({ correlation, nFactors,
    extraction: 'minres', rotation: 'promax', scoreMethod: 'none', compareFactors: [],
    parallelAnalysis: { enabled: true, iterations: 500, quantile: .95, seed: 42 },
    sensitivityAnalysis: { enabled: false, approximationAcknowledged: false },
    context: { weightMode: 'dataset', missingPolicy: 'exclude', scope: 'all' },
    uniquenessLower: .005, nStarts: 5, maxIterations: 2000, seed: 42,
  })
  expect((vi.mocked(efa.runEFA).mock.calls[0][0].variables as any[]).every(variable => !variable.approximationAcknowledged)).toBe(true)
})

it('retains manual method settings when the optional panel is closed and reopened', async () => {
  const view = renderPage()
  chooseItems(view, ['c1', 'c2', 'c3', 'c4', 'c5'])
  const methods = panel(view, '分析方法・詳細設定')
  fireEvent.click(methods.querySelector('summary')!)
  fireEvent.change(view.getByLabelText('因子数'), { target: { value: '1' } })
  fireEvent.change(view.getByLabelText('相関'), { target: { value: 'pearson' } })
  fireEvent.change(view.getByLabelText('抽出'), { target: { value: 'ml' } })
  fireEvent.change(view.getByLabelText('回転'), { target: { value: 'varimax' } })
  fireEvent.change(view.getByLabelText('得点'), { target: { value: 'regression' } })
  fireEvent.change(view.getByLabelText('候補比較'), { target: { value: '2' } })
  fireEvent.click(view.getByLabelText('平行分析'))
  fireEvent.click(methods.querySelector('summary')!)
  expect(methods.open).toBe(false)
  fireEvent.click(methods.querySelector('summary')!)
  expect(view.getByLabelText('因子数')).toHaveValue('1')
  expect(view.getByLabelText('相関')).toHaveValue('pearson')
  fireEvent.click(methods.querySelector('summary')!)
  expect(methods.querySelector('summary')).toHaveTextContent('得点: regression')
  expect(methods.querySelector('summary')).toHaveTextContent('候補比較: 2')
  fireEvent.click(runButton(view))
  await waitFor(() => expect(efa.runEFA).toHaveBeenCalledTimes(1))
  expect(vi.mocked(efa.runEFA).mock.calls[0][0]).toMatchObject({ correlation: 'pearson', nFactors: 1, extraction: 'ml', rotation: 'varimax', scoreMethod: 'regression', compareFactors: [2], parallelAnalysis: { enabled: false } })
})

it('requires acknowledged approximation for mixed items and opens the treatment panel', async () => {
  const view = renderPage()
  chooseItems(view, ['o1', 'c1', 'c2'])
  expect(panel(view, '項目の扱い・逆転').open).toBe(true)
  expect(runButton(view)).toBeDisabled()
  expect(view.getByLabelText('順序1')).toHaveValue('ordinal')
  expect(view.getByText(/順序モデルと連続項目は混在できません/)).toBeInTheDocument()
  fireEvent.change(view.getByLabelText('順序1'), { target: { value: 'continuous_approximation' } })
  expect(runButton(view)).toBeDisabled()
  expect(panel(view, '項目の扱い・逆転').querySelector('summary')).toHaveTextContent('近似の同意待ち 1項目')
  fireEvent.click(view.getByLabelText('等間隔の明示同意'))
  fireEvent.click(view.getByLabelText('逆転'))
  expect(panel(view, '項目の扱い・逆転').querySelector('summary')).toHaveTextContent('連続近似 1項目 / 逆転 1項目')
  expect(runButton(view)).toBeEnabled()
  fireEvent.click(runButton(view))
  await waitFor(() => expect(efa.runEFA).toHaveBeenCalledTimes(1))
  const request = vi.mocked(efa.runEFA).mock.calls[0][0]
  expect(request.correlation).toBe('pearson')
  expect(request.variables).toContainEqual({ columnId: 'o1', measurement: 'ordinal', treatment: 'continuous_approximation', categoryOrder: ['1', '2', '3'], reverse: true, approximationAcknowledged: true })
})

it('explains underidentified manual factors without silently reducing an override', () => {
  const view = renderPage()
  chooseItems(view, ['c1', 'c2', 'c3', 'c4', 'c5'])
  const methods = panel(view, '分析方法・詳細設定')
  fireEvent.click(methods.querySelector('summary')!)
  fireEvent.change(view.getByLabelText('因子数'), { target: { value: '1' } })
  fireEvent.change(view.getByLabelText('因子数'), { target: { value: '2' } })
  fireEvent.click(methods.querySelector('summary')!)
  chooseItems(view, ['c1', 'c2', 'c3'])
  expect(methods.open).toBe(true)
  expect(view.getByLabelText('因子数')).toHaveValue('2')
  expect(runButton(view)).toBeDisabled()
  expect(view.getByText(/選択した3項目では因子数2を推定できません/)).toBeInTheDocument()
  fireEvent.click(view.getByRole('button', { name: '初期設定に戻す' }))
  expect(view.getByLabelText('因子数')).toHaveValue('1')
  expect(runButton(view)).toBeEnabled()
})

it('requires an explicit unweighted choice when the dataset has configured weights', async () => {
  const view = renderPage({ weighted: true })
  chooseItems(view, ['c1', 'c2', 'c3'])
  expect(panel(view, '重み・欠損値').open).toBe(true)
  expect(runButton(view)).toBeDisabled()
  fireEvent.click(view.getByLabelText('なし（明示）'))
  fireEvent.click(runButton(view))
  await waitFor(() => expect(efa.runEFA).toHaveBeenCalledTimes(1))
  expect(vi.mocked(efa.runEFA).mock.calls[0][0]).toMatchObject({ context: { weightMode: 'none' } })
})

it('explains an empty target near the run action instead of asking for more items', () => {
  const view = renderPage({ count: 0 })
  chooseItems(view, ['c1', 'c2', 'c3'])
  expect(runButton(view)).toBeDisabled()
  expect(runButton(view).closest('.analysis-run-row')).toHaveTextContent('分析対象が0行です')
  expect(efa.runEFA).not.toHaveBeenCalled()
})

it('reveals relevant collapsed settings when the API rejects a run', async () => {
  vi.mocked(efa.runEFA).mockRejectedValue({ code: 'FA_WEIGHT_UNSUPPORTED', message: '重みが利用できません' })
  const view = renderPage()
  chooseItems(view, ['c1', 'c2', 'c3'])
  expect(panel(view, '重み・欠損値').open).toBe(false)
  fireEvent.click(runButton(view))
  await view.findByText('重みが利用できません(FA_WEIGHT_UNSUPPORTED)')
  expect(panel(view, '重み・欠損値').open).toBe(true)
  expect(view.getByText('重み・欠損値を開いて設定を確認してください。')).toBeInTheDocument()
})

it('rejects missing ordinal category order without transmitting an invalid request', () => {
  const view = renderPage()
  chooseItems(view, ['o1', 'o2', 'missing-order'])
  expect(panel(view, '項目の扱い・逆転').open).toBe(true)
  expect(view.getByText(/順序未設定.*カテゴリ順序が不足しています/)).toBeInTheDocument()
  expect(runButton(view)).toBeDisabled()
  expect(efa.runEFA).not.toHaveBeenCalled()
})


it.each(['1.5', '1,1', '1,', '2'])('rejects invalid or underidentified factor comparison %s', (value) => {
  const view = renderPage()
  chooseItems(view, ['c1', 'c2', 'c3'])
  const methods = panel(view, '分析方法・詳細設定')
  fireEvent.click(methods.querySelector('summary')!)
  fireEvent.change(view.getByLabelText('候補比較'), { target: { value } })
  expect(runButton(view)).toBeDisabled()
  expect(view.getByText('分析方法・詳細設定を確認してください')).toBeInTheDocument()
  expect(efa.runEFA).not.toHaveBeenCalled()
})

it('preserves explicit correlation overrides and reveals a newly incompatible choice', () => {
  const view = renderPage()
  chooseItems(view, ['c1', 'c2', 'c3'])
  const methods = panel(view, '分析方法・詳細設定')
  fireEvent.click(methods.querySelector('summary')!)
  fireEvent.change(view.getByLabelText('相関'), { target: { value: 'pearson' } })
  fireEvent.click(methods.querySelector('summary')!)
  chooseItems(view, ['o1', 'o2', 'o3'])
  expect(methods.open).toBe(true)
  expect(view.getByLabelText('相関')).toHaveValue('pearson')
  expect(view.getByText('順序モデルでは相関をPolychoricにしてください。')).toBeInTheDocument()
  expect(runButton(view)).toBeDisabled()
  fireEvent.change(view.getByLabelText('相関'), { target: { value: 'auto' } })
  expect(runButton(view)).toBeEnabled()
})

it('shows sensitivity consent in the collapsed summary and clears consent when disabled', async () => {
  const view = renderPage()
  chooseItems(view, ['o1', 'o2', 'o3'])
  const methods = panel(view, '分析方法・詳細設定')
  fireEvent.click(methods.querySelector('summary')!)
  fireEvent.click(view.getByLabelText('感度比較'))
  expect(methods.querySelector('summary')).toHaveTextContent('感度比較あり（同意待ち）')
  expect(runButton(view)).toBeDisabled()
  fireEvent.click(view.getByLabelText('連続近似の独立同意'))
  expect(runButton(view)).toBeEnabled()
  fireEvent.click(view.getByLabelText('感度比較'))
  fireEvent.click(methods.querySelector('summary')!)
  fireEvent.click(runButton(view))
  await waitFor(() => expect(efa.runEFA).toHaveBeenCalledTimes(1))
  expect(vi.mocked(efa.runEFA).mock.calls[0][0]).toMatchObject({ sensitivityAnalysis: { enabled: false, approximationAcknowledged: false } })
})
