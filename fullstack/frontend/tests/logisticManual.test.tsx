import { getInstanceByDom } from 'echarts'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import LogisticRegressionPage from '../src/features/models/LogisticRegressionPage'

vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select data-testid={props['data-testid']}
  multiple={props.mode === 'multiple'} value={props.value} onChange={event => props.onChange(props.mode === 'multiple'
    ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd([{ columnId: 'A' }, { columnId: 'B' }])}>MA候補追加</button> }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('Logistic must not load raw columns') } }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef', selectionColor: '#123456' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, selectedRowIds: ['r2'] },
    globalObservations: { ...base.globalObservations, activeRowIds: [] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'score' }, { kind: 'ma', groupId: 'g' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false,
      columns: ['score', 'A', 'B'].map(name => ({ columnId: name, name, role: 'question',
        scaleType: name === 'score' ? 'ratio' : 'nominal', multiResponseGroup: name === 'score' ? null : 'g' })),
      multiResponseGroups: [{ groupId: 'g', label: 'サービス' }] } }
  const local = configureStore({ reducer: (s = state, action: any) => action.type === 'test/scope'
    ? { ...s, globalObservations: { ...s.globalObservations, activeRowIds: action.payload } } : s,
    middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<Provider store={local}><LogisticRegressionPage /></Provider>)
  return { local, view, dispatch }
}

it('requires explicit MA choices, excludes same-parent features and preserves empty inputs', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('対象行0件'))
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as any)
  vi.spyOn(message, 'warning').mockImplementation(() => (() => {}) as any)
  const { view } = setup()
  const target = view.getByTestId('logistic-target-select')
  const features = view.getByTestId('logistic-features-select')
  expect(target.textContent).not.toContain('A')
  expect(post).not.toHaveBeenCalled()
  fireEvent.click(view.getByText('MA候補追加'))
  fireEvent.change(target, { target: { value: 'A' } })
  expect(features.textContent).toBe('score')
  fireEvent.change(features, { target: { value: 'score' } })
  fireEvent.click(view.getByTestId('run-logistic-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/logistic', expect.objectContaining({
    targetColumn: 'A', featureColumns: ['score'], activeRowIds: [], expectedSchemaRevision: 2, expectedDataRevision: 3,
  })))
  await waitFor(() => expect(message.error).toHaveBeenCalled())
  fireEvent.change(features, { target: { value: '' } })
  fireEvent.click(view.getByTestId('run-logistic-btn'))
  expect(post).toHaveBeenCalledTimes(1)
})

it('discards responses after scope changes and unmount', async () => {
  let finish!: (value: any) => void
  const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const success = vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  const { view, local } = setup()
  fireEvent.click(view.getByText('MA候補追加'))
  fireEvent.change(view.getByTestId('logistic-target-select'), { target: { value: 'A' } })
  fireEvent.change(view.getByTestId('logistic-features-select'), { target: { value: 'score' } })
  fireEvent.click(view.getByTestId('run-logistic-btn'))
  act(() => { local.dispatch({ type: 'test/scope', payload: ['r9'] }) })
  await act(async () => { finish({ samples: [{ rowId: 'obsolete' }] }) })
  expect(success).not.toHaveBeenCalled()
  expect(view.queryByTestId('coefficients-table')).toBeNull()
  fireEvent.click(view.getByTestId('run-logistic-btn'))
  expect(post).toHaveBeenLastCalledWith('/models/logistic', expect.objectContaining({ activeRowIds: ['r9'] }))
  view.unmount()
  await act(async () => { finish({ samples: [{ rowId: 'after-unmount' }] }) })
  expect(success).not.toHaveBeenCalled()
})

it.each([0.5, 1, 2])('selects points and rectangles at display scale %s', async scale => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'post').mockResolvedValue({ target: 'A', classes: ['0', '1'], features: ['score'], excludedRowCount: 0,
    diagnostics: { completeSeparation: false }, coefficients: [], curves: {},
    fitMetrics: { logLikelihood: -1, nullLogLikelihood: -2, aic: 4, bic: 4, pseudoR2: 0.5, converged: true },
    samples: [0, 1, 2].map(index => ({ rowId: `r${index + 1}`, actual: index % 2, predictedProb: index % 2 ? 0.9 : 0.1,
      featureValues: { score: index }, predictedClass: index % 2, residual: 0, isMisclassified: false })) } as any)
  const { view, dispatch } = setup()
  fireEvent.click(view.getByText('MA候補追加'))
  fireEvent.change(view.getByTestId('logistic-target-select'), { target: { value: 'A' } })
  fireEvent.change(view.getByTestId('logistic-features-select'), { target: { value: 'score' } })
  fireEvent.click(view.getByTestId('run-logistic-btn'))
  const element = await view.findByTestId('logistic-sigmoid-svg')
  const chart = getInstanceByDom(element)!
  chart.resize({width:480,height:280})
  const svg = element.closest<HTMLElement>('[data-chart-host="echarts"]')!.parentElement!
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 480 * scale, height: 280 * scale } as DOMRect)
  const capture = vi.fn()
  Object.defineProperty(svg, 'setPointerCapture', { value: capture, configurable: true })
  const series = (chart.getOption().series as any[]).find(s => s.id === 'model-points')
  const middle = series.data[1]
  expect(middle.itemStyle.color).toBe('#abcdef')
  expect(middle.itemStyle.borderColor).toBe('#123456')
  expect(middle.symbolSize).toBe(14)
  const [x,y] = chart.convertToPixel({gridIndex:0}, middle.value) as number[]
  const point = (x: number, y: number) => ({ clientX: 10 + x * scale, clientY: 20 + y * scale, button: 0 })
  fireEvent.pointerDown(svg, point(x, y))
  fireEvent.pointerUp(svg, point(x, y))
  expect(capture).toHaveBeenCalled()
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: ['r2'], operation: 'toggle' }) }))
  fireEvent.pointerDown(svg, point(x - 20, y - 15))
  // Pointer-up position is authoritative even when no move event was delivered.
  fireEvent.pointerUp(svg, point(x + 20, y + 15))
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: ['r2'], operation: 'replace' }) }))
  fireEvent.pointerDown(svg, point(100, 100))
  fireEvent.pointerUp(svg, point(150, 160))
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: [], operation: 'replace' }) }))
  dispatch.mockClear()
  fireEvent.pointerDown(svg, point(x, y))
  fireEvent.pointerCancel(svg)
  fireEvent.pointerUp(svg, point(x, y))
  expect(dispatch).not.toHaveBeenCalled()
})
