import { getInstanceByDom } from 'echarts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import DiscriminantAnalysisPage, { type DiscriminantResponse } from '../src/features/models/DiscriminantAnalysisPage'

// Real page, diagnostics, ModelScatter and ECharts options. Only the API,
// column picker and unrelated row-color/legend data are bounded here.
// These component checks do not establish browser paint or native keyboard use.
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select data-testid={props['data-testid']}
  multiple={props.mode === 'multiple'} value={props.value} onChange={event => props.onChange(props.mode === 'multiple'
    ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef', selectionColor: '#123456' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('Class identity must use the fit response') } }))

const rowIds = Array.from({ length: 8 }, (_, index) => `r${index + 1}`)

// A fixed consumer fixture: the two returned score keys reverse their raw
// meaning between fits. Numerical estimator correctness belongs to API tests.
function ordinalResult(reversed = false): DiscriminantResponse {
  const low = reversed ? '2.0' : '1.0'
  const high = reversed ? '1.0' : '2.0'
  const samples = rowIds.map((rowId, index) => {
    const actualClass = [3, 5, 6, 7].includes(index) ? high : low
    const predictedClass = index < 4 ? low : high
    return { rowId, actualClass, predictedClass, isMisclassified: actualClass !== predictedClass,
      ld1: index - 3.5, ld2: 0, posteriorProbabilities: { [low]: index < 4 ? 0.75 : 0.25, [high]: index < 4 ? 0.25 : 0.75 },
      mahalanobisDistance: 1 }
  })
  return {
    target: 'answer', targetDtype: 'Int64', classes: ['1.0', '2.0'],
    classCategories: { [low]: [{ rawValue: '10', code: '10', label: '低' }], [high]: [{ rawValue: '20', code: '20', label: '高' }] },
    features: ['x'], method: 'lda', accuracy: 0.75,
    axes: [{ axisIndex: 1, eigenvalue: 1, explainedVarianceRatio: 1, canonicalCorrelation: 0.8 }],
    loadings: [{ variable: 'x', ld1: 1 }], samples, boundaryMesh: null, decisionThreshold1D: 0,
    misclassifiedRowIds: ['r4', 'r5'], wilksLambdaOverall: 0.2, pOverall: 0.01, excludedRowCount: 1, evidenceClass: 'JAR-INITIAL',
    diagnostics: { inputDimensions: 1, usedDimensions: 1, sampleCount: 8, classCounts: { '1.0': 4, '2.0': 4 },
      totalRank: 1, withinClassRank: 1, collinear: false, singularWithinClassCovariance: false, qdaSmallClasses: [] },
  }
}

function rekey(result: DiscriminantResponse, keys: [string, string]): DiscriminantResponse {
  const oldKeys = result.classes
  const key = (old: string) => keys[oldKeys.indexOf(old)]
  return { ...result, classes: keys,
    classCategories: Object.fromEntries(oldKeys.map((old, index) => [keys[index], result.classCategories[old]])),
    diagnostics: { ...result.diagnostics, classCounts: Object.fromEntries(oldKeys.map((old, index) => [keys[index], result.diagnostics.classCounts[old]])) },
    samples: result.samples.map(sample => ({ ...sample, actualClass: key(sample.actualClass), predictedClass: key(sample.predictedClass),
      posteriorProbabilities: Object.fromEntries(oldKeys.map((old, index) => [keys[index], sample.posteriorProbabilities[old]])) })),
  }
}

async function fit(result: DiscriminantResponse) {
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce(result)
  const base = store.getState()
  const state: any = { ...base,
    pcp: { ...base.pcp, brushOperation: 'replace' },
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: [...rowIds, 'missing'], activeRowIds: [...rowIds, 'missing'], selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables, activeEntities: ['x', 'answer', 'otherAnswer'].map(columnId => ({ kind: 'column', columnId })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false, columns: [
      { name: 'x', columnId: 'x', label: 'x', role: 'attribute', scaleType: 'ratio', multiResponseGroup: null },
      { name: 'answer', columnId: 'answer', label: 'answer', role: 'question', scaleType: 'ordinal', multiResponseGroup: null,
        categoryOrder: ['10', '20'], valueLabels: { '10': '現在の別ラベルA', '20': '現在の別ラベルB' } },
      { name: 'otherAnswer', columnId: 'otherAnswer', label: 'otherAnswer', role: 'question', scaleType: 'nominal', multiResponseGroup: null },
    ] },
  }
  const local = configureStore({ reducer: (current = state, action: any) => action.type === 'test/reversal'
    ? { ...current, codebook: { ...current.codebook, schemaRevision: current.codebook.schemaRevision + 1,
      columns: current.codebook.columns.map((column: any) => column.name === 'answer' ? { ...column, isReversed: true } : column) } } : current,
    middleware: get => get({ serializableCheck: false }) })
  vi.spyOn(store, 'getState').mockImplementation(() => local.getState())
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><DiscriminantAnalysisPage /></Provider></ConfigProvider>)
  fireEvent.change(screen.getByTestId('discriminant-target-select'), { target: { value: 'answer' } })
  fireEvent.change(screen.getByTestId('discriminant-features-select'), { target: { value: 'x' } })
  fireEvent.click(screen.getByTestId('run-discriminant-btn'))
  const mapping = await screen.findByRole('group', { name: '表示中の判別分析のクラス' })
  const chart = () => getInstanceByDom(screen.getByTestId('discriminant-map-svg'))!
  const chartPoints = () => (chart().getOption().series as any[]).find(series => series.id === 'model-points').data
  const tooltip = (rowId: string) => {
    const data = chartPoints().find((point: any) => point.rowId === rowId)
    return (chart().getOption().tooltip as any[])[0].formatter({ data }) as string
  }
  return { ...view, mapping, chart, chartPoints, tooltip, post, local }
}

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('maps both fits around an ordinal reversal to the same raw Actual and Pred meaning', async () => {
  const { mapping, tooltip, chartPoints, post, local } = await fit(ordinalResult())
  expect(mapping).toHaveTextContent('目的変数 answer のクラス（学習時）')
  expect(mapping).toHaveTextContent('解析クラス 1.0: 10（低）')
  expect(mapping).toHaveTextContent('解析クラス 2.0: 20（高）')
  expect(screen.getByLabelText('判別分析の入力診断')).toHaveTextContent('クラス人数: 1.0: 10（低）: 4 / 2.0: 20（高）: 4')
  expect(tooltip('r1')).toContain('Actual: 1.0: 10（低）\nPred: 1.0: 10（低）')
  expect(tooltip('r4')).toContain('Actual: 2.0: 20（高）\nPred: 1.0: 10（低）')
  expect(tooltip('r5')).toContain('Actual: 1.0: 10（低）\nPred: 2.0: 20（高）')
  expect(chartPoints().map((point: any) => point.rowId)).toEqual(rowIds)
  expect(screen.getByText('欠損値を含む 1 行を除外しました。')).toBeVisible()

  post.mockResolvedValueOnce(ordinalResult(true))
  act(() => { local.dispatch({ type: 'test/reversal' }) })
  expect(screen.queryByRole('group', { name: '表示中の判別分析のクラス' })).toBeNull()
  fireEvent.click(screen.getByTestId('run-discriminant-btn'))
  const reversed = await screen.findByRole('group', { name: '表示中の判別分析のクラス' })
  expect(reversed).toHaveTextContent('解析クラス 1.0: 20（高）')
  expect(reversed).toHaveTextContent('解析クラス 2.0: 10（低）')
  expect(screen.getByLabelText('判別分析の入力診断')).toHaveTextContent('クラス人数: 1.0: 20（高）: 4 / 2.0: 10（低）: 4')
  expect(tooltip('r1')).toContain('Actual: 2.0: 10（低）\nPred: 2.0: 10（低）')
  expect(tooltip('r4')).toContain('Actual: 1.0: 20（高）\nPred: 2.0: 10（低）')
  expect(tooltip('r5')).toContain('Actual: 2.0: 10（低）\nPred: 1.0: 20（高）')
  expect(chartPoints().map((point: any) => point.rowId)).toEqual(rowIds)
  expect(reversed).not.toHaveTextContent('現在の別ラベル')
  expect(post).toHaveBeenCalledTimes(2)
  for (const [call, schemaRevision] of [[1, 2], [2, 3]]) expect(post).toHaveBeenNthCalledWith(call, '/models/discriminant', {
    datasetId: 'd', targetColumn: 'answer', featureColumns: ['x'], activeRowIds: [...rowIds, 'missing'],
    expectedDataRevision: 3, expectedSchemaRevision: schemaRevision, method: 'lda', shrinkage: 'none', priors: 'proportional', stepwiseConfig: undefined,
  })
})

it('keeps the fitted target and label snapshot when the next-run target changes', async () => {
  const { mapping, tooltip, post } = await fit(ordinalResult())
  const before = tooltip('r4')
  expect(mapping).not.toHaveTextContent('現在の別ラベル')
  fireEvent.change(screen.getByTestId('discriminant-target-select'), { target: { value: 'otherAnswer' } })
  expect(screen.getByText(/表示中の結果は前回実行分/)).toBeVisible()
  expect(mapping).toHaveTextContent('目的変数 answer のクラス（学習時）')
  expect(mapping).not.toHaveTextContent('otherAnswer')
  expect(mapping).toHaveTextContent('解析クラス 1.0: 10（低）')
  expect(tooltip('r4')).toBe(before)
  expect(post).toHaveBeenCalledTimes(1)
})

it.each([
  { dtype: 'Int64', raw: ['9007199254740992', '9007199254740993'], codes: ['9007199254740992', '9007199254740993'], shown: ['9007199254740992', '9007199254740993'] },
  { dtype: 'Float64', raw: ['1.0', '2.0'], codes: ['1', '2'], shown: ['1.0', '2.0'] },
  { dtype: 'String', raw: ['01', '1.0'], codes: ['01', '1.0'], shown: ['"01"', '"1.0"'] },
])('preserves exact $dtype raw text and distinguishes string values from numeric values', async ({ dtype, raw, codes, shown }) => {
  const result = rekey(ordinalResult(), [raw[0], raw[1]])
  result.targetDtype = dtype
  result.classCategories = Object.fromEntries(result.classes.map((key, index) => [key,
    [{ rawValue: raw[index], code: codes[index], label: codes[index] }]]))
  const { mapping, tooltip } = await fit(result)
  expect(mapping).toHaveTextContent(`解析クラス ${raw[0]}: ${shown[0]}`)
  expect(mapping).toHaveTextContent(`解析クラス ${raw[1]}: ${shown[1]}`)
  expect(tooltip('r4')).toContain(`Actual: ${raw[1]}: ${shown[1]}\nPred: ${raw[0]}: ${shown[0]}\n`)
  expect(screen.getByLabelText('判別分析の入力診断')).toHaveTextContent(`クラス人数: ${raw[0]}: ${shown[0]}: 4 / ${raw[1]}: ${shown[1]}: 4`)
})

it('retains distinct raw codes when labels duplicate across and within many-code classes', async () => {
  const result = rekey(ordinalResult(), ['0', '1'])
  const label = '同じカテゴリー名が長く続いても省略しない'
  result.classCategories = {
    '0': [{ rawValue: '10', code: '10', label }, { rawValue: '11', code: '11', label: '11' }],
    '1': [{ rawValue: '20', code: '20', label }, { rawValue: '21', code: '21', label }],
  }
  result.method = 'qda'
  result.diagnostics = { ...result.diagnostics, qdaSmallClasses: ['1'] }
  const { mapping, tooltip } = await fit(result)
  const zero = `0: 10（${label}）、11`
  const one = `1: 20（${label}）、21（${label}）`
  expect(mapping).toHaveTextContent(`解析クラス ${zero}`)
  expect(mapping).toHaveTextContent(`解析クラス ${one}`)
  expect(tooltip('r4')).toContain(`Actual: ${one}\nPred: ${zero}`)
  const diagnostics = screen.getByLabelText('判別分析の入力診断')
  expect(diagnostics).toHaveTextContent(`クラス人数: ${zero}: 4 / ${one}: 4`)
  expect(within(diagnostics).getByRole('alert')).toHaveTextContent(`対象クラス: ${one}。`)
})

it('uses explicit numeric-looking class order in the mapping, counts, QDA warnings and existing multiclass boundary legend', async () => {
  const result = ordinalResult()
  result.classes = ['10', '2', '1']
  result.classCategories = {
    '10': [{ rawValue: '100', code: '100', label: '先頭' }],
    '2': [{ rawValue: '200', code: '200', label: '中央' }],
    '1': [{ rawValue: '300', code: '300', label: '末尾' }],
  }
  result.method = 'qda'
  result.axes = [
    { axisIndex: 1, eigenvalue: 2, explainedVarianceRatio: 0.8, canonicalCorrelation: 0.8 },
    { axisIndex: 2, eigenvalue: 0.5, explainedVarianceRatio: 0.2, canonicalCorrelation: 0.4 },
  ]
  result.samples = result.samples.map((sample, index) => ({ ...sample, actualClass: result.classes[index % 3],
    predictedClass: result.classes[index % 3], isMisclassified: false, ld2: index % 3,
    posteriorProbabilities: Object.fromEntries(result.classes.map(key => [key, key === result.classes[index % 3] ? 0.8 : 0.1])) }))
  result.accuracy = 1
  result.misclassifiedRowIds = []
  result.boundaryMesh = { xRange: [-4, 4], yRange: [-1, 3], gridResolution: 2,
    classes: ['2', '1', '10'], gridClassIndices: [[0, 1], [2, 0]] }
  result.diagnostics = { ...result.diagnostics, inputDimensions: 2, usedDimensions: 2, totalRank: 2, withinClassRank: 2,
    classCounts: { '10': 3, '2': 3, '1': 2 }, qdaSmallClasses: ['1', '10'] }
  const { mapping, tooltip, chart } = await fit(result)
  const displayed = ['10: 100（先頭）', '2: 200（中央）', '1: 300（末尾）']
  expect(mapping).toHaveTextContent(`解析クラス ${displayed[0]}解析クラス ${displayed[1]}解析クラス ${displayed[2]}`)
  const diagnostics = screen.getByLabelText('判別分析の入力診断')
  expect(diagnostics).toHaveTextContent(`クラス人数: ${displayed[0]}: 3 / ${displayed[1]}: 3 / ${displayed[2]}: 2`)
  expect(within(diagnostics).getByRole('alert')).toHaveTextContent(`対象クラス: ${displayed[0]}, ${displayed[2]}。`)
  const legend = screen.getByText('背景の予測クラス:').parentElement!
  expect(displayed.map(label => within(legend).getByText(label).textContent)).toEqual(displayed)
  const labels = [...legend.querySelectorAll('div > span.ant-typography')].map(element => element.textContent)
  expect(labels.filter(label => displayed.includes(label!))).toEqual(displayed)
  for (const [index, label] of displayed.entries()) expect(within(legend).getByText(label).previousElementSibling)
    .toHaveStyle({ background: ['#1890ff', '#52c41a', '#fa8c16'][index] })
  expect(tooltip('r3')).toContain(`Actual: ${displayed[2]}\nPred: ${displayed[2]}`)
  // The mesh still indexes its own class keys; text formatting must not recolor it.
  const boundary = (chart().getOption().series as any[]).find(series => series.type === 'custom')
  expect(boundary.data).toEqual([[-4, -1, 0], [0, -1, 1], [-4, 1, 2], [0, 1, 0]])
  const cell = boundary.renderItem({}, { value: (index: number) => [-4, -1, 0][index], coord: (value: number[]) => value })
  expect(cell.style.fill).toBe('#52c41a')
})
