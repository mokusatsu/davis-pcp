import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { api, type CodebookColumn } from '../src/api/client'
import { store } from '../src/app/store'
import { codebookSlice, editorModalOpened } from '../src/features/dataset/codebookSlice'
import FactorAnalysisPage from '../src/features/models/FactorAnalysisPage'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import FamdPage from '../src/features/models/FamdPage'

// Exercise the real page fields, ColumnSelect dialogs, searches, checkboxes and
// Codebook reducer. No analysis or chart data is needed for picker guidance.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))

function column(name: string, scaleType: CodebookColumn['scaleType'], extra: Partial<CodebookColumn> = {}): CodebookColumn {
  return { columnId: `${name}-id`, name, label: name, scaleType, role: 'question', multiResponseGroup: null,
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false, ...extra }
}
const columns = [
  column('Numeric', 'ratio'), column('Interval', 'interval'),
  column('Ordered', 'ordinal', { categoryOrder: ['1', '2', '3'] }), column('Category', 'nominal'),
  column('HiddenNumeric', 'ratio'), column('HiddenCategory', 'nominal'),
  column('Weight', 'ratio', { role: 'weight' }), column('Text', 'text'), column('ID', 'id', { role: 'id' }),
  column('MA1', 'nominal', { multiResponseGroup: 'g' }), column('MA2', 'nominal', { multiResponseGroup: 'g' }),
  column('MAOrdered', 'ordinal', { multiResponseGroup: 'g' }), column('MANumeric', 'ratio', { multiResponseGroup: 'g' }),
]
const active = ['Numeric', 'Interval', 'Ordered', 'Category', 'Weight', 'Text', 'ID']
type Page = 'efa' | 'mca' | 'famd'
const pickers = [
  { page: 'efa' as Page, id: 'efa-items', role: 'EFAの分析項目', field: '項目（必須・3つ以上）',
    eligible: ['Numeric (Numeric)', 'Interval (Interval)', 'Ordered (Ordered)', 'HiddenNumeric (HiddenNumeric)', 'Weight (Weight)'],
    first: 'Numeric (Numeric)', second: 'Interval (Interval)',
    emptyReason: '分析項目に使える順序・間隔・比例尺度の列がありません。', recovery: '順序尺度ではカテゴリ順序も確認してください。' },
  { page: 'mca' as Page, id: 'mca-variables', role: 'MCAの分析変数', field: '分析変数（2つ以上）',
    eligible: ['Ordered', 'Category'], first: 'Ordered', second: 'Category',
    emptyReason: '現在の共通選択内に使える名義・順序尺度の列がありません。', recovery: 'MA子を使用する場合は詳細設定で明示選択してください。' },
  { page: 'mca' as Page, id: 'mca-ma-variables', role: 'MCAのMA子変数', field: 'MA子変数（任意・明示採用）',
    eligible: ['MA1 [MA]', 'MA2 [MA]'], first: 'MA1 [MA]', second: 'MA2 [MA]',
    emptyReason: '選択できる名義尺度のMA子列がありません。', recovery: 'MAを使わない場合は「通常のみ」に戻せます。' },
  { page: 'famd' as Page, id: 'famd-numeric', role: 'FAMDの数値列', field: '数値列',
    eligible: ['Numeric', 'Interval', 'Weight'], first: 'Numeric', second: 'Interval',
    emptyReason: '現在の共通選択内に使える間隔・比例尺度の列がありません。', recovery: '順序尺度の列はカテゴリ列から選択します。' },
  { page: 'famd' as Page, id: 'famd-categorical', role: 'FAMDのカテゴリ列', field: 'カテゴリ列',
    eligible: ['Ordered', 'Category'], first: 'Ordered', second: 'Category',
    emptyReason: '現在の共通選択内に使える名義・順序尺度の列がありません。', recovery: '順序尺度はカテゴリとして扱います。' },
]
type Picker = typeof pickers[number]

