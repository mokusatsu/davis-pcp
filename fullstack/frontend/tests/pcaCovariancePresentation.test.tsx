import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { editorModalOpened } from '../src/features/dataset/codebookSlice'
import OrdinaryPcaPanel from '../src/features/pca/OrdinaryPcaPanel'
import SparsePcaPanel from '../src/features/pca/SparsePcaPanel'
import CovariancePage from '../src/features/covariance/CovariancePage'
import { makeSparsePcaResult } from './sparsePcaFixture'

// Keep the real picker, form controls and scope hooks; graph rendering has separate coverage.
vi.mock('../src/features/pca/ScreePlot', () => ({ ScreePlot: () => null }))
vi.mock('../src/features/pca/LoadingTable', () => ({ LoadingTable: () => null }))
vi.mock('../src/features/pca/BiplotView', () => ({ BiplotView: ({ pcaData }: any) => <div data-testid="biplot-result">{pcaData?.columns.join(',')}</div> }))
vi.mock('../src/features/pca/PcaMatrixPlot', () => ({ PcaMatrixPlot: ({ pcaData }: any) => <div data-testid="matrix-result">{pcaData?.columns.join(',')}</div> }))
vi.mock('../src/features/pca/SparsePcaScorePlot', () => ({ default: () => null }))
vi.mock('../src/features/pca/SparsePcaResultTables', () => ({ default: ({ result }: any) => <div data-testid="sparse-saved-result">{result.resultId}</div> }))
vi.mock('../src/features/charts/MatrixHeatmap', () => ({ default: ({ matrix }: any) => <div data-testid="covariance-result">{JSON.stringify(matrix)}</div> }))
vi.mock('../src/features/common/GraphPanel', () => ({ useGraphPopupContainer: () => undefined, default: ({ children, sizing, intrinsicSize }: any) =>
  <div data-testid="graph-shell" data-sizing={sizing} data-width={intrinsicSize?.width}>{children}</div> }))

const pages = [
  { Page: OrdinaryPcaPanel, role: '通常PCAの分析変数', testId: 'pca-columns-select', defaults: ['x', 'y'] },
  { Page: SparsePcaPanel, role: 'SparsePCAの分析変数', testId: 'sparse-pca-columns', defaults: ['x', 'y'] },
  { Page: CovariancePage, role: '共分散の対象列', testId: 'covariance-columns-select', defaults: ['x', 'y', 'ordinal'] },
]
function initialState() {
  const base = store.getState()
  const columns = ['x', 'y', 'ordinal', 'nominal', 'id', 'weight', 'ma', 'inactive'].map(name => ({
    name, columnId: `${name}-id`, label: `${name} question`, role: name === 'weight' ? 'weight' : name === 'id' ? 'id' : name === 'y' ? 'attribute' : 'question',
    scaleType: name === 'ordinal' ? 'ordinal' : name === 'nominal' ? 'nominal' : name === 'id' ? 'id' : name === 'y' ? 'interval' : 'ratio',
    multiResponseGroup: name === 'ma' ? 'group' : null, categoryOrder: ['1', '2'], valueLabels: {}, missingCodes: [], missingReasons: {}, isReversed: false,
  }))
  return { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'], selectedRowIds: [] },
    globalVariables: { ...base.globalVariables, allVariables: columns.map(c => c.name),
      activeEntities: columns.filter(c => c.name !== 'inactive').map(c => ({ kind: 'column', columnId: c.columnId })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns, isLoading: false, weightConfig: null, surveyDesign: null },
  } as any
}
function mount(Page: any, initial = initialState()) {
  const local = configureStore({ reducer: (state = initial, action: any) => action.type === 'test/replace' ? action.payload : state,
    middleware: g => g({ serializableCheck: false, immutableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  return { dispatch, ...render(<Provider store={local}><MemoryRouter><Page /></MemoryRouter></Provider>), local }
}
function replace(local: ReturnType<typeof mount>['local'], state: any) {
  act(() => { local.dispatch({ type: 'test/replace', payload: state }) })
}
async function picker(role: string) {
  fireEvent.click(screen.getByRole('button', { name: `${role}を選択`, exact: true }))
  return within(await screen.findByRole('dialog', { name: `${role}を選択`, exact: true }))
}
async function choose(role: string, names: string[]) {
  const dialog = await picker(role)
  const group = dialog.getByRole('group', { name: `${role}の検索結果` })
  for (const checkbox of within(group).getAllByRole('checkbox')) {
    const shouldCheck = names.some(name => checkbox.closest('label')?.textContent === `${name}${name} question`)
    if ((checkbox as HTMLInputElement).checked !== shouldCheck) fireEvent.click(checkbox)
  }
  fireEvent.click(dialog.getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}
function covarianceResponse(columns: string[]) {
  const diagonal = (value: number) => columns.map((_, i) => columns.map((__, j) => i === j ? value : 0))
  return { columns, covariance: diagonal(2), correlation: diagonal(1), partialCorrelation: diagonal(.5),
    diagnostics: { generalizedVariance: 1, totalVariance: 6, conditionNumber: 1, isSingular: false } }
}
beforeEach(() => {
  vi.spyOn(api, 'post').mockImplementation(async (url, body: any) => url === '/statistics/covariance'
    ? covarianceResponse(body.columns) : url === '/models/sparse-pca' ? makeSparsePcaResult() : { columns: body.columns, nComponents: 2, eigenvalues: [2, 1] } as any)
  vi.spyOn(api, 'get').mockResolvedValue({ resultId: 'saved-spca-result', axes: [1, 2], total: 0, nextOffset: null, rows: [] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(pages)('$role has a contained, purpose-named picker and preserves eligible defaults', async ({ Page, role, testId, defaults }) => {
  mount(Page)
  const input = screen.getByRole('combobox', { name: role })
  const help = document.getElementById(input.getAttribute('aria-describedby')!)!
  expect(help).toHaveTextContent('質問・属性')
  expect(help).toHaveTextContent('順序・間隔・比例')
  expect(help).toHaveTextContent('非MA')
  expect(screen.getByTestId(testId).closest('.column-select-multi-wrap')).toHaveStyle({ width: '100%', minWidth: '0' })
  expect(input.closest('.analysis-field')).not.toBeNull()
  const dialog = await picker(role)
  expect(dialog.getByRole('textbox', { name: `${role}を変数名・質問文で絞り込み` })).toBeInTheDocument()
  const choices = within(dialog.getByRole('group', { name: `${role}の検索結果` })).getAllByRole('checkbox')
  expect(choices.map(c => c.closest('label')?.textContent)).toEqual(['xx question', 'yy question', 'ordinalordinal question'])
  expect(choices.filter(c => (c as HTMLInputElement).checked).map(c => c.closest('label')?.textContent)).toEqual(defaults.map(n => `${n}${n} question`))
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'no matching column' } })
  expect(dialog.getByText(/検索条件を変更または解除してください/)).toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'コードブックを開く' })).not.toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: 'キャンセル' }))
})

it.each(pages)('$role keeps explicit empty common selection empty and offers accurate codebook recovery', async ({ Page, role }) => {
  const initial = initialState(); initial.globalVariables.activeEntities = []
  const { dispatch } = mount(Page, initial)
  const dialog = await picker(role)
  expect(dialog.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(dialog.getByText(/共通の有効変数とコードブックの役割・尺度・MAグループ/)).toBeInTheDocument()
  expect(api.post).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: 'コードブックを開く' }))
  expect(dispatch).toHaveBeenCalledWith(editorModalOpened())
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(api.post).not.toHaveBeenCalled()
})

