import { getInstanceByDom } from 'echarts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import LogisticRegressionPage, { type LogisticResponse } from '../src/features/models/LogisticRegressionPage'

// Exercise the real page, cutoff, confusion table and ECharts tooltip data.
// Picker mechanics are independently covered by classificationSetup.test.tsx.
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
// Same grouped-binomial population as backend/tests/api/test_logistic_class_identity.py
// and the reviewed native observation: x=0 has 1/4 high; x=1 has 3/4 high.
// The independent oracle is beta=(-ln(3), ln(9)), p=.25/.75. Reversal
// complements actual and probability, while analysis classes remain [1.0,2.0].
function ordinalResult(reversed = false): LogisticResponse {
  const actual = reversed ? [1, 1, 1, 0, 1, 0, 0, 0] : [0, 0, 0, 1, 0, 1, 1, 1]
  const probability = reversed ? [0.75, 0.25] : [0.25, 0.75]
  const coefficient = reversed ? -2.1972130880641494 : 2.1972130880641494
  const logCiLower = reversed ? -5.397875088647872 : -1.0034489125195734
  const logCiUpper = reversed ? 1.0034489125195734 : 5.397875088647872
  const low = [{ rawValue: '10', code: '10', label: '低' }]
  const high = [{ rawValue: '20', code: '20', label: '高' }]
  return {
    target: 'answer', targetDtype: 'Int64', classes: ['1.0', '2.0'], classCategories: reversed ? [high, low] : [low, high],
    features: ['x'], excludedRowCount: 0, diagnostics: { completeSeparation: false, inferenceStatus: 'available' },
    coefficients: [{ name: 'x', coefficient, stdError: 1.6329908166243483, zValue: reversed ? -1.3455 : 1.3455,
      pValue: 0.178459, oddsRatio: Math.exp(coefficient), ciLower: Math.exp(logCiLower), ciUpper: Math.exp(logCiUpper),
      logOddsRatio: coefficient, logCiLower, logCiUpper, inferenceStatus: 'available', inferenceReason: null }],
    fitMetrics: { logLikelihood: -4.4987, nullLogLikelihood: -5.5452, aic: 12.9974, bic: 13.1562, pseudoR2: 0.1887, converged: true },
    confusionMatrix: { tn: 3, fp: 1, fn: 1, tp: 3, accuracy: 0.75, precision: 0.75, recall: 0.75, f1Score: 0.75,
      tnRowIds: reversed ? ['r6', 'r7', 'r8'] : ['r1', 'r2', 'r3'], fpRowIds: reversed ? ['r4'] : ['r5'],
      fnRowIds: reversed ? ['r5'] : ['r4'], tpRowIds: reversed ? ['r1', 'r2', 'r3'] : ['r6', 'r7', 'r8'] },
    samples: rowIds.map((rowId, index) => {
      const x = index < 4 ? 0 : 1
      const predictedProb = probability[x]
      const predictedClass = x === 0 ? (reversed ? 1 : 0) : (reversed ? 0 : 1)
      return { rowId, featureValues: { x }, actual: actual[index], predictedProb, predictedClass,
        residual: actual[index] - predictedProb, isMisclassified: actual[index] !== predictedClass }
    }),
    curves: { x: [{ x: 0, probability: probability[0] }, { x: 1, probability: probability[1] }] }, evidenceClass: 'JAR-INITIAL',
  }
}

