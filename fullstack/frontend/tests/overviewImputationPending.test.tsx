import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { Provider } from 'react-redux'
import { selectionReducer, store, type RootState } from '../src/app/store'
import { api } from '../src/api/client'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import OverviewPage from '../src/features/dataset/OverviewPage'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Real Overview, ColumnTable, ImputationModal, ActiveModal, and reducers.
// Only unrelated dialogs/history, chart rendering, and transport are replaced.
vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChartSurface', () => ({ default: () => null }))

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) await dispose()
  vi.restoreAllMocks()
})

it('keeps direct Imputation Apply single-flight for dataset A after Overview deactivation and reopening', async () => {
  const base = store.getState()
  const book = { datasetId: 'a', schemaRevision: 1, multiResponseGroups: [], columns: [{
    columnId: 'x', name: 'x', label: 'x', role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null,
  }] }
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'a', revision: 1, dataRevision: 1,
      allRowIds: ['a-r1', 'a-r2'], activeRowIds: ['a-r1', 'a-r2'], activeRowIdSet: new Set(['a-r1', 'a-r2']), selectedRowIds: [] },
    codebook: { ...base.codebook, ...book, isLoading: false },
  } as RootState
  const local = configureStore({ reducer: (state = initial, action: any) => ({ ...state,
    selection: selectionReducer(state.selection, action), codebook: codebookSlice.reducer(state.codebook, action),
  }), middleware: defaults => defaults({ serializableCheck: false }) })
  const requests: { path: string; body: any; promise: Promise<any>; reject: (error: Error) => void }[] = []
  const unexpected: string[] = []
  let settledCount = 0
  // Toast rendering is unrelated to mutation admission; pending requests are
  // rejected only after the final oracle, during cleanup of this bounded proof.
  for (const kind of ['success', 'warning', 'error'] as const) {
    vi.spyOn(message, kind).mockImplementation(() => (() => {}) as any)
  }
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/datasets/a/codebook') return book as any
    if (path !== '/datasets/a') {
      unexpected.push(`GET ${path}`)
      throw new Error(`Unexpected GET ${path}`)
    }
    return { datasetId: 'a', name: 'Dataset A', format: 'csv', rowCount: 2, columnCount: 1,
      fingerprint: 'a-1', dataRevision: 1, schemaRevision: 1, rowIdentity: 'stable', createdAt: '2026-10-12T00:00:00Z',
      schema: [{ columnId: 'x', name: 'x', physicalType: 'Float64', semanticType: 'numeric',
        role: 'numeric_axis', missingCount: 1, uniqueCount: 1, min: 4, max: 4 }],
    } as any
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    if (path === '/summaries') return { rowCount: 2, columns: { x: { count: 1, missing: 1,
      uniqueCount: 1, min: 4, max: 4, mean: 4 } } } as any
    if (path !== '/datasets/a/impute') {
      unexpected.push(`POST ${path}`)
      throw new Error(`Unexpected POST ${path}; this regression requires no preview`)
    }
    let reject!: (error: Error) => void
    const promise = new Promise<any>((_resolve, fail) => { reject = fail })
    requests.push({ path, body, promise, reject })
    try { return await promise } finally { settledCount++ }
  })
  disposals.push(async () => {
    await act(async () => {
      const settled = Promise.allSettled(requests.map(request => request.promise))
      requests.forEach(request => request.reject(new Error('test cleanup after admission oracle')))
      await settled
    })
  })
  const ui = (active: boolean) => <ConfigProvider theme={{ token: { motion: false } }}>
    <Provider store={local}><AnalysisViewActivityContext.Provider value={active}>
      <OverviewPage />
    </AnalysisViewActivityContext.Provider></Provider>
  </ConfigProvider>
  const view = render(ui(true))
  const open = async () => {
    fireEvent.click(await view.findByTestId('btn-impute-x'))
    const dialog = await view.findByRole('dialog')
    const mean = within(dialog).getByRole('radio', { name: 'Mean (平均値)', exact: true })
    fireEvent.click(mean)
    // A shared pending lock may disable the entire reopened form. When editable,
    // choosing Mean must work and supplies the same valid direct-Apply request.
    if (!(mean as HTMLInputElement).disabled) expect(mean).toBeChecked()
    return within(dialog).getByTestId('btn-execute-imputation')
  }
  const apply = await open()
  expect(apply).toBeEnabled()
  fireEvent.click(apply)
  fireEvent.click(apply)
  expect(requests, 'Repeated Apply within the same modal instance stays single-flight').toHaveLength(1)
  expect(apply).toBeDisabled()
  expect(requests[0].body).toEqual({ columns: ['x'], predictorColumns: undefined,
    strategy: 'mean', options: { seed: 42 }, inPlace: true, planHash: undefined })
  expect(post.mock.calls.filter(([path]) => path.endsWith('/impute/preview'))).toHaveLength(0)
  expect(settledCount).toBe(0)
  console.info('IMPUTATION_SAME_INSTANCE_GUARD', JSON.stringify({ admitted: requests.length,
    settled: settledCount, applyDisabled: (apply as HTMLButtonElement).disabled,
    previewRequests: 0, body: requests[0].body }))

  view.rerender(ui(false))
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
  expect(apply).not.toBeInTheDocument()
  view.rerender(ui(true))
  expect(view.queryByRole('dialog')).toBeNull()
  const reopened = await open()
  expect(reopened).not.toBe(apply)
  fireEvent.click(reopened)
  expect(unexpected).toEqual([])
  expect(post.mock.calls.filter(([path]) => path.endsWith('/impute/preview'))).toHaveLength(0)
  expect(settledCount).toBe(0)
  console.info('IMPUTATION_PENDING_ADMISSIONS', JSON.stringify({ settled: settledCount,
    previewRequests: 0, requests: requests.map(({ path, body }) => ({ path, body })) }))
  expect(requests, 'Navigation/reopen must not admit a second impute for A while the first is pending').toHaveLength(1)
})
