import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import ConjointPage from '../src/features/models/ConjointPage'
import * as conjoint from '../src/features/models/conjointApi'
vi.mock('../src/features/common/ColumnSelect', () => ({ default: (props: any) => <select id={props.id} aria-label={props.placeholder} multiple={props.mode === 'multiple'} value={props.value ?? (props.mode === 'multiple' ? [] : '')} disabled={props.disabled}
  onChange={event => props.onChange(props.mode === 'multiple' ? [...event.target.selectedOptions].map(option => option.value) : event.target.value)}>
  <option value="">選択</option>{props.options?.map((option: any) => <option key={option.value} value={option.value}>{option.label}</option>)}
</select> }))
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#123456' }) }))
vi.mock('../src/features/models/ConjointFigure', () => ({ default: () => null }))
function mount() {
  const base = store.getState()
  const columns = ['respondent', 'task', 'alternative', 'response', 'brand', 'price'].map(name => ({ columnId: name, name, label: name, scaleType: name === 'brand' ? 'nominal' : 'ratio', role: 'question', multiResponseGroup: null, categoryOrder: name === 'brand' ? ['a', 'b'] : [] }))
  const state = { ...base, selection: { ...base.selection, datasetId: 'd', dataRevision: 1, allRowIds: ['r1', 'r2'], activeRowIds: ['r1', 'r2'] }, codebook: { ...base.codebook, datasetId: 'd', schemaRevision: 1, columns, isLoading: false } }
  return render(<Provider store={configureStore({ reducer: (s = state) => s })}><ConjointPage /></Provider>)
}
function choose(id: string, value: string) { fireEvent.change(screen.getByTestId(id).querySelector('select')!, { target: { value } }) }
function chooseMultiple(id: string, value: string) {
  const select = screen.getByTestId(id).querySelector('select')!
  for (const option of select.options) option.selected = option.value === value
  fireEvent.change(select)
}
function ready() {
  for (const [id, value] of [['cj-respondent-col', 'respondent'], ['cj-task-col', 'task'], ['cj-alt-col', 'alternative'], ['cj-response-col', 'response']]) choose(id, value)
  chooseMultiple('cj-cat-attrs', 'brand')
}
beforeEach(() => { vi.spyOn(conjoint, 'runConjoint').mockRejectedValue(new Error('test response')) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('keeps required roles visible and optional settings closed; sends unchanged defaults', async () => {
  const view = mount()
  expect([...view.container.querySelectorAll('details')].every(panel => !panel.open)).toBe(true)
  expect(screen.getByText('回答者ID列を選択してください。')).toBeVisible()
  expect(screen.getByTestId('cj-run')).toBeDisabled()
  ready()
  expect(screen.getByTestId('cj-run')).toBeEnabled()
  fireEvent.click(screen.getByTestId('cj-run'))
  await waitFor(() => expect(conjoint.runConjoint).toHaveBeenCalled())
  expect(vi.mocked(conjoint.runConjoint).mock.calls[0]).toEqual([
    expect.objectContaining({ datasetId: 'd', weightMode: 'dataset', missingPolicy: 'exclude' }), 'choice',
    { respondentId: 'respondent', taskId: 'task', alternativeId: 'alternative', response: 'response' },
    [{ columnId: 'brand', kind: 'categorical', referenceLevel: null }], 'pooled', null,
  ])
  expect(screen.getByTestId('cj-run').closest('.analysis-run-row')).toBeTruthy()
})
it('explains duplicate roles and surfaces incomplete optional ranges when collapsed', () => {
  mount(); ready()
  choose('cj-task-col', 'respondent')
  expect(screen.getByTestId('cj-run')).toBeDisabled()
  expect(screen.getByText('回答者ID・タスク・代替案・応答にはそれぞれ別の列を指定してください。')).toBeVisible()
  choose('cj-task-col', 'task'); chooseMultiple('cj-lin-attrs', 'price')
  const low = screen.getByLabelText('price (price) の効用範囲 下限')
  fireEvent.change(low, { target: { value: '1' } }); fireEvent.blur(low)
  const details = low.closest('details')!
  expect(details.open).toBe(true)
  details.open = false
  expect(screen.getByTestId('cj-run')).toBeDisabled()
  expect(screen.getByText(/「モデルの詳細設定」の効用範囲を確認/)).toBeVisible()
  expect(details.querySelector('summary')).toHaveTextContent('設定を確認してください')
})