it('uses independent native projection groups, changes only display, and retains a result after draft edits and failed rerun', async () => {
  const { local } = mount(OrdinaryPcaPanel)
  const group = screen.getByRole('radiogroup', { name: '通常PCAの射影ビュー' })
  expect(group.closest('.analysis-setup')).not.toBeNull()
  const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
  expect(radios[0].name).toBeTruthy(); expect(radios[1].name).toBe(radios[0].name)
  expect((screen.getByRole('radio', { name: '相関行列 (標準化)' }) as HTMLInputElement).name).not.toBe(radios[0].name)
  fireEvent.click(screen.getByTestId('pca-run-button'))
  await waitFor(() => expect(screen.getByTestId('biplot-result')).toHaveTextContent('x,y'))
  fireEvent.click(radios[1]); expect(screen.getByTestId('matrix-result')).toHaveTextContent('x,y')
  expect(api.post).toHaveBeenCalledTimes(1)
  await choose('通常PCAの分析変数', ['x', 'ordinal'])
  expect(screen.getByText('実行時の対象・設定を保持しています。現在の入力で計算するには再実行してください。')).toBeInTheDocument()
  expect(screen.getByTestId('matrix-result')).toHaveTextContent('x,y')
  vi.mocked(api.post).mockRejectedValueOnce(new Error('rerun failed'))
  fireEvent.click(screen.getByTestId('pca-run-button'))
  await screen.findByText('rerun failed')
  expect(api.post).toHaveBeenLastCalledWith('/models/pca', expect.objectContaining({ columns: ['x', 'ordinal'], useCorrelation: true }))
  expect(screen.getByTestId('matrix-result')).toHaveTextContent('x,y')
  const next = initialState(); next.globalVariables.activeEntities = [{ kind: 'column', columnId: 'x-id' }]
  replace(local, next)
  expect(screen.getByTestId('pca-run-button')).toBeDisabled()
  expect(screen.queryByText('使用できなくなった変数があります。分析変数を選び直してください。')).not.toBeInTheDocument()
})

it('gives simultaneous ordinary panels distinct native radio names', () => {
  mount(() => <><OrdinaryPcaPanel /><OrdinaryPcaPanel /></>)
  const groups = screen.getAllByRole('radiogroup', { name: '通常PCAの射影ビュー' })
  expect((within(groups[0]).getAllByRole('radio')[0] as HTMLInputElement).name)
    .not.toBe((within(groups[1]).getAllByRole('radio')[0] as HTMLInputElement).name)
})