async function fit(result: LogisticResponse) {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  const base = store.getState()
  const state: any = { ...base,
    pcp: { ...base.pcp, brushOperation: 'replace' },
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: rowIds, activeRowIds: rowIds, selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables, activeEntities: ['x', 'answer', 'otherAnswer'].map(columnId => ({ kind: 'column', columnId })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false, columns: [
      { name: 'x', columnId: 'x', label: 'x', role: 'attribute', scaleType: 'ratio', multiResponseGroup: null },
      { name: 'answer', columnId: 'answer', label: 'answer', role: 'question', scaleType: 'ordinal', multiResponseGroup: null,
        categoryOrder: ['10', '20'], valueLabels: { '10': '現在の別ラベルA', '20': '現在の別ラベルB' } },
      { name: 'otherAnswer', columnId: 'otherAnswer', label: 'otherAnswer', role: 'question', scaleType: 'nominal', multiResponseGroup: null },
    ] },
  }
  const local = configureStore({ reducer: (current = state) => current, middleware: get => get({ serializableCheck: false }) })
  vi.spyOn(store, 'getState').mockImplementation(() => local.getState())
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><LogisticRegressionPage /></Provider></ConfigProvider>)
  fireEvent.change(screen.getByTestId('logistic-target-select'), { target: { value: 'answer' } })
  fireEvent.change(screen.getByTestId('logistic-features-select'), { target: { value: 'x' } })
  fireEvent.click(screen.getByTestId('run-logistic-btn'))
  const mapping = await screen.findByRole('group', { name: '表示中のモデルのクラス' })
  const chart = getInstanceByDom(screen.getByTestId('logistic-sigmoid-svg'))!
  const chartPoints = () => (chart.getOption().series as any[]).find(series => series.id === 'model-points').data
  const tooltip = (rowId: string) => {
    const data = chartPoints().find((point: any) => point.rowId === rowId)
    return (chart.getOption().tooltip as any[])[0].formatter({ data }) as string
  }
  return { ...view, mapping, chart, chartPoints, tooltip, post, dispatch }
}

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each([false, true])('discloses fitted ordinal identity with reversed=%s across mapping, confusion headings and tooltip', async reversed => {
  const { mapping, chart, tooltip, post, dispatch } = await fit(ordinalResult(reversed))
  const zero = reversed ? '0: 20（高）' : '0: 10（低）'
  const one = reversed ? '1: 10（低）' : '1: 20（高）'
  expect(mapping).toHaveTextContent(`クラス ${zero}`)
  expect(mapping).toHaveTextContent(`クラス ${one}`)
  expect(mapping).not.toHaveTextContent('1.0')
  expect(mapping).not.toHaveTextContent('2.0')
  expect(mapping).not.toHaveTextContent('現在の別ラベル')
  expect(screen.getByRole('columnheader', { name: `予測: ${zero}` })).toBeVisible()
  expect(screen.getByRole('columnheader', { name: `予測: ${one}` })).toBeVisible()
  expect(screen.getByText(`実測: ${zero}`)).toBeVisible()
  expect(screen.getByText(`実測: ${one}`)).toBeVisible()
  expect(screen.getByText(`予測確率の対象: answer のクラス ${one}`)).toBeVisible()
  expect(screen.getByText(/オッズ比の対象:/)).toHaveTextContent(`オッズ比の対象: answer のクラス ${one}`)
  expect(screen.getByText(/オッズ比の対象:/)).toHaveTextContent('他の説明変数を一定にして、説明変数が解析上の尺度（例: 順序尺度のスコア）で1単位増えたときの、オッズ P(クラス1) / P(クラス0) の倍率')
  expect((chart.getOption().yAxis as any[])[0].name).toBe('P(Y = 1 | X)')
  expect(tooltip('r1')).toContain(`Actual: ${reversed ? '1: 10（低）' : '0: 10（低）'}`)
  expect(tooltip('r1')).toContain(`Prob (class 1): ${reversed ? 0.75 : 0.25}`)
  expect(tooltip('r6')).toContain(`Actual: ${reversed ? '0: 20（高）' : '1: 20（高）'}`)
  for (const [cell, count] of [['tn', 3], ['fp', 1], ['fn', 1], ['tp', 3]] as const) {
    expect(within(screen.getByTestId(`cm-${cell}-cell`)).getByRole('heading')).toHaveTextContent(String(count))
  }
  fireEvent.click(screen.getByTestId('cm-tp-cell'))
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({
    rowIds: reversed ? ['r1', 'r2', 'r3'] : ['r6', 'r7', 'r8'], operation: 'replace',
  }) }))
  expect(post).toHaveBeenCalledTimes(1)
  expect(post).toHaveBeenCalledWith('/models/logistic', {
    datasetId: 'd', targetColumn: 'answer', featureColumns: ['x'], activeRowIds: rowIds,
    expectedDataRevision: 3, expectedSchemaRevision: 2, intercept: true, regularization: 'none', cValue: 1, cutoff: 0.5,
  })
})

it('retains the raw codes when class labels are duplicated', async () => {
  const result = ordinalResult()
  result.classCategories = [[{ rawValue: '10', code: '10', label: '同じ' }], [{ rawValue: '20', code: '20', label: '同じ' }]]
  const { mapping, tooltip } = await fit(result)
  expect(mapping).toHaveTextContent('クラス 0: 10（同じ）')
  expect(mapping).toHaveTextContent('クラス 1: 20（同じ）')
  expect(screen.getByRole('columnheader', { name: '予測: 1: 20（同じ）' })).toBeVisible()
  expect(tooltip('r1')).toContain('Actual: 0: 10（同じ）')
  expect(tooltip('r6')).toContain('Actual: 1: 20（同じ）')
})

it.each([
  { dtype: 'Int64', raw: ['9007199254740992', '9007199254740993'], codes: ['9007199254740992', '9007199254740993'], shown: ['9007199254740992', '9007199254740993'] },
  { dtype: 'Float64', raw: ['1.0', '2.0'], codes: ['1', '2'], shown: ['1.0', '2.0'] },
  { dtype: 'String', raw: ['01', '1.0'], codes: ['01', '1.0'], shown: ['"01"', '"1.0"'] },
])('shows exact stored $dtype raw values when labels fall back to lookup codes', async ({ dtype, raw, codes, shown }) => {
  const result = ordinalResult()
  result.targetDtype = dtype
  result.classes = raw
  result.classCategories = [[{ rawValue: raw[0], code: codes[0], label: codes[0] }], [{ rawValue: raw[1], code: codes[1], label: codes[1] }]]
  const { mapping, tooltip } = await fit(result)
  expect(mapping).toHaveTextContent(`クラス 0: ${shown[0]}`)
  expect(mapping).toHaveTextContent(`クラス 1: ${shown[1]}`)
  expect(screen.getByRole('columnheader', { name: `予測: 1: ${shown[1]}` })).toBeVisible()
  expect(tooltip('r1')).toContain(`Actual: 0: ${shown[0]}\n`)
  expect(tooltip('r6')).toContain(`Actual: 1: ${shown[1]}\n`)
})

