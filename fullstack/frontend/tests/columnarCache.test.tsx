import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
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
