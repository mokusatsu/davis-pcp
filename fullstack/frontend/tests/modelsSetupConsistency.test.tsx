import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { store, selectionReducer, selectionApplied } from '../src/app/store'
import { api } from '../src/api/client'
import { editorModalOpened } from '../src/features/dataset/codebookSlice'
import ModelsPage from '../src/features/models/ModelsPage'

// Keep actual number inputs, variable dialogs, model radios, MA picker and tree leaves.
// Charts and panel sizing have separate rendering tests.
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <section>{children}</section>, useGraphPopupContainer: () => undefined }))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => { throw new Error('raw data forbidden') } }))

const rows = ['r1', 'r2', 'r3', 'r4']
const result = {
  resultId: 'model-result', modelType: 'decision_tree', taskType: 'regression', evidenceClass: 'test',
  targetDtype: 'Float64', classCategories: null,
  features: ['x'], target: 'outcome', trainedRows: 2, scopeCount: 4, ordinaryMissingExcluded: 1,
  featureImportance: { x: 1 }, diagnostics: {}, leafCount: 1,
  leafMembership: [{ treeIndex: 0, nodeId: 7, rowIds: ['r2', 'r4'] }],
  treeStructures: [{ nodeId: 7, isLeaf: true, count: 2, majority: '12.5', values: [] }],
}
const defaultPayload = {
  datasetId: 'd', modelType: 'decision_tree', taskType: 'auto', features: ['x'], target: 'outcome',
  maxDepth: 4, nEstimators: 100, seed: 42, rowIds: rows, expectedSchemaRevision: 2, expectedDataRevision: 3,
}
const modelLabels = { decision_tree: '決定木 (Decision Tree)', random_forest: 'ランダムフォレスト (Random Forest)' }

