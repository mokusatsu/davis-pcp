import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, datasetLoaded } from '../src/app/store'
import type { MaDisplayAxis } from '../src/api/client'
import { COLUMNAR_CACHE_MAX_BYTES, COLUMNAR_CACHE_MAX_ENTRIES, acquireColumnarData, getColumnarCacheStats } from '../src/features/pcp/columnarCache'
import { invalidateColumnarCache, useColumnarData, type ColumnarData } from '../src/features/pcp/useDatasetColumns'

const api = vi.hoisted(() => ({ get: vi.fn(), view: vi.fn() }))
vi.mock('../src/api/client', () => ({ api: { get: api.get }, fetchArrowView: api.view }))
afterEach(() => { cleanup(); invalidateColumnarCache(); vi.clearAllMocks() })

it('shares canonical projections, keeps distinct and empty requests separate, and reuses a revisited projection', async () => {
  api.get.mockResolvedValue({ schema: ['A', 'B'].map(name => ({ name, columnId: name, semanticType: 'numeric' })) })
  api.view.mockImplementation(async (_id, columns) => ({ __rowId__: ['r'], ...Object.fromEntries(columns.map((name: string) => [name, [1]])) }))
  const seen: (ColumnarData | null)[] = []
  function Probe({ index, columns }: { index: number; columns: string[] }) {
    seen[index] = useColumnarData('projected', columns)
    return null
  }
  function App({ first }: { first: string[] }) { return <Provider store={store}>
    <Probe index={0} columns={first} /><Probe index={1} columns={['B', 'A', 'B']} /><Probe index={2} columns={[]} />
  </Provider> }
  const view = render(<App first={['A', 'B']} />)
  await waitFor(() => expect(seen.every(Boolean)).toBe(true))
  expect(seen[0]).toBe(seen[1])
  expect(seen[2]?.schema).toEqual([])
  expect(api.view).toHaveBeenCalledTimes(2)
  expect(api.view).toHaveBeenCalledWith('projected', [])
  view.rerender(<App first={['A']} />)
  await waitFor(() => expect(seen[0]?.schema.map(column => column.name)).toEqual(['A']))
  expect(api.view).toHaveBeenCalledTimes(3)
  view.rerender(<App first={['B', 'A']} />)
  await waitFor(() => expect(seen[0]).toBe(seen[1]))
  expect(api.view).toHaveBeenCalledTimes(3)
})

it('shares one load and object across views, and hides previous-dataset data while loading', async () => {
  api.get.mockResolvedValue({ schema: [{ name: 'Q', columnId: 'q', semanticType: 'numeric' }] })
  api.view.mockResolvedValue({ __rowId__: ['r'], Q: [1] })
  const base = store.getState()
  const state = configureStore({ reducer: (s = { ...base, selection: { ...base.selection, datasetId: 'a' } }, action: any) =>
    action.type === 'switch' ? { ...s, selection: { ...s.selection, datasetId: action.payload } }
      : action.type === 'schema' ? { ...s, codebook: { ...s.codebook, datasetId: 'a', schemaRevision: 2 } }
      : action.type === 'data' ? { ...s, selection: { ...s.selection, dataRevision: 2 } } : s,
    middleware: g => g({ serializableCheck: false }),
  })
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index }: { index: number }) {
    const datasetId = state.getState().selection.datasetId
    seen[index] = useColumnarData(datasetId)
    return <span>{seen[index]?.columns.Q[0] as number ?? 'loading'}</span>
  }
  function App() { return <Provider store={state}><Probe index={0} /><Probe index={1} /></Provider> }
  const rendered = render(<App />)
  await waitFor(() => expect(seen[0]).not.toBeNull())
  expect(seen[0]).toBe(seen[1])
  expect(api.get).toHaveBeenCalledTimes(1)
  expect(api.view).toHaveBeenCalledTimes(1)
  act(() => { state.dispatch({ type: 'schema' }) })
  rendered.rerender(<App />)
  expect(api.view).toHaveBeenCalledTimes(1)
  act(() => { state.dispatch({ type: 'data' }) })
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(seen[0]).not.toBeNull())
  let finish: (view: unknown) => void = () => {}
  api.view.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  act(() => { state.dispatch({ type: 'switch', payload: 'b' }) })
  rendered.rerender(<App />)
  expect(seen).toEqual([null, null])
  await act(async () => { finish({ __rowId__: ['s'], Q: [2] }) })
  await waitFor(() => expect(seen[0]?.columns.Q).toEqual([2]))
  expect(seen[0]).toBe(seen[1])
})


