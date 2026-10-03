import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { store, selectionReducer, globalObservationsSlice, datasetLoaded } from '../src/app/store'
import { api } from '../src/api/client'
import ObservationModal from '../src/features/selection/ObservationModal'
const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => { vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element)) })
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

it.each(['1.5', '-1', '9007199254740992'])('WF-11 rejects invalid seed %s persistently and recovers to an integer', async value => {
  const local = setup(), onClose = vi.fn()
  const post = vi.spyOn(api, 'post').mockResolvedValue({ datasetId: 'd', sampledRowIds: ['r1'], sampledRowWeights: { r1: 1 }, sampleSize: 1,
    seed: 42, dataRevision: 1, schemaRevision: 1, sourceScopeHash: 'hash', sourceOrderHash: 'order', sourceRowCount: 2 })
  const view = render(<Provider store={local}><ObservationModal open onClose={onClose} /></Provider>)
  const input = view.getByTestId('sampling-seed-input'), apply = view.getByTestId('apply-sampling-btn')
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(view.getByText(/Seedは0以上/)).toHaveAttribute('role', 'alert')
  expect(apply).toBeDisabled()
  fireEvent.click(apply)
  expect(post).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  expect(local.getState().globalObservations.sampling.enabled).toBe(false)
  fireEvent.change(input, { target: { value: '42' } })
  fireEvent.blur(input)
  expect(input).toHaveAttribute('aria-invalid', 'false')
  expect(apply).not.toBeDisabled()
  fireEvent.click(apply)
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  expect(post).toHaveBeenCalledWith('/datasets/d/observations/sample', expect.objectContaining({ seed: 42 }))
  expect(local.getState().globalObservations.sampling.seed).toBe(42)
})

it('retains API validation errors next to seed and recovers without closing the draft', async () => {
  const local = setup(), onClose = vi.fn()
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce({ code: 'VALIDATION_ERROR', message: 'seed: 整数で入力してください。',
    details: { fieldErrors: { seed: '整数で入力してください。' } } }).mockResolvedValueOnce({ datasetId: 'd', sampledRowIds: ['r1'],
      sampledRowWeights: { r1: 1 }, sampleSize: 1, seed: 0, dataRevision: 1, schemaRevision: 1, sourceRowCount: 2 })
  const view = render(<Provider store={local}><ObservationModal open onClose={onClose} /></Provider>)
  fireEvent.click(view.getByTestId('apply-sampling-btn'))
  await waitFor(() => expect(view.getByTestId('sampling-error')).toHaveTextContent('seed: 整数'))
  expect(view.getByTestId('sampling-seed-input')).toHaveAttribute('aria-invalid', 'true')
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.change(view.getByTestId('sampling-seed-input'), { target: { value: '0' } })
  expect(view.queryByTestId('sampling-error')).toBeNull()
  fireEvent.click(view.getByTestId('apply-sampling-btn'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  expect(local.getState().globalObservations.sampling.seed).toBe(0)
})

it('keeps a general sampling failure visible and permits retry', async () => {
  const local = setup()
  vi.spyOn(api, 'post').mockRejectedValue(new Error('通信に失敗しました'))
  const view = render(<Provider store={local}><ObservationModal open onClose={() => {}} /></Provider>)
  fireEvent.click(view.getByTestId('apply-sampling-btn'))
  await waitFor(() => expect(view.getByTestId('sampling-error')).toHaveTextContent('通信に失敗しました'))
  expect(view.getByTestId('sampling-seed-input')).toHaveValue('42')
  expect(view.getByTestId('apply-sampling-btn')).not.toBeDisabled()
})