function mount(empty = false) {
  const base = store.getState()
  const column = (name: string, extra = {}) => ({ name, columnId: name, label: name, role: 'question',
    scaleType: 'ratio', multiResponseGroup: null, valueLabels: {}, categoryOrder: [], missingCodes: [], ...extra })
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: rows, activeRowIds: rows,
      activeRowIdSet: new Set(rows), selectedRowIds: [], modelResult: null },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    pcp: { ...base.pcp, brushOperation: 'replace' },
    globalVariables: { ...base.globalVariables, activeEntities: empty ? [] : [
      ...['outcome', 'x', 'category', 'weight'].map(columnId => ({ kind: 'column', columnId })), { kind: 'ma', groupId: 'g' },
    ], weightColumnId: 'weight' },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false,
      columns: [column('outcome'), column('x'), column('category', { scaleType: 'nominal' }), column('hidden'),
        column('weight', { role: 'weight' }),
        ...['A', 'B'].map(name => column(name, { scaleType: 'nominal', multiResponseGroup: 'g', multiResponseOptionLabel: `選択肢${name}` })),
      ], multiResponseGroups: [{ groupId: 'g', label: 'MA設問', optionOrder: ['A', 'B'], selectedCodes: ['1'],
        unselectedCodes: ['0'], allUnselectedMeaning: 'valid', maxSelections: null }],
    },
  }
  const local = configureStore({ reducer: (current = state, action: any) => action.type === 'test/revision'
    ? { ...current, selection: { ...current.selection, dataRevision: current.selection.dataRevision + 1, modelResult: null } }
    : { ...current, selection: selectionReducer(current.selection, action) },
    middleware: get => get({ serializableCheck: false }) })
  vi.spyOn(store, 'getState').mockImplementation(() => local.getState())
  const dispatch = vi.spyOn(local, 'dispatch')
  return { ...render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><ModelsPage /></Provider></ConfigProvider>), local, dispatch }
}
function settings() { return screen.getByText('モデルの詳細設定').closest('details')! }
function openSettings() { act(() => { settings().open = true }) }
function chooseModel(model: keyof typeof modelLabels) { fireEvent.click(screen.getByRole('radio', { name: modelLabels[model], exact: true })) }
function runButton() { return screen.getByTestId('run-model') }
function editNumber(id: string, value: string) {
  const input = screen.getByTestId(id)
  act(() => { input.focus() })
  fireEvent.change(input, { target: { value } })
  return input
}
function tabOut(input: HTMLElement) {
  fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' })
  // jsdom has no native Tab traversal; explicitly perform its focus/blur transition.
  act(() => { input.blur() })
  fireEvent.keyUp(input, { key: 'Tab', code: 'Tab' })
}
function clickRunAfterBlur(input?: HTMLElement) {
  fireEvent.mouseDown(runButton())
  if (input) act(() => { input.blur() })
  fireEvent.mouseUp(runButton()); fireEvent.click(runButton())
}
async function openPicker(roleName: string) {
  fireEvent.click(screen.getByRole('button', { name: `${roleName}を選択`, exact: true }))
  // rc-util uses the same aria-labelledby ID for retained modals in test mode.
  const search = await screen.findByRole('textbox', { name: `${roleName}を変数名・質問文で絞り込み` })
  const dialog = search.closest('[role="dialog"]') as HTMLElement
  await waitFor(() => expect(dialog).toBeVisible())
  return dialog
}
async function commitPicker(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}
async function chooseFeature() {
  const dialog = await openPicker('モデルの説明変数')
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'x', exact: true }))
  await commitPicker(dialog)
}
async function chooseTarget(target: string) {
  const dialog = await openPicker('モデルの目的変数')
  fireEvent.click(within(dialog).getByRole('radio', { name: target, exact: true }))
  await commitPicker(dialog)
}
function deferred() {
  let resolve!: (value: any) => void
  const promise = new Promise<any>(done => { resolve = done })
  return { promise, resolve }
}
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps variables first, optional settings closed, named wrapping model radios and the shared Run footer', () => {
  const { container } = mount()
  expect([...container.querySelectorAll('details')].every(panel => !panel.open)).toBe(true)
  const target = screen.getByRole('combobox', { name: 'モデルの目的変数' })
  const features = screen.getByRole('combobox', { name: 'モデルの説明変数' })
  expect(target).toHaveAccessibleDescription(/予測する列を1つ/)
  expect(features).toHaveAccessibleDescription(/同じMA設問/)
  for (const input of [target, features]) {
    expect(input.closest('.analysis-variable-grid')).toBeTruthy()
    expect(input.closest('.column-select-multi-wrap')).toHaveStyle({ width: '100%', minWidth: '0' })
  }
  const methods = screen.getByTestId('model-type')
  expect(methods).toHaveClass('ant-radio-group')
  expect(screen.getByRole('radiogroup', { name: 'モデル' })).toContainElement(methods)
  expect(within(methods).getAllByRole('radio')).toHaveLength(2)
  for (const label of Object.values(modelLabels)) {
    const radio = within(methods).getByRole('radio', { name: label, exact: true })
    expect(radio).toHaveAttribute('name', 'model-type'); act(() => { radio.focus() }); expect(radio).toHaveFocus()
  }
  expect(features.compareDocumentPosition(methods) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelector('.ant-segmented')).toBeNull()
  expect(runButton().closest('.analysis-run-row')).toBeTruthy()
  expect(runButton()).toHaveClass('ant-btn-primary')
  expect(runButton()).toBeDisabled()
  expect(runButton()).toHaveAccessibleDescription('説明変数を1列以上選択してください。')
})

it.each(['decision_tree', 'random_forest'] as const)('%s submits every existing default unchanged', async model => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); await chooseFeature(); chooseModel(model)
  expect(settings()).not.toHaveAttribute('open')
  expect(settings().querySelector('summary')).toHaveTextContent('最大深さ: 4')
  openSettings()
  expect(screen.getByRole('spinbutton', { name: '木の最大深さ' })).toHaveValue('4')
  if (model === 'random_forest') expect(screen.getByRole('spinbutton', { name: '決定木の本数' })).toHaveValue('100')
  else expect(screen.queryByTestId('n-estimators')).toBeNull()
  clickRunAfterBlur()
  await waitFor(() => expect(post.mock.calls).toEqual([['/models', { ...defaultPayload, modelType: model }]]))
})

