import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { store, clusterResultStored, groupsReplaced } from '../src/app/store'
import { api } from '../src/api/client'
import { editorModalOpened } from '../src/features/dataset/codebookSlice'
import ClustersPage from '../src/features/clustering/ClustersPage'

// Keep actual inputs, radio buttons, variable dialogs, MA picker and disclosures.
// Results and shared-selection rendering have dedicated clustering tests.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456', selectionColor: '#abcdef' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div>, useGraphPopupContainer: () => undefined, useGraphViewport: () => ({ scale: 1, zoom: null }) }))
const methods = [
  ['KMeans', 'kmeans'], ['KMedoids', 'kmedoids'], ['Divisive', 'divisive'], ['EM(GMM)', 'gmm'],
  ['階層的', 'agglomerative'], ['Cobweb', 'cobweb'], ['DISC (AAAI 2026)', 'disc'], ['Class変数', 'class_variable'],
] as const
const result = { resultId: 'c', method: 'kmeans', k: 2, rowIds: ['r1', 'r2'], labels: [0, 1], diagnostics: {}, linkageMatrix: null, evidenceClass: 'test' }
const defaultPayload = {
  datasetId: 'd', activeRowIds: ['r1', 'r2', 'r3', 'r4'], expectedDataRevision: 3, expectedSchemaRevision: 2,
  method: 'kmeans', k: 3, seed: 42, linkage: 'average', distance: 'euclidean', classColumn: undefined,
  columns: ['x', 'z'], categoricalColumns: undefined, scaling: 'zscore', acuity: 0.1, cutoff: 0.001, alphaSmooth: 0.6, numWeight: 1,
}
function mount(empty = false) {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3, allRowIds: ['r1', 'r2', 'r3', 'r4'], activeRowIds: ['r1', 'r2', 'r3', 'r4'], clusterResult: null },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables, activeEntities: empty ? [] : [
      ...['x', 'z', 'category'].map(columnId => ({ kind: 'column', columnId })), { kind: 'ma', groupId: 'g' },
    ] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, isLoading: false,
      columns: [
        ...['x', 'z', 'category', 'hidden'].map(name => ({ name, columnId: name, label: name, role: 'question', scaleType: name === 'category' ? 'nominal' : 'ratio', multiResponseGroup: null })),
        { name: 'A', columnId: 'A', label: 'MA option A', role: 'question', scaleType: 'nominal', multiResponseGroup: 'g', multiResponseOptionLabel: '選択肢A' },
      ], multiResponseGroups: [{ groupId: 'g', label: 'MA設問', optionOrder: ['A'], selectedCodes: ['1'], unselectedCodes: ['0'], allUnselectedMeaning: 'valid', maxSelections: null }],
    },
  }
  const local = configureStore({ reducer: (current = state, action: any) => clusterResultStored.match(action)
    ? { ...current, selection: { ...current.selection, clusterResult: action.payload } }
    : groupsReplaced.match(action) ? { ...current, selection: { ...current.selection, groups: action.payload } } : current,
    middleware: get => get({ serializableCheck: false }) })
  vi.spyOn(store, 'getState').mockImplementation(() => local.getState())
  const dispatch = vi.spyOn(local, 'dispatch')
  return { ...render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><ClustersPage /></Provider></ConfigProvider>), local, dispatch }
}
function settings() { return screen.getByText('クラスタリングの詳細設定').closest('details')! }
function openSettings() { act(() => { settings().open = true }) }
function chooseMethod(label: string) { fireEvent.click(screen.getByRole('radio', { name: label, exact: true })) }
function inputNumber(id: string, value: string) {
  const input = screen.getByTestId(id)
  act(() => { input.focus() })
  fireEvent.change(input, { target: { value } })
  return input
}
// Reproduce pointer activation ordering: mousedown, old field blur, then click.
function clickRunAfterBlur(input: HTMLElement) {
  const run = screen.getByTestId('run-clustering')
  fireEvent.mouseDown(run); fireEvent.blur(input); fireEvent.mouseUp(run); fireEvent.click(run)
}
async function editColumns(roleName: string, values: string[]) {
  fireEvent.click(screen.getByRole('button', { name: `${roleName}を選択`, exact: true }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  for (const value of values) fireEvent.click(within(dialog).getByRole('checkbox', { name: value, exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
async function chooseClass(value = 'category') {
  fireEvent.click(screen.getByRole('button', { name: 'クラスタリングの正解ラベル列を選択', exact: true }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('radio', { name: value, exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps variables first, all eight methods in the wrapping radio group, and optional settings closed', () => {
  const { container } = mount()
  expect([...container.querySelectorAll('details')].every(panel => !panel.open)).toBe(true)
  const numeric = screen.getByRole('combobox', { name: 'クラスタリングの数値列' })
  expect(numeric).toHaveAccessibleDescription(/順序・間隔・比率尺度/)
  expect(numeric.closest('.column-select-multi-wrap')).toHaveStyle({ width: '100%', minWidth: '0' })
  expect(numeric.closest('.analysis-variable-grid')).toBeTruthy()
  const methodGroup = screen.getByTestId('cluster-method')
  expect(methodGroup).toHaveClass('ant-radio-group')
  expect(methodGroup.closest('.analysis-setup')).toBeTruthy()
  expect(screen.getByRole('radiogroup', { name: 'クラスタリング手法' })).toContainElement(methodGroup)
  expect(container.querySelector('.ant-segmented')).toBeNull()
  expect(within(methodGroup).getAllByRole('radio')).toHaveLength(8)
  for (const [label] of methods) {
    const radio = within(methodGroup).getByRole('radio', { name: label, exact: true })
    expect(radio.closest('label')).toBeVisible(); expect(radio).toHaveAttribute('name', 'cluster-method')
    act(() => { radio.focus() }); expect(radio).toHaveFocus()
  }
  expect(numeric.compareDocumentPosition(methodGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByTestId('run-clustering').closest('.analysis-run-row')).toBeTruthy()
  expect(screen.getByTestId('run-clustering')).toHaveAccessibleDescription(/分析対象: 数値列 2本/)
  expect(screen.getByRole('button', { name: 'MA軸を追加' })).toBeVisible()
})

it.each(methods)('%s submits the exact existing defaults and conditional column contract', async (label, method) => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); chooseMethod(label)
  if (method === 'class_variable') {
    expect(screen.getByTestId('run-clustering')).toBeDisabled()
    expect(screen.queryByTestId('cluster-k')).toBeNull()
    expect(screen.queryByTestId('cluster-numeric-columns')).toBeNull()
    await chooseClass()
  } else {
    openSettings(); expect(screen.getByLabelText('クラスタ数 k')).toHaveValue('3')
    const seed = screen.queryByTestId('cluster-seed')
    if (['kmeans', 'divisive', 'gmm', 'disc'].includes(method)) expect(seed).toHaveValue('42')
    else expect(seed).toBeNull()
  }
  expect(Boolean(screen.queryByTestId('cobweb-acuity'))).toBe(method === 'cobweb')
  expect(Boolean(screen.queryByTestId('disc-alpha'))).toBe(method === 'disc')
  expect(Boolean(screen.queryByTestId('linkage'))).toBe(method === 'agglomerative')
  expect(Boolean(screen.queryByTestId('distance'))).toBe(['kmedoids', 'agglomerative'].includes(method))
  fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith('/clusters', {
    ...defaultPayload, method, columns: method === 'class_variable' ? [] : ['x', 'z'],
    classColumn: method === 'class_variable' ? 'category' : undefined,
    categoricalColumns: ['cobweb', 'disc'].includes(method) ? ['category'] : undefined,
  })
})

it.each(['', '0', '1', '21', '2.5', 'abc'])('blocks the real k draft %j before and after Run blur/click ordering', async value => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); openSettings()
  const input = inputNumber('cluster-k', value)
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByTestId('run-clustering')).toBeDisabled()
  clickRunAfterBlur(input)
  expect(post).not.toHaveBeenCalled(); expect(screen.getByTestId('run-clustering')).toBeDisabled()
  if (value === '') expect(input).toHaveValue('')
  if (['0', '1', '21', '2.5'].includes(value)) expect(input).toHaveValue(value)
  act(() => { settings().open = false })
  expect(settings().querySelector('summary')).toHaveTextContent('設定を確認してください')
  expect(screen.getByTestId('run-clustering')).toHaveAccessibleDescription(/クラスタ数 k（2〜20の整数）/)
  openSettings(); inputNumber('cluster-k', '4'); clickRunAfterBlur(input)
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', { ...defaultPayload, k: 4 }))
})

it.each([
  ['KMeans', 'cluster-seed', '', '0'], ['KMeans', 'cluster-seed', '-1', '1'],
  ['KMeans', 'cluster-seed', '1.5', '2'], ['KMeans', 'cluster-seed', '4294967296', '4294967295'],
  ['Cobweb', 'cobweb-acuity', '', '0.01'], ['Cobweb', 'cobweb-acuity', '0.001', '0.05'],
  ['Cobweb', 'cobweb-cutoff', '', '0.0001'], ['Cobweb', 'cobweb-cutoff', '0', '0.002'],
  ['DISC (AAAI 2026)', 'disc-alpha', '', '0.6'], ['DISC (AAAI 2026)', 'disc-alpha', '5.1', '5'],
  ['DISC (AAAI 2026)', 'disc-num-weight', '', '1'], ['DISC (AAAI 2026)', 'disc-num-weight', '0', '0.1'],
  ['DISC (AAAI 2026)', 'disc-num-weight', '11', '10'],
])('%s validates %s draft %j through blur and recovers with %j', (label, id, value, valid) => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); chooseMethod(label); openSettings()
  const input = inputNumber(id, value)
  expect(input).toHaveAttribute('aria-invalid', 'true'); clickRunAfterBlur(input)
  expect(post).not.toHaveBeenCalled(); expect(screen.getByTestId('run-clustering')).toBeDisabled()
  inputNumber(id, valid); fireEvent.blur(input)
  expect(input).not.toHaveAttribute('aria-invalid', 'true'); expect(screen.getByTestId('run-clustering')).toBeEnabled()
})

it('retains edited settings across collapse and method changes, without replacing completed groups', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  const { local } = mount()
  fireEvent.click(screen.getByTestId('run-clustering')); await screen.findByRole('button', { name: 'cluster 0 (1)' })
  const completedGroups = local.getState().selection.groups
  chooseMethod('DISC (AAAI 2026)'); openSettings()
  const alpha = inputNumber('disc-alpha', '1.2'); fireEvent.blur(alpha); inputNumber('cluster-k', '4')
  act(() => { settings().open = false })
  expect(settings().querySelector('summary')).toHaveTextContent('k: 4 / seed: 42 / Alpha: 1.2')
  openSettings(); expect(screen.getByTestId('disc-alpha')).toBe(alpha)
  chooseMethod('Cobweb'); chooseMethod('DISC (AAAI 2026)')
  expect(screen.getByTestId('disc-alpha')).toHaveValue('1.2'); expect(screen.getByTestId('cluster-k')).toHaveValue('4')
  expect(screen.getByTestId('cluster-previous-result')).toBeVisible()
  expect(local.getState().selection.groups).toBe(completedGroups); expect(post).toHaveBeenCalledTimes(1)
  act(() => { settings().open = false }); fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(post).toHaveBeenLastCalledWith('/clusters', { ...defaultPayload, method: 'disc', k: 4, alphaSmooth: 1.2, categoricalColumns: ['category'] })
})

it('ignores inactive invalid drafts, retains them on return, and never sends their nulls', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); openSettings(); inputNumber('cluster-seed', '')
  chooseMethod('Cobweb'); expect(screen.getByTestId('run-clustering')).toBeEnabled(); fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', { ...defaultPayload, method: 'cobweb', categoricalColumns: ['category'] }))
  inputNumber('cobweb-acuity', ''); inputNumber('cluster-k', '')
  chooseMethod('Class変数'); await chooseClass(); fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(post).toHaveBeenLastCalledWith('/clusters', { ...defaultPayload, method: 'class_variable', columns: [], classColumn: 'category' })
  chooseMethod('Cobweb')
  expect(screen.getByTestId('cobweb-acuity')).toHaveValue(''); expect(screen.getByTestId('cluster-k')).toHaveValue('')
  expect(screen.getByTestId('run-clustering')).toBeDisabled()
  chooseMethod('KMeans'); expect(screen.getByTestId('cluster-seed')).toHaveValue('')
})

