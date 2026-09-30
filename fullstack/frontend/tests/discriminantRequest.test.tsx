import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { store, globalObservationsSlice } from '../src/app/store'
import { GraphExpansionProvider, useGraphExpansion } from '../src/features/common/GraphExpansion'
import { useBrushOp, type BrushOperation } from '../src/features/selection/SelectionMenu'
import { api } from '../src/api/client'
import DiscriminantAnalysisPage from '../src/features/models/DiscriminantAnalysisPage'

vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select data-testid={props['data-testid']}
  multiple={props.mode === 'multiple'} value={props.value} onChange={event => props.onChange(props.mode === 'multiple'
    ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd([{ columnId: 'A' }, { columnId: 'B' }])}>MA候補追加</button> }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('Discriminant must not load raw columns') } }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef', selectionColor: '#123456' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('preserves an empty scope and ignores a late response after scope changes', async () => {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, activeRowIds: [] },
    globalVariables: { ...base.globalVariables, targetVariableId: 'y', activeEntities: [{ kind: 'column', columnId: 'x' }, { kind: 'column', columnId: 'y' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns: [
      { name: 'x', columnId: 'x', role: 'question', scaleType: 'ratio' },
      { name: 'y', columnId: 'y', role: 'attribute', scaleType: 'nominal' }] } }
  const local = configureStore({ reducer: (s = state, action: any) => action.type === 'test/scope'
    ? { ...s, globalObservations: { ...s.globalObservations, activeRowIds: action.payload } } : s,
    middleware: get => get({ serializableCheck: false }) })
  let finish!: (result: any) => void
  const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const success = vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  const view = render(<Provider store={local}><DiscriminantAnalysisPage /></Provider>)
  expect(post).not.toHaveBeenCalled()
  fireEvent.change(view.getByTestId('discriminant-target-select'), { target: { value: 'y' } })
  fireEvent.change(view.getByTestId('discriminant-features-select'), { target: { value: 'x' } })
  fireEvent.click(view.getByRole('button', { name: /判別分析.*実行|分析実行|Run/ }))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/discriminant', expect.objectContaining({
    activeRowIds: [], featureColumns: ['x'], targetColumn: 'y', expectedDataRevision: 3, expectedSchemaRevision: 2 })))
  act(() => { local.dispatch({ type: 'test/scope', payload: ['r7'] }) })
  await act(async () => { finish({ samples: [{ rowId: 'obsolete' }] }) })
  expect(success).not.toHaveBeenCalled()
  expect(view.queryByText('obsolete')).toBeNull()
})

it('admits only explicitly added MA choices and prevents same-parent leakage', async () => {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3 },
    globalObservations: { ...base.globalObservations, activeRowIds: [] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'score' }, { kind: 'ma', groupId: 'g' }] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false,
      columns: ['score', 'A', 'B'].map(name => ({ columnId: name, name, role: 'question',
        scaleType: name === 'score' ? 'ratio' : 'nominal', multiResponseGroup: name === 'score' ? null : 'g' })),
      multiResponseGroups: [{ groupId: 'g', label: 'サービス' }] } }
  const local = configureStore({ reducer: () => state, middleware: get => get({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('対象行0件'))
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as any)
  vi.spyOn(message, 'warning').mockImplementation(() => (() => {}) as any)
  const view = render(<Provider store={local}><DiscriminantAnalysisPage /></Provider>)
  const target = view.getByTestId('discriminant-target-select')
  const features = view.getByTestId('discriminant-features-select')
  expect(target.textContent).not.toContain('A')
  expect((target as HTMLSelectElement).value).toBe('')
  expect((features as HTMLSelectElement).selectedOptions).toHaveLength(0)
  fireEvent.click(view.getByText('MA候補追加'))
  fireEvent.change(target, { target: { value: 'A' } })
  expect(features.textContent).toBe('score')
  fireEvent.change(features, { target: { value: 'score' } })
  fireEvent.click(view.getByRole('button', { name: /判別分析.*実行|分析実行|Run/ }))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/models/discriminant', expect.objectContaining({
    targetColumn: 'A', featureColumns: ['score'], activeRowIds: [], expectedDataRevision: 3, expectedSchemaRevision: 2 })))
  await waitFor(() => expect(message.error).toHaveBeenCalled())
  fireEvent.change(features, { target: { value: '' } })
  fireEvent.click(view.getByRole('button', { name: /判別分析.*実行|分析実行|Run/ }))
  expect(post).toHaveBeenCalledTimes(1)
})

