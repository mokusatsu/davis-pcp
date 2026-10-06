import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import { codebookSlice, editorModalOpened } from '../src/features/dataset/codebookSlice'
import CrosstabPage from '../src/features/crosstab/CrosstabPage'

// Keep useCodebook, ColumnSelect, AntD controls, scope and the result table real.
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => null }))

const roles = {
  row: 'クロス集計の行変数（表側）', column: 'クロス集計の列変数（表頭）',
  weight: 'クロス集計のウェイト', strata: 'クロス集計の層（strata）', psu: 'クロス集計のPSU',
}
const categoricalNames = ['row', 'col', 'legacy', 'categoryWeight']
const weightNames = ['weightRatio', 'weightInterval', 'maWeight']
const designNames = [...categoricalNames, 'value', 'weightRatio', 'weightInterval', 'inactive']
const pickerCases = [
  { role: roles.row, label: '行変数（表側）', testId: 'crosstab-row-variable', choices: categoricalNames, design: false },
  { role: roles.column, label: '列変数（表頭）', testId: 'crosstab-col-variable', choices: categoricalNames, design: false },
  { role: roles.weight, label: 'この集計のウェイト', testId: 'crosstab-weight', choices: weightNames, design: false },
  { role: roles.strata, label: '層（strata）', testId: 'crosstab-strata', choices: designNames, design: true },
  { role: roles.psu, label: 'PSU（一次抽出単位）', testId: 'crosstab-psu', choices: designNames, design: true },
]

function initialState({ declared = true } = {}) {
  const base = store.getState()
  const specs = [
    ['row', 'nominal', 'question', null], ['col', 'ordinal', 'attribute', null],
    ['legacy', 'binary', 'id', null], ['categoryWeight', 'nominal', 'weight', null],
    ['value', 'interval', 'question', null], ['weightRatio', 'ratio', 'weight', null],
    ['weightInterval', 'interval', 'weight', null], ['inactive', 'nominal', 'question', null],
    ['maWeight', 'ratio', 'weight', 'ma'], ['maCategory', 'nominal', 'question', 'ma'],
  ]
  const columns = specs.map(([name, scaleType, role, multiResponseGroup]) => ({
    name, columnId: `${name}-id`, label: `${name} question`, scaleType, role, multiResponseGroup,
    valueLabels: {}, categoryOrder: ['1', '2'], missingCodes: [], missingReasons: {}, isReversed: false,
  }))
  return { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 3,
      allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'], selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables,
      activeEntities: [...categoricalNames, 'value'].map(name => ({ kind: 'column', columnId: `${name}-id` })) },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 2, columns, draftColumns: columns,
      isLoading: false, isWeightSaving: false, weightNeedsRefresh: false, isEditorOpen: false,
      weightConfig: declared ? { weightColumnId: 'weightRatio-id', weightType: 'survey' } : null,
      surveyDesign: declared ? { weightColumnId: 'weightRatio-id', strataColumnId: null, psuColumnId: null } : null },
  } as any
}

function mount(initial = initialState(), children: ReactNode = <CrosstabPage />) {
  const local = configureStore({ reducer: (state = initial, action: any) => {
    if (action.type === 'test/replace') return action.payload
    if (action.type.startsWith('codebook/')) return { ...state, codebook: codebookSlice.reducer(state.codebook, action) }
    return state
  }, middleware: get => get({ serializableCheck: false, immutableCheck: false }) })
  const dispatch = vi.spyOn(local, 'dispatch')
  return { local, dispatch, ...render(<Provider store={local}><MemoryRouter
    future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{children}</MemoryRouter></Provider>) }
}

