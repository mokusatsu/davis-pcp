import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store, weightColumnCleared, weightColumnSet } from '../src/app/store'
import { QuestionCard } from '../src/features/distribution/QuestionCard'
import WeightUnsupportedAlert from '../src/features/common/WeightUnsupportedAlert'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function weightStore() {
  const base = store.getState()
  return configureStore({ reducer: (s = base) => s })
}

it('stores the weight column per dataset and clears it on switch', () => {
  const base = store.getState()
  const state = {
    ...base,
    globalVariables: { ...base.globalVariables, datasetId: 'd1', weightColumnId: null },
  }
  const local = configureStore({ reducer: (s = state, a: any) => {
    if (a.type === 'globalVariables/weightColumnSet') return { ...s, globalVariables: { ...s.globalVariables, weightColumnId: a.payload.columnId } }
    if (a.type === 'globalVariables/weightColumnCleared') return { ...s, globalVariables: { ...s.globalVariables, weightColumnId: null } }
    if (a.type === 'globalVariables/variablesInitialized' && a.payload.datasetId !== s.globalVariables.datasetId) {
      return { ...s, globalVariables: { ...s.globalVariables, datasetId: a.payload.datasetId, weightColumnId: null } }
    }
    return s
  } })
  local.dispatch(weightColumnSet({ columnId: 'c-w', datasetId: 'd1' }))
  expect(local.getState().globalVariables.weightColumnId).toBe('c-w')
  local.dispatch(weightColumnCleared())
  expect(local.getState().globalVariables.weightColumnId).toBeNull()
})

it('renders weighted and unweighted values with the required note', () => {
  const view = render(<Provider store={weightStore()}><QuestionCard summary={{
    columnId: 'Q1',
    denominators: { total: 6, target: 6, valid: 6, missing: 0, notApplicable: 0 },
    distribution: [{ code: '1', label: 'low', count: 3, percentageValid: 50, percentageTotal: 50 }],
    auxiliaryStats: { mean: 1.5, meanNote: '等間隔得点として計算', median: 1.5 },
    weighted: { weightedN: 11, weightMissingCount: 1,
      distribution: [{ code: '1', weightedCount: 3, weightedPct: 27.2727 }],
      weightedMean: 1.5, meanNote: '等間隔得点として計算' },
    weight: { status: 'applied', columnName: 'wt', unweightedN: 6, weightedN: 11, weightMissingCount: 1 },
  }} /></Provider>)
  expect(view.getByText('ウェイト適用中')).toBeTruthy()
  expect(view.getByTestId('weight-note').textContent).toContain('非加重n=6')
  expect(view.getByTestId('weight-note').textContent).toContain('標準誤差は非加重n基準')
  expect(view.container.textContent).toContain('加重平均')
  fireEvent.click(view.getByText('ウェイト適用中'))
})

it('shows the unsupported warning only when a weight is selected', () => {
  const withWeight = render(<WeightUnsupportedAlert weightColumnName="wt" />)
  expect(withWeight.getByTestId('weight-unsupported-alert').textContent).toContain('ウェイト未適用')
  withWeight.unmount()
  const withoutWeight = render(<WeightUnsupportedAlert weightColumnName={null} />)
  expect(withoutWeight.queryByTestId('weight-unsupported-alert')).toBeNull()
})
