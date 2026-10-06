import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider, useSelector } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { message } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api, getCodebook, type CodebookColumn, type CodebookResponse, type SurveyDesignSpec,
  type WeightConfig,
} from '../src/api/client'
import {
  store, datasetLoaded, variablesInitialized, weightColumnSet, weightColumnCleared,
  type RootState,
} from '../src/app/store'
import {
  codebookReceived, codebookReset, draftColumnUpdated, fetchCodebookThunk,
} from '../src/features/dataset/codebookSlice'
import CrosstabPage from '../src/features/crosstab/CrosstabPage'
import { GlobalHeaderControlBar } from '../src/features/selection/GlobalHeaderControlBar'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Keep the exported application store, every reducer/consumer, useCodebook,
// CrosstabPage, and both ordinary/global ColumnSelect controls real. These are
// unrelated data-loading hooks, not substitutes for weight state or controls.
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => null }))
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [] }))

const clone = <T,>(value: T): T => structuredClone(value)
const weight = (id = 'a-w1'): WeightConfig => ({ weightColumnId: id, weightType: 'survey' })
const design = (id = 'a-w1'): SurveyDesignSpec => ({
  weightColumnId: id, strataColumnId: null, psuColumnId: null, fpcColumnId: null,
})

function column(id: string, name: string, role: 'question' | 'weight' = 'question'): CodebookColumn {
  return {
    columnId: id, name, label: name, scaleType: role === 'weight' ? 'ratio' : 'nominal',
    role, valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null,
  }
}

function book(id: string): CodebookResponse {
  return {
    datasetId: id, schemaRevision: 10, licenseText: '', licenseRevision: 1,
    columns: [column(`${id}-row`, 'Row'), column(`${id}-col`, 'Col'),
      column(`${id}-w1`, 'W1', 'weight'), column(`${id}-w2`, 'W2', 'weight'),
      column(`${id}-w3`, 'W3', 'weight'), column(`${id}-strata`, 'Strata'),
      column(`${id}-psu`, 'PSU')],
    multiResponseGroups: [], weightConfig: null, surveyDesign: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

type PutBody = {
  columns: Partial<CodebookColumn>[]
  expectedSchemaRevision: number
  weightConfig: WeightConfig | null
  surveyDesign?: SurveyDesignSpec | null
}
type PutResponse = {
  status: string; datasetId: string; schemaRevision: number; updatedColumns: number;
  codebook: CodebookResponse;
}

function harness({ declared = false, firstWriteCommits = true } = {}) {
  const snapshots: Record<string, CodebookResponse> = { a: book('a'), b: book('b') }
  if (declared) {
    snapshots.a.weightConfig = weight()
    snapshots.a.surveyDesign = design()
  }
  const pending: Array<{
    body: PutBody; committed: boolean; finish(): void; fail(reason?: unknown): void;
  }> = []
  let failNextRead = false
  const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    const id = path.split('/')[2]
    expect(path).toBe(`/datasets/${id}/codebook`)
    if (failNextRead) { failNextRead = false; throw new Error('canonical GET unavailable') }
    return clone(snapshots[id]) as any
  })
  const put = vi.spyOn(api, 'put').mockImplementation((path: string, body: PutBody) => {
    const id = path.split('/')[2]
    expect(path).toBe(`/datasets/${id}/codebook`)
    const current = snapshots[id]
    // Server CAS is checked before persistence and BEFORE holding delivery.
    // No pair of successful writes can share an expected schema revision.
    if (body.expectedSchemaRevision !== current.schemaRevision) {
      return Promise.reject({ code: 'ANALYSIS_INPUT_STALE', message: 'schema revision changed' })
    }
    expect(body.columns).toEqual([])
    const committed = pending.length !== 0 || firstWriteCommits
    const next = clone(current)
    if (committed) {
      next.weightConfig = clone(body.weightConfig)
      if ('surveyDesign' in body) {
        next.surveyDesign = body.surveyDesign === null ? null : {
          ...design(body.surveyDesign?.weightColumnId ?? `${id}-w1`), ...clone(body.surveyDesign),
        }
      } else if (JSON.stringify(current.weightConfig) !== JSON.stringify(body.weightConfig)) {
        next.surveyDesign = null
      }
      if (next.surveyDesign) expect(next.surveyDesign.weightColumnId).toBe(next.weightConfig?.weightColumnId)
      next.schemaRevision++
      snapshots[id] = next
    }
    const wire = deferred<PutResponse>()
    pending.push({
      body: clone(body), committed,
      finish() {
        if (!committed) throw new Error('A write that never reached the server cannot return committed success')
        wire.resolve({ status: 'success', datasetId: id, schemaRevision: next.schemaRevision,
          updatedColumns: 0, codebook: clone(next) })
      },
      fail(reason = new Error('weight response was lost')) { wire.reject(reason) },
    })
    return wire.promise as any
  })
  return { snapshots, pending, get, put, failRead() { failNextRead = true } }
}
type Harness = ReturnType<typeof harness>

