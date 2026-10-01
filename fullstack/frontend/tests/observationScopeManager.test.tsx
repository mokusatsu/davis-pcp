import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { store, selectionReducer, globalObservationsSlice, datasetLoaded } from '../src/app/store'
import { api } from '../src/api/client'
import ObservationModal from '../src/features/selection/ObservationModal'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function setup() {
  const base = store.getState()
  const local = configureStore({ reducer: (state = base, action: any) => ({ ...state,
    selection: selectionReducer(state.selection, action), globalObservations: globalObservationsSlice.reducer(state.globalObservations, action),
  }), middleware: g => g({ serializableCheck: false }) })
  local.dispatch(datasetLoaded({ datasetId: 'd', name: 'D', rowIds: ['r1', 'r2'] }))
  return local
}
it('does not apply a range response after the manager is closed', async () => {
  const local = setup()
  let finish!: (value: any) => void
  vi.spyOn(api, 'post').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const app = (open: boolean) => <Provider store={local}><ObservationModal open={open} defaultTab="range" onClose={() => {}} /></Provider>
  const view = render(app(true))
  fireEvent.click(view.getByTestId('apply-range-btn'))
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
  view.rerender(app(false))
  await act(async () => { finish({ rowIds: ['r2'], count: 1 }) })
  expect(local.getState().selection.activeRowIds).toEqual(['r1', 'r2'])
})
it('sends null for a blank random seed and records the effective seed and provenance returned by the API', async () => {
  const local = setup()
  vi.spyOn(api, 'post').mockResolvedValue({ datasetId: 'd', sampledRowIds: ['r1'], sampledRowWeights: {r1: 1}, sampleSize: 1,
    seed: 123, dataRevision: 1, schemaRevision: 1, sourceScopeHash: 'hash', sourceOrderHash: 'order', sourceRowCount: 2, sampleId: 'sample' })
  const view = render(<Provider store={local}><ObservationModal open defaultTab="sampling" onClose={() => {}} /></Provider>)
  fireEvent.change(view.getByTestId('sampling-seed-input'), { target: { value: '' } })
  fireEvent.blur(view.getByTestId('sampling-seed-input'))
  fireEvent.click(view.getByTestId('apply-sampling-btn'))
  await waitFor(() => expect(local.getState().globalObservations.sampling.seed).toBe(123))
  expect(api.post).toHaveBeenCalledWith('/datasets/d/observations/sample', expect.objectContaining({ seed: null, expectedDataRevision: 1 }))
  expect(local.getState().globalObservations.sampling).toMatchObject({ sourceScope: 'active', sourceRowCount: 2, sourceScopeHash: 'hash', sourceOrderHash: 'order' })
})
