import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import * as lrApi from '../src/features/models/lrApi'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'

function SelectInput(props: any) {
  return <select id={props.id} aria-label={props['aria-label'] ?? props.placeholder}
    multiple={props.mode === 'multiple'} value={props.value ?? ''} onChange={event => props.onChange(props.mode === 'multiple'
      ? Array.from(event.target.selectedOptions, option => option.value) : event.target.value)}>
    {props.mode !== 'multiple' && <option value="">選択</option>}
    {props.options.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>
}
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <SelectInput {...props} /> }))
vi.mock('antd', async original => ({ ...await original<any>(), Select: (props: any) => <SelectInput {...props} /> }))
vi.mock('../src/features/models/LinearRegressionFigure', () => ({ default: () => <div /> }))
vi.mock('../src/features/common/GraphPanel', () => ({ default: ({ children, controls }: any) => <div>{controls}{children}</div> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#abcdef' }) }))
vi.mock('../src/features/common/L1Legend', () => ({ default: () => null }))
vi.mock('../src/features/selection/SelectionMenu', () => ({ default: () => null, getBrushOp: () => 'replace' }))

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  // Stop at the request contract; result rendering is covered by workflow tests.
  vi.spyOn(lrApi, 'runLinearRegression').mockRejectedValue(new Error('Captured request'))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function mount() {
  const base = store.getState()
  const initial: any = { ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1, activeRowIds: ['r1', 'r2'] },
    codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, isLoading: false,
      columns: ['Outcome', 'X', 'Z', 'Group', 'Ordered'].map(name => ({ columnId: name, name, label: name,
        role: 'question', scaleType: name === 'Group' ? 'nominal' : name === 'Ordered' ? 'ordinal' : 'ratio',
        categoryOrder: name === 'Group' ? ['a', 'b'] : [] })) } }
  const local = configureStore({ reducer: (state = initial) => state, middleware: get => get({ serializableCheck: false }) })
  const view = render(<Provider store={local}><LinearRegressionPage /></Provider>)
  const settings = view.container.querySelector('details')!
  const run = screen.getByTestId('lr-run')
  const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
  const chooseVariables = () => { choose('目的変数を選択', 'Outcome'); choose('数値を選択', 'X') }
  return { ...view, settings, run, choose, chooseVariables }
}

it('keeps OLS optional settings closed and submits unchanged defaults from the simple form', async () => {
  const { settings, run, chooseVariables } = mount()
  expect(settings).not.toHaveAttribute('open')
  expect(run).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('目的変数を1列')
  chooseVariables()
  expect(run).toBeEnabled()
  expect(screen.getByLabelText('信頼水準')).not.toBeVisible()
  expect(settings.querySelector('summary')).toHaveTextContent('信頼水準 95%')
  expect(run.closest('.analysis-run-row')).toBeInTheDocument()
  expect(run).toHaveClass('ant-btn-primary')
  fireEvent.click(run)
  await waitFor(() => expect(lrApi.runLinearRegression).toHaveBeenCalledWith(
    expect.objectContaining({ datasetId: 'd', weightMode: 'dataset', missingPolicy: 'exclude', activeRowIds: ['r1', 'r2'] }),
    'Outcome', [{ columnId: 'X', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null }], [], true, 'auto', .95,
  ))
})

it('retains OLS optional edits when closing and reopening settings and switching methods', async () => {
  const { settings, run, choose, chooseVariables } = mount()
  chooseVariables()
  fireEvent.click(settings.querySelector('summary')!)
  choose('共分散', 'classical')
  fireEvent.change(screen.getByLabelText('信頼水準'), { target: { value: '.9' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '切片あり' }))
  choose('カテゴリを選択', 'Group')
  choose('Group の基準', 'b')
  choose('変数1', 'X'); choose('変数2', 'Group')
  fireEvent.click(screen.getByRole('button', { name: '追 加' }))
  fireEvent.click(settings.querySelector('summary')!)
  expect(settings).not.toHaveAttribute('open')
  expect(settings.querySelector('summary')).toHaveTextContent('切片なし / 共分散 classical / 信頼水準 90%')
  expect(settings.querySelector('summary')).toHaveTextContent('交互作用 1件 / 基準カテゴリ指定 1件')
  fireEvent.click(screen.getByRole('radio', { name: '正則化回帰' }))
  fireEvent.click(screen.getByRole('radio', { name: '通常の重回帰（OLS）' }))
  fireEvent.click(settings.querySelector('summary')!)
  expect(Number((screen.getByLabelText('信頼水準') as HTMLInputElement).value)).toBe(.9)
  expect(screen.getByLabelText('Group の基準')).toHaveValue('b')
  fireEvent.click(settings.querySelector('summary')!)
  fireEvent.click(run)
  await waitFor(() => expect(lrApi.runLinearRegression).toHaveBeenCalledWith(expect.anything(), 'Outcome', [
    { columnId: 'X', kind: 'numeric', ordinalAsNumericAcknowledged: false, score: null },
    { columnId: 'Group', kind: 'categorical', referenceCategory: 'b' },
  ], [['X', 'Group']], false, 'classical', .9))
})

it('opens settings and explains a stale hidden interaction next to Run', () => {
  const { settings, run, choose, chooseVariables } = mount()
  chooseVariables(); choose('カテゴリを選択', 'Group')
  fireEvent.click(settings.querySelector('summary')!)
  choose('変数1', 'X'); choose('変数2', 'Group')
  fireEvent.click(screen.getByRole('button', { name: '追 加' }))
  fireEvent.click(settings.querySelector('summary')!)
  choose('数値を選択', 'Z')
  expect(settings).toHaveAttribute('open')
  expect(run).toBeDisabled()
  expect(screen.getByTestId('lr-settings-issues')).toHaveTextContent('現在の説明変数にない列')
  fireEvent.click(settings.querySelector('summary')!)
  expect(screen.getByTestId('lr-settings-issues')).toBeVisible()
  expect(settings.querySelector('summary')).toHaveTextContent('設定を確認してください')
  fireEvent.click(run)
  expect(lrApi.runLinearRegression).not.toHaveBeenCalled()
})

it('keeps ordinal acknowledgement visible outside optional settings', () => {
  const { settings, run, choose, chooseVariables } = mount()
  chooseVariables(); choose('数値を選択', 'Ordered')
  expect(settings).not.toHaveAttribute('open')
  expect(run).toBeDisabled()
  const acknowledgement = screen.getByRole('checkbox', { name: /等間隔仮定/ })
  expect(acknowledgement.closest('label')).toBeVisible()
  expect(acknowledgement.closest('details')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('等間隔仮定を確認')
  fireEvent.click(acknowledgement)
  expect(run).toBeEnabled()
})

it('explains incompatible hidden covariance without silently changing weights', () => {
  const { settings, run, choose, chooseVariables } = mount()
  chooseVariables(); fireEvent.click(settings.querySelector('summary')!)
  choose('共分散', 'taylor')
  fireEvent.click(settings.querySelector('summary')!)
  expect(run).toBeDisabled()
  expect(screen.getByTestId('lr-settings-issues')).toHaveTextContent('データ設定の調査ウェイトが必要')
  expect(screen.getByTestId('lr-settings-issues')).toBeVisible()
  expect(lrApi.runLinearRegression).not.toHaveBeenCalled()
})