it.each(['Cobweb', 'DISC (AAAI 2026)'])('%s allows categorical-only input while ordinary methods require numeric/MA input', async label => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); await editColumns('クラスタリングの数値列', ['x: x', 'z: z'])
  expect(screen.getByTestId('run-clustering')).toBeDisabled(); chooseMethod(label)
  expect(screen.getByTestId('run-clustering')).toBeEnabled(); fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', expect.objectContaining({ columns: [], categoricalColumns: ['category'] })))
  await editColumns('クラスタリングのカテゴリ列', ['category: category'])
  expect(screen.getByTestId('run-clustering')).toBeDisabled()
  expect(screen.getByTestId('run-clustering')).toHaveAccessibleDescription(/いずれかを1つ以上/)
})

it('provides contextual empty recovery via the existing Codebook action', async () => {
  const { dispatch } = mount(true)
  expect(screen.getByTestId('run-clustering')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'クラスタリングの数値列を選択', exact: true }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog).toBeVisible())
  expect(within(dialog).getByText(/数値列の候補がありません。/)).toBeVisible()
  expect(within(dialog).getByText(/共通の有効変数を確認してください。/)).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
  expect(dispatch).toHaveBeenCalledWith(editorModalOpened())
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('adds a real MA option and preserves its numeric, mixed and class-variable routing', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'MA軸を追加' }))
  const dialog = await screen.findByRole('dialog', { name: 'MA軸を追加' })
  await waitFor(() => expect(dialog).toBeVisible())
  fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'MA軸の設問' }))
  fireEvent.click(await screen.findByText('MA設問'))
  fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: '追加するMA軸' }))
  expect(screen.queryByText('選択数', { selector: '.ant-select-item-option-content' })).toBeNull()
  fireEvent.click(await screen.findByText('選択肢A'))
  fireEvent.click(within(dialog).getByRole('button', { name: /追\s*加/, exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('combobox', { name: 'クラスタリングに追加したMA選択肢' })).toHaveAccessibleDescription(/数値列（0\/1）/)
  fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/clusters', { ...defaultPayload, columns: ['x', 'z', 'A'] }))
  chooseMethod('DISC (AAAI 2026)')
  expect(screen.getByRole('combobox', { name: 'クラスタリングに追加したMA選択肢' })).toHaveAccessibleDescription(/カテゴリ列として/)
  fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/clusters', { ...defaultPayload, method: 'disc', categoricalColumns: ['category', 'A'] }))
  chooseMethod('Class変数'); await chooseClass('A MA option A')
  fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/clusters', { ...defaultPayload, method: 'class_variable', columns: [], classColumn: 'A' }))
})

