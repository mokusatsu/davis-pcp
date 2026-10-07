import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { getInstanceByDom } from 'echarts'
import { api } from '../src/api/client'
import { store } from '../src/app/store'
import LikertComparisonPage from '../src/features/distribution/LikertComparisonPage'
import captured from './fixtures/likertAuditApi.json'
import weightControls from './fixtures/likertAuditWeightControls.json'

// The API fixture is captured from native HTTP on the unchanged audit source.
// React controls and SVG ECharts are real; only HTTP and Arrow loading are stubbed.
const raw = vi.hoisted(() => ({ value: null as any }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => raw.value }))
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); raw.value = null })

function mount(names: string[], definitions: any[] = captured.codebook.columns) {
  const base = store.getState()
  const rowIds = captured.arrow.__rowId__
  raw.value = { rowIds, columns: captured.arrow }
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: captured.meta.datasetId, dataRevision: captured.meta.dataRevision, allRowIds: rowIds, activeRowIds: rowIds, selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: rowIds } },
    globalVariables: { ...base.globalVariables, datasetId: captured.meta.datasetId,
      weightColumnId: definitions.find(c => c.name === 'w')?.columnId,
      activeEntities: names.map(name => ({ kind: 'column', columnId: definitions.find(c => c.name === name)!.columnId })) },
    codebook: { ...base.codebook, datasetId: captured.meta.datasetId, schemaRevision: captured.codebook.schemaRevision, columns: definitions, isLoading: false },
  }
  const local = configureStore({ reducer: (s = state, action: any) => action.type === 'test/schema'
    ? { ...s, codebook: { ...s.codebook, schemaRevision: action.payload.revision, columns: action.payload.columns } } : s,
    middleware: getDefault => getDefault({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  render(<Provider store={local}><MemoryRouter><LikertComparisonPage /></MemoryRouter></Provider>)
  return { local, dispatch }
}
function reply(response: any = captured.summary) {
  return vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => path.endsWith('/column-matches')
    ? copy(captured.reverseCodeMatches[body.code as keyof typeof captured.reverseCodeMatches]) as any : copy(response))
}
function card(name: string) {
  const title = screen.getByText(new RegExp(`^${name}（n=`))
  return title.closest('.ant-card')! as HTMLElement
}
function chart() { return getInstanceByDom(screen.getByTestId('likert-echart'))! }
function chartOrder(): string[] { return (chart().getOption().yAxis as any[])[0].data }
function intervals(name: string): number[][] {
  const index = chartOrder().indexOf(name)
  return ((chart().getOption().series as any[])[0].data as number[][]).filter(row => row[2] === index).map(row => row.slice(0, 2))
}
function widths(name: string) { return intervals(name).map(([start, end]) => end - start) }
function chooseBasis(label: '加重' | '非加重') { fireEvent.click(within(screen.getByTestId('likert-basis')).getByRole('radio', { name: label, exact: true })) }
function chooseSort(label: string) { fireEvent.click(within(screen.getByTestId('likert-sort')).getByText(label)) }

it('keeps captured weighted bars, cards and both actual sort controls on one basis', async () => {
  const post = reply()
  mount(['Q_A', 'Q_B'])
  await screen.findByTestId('likert-echart')
  expect(chartOrder()).toEqual(['Q_B', 'Q_A'])
  expect(card('Q_A')).toHaveTextContent('Top-2: 40.0%')
  expect(card('Q_A')).toHaveTextContent('平均2.60')
  chooseBasis('加重')
  await waitFor(() => expect(chartOrder()).toEqual(['Q_A', 'Q_B']))
  // Independent arithmetic: (1+1+1+10+10)=23, top mass20/3 and score totals103/35.
  expect(widths('Q_A')[4]).toBeCloseTo(20 / 23 * 100, 4)
  expect(widths('Q_B')[4]).toBeCloseTo(3 / 23 * 100, 4)
  expect(card('Q_A')).toHaveTextContent(`Top-2: ${(20 / 23 * 100).toFixed(1)}%`)
  expect(card('Q_A')).toHaveTextContent(`平均${(103 / 23).toFixed(2)}`)
  expect(card('Q_B')).toHaveTextContent(`Top-2: ${(3 / 23 * 100).toFixed(1)}%`)
  expect(card('Q_B')).toHaveTextContent(`平均${(35 / 23).toFixed(2)}`)
  expect(screen.getByText('Q_A（n=5）')).toBeInTheDocument()
  expect(screen.getByTestId('likert-weight-meta')).toHaveTextContent('非加重n=5 / 加重Σw=23')
  chooseSort('平均降順')
  expect(chartOrder()).toEqual(['Q_A', 'Q_B'])
  chooseBasis('非加重')
  await waitFor(() => expect(chartOrder()).toEqual(['Q_B', 'Q_A']))
  expect(widths('Q_A')).toEqual([60, 0, 0, 0, 40])
  chooseSort('元順')
  expect(chartOrder()).toEqual(['Q_A', 'Q_B'])
  chooseSort('Top-2降順')
  expect(chartOrder()).toEqual(['Q_B', 'Q_A'])
  expect(post).toHaveBeenCalledTimes(1)
})

it('displays reversed API order once in both modes and selects original raw codes', async () => {
  const post = reply()
  const { dispatch } = mount(['Q_reverse'])
  await screen.findByTestId('likert-echart')
  const codes = () => [...card('Q_reverse').querySelectorAll('[data-testid^="likert-seg-"]')].map(element => element.getAttribute('data-testid')!.split('-').at(-1))
  expect(codes()).toEqual(['5', '4', '3', '2', '1'])
  expect(widths('Q_reverse')).toEqual([40, 0, 0, 0, 60])
  expect(card('Q_reverse')).toHaveTextContent('Top-2: 60.0%')
  fireEvent.click(within(screen.getByTestId('likert-mode')).getByText('発散型'))
  expect(codes()).toEqual(['5', '4', '3', '2', '1'])
  expect(intervals('Q_reverse')).toEqual([[-40, 0], [0, 0], [0, 0], [0, 0], [0, 60]])
  fireEvent.click(screen.getByTestId('likert-seg-Q_reverse-1'))
  const reverse = captured.codebook.columns.find(c => c.name === 'Q_reverse')!
  await waitFor(() => expect(post).toHaveBeenCalledWith(`/datasets/${captured.meta.datasetId}/column-matches`, expect.objectContaining({ columnId: reverse.columnId, code: '1', rowIds: captured.arrow.__rowId__ })))
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'selection/selectionApplied', payload: expect.objectContaining({ rowIds: captured.arrow.__rowId__.slice(0, 3) }) })))
})

