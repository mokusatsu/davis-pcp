import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import RelationshipsPage from '../src/features/relationships/RelationshipsPage'

const load = vi.hoisted(() => vi.fn(() => null))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ useColumnarData: load }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1677ff' }) }))
vi.mock('../src/features/common/FocusMode', () => ({ FocusTarget: ({ children }: any) => children, FocusEnterButton: () => null }))
vi.mock('../src/features/relationships/RelationshipCanvas', () => ({ default: ({ data }: any) => <div data-testid="pair-result">{data.rowIds.join(',')}</div> }))
vi.mock('../src/features/pcp/MaAxisPicker', () => ({ default: ({ onAdd }: any) => <button onClick={() => onAdd([{ kind: 'maOption', groupId: 'q', columnId: 'a' }])}>Add A</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks(); load.mockClear() })

it('starts with six ordinary variables, expands only a requested MA child, and does not reload on highlight', async () => {
  const base = store.getState()
  const columns = [...Array.from({ length: 8 }, (_, index) => ({ columnId: `x${index}`, name: `x${index}`, role: 'question', scaleType: 'ratio' })),
    ...['a', 'b'].map(name => ({ columnId: name, name, role: 'question', scaleType: 'nominal', multiResponseGroup: 'q' }))]
  const initial = { ...base, selection: { ...base.selection, datasetId: 'd', allRowIds: ['r'], activeRowIds: ['r'], selectedRowIds: [] },
    globalObservations: { ...base.globalObservations, activeRowIds: ['r'], totalRowIds: ['r'] },
    globalVariables: { ...base.globalVariables, activeEntities: null }, pcp: { ...base.pcp, colorBy: null },
    codebook: { ...base.codebook, datasetId: 'd', columns, schemaRevision: 1 } } as any
  const local = configureStore({ reducer: (state = initial, action: any) => action.type === 'highlight'
    ? { ...state, selection: { ...state.selection, selectedRowIds: ['r'] } }
    : action.type === 'clearVariables' ? { ...state, globalVariables: { ...state.globalVariables, activeEntities: [] } } : state,
    middleware: g => g({ serializableCheck: false }) })
  const post = vi.spyOn(api, 'post').mockImplementation(async (path, body: any) => path.endsWith('/matrix')
    ? { columns: body.columns, matrix: body.columns.map(() => body.columns.map(() => 1)), counts: body.columns.map(() => body.columns.map(() => 1)) } as any
    : { rowIds: ['r'], x: [1], y: [2] } as any)
  const view = render(<Provider store={local}><RelationshipsPage /></Provider>)
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(post.mock.calls[0][1]).toMatchObject({ columns: ['x0', 'x1', 'x2', 'x3', 'x4', 'x5'] })
  expect(post.mock.calls[1][1]).toMatchObject({ columns: ['x0', 'x1'] })
  expect(load.mock.calls.every(args => args[1]?.length === 0)).toBe(true)
  act(() => { local.dispatch({ type: 'highlight' }) })
  expect(post).toHaveBeenCalledTimes(2)
  fireEvent.click(view.getByText('Add A'))
  await waitFor(() => expect(post.mock.calls.some(([, body]: any) => body.columns.includes('a'))).toBe(true))
  expect(post.mock.calls.every(([, body]: any) => !body.columns.includes('b'))).toBe(true)
  act(() => { local.dispatch({ type: 'clearVariables' }) })
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/relationships/matrix', expect.objectContaining({ columns: [] })))
  expect(view.queryByTestId('pair-result')).toBeNull()
})
