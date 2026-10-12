import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, notification } from 'antd'
import { Provider, useSelector } from 'react-redux'
import { selectionReducer, store, type RootState } from '../src/app/store'
import { api, type CodebookColumn } from '../src/api/client'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import { onDatasetMutationCommitted } from '../src/features/dataset/datasetMutationEvents'
import OverviewPage from '../src/features/dataset/OverviewPage'
import BinningModal from '../src/features/dataset/BinningModal'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Retain real Overview, ColumnTable actions, BinningModal, ActiveModal and the
// selection/codebook reducers. Only unrelated dialogs/history and transport differ.
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChartSurface', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ImputationModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))

const binPreview = { column: 'x', method: 'equal_width', edges: [0, 1], bins: [{ binIndex: 0, label: 'BIN', min: 0, max: 1, count: 2, ratio: 1 }], histogram: { counts: [2], edges: [0, 1] }, min: 0, max: 1, count: 2 }

const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) await dispose()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: (value: { createdColumns: string[] }) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<{ createdColumns: string[] }>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject, settled: false }
}
function column(name: string): CodebookColumn {
  return { columnId: name, name, label: name, role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null }
}
function KeyedOverview() {
  const datasetId = useSelector((state: RootState) => state.selection.datasetId)
  // The real KeepAliveOutlet also remounts its views when the dataset ID changes.
  return <OverviewPage key={datasetId} />
}
function mount() {
  const servers: Record<string, { revision: number; names: string[] }> = {
    a: { revision: 1, names: ['x'] }, b: { revision: 1, names: ['x'] },
  }
  const book = (id: string) => ({ datasetId: id, schemaRevision: servers[id].revision,
    columns: servers[id].names.map(column), multiResponseGroups: [] })
  const stateFor = (id: string, revision = 1): RootState => {
    const base = store.getState()
    return { ...base, selection: { ...base.selection, datasetId: id, revision,
      dataRevision: servers[id].revision, allRowIds: [`${id}-r1`, `${id}-r2`],
      activeRowIds: [`${id}-r2`], activeRowIdSet: new Set([`${id}-r2`]), selectedRowIds: [`${id}-r2`] },
      codebook: { ...base.codebook, ...book(id), isLoading: false } }
  }
  const local = configureStore({ reducer: (state = stateFor('a'), action: any) => {
    if (action.type === 'test/switch-dataset') return stateFor(action.payload, state.selection.revision + 1)
    return { ...state, selection: selectionReducer(state.selection, action), codebook: codebookSlice.reducer(state.codebook, action) }
  }, middleware: defaults => defaults({ serializableCheck: false }) })
  const requests: (ReturnType<typeof deferred> & { datasetId: string; prefix: string })[] = []
  const commits = vi.fn()
  const unsubscribe = onDatasetMutationCommitted(commits)
  vi.spyOn(notification, 'success').mockImplementation(() => {})
  vi.spyOn(notification, 'error').mockImplementation(() => {})
  vi.spyOn(api, 'get').mockImplementation(async path => {
    const id = path.split('/')[2], server = servers[id]
    if (path === `/datasets/${id}/codebook`) return book(id) as any
    if (path !== `/datasets/${id}` || !server) throw new Error(`Unexpected GET ${path}`)
    return { datasetId: id, name: `Dataset ${id}`, format: 'csv', rowCount: 2,
      columnCount: server.names.length, fingerprint: `${id}-${server.revision}`,
      dataRevision: server.revision, schemaRevision: server.revision,
      rowIdentity: 'stable', createdAt: '2026-10-12T00:00:00Z',
      schema: server.names.map(name => ({ columnId: name, name,
        physicalType: 'Float64', semanticType: 'numeric',
        role: 'numeric_axis', missingCount: 0, uniqueCount: 2,
        min: 0, max: 1,
      })),
    } as any
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    if (path === '/summaries') {
      const server = servers[body.datasetId]
      expect(body).toEqual({ datasetId: body.datasetId, expectedDataRevision: server.revision, expectedSchemaRevision: server.revision })
      return { rowCount: 2, columns: Object.fromEntries(server.names.map(name => [name,
        { count: 2, missing: 0, min: 0, max: 1, mean: 0.5 },
      ])) } as any
    }
    if (path.endsWith('/transform/preview')) return binPreview as any
    const match = path.match(/^\/datasets\/([ab])\/transform$/)
    if (!match) throw new Error(`Unexpected POST ${path}`)
    expect(body).toEqual({ type: 'binning', source_column: 'x', options: { method: 'equal_width', num_bins: 4, custom_cuts: undefined, output_column_name: 'x_bin4', labels_format: 'range' } })
    const request = { ...deferred(), datasetId: match[1], prefix: 'x_bin4' }
    requests.push(request)
    return request.promise
  })
  const ui = (active: boolean) => <ConfigProvider theme={{ token: { motion: false } }}>
    <Provider store={local}><AnalysisViewActivityContext.Provider value={active}>
      <KeyedOverview />
    </AnalysisViewActivityContext.Provider></Provider>
  </ConfigProvider>
  const view = render(ui(true))
  disposals.push(async () => {
    unsubscribe()
    await act(async () => {
      for (const request of requests) if (!request.settled) request.reject(new Error('test cleanup'))
      await Promise.allSettled(requests.map(request => request.promise))
    })
  })
  const open = async () => {
    fireEvent.click(await view.findByTestId('btn-bin-x'))
    return view.findByRole('button', { name: /ビン列を生成/ })
  }
  const reopen = async () => {
    view.rerender(ui(false))
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
    view.rerender(ui(true))
    expect(view.queryByRole('dialog')).toBeNull()
    return open()
  }
  const complete = async (index: number) => {
    const request = requests[index], server = servers[request.datasetId]
    const suffix = server.revision === 1 ? '' : `_${server.revision - 1}`
    const createdColumns = [`${request.prefix}${suffix}`]
    server.names.push(...createdColumns)
    server.revision++
    request.settled = true
    await act(async () => { request.resolve({ createdColumns }); await request.promise })
  }
  const fail = async (index: number) => {
    const request = requests[index]
    request.settled = true
    await act(async () => { request.reject(new Error('TRANSFORM_FAILED')); await Promise.allSettled([request.promise]) })
  }
  const switchTo = async (id: string) => {
    act(() => { local.dispatch({ type: 'test/switch-dataset', payload: id }) })
    await view.findByText(`Dataset ${id}`)
  }
  return { view, local, post, requests, commits, open, reopen, complete, fail, switchTo }
}