it('preserves Sparse ordinal acknowledgement, column IDs, and unavailable-selection repair', async () => {
  const { local } = mount(SparsePcaPanel)
  await choose('SparsePCAの分析変数', ['x', 'ordinal'])
  expect(screen.getByTestId('sparse-pca-run')).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: /固定したカテゴリ順/ }))
  fireEvent.click(screen.getByTestId('sparse-pca-run'))
  await screen.findByTestId('sparse-saved-result')
  expect(api.post).toHaveBeenLastCalledWith('/models/sparse-pca', expect.objectContaining({
    variables: [{ columnId: 'x-id', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null },
      { columnId: 'ordinal-id', kind: 'numeric', ordinalAsNumericAcknowledged: true, score: 'ordered_rank' }],
    preprocessing: 'correlation', nComponents: 2, alpha: 1, ridgeAlpha: .01, tolerance: 1e-8, maxIterations: 1000, seed: 0,
  }))
  const next = initialState(); next.globalVariables.activeEntities = ['x-id', 'y-id'].map(columnId => ({ kind: 'column', columnId }))
  replace(local, next)
  expect(screen.getByTestId('sparse-pca-run')).toBeDisabled()
  expect(screen.getByText('使用できなくなった変数があります。分析変数を選び直してください。')).toBeInTheDocument()
  expect(screen.getByTestId('sparse-saved-result')).toHaveTextContent('saved-spca-result')
  // Unavailable chosen IDs remain until the user explicitly replaces the choice.
  replace(local, initialState())
  await choose('SparsePCAの分析変数', ['x', 'y'])
  expect(screen.getByTestId('sparse-pca-run')).toBeEnabled()
  vi.mocked(api.post).mockRejectedValueOnce(new Error('sparse rerun failed'))
  fireEvent.click(screen.getByTestId('sparse-pca-run'))
  await screen.findByText('sparse rerun failed')
  expect(screen.getByTestId('sparse-saved-result')).toHaveTextContent('saved-spca-result')
  expect(screen.getByTestId('sparse-pca-dirty')).toBeInTheDocument()
})

it('keeps Sparse numeric input semantics while allowing long setting labels to wrap', () => {
  mount(SparsePcaPanel)
  expect(screen.getByRole('spinbutton', { name: 'ridgeAlpha（得点の安定化）' }).closest('label')).toHaveStyle({ flexWrap: 'wrap', maxWidth: '100%' })
  const count = screen.getByTestId('sparse-pca-nComponents')
  fireEvent.change(count, { target: { value: '1.5' } }); fireEvent.blur(count)
  expect(count).toHaveValue('1.5'); expect(screen.getByTestId('sparse-pca-run')).toBeDisabled()
  fireEvent.change(count, { target: { value: '' } }); fireEvent.blur(count)
  expect(count).toHaveValue(''); expect(screen.getByTestId('sparse-pca-run')).toBeDisabled()
  fireEvent.change(count, { target: { value: '2' } }); fireEvent.blur(count)
  expect(screen.getByTestId('sparse-pca-run')).toBeEnabled()
  expect(api.post).not.toHaveBeenCalled()
})

it('keeps covariance live recomputation separate from display mode and preserves intrinsic chart sizing', async () => {
  mount(CovariancePage)
  await screen.findByTestId('covariance-result')
  expect(api.post).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: /実行/ })).not.toBeInTheDocument()
  expect(screen.getByTestId('graph-shell')).toHaveAttribute('data-sizing', 'intrinsic')
  expect(screen.getByTestId('graph-shell')).toHaveAttribute('data-width', '560')
  fireEvent.click(screen.getByRole('radio', { name: '偏相関行列 (Partial Correlation)' }))
  expect(screen.getByTestId('covariance-result')).toHaveTextContent('0.5')
  expect(api.post).toHaveBeenCalledTimes(1)
  await choose('共分散の対象列', ['x', 'ordinal'])
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(api.post).toHaveBeenLastCalledWith('/statistics/covariance', expect.objectContaining({ columns: ['x', 'ordinal'], rowIds: ['r1', 'r2'], expectedSchemaRevision: 2, expectedDataRevision: 3 }))
  expect(screen.getByRole('radio', { name: '偏相関行列 (Partial Correlation)' })).toBeChecked()
  await choose('共分散の対象列', [])
  expect(screen.getByText('最低2つの数値列を選択してください。')).toBeInTheDocument()
  expect(api.post).toHaveBeenCalledTimes(2)
})

it('retains covariance first-eight defaults including ordinal columns', async () => {
  const initial = initialState()
  initial.codebook.columns = Array.from({ length: 10 }, (_, index) => ({ ...initial.codebook.columns[0], name: `v${index}`, columnId: `v${index}-id`, scaleType: index === 0 ? 'ordinal' : 'ratio' }))
  initial.globalVariables.activeEntities = null
  mount(CovariancePage, initial)
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/statistics/covariance', expect.objectContaining({ columns: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'] })))
})
