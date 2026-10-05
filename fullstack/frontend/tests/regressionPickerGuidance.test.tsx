import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CodebookColumn } from '../src/api/client'
import { store } from '../src/app/store'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'
import RegularizedRegressionPanel from '../src/features/models/RegularizedRegressionPanel'
import ConjointPage from '../src/features/models/ConjointPage'

// Keep the pages, ColumnSelect, codebook lookup, native modal radios and Ant Design
// controls real. Selector behavior does not need result charts or backend data.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))

function column(name: string, scaleType: CodebookColumn['scaleType'], label = name,
  multiResponseGroup: string | null = null): CodebookColumn {
  return { columnId: name, name, label, scaleType, multiResponseGroup,
    role: name === 'Identifier' || name === 'Z' ? 'id' : 'question', valueLabels: {},
    categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false }
}
const columns = [
  column('Outcome', 'ratio'), column('X', 'ratio', '価格'), column('Z', 'interval', '容量'),
  column('Group', 'nominal', 'ブランド'), column('Ordered', 'ordinal', '段階'),
  column('Identifier', 'id'), column('FreeText', 'text'), column('Inactive', 'ratio'),
  column('MA_CAT', 'nominal', '複数回答カテゴリ', 'ma'), column('MA_NUM', 'ratio', '複数回答数値', 'ma'),
]
const activeColumns = ['Outcome', 'X', 'Z', 'Group', 'Ordered']
type Page = 'ols' | 'regularized' | 'conjoint'
function mount(page: Page, empty = false) {
  const base = store.getState()
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'picker-guidance', dataRevision: 1 },
    globalVariables: { ...base.globalVariables, activeEntities: (empty ? [] : activeColumns)
      .map(columnId => ({ kind: 'column' as const, columnId })) },
    codebook: { ...base.codebook, datasetId: 'picker-guidance', schemaRevision: 1, isLoading: false,
      isEditorOpen: false, columns: empty && page === 'conjoint' ? columns.filter(c => c.multiResponseGroup) : columns },
  }
  const local = configureStore({ reducer: (state = initial, action) => ({ ...state,
    codebook: codebookSlice.reducer(state.codebook, action) }) })
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    {page === 'ols' ? <LinearRegressionPage /> : page === 'regularized' ? <RegularizedRegressionPanel /> : <ConjointPage />}
  </Provider></ConfigProvider>)
  return { ...view, local }
}
function openDetails(title?: string) {
  if (title) act(() => { screen.getByText(title, { exact: true }).closest('details')!.open = true })
}
async function picker(purpose: string) {
  const button = screen.getByRole('button', { name: `${purpose}を選択`, exact: true })
  expect(button).toHaveAttribute('title', `${purpose}を選択`)
  fireEvent.click(button)
  // rc-util uses duplicate title IDs in test mode for retained modal instances.
  // Locate the active modal by its uniquely named input; assert the actual title
  // and test accessible dialog names independently before opening other pickers.
  const search = await screen.findByRole('textbox', { name: `${purpose}を変数名・質問文で絞り込み`, exact: true })
  const dialog = search.closest<HTMLElement>('[role="dialog"]')!
  await waitFor(() => expect(dialog).toBeVisible())
  expect(within(dialog).getByText(`${purpose}を選択`, { exact: true })).toBeVisible()
  return { dialog, search,
    results: within(dialog).getByLabelText(`${purpose}の検索結果`, { exact: true }) }
}
async function finish(dialog: HTMLElement, commit = true) {
  fireEvent.click(within(dialog).getByRole('button', { name: commit ? /決\s*定/ : 'キャンセル' }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}
function choose(results: HTMLElement, name: string) {
  fireEvent.click(within(results).getByText(name, { exact: true }).closest('label')!)
}
async function choosePredictors(page: Page) {
  const purpose = page === 'conjoint' ? 'コンジョイントの線形属性' : '重回帰の数値説明変数'
  const { dialog, results } = await picker(purpose)
  choose(results, 'X'); choose(results, 'Z')
  await finish(dialog)
}

type PickerCase = {
  page: Page
  id: string
  purpose: string
  inputLabel: string
  reason: string
  guidance: string
  eligible: string[]
  multiple?: boolean
  details?: string
  dependent?: boolean
}
const regressionCases: PickerCase[] = (['ols', 'regularized'] as const).flatMap(page => {
  const prefix = page === 'ols' ? '重回帰' : '正則化'
  const id = page === 'ols' ? 'lr' : 'rr'
  return [
    { page, id: `${id}-target`, purpose: `${prefix}の目的変数`, inputLabel: page === 'ols' ? '目的変数' : '正則化の目的変数',
      reason: '目的変数の候補がありません。', guidance: '間隔・比率尺度の単一列', eligible: ['Outcome', 'X', 'Z'] },
    { page, id: `${id}-numeric`, purpose: `${prefix}の数値説明変数`, inputLabel: page === 'ols' ? '数値説明変数' : '正則化の数値説明変数', multiple: true,
      reason: '数値説明変数の候補がありません。', guidance: '間隔・比率・順序尺度の単一列', eligible: ['Outcome', 'X', 'Z', 'Ordered'] },
    { page, id: `${id}-categorical`, purpose: `${prefix}のカテゴリ説明変数`, inputLabel: page === 'ols' ? 'カテゴリ説明変数' : '正則化のカテゴリ説明変数', multiple: true,
      reason: 'カテゴリ説明変数の候補がありません。', guidance: '名義・順序尺度の単一列', eligible: ['Group', 'Ordered'] },
  ]
})
const structural = ['Outcome', 'X', 'Z', 'Group', 'Ordered', 'Identifier', 'FreeText', 'Inactive']
const cases: PickerCase[] = [
  ...regressionCases,
  ...(['first', 'second'] as const).map((suffix, i) => ({ page: 'ols' as const, id: `lr-interaction-${suffix}`,
    purpose: `重回帰の交互作用の変数${i + 1}`, inputLabel: `変数${i + 1}`, reason: `交互作用の変数${i + 1}の候補がありません。`,
    guidance: '先に数値説明変数またはカテゴリ説明変数を選択してください。', eligible: ['価格', '容量'],
    details: '回帰の詳細設定', dependent: true })),
  { page: 'conjoint', id: 'cj-respondent', purpose: 'コンジョイントの回答者ID列', inputLabel: '回答者ID列',
    reason: '回答者ID列の候補がありません。', guidance: '複数回答（MA）に属さない列', eligible: structural },
  { page: 'conjoint', id: 'cj-task', purpose: 'コンジョイントのタスク列', inputLabel: 'タスク列',
    reason: 'タスク列の候補がありません。', guidance: '複数回答（MA）に属さない列', eligible: structural },
  { page: 'conjoint', id: 'cj-alternative', purpose: 'コンジョイントの代替案列', inputLabel: '代替案列',
    reason: '代替案列の候補がありません。', guidance: '複数回答（MA）に属さない列', eligible: structural },
  { page: 'conjoint', id: 'cj-response', purpose: 'コンジョイントの応答列', inputLabel: '応答列',
    reason: '応答列の候補がありません。', guidance: '回答形式に合う値を持つ列', eligible: structural },
  { page: 'conjoint', id: 'cj-categorical', purpose: 'コンジョイントのカテゴリ属性', inputLabel: 'カテゴリ属性', multiple: true,
    reason: 'カテゴリ属性の候補がありません。', guidance: '名義・順序尺度', eligible: ['Group', 'Ordered'] },
  { page: 'conjoint', id: 'cj-linear', purpose: 'コンジョイントの線形属性', inputLabel: '線形属性', multiple: true,
    reason: '線形属性の候補がありません。', guidance: '間隔・比率尺度', eligible: ['Outcome', 'X', 'Z', 'Inactive'] },
  { page: 'conjoint', id: 'cj-available', purpose: 'コンジョイントの利用可能性列', inputLabel: '利用可能性（availability）列',
    reason: '利用可能性列の候補がありません。', guidance: '未指定なら全案を利用可能とします。', eligible: structural, details: 'モデルの詳細設定' },
  { page: 'conjoint', id: 'cj-optout', purpose: 'コンジョイントの選択しない案の列', inputLabel: '選択しない案（opt-out）列',
    reason: '選択しない案の列の候補がありません。', guidance: '「どれも選ばない」案がなければ未指定で構いません。', eligible: structural, details: 'モデルの詳細設定' },
  { page: 'conjoint', id: 'cj-price', purpose: 'コンジョイントの価格属性', inputLabel: '価格属性',
    reason: '価格属性の候補がありません。', guidance: '先に「線形属性」で価格列を選択してください。', eligible: ['価格 (X)', '容量 (Z)'],
    details: '価格・支払意思額（WTP）', dependent: true },
]

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => { vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element)) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(cases)('names $purpose controls distinctly and preserves actual eligibility and ordinary search recovery', async testCase => {
  mount(testCase.page)
  if (testCase.dependent) await choosePredictors(testCase.page)
  openDetails(testCase.details)
  const input = screen.getByRole('combobox', { name: testCase.inputLabel, exact: true })
  expect(input).toHaveAttribute('id', testCase.id)
  if (!testCase.id.startsWith('lr-interaction')) {
    expect(input).toHaveAttribute('aria-describedby', `${testCase.id}-help`)
    expect(input).toHaveAccessibleDescription(document.getElementById(`${testCase.id}-help`)!.textContent!)
  }
  expect(screen.queryByRole('button', { name: '変数を選択', exact: true })).toBeNull()
  const { dialog, results, search } = await picker(testCase.purpose)
  if (!testCase.dependent) expect(dialog).toHaveAccessibleName(`${testCase.purpose}を選択`)
  expect(results).toHaveAttribute('role', testCase.multiple ? 'group' : 'radiogroup')
  expect(within(results).getAllByRole(testCase.multiple ? 'checkbox' : 'radio')).toHaveLength(testCase.eligible.length)
  for (const name of testCase.eligible) expect(within(results).getByText(name, { exact: true })).toBeVisible()
  expect(results).not.toHaveTextContent('MA_CAT')
  expect(results).not.toHaveTextContent('MA_NUM')
  fireEvent.change(search, { target: { value: 'no-such-column' } })
  expect(results).toHaveTextContent('該当する変数がありません')
  expect(results).toHaveTextContent('検索条件を変更または解除してください')
  expect(within(dialog).queryByRole('button', { name: 'コードブックを開く' })).toBeNull()
  expect(results).not.toHaveTextContent(testCase.reason)
  fireEvent.change(search, { target: { value: '' } })
  expect(within(results).getAllByRole(testCase.multiple ? 'checkbox' : 'radio')).toHaveLength(testCase.eligible.length)
  await finish(dialog, false)
})

it.each(cases)('explains truly empty $purpose candidates and opens the existing Codebook editor', async testCase => {
  // Dependent pickers are empty even with eligible columns until the user chooses
  // predictors/linear attributes. Conjoint has no common-active filter at all.
  const { local } = mount(testCase.page, !testCase.dependent)
  openDetails(testCase.details)
  const { dialog, results } = await picker(testCase.purpose)
  expect(dialog).toHaveAccessibleName(`${testCase.purpose}を選択`)
  expect(results).toHaveTextContent(testCase.reason)
  expect(results).toHaveTextContent(testCase.guidance)
  expect(results).toHaveTextContent('コードブック')
  if (testCase.page === 'conjoint') expect(results).not.toHaveTextContent('共通の')
  else expect(results).toHaveTextContent('共通の変数選択')
  expect(results).not.toHaveTextContent('検索条件を変更または解除してください')
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く', exact: true }))
  expect(local.getState().codebook.isEditorOpen).toBe(true)
  await waitFor(() => expect(dialog).not.toBeVisible())
})

it.each(cases.filter(testCase => ['lr-target', 'rr-target', 'cj-respondent'].includes(testCase.id)))(
  'also shows empty $purpose guidance in the ordinary dropdown', async testCase => {
    const { local } = mount(testCase.page, true)
    fireEvent.mouseDown(screen.getByRole('combobox', { name: testCase.inputLabel, exact: true }))
    const dropdown = await waitFor(() => {
      const popup = document.querySelector<HTMLElement>('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      expect(popup).not.toBeNull()
      expect(popup).toHaveTextContent(testCase.reason)
      return popup!
    })
    expect(dropdown).toHaveTextContent(testCase.guidance)
    fireEvent.click(within(dropdown).getByRole('button', { name: 'コードブックを開く', exact: true }))
    expect(local.getState().codebook.isEditorOpen).toBe(true)
    await waitFor(() => expect(dropdown).not.toBeVisible())
  },
)

it.each(regressionCases.filter(testCase => testCase.id.endsWith('target') || testCase.id.endsWith('numeric')).concat(
  cases.filter(testCase => testCase.id === 'cj-respondent' || testCase.id === 'cj-linear'),
))('retains committed $purpose choices through filtering, cancel and reopen', async testCase => {
  mount(testCase.page)
  let current = await picker(testCase.purpose)
  choose(current.results, 'X')
  await finish(current.dialog)
  current = await picker(testCase.purpose)
  const first = within(current.results).getByText('X', { exact: true }).closest('label')!.querySelector('input')!
  expect(first).toBeChecked()
  fireEvent.change(current.search, { target: { value: 'Z' } })
  expect(within(current.dialog).getByRole('status')).toHaveTextContent('1件選択中（検索結果外 1件）')
  choose(current.results, 'Z')
  await finish(current.dialog, false)
  current = await picker(testCase.purpose)
  expect(current.search).toHaveValue('')
  expect(within(current.results).getByText('X', { exact: true }).closest('label')!.querySelector('input')).toBeChecked()
  expect(within(current.results).getByText('Z', { exact: true }).closest('label')!.querySelector('input')).not.toBeChecked()
  choose(current.results, 'Z')
  await finish(current.dialog)
  current = await picker(testCase.purpose)
  expect(within(current.results).getByText('Z', { exact: true }).closest('label')!.querySelector('input')).toBeChecked()
  const retainedX = within(current.results).getByText('X', { exact: true }).closest('label')!.querySelector('input')!
  if (testCase.multiple) expect(retainedX).toBeChecked()
  else expect(retainedX).not.toBeChecked()
  await finish(current.dialog, false)
})

it.each(cases.filter(testCase => ['cj-available', 'cj-optout', 'cj-price'].includes(testCase.id)))(
  'keeps optional $purpose clear actions through commit and reopen', async testCase => {
    mount('conjoint')
    if (testCase.dependent) await choosePredictors('conjoint')
    openDetails(testCase.details)
    let current = await picker(testCase.purpose)
    choose(current.results, testCase.eligible[0])
    await finish(current.dialog)
    current = await picker(testCase.purpose)
    expect(within(current.dialog).getByRole('status')).toHaveTextContent('1件選択中')
    fireEvent.click(within(current.dialog).getByRole('button', { name: '選択解除', exact: true }))
    await finish(current.dialog)
    current = await picker(testCase.purpose)
    expect(within(current.dialog).getByRole('status')).toHaveTextContent('0件選択中')
    await finish(current.dialog, false)
  },
)

it('disables Conjoint opt-out in ratings mode and keeps it cleared on returning to choice mode', async () => {
  mount('conjoint')
  openDetails('モデルの詳細設定')
  const purpose = 'コンジョイントの選択しない案の列'
  let current = await picker(purpose)
  choose(current.results, 'Identifier')
  await finish(current.dialog)
  fireEvent.click(screen.getByRole('radio', { name: '評点', exact: true }))
  expect(screen.getByRole('button', { name: `${purpose}を選択`, exact: true })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: '選択しない案（opt-out）列', exact: true })).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: '選択', exact: true }))
  current = await picker(purpose)
  expect(within(current.dialog).getByRole('status')).toHaveTextContent('0件選択中')
  await finish(current.dialog, false)
})
