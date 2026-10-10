import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { api, type CodebookColumn } from '../src/api/client'
import { globalVariablesSlice, selectionApplied, store, type RootState } from '../src/app/store'
import StatisticsPage from '../src/features/dataset/StatisticsPage'
import GlobalHeaderControlBar from '../src/features/selection/GlobalHeaderControlBar'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import { graphEngine } from '../src/engine/graphClient'

// Handmade frontend mocks, not captured API responses or a backend arithmetic oracle.
// X: four valid answers (10,20,30,40), weights (1,0,null,3), two missing answers.
// Scope mass is 13; X-valid mass is 4; raw mean is 25; weighted mean is 32.5.
const data = vi.hoisted(() => ({
  rowIds: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
  rowIndex: new Map(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id, index) => [id, index])),
  schema: [{ columnId: 'x', name: 'X', semanticType: 'numeric' }, { columnId: 'y', name: 'Y', semanticType: 'numeric' },
    { columnId: 'c', name: 'C', semanticType: 'categorical' }],
  columns: { X: [10, 20, 30, 99, null, 40], Y: [1, 2, 3, 4, 5, 6], C: ['a', 'b', 'a', 'b', 'a', 'b'] },
  numeric: { X: new Float64Array([10, 20, 30, 99, NaN, 40]), Y: new Float64Array([1, 2, 3, 4, 5, 6]) },
  minMax: { X: { min: 10, max: 99 }, Y: { min: 1, max: 6 } }, categories: { C: ['a', 'b'] },
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => data }))
vi.mock('../src/engine/graphClient', () => ({ graphEngine: { describeNumeric: vi.fn() } }))
vi.mock('../src/features/charts/EChartSurface', async () => ({ default: (await import('react')).forwardRef(() => null) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))

const column = (name: string, options: Partial<CodebookColumn> = {}): CodebookColumn => ({
  columnId: name.toLowerCase(), name, label: name, role: 'question', scaleType: 'ratio',
  missingCodes: [], missingReasons: {}, valueLabels: {}, categoryOrder: [], isReversed: false, multiResponseGroup: null, ...options,
})
const columns = [column('X', { missingCodes: ['99'] }), column('Y'), column('C', { scaleType: 'nominal' }),
  column('W', { role: 'weight' }), column('W2', { role: 'weight' })]
const rawDescription = [4, 2, 25, 12.91, 10, 15, 25, 35, 40]
function localStore() {
  const base = store.getState()
  const initial: RootState = { ...base,
    selection: { ...base.selection, datasetId: 'statistics-mock', dataRevision: 2, allRowIds: data.rowIds, activeRowIds: data.rowIds, selectedRowIds: ['r2'] },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables, datasetId: 'statistics-mock', activeEntities: [{ kind: 'column', columnId: 'x' }], weightColumnId: 'w' },
    codebook: { ...base.codebook, datasetId: 'statistics-mock', schemaRevision: 3, isLoading: false, columns,
      weightConfig: { weightColumnId: 'w', weightType: 'survey' } },
  }
  return configureStore({ reducer: (state = initial, action: any): RootState => action.type === 'test/update'
    ? action.payload(state) : { ...state, globalVariables: globalVariablesSlice.reducer(state.globalVariables, action) },
  middleware: getDefault => getDefault({ serializableCheck: false }) })
}
type LocalStore = ReturnType<typeof localStore>
type Request = { datasetId: string; expectedDataRevision: number; expectedSchemaRevision: number; rowIds: string[];
  columns: string[]; weightMode: 'column' | 'none'; weightColumn?: string }
