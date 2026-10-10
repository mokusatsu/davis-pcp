import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { api, type CodebookColumn, type CodebookResponse } from '../src/api/client'
import { globalVariablesSlice, selectionCleared, selectionReducer, store, type RootState } from '../src/app/store'
import StatisticsPage from '../src/features/dataset/StatisticsPage'
import type { QuestionSummaryData, WeightMeta } from '../src/features/distribution/QuestionCard'
import type { ColumnarData } from '../src/features/pcp/useDatasetColumns'
import GlobalHeaderControlBar from '../src/features/selection/GlobalHeaderControlBar'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
import { graphEngine } from '../src/engine/graphClient'
import capture from './fixtures/distributionWeightModeApi.json'

const source = vi.hoisted(() => ({ data: null as ColumnarData | null }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => source.data }))
vi.mock('../src/engine/graphClient', () => ({ graphEngine: { describeNumeric: vi.fn() } }))
vi.mock('../src/features/charts/EChartSurface', async () => ({ default: (await import('react')).forwardRef(() => null) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))

type Request = { datasetId: string; expectedDataRevision: number; expectedSchemaRevision: number;
  rowIds: string[]; columns: string[]; weightMode: 'column' | 'none'; weightColumn?: string }
type Summary = Pick<QuestionSummaryData, 'denominators' | 'distribution' | 'weighted'>
type ResponseBody = { datasetId: string; dataRevision: number; schemaRevision: number;
  weightStatus: WeightMeta['status']; weightedN: number | null; warnings?: { code: string; message: string }[];
  columns: Record<string, Summary> }
const column = (name: string, options: Partial<CodebookColumn> = {}): CodebookColumn => ({
  columnId: name.toLowerCase(), name, label: name, role: 'question', scaleType: 'nominal',
  missingCodes: [], missingReasons: {}, valueLabels: {}, categoryOrder: [], isReversed: false,
  multiResponseGroup: null, ...options,
})

// Handmade frontend classification controls, NOT captured API responses or backend
// arithmetic evidence. C has four API-valid answers, including zero/missing weights.
// Its scope mass is 53, valid-answer mass is 5, and the unchanged raw card keeps
// undeclared 9 valid (five raw-valid answers) while collapsing NA/M/null to missing.
const categorySpec = { categoryOrder: ['1', '2', '3'], missingCodes: ['NA', 'M'],
  missingReasons: { NA: 'not_applicable', M: 'missing' },
  valueLabels: { '1': 'Not in universe', '2': 'Shared label', '3': 'Shared label', NA: 'Not applicable', M: 'No answer' } }
const handmadeBook: CodebookResponse = { datasetId: 'statistics-category-control', schemaRevision: 3,
  columns: [column('C', categorySpec), column('X', { scaleType: 'ratio' }),
    column('D', { ...categorySpec, scaleType: 'ordinal' }), column('T', { scaleType: 'text' }),
    column('I', { scaleType: 'id', role: 'id' }), column('W', { scaleType: 'ratio', role: 'weight' }),
    column('W2', { scaleType: 'ratio', role: 'weight' })],
  multiResponseGroups: [], weightConfig: { weightColumnId: 'w', weightType: 'survey' } }
const controlRows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']
function controlData(): ColumnarData {
  return { rowIds: controlRows, rowIndex: new Map(controlRows.map((id, index) => [id, index])),
    schema: handmadeBook.columns.map(col => ({ columnId: col.columnId, name: col.name,
      semanticType: col.scaleType === 'ratio' ? 'numeric' : 'categorical' })),
    columns: { C: [1, '2', '2', 'NA', 'M', null, '9', 1], D: [1, '2', '2', 'NA', 'M', null, '9', 1],
      X: [10, 20, 30, 40, 50, 60, 70, 80], T: controlRows, I: controlRows,
      W: [2, 0, null, 7, 11, 13, 17, 3], W2: [2, 0, null, 7, 11, 13, 17, 3] },
    numeric: { X: new Float64Array([10, 20, 30, 40, 50, 60, 70, 80]) },
    minMax: { X: { min: 10, max: 80 } }, categories: { C: ['1', '2', 'NA', 'M', '9'], D: ['1', '2', 'NA', 'M', '9'] } }
}
function handmadeCategory(): Summary {
  return { denominators: { total: 8, target: 7, valid: 4, missing: 2, notApplicable: 1, invalid: 1 },
    // API order intentionally differs from weighted order; number 1 matches string '1'.
    // Codes 2 and 3 share a label, so neither position nor label is a safe join key.
    distribution: [
      { code: '2', label: 'Shared label', count: 2, percentageValid: 50, percentageTotal: 25 },
      { code: 1, label: 'Not in universe', count: 2, percentageValid: 50, percentageTotal: 25 },
      { code: '3', label: 'Shared label', count: 0, percentageValid: 0, percentageTotal: 0 },
      { code: 'NA', label: 'Not applicable', count: 1, percentageValid: 0, percentageTotal: 12.5, isMissing: true, missingReason: 'not_applicable' },
      { code: 'M', label: 'No answer', count: 1, percentageValid: 0, percentageTotal: 12.5, isMissing: true, missingReason: 'missing' },
      { code: null, label: 'Null response', count: 1, percentageValid: 0, percentageTotal: 12.5, isMissing: true, missingReason: 'missing' },
      { code: '9', label: 'Undeclared', count: 1, percentageValid: 0, percentageTotal: 12.5, isInvalid: true, missingReason: 'invalid_value' },
    ], weighted: { weightedN: 5, weightedNStatus: 'ok', weightMissingCount: 1,
      distribution: [{ code: '3', weightedCount: 0, weightedPct: 0 },
        { code: '1', weightedCount: 5, weightedPct: 100 }, { code: '2', weightedCount: 0, weightedPct: 0 }] } }
}
function handmadeResponse(body: Request): ResponseBody {
  return { datasetId: body.datasetId, dataRevision: body.expectedDataRevision,
    schemaRevision: body.expectedSchemaRevision, weightStatus: body.weightMode === 'none' ? 'omitted' : 'applied',
    weightedN: body.weightMode === 'none' ? null : 53,
    columns: Object.fromEntries(body.columns.map(name => {
      const summary: Summary = name === 'X'
        ? { denominators: { total: 8, target: 8, valid: 8, missing: 0, notApplicable: 0 },
          weighted: { weightedN: 53, weightMissingCount: 1, weightedMean: 55, distribution: [] } }
        : handmadeCategory()
      if (body.weightMode === 'none') summary.weighted = null
      return [name, summary]
    })) }
}
function localStore(book = handmadeBook, names = ['C'], dataRevision = 2) {
  const base = store.getState()
  const initial: RootState = { ...base,
    selection: { ...base.selection, datasetId: book.datasetId, dataRevision, allRowIds: source.data!.rowIds,
      activeRowIds: source.data!.rowIds, activeRowIdSet: new Set(source.data!.rowIds), selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables, datasetId: book.datasetId,
      activeEntities: names.map(name => ({ kind: 'column', columnId: book.columns.find(col => col.name === name)!.columnId })),
      weightColumnId: book.weightConfig!.weightColumnId },
    codebook: { ...base.codebook, ...book, isLoading: false },
  }
  return configureStore({ reducer: (state = initial, action: any): RootState => action.type === 'test/update'
    ? action.payload(state) : { ...state, selection: selectionReducer(state.selection, action),
      globalVariables: globalVariablesSlice.reducer(state.globalVariables, action) },
  middleware: getDefault => getDefault({ serializableCheck: false }) })
}
type LocalStore = ReturnType<typeof localStore>
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
function transport(handler: (body: Request) => unknown = handmadeResponse) {
  const requests: Request[] = []
  vi.spyOn(api, 'post').mockImplementation(async (path, body) => {
    if (path.endsWith('/color-domains')) return { domains: [] } as any
    if (path !== '/summaries') throw new Error(`Unexpected request: ${path}`)
    requests.push(body as Request)
    return await handler(body as Request) as any
  })
  return requests
}
const root = () => within(screen.getByTestId('statistics-categorical-weight-companion'))
const category = (name = 'C') => within(screen.getByTestId(`statistics-category-weight-${name}`))
const dataRows = (region: ReturnType<typeof within>) => region.getAllByRole('row').filter(row => row.hasAttribute('data-row-key'))
const cells = (region: ReturnType<typeof within>, index: number) => within(dataRows(region)[index]).getAllByRole('cell')
const values = (region: ReturnType<typeof within>, index: number) => cells(region, index).slice(1).map(cell => cell.textContent)
const rawSnapshot = () => dataRows(within(screen.getByTestId('statistics-raw-summary'))).map(row => row.textContent)
async function ready(name = 'C', pct = '100.0%') {
  await waitFor(() => expect(category(name).getByRole('cell', { name: pct, exact: true })).toBeInTheDocument())
}
function expectDenominators(name: string, counts: number[]) {
  const bar = screen.getByTestId(`statistics-category-denominators-${name}`)
  ;['全対象 n', '設問対象 n', '有効回答 n', '無回答 n', '非該当 n', '無効 n'].forEach((label, index) => {
    expect(bar).toHaveTextContent(new RegExp(`${label}\\s*[:：]?\\s*${counts[index]}(?:\\D|$)`))
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  source.data = controlData()
  vi.mocked(graphEngine.describeNumeric).mockResolvedValue([8, 0, 45, 24.49, 10, 20, 45, 70, 80])
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

describe('Statistics categorical weighted companion', () => {
  it('reuses the unchanged eight-row API capture through raw-base and real-header on/off/on changes', async () => {
    const book = capture.codebook as CodebookResponse
    const question = book.columns.find(col => col.name === 'migration_msa')!
    const weight = book.columns.find(col => col.role === 'weight')!
    // Raw projection verified against source CSV records 1,2,3,4,19,20,32,46.
    // The response JSON retains its original native capture/provenance unchanged.
    source.data = { rowIds: capture.request.rowIds,
      rowIndex: new Map(capture.request.rowIds.map((id, index) => [id, index])),
      schema: [{ columnId: question.columnId, name: question.name, semanticType: 'categorical' }],
      columns: { migration_msa: ['?', '?', 'Nonmover', 'Nonmover', 'MSA to MSA', 'MSA to nonMSA', 'MSA to MSA', 'NonMSA to nonMSA'] },
      numeric: {}, minMax: {}, categories: { migration_msa: ['?', 'Nonmover', 'MSA to MSA', 'MSA to nonMSA', 'NonMSA to nonMSA'] } }
    const requests = transport(body => body.weightMode === 'none' ? capture.responses.unweighted : capture.responses.weighted)
    const { local } = mount(localStore(book, [question.name], capture.request.expectedDataRevision), true)
    const readyCapturedCategory = async () => {
      await waitFor(() => {
        const row = category(question.name).getByText('MSA to MSA', { selector: 'span', exact: true }).closest('tr')!
        expect(within(row).getByRole('cell', { name: '40.8%', exact: true })).toBeInTheDocument()
      })
    }
    await readyCapturedCategory()
    const weighted = category(question.name)
    const raw = within(screen.getByTestId(`question-card-${question.name}`))
    const rawValues = rawSnapshot()
    expect(root().getByText('コードブック基準の加重カテゴリ集計')).toBeInTheDocument()
    expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('カテゴリ加重集計: ウェイト適用中（MARSUPWT）')
    expectDenominators(question.name, [8, 8, 6, 2, 0, 0])
    const initialRows = dataRows(weighted)
    const initialValues = (index: number) => within(initialRows[index]).getAllByRole('cell').slice(1).map(cell => cell.textContent)
    expect(initialValues(2)).toEqual(['2', '5,520.57', '40.8%'])
    expect(initialValues(0)).toEqual(['0', '0', '0.0%'])
    expect(initialValues(7)).toEqual(['2', '対象外', '対象外'])
    expect(screen.getByTestId(`statistics-category-weight-${question.name}`)).toHaveTextContent(/有効回答の加重対象 Σw\s*[:：]?\s*13,539.87/)
    expect(screen.getByTestId(`statistics-category-weight-${question.name}`)).not.toHaveTextContent('18,155.39')
    expect(weighted.getAllByRole('columnheader').map(cell => cell.textContent)).toEqual([
      'コード・ラベル', '非加重 n', '加重度数 Σw', '加重割合（有効回答ベース）',
    ])
    expect(weighted.queryByRole('button')).toBeNull()
    expect(weighted.queryByTestId('question-denominator-toggle')).toBeNull()
    expect(raw.getByTestId('category-migration_msa-MSA to MSA')).toHaveTextContent('33.3% (2)')
    expect(raw.queryByTestId('weight-note')).toBeNull()
    fireEvent.click(within(raw.getByTestId('category-migration_msa-MSA to MSA')).getByRole('button', { name: 'MSA to MSAの回答者を選択', exact: true }))
    const assertMembership = () => {
      expect(local.getState().selection.selectedRowIds).toEqual(['ROW-000019', 'ROW-000032'])
      expect(local.getState().selection.activeRowIds).toEqual(capture.request.rowIds)
      expect(raw.getByTestId('category-migration_msa-MSA to MSA')).toHaveTextContent('2選択中')
      expect(rawSnapshot()).toEqual(rawValues)
    }
    assertMembership()
    fireEvent.click(screen.getByText('全対象者ベース'))
    expect(raw.getByTestId('category-migration_msa-MSA to MSA')).toHaveTextContent('25.0% (2)')
    expect(values(weighted, 2)).toEqual(['2', '5,520.57', '40.8%'])
    assertMembership()
    const chooseWeight = async (selected: boolean) => {
      fireEvent.click(within(screen.getByTestId('global-weight-controls')).getByRole('button', { name: '変数を選択', exact: true }))
      const dialog = await screen.findByRole('dialog', { name: '変数を選択', exact: true })
      if (selected) fireEvent.click(within(dialog).getByRole('radio', { name: /^MARSUPWT(?:\s|$)/ }))
      else fireEvent.click(within(dialog).getByRole('button', { name: '選択解除', exact: true }))
      fireEvent.click(within(dialog).getByRole('button', { name: /^決\s*定$/ }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    await chooseWeight(false)
    await waitFor(() => expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('ウェイト未選択（非加重）'))
    expect(root().queryByRole('table')).toBeNull()
    expect(root().queryByText('40.8%')).toBeNull()
    assertMembership()
    await chooseWeight(true)
    await readyCapturedCategory()
    assertMembership()
    fireEvent.click(screen.getByText('有効回答ベース'))
    expect(raw.getByTestId('category-migration_msa-MSA to MSA')).toHaveTextContent('33.3% (2)')
    assertMembership()
    const { selectedRowIds: _selectedRowIds, ...expected } = capture.request
    expect(requests).toEqual([{ ...expected, weightMode: 'column', weightColumn: weight.name },
      { ...expected, weightMode: 'none' }, { ...expected, weightMode: 'column', weightColumn: weight.name }])
    expect(local.getState().codebook.weightConfig).toEqual(book.weightConfig)
    expect(graphEngine.describeNumeric).not.toHaveBeenCalled()
  })

  it('presents handmade API classifications and code-keyed weights while preserving the different raw membership', async () => {
    const requests = transport()
    const { local } = mount()
    await ready()
    expectDenominators('C', [8, 7, 4, 2, 1, 1])
    const weighted = category()
    expect(values(weighted, 0)).toEqual(['2', '0', '0.0%'])
    expect(values(weighted, 1)).toEqual(['2', '5', '100.0%'])
    expect(cells(weighted, 1)[0]).toHaveTextContent('Not in universe')
    expect(values(weighted, 2)).toEqual(['0', '0', '0.0%'])
    ;['非該当', '無回答', '無回答', '無効'].forEach((classification, index) => {
      expect(cells(weighted, index + 3)[0]).toHaveTextContent(classification)
      expect(values(weighted, index + 3)).toEqual(['1', '対象外', '対象外'])
    })
    expect(cells(weighted, 5)[0]).toHaveTextContent('Null response')
    expect(screen.getByTestId('statistics-category-weight-C')).toHaveTextContent(/有効回答の加重対象 Σw\s*[:：]?\s*5/)
    expect(screen.getByTestId('statistics-category-weight-C')).toHaveTextContent(/有効回答内のウェイト欠損\s*[:：]?\s*1/)
    expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('コードブックの非該当・欠損・定義域に基づく集計です')
    expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('非加重nにはゼロ・欠損ウェイトの有効回答も含みます')
    expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('Σwは人数ではありません')
    expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('非加重カテゴリカードの分母切替は、この加重割合を変更しません')
    expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('標準誤差は非加重n基準')
    const raw = within(screen.getByTestId('question-card-C'))
    expect(raw.getByTestId('denominators-bar')).toHaveTextContent('全: 8')
    expect(raw.getByTestId('denominators-bar')).toHaveTextContent('設問対象: 8')
    expect(raw.getByTestId('denominators-bar')).toHaveTextContent('有効: 5')
    expect(raw.getByTestId('denominators-bar')).toHaveTextContent('無回答: 3')
    expect(raw.getByTestId('denominators-bar')).not.toHaveTextContent('無効:')
    expect(raw.getByTestId('category-C-9')).toHaveTextContent('20.0% (1)')
    expect(raw.getByTestId('category-C-2')).toHaveTextContent('40.0% (2)')
    fireEvent.click(within(raw.getByTestId('category-C-2')).getByRole('button'))
    expect(local.getState().selection.selectedRowIds).toEqual(['r2', 'r3'])
    act(() => { local.dispatch(selectionCleared()) })
    fireEvent.click(within(raw.getByTestId('category-C-9')).getByRole('button'))
    expect(local.getState().selection.selectedRowIds).toEqual(['r7'])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ columns: ['C'], weightMode: 'column', weightColumn: 'W' })
  })

  it.each(['missing column', 'missing denominators', 'missing distribution', 'missing weighted block', 'missing weighted entry', 'null weighted values'])(
    'does not invent values for a handmade %s response', async kind => {
      transport(body => {
        const result = handmadeResponse(body)
        if (kind === 'missing column') delete result.columns.C
        else if (kind === 'missing denominators') delete result.columns.C.denominators
        else if (kind === 'missing distribution') delete result.columns.C.distribution
        else if (kind === 'missing weighted block') result.columns.C.weighted = null
        else if (kind === 'missing weighted entry') result.columns.C.weighted!.distribution = result.columns.C.weighted!.distribution.filter(row => row.code !== '1')
        else Object.assign(result.columns.C.weighted!.distribution.find(row => row.code === '1')!, { weightedCount: null, weightedPct: null })
        return result
      })
      mount()
      await waitFor(() => expect(screen.getByTestId('statistics-category-weight-C')).toHaveTextContent('取得できません'))
      if (kind === 'missing denominators' || kind === 'missing distribution' || kind === 'missing column') {
        expect(category().queryByRole('table')).toBeNull()
      }
      if (kind === 'missing weighted entry' || kind === 'null weighted values') {
        expect(cells(category(), 1)[1]).toHaveTextContent('2')
        expect(cells(category(), 1)[2]).toHaveTextContent('取得できません')
        expect(cells(category(), 1)[3]).toHaveTextContent('取得できません')
        expect(values(category(), 0)).toEqual(['2', '0', '0.0%'])
      }
      expect(screen.getByTestId('question-card-C')).toHaveTextContent('40.0% (2)')
      expect(screen.getByTestId('statistics-raw-summary')).toHaveTextContent('Not in universe (2)')
    })

  it.each(['omitted with selected weight', 'no positive scope', 'variable-only zero mass', 'out-of-range mass'])(
    'distinguishes handmade %s from a finite weighted result', async kind => {
      transport(body => {
        const result = handmadeResponse(body)
        const weighted = result.columns.C.weighted!
        if (kind === 'omitted with selected weight') result.weightStatus = 'omitted'
        else if (kind === 'out-of-range mass') {
          weighted.weightedN = null
          weighted.weightedNStatus = 'out_of_range'
          Object.assign(weighted.distribution.find(row => row.code === '1')!, { weightedCount: null, weightedCountStatus: 'out_of_range' })
          result.warnings = [{ code: 'MOCK_SCOPE_RANGE', message: '対象全体のウェイト合計が表示範囲外です' }]
          weighted.warnings = [{ code: 'MOCK_CATEGORY_RANGE', message: 'カテゴリのウェイト合計が表示範囲外です' }]
        } else {
          if (kind === 'no positive scope') { result.weightStatus = 'no_positive_weight'; result.weightedN = 0 }
          weighted.weightedN = 0
          weighted.distribution.forEach(row => { row.weightedCount = 0; row.weightedPct = null })
        }
        return result
      })
      mount()
      if (kind === 'omitted with selected weight') {
        await waitFor(() => expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('ウェイトが適用されていません'))
        expect(root().queryByRole('table')).toBeNull()
      } else if (kind === 'out-of-range mass') {
        await ready()
        expect(values(category(), 1)).toEqual(['2', '範囲外', '100.0%'])
        expect(screen.getByTestId('statistics-category-weight-C')).toHaveTextContent(/有効回答の加重対象 Σw\s*[:：]?\s*範囲外/)
        expect(root().getByText('対象全体のウェイト合計が表示範囲外です')).toBeInTheDocument()
        expect(root().getByText('カテゴリのウェイト合計が表示範囲外です')).toBeInTheDocument()
      } else {
        await waitFor(() => expect(screen.getByTestId('statistics-category-weight-C')).toHaveTextContent('この変数の有効回答に正のウェイトがありません'))
        expect(cells(category(), 1)[1]).toHaveTextContent('2')
        expect(cells(category(), 1)[2]).toHaveTextContent(/^0$/)
        expect(cells(category(), 1)[3]).not.toHaveTextContent('0.0%')
        if (kind === 'no positive scope') expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('カテゴリ加重集計: 正のウェイトがありません')
        else expect(screen.getByTestId('statistics-categorical-weight-companion')).toHaveTextContent('カテゴリ加重集計: ウェイト適用中（W）')
      }
      expect(screen.getByTestId('question-card-C')).toHaveTextContent('40.0% (2)')
    })

  it('hides stale category results immediately and rejects an obsolete codebook request after membership changes', async () => {
    const obsolete = deferred<ResponseBody>()
    const current = deferred<ResponseBody>()
    let calls = 0
    const requests = transport(body => ++calls === 1 ? handmadeResponse(body) : calls === 2 ? obsolete.promise : current.promise)
    const { local } = mount()
    await ready()
    update(local, state => ({ ...state, codebook: { ...state.codebook,
      columns: state.codebook.columns.map(col => col.name === 'C' ? { ...col, missingCodes: ['NA', 'M', '2'] } : col) } }))
    expect(root().queryByRole('cell', { name: '100.0%', exact: true })).toBeNull()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(root().getByRole('status')).toHaveTextContent('カテゴリ加重集計を確認中')
    update(local, state => ({ ...state, globalVariables: { ...state.globalVariables,
      activeEntities: [{ kind: 'column', columnId: 'd' }] } }))
    expect(screen.queryByTestId('statistics-category-weight-C')).toBeNull()
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[1].columns).toEqual(['C'])
    expect(requests[2].columns).toEqual(['D'])
    const latest = handmadeResponse(requests[2])
    latest.columns.D.weighted!.distribution.find(row => row.code === '1')!.weightedPct = 67.8
    await act(async () => { current.resolve(latest) })
    await ready('D', '67.8%')
    const stale = handmadeResponse(requests[1])
    stale.columns.C.weighted!.distribution.find(row => row.code === '1')!.weightedPct = 99.9
    await act(async () => { obsolete.resolve(stale) })
    expect(category('D').getByRole('cell', { name: '67.8%', exact: true })).toBeInTheDocument()
    expect(root().queryByText('99.9%')).toBeNull()
    expect(root().queryByRole('alert')).toBeNull()
  })

  it('keeps hidden, empty and text/ID-only inputs out of the shared request', async () => {
    const requests = transport()
    const view = mount(localStore(), false, false)
    expect(requests).toHaveLength(0)
    expect(screen.queryByTestId('statistics-categorical-weight-companion')).toBeNull()
    view.setActive(true)
    await ready()
    expect(requests).toHaveLength(1)
    update(view.local, state => ({ ...state, selection: { ...state.selection, activeRowIds: [] } }))
    expect(screen.queryByTestId('statistics-categorical-weight-companion')).toBeNull()
    expect(requests).toHaveLength(1)
    update(view.local, state => ({ ...state, selection: { ...state.selection, activeRowIds: controlRows },
      globalVariables: { ...state.globalVariables, activeEntities: [{ kind: 'column', columnId: 't' }, { kind: 'column', columnId: 'i' }] } }))
    expect(screen.queryByTestId('statistics-categorical-weight-companion')).toBeNull()
    expect(requests).toHaveLength(1)
  })

  it('shares one ordered mixed request and failure/retry while raw statistics and selections stay usable', async () => {
    const pending = deferred<ResponseBody>()
    let calls = 0
    const requests = transport(body => ++calls === 2 ? pending.promise : handmadeResponse(body))
    // Selection order differs from schema order; text/ID columns remain raw-only.
    const { local } = mount(localStore(handmadeBook, ['D', 'X', 'C', 'T', 'I']))
    await ready()
    const numeric = () => within(screen.getByTestId('statistics-weight-companion'))
    await waitFor(() => expect(numeric().getByRole('cell', { name: '55.000', exact: true })).toBeInTheDocument())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ columns: ['C', 'X', 'D'], weightMode: 'column', weightColumn: 'W' })
    const rawValues = rawSnapshot()
    expect(screen.getByTestId('statistics-raw-summary')).toHaveTextContent('45.000')
    expect(graphEngine.describeNumeric).toHaveBeenCalledTimes(1)
    update(local, state => ({ ...state, globalVariables: { ...state.globalVariables, weightColumnId: 'w2' } }))
    expect(numeric().queryByText('55.000')).toBeNull()
    expect(root().queryByRole('cell', { name: '100.0%', exact: true })).toBeNull()
    expect(rawSnapshot()).toEqual(rawValues)
    await waitFor(() => expect(requests).toHaveLength(2))
    await act(async () => { pending.reject({ code: 'MOCK_SHARED_FAILURE', message: '選択中のカテゴリを集計できません' }) })
    expect(root().getByRole('alert')).toHaveTextContent('カテゴリ加重集計に失敗しました')
    expect(root().getByRole('alert')).toHaveTextContent('選択中のカテゴリを集計できません')
    expect(numeric().getByRole('alert')).toHaveTextContent('数値加重集計に失敗しました')
    expect(numeric().getByRole('alert')).toHaveTextContent('選択中のカテゴリを集計できません')
    expect(rawSnapshot()).toEqual(rawValues)
    const raw = within(screen.getByTestId('question-card-C'))
    fireEvent.click(within(raw.getByTestId('category-C-2')).getByRole('button'))
    expect(local.getState().selection.selectedRowIds).toEqual(['r2', 'r3'])
    expect(requests).toHaveLength(2)
    fireEvent.click(root().getByRole('button', { name: '加重集計を再試行', exact: true }))
    await ready()
    expect(numeric().getByRole('cell', { name: '55.000', exact: true })).toBeInTheDocument()
    expect(requests).toHaveLength(3)
    expect(requests[2]).toEqual({ ...requests[0], weightColumn: 'W2' })
    expect(root().queryByRole('alert')).toBeNull()
    expect(numeric().queryByRole('alert')).toBeNull()
    expect(rawSnapshot()).toEqual(rawValues)
    expect(graphEngine.describeNumeric).toHaveBeenCalledTimes(1)
  })
})