it.each([
  ['max-depth', ''], ['max-depth', '0'], ['max-depth', '21'], ['max-depth', '4.5'], ['max-depth', 'abc'],
  ['n-estimators', ''], ['n-estimators', '9'], ['n-estimators', '501'], ['n-estimators', '100.5'], ['n-estimators', 'abc'],
])('blocks %s draft %j through change → Tab blur → Run, then recovers without coercion', async (id, value) => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); await chooseFeature(); chooseModel('random_forest'); openSettings()
  const input = editNumber(id, value)
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(runButton()).toBeDisabled()
  tabOut(input); clickRunAfterBlur(input)
  expect(post).not.toHaveBeenCalled(); expect(runButton()).toBeDisabled()
  if (value !== 'abc') expect(input).toHaveValue(value)
  act(() => { settings().open = false })
  expect(settings().querySelector('summary')).toHaveTextContent('設定を確認してください')
  expect(runButton()).toHaveAccessibleDescription(new RegExp(id === 'max-depth' ? '木の最大深さ（1〜20の整数）' : '決定木の本数（10〜500の整数）'))
  openSettings(); editNumber(id, id === 'max-depth' ? '4' : '100'); tabOut(input); clickRunAfterBlur(input)
  await waitFor(() => expect(post.mock.calls).toEqual([['/models', { ...defaultPayload, modelType: 'random_forest' }]]))
})

it.each([
  ['max-depth', '1', { maxDepth: 1 }], ['max-depth', '20', { maxDepth: 20 }],
  ['n-estimators', '10', { nEstimators: 10 }], ['n-estimators', '500', { nEstimators: 500 }],
] as const)('accepts %s boundary %s without changing the request on blur', async (id, value, changed) => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); await chooseFeature(); chooseModel('random_forest'); openSettings()
  const input = editNumber(id, value); tabOut(input)
  expect(input).toHaveValue(value); expect(input).not.toHaveAttribute('aria-invalid', 'true')
  clickRunAfterBlur(input)
  await waitFor(() => expect(post.mock.calls).toEqual([['/models', { ...defaultPayload, modelType: 'random_forest', ...changed }]]))
})

it.each(['', '100.5', '501'])('ignores inactive forest draft %j without sending it and retains it on return', async value => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); await chooseFeature(); chooseModel('random_forest'); openSettings()
  const input = editNumber('n-estimators', value); tabOut(input)
  expect(runButton()).toBeDisabled()
  chooseModel('decision_tree')
  expect(screen.queryByTestId('n-estimators')).toBeNull(); expect(runButton()).toBeEnabled()
  clickRunAfterBlur()
  await waitFor(() => expect(post.mock.calls).toEqual([['/models', defaultPayload]]))
  chooseModel('random_forest')
  expect(screen.getByTestId('n-estimators')).toHaveValue(value)
  expect(screen.getByTestId('n-estimators')).toHaveAttribute('aria-invalid', 'true')
  expect(runButton()).toBeDisabled()
})

it('retains valid edits through collapse and model changes, and submits them only on explicit Run', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); await chooseFeature(); chooseModel('random_forest'); openSettings()
  const depth = editNumber('max-depth', '8'); tabOut(depth)
  tabOut(editNumber('n-estimators', '120'))
  act(() => { settings().open = false })
  expect(settings().querySelector('summary')).toHaveTextContent('最大深さ: 8 / 決定木の本数: 120')
  chooseModel('decision_tree'); chooseModel('random_forest'); openSettings()
  expect(screen.getByTestId('max-depth')).toBe(depth)
  expect(screen.getByTestId('n-estimators')).toHaveValue('120')
  expect(post).not.toHaveBeenCalled(); act(() => { settings().open = false }); clickRunAfterBlur()
  await waitFor(() => expect(post.mock.calls).toEqual([['/models', { ...defaultPayload, modelType: 'random_forest', maxDepth: 8, nEstimators: 120 }]]))
})

it.each(['モデルの目的変数', 'モデルの説明変数'])('provides role-specific %s empty recovery through Codebook', async roleName => {
  const { dispatch } = mount(true)
  expect(runButton()).toBeDisabled()
  const dialog = await openPicker(roleName)
  expect(within(dialog).getByText(/変数の候補がありません。/)).toBeVisible()
  expect(within(dialog).getByText(/共通の有効変数/)).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
  expect(dispatch).toHaveBeenCalledWith(editorModalOpened())
  await waitFor(() => expect(dialog).not.toBeVisible())
})