async function picker(role: string, root: Pick<typeof screen, 'getByRole'> = screen) {
  fireEvent.click(root.getByRole('button', { name: `${role}を選択`, exact: true }))
  // Retained modal titles share rc-util's test-only ID. Use the purpose-named
  // search for sequential flows; fresh-instance cases assert dialog names too.
  const search = await screen.findByRole('textbox', { name: `${role}を変数名・質問文で絞り込み`, exact: true })
  const dialog = search.closest<HTMLElement>('[role="dialog"]')!
  await waitFor(() => expect(dialog).toBeVisible())
  expect(within(dialog).getByText(`${role}を選択`, { exact: true })).toBeVisible()
  return { element: dialog, ...within(dialog) }
}
async function choose(role: string, name: string | null, root: Pick<typeof screen, 'getByRole'> = screen) {
  const dialog = await picker(role, root)
  if (name === null) fireEvent.click(dialog.getByRole('button', { name: '選択解除' }))
  else fireEvent.click(dialog.getByRole('radio', { name: `${name} ${name} question`, exact: true }))
  fireEvent.click(dialog.getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog.element).not.toBeVisible())
}
async function chooseInline(role: string, name: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: role }))
  const option = await waitFor(() => {
    const match = Array.from(document.querySelectorAll(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
    )).find(item => within(item as HTMLElement).queryByText(`${name} — ${name} question`, { exact: true }))
    if (!match) throw new Error(`Missing inline option ${name}`)
    return match
  })
  fireEvent.click(option)
}
async function cancel(dialog: Awaited<ReturnType<typeof picker>>) {
  fireEvent.click(dialog.getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(dialog.element).not.toBeVisible())
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  vi.spyOn(api, 'post').mockResolvedValue({})
  vi.spyOn(api, 'put').mockResolvedValue({})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Crosstab setup presentation with real controls', () => {
  it.each(pickerCases)('names and links $role without changing its candidates', async ({ role, label, testId, choices, design }) => {
    mount()
    if (design) await chooseInline(roles.weight, 'weightRatio')
    const input = screen.getByRole('combobox', { name: role })
    expect(screen.getByLabelText(label, { exact: true })).toBe(input)
    expect(input.id).toBeTruthy()
    const helpIds = input.getAttribute('aria-describedby')!.split(' ')
    for (const id of helpIds) expect(document.getElementById(id)).not.toBeNull()
    expect(input).toHaveAccessibleDescription(design
      ? /MAグループに属さない列.*ウェイト列自身.*その場でこのデータセットに保存/
      : role === roles.weight ? /ウェイト.*間隔・比率.*未指定なら加重しません/
        : /共通の有効変数.*名義・順序.*非MA.*既存データの二値/)
    expect(input.closest('.analysis-field')).not.toBeNull()
    expect(screen.getByTestId(testId).closest('.column-select-multi-wrap')).toHaveStyle({ width: '100%', minWidth: '0' })

    const dialog = await picker(role)
    expect(screen.getByRole('dialog', { name: `${role}を選択`, exact: true })).toBe(dialog.element)
    expect(dialog.getByRole('textbox', { name: `${role}を変数名・質問文で絞り込み` })).toBeVisible()
    const results = dialog.getByRole('radiogroup', { name: `${role}の検索結果` })
    expect(within(results).getAllByRole('radio').map(radio => radio.closest('label')?.textContent))
      .toEqual(choices.map(name => `${name}${name} question`))
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'no matching column' } })
    expect(dialog.getByText(/検索条件を変更または解除してください/)).toBeVisible()
    expect(dialog.queryByRole('button', { name: 'コードブックを開く' })).not.toBeInTheDocument()
    await cancel(dialog)
    expect(api.post).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('labels missing policy and visibly separates next-run inputs from immediate dataset saves', async () => {
    mount(initialState({ declared: false }))
    const missing = screen.getByRole('combobox', { name: 'クロス集計の欠損の扱い' })
    expect(screen.getByLabelText('欠損の扱い', { exact: true })).toBe(missing)
    expect(missing).toHaveAccessibleDescription('次の集計で欠損値をどのように扱うかを指定します。')
    expect(missing.closest('section')).toHaveAccessibleName('次回の集計入力')
    const run = screen.getByTestId('crosstab-run').closest('.analysis-run-row')!
    expect(run).toContainElement(screen.getByTestId('analysis-scope-summary'))
    await choose(roles.weight, 'weightRatio')
    const group = screen.getByRole('radiogroup', { name: 'ウェイトの種類' })
    expect(group).toHaveAccessibleDescription(/先に種類を指定.*その場でこのデータセットに保存/)
    expect(group.closest('section')).toHaveAccessibleName('データセットに保存するウェイト設定')
    expect(group.closest('details')).toBeNull()
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios[0].name).toBeTruthy()
    expect(radios[1].name).toBe(radios[0].name)
    expect(radios.map(radio => radio.value)).toEqual(['survey', 'frequency'])
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('keeps labels, help and native weight groups unique and stable for two instances', async () => {
    const initial = initialState({ declared: false })
    const { local } = mount(initial, <><CrosstabPage /><CrosstabPage /></>)
    const pages = screen.getAllByTestId('crosstab-page')
    for (const page of pages) await choose(roles.weight, 'weightRatio', within(page))
    const groups = screen.getAllByRole('radiogroup', { name: 'ウェイトの種類' })
    const names = groups.map(group => (within(group).getAllByRole('radio')[0] as HTMLInputElement).name)
    expect(new Set(names).size).toBe(2)
    const inputs = screen.getAllByRole('combobox')
    const ids = inputs.map(input => input.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const input of inputs) expect(input).toHaveAccessibleDescription()
    act(() => { local.dispatch({ type: 'test/replace', payload: { ...initial, codebook: { ...initial.codebook, licenseText: 'updated' } } }) })
    expect(screen.getAllByRole('combobox').map(input => input.id)).toEqual(ids)
  })

  it.each([
    { role: roles.row, reason: '行変数（表側）の候補がありません。', guidance: /共通の有効変数と、コードブックの尺度・MAグループ/ },
    { role: roles.column, reason: '列変数（表頭）の候補がありません。', guidance: /共通の有効変数と、コードブックの尺度・MAグループ/ },
    { role: roles.weight, reason: 'ウェイトの候補がありません。ウェイトなしでも集計できます。', guidance: /コードブックの役割（ウェイト）と尺度（間隔・比率）/ },
  ].flatMap(item => (['inline', 'dialog'] as const).map(surface => ({ ...item, surface }))))(
    'offers honest $surface repair for empty $role without metadata writes or automatic choices',
    async ({ role, reason, guidance, surface }) => {
      const initial = initialState()
      if (role === roles.weight) initial.codebook.columns = initial.codebook.columns.filter((c: any) => !weightNames.includes(c.name))
      else initial.globalVariables.activeEntities = []
      const { local, dispatch } = mount(initial)
      const beforeColumns = structuredClone(local.getState().codebook.columns)
      if (surface === 'dialog') {
        const dialog = await picker(role)
        expect(dialog.queryByRole('radio')).not.toBeInTheDocument()
        expect(dialog.getByText(text => text.includes(reason))).toHaveTextContent(guidance)
        fireEvent.click(dialog.getByRole('button', { name: 'コードブックを開く' }))
        await waitFor(() => expect(dialog.element).not.toBeVisible())
      } else {
        fireEvent.mouseDown(screen.getByRole('combobox', { name: role }))
        expect(await screen.findByText(text => text.includes(reason))).toHaveTextContent(guidance)
        fireEvent.click(screen.getByRole('button', { name: 'コードブックを開く' }))
      }
      expect(dispatch).toHaveBeenCalledWith(editorModalOpened())
      expect(local.getState().codebook.isEditorOpen).toBe(true)
      expect(local.getState().codebook.columns).toEqual(beforeColumns)
      expect(screen.getByTestId('crosstab-run')).toBeDisabled()
      expect(screen.getByTestId('crosstab-row-variable').querySelector('.ant-select-selection-item')).toBeNull()
      expect(screen.getByTestId('crosstab-col-variable').querySelector('.ant-select-selection-item')).toBeNull()
      expect(api.post).not.toHaveBeenCalled()
      expect(api.put).not.toHaveBeenCalled()
    },
  )

  it('keeps row and column dialog selection independent, supports cancellation and opens inline by keyboard', async () => {
    mount()
    const row = screen.getByRole('combobox', { name: roles.row })
    fireEvent.keyDown(row, { key: 'ArrowDown', keyCode: 40 })
    await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'true'))
    fireEvent.keyDown(row, { key: 'Escape', keyCode: 27 })
    await choose(roles.row, 'row')
    await choose(roles.column, 'col')
    const rowDialog = await picker(roles.row)
    const rowRadio = rowDialog.getByRole('radio', { name: 'row row question' }) as HTMLInputElement
    expect(rowRadio).toBeChecked()
    const rowGroupName = rowRadio.name
    fireEvent.click(rowDialog.getByRole('radio', { name: 'legacy legacy question' }))
    await cancel(rowDialog)
    const columnDialog = await picker(roles.column)
    const colRadio = columnDialog.getByRole('radio', { name: 'col col question' }) as HTMLInputElement
    expect(colRadio).toBeChecked()
    expect(colRadio.name).not.toBe(rowGroupName)
    await cancel(columnDialog)
    const again = await picker(roles.row)
    expect(again.getByRole('radio', { name: 'row row question' })).toBeChecked()
    expect(again.getByRole('radio', { name: 'legacy legacy question' })).not.toBeChecked()
    await cancel(again)
    await choose(roles.weight, 'weightRatio')
    await choose(roles.weight, null)
    expect(screen.getByTestId('crosstab-weight').querySelector('.ant-select-selection-item')).toBeNull()
    expect(screen.queryByTestId('crosstab-strata')).not.toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalled()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('stacks recovery copy and its action and keeps saving/recovery visible without a disclosure', () => {
    const initial = initialState()
    initial.codebook.weightNeedsRefresh = true
    initial.codebook.isWeightSaving = true
    initial.codebook.isLoading = true
    mount(initial)
    const recovery = screen.getByTestId('crosstab-weight-recovery')
    const button = within(recovery).getByRole('button', { name: /最新の設定を読み込む$/ })
    const copy = within(recovery).getByText(/応答を確認できなくても、保存が完了している場合/)
    expect(button.parentElement).toBe(copy.parentElement)
    expect(copy.nextElementSibling).toBe(button)
    expect(button.parentElement).toHaveClass('analysis-form-stack')
    expect(button).toHaveClass('crosstab-wrap-action', 'ant-btn-loading')
    expect(recovery.querySelector('.ant-alert-action')).toBeNull()
    expect(recovery.closest('details')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('ウェイト設定を保存中…')
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
  })
})