function response(body: Request, mean = 32.5) {
  return { datasetId: body.datasetId, dataRevision: body.expectedDataRevision, schemaRevision: body.expectedSchemaRevision,
    weightStatus: body.weightMode === 'none' ? 'omitted' : 'applied', weightedN: body.weightMode === 'none' ? null : 13,
    weightMissingCount: 1,
    columns: Object.fromEntries(body.columns.map(name => [name, {
      denominators: { total: 6, target: 6, valid: 4, missing: 2, notApplicable: 0 },
      weighted: body.weightMode === 'none' ? null : { weightedN: 4, weightedNStatus: 'ok', weightMissingCount: 1, weightedMean: mean, distribution: [] },
    }])),
  }
}
function transport(handler: (body: Request) => unknown = response) {
  return vi.spyOn(api, 'post').mockImplementation(async (path, body) => {
    if (path.endsWith('/color-domains')) return { domains: [] } as any
    if (path !== '/summaries') throw new Error(`Unexpected request: ${path}`)
    return await handler(body as Request) as any
  })
}
function update(local: LocalStore, change: (state: RootState) => RootState) {
  act(() => { local.dispatch({ type: 'test/update', payload: change }) })
}
function mount(local = localStore(), header = false, active = true) {
  const content = (isActive: boolean) => <Provider store={local}><MemoryRouter>
    <AnalysisViewActivityContext.Provider value={isActive}>
      {header && <GlobalHeaderControlBar />}<StatisticsPage />
    </AnalysisViewActivityContext.Provider>
  </MemoryRouter></Provider>
  const view = render(content(active))
  return { ...view, local, setActive: (isActive: boolean) => view.rerender(content(isActive)) }
}
const companion = () => within(screen.getByTestId('statistics-weight-companion'))
const raw = () => within(screen.getByTestId('statistics-raw-summary'))
const dataRow = (region: ReturnType<typeof within>) => region.getAllByRole('row').find(row => row.hasAttribute('data-row-key'))!
const assertRaw = () => expect(dataRow(raw()).children[4]).toHaveTextContent('25.000')
async function ready(mean = '32.500') {
  await waitFor(() => expect(companion().getByRole('cell', { name: mean, exact: true })).toBeInTheDocument())
  assertRaw()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { vi.mocked(graphEngine.describeNumeric).mockResolvedValue(rawDescription) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('Statistics numeric weighted companion', () => {
  it('uses the real header for column/none/column while keeping raw values and describeNumeric untouched', async () => {
    const post = transport()
    const { local } = mount(localStore(), true)
    await ready()
    const expected = { datasetId: 'statistics-mock', expectedDataRevision: 2, expectedSchemaRevision: 3,
      rowIds: data.rowIds, columns: ['X'] }
    const summaryCalls = () => post.mock.calls.filter(([path]) => path === '/summaries').map(([, body]) => body)
    expect(summaryCalls()).toEqual([{ ...expected, weightMode: 'column', weightColumn: 'W' }])
    expect(graphEngine.describeNumeric).toHaveBeenCalledTimes(1)
    const chooseWeight = async (selected: boolean) => {
      fireEvent.click(within(screen.getByTestId('global-weight-controls')).getByRole('button', { name: '変数を選択', exact: true }))
      const dialog = await screen.findByRole('dialog', { name: '変数を選択', exact: true })
      if (selected) fireEvent.click(within(dialog).getByRole('radio', { name: /^W(?:\s|$)/ }))
      else fireEvent.click(within(dialog).getByRole('button', { name: '選択解除', exact: true }))
      fireEvent.click(within(dialog).getByRole('button', { name: /^決\s*定$/ }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    await chooseWeight(false)
    await waitFor(() => expect(companion().getByTestId('statistics-weight-status')).toHaveTextContent('ウェイト未選択（非加重）'))
    expect(companion().queryByRole('table')).toBeNull()
    expect(companion().queryByText('32.500')).toBeNull()
    assertRaw()
    expect(graphEngine.describeNumeric).toHaveBeenCalledTimes(1)
    await chooseWeight(true)
    await ready()
    expect(summaryCalls()).toEqual([{ ...expected, weightMode: 'column', weightColumn: 'W' },
      { ...expected, weightMode: 'none' }, { ...expected, weightMode: 'column', weightColumn: 'W' }])
    expect(graphEngine.describeNumeric).toHaveBeenCalledTimes(1)
    expect(local.getState().selection.activeRowIds).toEqual(data.rowIds)
    expect(local.getState().selection.selectedRowIds).toEqual(['r2'])
    expect(local.getState().codebook.weightConfig).toEqual({ weightColumnId: 'w', weightType: 'survey' })
  })

  it('labels API valid n, per-variable eligible mass and missing weights separately from raw and scope bases', async () => {
    transport()
    mount()
    await ready()
    const cells = dataRow(companion()).children
    expect(Array.from(cells, cell => cell.textContent)).toEqual(['X', '32.500', '4', '4', '1', '有効回答'])
    expect(companion().getByRole('columnheader', { name: '有効回答内のウェイト欠損' })).toBeInTheDocument()
    expect(companion().getByText(/有効回答 n はゼロ・欠損ウェイトの回答を含みます/)).toBeInTheDocument()
    expect(companion().getByText(/標準誤差は非加重n基準/)).toBeInTheDocument()
    expect(screen.getByTestId('statistics-raw-basis')).toHaveTextContent('カテゴリカードも非加重')
    expect(screen.getByTestId('statistics-raw-basis')).toHaveTextContent('標準偏差・分位点・ヒストグラムへのウェイト適用はありません')
    expect(graphEngine.describeNumeric).toHaveBeenCalledWith(new Float64Array([10, 20, 30, NaN, NaN, 40]))
  })

  it('discloses declared-domain exclusion and reverse scoring without relabeling the observed raw mean', async () => {
    const local = localStore()
    update(local, state => ({ ...state, codebook: { ...state.codebook, columns: state.codebook.columns.map(col => col.name === 'X'
      ? { ...col, categoryOrder: ['10', '20', '40'], isReversed: true } : col) } }))
    transport(body => {
      const result = response(body, 17.5)
      result.columns.X.denominators.valid = 3
      result.columns.X.weighted!.weightMissingCount = 0
      return result
    })
    mount(local)
    await ready('17.500')
    expect(companion().getByRole('cell', { name: '定義域外を除外・逆転得点化' })).toBeInTheDocument()
    expect(dataRow(companion()).children[2]).toHaveTextContent('3')
    expect(screen.getByTestId('statistics-raw-basis')).toHaveTextContent('定義域による除外・逆転得点化は行いません')
    expect(companion().getByText(/非加重の観測値とは集計基準が異なる場合/)).toBeInTheDocument()
  })

  it.each([
    { kind: 'no positive scope', status: 'no_positive_weight', mass: 0, mean: null, massStatus: 'ok', text: '正のウェイトがありません', massText: '0' },
    { kind: 'variable-only zero mass', status: 'applied', mass: 0, mean: null, massStatus: 'ok', text: 'この変数の有効回答に正のウェイトがありません', massText: '0' },
    { kind: 'unavailable mean', status: 'applied', mass: 4, mean: null, massStatus: 'ok', text: '加重平均を取得できません', massText: '4' },
    { kind: 'out-of-range mass', status: 'applied', mass: null, mean: 32.5, massStatus: 'out_of_range', text: '32.500', massText: '範囲外' },
  ])('handles $kind without substituting raw mean', async ({ status, mass, mean, massStatus, text, massText }) => {
    transport(body => ({ ...response(body), weightStatus: status,
      columns: { X: { denominators: { valid: 4 }, weighted: { weightedN: mass, weightedNStatus: massStatus,
        weightedMean: mean, weightMissingCount: 1, distribution: [],
        warnings: massStatus === 'out_of_range' ? [{ code: 'MOCK_RANGE', message: 'ウェイト合計が表示範囲を超えています' }] : [] } } } }))
    mount()
    await waitFor(() => expect(screen.getByTestId('statistics-weight-companion')).toHaveTextContent(text))
    expect(dataRow(companion()).children[3]).toHaveTextContent(massText)
    expect(companion().queryByRole('cell', { name: '25.000' })).toBeNull()
    if (massStatus === 'out_of_range') expect(companion().getByText('ウェイト合計が表示範囲を超えています')).toBeInTheDocument()
    assertRaw()
  })

  it.each(['omitted', 'missing weighted block', 'missing column'])('shows unavailable values for %s without raw fallback', async kind => {
    transport(body => {
      const result = response(body)
      if (kind === 'omitted') result.weightStatus = 'omitted'
      else if (kind === 'missing column') result.columns = {}
      else result.columns.X.weighted = null
      return result
    })
    mount()
    await waitFor(() => expect(companion().getByTestId('statistics-weight-status')).toBeInTheDocument())
    expect(companion().queryByRole('cell', { name: '25.000' })).toBeNull()
    if (kind === 'omitted') {
      expect(companion().getByTestId('statistics-weight-status')).toHaveTextContent('ウェイトが適用されていません')
      expect(companion().queryByRole('table')).toBeNull()
    } else expect(companion().getByRole('cell', { name: /加重データを取得できません/ })).toBeInTheDocument()
    assertRaw()
  })

  const changes: { name: string; change: (state: RootState) => RootState; expected: Partial<Request> }[] = [
    { name: 'weight', change: state => ({ ...state, globalVariables: { ...state.globalVariables, weightColumnId: 'w2' } }), expected: { weightColumn: 'W2' } },
    { name: 'scope', change: state => ({ ...state, selection: { ...state.selection, activeRowIds: ['r1'] } }), expected: { rowIds: ['r1'] } },
    { name: 'data revision', change: state => ({ ...state, selection: { ...state.selection, dataRevision: 4 } }), expected: { expectedDataRevision: 4 } },
    { name: 'schema revision', change: state => ({ ...state, codebook: { ...state.codebook, schemaRevision: 5 } }), expected: { expectedSchemaRevision: 5 } },
    { name: 'numeric membership', change: state => ({ ...state, globalVariables: { ...state.globalVariables, activeEntities: [{ kind: 'column', columnId: 'y' }] } }), expected: { columns: ['Y'] } },
    { name: 'codebook definitions', change: state => ({ ...state, codebook: { ...state.codebook, columns: state.codebook.columns.map(col => col.name === 'X' ? { ...col, missingCodes: ['99', '30'] } : col) } }), expected: { columns: ['X'] } },
    { name: 'dataset', change: state => ({ ...state, selection: { ...state.selection, datasetId: 'new-dataset' }, codebook: { ...state.codebook, datasetId: 'new-dataset' } }), expected: { datasetId: 'new-dataset' } },
  ]
  it.each(changes)('ignores obsolete success after the current $name result has arrived', async ({ change, expected }) => {
    const obsolete = deferred<ReturnType<typeof response>>()
    const current = deferred<ReturnType<typeof response>>()
    const requests: Request[] = []
    transport(body => { requests.push(body); return requests.length === 1 ? obsolete.promise : current.promise })
    const { local } = mount()
    await waitFor(() => expect(requests).toHaveLength(1))
    update(local, change)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject(expected)
    await act(async () => { current.resolve(response(requests[1], 77.7)) })
    await ready('77.700')
    await act(async () => { obsolete.resolve(response(requests[0], 999)) })
    expect(companion().getByRole('cell', { name: '77.700', exact: true })).toBeInTheDocument()
    expect(companion().queryByRole('alert')).toBeNull()
    expect(companion().queryByText('999.000')).toBeNull()
  })

  it('does not let an obsolete failure complete a newer pending request', async () => {
    const obsolete = deferred<ReturnType<typeof response>>()
    const current = deferred<ReturnType<typeof response>>()
    const requests: Request[] = []
    transport(body => { requests.push(body); return requests.length === 1 ? obsolete.promise : current.promise })
    const { local } = mount()
    await waitFor(() => expect(requests).toHaveLength(1))
    update(local, changes[0].change)
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => { obsolete.reject({ message: 'obsolete API failure' }) })
    expect(companion().getByRole('status')).toHaveTextContent('数値加重集計を確認中')
    expect(companion().queryByRole('alert')).toBeNull()
    await act(async () => { current.resolve(response(requests[1], 77.7)) })
    await ready('77.700')
  })

  it('keeps raw statistics usable on a plain-object API failure and retries only the current input', async () => {
    const post = transport()
    const { local } = mount()
    await ready()
    const pending = deferred<ReturnType<typeof response>>()
    post.mockImplementationOnce(async () => pending.promise)
    update(local, state => ({ ...state, globalVariables: { ...state.globalVariables, weightColumnId: 'w2' } }))
    expect(companion().queryByText('32.500')).toBeNull()
    assertRaw()
    await act(async () => { pending.reject({ code: 'MOCK_FAILURE', message: '現在のウェイトを読み込めません' }) })
    expect(companion().getByRole('alert')).toHaveTextContent('現在のウェイトを読み込めません')
    assertRaw()
    fireEvent.click(companion().getByRole('button', { name: '加重集計を再試行' }))
    await ready()
    expect(post).toHaveBeenLastCalledWith('/summaries', expect.objectContaining({ weightColumn: 'W2', weightMode: 'column', expectedDataRevision: 2, expectedSchemaRevision: 3 }))
    expect(companion().queryByRole('alert')).toBeNull()
    expect(graphEngine.describeNumeric).toHaveBeenCalledTimes(1)
  })

  it('does not request hidden or empty inputs and reactivates with current numeric or categorical inputs', async () => {
    const post = transport()
    const view = mount(localStore(), false, false)
    expect(post).not.toHaveBeenCalled()
    expect(screen.queryByTestId('statistics-weight-companion')).toBeNull()
    update(view.local, state => ({ ...state, globalVariables: { ...state.globalVariables, weightColumnId: 'w2' } }))
    expect(post).not.toHaveBeenCalled()
    view.setActive(true)
    await ready()
    expect(post).toHaveBeenLastCalledWith('/summaries', expect.objectContaining({ weightColumn: 'W2' }))
    update(view.local, state => ({ ...state, selection: { ...state.selection, activeRowIds: [] } }))
    expect(screen.queryByTestId('statistics-weight-companion')).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)
    update(view.local, state => ({ ...state, selection: { ...state.selection, activeRowIds: data.rowIds },
      globalVariables: { ...state.globalVariables, activeEntities: [{ kind: 'column', columnId: 'c' }] } }))
    expect(screen.queryByTestId('statistics-weight-companion')).toBeNull()
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenLastCalledWith('/summaries', expect.objectContaining({ columns: ['C'], weightMode: 'column', weightColumn: 'W2' }))
  })

  it.each(['loading', 'different dataset', 'unresolved weight'])('waits for %s instead of silently sending none', async kind => {
    const post = transport()
    const local = localStore()
    update(local, state => ({ ...state,
      codebook: { ...state.codebook, isLoading: kind === 'loading', datasetId: kind === 'different dataset' ? 'old-dataset' : state.codebook.datasetId },
      globalVariables: { ...state.globalVariables, weightColumnId: kind === 'unresolved weight' ? 'missing-id' : 'w' } }))
    mount(local)
    expect(post).not.toHaveBeenCalled()
    expect(screen.getByTestId('statistics-weight-companion')).toHaveTextContent(kind === 'unresolved weight' ? '選択したウェイト列を確認できません' : 'コードブックを読み込み中')
    update(local, state => ({ ...state, codebook: { ...state.codebook, datasetId: 'statistics-mock', isLoading: false },
      globalVariables: { ...state.globalVariables, weightColumnId: 'w' } }))
    await ready()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenLastCalledWith('/summaries', expect.objectContaining({ weightMode: 'column', weightColumn: 'W' }))
  })

  it('keeps categorical selection canonical beside a shared numeric and categorical weighted request', async () => {
    const post = transport()
    const local = localStore()
    update(local, state => ({ ...state, globalVariables: { ...state.globalVariables,
      activeEntities: [{ kind: 'column', columnId: 'x' }, { kind: 'column', columnId: 'c' }] } }))
    const dispatch = vi.spyOn(local, 'dispatch')
    mount(local)
    await ready()
    const card = within(screen.getByTestId('question-card-C'))
    expect(card.getByTestId('denominators-bar')).toHaveTextContent('有効: 6')
    expect(card.queryByTestId('weight-note')).toBeNull()
    fireEvent.click(card.getByRole('button', { name: 'aの回答者を選択', exact: true }))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: selectionApplied.type,
      payload: expect.objectContaining({ rowIds: ['r1', 'r3', 'r5'] }) }))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/summaries', expect.objectContaining({ columns: ['X', 'C'], weightMode: 'column' }))
  })

  it('rejects a response from a mismatched revision', async () => {
    transport(body => ({ ...response(body), dataRevision: body.expectedDataRevision - 1 }))
    mount()
    await waitFor(() => expect(companion().getByRole('alert')).toHaveTextContent('版が一致しません'))
    expect(companion().queryByRole('table')).toBeNull()
    assertRaw()
  })
})