function FocusControls() {
  const { close, setZoom } = useGraphExpansion()
  return <><button onClick={() => setZoom(1.25)}>test zoom</button><button onClick={() => setZoom(null)}>test fit</button><button onClick={close}>test exit</button></>
}

function OperationPicker() {
  const [, setOperation] = useBrushOp()
  return <select aria-label="test operation" onChange={event => setOperation(event.target.value as BrushOperation)} defaultValue="replace">
    {['replace', 'add', 'subtract', 'toggle'].map(op => <option key={op}>{op}</option>)}
  </select>
}

it.each([0.5, 1, 2].flatMap(scale => [1, 2].map(dimensions => ({ scale, dimensions }))))('selects points and rectangles at scale $scale in $dimensions dimensions', async ({ scale, dimensions }) => {
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
  vi.spyOn(api, 'post').mockResolvedValue({ target: 'y', classes: ['0', '1'], features: ['x'], excludedRowCount: 0,
    axes: Array.from({ length: dimensions }, (_, i) => ({ axisIndex: i + 1, explainedVarianceRatio: 1 / dimensions, canonicalCorrelation: 0.8 })), loadings: [],
    misclassifiedRowIds: [], accuracy: 1, wilksLambdaOverall: 0.2, pOverall: 0.01,
    samples: [0, 1, 2].map(index => ({ rowId: `r${index + 1}`, actualClass: `${index % 2}`, predictedClass: `${index % 2}`,
      ld1: index, ld2: index - 1, mahalanobisDistance: 1, isMisclassified: false })) } as any)
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', selectedRowIds: ['r2'] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'x' }, { kind: 'column', columnId: 'y' }] },
    codebook: { ...base.codebook, datasetId: 'd', columns: [
      { name: 'x', columnId: 'x', role: 'question', scaleType: 'ratio' },
      { name: 'y', columnId: 'y', role: 'attribute', scaleType: 'nominal' }] } }
  state.globalObservations = { ...base.globalObservations, totalRowIds: ['r1', 'r2', 'r3'], activeRowIds: ['r1', 'r2', 'r3'], selectedRowIds: ['r1', 'r2'] }
  const local = configureStore({ reducer: (current = state, action: any) => ({ ...current,
    globalObservations: globalObservationsSlice.reducer(current.globalObservations, action) }), middleware: get => get({ serializableCheck: false }) })
  const view = render(<Provider store={local}><GraphExpansionProvider><FocusControls /><OperationPicker /><DiscriminantAnalysisPage /></GraphExpansionProvider></Provider>)
  fireEvent.change(view.getByTestId('discriminant-target-select'), { target: { value: 'y' } })
  fireEvent.change(view.getByTestId('discriminant-features-select'), { target: { value: 'x' } })
  fireEvent.click(view.getByRole('button', { name: /判別分析.*実行|分析実行|Run/ }))
  const svg = await view.findByTestId('discriminant-map-svg')
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 460 * scale, height: 300 * scale } as DOMRect)
  const capture = vi.fn()
  Object.defineProperty(svg, 'setPointerCapture', { value: capture, configurable: true })
  const dispatch = vi.spyOn(local, 'dispatch')
  const middle = svg.querySelectorAll('circle')[1]
  expect(middle).toHaveAttribute('fill', '#abcdef')
  expect(middle).toHaveAttribute('stroke', '#123456')
  expect(middle).toHaveAttribute('r', '6')
  const x = Number(middle.getAttribute('cx')), y = Number(middle.getAttribute('cy'))
  const point = (x: number, y: number) => ({ clientX: 10 + x * scale, clientY: 20 + y * scale, button: 0 })
  fireEvent.pointerDown(svg, point(x, y))
  fireEvent.pointerUp(svg, point(x, y))
  expect(capture).toHaveBeenCalled()
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: ['r2'], operation: 'toggle' }) }))
  fireEvent.pointerDown(svg, point(x - 20, y - 15))
  // Pointer-up position is authoritative even when no move event was delivered.
  fireEvent.pointerUp(svg, point(x + 20, y + 15))
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: ['r2'], operation: 'replace' }) }))
  fireEvent.pointerDown(svg, point(100, 25))
  fireEvent.pointerUp(svg, point(150, 65))
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ rowIds: [], operation: 'replace' }) }))
  const operation = view.getByRole('combobox', { name: 'test operation' })
  const rectangle = () => {
    fireEvent.pointerDown(svg, point(x - 20, y - 15))
    fireEvent.pointerUp(svg, point(x + 20, y + 15))
  }
  for (const [op, expected] of [['replace', ['r2']], ['add', ['r2']], ['subtract', []], ['toggle', ['r2']], ['toggle', []]] as const) {
    fireEvent.change(operation, { target: { value: op } })
    rectangle()
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ operation: op, rowIds: ['r2'] }) }))
    expect(local.getState().globalObservations.selectedRowIds).toEqual(expected)
  }
  const first = svg.querySelector('[data-row-id="r1"]')!
  const firstX = Number(first.getAttribute('cx')), firstY = Number(first.getAttribute('cy'))
  fireEvent.pointerDown(svg, point(firstX, firstY))
  fireEvent.pointerUp(svg, point(firstX, firstY))
  fireEvent.change(operation, { target: { value: 'add' } })
  rectangle()
  expect([...local.getState().globalObservations.selectedRowIds].sort()).toEqual(['r1', 'r2'])
  fireEvent.change(operation, { target: { value: 'subtract' } })
  rectangle()
  expect(local.getState().globalObservations.selectedRowIds).toEqual(['r1'])
  fireEvent.change(operation, { target: { value: 'replace' } })
  dispatch.mockClear()
  fireEvent.pointerDown(svg, point(x, y))
  fireEvent.pointerCancel(svg)
  fireEvent.pointerUp(svg, point(x, y))
  expect(dispatch).not.toHaveBeenCalled()
  const callsBeforeFocus = vi.mocked(api.post).mock.calls.length
  // 新方式：GraphPanel の拡大入口で開き、同一 host・同一 svg のまま倍率が変わる
  const host = view.getByTestId('graph-host-discriminant/map')
  const svgBefore = view.getByTestId('discriminant-map-svg')
  fireEvent.click(view.getByTestId('graph-expand-discriminant/map'))
  expect(view.getByTestId('graph-expansion-dialog')).toBeInTheDocument()
  expect(view.getByTestId('graph-expansion-dock')).toContainElement(host)
  expect(host).toContainElement(view.getByTestId('discriminant-map-svg'))
  expect(view.getByTestId('discriminant-map-svg').querySelectorAll('[data-row-id]')).toHaveLength(3)
  fireEvent.click(view.getByText('test zoom'))
  expect(view.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('125%')
  expect(view.getByTestId('graph-expansion-dock')).toContainElement(host)
  expect(host).toContainElement(view.getByTestId('discriminant-map-svg'))
  expect(svgBefore).toBe(view.getByTestId('discriminant-map-svg'))
  fireEvent.click(view.getByText('test fit'))
  expect(view.getByTestId('graph-expansion-zoom-label')).toHaveTextContent('フィット')
  fireEvent.click(view.getByText('test exit'))
  expect(view.getByTestId('discriminant-target-select')).toHaveValue('y')
  expect(view.getByTestId('discriminant-features-select')).toHaveValue(['x'])
  expect(view.getByTestId('discriminant-map-svg').querySelectorAll('[data-row-id]')).toHaveLength(3)
  expect(vi.mocked(api.post).mock.calls.length).toBe(callsBeforeFocus)
})