it('keeps a pending Binning submission single-flight after deactivation, then allows a deliberate repeat after success', async () => {
  const ui = mount(), before = ui.local.getState().selection
  const apply = await ui.open()
  await waitFor(() => expect(apply).toBeEnabled())
  fireEvent.click(apply); fireEvent.click(apply)
  expect(ui.requests).toHaveLength(1)
  expect(apply).toBeDisabled()
  const reopened = await ui.reopen()
  expect(reopened).toBeDisabled()
  await waitFor(() => expect(ui.view.getByText('データを更新しています。処理中は編集・キャンセルできません。')).toBeVisible())
  const dialog = () => within(ui.view.getByRole('dialog'))
  expect(dialog().getByTestId('binning-output-name')).toBeDisabled()
  expect(dialog().getByRole('button', { name: 'キャンセル' })).toBeDisabled()
  fireEvent.click(reopened)
  expect(ui.requests).toHaveLength(1)

  await ui.complete(0)
  await waitFor(() => expect(ui.local.getState().codebook.schemaRevision).toBe(2))
  await waitFor(() => {
    expect(ui.view.getByRole('dialog')).toBeVisible()
    expect(dialog().getByRole('button', { name: /ビン列を生成/ })).toBeEnabled()
  })
  expect(ui.commits.mock.calls).toEqual([['a']])
  expect(ui.local.getState().codebook.columns.map(col => col.name)).toEqual(['x', 'x_bin4'])
  expect(ui.local.getState().selection).toEqual({ ...before, dataRevision: 2 })
  fireEvent.click(dialog().getByRole('button', { name: /ビン列を生成/ }))
  expect(ui.requests).toHaveLength(2)
})

it('releases the pending lock after failure and accepts one explicit retry from the reopened dialog', async () => {
  const ui = mount()
  const firstApply = await ui.open()
  await waitFor(() => expect(firstApply).toBeEnabled())
  fireEvent.click(firstApply)
  const reopened = await ui.reopen()
  expect(reopened).toBeDisabled()
  await ui.fail(0)
  await waitFor(() => expect(reopened).toBeEnabled())
  expect(ui.view.getByTestId('binning-output-name')).toBeEnabled()
  expect(ui.commits).not.toHaveBeenCalled()
  expect(ui.local.getState().selection.dataRevision).toBe(1)
  expect(notification.error).toHaveBeenCalledOnce()
  fireEvent.click(reopened); fireEvent.click(reopened)
  expect(ui.requests).toHaveLength(2)
  await ui.complete(1)
  await waitFor(() => expect(ui.local.getState().codebook.schemaRevision).toBe(2))
  expect(ui.commits.mock.calls).toEqual([['a']])
})