function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function revisionsStore() {
  const base = store.getState()
  return configureStore({
    reducer: (state = { ...base, selection: { ...base.selection, datasetId: 'a', dataRevision: 1 }, codebook: { ...base.codebook, schemaRevision: 1 } }, action: any) =>
      action.type === 'data' ? { ...state, selection: { ...state.selection, dataRevision: action.payload } }
        : action.type === 'schema' ? { ...state, codebook: { ...state.codebook, schemaRevision: action.payload } } : state,
    middleware: g => g({ serializableCheck: false }),
  })
}

function mockNumericColumns(names: string[]) {
  api.get.mockResolvedValue({ schema: names.map(name => ({ name, columnId: name, semanticType: 'numeric' })) })
  api.view.mockImplementation(async (_id, columns) => ({
    __rowId__: ['r'], ...Object.fromEntries((columns ?? names).map((name: string) => [name, [42]])),
  }))
}

it('bounds projection count and refreshes recency when an old projection is reused', async () => {
  const names = Array.from({ length: COLUMNAR_CACHE_MAX_ENTRIES + 1 }, (_, index) => `C${index}`)
  mockNumericColumns(names)
  let seen: ColumnarData | null = null
  function Probe({ column }: { column: string }) { seen = useColumnarData('bounded', [column]); return null }
  const app = (column: string) => <Provider store={store}><Probe column={column} /></Provider>
  const rendered = render(app(names[0]))
  await waitFor(() => expect(seen?.schema[0]?.name).toBe(names[0]))
  const oldest = seen
  for (const name of names.slice(1, COLUMNAR_CACHE_MAX_ENTRIES)) {
    rendered.rerender(app(name))
    await waitFor(() => expect(seen?.schema[0]?.name).toBe(name))
  }
  expect(getColumnarCacheStats().entries).toBe(COLUMNAR_CACHE_MAX_ENTRIES)
  rendered.rerender(app(names[0]))
  expect(seen).toBe(oldest)
  expect(api.view).toHaveBeenCalledTimes(COLUMNAR_CACHE_MAX_ENTRIES)
  rendered.rerender(app(names.at(-1)!))
  await waitFor(() => expect(seen?.schema[0]?.name).toBe(names.at(-1)))
  expect(getColumnarCacheStats().entries).toBe(COLUMNAR_CACHE_MAX_ENTRIES)
  rendered.rerender(app(names[0]))
  expect(seen).toBe(oldest)
  rendered.rerender(app(names[1]))
  await waitFor(() => expect(seen?.schema[0]?.name).toBe(names[1]))
  expect(api.view).toHaveBeenCalledTimes(COLUMNAR_CACHE_MAX_ENTRIES + 2)
})

it('keeps mounted view data correct when its cache entry is evicted', async () => {
  const names = Array.from({ length: COLUMNAR_CACHE_MAX_ENTRIES + 1 }, (_, index) => `C${index}`)
  mockNumericColumns(names)
  const state = revisionsStore()
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index, column }: { index: number; column: string }) {
    seen[index] = useColumnarData('mounted', [column])
    return null
  }
  const app = (column: string) => <Provider store={state}>
    <Probe index={0} column={names[0]} /><Probe index={1} column={column} />
  </Provider>
  const rendered = render(app(names[0]))
  await waitFor(() => expect(seen[0]).not.toBeNull())
  const mounted = seen[0]
  for (const name of names.slice(1)) {
    rendered.rerender(app(name))
    await waitFor(() => expect(seen[1]?.schema[0]?.name).toBe(name))
  }
  expect(getColumnarCacheStats().entries).toBe(COLUMNAR_CACHE_MAX_ENTRIES)
  expect(seen[0]).toBe(mounted)
  expect(seen[0]?.numeric.C0[0]).toBe(42)
  expect(seen[0]?.rowIndex.get('r')).toBe(0)
  act(() => { state.dispatch({ type: 'schema', payload: 2 }) })
  expect(seen[0]).toBe(mounted)
  expect(api.view).toHaveBeenCalledTimes(COLUMNAR_CACHE_MAX_ENTRIES + 1)
  rendered.rerender(app(names[0]))
  await waitFor(() => expect(seen[1]?.schema[0]?.name).toBe(names[0]))
  expect(api.view).toHaveBeenCalledTimes(COLUMNAR_CACHE_MAX_ENTRIES + 2)
  expect(seen[1]).not.toBe(mounted)
  expect(seen[0]).toBe(mounted)
})

