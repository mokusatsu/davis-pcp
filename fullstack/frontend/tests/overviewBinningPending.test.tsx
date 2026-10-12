import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, notification } from 'antd'
import { Provider } from 'react-redux'
import { selectionReducer, store, type RootState } from '../src/app/store'
import { api } from '../src/api/client'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import OverviewPage from '../src/features/dataset/OverviewPage'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Preserve real Overview actions, BinningModal, ActiveModal, and reducers.
// Only unrelated dialogs/history, chart rendering, and transport are replaced.
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ImputationModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChartSurface', () => ({ default: () => null }))

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) await dispose()
  vi.restoreAllMocks()
})

it('keeps a pending Binning submission single-flight after Overview deactivation and reopening', async () => {
  const base = store.getState()
  const book = { datasetId: 'a', schemaRevision: 1, multiResponseGroups: [], columns: [{
    columnId: 'x', name: 'x', label: 'x', role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null,
  }] }
  const initial = { ...base,
    selection: { ...base.selection, datasetId: 'a', revision: 1, dataRevision: 1,
      allRowIds: ['a-r1', 'a-r2'], activeRowIds: ['a-r2'], activeRowIdSet: new Set(['a-r2']), selectedRowIds: ['a-r2'] },
    codebook: { ...base.codebook, ...book, isLoading: false },
  } as RootState
  const local = configureStore({ reducer: (state = initial, action: any) => ({ ...state,
    selection: selectionReducer(state.selection, action), codebook: codebookSlice.reducer(state.codebook, action),
  }), middleware: defaults => defaults({ serializableCheck: false }) })
  const requests: { path: string; body: unknown; promise: Promise<any>; reject: (error: Error) => void }[] = []
  vi.spyOn(notification, 'success').mockImplementation(() => {})
  vi.spyOn(notification, 'error').mockImplementation(() => {})
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/datasets/a/codebook') return book as any
    if (path !== '/datasets/a') throw new Error(`Unexpected GET ${path}`)
    return { datasetId: 'a', name: 'Dataset a', format: 'csv', rowCount: 2, columnCount: 1,
      fingerprint: 'a-1', dataRevision: 1, schemaRevision: 1, rowIdentity: 'stable', createdAt: '2026-10-12T00:00:00Z',
      schema: [{ columnId: 'x', name: 'x', physicalType: 'Float64', semanticType: 'numeric',
        role: 'numeric_axis', missingCount: 0, uniqueCount: 2, min: 0, max: 1 }],
    } as any
  })
  vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    if (path === '/summaries') return { rowCount: 2, columns: { x: { count: 2, missing: 0,
      uniqueCount: 2, min: 0, max: 1, mean: 0.5 } } } as any
    if (path === '/datasets/a/transform/preview') return { column: 'x', method: 'equal_width', edges: [0, 1],
      bins: [{ binIndex: 0, label: 'BIN', min: 0, max: 1, count: 2, ratio: 1 }],
      histogram: { counts: [2], edges: [0, 1] }, min: 0, max: 1, count: 2 } as any
    if (path !== '/datasets/a/transform') throw new Error(`Unexpected POST ${path}`)
    let reject!: (error: Error) => void
    const promise = new Promise<any>((_resolve, fail) => { reject = fail })
    requests.push({ path, body, promise, reject })
    return promise
  })
  disposals.push(async () => {
    await act(async () => {
      const settled = Promise.allSettled(requests.map(request => request.promise))
      requests.forEach(request => request.reject(new Error('test cleanup')))
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
    fireEvent.click(await view.findByTestId('btn-bin-x'))
    const dialog = await view.findByRole('dialog')
    return within(dialog).getByRole('button', { name: /ビン列を生成/ })
  }
  const apply = await open()
  await waitFor(() => expect(apply).toBeEnabled())
  fireEvent.click(apply)
  expect(requests).toHaveLength(1)
  expect(apply).toBeDisabled()
  view.rerender(ui(false))
  await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
  view.rerender(ui(true))
  expect(view.queryByRole('dialog')).toBeNull()
  const reopened = await open()
  // Ensure the reopened preview finished, without requiring Apply to be enabled:
  // a correct shared lock should keep it disabled even with a valid preview.
  await within(view.getByRole('dialog')).findByText('BIN')
  fireEvent.click(reopened)
  // Independent transport oracle: neither original request has been settled.
  // Log exact admitted payloads so failure cannot be mistaken for a UI timeout.
  console.info('BINNING_PENDING_ADMISSIONS', JSON.stringify(requests.map(({ path, body }) => ({ path, body }))))
  expect(requests, 'Navigation/reopen must not admit a second transform while the first is pending').toHaveLength(1)
})
