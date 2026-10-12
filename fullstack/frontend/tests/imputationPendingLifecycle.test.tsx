import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider, message } from 'antd'
import { Provider, useSelector } from 'react-redux'
import { selectionReducer, store, type RootState } from '../src/app/store'
import { api, type CodebookColumn } from '../src/api/client'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import { onDatasetMutationCommitted } from '../src/features/dataset/datasetMutationEvents'
import OverviewPage from '../src/features/dataset/OverviewPage'
import ImputationModal from '../src/features/dataset/ImputationModal'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'

// Preserve the real Overview, table, Imputation/ActiveModal and reducers.
vi.mock('../src/features/dataset/BinningModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/OneHotModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/AddVariableModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/ProvenanceHistoryPanel', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChartSurface', () => ({ default: () => null }))

const disposals: (() => Promise<void>)[] = []
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
  for (const kind of ['success', 'warning', 'error'] as const) {
    vi.spyOn(message, kind).mockImplementation(() => (() => {}) as any)
  }
})
afterEach(async () => {
  cleanup()
  for (const dispose of disposals.splice(0)) await dispose()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: (value: unknown) => void, reject!: (reason: Error) => void
  const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject, settled: false }
}
function column(name: string): CodebookColumn {
  return { columnId: name, name, label: name, role: 'question', scaleType: 'ratio',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
    isReversed: false, multiResponseGroup: null }
}
const columns = ['x', 'y'].map(column)
function localStore() {
  const stateFor = (datasetId: string, revision = 1): RootState => {
    const base = store.getState()
    return { ...base, selection: { ...base.selection, datasetId, revision, dataRevision: 1,
      allRowIds: [`${datasetId}-r1`, `${datasetId}-r2`], activeRowIds: [`${datasetId}-r2`],
      activeRowIdSet: new Set([`${datasetId}-r2`]), selectedRowIds: [`${datasetId}-r2`] },
      codebook: { ...base.codebook, datasetId, schemaRevision: 1, columns,
        multiResponseGroups: [], isLoading: false } }
  }
  return configureStore({ reducer: (state = stateFor('a'), action: any) => {
    if (action.type === 'test/switch-dataset') return stateFor(action.payload, state.selection.revision + 1)
    return { ...state, selection: selectionReducer(state.selection, action),
      codebook: codebookSlice.reducer(state.codebook, action) }
  }, middleware: defaults => defaults({ serializableCheck: false }) })
}
function KeyedOverview() {
  const datasetId = useSelector((state: RootState) => state.selection.datasetId)
  return <OverviewPage key={datasetId} />
}
function chooseMean(dialog: HTMLElement) {
  const radio = within(dialog).getByRole('radio', { name: 'Mean (平均値)', exact: true })
  fireEvent.click(radio)
  expect(radio).toBeChecked()
}
function mountOverview() {
  const servers: Record<string, { revision: number; missing: Record<string, number> }> = {
    a: { revision: 1, missing: { x: 1, y: 1 } }, b: { revision: 1, missing: { x: 1, y: 1 } },
  }
  const local = localStore(), commits = vi.fn()
  const unsubscribe = onDatasetMutationCommitted(commits)
  const requests: (ReturnType<typeof deferred> & { datasetId: string; body: any })[] = []
  const get = vi.spyOn(api, 'get').mockImplementation(async path => {
    const id = path.split('/')[2], server = servers[id]
    if (!server) throw new Error(`Unexpected GET ${path}`)
    if (path === `/datasets/${id}/codebook`) return { datasetId: id, schemaRevision: 1,
      columns, multiResponseGroups: [] } as any
    if (path !== `/datasets/${id}`) throw new Error(`Unexpected GET ${path}`)
    return { datasetId: id, name: `Dataset ${id}`, format: 'csv', rowCount: 2, columnCount: 2,
      fingerprint: `${id}-${server.revision}`, dataRevision: server.revision, schemaRevision: 1,
      rowIdentity: 'stable', createdAt: '2026-10-12T00:00:00Z', schema: columns.map(({ name }) => ({
        columnId: name, name, physicalType: 'Float64', semanticType: 'numeric', role: 'numeric_axis',
        missingCount: server.missing[name], uniqueCount: 1, min: 4, max: 4,
      })) } as any
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    if (path === '/summaries') {
      const server = servers[body.datasetId]
      expect(body).toEqual({ datasetId: body.datasetId, expectedDataRevision: server.revision, expectedSchemaRevision: 1 })
      return { rowCount: 2, columns: Object.fromEntries(columns.map(({ name }) => [name, {
        count: 2 - server.missing[name], missing: server.missing[name], uniqueCount: 1, min: 4, max: 4, mean: 4,
      }])) } as any
    }
    const id = path.match(/^\/datasets\/([ab])\/impute$/)?.[1]
    if (!id) throw new Error(`Unexpected POST ${path}; these controls use direct Apply`)
    expect(body).toEqual({ columns: [expect.stringMatching(/^[xy]$/)], predictorColumns: undefined,
      strategy: 'mean', options: { seed: 42 }, inPlace: true, planHash: undefined })
    const request = { ...deferred(), datasetId: id, body }
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
      const settled = Promise.allSettled(requests.map(request => request.promise))
      for (const request of requests) if (!request.settled) request.reject(new Error('test cleanup'))
      await settled
    })
  })
  const open = async (name = 'x', choose = true) => {
    fireEvent.click(await view.findByTestId(`btn-impute-${name}`))
    const dialog = await view.findByRole('dialog')
    if (choose) chooseMean(dialog)
    return within(dialog).getByTestId('btn-execute-imputation')
  }
  const reopen = async (name = 'x') => {
    view.rerender(ui(false))
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull())
    view.rerender(ui(true))
    expect(view.queryByRole('dialog')).toBeNull()
    return open(name, false)
  }
  const complete = async (index: number) => {
    const request = requests[index], server = servers[request.datasetId]
    request.body.columns.forEach((name: string) => { server.missing[name] = 0 })
    server.revision++
    request.settled = true
    await act(async () => { request.resolve({}); await request.promise })
  }
  const fail = async (index: number) => {
    const request = requests[index]
    request.settled = true
    await act(async () => { request.reject(new Error('IMPUTATION_FAILED')); await Promise.allSettled([request.promise]) })
  }
  const switchTo = async (id: string) => {
    act(() => { local.dispatch({ type: 'test/switch-dataset', payload: id }) })
    await view.findByText(`Dataset ${id}`)
  }
  return { view, local, get, post, requests, commits, open, reopen, complete, fail, switchTo }
}