it('enforces the byte budget as well as the entry limit', async () => {
  const names = ['A', 'B', 'C', 'D']
  const largeValue = 'x'.repeat(Math.floor(COLUMNAR_CACHE_MAX_BYTES / 12))
  api.get.mockResolvedValue({ schema: names.map(name => ({ name, columnId: name, semanticType: 'nominal' })) })
  api.view.mockImplementation(async (_id, columns) => ({ __rowId__: ['r'], [columns[0]]: [largeValue] }))
  let seen: ColumnarData | null = null
  function Probe({ column }: { column: string }) { seen = useColumnarData('bytes', [column]); return null }
  const app = (column: string) => <Provider store={store}><Probe column={column} /></Provider>
  const rendered = render(app(names[0]))
  for (const column of names) {
    rendered.rerender(app(column))
    await waitFor(() => expect(seen?.schema[0]?.name).toBe(column))
    expect(getColumnarCacheStats().estimatedBytes).toBeLessThanOrEqual(COLUMNAR_CACHE_MAX_BYTES)
  }
  expect(getColumnarCacheStats().entries).toBeLessThan(names.length)
  expect(getColumnarCacheStats().entries).toBeGreaterThan(0)
  rendered.rerender(app(names[0]))
  await waitFor(() => expect(seen?.schema[0]?.name).toBe(names[0]))
  expect(api.view).toHaveBeenCalledTimes(names.length + 1)
})

it('delivers an oversize result to concurrent mounted consumers without retaining it in the cache', async () => {
  const value = 'x'.repeat(COLUMNAR_CACHE_MAX_BYTES / 4)
  api.get.mockResolvedValue({ schema: [{ name: 'A', columnId: 'A', semanticType: 'nominal' }] })
  api.view.mockResolvedValue({ __rowId__: ['r'], A: [value] })
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index }: { index: number }) { seen[index] = useColumnarData('oversize'); return null }
  const app = <Provider store={store}><Probe index={0} /><Probe index={1} /></Provider>
  const first = render(app)
  await waitFor(() => expect(seen[0]).not.toBeNull())
  expect(seen[0]).toBe(seen[1])
  expect(seen[0]?.columns.A[0]).toBe(value)
  expect(api.view).toHaveBeenCalledTimes(1)
  expect(getColumnarCacheStats()).toEqual({ entries: 0, estimatedBytes: 0, pendingLoads: 0, pendingConsumers: 0 })
  first.unmount()
  const next = render(app)
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(seen[0]).not.toBeNull())
  next.unmount()
})

it('releases obsolete dataset and data-revision entries instead of reviving old objects', async () => {
  mockNumericColumns(['Q'])
  const state = revisionsStore()
  let seen: ColumnarData | null = null
  function Probe({ datasetId }: { datasetId: string }) { seen = useColumnarData(datasetId); return null }
  const app = (id: string) => <Provider store={state}><Probe datasetId={id} /></Provider>
  const rendered = render(app('a'))
  await waitFor(() => expect(seen).not.toBeNull())
  const first = seen
  rendered.rerender(app('b'))
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(seen).not.toBeNull())
  expect(getColumnarCacheStats().entries).toBe(1)
  rendered.rerender(app('a'))
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(seen).not.toBeNull())
  expect(seen).not.toBe(first)
  const revisionOne = seen
  act(() => { state.dispatch({ type: 'data', payload: 2 }) })
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(4))
  await waitFor(() => expect(seen).not.toBeNull())
  expect(getColumnarCacheStats().entries).toBe(1)
  act(() => { state.dispatch({ type: 'data', payload: 1 }) })
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(5))
  await waitFor(() => expect(seen).not.toBeNull())
  expect(seen).not.toBe(revisionOne)
})

