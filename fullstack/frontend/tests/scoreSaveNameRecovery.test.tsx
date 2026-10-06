import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { api, type CodebookColumn } from '../src/api/client'
import { selectionReducer, store } from '../src/app/store'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import FamdPage from '../src/features/models/FamdPage'

// Run, inline ColumnSelect, Tabs, source-axis Select, destination Input, save Button, messages,
// result lifecycle, and selection/codebook reducers are real. Only transport and
// unrelated chart rendering are replaced. No browser, socket, or dataset writes.
vi.mock('../src/features/common/GraphPanel', async original => ({ ...await original<any>(),
  default: ({ children, controls }: any) => <div>{controls}{children}</div>,
  useGraphViewport: () => ({ logicalWidth: 600, logicalHeight: 400, scale: 1, zoom: null, dpr: 1, revision: 0 }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))
vi.mock('../src/features/models/McaFigure', async original => ({ ...await original<any>(), default: () => null }))
vi.mock('../src/features/models/FamdFigure', async original => ({ ...await original<any>(), default: () => null }))

const cases = [
  { name: 'MCA', Page: MultipleCorrespondencePage, path: '/models/mca', run: 'mca-run',
    fields: [['分析変数（2つ以上）', ['A', 'B']]] },
  { name: 'FAMD', Page: FamdPage, path: '/models/famd', run: 'famd-run',
    fields: [['数値列', ['X']], ['カテゴリ列', ['A']]] },
] as const
type Case = typeof cases[number]
const rowIds = ['r1', 'r2', 'r3']
const scoreValues = [.25, -.5, .75]
const secondAxisValues = [-1, .5, 1]

function column(name: string, scaleType: CodebookColumn['scaleType']): CodebookColumn {
  return { columnId: `${name}-id`, name, label: name, scaleType, role: 'question',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false,
    multiResponseGroup: null }
}

function fitResponse(test: Case, context: any, fitNumber: number) {
  return { status: 'success', method: test.name.toLowerCase(), resultId: `fit-${fitNumber}`,
    meta: { datasetId: context.datasetId, dataRevision: context.expectedDataRevision,
      schemaRevision: context.expectedSchemaRevision, resultState: 'ready', scope: context.scope,
      scopeCount: rowIds.length, fitCount: rowIds.length, effectiveN: rowIds.length,
      excludedCount: 0, exclusionCounts: {}, analysisUnit: 'respondent', warnings: [], weightApplied: false },
    summary: { rank: 2, totalInertia: 1, eigenvalues: [.6, .4], inertiaRatio: [.6, .4],
      cumulativeInertiaRatio: [.6, 1], rawInertiaRatio: [.6, .4], rawCumulativeInertiaRatio: [.6, 1],
      nVariables: 2, nCategories: 4, nNumericVariables: 1, nCategoricalVariables: 1 },
    details: { variables: [], categories: [], numericVariables: [], categoricalVariables: [],
      variableRelation: [], omittedCategories: [], maDiagnostics: [] },
    capabilities: { materializeFitFields: ['coordinate:1', 'coordinate:2'], materializePredictionFields: [] },
    unavailableReasons: {} }
}

type SaveOverride = (body: any, apply: () => any) => Promise<any>
function mount(test: Case, options: { save?: SaveOverride; refresh?: (codebook: any) => Promise<any> } = {}) {
  const columns = [column('A', 'nominal'), column('B', 'nominal'), column('X', 'ratio'), { ...column('Existing_score', 'interval'), role: 'other' as const }]
  let dataset = { dataRevision: 1, schemaRevision: 1, columns }
  let fitNumber = 0
  const savedValues = new Map<string, number[]>()
  const codebook = () => ({ datasetId: 'synthetic', schemaRevision: dataset.schemaRevision,
    licenseText: '', licenseRevision: 1, columns: dataset.columns, multiResponseGroups: [],
    weightConfig: null, surveyDesign: null })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    if (path === test.path) return fitResponse(test, body.context, ++fitNumber) as any
    if (path.endsWith('/materialize')) {
      const apply = () => {
        const { name, sourceField } = body.columns[0]
        // Model the already-established backend no-overwrite contract. Backend
        // integrity itself is source evidence, not proved by this transport fake.
        if (dataset.columns.some(c => c.name === name)) throw {
          code: 'COLUMN_ALREADY_EXISTS', message: `既存列への上書きは禁止です: ${name}`,
        }
        const saved = { ...column(name, 'interval'), role: 'other' as const }
        savedValues.set(name, [...(sourceField === 'coordinate:2' ? secondAxisValues : scoreValues)])
        dataset = { dataRevision: dataset.dataRevision + 1, schemaRevision: dataset.schemaRevision + 1,
          columns: [...dataset.columns, saved] }
        return { createdColumns: [{ columnId: saved.columnId, name, sourceField }],
          writtenRowCount: rowIds.length, dataRevision: dataset.dataRevision, schemaRevision: dataset.schemaRevision } as any
      }
      return options.save ? options.save(body, apply) : apply()
    }
    throw new Error(`Unexpected POST ${path}`)
  })
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/datasets/synthetic/codebook') return options.refresh ? options.refresh(codebook()) : codebook() as any
    if (path === '/datasets/synthetic') return { dataRevision: dataset.dataRevision, schemaRevision: dataset.schemaRevision } as any
    if (path.startsWith('/analysis-results/') && path.includes('/rows?')) return {
      rows: rowIds.map((rowId, index) => ({ rowId, coordinates: [scoreValues[index], 0] })),
      total: rowIds.length, nextOffset: null,
    } as any
    throw new Error(`Unexpected GET ${path}`)
  })
  const base = store.getState()
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'synthetic', dataRevision: 1,
      allRowIds: rowIds, activeRowIds: rowIds, selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'all' as const,
      totalRowIds: rowIds, activeRowIds: rowIds, selectedRowIds: [] },
    globalVariables: { ...base.globalVariables, activeEntities: columns.filter(c => c.role === 'question').map(c => ({ kind: 'column' as const, columnId: c.columnId })) },
    codebook: { ...base.codebook, ...codebook(), isLoading: false },
  }
  const local = configureStore({ reducer: (state = initial, action: any) => {
    if (action.type === 'test/dataset') return { ...state,
      selection: { ...state.selection, datasetId: action.payload, dataRevision: 1 },
      codebook: { ...state.codebook, ...codebook(), datasetId: action.payload, schemaRevision: 1, columns },
    }
    return { ...state, selection: selectionReducer(state.selection, action), codebook: codebookSlice.reducer(state.codebook, action) }
  }, middleware: get => get({ serializableCheck: false }) })
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><test.Page /></Provider></ConfigProvider>)
  return { local, post, dataset: () => dataset, savedValues, codebook }
}