function surveyResult() {
  return {
    meta: { datasetId: 'd', dataRevision: 3, schemaRevision: 2, scope: 'active', scopeHash: 'sha256:result',
      scopeCount: 2, effectiveN: 2, missingCount: 0, weightApplied: true, weightColumn: 'weightRatio',
      algorithmVersion: 'crosstab-survey-2', isExplorative: false, warnings: [] },
    rowCategories: [{ id: 'r', label: 'R', order: 0 }], colCategories: [{ id: 'c', label: 'C', order: 0 }],
    cells: [{ rowCategoryId: 'r', colCategoryId: 'c', rowLabel: 'R', colLabel: 'C', unweightedCount: 2,
      count: 2, rowPct: 100, colPct: 100, totalPct: 100, expectedCount: 2, residual: 0, asr: null,
      significance: '', rowIds: ['r1', 'r2'], rowIdCount: 2, rowIdsTruncated: false }],
    rowTotals: [{ categoryId: 'r', label: 'R', unweightedCount: 2, count: 2 }],
    colTotals: [{ categoryId: 'c', label: 'C', unweightedCount: 2, count: 2 }], grandTotal: { unweightedCount: 2, count: 2 },
    descriptiveAssociation: { pearsonChi2: 1, df: 1, cramersV: null, weightedCramersV: .2, weighted: true },
    inference: { requested: false, status: 'not_requested', method: null, statisticType: null,
      statistic: null, numeratorDf: null, denominatorDf: null, pValue: null, designAssumption: null, approximate: null },
    weightDiagnostics: { weightColumnId: 'weightRatio-id', weightType: 'survey', unweightedN: 2,
      weightMissingCount: 0, weightZeroCount: 0, weightSum: 2, kishEffectiveN: 2, weightCv: 0,
      weightingDeff: 1, positiveWeightN: 2, numberOfPSUs: null, numberOfStrata: null, designDf: null },
    diagnostics: { expectedLt5Count: 0, expectedLt5Ratio: 0, smallMarginalWarnings: [] },
    analysisProvenance: { weightColumnId: 'weightRatio-id', weightType: 'survey', schemaRevision: 2 },
    warnings: [], weightStatus: 'applied',
  }
}