it('preserves eligible feature filtering, explicit MA children and same-MA target exclusion', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount()
  const features = await openPicker('モデルの説明変数')
  expect(within(features).getAllByRole('checkbox')).toHaveLength(2)
  expect(within(features).getByRole('checkbox', { name: 'x', exact: true }).closest('label')).toBeVisible()
  expect(within(features).getByRole('checkbox', { name: 'category', exact: true }).closest('label')).toBeVisible()
  for (const name of ['outcome', 'hidden', 'weight', '選択肢A', '選択肢B']) expect(within(features).queryByRole('checkbox', { name, exact: true })).toBeNull()
  fireEvent.click(within(features).getByRole('checkbox', { name: 'x', exact: true })); await commitPicker(features)
  fireEvent.click(screen.getByRole('button', { name: 'MA軸を追加' }))
  const maTitle = await screen.findByText('MA軸を追加', { selector: '.ant-modal-title' })
  const ma = maTitle.closest('[role="dialog"]') as HTMLElement
  await waitFor(() => expect(ma).toBeVisible())
  fireEvent.mouseDown(within(ma).getByRole('combobox', { name: 'MA軸の設問' }))
  fireEvent.click(await screen.findByText('MA設問'))
  fireEvent.mouseDown(within(ma).getByRole('combobox', { name: '追加するMA軸' }))
  expect(screen.queryByText('選択数', { selector: '.ant-select-item-option-content' })).toBeNull()
  fireEvent.click(await screen.findByText('選択肢A'))
  fireEvent.click(await screen.findByText('選択肢B'))
  fireEvent.click(within(ma).getByRole('button', { name: /追\s*加/, exact: true }))
  await waitFor(() => expect(ma).not.toBeVisible())
  clickRunAfterBlur()
  await waitFor(() => expect(post.mock.calls).toEqual([['/models', { ...defaultPayload, features: ['x', 'A', 'B'] }]]))
  await chooseTarget('A')
  const filtered = await openPicker('モデルの説明変数')
  expect(within(filtered).queryByRole('checkbox', { name: '選択肢A' })).toBeNull()
  expect(within(filtered).queryByRole('checkbox', { name: '選択肢B' })).toBeNull()
  expect(within(filtered).getByRole('checkbox', { name: 'x', exact: true })).toBeChecked()
  await commitPicker(filtered); clickRunAfterBlur()
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/models', { ...defaultPayload, target: 'A' }))
}, 10000)

it('keeps completed forest metadata, target, importance and selectable leaves tied to the captured result after edits', async () => {
  const pending = deferred()
  const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise)
  const { local, dispatch } = mount()
  await chooseFeature(); chooseModel('random_forest'); clickRunAfterBlur()
  await waitFor(() => expect(post).toHaveBeenCalledOnce())
  chooseModel('decision_tree'); await chooseTarget('category'); openSettings(); tabOut(editNumber('max-depth', '8'))
  const completed = { ...result, modelType: 'random_forest', diagnostics: { nEstimators: 100 },
    representativeTree: { index: 3, forestAgreement: null, treeAgreements: null, forestMae: .25, treeMaes: [1, 2, 3, .25] } }
  await act(async () => { pending.resolve(completed); await pending.promise })
  expect(screen.getByText('現在の入力と異なる実行済み結果です。再実行すると更新されます。')).toBeVisible()
  expect(screen.getByText('決定木: 100本')).toBeVisible()
  expect(screen.getByText('目的変数 & タスク').closest('.ant-card')).toHaveTextContent('outcome')
  expect(screen.getByText(/森の予測との平均絶対差 0.2500（木3／4本中/)).toBeVisible()
  expect(screen.getByTestId('feature-importance-panel')).toBeVisible()
  expect(local.getState().selection.modelResult).toEqual(completed)
  const leaf = screen.getByRole('button', { name: '葉7の2行を選択' })
  fireEvent.click(leaf)
  expect(dispatch).toHaveBeenCalledWith(selectionApplied({ rowIds: ['r2', 'r4'], operation: 'replace', label: 'tree leaf選択' }))
  expect(local.getState().selection.selectedRowIds).toEqual(['r2', 'r4'])
  expect(post.mock.calls).toEqual([['/models', { ...defaultPayload, modelType: 'random_forest' }]])
})

it('rejects a pending result after the dataset revision changes', async () => {
  const pending = deferred()
  vi.spyOn(api, 'post').mockReturnValue(pending.promise)
  const { local } = mount()
  await chooseFeature(); clickRunAfterBlur()
  act(() => { local.dispatch({ type: 'test/revision' }) })
  await act(async () => { pending.resolve(result); await pending.promise })
  expect(local.getState().selection.modelResult).toBeNull()
  expect(screen.queryByRole('button', { name: '葉7の2行を選択' })).toBeNull()
  expect(screen.queryByText('モデル学習結果')).toBeNull()
})