function mount(page: Page, options: { columns?: CodebookColumn[]; active?: string[] } = {}) {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1, allRowIds: ['r1', 'r2', 'r3'], activeRowIds: ['r1', 'r2', 'r3'] },
    globalVariables: { ...base.globalVariables, activeEntities: (options.active ?? active).map(name => ({ kind: 'column' as const, columnId: `${name}-id` })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns: options.columns ?? columns, isLoading: false },
  }
  const local = configureStore({ reducer: (current = state, action: any) => ({ ...current,
    codebook: codebookSlice.reducer(current.codebook, action),
    globalVariables: action.type === 'test/active' ? { ...current.globalVariables, activeEntities: action.payload } : current.globalVariables,
  }), middleware: get => get({ serializableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    {page === 'efa' ? <FactorAnalysisPage /> : page === 'mca' ? <MultipleCorrespondencePage /> : <FamdPage />}
  </Provider></ConfigProvider>)
  return { ...view, local, dispatch }
}
function enableMa() {
  const details = screen.getByText('詳細設定', { selector: '.analysis-settings-title' }).closest('details')!
  act(() => { details.open = true })
  fireEvent.click(screen.getByRole('radio', { name: 'MA子を含める' }))
}
function prepare(picker: Picker) { if (picker.id === 'mca-ma-variables') enableMa() }
async function openPicker(picker: Picker) {
  fireEvent.click(screen.getByRole('button', { name: `${picker.role}を選択`, exact: true }))
  const search = await screen.findByRole('textbox', { name: `${picker.role}を変数名・質問文で絞り込み` })
  // rc-util assigns a shared title ID in test mode. Search names also identify
  // the correct retained dialog when another picker was opened earlier.
  const dialog = search.closest('[role="dialog"]') as HTMLElement
  await waitFor(() => expect(dialog).toBeVisible())
  return { dialog, search, results: within(dialog).getByRole('group', { name: `${picker.role}の検索結果` }) }
}
async function closePicker(dialog: HTMLElement, commit = false) {
  fireEvent.click(within(dialog).getByRole('button', { name: commit ? /決\s*定/ : 'キャンセル' }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}
function emptyOptions(picker: Picker) {
  if (picker.page === 'efa') return { columns: columns.filter(c => ['nominal', 'text', 'id'].includes(c.scaleType) || Boolean(c.multiResponseGroup)) }
  if (picker.id === 'mca-ma-variables') return { columns: columns.filter(c => !c.multiResponseGroup || c.scaleType !== 'nominal') }
  return { active: picker.id === 'famd-numeric' ? ['Category'] : ['Numeric'] }
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  vi.spyOn(api, 'get').mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(pickers)('$role names its button, dialog, search and results without changing eligibility', async picker => {
  mount(picker.page); prepare(picker)
  const field = screen.getByRole('combobox', { name: picker.field })
  expect(field).toHaveAttribute('id', picker.id)
  expect(field).toHaveAttribute('aria-describedby', `${picker.id}-help`)
  expect(field).toHaveAccessibleDescription()
  expect(screen.getByRole('button', { name: `${picker.role}を選択` })).toHaveAttribute('title', `${picker.role}を選択`)
  expect(screen.queryByRole('button', { name: '変数を選択' })).toBeNull()
  const { dialog, results } = await openPicker(picker)
  expect(dialog).toHaveAccessibleName(`${picker.role}を選択`)
  expect(within(results).getAllByRole('checkbox')).toHaveLength(picker.eligible.length)
  for (const name of picker.eligible) expect(within(results).getByRole('checkbox', { name, exact: true })).toBeInTheDocument()
  expect(within(dialog).queryByRole('button', { name: 'コードブックを開く' })).toBeNull()
})

it.each(pickers)('$role explains full-options emptiness in the dropdown and dialog and opens Codebook', async picker => {
  const { local, dispatch } = mount(picker.page, emptyOptions(picker)); prepare(picker)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: picker.field }))
  const guide = await screen.findByText(picker.emptyReason, { exact: false })
  expect(guide).toHaveTextContent(picker.recovery)
  const { dialog } = await openPicker(picker)
  expect(within(dialog).getByText(picker.emptyReason, { exact: false })).toHaveTextContent(picker.recovery)
  expect(within(dialog).queryByText('検索条件を変更または解除してください')).toBeNull()
  if (picker.page === 'efa' || picker.id === 'mca-ma-variables') expect(dialog).not.toHaveTextContent('共通選択で対象列を含め')
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
  expect(dispatch).toHaveBeenCalledWith(editorModalOpened())
  expect(local.getState().codebook.isEditorOpen).toBe(true)
  await waitFor(() => expect(dialog).not.toBeVisible())
})

it.each(pickers)('$role distinguishes a search miss and preserves committed choices through cancellation', async picker => {
  mount(picker.page); prepare(picker)
  const first = await openPicker(picker)
  fireEvent.click(within(first.results).getByRole('checkbox', { name: picker.first, exact: true }))
  await closePicker(first.dialog, true)
  const draft = await openPicker(picker)
  fireEvent.click(within(draft.results).getByRole('checkbox', { name: picker.second, exact: true }))
  expect(within(draft.dialog).getByRole('status')).toHaveTextContent('2件選択中')
  await closePicker(draft.dialog)
  const retained = await openPicker(picker)
  expect(within(retained.results).getByRole('checkbox', { name: picker.first, exact: true })).toBeChecked()
  expect(within(retained.results).getByRole('checkbox', { name: picker.second, exact: true })).not.toBeChecked()
  fireEvent.change(retained.search, { target: { value: 'no-matching-variable' } })
  expect(within(retained.dialog).getByText('検索条件を変更または解除してください', { exact: false })).toBeVisible()
  expect(within(retained.dialog).queryByRole('button', { name: 'コードブックを開く' })).toBeNull()
  expect(within(retained.dialog).queryByText(picker.emptyReason, { exact: false })).toBeNull()
  expect(within(retained.dialog).getByRole('status')).toHaveTextContent('1件選択中（検索結果外 1件）')
  fireEvent.change(retained.search, { target: { value: '' } })
  expect(within(retained.results).getByRole('checkbox', { name: picker.first, exact: true })).toBeChecked()
})

it('keeps EFA independent of the common variable selection and keeps explicit MA children outside the ordinary MCA picker', async () => {
  const efa = mount('efa', { active: [] })
  const efaPicker = await openPicker(pickers[0])
  expect(within(efaPicker.results).getAllByRole('checkbox')).toHaveLength(5)
  await closePicker(efaPicker.dialog); efa.unmount()
  mount('mca', { active: [] }); enableMa()
  const ordinary = await openPicker(pickers[1])
  expect(within(ordinary.results).queryByRole('checkbox')).toBeNull()
  await closePicker(ordinary.dialog)
  const ma = await openPicker(pickers[2])
  expect(within(ma.results).getAllByRole('checkbox')).toHaveLength(2)
  fireEvent.click(within(ma.results).getByRole('checkbox', { name: 'MA1 [MA]' }))
  fireEvent.click(within(ma.results).getByRole('checkbox', { name: 'MA2 [MA]' }))
  await closePicker(ma.dialog, true)
  expect(screen.getByTestId('mca-run')).toBeEnabled()
  fireEvent.click(screen.getByRole('radio', { name: '通常のみ' }))
  expect(screen.getByTestId('mca-run')).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'MA子を含める' }))
  expect(screen.getByTestId('mca-run')).toBeEnabled()
  const restored = await openPicker(pickers[2])
  for (const checkbox of within(restored.results).getAllByRole('checkbox')) expect(checkbox).toBeChecked()
})