it('retains independent A and B pending ownership through keyed modal A → B → A remounts', async () => {
  // The Overview cases above exercise global refresh. This ownership case keeps
  // the real modal/activity lifecycle but avoids rendering Overview's table and
  // metadata again for each dataset installation.
  const base = store.getState()
  const stateFor = (datasetId: string): RootState => ({ ...base,
    selection: { ...base.selection, datasetId },
    codebook: { ...base.codebook, datasetId, columns: [column('x')] },
  })
  const local = configureStore({ reducer: (state = stateFor('a'), action: any) =>
    action.type === 'test/switch-dataset' ? stateFor(action.payload) : state,
    middleware: defaults => defaults({ serializableCheck: false }) })
  const pending = { a: deferred(), b: deferred() }
  const success = vi.fn(), close = vi.fn()
  vi.spyOn(notification, 'success').mockImplementation(() => {})
  vi.spyOn(notification, 'error').mockImplementation(() => {})
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body) => {
    if (path.endsWith('/transform/preview')) return binPreview as any
    const id = path.match(/^\/datasets\/([ab])\/transform$/)?.[1] as 'a' | 'b' | undefined
    if (!id) throw new Error(`Unexpected POST ${path}`)
    expect(body).toEqual({ type: 'binning', source_column: 'x',
      options: { method: 'equal_width', num_bins: 4, custom_cuts: undefined, output_column_name: 'x_bin4', labels_format: 'range' } })
    return pending[id].promise as any
  })
  function KeyedBinning() {
    const datasetId = useSelector((state: RootState) => state.selection.datasetId)!
    return <BinningModal key={datasetId} open datasetId={datasetId} columnName="x" onSuccess={success} onClose={close} />
  }
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}>
    <Provider store={local}><AnalysisViewActivityContext.Provider value={true}>
      <KeyedBinning />
    </AnalysisViewActivityContext.Provider></Provider>
  </ConfigProvider>)
  disposals.push(async () => {
    await act(async () => {
      const settled = Promise.allSettled(Object.values(pending).map(request => request.promise))
      for (const request of Object.values(pending)) if (!request.settled) request.reject(new Error('test cleanup'))
      await settled
    })
  })
  const apply = () => within(view.getByRole('dialog')).getByRole('button', { name: /ビン列を生成/ })
  const switchTo = (datasetId: string) => {
    act(() => { local.dispatch({ type: 'test/switch-dataset', payload: datasetId }) })
  }
  const complete = async (datasetId: 'a' | 'b') => {
    const request = pending[datasetId]
    request.settled = true
    await act(async () => { request.resolve({ createdColumns: ['x_bin4'] }); await request.promise })
  }

  await waitFor(() => expect(apply()).toBeEnabled())
  fireEvent.click(apply())
  switchTo('b')
  const bApply = apply()
  await waitFor(() => expect(bApply).toBeEnabled())
  fireEvent.click(bApply)
  expect(post.mock.calls.filter(([path]) => path.endsWith('/transform')).map(([path]) => path)).toEqual(['/datasets/a/transform', '/datasets/b/transform'])
  switchTo('a')
  const aReopened = apply()
  expect(aReopened).toBeDisabled()
  fireEvent.click(aReopened)
  expect(post.mock.calls.filter(([path]) => path.endsWith('/transform'))).toHaveLength(2)
  await complete('a')
  await waitFor(() => expect(apply()).toBeEnabled())
  await waitFor(() => expect(view.getByRole('dialog')).toBeVisible())
  expect(success.mock.calls).toEqual([['a']])
  expect(close).not.toHaveBeenCalled()
  switchTo('b')
  const bReopened = apply()
  expect(bReopened).toBeDisabled()
  fireEvent.click(bReopened)
  expect(post.mock.calls.filter(([path]) => path.endsWith('/transform'))).toHaveLength(2)
  await complete('b')
  await waitFor(() => expect(apply()).toBeEnabled())
  expect(success.mock.calls).toEqual([['a'], ['b']])
  expect(close).not.toHaveBeenCalled()
})


it('does not refresh or alter B when A completes after a dataset switch', async () => {
  const ui = mount()
  const apply = await ui.open()
  await waitFor(() => expect(apply).toBeEnabled())
  fireEvent.click(apply)
  await ui.switchTo('b')
  const bApply = await ui.open()
  await waitFor(() => expect(bApply).toBeEnabled())
  const before = ui.local.getState()
  vi.mocked(api.get).mockClear()
  ui.post.mockClear()
  await ui.complete(0)
  expect(ui.commits.mock.calls).toEqual([['a']])
  expect(api.get).not.toHaveBeenCalled()
  expect(ui.post).not.toHaveBeenCalled()
  expect(ui.local.getState()).toBe(before)
  await waitFor(() => expect(ui.view.getByRole('dialog')).toBeVisible())
  expect(bApply).toBeEnabled()
})