async function install(id: 'a' | 'b') {
  const response = await getCodebook(id)
  // These production installation actions advance the real dataset generation;
  // a weight/schema write alone never advances dataRevision.
  store.dispatch(datasetLoaded({ datasetId: id, name: id,
    rowIds: [`${id}-r1`, `${id}-r2`], dataRevision: 7 }))
  store.dispatch(variablesInitialized({ datasetId: id,
    variables: response.columns.map(c => c.name),
    meta: Object.fromEntries(response.columns.map(c => [c.name, {
      columnId: c.columnId, name: c.name,
      semanticType: c.role === 'weight' ? 'numeric' as const : 'nominal' as const,
      physicalType: c.role === 'weight' ? 'Float64' : 'String', missingCount: 0,
      isTargetCandidate: false,
    }])) }))
  store.dispatch(codebookReceived(response))
}

function DatasetKeyedCrosstab() {
  const id = useSelector((s: RootState) => s.selection.datasetId)
  return <CrosstabPage key={id} />
}

function mount({ header = false, keyed = false } = {}) {
  return render(<Provider store={store}>
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {header && <GlobalHeaderControlBar />}
      {keyed ? <DatasetKeyedCrosstab /> : <CrosstabPage />}
    </MemoryRouter>
  </Provider>)
}

const pickerNames: Record<string, string> = {
  'global-weight-select': '変数を選択',
  'crosstab-row-variable': 'クロス集計の行変数（表側）を選択',
  'crosstab-col-variable': 'クロス集計の列変数（表頭）を選択',
  'crosstab-weight': 'クロス集計のウェイトを選択',
  'crosstab-strata': 'クロス集計の層（strata）を選択',
  'crosstab-psu': 'クロス集計のPSUを選択',
}

async function findPickerDialog(testId: string) {
  // rc-util uses duplicate title IDs for retained modals only in test mode.
  // The purpose-named search and exact visible title identify the real dialog.
  const searchName = testId === 'global-weight-select' ? '変数名・質問文で絞り込み'
    : pickerNames[testId].replace(/を選択$/, 'を変数名・質問文で絞り込み')
  const search = await screen.findByRole('textbox', { name: searchName, exact: true })
  const dialog = search.closest<HTMLElement>('[role="dialog"]')!
  await waitFor(() => expect(dialog).toBeVisible())
  expect(within(dialog).getByText(pickerNames[testId], { exact: true })).toBeVisible()
  return dialog
}