it('blocks changed targets in remounted A, then completes a deliberate second Apply after success', async () => {
  const ui = mountOverview(), before = ui.local.getState().selection
  fireEvent.click(await ui.open('x'))
  expect(ui.requests).toHaveLength(1)
  const reopened = await ui.reopen('y')
  const dialog = () => within(ui.view.getByRole('dialog'))
  const apply = () => dialog().getByTestId('btn-execute-imputation')
  expect(dialog().getByRole('checkbox', { name: /^y 欠損/ })).toBeChecked()
  expect(dialog().getByRole('checkbox', { name: /^x 欠損/ })).not.toBeChecked()
  expect(reopened).toBeDisabled()
  expect(dialog().getByRole('button', { name: 'キャンセル' })).toBeDisabled()
  expect(dialog().getByRole('button', { name: 'プレビュー更新' })).toBeDisabled()
  for (const input of [...dialog().getAllByRole('radio'), ...dialog().getAllByRole('checkbox'),
    ...dialog().getAllByRole('textbox'), ...dialog().getAllByRole('spinbutton')]) expect(input).toBeDisabled()
  fireEvent.click(reopened)
  expect(ui.requests).toHaveLength(1)
  await waitFor(() => expect(ui.view.getByText('データを更新しています。処理中は編集・キャンセルできません。')).toBeVisible())
  await ui.complete(0)
  await waitFor(() => expect(ui.local.getState().selection.dataRevision).toBe(2))
  await waitFor(() => expect(apply()).toBeEnabled())
  await waitFor(() => expect(ui.view.getByRole('dialog')).toBeVisible())
  expect(ui.commits.mock.calls).toEqual([['a']])
  expect(ui.local.getState().selection).toEqual({ ...before, dataRevision: 2 })
  chooseMean(ui.view.getByRole('dialog'))
  fireEvent.click(apply()); fireEvent.click(apply())
  expect(ui.requests.map(request => request.body.columns)).toEqual([['x'], ['y']])
  expect(ui.requests[1].settled).toBe(false)
  await ui.complete(1)
  await waitFor(() => expect(ui.local.getState().selection.dataRevision).toBe(3))
  await waitFor(() => expect(ui.view.queryByRole('dialog')).toBeNull())
  expect(ui.commits.mock.calls).toEqual([['a'], ['a']])
  expect(ui.requests.every(request => request.settled)).toBe(true)
  expect(ui.view.queryByTestId('btn-impute-x')).toBeNull()
  expect(ui.view.queryByTestId('btn-impute-y')).toBeNull()
})

