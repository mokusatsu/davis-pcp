import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import TablePage from '../src/features/table/TablePage'
import { AnalysisViewActivityContext } from '../src/features/selection/analysisScope'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('does not fetch hidden KeepAlive views and fetches only the latest scope when shown', async () => {
  const base = store.getState()
  const initial = { ...base, selection: { ...base.selection, datasetId: 'd', activeRowIds: ['r1'], allRowIds: ['r1', 'r2'] },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'x' }] },
    codebook: { ...base.codebook, datasetId: 'd', columns: [{ name: 'x', columnId: 'x', scaleType: 'ratio', role: 'question' }] } }
  const local = configureStore({ reducer: (state: any = initial, action: any) => action.type === 'test/scope'
    ? { ...state, selection: { ...state.selection, activeRowIds: action.payload } } : state,
    middleware: g => g({ serializableCheck: false }) })
  vi.spyOn(api, 'get').mockResolvedValue({ entries: [] })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ rows: [], entities: [], total: 0 })
  const app = (visible: boolean) => <Provider store={local}><MemoryRouter><AnalysisViewActivityContext.Provider value={visible}><TablePage /></AnalysisViewActivityContext.Provider></MemoryRouter></Provider>
  const view = render(app(false))
  await act(async () => {})
  expect(post).not.toHaveBeenCalled()
  act(() => { local.dispatch({ type: 'test/scope', payload: ['r2'] }) })
  expect(post).not.toHaveBeenCalled()
  view.rerender(app(true))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenLastCalledWith('/datasets/d/table-view', expect.objectContaining({ rowIds: ['r2'] }))
})