it('prunes on store dataset/revision changes even with no mounted columnar consumers', async () => {
  mockNumericColumns(['Q'])
  const original = store.getState().selection
  store.dispatch(datasetLoaded({ datasetId: 'store-a', name: 'a', rowIds: ['r'], dataRevision: 1 }))
  let seen: ColumnarData | null = null
  function Probe() { seen = useColumnarData('store-a'); return null }
  const load = async () => {
    const rendered = render(<Provider store={store}><Probe /></Provider>)
    await waitFor(() => expect(seen).not.toBeNull())
    rendered.unmount()
    expect(getColumnarCacheStats().entries).toBe(1)
  }
  try {
    await load()
    store.dispatch(datasetLoaded({ datasetId: 'store-a', name: 'a', rowIds: ['r'], dataRevision: 2 }))
    expect(getColumnarCacheStats().entries).toBe(0)
    await load()
    store.dispatch(datasetLoaded({ datasetId: 'store-b', name: 'b', rowIds: ['r'], dataRevision: 1 }))
    expect(getColumnarCacheStats()).toEqual({ entries: 0, estimatedBytes: 0, pendingLoads: 0, pendingConsumers: 0 })
  } finally {
    store.dispatch({ type: datasetLoaded.type, payload: { datasetId: original.datasetId, name: original.datasetName, rowIds: original.allRowIds, dataRevision: original.dataRevision } })
  }
})

it('preserves raw data across schema edits while purging obsolete MA schema entries', async () => {
  mockNumericColumns(['Q'])
  api.view.mockImplementation(async (_id, columns, _rows, options) => ({
    __rowId__: ['r'], Q: [42], ...Object.fromEntries((options?.maAxes ?? []).map((axis: MaDisplayAxis) => [axis.key, [options.expectedSchemaRevision]])),
  }))
  const axes: MaDisplayAxis[] = [{ key: 'count', kind: 'maCount', groupId: 'group' }]
  const state = revisionsStore()
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index }: { index: number }) { seen[index] = useColumnarData('a', ['Q'], index ? axes : undefined); return null }
  const rendered = render(<Provider store={state}><Probe index={0} /><Probe index={1} /></Provider>)
  await waitFor(() => expect(seen.every(Boolean)).toBe(true))
  const raw = seen[0]
  const firstMa = seen[1]
  expect(api.view).toHaveBeenCalledTimes(2)
  expect(seen[1]?.numeric.count[0]).toBe(1)
  act(() => { state.dispatch({ type: 'schema', payload: 2 }) })
  await waitFor(() => expect(seen[1]?.numeric.count[0]).toBe(2))
  expect(seen[0]).toBe(raw)
  expect(api.view).toHaveBeenCalledTimes(3)
  expect(getColumnarCacheStats().entries).toBe(2)
  act(() => { state.dispatch({ type: 'schema', payload: 1 }) })
  await waitFor(() => expect(seen[1]?.numeric.count[0]).toBe(1))
  expect(api.view).toHaveBeenCalledTimes(4)
  expect(seen[1]).not.toBe(firstMa)
  expect(seen[0]).toBe(raw)
  rendered.unmount()
})

