import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import type { ReactElement } from 'react'
import { store, selectionReducer } from '../src/app/store'
import type { CodebookColumn } from '../src/api/client'
import { api } from '../src/api/client'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import FamdPage from '../src/features/models/FamdPage'
import FactorAnalysisPage from '../src/features/models/FactorAnalysisPage'
import ModelScatter from '../src/features/models/ModelScatter'
import type { MCAResponse } from '../src/features/models/mcaTypes'
import type { FAMDResponse } from '../src/features/models/famdTypes'
import * as mca from '../src/features/models/mcaApi'
import * as famd from '../src/features/models/famdApi'
import * as efa from '../src/features/models/efaApi'

// Keep page state, all Ant Design controls (including every target Select),
// codebook lookup, figure coordinate/caption adapters and GraphPanel real.
// Only the unrelated setup variable picker, row-color/legend data, final chart
// renderer and analysis/metadata transport are replaced. No live API is used.
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) =>
  <select id={props.id} multiple value={props.value} onChange={event =>
    props.onChange([...event.target.selectedOptions].map(option => option.value))}>
    {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/models/ModelScatter', () => ({ default: vi.fn(({ testId }) => <div data-testid={testId} />) }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))

const meta = { datasetId: 'axis-test', dataRevision: 1, schemaRevision: 1, resultState: 'fresh', scope: 'all',
  scopeCount: 2, fitCount: 2, effectiveN: 2, excludedCount: 0, exclusionCounts: {}, weightApplied: false,
  weightType: null, weightColumn: null, algorithmVersion: 'test', warnings: [] }
const capabilities = { rows: true, projection: false, materialize: false, selectionKinds: [],
  exportTables: [], materializeFitFields: [], materializePredictionFields: [] }
const columns: CodebookColumn[] = ['cat1', 'cat2', 'n1', 'n2', 'n3', 'n4', 'n5'].map(name => ({
  columnId: name, name, label: name, scaleType: name.startsWith('cat') ? 'nominal' : 'ratio',
  role: 'question', multiResponseGroup: null, valueLabels: {}, categoryOrder: [], missingCodes: [],
  missingReasons: {}, isReversed: false,
}))
function mcaResult(rank: number): MCAResponse {
  return { status: 'ok', resultId: 'mca-axis-result', method: 'mca', meta, config: {}, capabilities,
    summary: { nVariables: 2, nCategories: 5, rank, totalInertia: 1.5,
      eigenvalues: [.75, .45, .3].slice(0, rank), rawInertiaRatio: [.5, .3, .2].slice(0, rank),
      rawCumulativeInertiaRatio: [.5, .8, 1].slice(0, rank), inertiaAdjustment: 'raw',
      adjustedEigenvalues: null, adjustedInertiaRatio: null, adjustedReason: null,
      discardedNumericalInertia: 0, degenerateBlocks: [] },
    details: { categories: [], variables: [], omittedCategories: [], maDiagnostics: [], rowCount: 2 } }
}
function famdResult(rank: number): FAMDResponse {
  return { status: 'ok', resultId: 'famd-axis-result', method: 'famd', meta, config: {}, capabilities,
    summary: { rank, totalInertia: 2, eigenvalues: [1, .6, .4].slice(0, rank),
      inertiaRatio: [.5, .3, .2].slice(0, rank), cumulativeInertiaRatio: [.5, .8, 1].slice(0, rank),
      nNumericVariables: 1, nCategoricalVariables: 1, nCategories: 3,
      coordinateConvention: 'test', discardedNumericalInertia: 0, degenerateBlocks: [] },
    details: { numericVariables: [], categoricalVariables: [], categories: [], variableRelation: [], omittedCategories: [], rowCount: 2 } }
}
function efaResult(nFactors: number, rows: boolean): efa.EFAResponse {
  return { status: 'ok', resultId: 'efa-axis-result', method: 'efa', meta, config: {},
    capabilities: { ...capabilities, rows }, summary: { computationStatus: 'ok', solutionStatus: 'admissible',
      nVariables: nFactors === 1 ? 3 : 5, nFactors, modelDf: 1,
      objective: { id: 'objective', value: 0, offDiagonalSse: 0 }, rmsr: 0, totalCommunalityRatio: .5,
      inferenceStatus: 'none', scoreMethod: rows ? 'regression' : 'none' },
    details: { variables: [], factorIds: ['F1', 'F2'].slice(0, nFactors), factorLabels: ['F1', 'F2'].slice(0, nFactors),
      pattern: [], structure: [], factorCorrelation: [], communality: [], uniqueness: [], sampleCorrelation: [],
      reproducedCorrelation: [], residualCorrelation: [], thresholds: null, factorComparisons: [], distributionProfiles: [],
      parallelAnalysis: { status: 'disabled', observedEigenvalues: [], referenceQuantiles: [], suggestedFactors: null, reasonCode: null } },
    unavailableReasons: {} }
}
function mount(page: ReactElement) {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: meta.datasetId, dataRevision: 1,
      allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'], selectedRowIds: ['r1'] },
    globalVariables: { ...base.globalVariables, activeEntities: null },
    globalObservations: { ...base.globalObservations, scopeMode: 'all' as const },
    codebook: { ...base.codebook, datasetId: meta.datasetId, schemaRevision: 1, columns, isLoading: false, weightConfig: null },
  }
  const local = configureStore({ reducer: (current = state, action) => ({ ...current,
    selection: selectionReducer(current.selection, action) }), middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<Provider store={local}><GraphExpansionProvider>{page}</GraphExpansionProvider></Provider>)
  return { ...view, local, dispatch }
}
function chooseItems(label: string, values: string[]) {
  const select = screen.getByLabelText(label) as HTMLSelectElement
  for (const option of select.options) option.selected = values.includes(option.value)
  fireEvent.change(select)
}
function axes(panel: HTMLElement, method: string, hasY = true) {
  const names = [`${method}のX軸`, ...(hasY ? [`${method}のY軸`] : [])]
  const inputs = names.map(name => within(panel).queryByRole('combobox', { name, exact: true }))
  expect(inputs, `Exact INPUT names: ${names.join(', ')}`).toEqual(names.map(() => expect.any(HTMLInputElement)))
  for (const input of inputs) expect(input!.id).not.toBe('')
  return inputs as HTMLInputElement[]
}
function expectValue(input: HTMLElement, label: string) {
  expect(input.closest('.ant-select')!.querySelector('.ant-select-selection-item')).toHaveTextContent(label)
}
async function chooseAxis(input: HTMLElement, current: string, next: string, steps = 1) {
  fireEvent.mouseDown(input)
  const activeOption = () => document.getElementById(input.getAttribute('aria-activedescendant')!)
  await waitFor(() => expect(activeOption()).toHaveAccessibleName(current))
  for (let step = 0; step < steps; step++) {
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, which: 40 })
    fireEvent.keyUp(input, { key: 'ArrowDown', keyCode: 40, which: 40 })
  }
  expect(activeOption()).toHaveAccessibleName(next)
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 })
  fireEvent.keyUp(input, { key: 'Enter', keyCode: 13, which: 13 })
  await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'))
}
function plot(testId: string) {
  const calls = vi.mocked(ModelScatter).mock.calls.filter(([props]) => props.testId === testId)
  return calls[calls.length - 1][0]
}
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  vi.spyOn(api, 'get').mockResolvedValue({ dataRevision: 1, schemaRevision: 1, rows: [], nextOffset: null })
  vi.spyOn(api, 'post').mockResolvedValue({ payload: '{"rows":[]}', nextOffset: null })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const correspondenceCases = [
  { name: 'MCA', page: <MultipleCorrespondencePage />, result: mcaResult, graph: 'mca' },
  { name: 'FAMD', page: <FamdPage />, result: famdResult, graph: 'famd' },
]
async function runCorrespondence(test: typeof correspondenceCases[number], rank: number) {
  const result = test.result(rank), original = structuredClone(result)
  const run = test.name === 'MCA' ? vi.spyOn(mca, 'runMca').mockResolvedValue(result as MCAResponse)
    : vi.spyOn(famd, 'runFamd').mockResolvedValue(result as FAMDResponse)
  const fetch = test.name === 'MCA' ? vi.spyOn(mca, 'fetchMcaRows') : vi.spyOn(famd, 'fetchFamdRows')
  fetch.mockImplementation(async (_id, _offset, _limit, requested = []) => ({
    total: 2, nextOffset: null, axes: requested,
    rows: [{ rowId: 'r1', coordinates: requested.map(axis => axis * 10) },
      { rowId: 'r2', coordinates: requested.map(axis => axis * -10) }],
  }))
  const view = mount(test.page)
  if (test.name === 'MCA') chooseItems('分析変数（2つ以上）', ['cat1', 'cat2'])
  else { chooseItems('数値列', ['n1']); chooseItems('カテゴリ列', ['cat1']) }
  fireEvent.click(view.getByTestId(`${test.graph}-run`))
  const panel = await view.findByRole('tabpanel', { name: '個体図（2）' })
  view.dispatch.mockClear()
  return { ...view, panel, result, original, run, fetch }
}
it.each(correspondenceCases)('$name names real axis INPUTs while retaining numeric choices and effective Y', async test => {
  const view = await runCorrespondence(test, 3)
  const [x, y] = axes(view.panel, test.name), ids = [x.id, y.id]
  const first = '第1軸 (50.0%)', second = '第2軸 (30.0%)', third = '第3軸 (20.0%)'
  expectValue(x, first); expectValue(y, second)
  expect(view.fetch.mock.calls.map(call => call[3])).toEqual([[1, 2]])
  const expectPlot = (xLabel: string, yLabel: string, xValue: number, yValue: number) => {
    expect(plot(`${test.graph}-individual-svg`)).toMatchObject({ xLabel, yLabel,
      points: [{ id: 'r1', rowId: 'r1', x: xValue, y: yValue, selected: true },
        { id: 'r2', rowId: 'r2', x: -xValue, y: -yValue, selected: false }] })
  }
  expectPlot(first, second, 10, 20)
  await chooseAxis(x, first, second)
  await waitFor(() => expectPlot(second, first, 20, 10))
  expectValue(x, second); expectValue(y, first)
  await chooseAxis(y, first, third, 2)
  await waitFor(() => expectPlot(second, third, 20, 30))
  expectValue(x, second); expectValue(y, third)
  // Selecting X's value for Y retains the already effective Y.
  await chooseAxis(y, third, second, 2)
  expectValue(y, third); expectPlot(second, third, 20, 30)
  await chooseAxis(x, second, first, 2)
  await waitFor(() => expectPlot(first, third, 10, 30))
  expectValue(x, first); expectValue(y, third)
  expect(view.fetch.mock.calls.map(call => call[3])).toEqual([[1, 2], [2, 1], [2, 3], [1, 3]])
  expect(view.fetch.mock.calls.every(call => call[0] === view.result.resultId)).toBe(true)
  expect(axes(view.panel, test.name)).toEqual([x, y]); expect([x.id, y.id]).toEqual(ids)
  const host = view.getByTestId(`graph-host-${test.graph}/individuals`)
  expect(host).not.toContainElement(x); expect(host).not.toContainElement(y)
  expect(view.dispatch).not.toHaveBeenCalled()
  expect(view.local.getState().selection.selectedRowIds).toEqual(['r1'])
  expect(view.run).toHaveBeenCalledTimes(1)
  expect(view.result).toEqual(view.original)
  expect(vi.mocked(api.post).mock.calls).toEqual([[`/analysis-results/${view.result.resultId}/export`,
    { format: 'json', table: 'members', offset: 0, limit: 5000 }]])
})
it.each(correspondenceCases)('$name displays effective Y and restores the retained Y choice when only X changes', async test => {
  const view = await runCorrespondence(test, 3)
  const [x, y] = axes(view.panel, test.name), ids = [x.id, y.id]
  const first = '第1軸 (50.0%)', second = '第2軸 (30.0%)'
  const expectAxes = (xLabel: string, yLabel: string, xAxis: number, yAxis: number) => {
    expectValue(x, xLabel); expectValue(y, yLabel)
    expect(view.fetch).toHaveBeenLastCalledWith(view.result.resultId, 0, 5000, [xAxis, yAxis])
    expect(plot(`${test.graph}-individual-svg`)).toMatchObject({ xLabel, yLabel,
      points: [{ id: 'r1', rowId: 'r1', x: xAxis * 10, y: yAxis * 10, selected: true },
        { id: 'r2', rowId: 'r2', x: xAxis * -10, y: yAxis * -10, selected: false }] })
  }
  expectAxes(first, second, 1, 2)
  await chooseAxis(x, first, second)
  await waitFor(() => expectAxes(second, first, 2, 1))
  // No Y interaction: restoring X must reveal the original stored Y choice.
  await chooseAxis(x, second, first, 2)
  await waitFor(() => expectAxes(first, second, 1, 2))
  expect(view.fetch.mock.calls.map(call => call[3])).toEqual([[1, 2], [2, 1], [1, 2]])
  expect(axes(view.panel, test.name)).toEqual([x, y]); expect([x.id, y.id]).toEqual(ids)
  expect(view.dispatch).not.toHaveBeenCalled()
  expect(view.local.getState().selection.selectedRowIds).toEqual(['r1'])
  expect(view.run).toHaveBeenCalledTimes(1)
  expect(view.result).toEqual(view.original)
})
it.each(correspondenceCases)('$name keeps its named X INPUT and omits Y for rank one', async test => {
  const view = await runCorrespondence(test, 1)
  const [x] = axes(view.panel, test.name, false)
  expect(within(view.panel).getAllByRole('combobox')).toEqual([x])
  expect(within(view.panel).queryByText('Y軸', { exact: true })).not.toBeInTheDocument()
  expectValue(x, '第1軸 (50.0%)')
  await chooseAxis(x, '第1軸 (50.0%)', '第1軸 (50.0%)', 0)
  expect(view.fetch.mock.calls.map(call => call[3])).toEqual([[1]])
  expect(plot(`${test.graph}-individual-svg`)).toMatchObject({ oneDimensional: true })
  expect(view.dispatch).not.toHaveBeenCalled()
  expect(view.local.getState().selection.selectedRowIds).toEqual(['r1'])
  expect(view.run).toHaveBeenCalledTimes(1)
  expect(view.result).toEqual(view.original)
})
async function runEfa(nFactors: number, hasScores: boolean) {
  const result = efaResult(nFactors, hasScores), original = structuredClone(result)
  const run = vi.spyOn(efa, 'runEFA').mockResolvedValue(result)
  const fetch = vi.spyOn(efa, 'fetchAllEFARows').mockResolvedValue([
    { rowId: 'r1', scores: [11, 22] }, { rowId: 'r2', scores: [-11, -22] }])
  const view = mount(<FactorAnalysisPage />)
  chooseItems('項目（必須・3つ以上）', nFactors === 1 ? ['n1', 'n2', 'n3'] : ['n1', 'n2', 'n3', 'n4', 'n5'])
  if (hasScores) {
    const methods = view.getByText('分析方法・詳細設定', { selector: '.analysis-settings-title' }).closest('details')!
    fireEvent.click(methods.querySelector('summary')!)
    await chooseAxis(within(methods).getByRole('combobox', { name: '得点', exact: true }), 'なし', 'regression')
  }
  fireEvent.click(view.getByRole('button', { name: /^実\s*行$/ }))
  const identity = await view.findByText(`結果: ${result.resultId}`, { exact: true })
  fireEvent.click(view.getByRole('tab', { name: '得点操作' }))
  const panel = view.getByRole('tabpanel', { name: '得点操作' })
  view.dispatch.mockClear()
  return { ...view, panel, identity, result, original, run, fetch }
}
it('EFA names real axis INPUTs and preserves independent one-based same-factor choices', async () => {
  const view = await runEfa(2, true)
  const [x, y] = axes(view.panel, 'EFA'), ids = [x.id, y.id]
  const expectPlot = (xLabel: string, yLabel: string, xValue: number, yValue: number) => {
    expect(plot('efa-score-figure')).toMatchObject({ xLabel, yLabel,
      points: [{ rowId: 'r1', x: xValue, y: yValue, selected: true },
        { rowId: 'r2', x: -xValue, y: -yValue, selected: false }] })
  }
  expectPlot('F1', 'F2', 11, 22)
  await chooseAxis(x, 'F1', 'F2')
  expectValue(x, 'F2'); expectValue(y, 'F2'); expectPlot('F2', 'F2', 22, 22)
  await chooseAxis(y, 'F2', 'F1')
  expectValue(x, 'F2'); expectValue(y, 'F1'); expectPlot('F2', 'F1', 22, 11)
  await chooseAxis(x, 'F2', 'F1')
  expectPlot('F1', 'F1', 11, 11)
  expect(axes(view.panel, 'EFA')).toEqual([x, y]); expect([x.id, y.id]).toEqual(ids)
  const host = view.getByTestId('graph-host-factor-analysis/scores')
  expect(host).not.toContainElement(x); expect(host).not.toContainElement(y)
  expect(view.identity).toHaveTextContent('結果: efa-axis-result')
  expect(view.fetch.mock.calls).toEqual([['efa-axis-result']])
  expect(view.run).toHaveBeenCalledTimes(1)
  expect(view.dispatch).not.toHaveBeenCalled()
  expect(view.local.getState().selection.selectedRowIds).toEqual(['r1'])
  expect(view.result).toEqual(view.original)
  expect(api.post).not.toHaveBeenCalled()
})
it('EFA names both one-factor INPUTs without requiring score capability', async () => {
  const view = await runEfa(1, false)
  const [x, y] = axes(view.panel, 'EFA')
  expectValue(x, 'F1'); expectValue(y, 'F1')
  await chooseAxis(x, 'F1', 'F1', 0)
  await chooseAxis(y, 'F1', 'F1', 0)
  expectValue(x, 'F1'); expectValue(y, 'F1')
  expect(view.queryByTestId('efa-score-figure')).not.toBeInTheDocument()
  expect(view.fetch).not.toHaveBeenCalled()
  expect(view.run).toHaveBeenCalledTimes(1)
  expect(view.run.mock.calls[0][0]).toMatchObject({ nFactors: 1, scoreMethod: 'none' })
  expect(view.identity).toHaveTextContent('結果: efa-axis-result')
  expect(view.dispatch).not.toHaveBeenCalled()
  expect(view.local.getState().selection.selectedRowIds).toEqual(['r1'])
  expect(view.result).toEqual(view.original)
})