it('retains hierarchy selectors when collapsing settings and switching methods', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue(result)
  mount(); chooseMethod('階層的'); openSettings()
  const linkage = screen.getByRole('combobox', { name: '連結法' })
  const distance = screen.getByRole('combobox', { name: '距離尺度' })
  expect(linkage).toHaveAccessibleDescription('標準設定はAverageです。')
  fireEvent.mouseDown(linkage)
  fireEvent.click(await screen.findByText('Farthest（最長距離法）', { selector: '.ant-select-item-option-content' }))
  fireEvent.mouseDown(distance)
  fireEvent.click(await screen.findByText('City-block', { selector: '.ant-select-item-option-content' }))
  act(() => { settings().open = false })
  expect(settings().querySelector('summary')).toHaveTextContent('連結法: farthest / 距離: city_block')
  chooseMethod('KMedoids')
  expect(settings().querySelector('summary')).toHaveTextContent('距離: city_block')
  expect(screen.queryByTestId('linkage')).toBeNull()
  fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', { ...defaultPayload, method: 'kmedoids', linkage: 'farthest', distance: 'city_block' }))
  chooseMethod('階層的')
  expect(settings().open).toBe(false)
  fireEvent.click(screen.getByTestId('run-clustering'))
  await waitFor(() => expect(post).toHaveBeenCalledWith('/clusters', { ...defaultPayload, method: 'agglomerative', linkage: 'farthest', distance: 'city_block' }))
})