async function choose(testId: string, name: string | null) {
  const wrapper = screen.getByTestId(testId).closest('.column-select-multi-wrap') as HTMLElement
  fireEvent.click(within(wrapper).getByRole('button', { name: pickerNames[testId] }))
  const dialog = await findPickerDialog(testId)
  if (name === null) fireEvent.click(within(dialog).getByRole('button', { name: '選択解除' }))
  else fireEvent.click(within(dialog).getByRole('radio', { name, exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}

async function chooseDesign(testId: string, name: string | null, surface: 'inline' | 'dialog') {
  if (surface === 'dialog') return choose(testId, name)
  const picker = screen.getByTestId(testId)
  if (name === null) {
    const clear = picker.querySelector('.ant-select-clear')
    expect(clear).not.toBeNull()
    fireEvent.mouseDown(clear!)
  } else {
    fireEvent.mouseDown(within(picker).getByRole('combobox'))
    const option = await waitFor(() => {
      const match = Array.from(document.querySelectorAll(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
      )).find(item => within(item as HTMLElement).queryByText(name, { exact: true }))
      if (!match) throw new Error(`Missing inline design option ${name}`)
      return match
    })
    fireEvent.click(option)
  }
}

function expectDesignValue(testId: string, name: string | null) {
  const picker = screen.getByTestId(testId)
  if (name === null) {
    expect(picker.querySelector('.ant-select-selection-item')).toBeNull()
    expect(within(picker).getByText('未指定')).toBeVisible()
  } else {
    expect(picker.querySelector('.ant-select-selection-item')).toHaveTextContent(name)
    expect(within(picker).queryByText('未指定')).toBeNull()
  }
}

async function expectDesignDialogValue(testId: string, name: string | null) {
  const wrapper = screen.getByTestId(testId).closest('.column-select-multi-wrap') as HTMLElement
  fireEvent.click(within(wrapper).getByRole('button', { name: pickerNames[testId] }))
  const dialog = await findPickerDialog(testId)
  expect(within(dialog).getByRole('status')).toHaveTextContent(`${name === null ? 0 : 1}件選択中`)
  expect(within(dialog).queryAllByRole('radio', { checked: true })).toHaveLength(name === null ? 0 : 1)
  if (name !== null) expect(within(dialog).getByRole('radio', { name, exact: true })).toBeChecked()
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}

async function inputs(weightName = 'W1') {
  await choose('crosstab-row-variable', 'Row')
  await choose('crosstab-col-variable', 'Col')
  await choose('crosstab-weight', weightName)
}

function declareSurvey() {
  const group = screen.getByTestId('crosstab-weight-type')
  fireEvent.click(within(group).getByRole('radio', { name: '調査ウェイト（母集団代表性の補正）' }))
}

function expectPickerDisabled(testId: string) {
  const wrapper = screen.getByTestId(testId).closest('.column-select-multi-wrap') as HTMLElement
  expect(within(wrapper).getByRole('button', { name: pickerNames[testId] })).toBeDisabled()
  expect(within(wrapper).getByRole('combobox')).toBeDisabled()
}

async function deliver(server: Harness, index: number, outcome: 'success' | 'failure' = 'success', reason?: unknown) {
  await act(async () => {
    if (outcome === 'success') server.pending[index].finish()
    else server.pending[index].fail(reason)
    // Let the API wrapper, producer, RTK acknowledgment and component's await
    // all settle before asserting that no obsolete toast/reset occurred.
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function surveyResult(schemaRevision: number, inference: 'auto' | 'rao_scott', weightName = 'W1') {
  const tested = inference === 'rao_scott'
  const weightColumnId = `a-${weightName.toLowerCase()}`
  return {
    meta: { datasetId: 'a', dataRevision: 7, schemaRevision, scope: 'active', scopeHash: 'sha256:a',
      scopeCount: 2, effectiveN: 2, missingCount: 0, weightApplied: true, weightColumn: weightName,
      algorithmVersion: 'crosstab-survey-2', isExplorative: false, warnings: [] },
    rowCategories: [{ id: 'r', label: 'Row category', order: 0 }],
    colCategories: [{ id: 'c', label: 'Col category', order: 0 }],
    cells: [{ rowCategoryId: 'r', colCategoryId: 'c', rowLabel: 'Row category', colLabel: 'Col category',
      unweightedCount: 2, count: 2, rowPct: 100, colPct: 100, totalPct: 100, expectedCount: 2,
      residual: 0, asr: null, residualType: 'adjusted', significance: '', rowIds: ['a-r1', 'a-r2'],
      rowIdCount: 2, rowIdsTruncated: false }],
    rowTotals: [{ categoryId: 'r', label: 'Row category', unweightedCount: 2, count: 2 }],
    colTotals: [{ categoryId: 'c', label: 'Col category', unweightedCount: 2, count: 2 }],
    grandTotal: { unweightedCount: 2, count: 2 },
    descriptiveAssociation: { pearsonChi2: 1, df: 1, cramersV: null, weightedCramersV: 0.2, weighted: true },
    inference: { requested: tested, status: tested ? 'ok' : 'not_requested',
      method: tested ? 'rao_scott_second_order' : null, statisticType: tested ? 'F' : null,
      statistic: tested ? 2 : null, numeratorDf: tested ? 1 : null, denominatorDf: tested ? 10 : null,
      pValue: tested ? 0.2 : null, designAssumption: tested ? 'independent_rows' : null,
      approximate: tested ? true : null },
    weightDiagnostics: { weightColumnId, weightType: 'survey', unweightedN: 2,
      weightMissingCount: 0, weightZeroCount: 0, weightSum: 2, kishEffectiveN: 2, weightCv: 0,
      weightingDeff: 1, positiveWeightN: 2, numberOfPSUs: null, numberOfStrata: null, designDf: null },
    diagnostics: { expectedLt5Count: 1, expectedLt5Ratio: 1, smallMarginalWarnings: [] },
    analysisProvenance: { weightColumnId, weightType: 'survey', schemaRevision },
    warnings: [], weightStatus: 'applied',
  }
}

function mockAnalysis(server: Harness) {
  return vi.spyOn(api, 'post').mockImplementation(async (path: string, body: any) => {
    expect(path).toBe('/summaries/crosstab')
    expect(body.context.expectedSchemaRevision).toBe(server.snapshots.a.schemaRevision)
    const selectedWeight = server.snapshots.a.columns.find(column => column.name === body.context.weightColumn)
    expect(selectedWeight?.columnId).toBe(server.snapshots.a.weightConfig?.weightColumnId)
    return surveyResult(server.snapshots.a.schemaRevision, body.inference, selectedWeight?.name) as any
  })
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  vi.spyOn(message, 'error').mockImplementation(() => (() => undefined) as any)
  store.dispatch(codebookReset())
  store.dispatch(weightColumnCleared())
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const designPickerCases = [
  { testId: 'crosstab-strata', key: 'strataColumnId', name: 'Strata', columnId: 'a-strata' },
  { testId: 'crosstab-psu', key: 'psuColumnId', name: 'PSU', columnId: 'a-psu' },
].flatMap(picker => (['inline', 'dialog'] as const).map(surface => ({ ...picker, surface })))

describe('Crosstab design pickers project the saved design', () => {
  it.each(designPickerCases.flatMap(picker => [null, 'a-unresolved'].map(savedId => ({ ...picker, savedId }))))(
    'restores $testId after a rejected $surface choice and canonical GET (savedId=$savedId)',
    async ({ testId, key, surface, savedId }) => {
      const server = harness({ declared: true, firstWriteCommits: false })
      server.snapshots.a.surveyDesign = { ...design(), [key]: savedId }
      await install('a')
      const post = mockAnalysis(server)
      mount()
      await inputs()
      const page = screen.getByTestId('crosstab-page')
      expectDesignValue(testId, null)
      await chooseDesign(testId, 'W1', surface)
      expect(server.pending).toHaveLength(1)
      expect(server.pending[0].committed).toBe(false)
      expect(server.pending[0].body).toEqual({ columns: [], expectedSchemaRevision: 10,
        weightConfig: weight(), surveyDesign: { ...design(), [key]: 'a-w1' } })
      expect(store.getState().codebook.surveyDesign).toEqual({ ...design(), [key]: savedId })
      expectPickerDisabled(testId)
      expect(screen.getByTestId('crosstab-run')).toBeDisabled()
      // Keep going through recovery even when the old uncontrolled inline
      // select exposes an unsaved value while the PUT is still pending.
      expect.soft(screen.getByTestId(testId).querySelector('.ant-select-selection-item')).toBeNull()
      await deliver(server, 0, 'failure', { code: 'CODEBOOK_INVALID',
        message: 'ウェイト列を strata / PSU / fpc に同時指定できません。',
        details: {}, recoverable: true, suggestedActions: [] })
      expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
      expectPickerDisabled(testId)
      expect(screen.getByTestId('crosstab-run')).toBeDisabled()
      expect.soft(screen.getByTestId(testId).querySelector('.ant-select-selection-item')).toBeNull()
      const readsBefore = server.get.mock.calls.length
      fireEvent.click(screen.getByTestId('crosstab-weight-refresh'))
      await waitFor(() => expect(screen.queryByTestId('crosstab-weight-recovery')).toBeNull())
      expect(screen.getByTestId('crosstab-page')).toBe(page)
      expect(server.get).toHaveBeenCalledTimes(readsBefore + 1)
      expect(server.put).toHaveBeenCalledTimes(1)
      expect(store.getState().codebook).toMatchObject({ schemaRevision: 10,
        isWeightSaving: false, weightNeedsRefresh: false, surveyDesign: { ...design(), [key]: savedId } })
      expect(screen.getByTestId('crosstab-run')).toBeEnabled()
      await expectDesignDialogValue(testId, null)
      expectDesignValue(testId, null)
      fireEvent.click(screen.getByTestId('crosstab-run'))
      await screen.findByTestId('crosstab-rao-scott')
      expect(post).toHaveBeenCalledTimes(1)
      expect(post.mock.calls[0][1]).toEqual({ context: {
        datasetId: 'a', expectedDataRevision: 7, expectedSchemaRevision: 10,
        scope: 'active', activeRowIds: ['a-r1', 'a-r2'], weightMode: 'column', weightColumn: 'W1', missingPolicy: 'exclude',
      }, rowVariableId: 'Row', colVariableId: 'Col', includeRowIds: true, maxRowIdsPerCell: 10000, inference: 'auto' })
      expect(screen.getByTestId('crosstab-weight-diagnostics')).toHaveTextContent('回答者数 2')
    },
  )

  // Keep selection, saved receipt, clear, and both reopened dialog checks in one
  // flow. Up to seven real picker dialogs need more than 5s on shared CI runners;
  // only the outer scenario budget changes, not any individual wait/assertion.
  it.each(designPickerCases)('shows $testId accepted $surface selection and clear only after saved receipts',
    async ({ testId, key, name, columnId, surface }) => {
      const server = harness({ declared: true })
      await install('a')
      mount()
      await inputs()
      await chooseDesign(testId, name, surface)
      expectDesignValue(testId, null)
      expectPickerDisabled(testId)
      expect(store.getState().codebook.surveyDesign).toEqual(design())
      expect(server.pending[0].body).toEqual({ columns: [], expectedSchemaRevision: 10,
        weightConfig: weight(), surveyDesign: { ...design(), [key]: columnId } })
      await deliver(server, 0)
      expectDesignValue(testId, name)
      await expectDesignDialogValue(testId, name)
      await chooseDesign(testId, null, surface)
      expectDesignValue(testId, name)
      expectPickerDisabled(testId)
      expect(store.getState().codebook.surveyDesign).toEqual({ ...design(), [key]: columnId })
      expect(server.pending[1].body).toEqual({ columns: [], expectedSchemaRevision: 11,
        weightConfig: weight(), surveyDesign: design() })
      await deliver(server, 1)
      expect(store.getState().codebook).toMatchObject({ schemaRevision: 12, surveyDesign: design() })
      expectDesignValue(testId, null)
      await expectDesignDialogValue(testId, null)
      expect(screen.getByTestId('crosstab-run')).toBeEnabled()
      expect(server.put).toHaveBeenCalledTimes(2)
      expect(message.error).not.toHaveBeenCalled()
    },
    10000,
  )
})

describe('Crosstab weight completion ownership with real controls and store', () => {
  it('accepts current declaration/design saves, blocks duplicate UI writes, and preserves open drafts', async () => {
    const server = harness()
    await install('a')
    store.dispatch(weightColumnSet({ datasetId: 'a', columnId: 'a-w2' }))
    store.dispatch(draftColumnUpdated({ columnId: 'a-row', patch: { label: 'Unsaved row label' } }))
    mount()
    await inputs()
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    declareSurvey()
    expect(server.pending).toHaveLength(1)
    expect(server.snapshots.a.schemaRevision).toBe(11)
    expect(store.getState().codebook.schemaRevision).toBe(10)
    expect(store.getState().codebook.isWeightSaving).toBe(true)
    const radios = within(screen.getByTestId('crosstab-weight-type')).getAllByRole('radio')
    for (const radio of radios) {
      expect(radio).toBeDisabled()
      fireEvent.click(radio)
    }
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    fireEvent.click(screen.getByTestId('crosstab-run'))
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(server.pending[0].body).toMatchObject({ expectedSchemaRevision: 10,
      weightConfig: weight(), surveyDesign: { weightColumnId: 'a-w1' } })
    await deliver(server, 0)
    expect(store.getState().codebook).toMatchObject({ schemaRevision: 11,
      isWeightSaving: false, weightNeedsRefresh: false, weightConfig: weight(), surveyDesign: design(),
      hasChanges: true })
    expect(store.getState().globalVariables.weightColumnId).toBe('a-w1')
    expect(store.getState().codebook.columns[0].label).toBe('Row')
    expect(store.getState().codebook.draftColumns[0].label).toBe('Unsaved row label')
    expect(screen.queryByTestId('crosstab-weight-type')).toBeNull()
    expect(screen.getByTestId('crosstab-run')).toBeEnabled()

    await choose('crosstab-strata', 'Strata')
    expectPickerDisabled('crosstab-strata')
    expectPickerDisabled('crosstab-psu')
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    expect(server.pending[1].body.expectedSchemaRevision).toBe(11)
    await deliver(server, 1)
    await choose('crosstab-psu', 'PSU')
    expect(server.pending[2].body).toMatchObject({ expectedSchemaRevision: 12,
      surveyDesign: { weightColumnId: 'a-w1', strataColumnId: 'a-strata', psuColumnId: 'a-psu' } })
    await deliver(server, 2)
    expect(store.getState().codebook).toMatchObject({ schemaRevision: 13,
      surveyDesign: { strataColumnId: 'a-strata', psuColumnId: 'a-psu' }, hasChanges: true })
    expect(screen.getByTestId('crosstab-strata')).toHaveTextContent('Strata')
    expect(screen.getByTestId('crosstab-psu')).toHaveTextContent('PSU')
    expect(message.error).not.toHaveBeenCalled()
  })

  it('disables an existing Rao–Scott action and both real design pickers while a design save is pending', async () => {
    const server = harness({ declared: true })
    await install('a')
    const post = mockAnalysis(server)
    mount()
    await inputs()
    fireEvent.click(screen.getByTestId('crosstab-run'))
    await screen.findByTestId('crosstab-rao-scott')
    await choose('crosstab-strata', 'Strata')
    expectPickerDisabled('crosstab-strata')
    expectPickerDisabled('crosstab-psu')
    expect(screen.getByTestId('crosstab-rao-scott')).toBeDisabled()
    fireEvent.click(screen.getByTestId('crosstab-rao-scott'))
    fireEvent.click(within(screen.getByTestId('crosstab-psu').closest('.column-select-multi-wrap') as HTMLElement)
      .getByRole('button', { name: pickerNames['crosstab-psu'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(1)
    await deliver(server, 0)
    expect(screen.getByTestId('crosstab-rao-scott')).toBeEnabled()
    expect(message.error).not.toHaveBeenCalled()
  })

  // Preserve the original failed write across a real remount, two canonical
  // reads, and retry. Six/seven real picker dialogs can exceed 5s in shared CI;
  // individual recovery waits still use their normal assertion deadlines.
  it.each([true, false])('keeps unknown-commit recovery across remount, requires GET-only recovery, and permits retry (committed=%s)', async firstWriteCommits => {
    const server = harness({ firstWriteCommits })
    await install('a')
    let view = mount()
    await inputs()
    declareSurvey()
    await deliver(server, 0, 'failure')
    expect(message.error).toHaveBeenCalledTimes(1)
    expect(message.error).toHaveBeenLastCalledWith('ウェイトの種類の保存結果を確認できませんでした。')
    expect(store.getState().codebook).toMatchObject({ isWeightSaving: false, weightNeedsRefresh: true })
    expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    declareSurvey()
    expect(server.put).toHaveBeenCalledTimes(1)

    view.unmount()
    view = mount()
    expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
    await inputs()
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    expect(within(screen.getByTestId('crosstab-weight-type')).getAllByRole('radio')
      .every(radio => (radio as HTMLInputElement).disabled)).toBe(true)
    const readsBefore = server.get.mock.calls.length
    server.failRead()
    fireEvent.click(screen.getByTestId('crosstab-weight-refresh'))
    await waitFor(() => expect(message.error).toHaveBeenCalledTimes(2))
    expect(message.error).toHaveBeenLastCalledWith('最新のウェイト設定を確認できませんでした。もう一度読み込んでください。')
    expect(server.get).toHaveBeenCalledTimes(readsBefore + 1)
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
    expect(store.getState().codebook.weightNeedsRefresh).toBe(true)

    fireEvent.click(screen.getByTestId('crosstab-weight-refresh'))
    await waitFor(() => expect(screen.queryByTestId('crosstab-weight-recovery')).toBeNull())
    expect(server.get).toHaveBeenCalledTimes(readsBefore + 2)
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(store.getState().codebook.weightNeedsRefresh).toBe(false)
    expect(store.getState().codebook.schemaRevision).toBe(firstWriteCommits ? 11 : 10)
    if (firstWriteCommits) {
      expect(screen.queryByTestId('crosstab-weight-type')).toBeNull()
      expect(screen.getByTestId('crosstab-run')).toBeEnabled()
      await choose('crosstab-strata', 'Strata')
    } else {
      expect(screen.getByTestId('crosstab-run')).toBeDisabled()
      declareSurvey()
    }
    expect(server.pending[1].body.expectedSchemaRevision).toBe(firstWriteCommits ? 11 : 10)
    await deliver(server, 1)
    expect(screen.getByTestId('crosstab-run')).toBeEnabled()
    expect(store.getState().codebook.schemaRevision).toBe(firstWriteCommits ? 12 : 11)
    expect(message.error).toHaveBeenCalledTimes(2)
    view.unmount()
  }, 10000)

  it.each(['b', 'a'] as const)('does not toast an old failure after a real dataset-keyed unmount and arrival at %s', async destination => {
    const server = harness()
    await install('a')
    mount({ keyed: true })
    await inputs()
    declareSurvey()
    const oldPage = screen.getByTestId('crosstab-page')
    await act(async () => { await install('b') })
    expect(oldPage).not.toBeInTheDocument()
    if (destination === 'a') await act(async () => { await install('a') })
    await inputs()
    const before = store.getState()
    await deliver(server, 0, 'failure')
    expect(store.getState()).toBe(before)
    expect(store.getState().selection.datasetId).toBe(destination)
    expect(screen.queryByTestId('crosstab-weight-recovery')).toBeNull()
    expect(message.error).not.toHaveBeenCalled()
  })

  it('shows the current design-save failure and restores its committed design through canonical GET alone', async () => {
    const server = harness({ declared: true })
    await install('a')
    mount()
    await inputs()
    await choose('crosstab-strata', 'Strata')
    expect(server.snapshots.a.surveyDesign?.strataColumnId).toBe('a-strata')
    expect(store.getState().codebook.surveyDesign?.strataColumnId).toBeNull()
    await deliver(server, 0, 'failure')
    expect(message.error).toHaveBeenCalledTimes(1)
    expect(message.error).toHaveBeenCalledWith('調査設計の保存結果を確認できませんでした。')
    expectPickerDisabled('crosstab-strata')
    expectPickerDisabled('crosstab-psu')
    expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
    fireEvent.click(screen.getByTestId('crosstab-weight-refresh'))
    await waitFor(() => expect(screen.queryByTestId('crosstab-weight-recovery')).toBeNull())
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(store.getState().codebook).toMatchObject({ schemaRevision: 11,
      isWeightSaving: false, weightNeedsRefresh: false, surveyDesign: { strataColumnId: 'a-strata' } })
    expect(screen.getByTestId('crosstab-strata')).toHaveTextContent('Strata')
    expect(screen.getByTestId('crosstab-run')).toBeEnabled()
  })

  it('resets prior Rao–Scott intent to auto when the current W2 survey declaration succeeds', async () => {
    const server = harness({ declared: true })
    await install('a')
    const post = mockAnalysis(server)
    mount()
    await inputs()
    fireEvent.click(screen.getByTestId('crosstab-run'))
    fireEvent.click(await screen.findByTestId('crosstab-rao-scott'))
    await screen.findByTestId('crosstab-design-assumption')
    expect(post.mock.calls.map(call => (call[1] as any).inference)).toEqual(['auto', 'rao_scott'])

    // Selecting a non-null weight clears the result but deliberately keeps the
    // existing inference choice. This current declaration must still reset it.
    await choose('crosstab-weight', 'W2')
    expect(screen.queryByTestId('crosstab-design-assumption')).toBeNull()
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    declareSurvey()
    expect(server.pending[0].body).toMatchObject({ expectedSchemaRevision: 10,
      weightConfig: weight('a-w2'), surveyDesign: { weightColumnId: 'a-w2' } })
    await deliver(server, 0)
    expect(store.getState().codebook).toMatchObject({ schemaRevision: 11,
      weightConfig: weight('a-w2'), surveyDesign: design('a-w2') })
    expect(post).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('crosstab-run'))
    await screen.findByTestId('crosstab-rao-scott')
    expect(post.mock.calls.map(call => (call[1] as any).inference)).toEqual(['auto', 'rao_scott', 'auto'])
    expect(post.mock.calls[2][1]).toMatchObject({ context: {
      weightColumn: 'W2', expectedSchemaRevision: 11,
    } })
    expect(screen.queryByTestId('crosstab-design-assumption')).toBeNull()
    expect(message.error).not.toHaveBeenCalled()
  })

  it('keeps a newer same-instance Rao–Scott choice after canonical read releases a delayed declaration', async () => {
    const server = harness()
    await install('a')
    const post = mockAnalysis(server)
    mount()
    await inputs()
    const originalPage = screen.getByTestId('crosstab-page')
    declareSurvey()
    const owner = store.getState().codebook.weightRequestId
    const installation = store.getState().selection.revision
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    await act(async () => { await store.dispatch(fetchCodebookThunk('a')).unwrap() })
    expect(screen.getByTestId('crosstab-page')).toBe(originalPage)
    expect(store.getState().selection.revision).toBe(installation)
    expect(store.getState().codebook).toMatchObject({ weightRequestId: owner,
      weightSnapshotAdvanced: true, isWeightSaving: false, schemaRevision: 11 })
    expect(screen.getByTestId('crosstab-run')).toBeEnabled()
    fireEvent.click(screen.getByTestId('crosstab-run'))
    fireEvent.click(await screen.findByTestId('crosstab-rao-scott'))
    await screen.findByTestId('crosstab-design-assumption')
    expect(post.mock.calls.map(call => (call[1] as any).inference)).toEqual(['auto', 'rao_scott'])

    await deliver(server, 0)
    expect(store.getState().codebook.weightRequestId).toBe(owner)
    expect(screen.getByTestId('crosstab-design-assumption')).toBeVisible()
    expect(screen.queryByTestId('crosstab-rao-scott')).toBeNull()
    expect(post).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('crosstab-run'))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
    expect((post.mock.calls[2][1] as any).inference).toBe('rao_scott')
    expect(message.error).not.toHaveBeenCalled()
  })

  it.each(['roundtrip', 'same-value confirmation'] as const)('suppresses stale notices after a real local picker %s without superseding the store owner', async intent => {
    const server = harness()
    await install('a')
    mount()
    await inputs()
    declareSurvey()
    const owner = store.getState().codebook.weightRequestId
    if (intent === 'roundtrip') await choose('crosstab-row-variable', 'Col')
    // Same-value confirmation emits a real ColumnSelect onChange but leaves
    // every rendered noticeInput value unchanged. Only event-time intent can
    // detach the old callback in that case; no reducer/install is substituted.
    await choose('crosstab-row-variable', 'Row')
    expect(store.getState().codebook.weightRequestId).toBe(owner)
    expect(store.getState().codebook.schemaRevision).toBe(10)
    await deliver(server, 0, 'failure')
    expect(store.getState().codebook).toMatchObject({ weightRequestId: owner,
      isWeightSaving: false, weightNeedsRefresh: true })
    expect(screen.getByTestId('crosstab-row-variable')).toHaveTextContent('Row')
    expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
    expect(message.error).not.toHaveBeenCalled()
  })

  it.each([false, true])('detaches a cached page notice on deactivation and preserves recovery when returned (reactivated before delivery=%s)', async reactivateBeforeDelivery => {
    const server = harness()
    await install('a')
    const cachedPage = (active: boolean) => <Provider store={store}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AnalysisViewActivityContext.Provider value={active}>
          <div style={{ display: active ? 'block' : 'none' }}><CrosstabPage /></div>
        </AnalysisViewActivityContext.Provider>
      </MemoryRouter>
    </Provider>
    const view = render(cachedPage(true))
    await inputs()
    declareSurvey()
    const page = screen.getByTestId('crosstab-page')
    const owner = store.getState().codebook.weightRequestId
    const installation = store.getState().selection.revision

    view.rerender(cachedPage(false))
    expect(page).toBeInTheDocument()
    expect(page).not.toBeVisible()
    if (reactivateBeforeDelivery) view.rerender(cachedPage(true))
    expect(screen.getByTestId('crosstab-page')).toBe(page)
    await deliver(server, 0, 'failure')
    // KeepAlive-style hiding retires only the local notice. This is still the
    // current store mutation, so its unknown-commit recovery must survive.
    expect(store.getState().selection.revision).toBe(installation)
    expect(store.getState().codebook).toMatchObject({ weightRequestId: owner,
      isWeightSaving: false, weightNeedsRefresh: true, schemaRevision: 10 })
    expect(message.error).not.toHaveBeenCalled()

    if (!reactivateBeforeDelivery) view.rerender(cachedPage(true))
    expect(screen.getByTestId('crosstab-page')).toBe(page)
    expect(page).toBeVisible()
    expect(screen.getByTestId('crosstab-weight-recovery')).toBeVisible()
    expect(screen.getByTestId('crosstab-run')).toBeDisabled()
    expect(message.error).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('crosstab-weight-refresh'))
    await waitFor(() => expect(screen.queryByTestId('crosstab-weight-recovery')).toBeNull())
    expect(screen.getByTestId('crosstab-run')).toBeEnabled()
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(store.getState().codebook.schemaRevision).toBe(11)
  })

  it('preserves the real header W2 → W3 → W2 intent roundtrip after accepting a W1 declaration', async () => {
    const server = harness()
    await install('a')
    mount({ header: true })
    await choose('global-weight-select', 'W2')
    await inputs()
    declareSurvey()
    const selectionRevision = store.getState().globalVariables.weightSelectionRevision
    await choose('global-weight-select', 'W3')
    await choose('global-weight-select', 'W2')
    expect(store.getState().globalVariables).toMatchObject({ weightColumnId: 'a-w2',
      weightSelectionRevision: selectionRevision + 2 })
    await deliver(server, 0)
    expect(store.getState().codebook).toMatchObject({ schemaRevision: 11, weightConfig: weight() })
    expect(store.getState().globalVariables.weightColumnId).toBe('a-w2')
    expect(screen.getByTestId('global-weight-select')).toHaveTextContent('W2')
    expect(server.put).toHaveBeenCalledTimes(1)
    expect(message.error).not.toHaveBeenCalled()
  })
})