it('retains FAMD values excluded by a later common selection while keeping both input kinds required', async () => {
  const { local } = mount('famd')
  const numeric = await openPicker(pickers[3])
  fireEvent.click(within(numeric.results).getByRole('checkbox', { name: 'Numeric', exact: true }))
  await closePicker(numeric.dialog, true)
  expect(screen.getByTestId('famd-run')).toBeDisabled()
  const category = await openPicker(pickers[4])
  fireEvent.click(within(category.results).getByRole('checkbox', { name: 'Ordered', exact: true }))
  await closePicker(category.dialog, true)
  expect(screen.getByTestId('famd-run')).toBeEnabled()
  act(() => { local.dispatch({ type: 'test/active', payload: [{ kind: 'column', columnId: 'Ordered-id' }] }) })
  expect(screen.getByTestId('famd-run')).toBeDisabled()
  const retained = await openPicker(pickers[3])
  expect(within(retained.dialog).getByText(pickers[3].emptyReason, { exact: false })).toBeVisible()
  expect(within(retained.dialog).getByRole('status')).toHaveTextContent('1件選択中（検索結果外 1件）')
  await closePicker(retained.dialog)
  act(() => { local.dispatch({ type: 'test/active', payload: ['Numeric-id', 'Ordered-id'].map(columnId => ({ kind: 'column', columnId })) }) })
  expect(screen.getByTestId('famd-run')).toBeEnabled()
  const restored = await openPicker(pickers[3])
  expect(within(restored.results).getByRole('checkbox', { name: 'Numeric', exact: true })).toBeChecked()
})