it('shares canonical MA axes but separates changed axis descriptors', async () => {
  mockNumericColumns(['Q'])
  const axes: MaDisplayAxis[] = [
    { key: 'count', kind: 'maCount', groupId: 'g' },
    { key: 'option', kind: 'maOption', groupId: 'g', columnId: 'Q' },
  ]
  const state = revisionsStore()
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index, axes }: { index: number; axes: MaDisplayAxis[] }) { seen[index] = useColumnarData('a', [], axes); return null }
  const app = (first: MaDisplayAxis[]) => <Provider store={state}>
    <Probe index={0} axes={first} /><Probe index={1} axes={[...axes].reverse()} />
  </Provider>
  const rendered = render(app(axes))
  await waitFor(() => expect(seen.every(Boolean)).toBe(true))
  expect(seen[0]).toBe(seen[1])
  expect(api.view).toHaveBeenCalledTimes(1)
  expect(api.view).toHaveBeenLastCalledWith('a', [], undefined, {
    maAxes: axes, expectedDataRevision: 1, expectedSchemaRevision: 1,
  })
  rendered.rerender(app(axes.map(axis => ({ ...axis, groupId: 'different' }))))
  await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(seen[0]).not.toBeNull())
  expect(seen[0]).not.toBe(seen[1])
})

it('invalidates an in-flight load without publishing its stale result or deleting its replacement', async () => {
  mockNumericColumns(['Q'])
  const old = deferred<Record<string, unknown[]>>()
  const fresh = deferred<Record<string, unknown[]>>()
  api.view.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  let seen: ColumnarData | null = null
  function Probe() { seen = useColumnarData('race'); return null }
  render(<Provider store={store}><Probe /></Provider>)
  expect(getColumnarCacheStats().pendingLoads).toBe(1)
  act(() => { invalidateColumnarCache() })
  expect(api.view).toHaveBeenCalledTimes(2)
  await act(async () => { old.resolve({ __rowId__: ['old'], Q: [1] }) })
  expect(seen).toBeNull()
  expect(getColumnarCacheStats()).toEqual({ entries: 0, estimatedBytes: 0, pendingLoads: 1, pendingConsumers: 1 })
  await act(async () => { fresh.resolve({ __rowId__: ['fresh'], Q: [2] }) })
  expect(seen?.columns.Q).toEqual([2])
  expect(seen?.rowIds).toEqual(['fresh'])
  expect(getColumnarCacheStats().entries).toBe(1)
})

it('does not revive a pending request after switching away and back to the same key', async () => {
  mockNumericColumns(['Q'])
  const old = deferred<Record<string, unknown[]>>()
  const fresh = deferred<Record<string, unknown[]>>()
  api.view.mockReturnValueOnce(old.promise)
  let seen: ColumnarData | null = null
  function Probe({ id }: { id: string }) { seen = useColumnarData(id); return null }
  const app = (id: string) => <Provider store={store}><Probe id={id} /></Provider>
  const rendered = render(app('a'))
  rendered.rerender(app('b'))
  await waitFor(() => expect(seen).not.toBeNull())
  api.view.mockReturnValueOnce(fresh.promise)
  rendered.rerender(app('a'))
  await act(async () => { old.resolve({ __rowId__: ['old'], Q: [1] }) })
  expect(seen).toBeNull()
  expect(getColumnarCacheStats().pendingLoads).toBe(1)
  await act(async () => { fresh.resolve({ __rowId__: ['fresh'], Q: [2] }) })
  expect(seen?.rowIds).toEqual(['fresh'])
  expect(getColumnarCacheStats().entries).toBe(1)
})

it('releases unmounted pending consumers immediately and never caches an orphaned completion', async () => {
  mockNumericColumns(['Q'])
  const response = deferred<Record<string, unknown[]>>()
  api.view.mockReturnValueOnce(response.promise)
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index }: { index: number }) { seen[index] = useColumnarData('pending'); return null }
  const first = render(<Provider store={store}><Probe index={0} /></Provider>)
  const second = render(<Provider store={store}><Probe index={1} /></Provider>)
  expect(api.view).toHaveBeenCalledTimes(1)
  expect(getColumnarCacheStats().pendingConsumers).toBe(2)
  first.unmount()
  expect(getColumnarCacheStats().pendingLoads).toBe(1)
  expect(getColumnarCacheStats().pendingConsumers).toBe(1)
  second.unmount()
  expect(getColumnarCacheStats().pendingLoads).toBe(0)
  expect(getColumnarCacheStats().pendingConsumers).toBe(0)
  await act(async () => { response.resolve({ __rowId__: ['old'], Q: [1] }) })
  expect(getColumnarCacheStats().entries).toBe(0)
  render(<Provider store={store}><Probe index={0} /></Provider>)
  await waitFor(() => expect(seen[0]?.numeric.Q[0]).toBe(42))
  expect(api.view).toHaveBeenCalledTimes(2)
})

