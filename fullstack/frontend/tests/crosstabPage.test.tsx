import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import { api } from '../src/api/client'
import CrosstabPage, { crosstabToCsv } from '../src/features/crosstab/CrosstabPage'

// The page reads the weight's declared *meaning* from the codebook, so the mock
// follows the store rather than a frozen fixture: declaring a type in the test
// has to be visible to the next render, exactly as it is in the app.
vi.mock('../src/features/dataset/useCodebookColumn', async () => {
  const { useSelector } = await import('react-redux')
  return {
    useCodebook: () => {
      const codebook = useSelector((s: any) => s.codebook)
      return {
        columns: [
          { name: 'row', columnId: 'c-row', label: '行', scaleType: 'nominal', role: 'question', multiResponseGroup: null },
          { name: 'col', columnId: 'c-col', label: '列', scaleType: 'nominal', role: 'question', multiResponseGroup: null },
          { name: 'w', columnId: 'c-w', label: 'ウェイト', scaleType: 'ratio', role: 'weight', multiResponseGroup: null },
        ],
        schemaRevision: codebook?.schemaRevision ?? 1,
        weightConfig: codebook?.weightConfig ?? null,
        surveyDesign: codebook?.surveyDesign ?? null,
        getColumn: () => undefined,
      }
    },
  }
})
vi.mock('../src/features/common/ColumnSelect', () => ({
  default: (props: any) => (
    <select
      data-testid={props['data-testid']}
      value={props.value ?? ''}
      onChange={(event) => props.onChange(event.target.value || null)}
    >
      <option value="">選択</option>
      {(props.options ?? []).map((option: any) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      datasetId: 'd', dataRevision: 2, schemaRevision: 1, scope: 'active', scopeHash: 'sha256:x',
      scopeCount: 200, effectiveN: 200, missingCount: 0, weightApplied: false, weightColumn: null,
      algorithmVersion: 'crosstab-survey-2', isExplorative: false, warnings: [],
    },
    rowCategories: [{ id: 'a', label: 'A', order: 0 }],
    colCategories: [{ id: 'x', label: 'X', order: 0 }],
    cells: [{
      rowCategoryId: 'a', colCategoryId: 'x', rowLabel: 'A', colLabel: 'X',
      unweightedCount: 200, count: 200, rowPct: 100, colPct: 100, totalPct: 100,
      expectedCount: 200, residual: 0, asr: null, residualType: 'adjusted', significance: '',
      rowIds: ['r1', 'r2'], rowIdCount: 2, rowIdsTruncated: false,
    }],
    rowTotals: [{ categoryId: 'a', label: 'A', unweightedCount: 200, count: 200 }],
    colTotals: [{ categoryId: 'x', label: 'X', unweightedCount: 200, count: 200 }],
    grandTotal: { unweightedCount: 200, count: 200 },
    descriptiveAssociation: {
      pearsonChi2: 12.5, df: 2, cramersV: 0.31, weightedCramersV: null, weighted: false,
    },
    inference: {
      requested: true, status: 'ok', method: 'pearson', statisticType: 'chi2',
      statistic: 12.5, numeratorDf: 2, denominatorDf: null, pValue: 0.0019,
      designAssumption: null, approximate: null,
    },
    weightDiagnostics: null,
    diagnostics: { expectedLt5Count: 0, expectedLt5Ratio: 0, smallMarginalWarnings: [] },
    analysisProvenance: {
      weightColumnId: null, weightType: null, weightSum: null, kishEffectiveN: null,
      schemaRevision: 1, inferenceMethod: 'pearson', designAssumption: null,
      algorithmVersion: 'crosstab-survey-2',
    },
    warnings: [],
    weightStatus: 'omitted',
    ...overrides,
  }
}

const payload = responseBody()

/** A survey-weighted result: the test is deliberately not run until asked. */
const surveyPayload = responseBody({
  meta: {
    ...(payload.meta as Record<string, unknown>),
    weightApplied: true, weightColumn: 'w',
  },
  descriptiveAssociation: {
    pearsonChi2: 12.5, df: 2, cramersV: null, weightedCramersV: 0.31, weighted: true,
  },
  inference: {
    requested: false, status: 'not_requested', method: null, statisticType: null,
    statistic: null, numeratorDf: null, denominatorDf: null, pValue: null,
    designAssumption: null, approximate: null,
  },
  weightDiagnostics: {
    weightColumnId: 'c-w', weightType: 'survey', unweightedN: 200,
    weightMissingCount: 0, weightZeroCount: 0, weightSum: 20345.7,
    kishEffectiveN: 180.2, weightCv: 0.42, weightingDeff: 1.11,
    positiveWeightN: 200, numberOfPSUs: null, numberOfStrata: null, designDf: null,
  },
  analysisProvenance: {
    weightColumnId: 'c-w', weightType: 'survey', weightSum: 20345.7, kishEffectiveN: 180.2,
    schemaRevision: 1, inferenceMethod: null, designAssumption: null,
    algorithmVersion: 'crosstab-survey-2',
  },
  weightStatus: 'applied',
})

const raoScottPayload = responseBody({
  meta: surveyPayload.meta,
  descriptiveAssociation: surveyPayload.descriptiveAssociation,
  inference: {
    requested: true, status: 'ok', method: 'rao_scott_second_order', statisticType: 'F',
    statistic: 5.1934, numeratorDf: 1.4946, denominatorDf: 20.925, pValue: 0.02175,
    designAssumption: 'independent_rows', approximate: true,
  },
  weightDiagnostics: surveyPayload.weightDiagnostics,
  analysisProvenance: {
    ...surveyPayload.analysisProvenance,
    inferenceMethod: 'rao_scott_second_order', designAssumption: 'independent_rows',
  },
  weightStatus: 'applied',
})

function localStore(codebook: Record<string, unknown> = {}) {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 2, activeRowIds: ['r1', 'r2'], selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r1', 'r2'], sampling: { sampledRowIds: [] } },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, weightConfig: null, surveyDesign: null, ...codebook },
  }
  const local = configureStore({ reducer: (s = state, action: any) => {
    // The weight declaration lives on the dataset, so it has to survive in the
    // store for the page to stop asking for it.
    if (typeof action?.type === 'string' && action.type.startsWith('codebook/')) {
      return { ...s, codebook: codebookSlice.reducer(s.codebook, action) }
    }
    return s
  }, middleware: get => get({ serializableCheck: false }) })
  return local
}

/** The weight picker is a real antd Select, so it opens and is clicked like one. */
async function pickWeight(view: ReturnType<typeof render>) {
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.mouseDown(view.getByTestId('crosstab-weight').querySelector('.ant-select-selector') as Element)
  const option = await waitFor(() => {
    const el = document.querySelector('.ant-select-item-option[title="ウェイト (w)"]')
    if (!el) throw new Error('weight option not rendered')
    return el as Element
  })
  fireEvent.click(option)
}

async function selectInputs(view: ReturnType<typeof render>, { weight = false } = {}) {
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.change(view.getByTestId('crosstab-row-variable'), { target: { value: 'row' } })
  fireEvent.change(view.getByTestId('crosstab-col-variable'), { target: { value: 'col' } })
  if (weight) await pickWeight(view)
  return fireEvent
}

it('runs crosstab and switches display modes without reselecting', async () => {
  const local = localStore()
  const post = vi.spyOn(api, 'post').mockResolvedValue(payload)
  const view = render(<Provider store={local}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  const fireEvent = await selectInputs(view)
  fireEvent.click(view.getByTestId('crosstab-run'))
  await waitFor(() => expect(view.getByTestId('crosstab-cell-a-x')).toBeTruthy())
  expect(post).toHaveBeenCalledTimes(1)
  expect(view.getByTestId('crosstab-cell-a-x').textContent).toContain('100.0%')
  fireEvent.click(view.getByText('Count'))
  expect(view.getByTestId('crosstab-cell-a-x').textContent).toContain('200')
  expect(post).toHaveBeenCalledTimes(1)
})

it('dispatches selectionApplied on cell action without rewriting other state', async () => {
  const local = localStore()
  const dispatch = vi.spyOn(local, 'dispatch')
  vi.spyOn(api, 'post').mockResolvedValue(payload)
  const view = render(<Provider store={local}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  const fireEvent = await selectInputs(view)
  fireEvent.click(view.getByTestId('crosstab-run'))
  await waitFor(() => expect(view.getByTestId('crosstab-cell-a-x')).toBeTruthy())
  fireEvent.click(view.getByTestId('crosstab-cell-a-x'))
  fireEvent.click(await view.findByText('選択を置換'))
  await waitFor(() => expect(dispatch).toHaveBeenCalled())
  const action = dispatch.mock.calls.map((c) => c[0]).find((a) => String(a?.type).includes('selectionApplied'))
  expect(action?.payload?.rowIds).toEqual(['r1', 'r2'])
  expect(action?.payload?.operation).toBe('replace')
})

it('asks for the weight meaning before a weight can be used at all', async () => {
  const local = localStore()
  const put = vi.spyOn(api, 'put').mockResolvedValue({ status: 'ok', datasetId: 'd', schemaRevision: 2, updatedColumns: 0, codebook: { weightConfig: { weightColumnId: 'c-w', weightType: 'survey' }, surveyDesign: { weightColumnId: 'c-w' } } })
  vi.spyOn(api, 'post').mockResolvedValue(payload)
  const view = render(<Provider store={local}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  await selectInputs(view, { weight: true })

  const group = await view.findByTestId('crosstab-weight-type')
  const radio = group.querySelector('input[value="survey"]') as HTMLInputElement
  const { fireEvent } = await import('@testing-library/react')
  // Running now would only be rejected by the server, so it is not offered.
  expect(view.getByTestId('crosstab-run').closest('button')?.disabled).toBe(true)
  fireEvent.click(radio)

  await waitFor(() => expect(put).toHaveBeenCalled())
  const body = put.mock.calls[0][1] as any
  expect(body.columns).toEqual([])
  expect(body.weightConfig).toEqual({ weightColumnId: 'c-w', weightType: 'survey' })
  // A survey design is only usable once the weight's meaning is declared, so the
  // declaration carries an (empty) design with it.
  expect(body.surveyDesign).toEqual({ weightColumnId: 'c-w' })
  expect(body.expectedSchemaRevision).toBe(1)

  await waitFor(() => expect(view.queryByTestId('crosstab-weight-type')).toBeNull())
  expect(view.getByTestId('crosstab-strata')).toBeTruthy()
  expect(view.getByTestId('crosstab-psu')).toBeTruthy()
})

it('shows survey diagnostics and only runs the design-based test on request', async () => {
  const local = localStore({
    weightConfig: { weightColumnId: 'c-w', weightType: 'survey' },
    surveyDesign: { weightColumnId: 'c-w' },
  })
  const post = vi.spyOn(api, 'post')
    .mockResolvedValueOnce(surveyPayload)
    .mockResolvedValueOnce(raoScottPayload)
  const view = render(<Provider store={local}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  const fireEvent = await selectInputs(view, { weight: true })
  fireEvent.click(view.getByTestId('crosstab-run'))

  await waitFor(() => expect(view.getByTestId('crosstab-weight-diagnostics')).toBeTruthy())
  expect(post.mock.calls[0][1] && (post.mock.calls[0][1] as any).inference).toBe('auto')
  // No p-value is invented for a survey weight; the user has to ask for one.
  expect(view.queryByTestId('crosstab-inference-unavailable')).toBeNull()
  expect(view.getByTestId('crosstab-weight-diagnostics').textContent).toContain('Kish 実効サンプル数')
  expect(view.getByTestId('crosstab-page').textContent).toContain('セル別の ★ は調査ウェイトでは表示しません')

  fireEvent.click(view.getByTestId('crosstab-rao-scott'))

  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect((post.mock.calls[1][1] as any).inference).toBe('rao_scott')
  await waitFor(() => expect(view.getByTestId('crosstab-design-assumption')).toBeTruthy())
  // Weights without strata/PSU are an approximation and the page must say so.
  expect(view.getByTestId('crosstab-design-assumption').textContent).toContain('独立 PSU')
  expect(view.getByTestId('crosstab-page').textContent).toContain('Rao–Scott')
})

it('escapes formula prefixes in csv export and carries the provenance', () => {
  const csv = crosstabToCsv({
    ...(surveyPayload as never),
    cells: [{ ...surveyPayload.cells[0], rowLabel: '=cmd' }],
  } as never)
  expect(csv).toContain("'=cmd")
  expect(csv).toContain('# scopeHash,sha256:x')
  expect(csv).toContain('# weightType,survey')
  expect(csv).toContain('# algorithmVersion,crosstab-survey-2')
})

it('sends explicit unweighted mode after clearing a saved weight, including cell lookup', async () => {
  const local = localStore({ weightConfig: { weightColumnId: 'c-w', weightType: 'frequency' } })
  const truncated = responseBody({ cells: [{ ...payload.cells[0], rowIdsTruncated: true }] })
  const post = vi.spyOn(api, 'post').mockResolvedValue(truncated)
  const view = render(<Provider store={local}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  const fireEvent = await selectInputs(view, { weight: true })
  fireEvent.click(view.getByTestId('crosstab-run'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect((post.mock.calls[0][1] as any).context).toMatchObject({ weightMode: 'column', weightColumn: 'w' })
  fireEvent.mouseDown(view.getByTestId('crosstab-weight').querySelector('.ant-select-clear') as Element)
  fireEvent.click(view.getByTestId('crosstab-run'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect((post.mock.calls[1][1] as any).context).toMatchObject({ weightMode: 'none', weightColumn: null })
  await waitFor(() => expect(view.getByTestId('crosstab-cell-a-x')).toBeTruthy())
  post.mockResolvedValue({ rowIds: ['r1', 'r2'] })
  fireEvent.click(view.getByTestId('crosstab-cell-a-x'))
  fireEvent.click(await view.findByText('選択を置換'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
  expect((post.mock.calls[2][1] as any).context.weightMode).toBe('none')
})

it('omits the absent denominator degrees of freedom and its comma', async () => {
  vi.spyOn(api, 'post').mockResolvedValue(payload)
  const view = render(<Provider store={localStore()}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  const fireEvent = await selectInputs(view)
  fireEvent.click(view.getByTestId('crosstab-run'))
  await waitFor(() => expect(view.getByText('df=2.00')).toBeTruthy())
  expect(view.container.textContent).not.toContain('undefined')
  expect(view.container.textContent).not.toContain('df=2.00,')
})
