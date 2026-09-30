import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import * as lrApi from '../src/features/models/lrApi'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'

vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select aria-label={props.placeholder}
  multiple={props.mode === 'multiple'} value={props.value ?? ''} onChange={event => props.onChange(props.mode === 'multiple'
    ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
  {props.mode !== 'multiple' && <option value="">選択</option>}
  {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/features/models/LinearRegressionFigure', () => ({ default: () => <div>diagnostic figure</div> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children, controls }: any) => <div>{controls}{children}</div> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: () => 'replace' }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup() {
  const base = store.getState()
  const state: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1 },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, isLoading: false,
      columns: ['Outcome', 'X', 'Z'].map(name => ({ columnId: name, name, role: 'question', scaleType: 'ratio' })) } }
  const local = configureStore({ reducer: (s = state) => s, middleware: get => get({ serializableCheck: false }) })
  const view = render(<Provider store={local}><LinearRegressionPage /></Provider>)
  fireEvent.change(view.getByLabelText('目的変数を選択'), { target: { value: 'Outcome' } })
  fireEvent.change(view.getByLabelText('数値を選択'), { target: { value: 'X' } })
  const button = view.getByRole('button', { name: '実 行' })
  return { view, button }
}

const fit: any = { resultId: 'lr1', meta: { dataRevision: 1, schemaRevision: 1, warnings: [] },
  summary: { modelFormula: 'Outcome ~ X', rSquared: .98, rmse: .72 },
  capabilities: { materializeFitFields: ['fitted'], materializePredictionFields: ['predicted'] },
  details: { coefficients: [], vif: [] }, unavailableReasons: {} }

it('clears run loading when fit succeeds even while diagnostic rows are pending', async () => {
  let finish!: (value: any) => void
  vi.spyOn(lrApi, 'runLinearRegression').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.spyOn(lrApi, 'fetchLinearRegressionRows').mockImplementation(() => new Promise(() => {}))
  const { view, button } = setup()
  fireEvent.click(button)
  await waitFor(() => expect(button).toHaveClass('ant-btn-loading'))
  await act(async () => { finish(fit) })
  await waitFor(() => expect(button).not.toHaveClass('ant-btn-loading'))
  expect(view.getByText('結果: Outcome ~ X')).toBeInTheDocument()
  expect(view.getByText('行を取得中…')).toBeInTheDocument()
  expect(button).not.toBeDisabled()
})

it('clears run loading after a rejected fit and allows retry', async () => {
  vi.spyOn(lrApi, 'runLinearRegression').mockRejectedValue(new Error('fit failed'))
  const { view, button } = setup()
  fireEvent.click(button)
  await view.findByText('fit failed')
  await waitFor(() => expect(button).not.toHaveClass('ant-btn-loading'))
  expect(button).not.toBeDisabled()
})