// Use real inline options; modal picker behavior is covered separately and is
// not relevant to the save/refit failure under investigation.
async function chooseInline(label: string, names: readonly string[]) {
  const input = screen.getByRole('combobox', { name: label })
  fireEvent.mouseDown(input)
  for (const name of names) {
    const option = await waitFor(() => {
      const found = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content'))
        .find(item => within(item as HTMLElement).queryByText(name, { exact: true }) !== null)
      expect(found, `inline option ${name} is available`).toBeTruthy()
      return found!
    })
    fireEvent.click(option)
  }
  fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', keyCode: 27 })
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(async () => {
  cleanup()
  // Static messages own a separate React root; flush queued cleanup before jsdom teardown.
  await act(async () => { message.destroy() })
  vi.restoreAllMocks()
})

function deferred<T = any>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const nameInput = () => screen.getByRole('textbox', { name: '保存先の列名（任意）' })
const setName = (name: string) => fireEvent.change(nameInput(), { target: { value: name } })
const saveButton = (name: string) => screen.getByRole('button', { name: `${name}を派生列へ保存`, exact: true })
const dirtyNotice = '対象または設定が変更されています。結果は前回実行分です。'

async function prepare(test: Case, options: Parameters<typeof mount>[1] = {}) {
  const fixture = mount(test, options)
  for (const [label, names] of test.fields) await chooseInline(label, names)
  const runs = () => fixture.post.mock.calls.filter(([path]) => path === test.path)
  const saves = () => fixture.post.mock.calls.filter(([path]) => path.endsWith('/materialize'))
  const run = async () => {
    const count = runs().length + 1
    fireEvent.click(screen.getByTestId(test.run))
    await waitFor(() => expect(runs()).toHaveLength(count))
    await waitFor(() => expect(screen.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
  }
  await run()
  fireEvent.click(screen.getByRole('tab', { name: '保存・出力' }))
  return { ...fixture, runs, saves, run }
}

// This two-fit/two-save recovery sequence is one lifecycle assertion.
// Allow measured hosted-runner headroom without changing individual waits.
it.each(cases)('$name keeps the default save and recovers after refit under a new name without replacing the old column', async test => {
  const { local, dataset, savedValues, runs, saves, run } = await prepare(test)
  const original = `${test.name}1`
  expect(runs()[0][1]).toMatchObject(test.name === 'MCA'
    ? { variables: ['A-id', 'B-id'] }
    : { numericVariables: ['X-id'], categoricalVariables: ['A-id'] })
  expect(nameInput()).toHaveValue('')
  expect(nameInput()).toHaveAttribute('placeholder', original)
  expect(nameInput()).toHaveAccessibleDescription(new RegExp(`空欄なら ${original}`))
  expect(screen.getByRole('combobox', { name: '保存する軸' })).toHaveAccessibleDescription('選んだ軸の個体座標を新しい派生列に保存します。')
  fireEvent.click(saveButton(original))
  await waitFor(() => expect(local.getState().codebook.schemaRevision).toBe(2))
  expect(local.getState().selection.dataRevision).toBe(2)
  expect(saveButton(original)).toBeDisabled()
  expect(screen.getByText('データ版が更新されました。表示は旧版のままです。選択・保存・予測はできません。')).toBeVisible()
  expect(saves()[0]).toEqual(['/analysis-results/fit-1/materialize', {
    context: expect.objectContaining({ expectedDataRevision: 1, expectedSchemaRevision: 1, scope: 'all' }),
    source: 'fit', columns: [{ sourceField: 'coordinate:1', name: original, label: `${test.name}第1軸` }],
    idempotencyKey: 'fit-1-fit-1',
  }])
  const originalColumn = local.getState().codebook.columns.find(c => c.name === original)
  const savedDataset = dataset()
  await run()
  const firstRequest = runs()[0][1] as any
  expect(runs()[1][1]).toEqual({ ...firstRequest, context: {
    ...firstRequest.context, expectedDataRevision: 2, expectedSchemaRevision: 2,
  } })
  expect(saveButton(original)).toBeDisabled()
  expect(nameInput()).toHaveAccessibleDescription(new RegExp(`列「${original}」は既に存在します`))
  fireEvent.click(saveButton(original))
  expect(saves()).toHaveLength(1)
  expect(dataset()).toBe(savedDataset)

  const next = `${test.name}_refit`
  setName(next)
  expect(saveButton(next)).toBeEnabled()
  expect(screen.queryByText(dirtyNotice)).toBeNull()
  fireEvent.click(saveButton(next))
  await waitFor(() => expect(local.getState().codebook.schemaRevision).toBe(3))
  expect(saves()[1]).toEqual(['/analysis-results/fit-2/materialize', {
    context: (runs()[1][1] as any).context,
    source: 'fit', columns: [{ sourceField: 'coordinate:1', name: next, label: `${test.name}第1軸` }],
    idempotencyKey: `fit-2-fit-1-${next}`,
  }])
  expect(savedValues.get(original)).toEqual(scoreValues)
  expect(savedValues.get(next)).toEqual(scoreValues)
  expect(local.getState().codebook.columns.filter(c => c.name === original)).toEqual([originalColumn])
  expect(local.getState().codebook.columns.map(c => c.name)).toEqual(['A', 'B', 'X', 'Existing_score', original, next])
  expect(local.getState().selection.dataRevision).toBe(3)
  expect(nameInput()).toHaveValue(next)
  expect(saveButton(next)).toBeDisabled()
}, 10000)

it.each(cases)('$name rejects invalid, known-existing and reserved names and recovers when cleared', async test => {
  const { saves } = await prepare(test)
  for (const invalid of ['123score', 'two words', '日本語', 'score-name', ' score ', '   ', '__rowId__', 'Existing_score']) {
    setName(invalid)
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput()).toHaveAccessibleDescription(/使用してください|システム列|既に存在します/)
    expect(screen.getByRole('button', { name: /を派生列へ保存$/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /を派生列へ保存$/ }))
    expect(saves()).toHaveLength(0)
  }
  setName('')
  expect(nameInput()).toHaveValue('')
  expect(nameInput()).toHaveAttribute('aria-invalid', 'false')
  expect(saveButton(`${test.name}1`)).toBeEnabled()
  expect(saves()).toHaveLength(0)
  expect(screen.queryByText(dirtyNotice)).toBeNull()
})

it.each(cases)('$name preserves default and custom retry intent, source axis and input after failures and refit', async test => {
  const { local, saves, runs, run } = await prepare(test, { save: async body => {
    throw { code: 'COLUMN_ALREADY_EXISTS', message: `既存列への上書きは禁止です: ${body.columns[0].name}` }
  } })
  await chooseInline('保存する軸', ['第2軸'])
  const defaultName = `${test.name}2`
  expect(nameInput()).toHaveAttribute('placeholder', defaultName)
  expect(nameInput()).toHaveAccessibleDescription(new RegExp(`空欄なら ${defaultName}`))
  fireEvent.click(saveButton(defaultName))
  await waitFor(() => expect(screen.getByText(`既存列への上書きは禁止です: ${defaultName}（COLUMN_ALREADY_EXISTS）`)).toBeVisible())
  expect(saves()).toHaveLength(1)
  setName(defaultName)
  fireEvent.click(saveButton(defaultName))
  await waitFor(() => expect(saves()).toHaveLength(2))
  expect(saves()[1]).toEqual(saves()[0])
  expect(saves()[0][1]).toMatchObject({ columns: [{ sourceField: 'coordinate:2', name: defaultName, label: `${test.name}第2軸` }], idempotencyKey: 'fit-1-fit-2' })

  setName('Clashing_score')
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(saveButton('Clashing_score'))
    await waitFor(() => expect(saves()).toHaveLength(3 + attempt))
  }
  expect(saves()[3]).toEqual(saves()[2])
  expect((saves()[2][1] as any).idempotencyKey).not.toBe((saves()[0][1] as any).idempotencyKey)
  expect(nameInput()).toHaveValue('Clashing_score')
  expect(screen.getAllByText('既存列への上書きは禁止です: Clashing_score（COLUMN_ALREADY_EXISTS）').length).toBeGreaterThan(0)
  expect(local.getState().selection.dataRevision).toBe(1)
  expect(screen.queryByText(dirtyNotice)).toBeNull()
  expect(runs()).toHaveLength(1)
  await run()
  expect(nameInput()).toHaveValue('Clashing_score')
  expect(runs()[1][1]).toEqual(runs()[0][1])

})

it.each(cases)('$name captures the submitted destination and axis while keeping pending inputs editable', async test => {
  const pending = deferred()
  let complete: (() => void) | undefined
  const { local, saves, runs } = await prepare(test, { save: async (_body, apply) => {
    complete = () => pending.resolve(apply())
    return pending.promise
  } })
  await chooseInline('保存する軸', ['第2軸'])
  const submittedName = `Saved_${'x'.repeat(300)}`
  setName(submittedName)
  expect(nameInput()).not.toHaveAttribute('maxLength')
  fireEvent.click(saveButton(submittedName))
  await waitFor(() => expect(complete).toBeDefined())
  expect(saves()).toHaveLength(1)
  expect(saves()[0]).toEqual(['/analysis-results/fit-1/materialize', {
    context: (runs()[0][1] as any).context, source: 'fit',
    columns: [{ sourceField: 'coordinate:2', name: submittedName, label: `${test.name}第2軸` }],
    idempotencyKey: `fit-1-fit-2-${submittedName}`,
  }])
  setName('Next_score')
  await chooseInline('保存する軸', ['第1軸'])
  await act(async () => { complete!() })
  await waitFor(() => expect(screen.getByText(`${submittedName}を保存しました（3行）。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。`)).toBeVisible())
  expect(nameInput()).toHaveValue('Next_score')
  expect(screen.queryByText('Next_scoreを保存しました（3行）。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。')).toBeNull()
  expect(local.getState().codebook.columns.some(c => c.name === submittedName)).toBe(true)
  expect(saveButton('Next_score')).toBeDisabled()
})

it.each(cases)('$name resets destination on dataset change and suppresses a late notice after codebook refresh', async test => {
  const refresh = deferred()
  let refreshResult: any
  const { local, saves } = await prepare(test, { refresh: async codebook => {
    refreshResult = codebook
    return refresh.promise
  } })
  setName('Previous_dataset_score')
  fireEvent.click(saveButton('Previous_dataset_score'))
  await waitFor(() => expect(refreshResult).toBeDefined())
  expect(saves()).toHaveLength(1)
  act(() => { local.dispatch({ type: 'test/dataset', payload: 'replacement' }) })
  await act(async () => { refresh.resolve(refreshResult) })
  expect(local.getState().selection.datasetId).toBe('replacement')
  expect(local.getState().selection.dataRevision).toBe(1)
  expect(local.getState().codebook.datasetId).toBe('replacement')
  expect(screen.queryByText('Previous_dataset_scoreを保存しました（3行）。新列は利用可能です。Tableに表示するには、Variablesで新列を選択してください。')).toBeNull()
  for (const [label, names] of test.fields) await chooseInline(label, names)
  fireEvent.click(screen.getByTestId(test.run))
  await waitFor(() => expect(screen.getByTestId(test.run)).not.toHaveClass('ant-btn-loading'))
  fireEvent.click(screen.getByRole('tab', { name: '保存・出力' }))
  expect(nameInput()).toHaveValue('')
})
