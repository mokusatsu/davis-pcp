import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { ConfigProvider } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import LogisticRegressionPage from '../src/features/models/LogisticRegressionPage'
import { useLogisticTargetEligibility, type LogisticTargetRequest } from '../src/features/models/useLogisticTargetEligibility'

vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456', selectionColor: '#abcdef' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children }: any) => <div>{children}</div>, useGraphPopupContainer: () => undefined }))
vi.mock('../src/features/models/ModelScatter', () => ({ default: () => null }))
vi.mock('../src/features/charts/EChart', () => ({ default: () => null }))
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => getComputedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const request: LogisticTargetRequest = { datasetId: 'iris', targetColumns: ['species', 'binary', 'x'], featureColumns: [],
  activeRowIds: ['r1', 'r2', 'r3'], expectedDataRevision: 1, expectedSchemaRevision: 2 }
const response = (species = 3, binary = 2) => ({ targets: [
  { name: 'species', classCount: species, eligible: species === 2, reason: species === 2 ? null : `${species}クラス（2クラスが必要）` },
  { name: 'binary', classCount: binary, eligible: binary === 2, reason: binary === 2 ? null : `${binary}クラス（2クラスが必要）` },
  { name: 'x', classCount: 3, eligible: false, reason: '3クラス（2クラスが必要）' },
] })
function deferred() {
  let resolve!: (value: any) => void
  let reject!: (reason: any) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
it('fails closed and rejects obsolete scope, dataset, revision, column and feature responses', async () => {
  const pending: ReturnType<typeof deferred>[] = []
  const post = vi.spyOn(api, 'post').mockImplementation(() => { const call = deferred(); pending.push(call); return call.promise })
  const { result, rerender, unmount } = renderHook(useLogisticTargetEligibility, { initialProps: request })
  expect(result.current).toMatchObject({ loading: true, ready: false, targets: [] })
  await act(async () => { pending[0].resolve(response()) })
  expect(result.current.ready).toBe(true)
  let next = request
  for (const patch of [{ activeRowIds: ['r1', 'r2'] }, { datasetId: 'other' }, { expectedSchemaRevision: 3 }, { featureColumns: ['x'] }, { targetColumns: ['binary'] }, { expectedDataRevision: 2 }]) {
    next = { ...next, ...patch }
    rerender(next)
    expect(result.current).toMatchObject({ loading: true, ready: false, targets: [] })
  }
  await act(async () => { pending[1].resolve(response(2)) })
  expect(result.current.ready).toBe(false)
  await act(async () => { pending.at(-1)!.resolve(response(1, 1)) })
  expect(result.current.ready).toBe(true)
  expect(result.current.targets[0].classCount).toBe(1)
  await act(async () => { pending[2].reject(new Error('obsolete failure')) })
  expect(result.current.error).toBeNull()
  expect(post).toHaveBeenLastCalledWith('/models/logistic/targets', next)
  act(() => { result.current.retry() })
  expect(result.current.ready).toBe(false)
  unmount()
  await act(async () => { pending.at(-1)!.resolve(response()) })
})
it('exposes retryable failures without reusing eligible results during retry', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce({ message: '読み込み失敗' }).mockResolvedValueOnce(response())
  const { result } = renderHook(useLogisticTargetEligibility, { initialProps: request })
  await waitFor(() => expect(result.current.error).toBe('読み込み失敗'))
  expect(result.current.ready).toBe(false)
  act(() => result.current.retry())
  expect(result.current).toMatchObject({ ready: false, loading: true })
  await waitFor(() => expect(result.current.ready).toBe(true))
  expect(post).toHaveBeenCalledTimes(2)
})
it('does not request an empty candidate list or absent dataset', () => {
  const post = vi.spyOn(api, 'post')
  const { rerender } = renderHook(useLogisticTargetEligibility, { initialProps: { ...request, targetColumns: [] } })
  rerender({ ...request, datasetId: null, targetColumns: [] })
  expect(post).not.toHaveBeenCalled()
})
function mount() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'iris', dataRevision: 1, allRowIds: request.activeRowIds, activeRowIds: request.activeRowIds },
    globalObservations: { ...base.globalObservations, scopeMode: 'active' },
    globalVariables: { ...base.globalVariables, activeEntities: request.targetColumns.map(columnId => ({ kind: 'column', columnId })) },
    codebook: { ...base.codebook, datasetId: 'iris', schemaRevision: 2, isLoading: false, columns: request.targetColumns.map(name => ({
      name, columnId: name, label: name, role: 'question', scaleType: name === 'x' ? 'ratio' : 'nominal', multiResponseGroup: null,
    })) },
  }
  const local = configureStore({ reducer: (s = state, action: any) => action.type === 'test/scope'
    ? { ...s, selection: { ...s.selection, activeRowIds: action.payload } } : action.type === 'test/dataset'
      ? { ...s, selection: { ...s.selection, datasetId: 'other' }, codebook: { ...s.codebook, datasetId: 'other' } }
      : action.type === 'test/columns' ? { ...s, globalVariables: { ...s.globalVariables, activeEntities: [{ kind: 'column', columnId: 'x' }] } } : s,
    middleware: get => get({ serializableCheck: false }) })
  render(<ConfigProvider theme={{ token: { motion: false } }}><Provider store={local}><LogisticRegressionPage /></Provider></ConfigProvider>)
  return local
}
async function openPicker(field: '目的' | '説明') {
  fireEvent.click(screen.getByRole('button', { name: `ロジスティック回帰の${field}変数を選択` }))
  return screen.findByRole('dialog')
}
async function choose(field: '目的' | '説明', name: RegExp) {
  const dialog = await openPicker(field)
  fireEvent.click(within(dialog).getByRole(field === '目的' ? 'radio' : 'checkbox', { name }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}
it('disables Iris three-class targets with reasons, accepts a two-class scope, and clears invalidated targets', async () => {
  const pending: ReturnType<typeof deferred>[] = []
  const post = vi.spyOn(api, 'post').mockImplementation(() => { const call = deferred(); pending.push(call); return call.promise })
  const local = mount()
  const run = screen.getByTestId('run-logistic-btn')
  let dialog = await openPicker('目的')
  expect(within(dialog).getByRole('radio', { name: /species.*確認中/ })).toBeDisabled()
  await act(async () => pending[0].resolve(response()))
  expect(within(dialog).getByRole('radio', { name: /species.*3クラス/ })).toBeDisabled()
  expect(within(dialog).getByRole('radio', { name: /binary.*2クラス/ })).toBeEnabled()
  fireEvent.click(within(dialog).getByRole('radio', { name: /binary.*2クラス/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await choose('説明', /^x$/)
  expect(run).toBeDisabled()
  await act(async () => pending.at(-1)!.resolve(response()))
  expect(run).toBeEnabled()
  act(() => local.dispatch({ type: 'test/scope', payload: ['r1', 'r2'] }))
  expect(run).toBeDisabled()
  fireEvent.click(run)
  expect(post.mock.calls.every(([path]) => path === '/models/logistic/targets')).toBe(true)
  await act(async () => pending.at(-1)!.resolve(response(2, 1)))
  expect(run).toBeDisabled()
  expect(screen.getByTestId('logistic-target-select')).not.toHaveTextContent('binary')
  dialog = await openPicker('目的')
  expect(within(dialog).getByRole('radio', { name: /binary.*1クラス/ })).toBeDisabled()
  expect(within(dialog).getByRole('radio', { name: /species.*2クラス/ })).toBeEnabled()
  fireEvent.click(within(dialog).getByRole('radio', { name: /species.*2クラス/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(run).toBeEnabled()
  act(() => local.dispatch({ type: 'test/dataset' }))
  expect(run).toBeDisabled()
  await act(async () => pending.at(-1)!.resolve(response(2)))
  expect(run).toBeDisabled()
  await choose('目的', /species.*2クラス/)
  act(() => local.dispatch({ type: 'test/columns' }))
  expect(screen.getByTestId('logistic-target-select')).not.toHaveTextContent('species')
  expect(run).toBeDisabled()
})

it('rejects stale modal confirmation and exposes an explicit retry after a failed check', async () => {
  const pending: ReturnType<typeof deferred>[] = []
  vi.spyOn(api, 'post').mockImplementation(() => { const call = deferred(); pending.push(call); return call.promise })
  const local = mount()
  await act(async () => pending[0].resolve(response()))
  const dialog = await openPicker('目的')
  fireEvent.click(within(dialog).getByRole('radio', { name: /binary.*2クラス/ }))
  act(() => local.dispatch({ type: 'test/scope', payload: ['r1'] }))
  await act(async () => pending.at(-1)!.resolve(response(1, 1)))
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByTestId('logistic-target-select')).not.toHaveTextContent('binary')
  expect(screen.getByTestId('run-logistic-btn')).toBeDisabled()
  act(() => local.dispatch({ type: 'test/scope', payload: ['r1', 'r2'] }))
  await act(async () => pending.at(-1)!.reject(new Error('クラス数エラー')))
  expect(screen.getByRole('alert')).toHaveTextContent('クラス数エラー')
  fireEvent.click(screen.getByRole('button', { name: '再試行' }))
  expect(screen.getByTestId('run-logistic-btn')).toBeDisabled()
  await act(async () => pending.at(-1)!.resolve(response(2)))
  expect(screen.queryByRole('alert')).toBeNull()
  await choose('目的', /species.*2クラス/)
  expect(screen.getByTestId('logistic-target-select')).toHaveTextContent('species')
})