it.each(['sevenfold', 'tiny', 'overflow'] as const)('keeps real API %s weight-scale results and available ratios on weighted controls', async name => {
  reply(weightControls[name].response)
  mount(['Q_A', 'Q_B'])
  await screen.findByTestId('likert-echart')
  chooseBasis('加重')
  await waitFor(() => expect(chartOrder()).toEqual(['Q_A', 'Q_B']))
  expect(widths('Q_A')[4]).toBeCloseTo(20 / 23 * 100, 4)
  expect(widths('Q_B')[4]).toBeCloseTo(3 / 23 * 100, 4)
  expect(card('Q_A')).toHaveTextContent('Top-2: 87.0%')
  expect(card('Q_A')).toHaveTextContent('平均4.48')
  chooseSort('平均降順')
  expect(chartOrder()).toEqual(['Q_A', 'Q_B'])
  if (name === 'overflow') {
    expect(screen.getByTestId('likert-weight-meta')).toHaveTextContent('加重Σw=範囲外')
    expect(screen.getByTestId('likert-seg-Q_A-5')).toHaveTextContent('高: 範囲外 (87.0%)')
  }
})

it('transports the real no-positive-weight response as unavailable percentages and means', async () => {
  reply(weightControls.noPositive.response)
  mount(['Q_A', 'Q_B'])
  await screen.findByTestId('likert-echart')
  chooseBasis('加重')
  await waitFor(() => expect(card('Q_A')).toHaveTextContent('Top-2: —'))
  expect(card('Q_A')).toHaveTextContent('平均—')
  expect(card('Q_A')).not.toHaveTextContent('0.0%')
  expect(screen.getByTestId('likert-seg-Q_A-1')).toHaveTextContent('低: 0 (—)')
  expect(chartOrder()).toEqual(['Q_A', 'Q_B'])
  chooseSort('平均降順')
  expect(chartOrder()).toEqual(['Q_A', 'Q_B'])
  chooseBasis('非加重')
  expect(card('Q_A')).toHaveTextContent('Top-2: 40.0%')
  expect(card('Q_A')).toHaveTextContent('平均2.60')
})

function synthetic(name: string, codes: string[], percentages: Array<number | null>, mean: number | null, reversed = false) {
  const source = captured.codebook.columns.find(c => c.name === 'Q_A')!
  const definition = { ...source, name, label: name, columnId: name, categoryOrder: [...codes].sort(), isReversed: reversed }
  const data = { denominators: { total: 100, target: 100, valid: 100, missing: 0, notApplicable: 0 },
    distribution: codes.map((code, index) => ({ code, label: code, count: index ? 0 : 100, percentageValid: index ? 0 : 100 })),
    auxiliaryStats: { mean: 1, top2Box: { pct: 0, n: 0 } },
    weighted: { weightedN: 100, weightedMean: mean, distribution: codes.map((code, index) => ({ code, weightedCount: percentages[index], weightedPct: percentages[index] })) },
  }
  return { definition, data }
}