it('releases a failed Apply and completes one explicit retry from the remounted dialog', async () => {
  const ui = mountOverview()
  fireEvent.click(await ui.open())
  const reopened = await ui.reopen()
  expect(reopened).toBeDisabled()
  await ui.fail(0)
  await waitFor(() => expect(reopened).toBeEnabled())
  expect(ui.commits).not.toHaveBeenCalled()
  expect(ui.local.getState().selection.dataRevision).toBe(1)
  expect(message.error).toHaveBeenCalledOnce()
  chooseMean(ui.view.getByRole('dialog'))
  fireEvent.click(reopened); fireEvent.click(reopened)
  expect(ui.requests).toHaveLength(2)
  await ui.complete(1)
  await waitFor(() => expect(ui.local.getState().selection.dataRevision).toBe(2))
  await waitFor(() => expect(ui.view.queryByRole('dialog')).toBeNull())
  expect(ui.commits.mock.calls).toEqual([['a']])
})

it('reports captured A completion without refreshing or closing the current B Overview dialog', async () => {
  const ui = mountOverview()
  fireEvent.click(await ui.open())
  await ui.switchTo('b')
  const bApply = await ui.open()
  expect(bApply).toBeEnabled()
  const bDialog = ui.view.getByRole('dialog')
  await waitFor(() => expect(bDialog).toBeVisible())
  const bState = ui.local.getState()
  const bReads = () => ui.get.mock.calls.filter(([path]) => path.startsWith('/datasets/b')).length
  const bSummaries = () => ui.post.mock.calls.filter(([path, body]) => path === '/summaries' && (body as any).datasetId === 'b').length
  const readsBefore = bReads(), summariesBefore = bSummaries()
  await ui.complete(0)
  expect(ui.commits.mock.calls).toEqual([['a']])
  expect(ui.local.getState()).toBe(bState)
  expect(bReads()).toBe(readsBefore)
  expect(bSummaries()).toBe(summariesBefore)
  expect(ui.view.getByRole('dialog')).toBe(bDialog)
  expect(bDialog).toBeVisible()
  expect(bApply).toBeEnabled()
  expect(ui.requests).toHaveLength(1)
})

it('keeps A and B independent through actual keyed A → B → A modal remounts', async () => {
  const local = localStore(), success = vi.fn(), close = vi.fn()
  const pending = { a: deferred(), b: deferred() }
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => {
    const id = path.match(/^\/datasets\/([ab])\/impute$/)?.[1] as 'a' | 'b' | undefined
    if (!id) throw new Error(`Unexpected POST ${path}`)
    expect(body.strategy).toBe('mean')
    expect(body.columns).toEqual(['x'])
    return pending[id].promise
  })
  function KeyedImputation() {
    const datasetId = useSelector((state: RootState) => state.selection.datasetId)!
    return <ImputationModal key={datasetId} open datasetId={datasetId} targetColumn="x"
      columnsWithMissing={[{ name: 'x', missing: 1, total: 2 }]}
      onSuccess={success} onClose={close} />
  }
  const view = render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}>
    <AnalysisViewActivityContext.Provider value={true}><KeyedImputation /></AnalysisViewActivityContext.Provider>
  </Provider></ConfigProvider>)
  disposals.push(async () => {
    await act(async () => {
      const settled = Promise.allSettled(Object.values(pending).map(request => request.promise))
      for (const request of Object.values(pending)) if (!request.settled) request.reject(new Error('test cleanup'))
      await settled
    })
  })
  const apply = () => within(view.getByRole('dialog')).getByTestId('btn-execute-imputation')
  const switchTo = (datasetId: string) => act(() => { local.dispatch({ type: 'test/switch-dataset', payload: datasetId }) })
  const complete = async (id: 'a' | 'b') => {
    pending[id].settled = true
    await act(async () => { pending[id].resolve({}); await pending[id].promise })
  }
  chooseMean(view.getByRole('dialog')); fireEvent.click(apply())
  const firstA = apply()
  switchTo('b')
  expect(firstA).not.toBeInTheDocument()
  expect(apply()).toBeEnabled()
  chooseMean(view.getByRole('dialog')); fireEvent.click(apply())
  expect(post.mock.calls.map(([path]) => path)).toEqual(['/datasets/a/impute', '/datasets/b/impute'])
  switchTo('a')
  expect(apply()).not.toBe(firstA)
  expect(apply()).toBeDisabled()
  fireEvent.click(apply())
  expect(post).toHaveBeenCalledTimes(2)
  await complete('a')
  expect(apply()).toBeEnabled()
  expect(success.mock.calls).toEqual([['a']])
  expect(close).not.toHaveBeenCalled()
  switchTo('b')
  expect(apply()).toBeDisabled()
  fireEvent.click(apply())
  expect(post).toHaveBeenCalledTimes(2)
  await complete('b')
  expect(apply()).toBeEnabled()
  expect(success.mock.calls).toEqual([['a'], ['b']])
  expect(close).not.toHaveBeenCalled()
})
