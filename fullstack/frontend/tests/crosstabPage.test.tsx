import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store, selectionApplied } from '../src/app/store'
import { api } from '../src/api/client'
import CrosstabPage, { crosstabToCsv } from '../src/features/crosstab/CrosstabPage'

vi.mock('../src/features/dataset/useCodebookColumn', () => ({
  useCodebook: () => ({
    schemaRevision: 1,
    getColumn: () => undefined,
    columns: [
      { name: 'row', columnId: 'c-row', label: '行', scaleType: 'nominal', role: 'question', multiResponseGroup: null },
      { name: 'col', columnId: 'c-col', label: '列', scaleType: 'nominal', role: 'question', multiResponseGroup: null },
    ],
  }),
}))
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

const payload = {
  meta: {
    datasetId: 'd', dataRevision: 2, schemaRevision: 1, scope: 'active', scopeHash: 'sha256:x',
    scopeCount: 200, effectiveN: 200, missingCount: 0, weightApplied: false, weightColumn: null,
    algorithmVersion: 'crosstab-1', isExplorative: false, warnings: [],
  },
  rowCategories: [{ id: 'a', label: 'A', order: 0 }],
  colCategories: [{ id: 'x', label: 'X', order: 0 }],
  cells: [{
    rowCategoryId: 'a', colCategoryId: 'x', rowLabel: 'A', colLabel: 'X',
    unweightedCount: 200, count: 200, rowPct: 100, colPct: 100, totalPct: 100,
    expectedCount: 200, asr: null, significance: '', rowIds: ['r1', 'r2'],
    rowIdCount: 2, rowIdsTruncated: false,
  }],
  rowTotals: [{ categoryId: 'a', label: 'A', unweightedCount: 200, count: 200 }],
  colTotals: [{ categoryId: 'x', label: 'X', unweightedCount: 200, count: 200 }],
  grandTotal: { unweightedCount: 200, count: 200 },
  statistics: {
    chi2: null, df: 0, pValue: null, cramersV: null, inferenceMethod: 'pearson',
    expectedLt5Count: 0, expectedLt5Ratio: 0, smallMarginalWarnings: [],
  },
  warnings: [],
  weightStatus: 'omitted',
  weightMissingCount: 0,
  weightedN: null,
}

function localStore() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 2, activeRowIds: ['r1', 'r2'], selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r1', 'r2'], sampling: { sampledRowIds: [] } },
  }
  const local = configureStore({ reducer: (s = state, action: any) => {
    if (typeof action?.type === 'string' && action.type.startsWith('selection/')) {
      const next = { ...s }
      selectionApplied as unknown
      void selectionApplied
      return next
    }
    return s
  }, middleware: get => get({ serializableCheck: false }) })
  return local
}

it('runs crosstab and switches display modes without reselecting', async () => {
  const local = localStore()
  const post = vi.spyOn(api, 'post').mockResolvedValue(payload)
  const view = render(<Provider store={local}><MemoryRouter><CrosstabPage /></MemoryRouter></Provider>)
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.change(view.getByTestId('crosstab-row-variable'), { target: { value: 'row' } })
  fireEvent.change(view.getByTestId('crosstab-col-variable'), { target: { value: 'col' } })
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
  const { fireEvent } = await import('@testing-library/react')
  fireEvent.change(view.getByTestId('crosstab-row-variable'), { target: { value: 'row' } })
  fireEvent.change(view.getByTestId('crosstab-col-variable'), { target: { value: 'col' } })
  fireEvent.click(view.getByTestId('crosstab-run'))
  await waitFor(() => expect(view.getByTestId('crosstab-cell-a-x')).toBeTruthy())
  fireEvent.click(view.getByTestId('crosstab-cell-a-x'))
  fireEvent.click(await view.findByText('選択を置換'))
  await waitFor(() => expect(dispatch).toHaveBeenCalled())
  const action = dispatch.mock.calls.map((c) => c[0]).find((a) => String(a?.type).includes('selectionApplied'))
  expect(action?.payload?.rowIds).toEqual(['r1', 'r2'])
  expect(action?.payload?.operation).toBe('replace')
})

it('escapes formula prefixes in csv export', () => {
  const csv = crosstabToCsv({ ...payload, cells: [{ ...payload.cells[0], rowLabel: '=cmd' }] })
  expect(csv).toContain("'=cmd")
  expect(csv).toContain('# scopeHash,sha256:x')
})