it.each(['sync', 'async'])('cleans failed %s loads and allows a later retry', async (mode) => {
  mockNumericColumns(['Q'])
  if (mode === 'sync') api.get.mockImplementationOnce(() => { throw new Error('transport failed') })
  else api.view.mockRejectedValueOnce(new Error('transport failed'))
  let seen: ColumnarData | null = null
  function Probe() { seen = useColumnarData('retry'); return null }
  const app = <Provider store={store}><Probe /></Provider>
  const first = render(app)
  await waitFor(() => expect(getColumnarCacheStats().pendingLoads).toBe(0))
  expect(seen).toBeNull()
  expect(getColumnarCacheStats().entries).toBe(0)
  first.unmount()
  render(app)
  await waitFor(() => expect(seen?.numeric.Q[0]).toBe(42))
  expect(getColumnarCacheStats().entries).toBe(1)
})


it('reloads mounted consumers after explicit invalidation even when the data key is unchanged', async () => {
  mockNumericColumns(['Q'])
  let seen: ColumnarData | null = null
  function Probe() { seen = useColumnarData('invalidate-ready'); return null }
  render(<Provider store={store}><Probe /></Provider>)
  await waitFor(() => expect(seen?.numeric.Q[0]).toBe(42))
  const fresh = deferred<Record<string, unknown[]>>()
  api.view.mockReturnValueOnce(fresh.promise)
  act(() => { invalidateColumnarCache() })
  expect(seen).toBeNull()
  expect(api.view).toHaveBeenCalledTimes(2)
  await act(async () => { fresh.resolve({ __rowId__: ['new'], Q: [84] }) })
  expect(seen?.numeric.Q[0]).toBe(84)
})

it('does not evict other views when a hook uses an external source instead of a dataset', async () => {
  mockNumericColumns(['Q'])
  const seen: (ColumnarData | null)[] = [null, null]
  function Probe({ index, id }: { index: number; id: string | null }) {
    seen[index] = useColumnarData(id)
    return null
  }
  const app = (second: string | null) => <Provider store={store}>
    <Probe index={0} id="a" /><Probe index={1} id={second} />
  </Provider>
  const rendered = render(app('a'))
  await waitFor(() => expect(seen.every(Boolean)).toBe(true))
  const first = seen[0]
  rendered.rerender(app(null))
  expect(seen[1]).toBeNull()
  expect(getColumnarCacheStats().entries).toBe(1)
  rendered.rerender(app('a'))
  expect(seen[0]).toBe(first)
  expect(seen[1]).toBe(first)
  expect(api.view).toHaveBeenCalledTimes(1)
})


it('does not let a new consumer join an already-delivered oversize request', async () => {
  const data: ColumnarData = {
    rowIds: ['r'], rowIndex: new Map([['r', 0]]), schema: [],
    columns: { text: ['x'.repeat(COLUMNAR_CACHE_MAX_BYTES / 2)] },
    numeric: {}, categories: {}, minMax: {},
  }
  const context = { datasetId: 'late-consumer', dataRevision: 1, schemaRevision: null }
  const load = vi.fn().mockResolvedValue(data)
  const second = vi.fn()
  let releaseSecond = () => {}
  const releaseFirst = acquireColumnarData('late-consumer', context, load, () => {
    releaseSecond = acquireColumnarData('late-consumer', context, load, second)
  })
  await waitFor(() => expect(second).toHaveBeenCalledOnce())
  expect(load).toHaveBeenCalledTimes(2)
  expect(getColumnarCacheStats().entries).toBe(0)
  expect(getColumnarCacheStats().pendingLoads).toBe(0)
  releaseFirst()
  releaseSecond()
})
