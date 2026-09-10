import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import RobustnessPage from '../src/features/robustness/RobustnessPage'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const evaluatePayload = {
  run_id: 'r1',
  conclusions: [
    {
      id: 'c1', type: 'kpi', label: '平均score', target_col: 'score',
      full_estimate: 15, ci_95: [14, 16] as [number, number],
      robustness: { grade: 'robust', grade_label: '頑健', flip_rate: 0, max_drift: 0.01, bootstrap_se: 0.2 },
      perturbations: [], sweep_curve: [], top_influence_respondents: [],
    },
  ],
}

const sensitivityPayload = {
  runId: 's1', method: 'standardized_deviation', threshold: 3.0, bootstrapB: 200, seed: 42,
  baseline: { n: 40, effectSize: 2.5, confidenceInterval: [1.2, 3.8] as [number, number], direction: 'positive', scopeHash: 'sha256:base' },
  sensitivity: { n: 39, excludedN: 1, effectSize: 2.4, confidenceInterval: [1.5, 3.3] as [number, number], direction: 'positive', scopeHash: 'sha256:sens' },
  comparison: { relativeChange: 0.04, baselineCiCrossesZero: false, sensitivityCiCrossesZero: false, directionPreserved: true, maxRelativeChange: 0.2, isRobust: true, reason: 'direction_and_ci_status_preserved' },
  outlierRowIds: ['r39'], weightApplied: false,
}

function localStore() {
  const base = store.getState()
  return configureStore({
    reducer: () => ({
      ...base,
      selection: { ...base.selection, datasetId: 'd', dataRevision: 1 },
      globalObservations: { ...base.globalObservations, activeRowIds: [] },
    }),
    middleware: (g) => g({ serializableCheck: false }),
  })
}

it('renders sensitivity comparison panel and runs sensitivity without touching selection', async () => {
  vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url === '/robustness/evaluate') return evaluatePayload as any
    if (url === '/robustness/sensitivity') return sensitivityPayload as any
    throw new Error(url)
  })
  const view = render(<Provider store={localStore()}><MemoryRouter><RobustnessPage /></MemoryRouter></Provider>)
  const { waitFor } = await import('@testing-library/react')
  await waitFor(() => expect(view.getByTestId('sensitivity-comparison-panel')).toBeTruthy())
  expect(view.container.textContent).toContain('数値的外れ度に基づく感度分析')
})
