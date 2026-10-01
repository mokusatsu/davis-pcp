import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store, datasetLoaded } from '../src/app/store'
import { api } from '../src/api/client'
import RobustnessPage from '../src/features/robustness/RobustnessPage'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const stalePayload = {
  run_id: 'stale',
  conclusions: [
    {
      id: 'c-stale', type: 'kpi', label: 'stale', target_col: 'score',
      full_estimate: 1, ci_95: [0, 2] as [number, number],
      robustness: { grade: 'robust', grade_label: '頑健', flip_rate: 0, max_drift: 0, bootstrap_se: 0.1 },
      perturbations: [], sweep_curve: [], top_influence_respondents: [],
    },
  ],
}

const freshPayload = {
  run_id: 'fresh',
  conclusions: [
    {
      id: 'c-fresh', type: 'kpi', label: 'fresh', target_col: 'score',
      full_estimate: 9, ci_95: [8, 10] as [number, number],
      robustness: { grade: 'robust', grade_label: '頑健', flip_rate: 0, max_drift: 0, bootstrap_se: 0.1 },
      perturbations: [], sweep_curve: [], top_influence_respondents: [],
    },
  ],
}

function localStore() {
  const base = store.getState()
  const selectionBase = { ...base.selection }
  let selection = { ...selectionBase, datasetId: 'd1', dataRevision: 1 }
  return configureStore({
    reducer: (state: any = { ...base, selection, globalObservations: { ...base.globalObservations, scopeMode: 'sampled', sampling: { ...base.globalObservations.sampling, sampledRowIds: [] } } }, action: any) => {
      if (action.type === 'selection/datasetLoaded') {
        selection = { ...selection, datasetId: action.payload.datasetId, dataRevision: action.payload.dataRevision ?? 1 }
        return { ...state, selection }
      }
      return state
    },
    middleware: (g) => g({ serializableCheck: false }),
  })
}

it('drops a stale robustness response when the dataset changes mid-flight', async () => {
  const local = localStore()
  let resolveStale!: (value: unknown) => void
  const stalePromise = new Promise((resolve) => { resolveStale = resolve })
  const post = vi.spyOn(api, 'post').mockImplementation(async () => stalePromise as any)
  const view = render(
    <Provider store={local}>
      <MemoryRouter><RobustnessPage /></MemoryRouter>
    </Provider>,
  )
  const { act, waitFor } = await import('@testing-library/react')
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  // Dataset switches while the first request is still in flight: bump the
  // version so the stale response is dropped, then refetch for d2.
  await act(async () => {
    local.dispatch(datasetLoaded({ datasetId: 'd2', name: 'd2', rowIds: ['r1'] }))
  })
  post.mockResolvedValue(freshPayload as any)
  await act(async () => {
    resolveStale(stalePayload)
    await stalePromise
    await Promise.resolve()
  })
  expect(view.container.textContent).not.toContain('c-stale')
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2), { timeout: 8000 })
  await waitFor(() => expect(view.getByTestId('robustness-scorecard').textContent).toContain('9'), { timeout: 8000 })
  expect(view.container.textContent).not.toContain('c-stale')
})