it('names display-only controls and keeps captured result scope visible while Rao–Scott reruns current inputs', async () => {
  vi.mocked(api.post).mockResolvedValue(surveyResult())
  const { local } = mount()
  await choose(roles.row, 'row'); await choose(roles.column, 'col'); await choose(roles.weight, 'weightRatio')
  fireEvent.click(screen.getByTestId('crosstab-run'))
  const display = await screen.findByRole('radiogroup', { name: '表の表示' })
  // Layout contract only: responsive columns give the unchanged statistics
  // full width on narrow screens, two columns from sm, and four from xl.
  const statistics = screen.getByText('関連の強さと統計的検定').closest('.ant-card')!
  const statisticBlocks = statistics.querySelectorAll('.ant-statistic')
  expect(statisticBlocks).toHaveLength(4)
  for (const statistic of statisticBlocks) {
    expect(statistic.closest('.ant-col')).toHaveClass('ant-col-xs-24', 'ant-col-sm-12', 'ant-col-xl-6')
  }
  expect(statistics.querySelector('.ant-row')).toHaveStyle({ rowGap: '16px' })
  expect(display).toHaveAccessibleDescription('表示の切り替えでは再集計しません。')
  expect(within(display).getByRole('radio', { name: 'Row %' })).toBeChecked()
  fireEvent.click(within(display).getByRole('radio', { name: 'Count' }))
  expect(screen.getByTestId('crosstab-cell-r-c')).toHaveTextContent('2')
  expect(api.post).toHaveBeenCalledTimes(1)
  const resultScope = screen.getByTestId('crosstab-result-scope')
  expect(resultScope).toHaveTextContent('2行（実行時）')
  expect(resultScope.parentElement).toHaveClass('crosstab-result-provenance')

  await choose(roles.row, 'legacy')
  const next = local.getState()
  act(() => { local.dispatch({ type: 'test/replace', payload: { ...next,
    selection: { ...next.selection, activeRowIds: ['r2'] } } }) })
  expect(resultScope).toHaveTextContent('2行（実行時）')
  expect(screen.getByTestId('analysis-scope-summary')).toHaveTextContent('1行')
  expect(screen.getByText('対象・設定が変更されています。結果は前回実行分です')).toBeVisible()
  expect(api.post).toHaveBeenCalledTimes(1)
  const rao = screen.getByTestId('crosstab-rao-scott')
  expect(rao).toHaveAccessibleDescription('現在の変数・集計対象・欠損設定で再集計します。')
  expect(rao).toHaveClass('crosstab-wrap-action')
  fireEvent.click(rao)
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(api.post).toHaveBeenLastCalledWith('/summaries/crosstab', {
    context: { datasetId: 'd', expectedDataRevision: 3, expectedSchemaRevision: 2,
      scope: 'active', activeRowIds: ['r2'], weightMode: 'column', weightColumn: 'weightRatio', missingPolicy: 'exclude' },
    rowVariableId: 'legacy', colVariableId: 'col', includeRowIds: true, maxRowIdsPerCell: 10000, inference: 'rao_scott',
  })
  expect(api.put).not.toHaveBeenCalled()
})