it('uses the final two result categories for seven levels and preserves four-level reverse controls', async () => {
  const seven = synthetic('Q7', ['1', '2', '3', '4', '5', '6', '7'], [10, 10, 10, 10, 20, 20, 20], 4.6)
  const four = synthetic('Q4', ['4', '3', '2', '1'], [0, 10, 20, 70], 3.6, true)
  reply({ ...captured.summary, columns: { Q7: seven.data, Q4: four.data } })
  mount(['Q7', 'Q4'], [seven.definition, four.definition, captured.codebook.columns.find(c => c.name === 'w')!])
  await screen.findByTestId('likert-echart')
  chooseBasis('加重')
  await waitFor(() => expect(chartOrder()).toEqual(['Q4', 'Q7']))
  expect(card('Q7')).toHaveTextContent('Top-2: 40.0%')
  expect(widths('Q7').slice(4)).toEqual([20, 20, 20])
  expect(card('Q4')).toHaveTextContent('Top-2: 90.0%')
  expect(card('Q4')).toHaveTextContent('偶数カテゴリのため中立なし')
  expect(widths('Q4')).toEqual([0, 10, 20, 70])
  expect([...card('Q4').querySelectorAll('[data-testid^="likert-seg-"]')].map(element => element.textContent)).toEqual(['4: 0 (0.0%)', '3: 10 (10.0%)', '2: 20 (20.0%)', '1: 70 (70.0%)'])
  fireEvent.click(within(screen.getByTestId('likert-mode')).getByText('発散型'))
  expect(intervals('Q4')).toEqual([[-10, -10], [-10, 0], [0, 20], [20, 90]])
  chooseSort('平均降順')
  expect(chartOrder()).toEqual(['Q7', 'Q4'])
})

it('keeps absent and null weighted results unavailable while zero remains available and sorts first', async () => {
  const zero = synthetic('Q_zero', ['1', '2', '3', '4'], [100, 0, 0, 0], 1)
  const none = synthetic('Q_none', ['1', '2', '3', '4'], [null, null, null, null], null)
  const absent = synthetic('Q_absent', ['1', '2', '3', '4'], [100, 0, 0, 0], 1)
  const partial = synthetic('Q_partial', ['1', '2', '3', '4'], [100, 0, 0, 0], 1)
  partial.data.weighted.distribution.pop()
  reply({ ...captured.summary, columns: { Q_none: none.data, Q_zero: zero.data, Q_absent: { ...absent.data, weighted: null }, Q_partial: partial.data } })
  mount(['Q_none', 'Q_zero', 'Q_absent', 'Q_partial'], [none.definition, zero.definition, absent.definition, partial.definition, captured.codebook.columns.find(c => c.name === 'w')!])
  await screen.findByTestId('likert-echart')
  chooseBasis('加重')
  await waitFor(() => expect(chartOrder()).toEqual(['Q_zero', 'Q_none', 'Q_absent', 'Q_partial']))
  expect(card('Q_zero')).toHaveTextContent('Top-2: 0.0%')
  expect(card('Q_zero')).toHaveTextContent('平均1.00')
  for (const name of ['Q_none', 'Q_absent']) {
    expect(card(name)).toHaveTextContent('Top-2: —')
    expect(card(name)).toHaveTextContent('平均—')
    expect(card(name)).not.toHaveTextContent('0.0%')
    expect(screen.getByTestId(`likert-seg-${name}-1`)).toHaveTextContent('1: — (—)')
    expect(intervals(name).every(([start, end]) => start === end)).toBe(true)
  }
  expect(card('Q_partial')).toHaveTextContent('Top-2: —')
  expect(card('Q_partial')).toHaveTextContent('平均1.00')
  expect(screen.getByTestId('likert-seg-Q_partial-3')).toHaveTextContent('3: 0 (0.0%)')
  expect(screen.getByTestId('likert-seg-Q_partial-4')).toHaveTextContent('4: — (—)')
  chooseSort('平均降順')
  expect(chartOrder()).toEqual(['Q_zero', 'Q_partial', 'Q_none', 'Q_absent'])
})

it('hides absent/stale results and rejects an older reverse result after a schema change', async () => {
  const resolve: Array<(response: any) => void> = []
  vi.spyOn(api, 'post').mockImplementation(() => new Promise<any>(done => resolve.push(done)))
  const { local } = mount(['Q_reverse'])
  await waitFor(() => expect(resolve).toHaveLength(1))
  expect(screen.queryByTestId('likert-echart')).toBeNull()
  const definitions = captured.codebook.columns.map(c => c.name === 'Q_reverse' ? { ...c, isReversed: false } : c)
  act(() => local.dispatch({ type: 'test/schema', payload: { revision: captured.codebook.schemaRevision + 1, columns: definitions } }))
  await waitFor(() => expect(resolve).toHaveLength(2))
  const newer = copy(captured.summary)
  newer.columns.Q_reverse = copy(captured.summary.columns.Q_A)
  await act(async () => resolve[1](newer))
  await screen.findByTestId('likert-echart')
  expect(widths('Q_reverse')).toEqual([60, 0, 0, 0, 40])
  expect(card('Q_reverse')).toHaveTextContent('Top-2: 40.0%')
  await act(async () => resolve[0](copy(captured.summary)))
  expect(widths('Q_reverse')).toEqual([60, 0, 0, 0, 40])
  expect(card('Q_reverse')).toHaveTextContent('Top-2: 40.0%')
})