it('lists every fitted source category for a multi-code class with wrapping outside the short probability axis', async () => {
  const result = ordinalResult()
  result.classes = ['0', '1']
  result.classCategories = [
    [{ rawValue: '10', code: '10', label: '非選択' }, { rawValue: '11', code: '11', label: '11' }],
    [{ rawValue: '20', code: '20', label: '選択された長いカテゴリー名' }, { rawValue: '21', code: '21', label: '選択された長いカテゴリー名' }],
  ]
  const { mapping, chart, tooltip } = await fit(result)
  const event = '1: 20（選択された長いカテゴリー名）、21（選択された長いカテゴリー名）'
  expect(mapping).toHaveTextContent('クラス 0: 10（非選択）、11')
  expect(mapping).toHaveTextContent(`クラス ${event}`)
  expect(mapping).toHaveStyle({ overflowWrap: 'anywhere' })
  const header = screen.getByRole('columnheader', { name: `予測: ${event}` })
  expect(header.closest('table')).toHaveStyle({ tableLayout: 'fixed', overflowWrap: 'anywhere' })
  expect(screen.getByText(`実測: ${event}`)).toBeVisible()
  expect(screen.getByText(`予測確率の対象: answer のクラス ${event}`)).toHaveStyle({ overflowWrap: 'anywhere' })
  expect(screen.getByText(/オッズ比の対象:/)).toHaveTextContent(event)
  expect(tooltip('r6')).toContain(`Actual: ${event}`)
  expect((chart.getOption().yAxis as any[])[0].name).toBe('P(Y = 1 | X)')
})

it('keeps event identity and fitted values when cutoff crosses an equality boundary without another fit', async () => {
  const { mapping, chart, tooltip, post, dispatch } = await fit(ordinalResult())
  const beforeTooltip = tooltip('r6')
  const coefficients = screen.getByTestId('coefficients-table').textContent
  const slider = screen.getByRole('slider', { name: '表示中の結果の分類閾値' })
  act(() => { slider.focus() })
  // rc-slider PageUp advances two steps; retain its real keyboard behavior.
  for (let index = 0; index < 12; index++) fireEvent.keyDown(slider, { key: 'PageUp', keyCode: 33 })
  fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
  expect(slider).toHaveAttribute('aria-valuenow', '0.75')
  expect(within(screen.getByTestId('cm-tp-cell')).getByRole('heading')).toHaveTextContent('3')
  expect(screen.getByText(/予測確率 ≥ Cutoff/)).toHaveTextContent('Cutoff（0.75）なら1、それ未満なら0')
  fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 })
  expect(slider).toHaveAttribute('aria-valuenow', '0.76')
  expect(within(screen.getByTestId('cm-tp-cell')).getByRole('heading')).toHaveTextContent('0')
  expect(within(screen.getByTestId('cm-fn-cell')).getByRole('heading')).toHaveTextContent('4')
  expect(screen.getByText(/予測確率 ≥ Cutoff/)).toHaveTextContent('Cutoff（0.76）なら1、それ未満なら0')
  expect(mapping).toHaveTextContent('クラス 1: 20（高）')
  expect(tooltip('r6')).toBe(beforeTooltip)
  expect(screen.getByTestId('coefficients-table').textContent).toBe(coefficients)
  const curve = (chart.getOption().series as any[]).find(series => series.type === 'line')
  expect(curve.data).toEqual([[0, 0.25], [1, 0.75]])
  expect(curve.markLine.data[0].yAxis).toBe(0.76)
  expect(screen.queryByText(/表示中の結果は前回実行分/)).toBeNull()
  fireEvent.click(screen.getByTestId('cm-fn-cell'))
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({
    rowIds: ['r4', 'r6', 'r7', 'r8'], operation: 'replace',
  }) }))
  fireEvent.change(screen.getByTestId('logistic-target-select'), { target: { value: 'otherAnswer' } })
  expect(screen.getByText(/表示中の結果は前回実行分/)).toBeVisible()
  expect(mapping).toHaveTextContent('目的変数 answer のクラス（学習時）')
  expect(mapping).not.toHaveTextContent('otherAnswer')
  expect(screen.getByText('予測確率の対象: answer のクラス 1: 20（高）')).toBeVisible()
  expect(screen.getByText(/オッズ比の対象:/)).toHaveTextContent('オッズ比の対象: answer のクラス 1: 20（高）')
  expect(post).toHaveBeenCalledTimes(1)
})
