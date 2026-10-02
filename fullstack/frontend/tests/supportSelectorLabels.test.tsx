import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import type { CodebookColumn } from '../src/api/client'
import { store, weightColumnCleared, weightColumnSet, type RootState } from '../src/app/store'
import ImputationModal from '../src/features/dataset/ImputationModal'
import { GlobalHeaderControlBar } from '../src/features/selection/GlobalHeaderControlBar'

// Keep both callers, ColumnSelect, codebook lookup, and Ant Design controls real.
// The unrelated color controls do not need to fetch full-dataset domains.
vi.mock('../src/theme/useL1ColorDomain', () => ({ useDatasetL1ColorDomains: () => [] }))

function column(columnId: string, name: string, label = name,
  scaleType: CodebookColumn['scaleType'] = 'ratio', role: CodebookColumn['role'] = 'question',
  multiResponseGroup: string | null = null): CodebookColumn {
  return { columnId, name, label, scaleType, role, multiResponseGroup,
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false }
}

const columns = [
  column('target-id', 'Target'),
  column('numeric-same-id', 'Numeric'),
  column('numeric-question-id', 'Q_NUM', '週間の利用時間', 'interval'),
  column('weight-same-id', 'Weight', 'Weight', 'ratio', 'weight'),
  column('weight-question-id', 'Q_WEIGHT', '人口構成の補正係数', 'interval', 'weight'),
  column('category-id', 'Category', 'カテゴリ変数', 'nominal'),
  column('category-weight-id', 'CategoryWeight', '非数値ウェイト', 'nominal', 'weight'),
  column('ma-id', 'MA_NUM', '複数回答の数値列', 'ratio', 'question', 'ma-group'),
  column('ma-weight-id', 'MA_WEIGHT', '複数回答ウェイト', 'ratio', 'weight', 'ma-group'),
]

function mount(page: ReactElement) {
  const base = store.getState()
  const state: RootState = { ...base,
    selection: { ...base.selection, datasetId: 'support-selector-labels', dataRevision: 1 },
    globalVariables: { ...base.globalVariables, activeEntities: null, weightColumnId: null },
    codebook: { ...base.codebook, datasetId: 'support-selector-labels', schemaRevision: 1, columns, isLoading: false },
  }
  const local = configureStore({
    reducer: (s = state, action) => {
      if (weightColumnSet.match(action)) return { ...s,
        globalVariables: { ...s.globalVariables, weightColumnId: action.payload.columnId } }
      if (weightColumnCleared.match(action)) return { ...s,
        globalVariables: { ...s.globalVariables, weightColumnId: null } }
      return s
    },
    middleware: getDefaultMiddleware => getDefaultMiddleware({
      serializableCheck: { ignoredPaths: ['selection.activeRowIdSet'] },
    }),
  })
  const dispatch = vi.spyOn(local, 'dispatch')
  render(<Provider store={local}><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{page}</MemoryRouter></Provider>)
  return { local, dispatch }
}

async function openPicker(picker: HTMLElement) {
  fireEvent.click(within(picker).getByRole('button', { name: '変数を選択' }))
  const search = await screen.findByRole('textbox', { name: '変数名・質問文で絞り込み' })
  // Ant Design's test IDs repeat across nested modals, so locate this dialog
  // through its unique search control rather than its aria-labelledby target.
  const dialog = search.closest('[role="dialog"]') as HTMLElement
  const results = within(dialog).getByLabelText('検索結果')
  return { dialog, results, search }
}

function expectOption(results: HTMLElement, name: string, question?: string) {
  const primary = within(results).getByText(name, { exact: true })
  const label = primary.closest('label')!
  expect(label.textContent).toBe(`${name}${question ?? ''}`)
  expect(label.querySelector('small')?.textContent).toBe(question)
  return label
}

function selectedText(element: Element) {
  const label = element.cloneNode(true) as Element
  label.querySelectorAll('[data-column-question]').forEach(control => control.remove())
  return label.textContent
}

async function commit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('imputation predictor selector labels', () => {
  it.each([
    { name: 'Numeric', question: undefined, queries: ['Numeric'] },
    { name: 'Q_NUM', question: '週間の利用時間', queries: ['Q_NUM', '利用時間'] },
  ])('shows $name once with a separate distinct question in search and committed tags', async ({ name, question, queries }) => {
    mount(<ImputationModal open datasetId="support-selector-labels"
      columnsWithMissing={[{ name: 'Target', missing: 1, total: 10 }]}
      onClose={vi.fn()} onSuccess={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: '個別に指定' }))
    const picker = screen.getByTestId('impute-predictors').closest('.column-select-multi-wrap') as HTMLElement
    const { dialog, results, search } = await openPicker(picker)
    // Preserve exclusion of targets, categorical variables, MA children, and weights.
    expect(within(results).getAllByRole('checkbox')).toHaveLength(2)
    expectOption(results, 'Numeric')
    expectOption(results, 'Q_NUM', '週間の利用時間')
    for (const query of queries) {
      fireEvent.change(search, { target: { value: query } })
      expect(within(results).getAllByRole('checkbox')).toHaveLength(1)
      expectOption(results, name, question)
    }
    fireEvent.click(within(results).getByRole('checkbox'))
    await commit(dialog)
    expect(Array.from(picker.querySelectorAll('.ant-tag'), selectedText))
      .toEqual([question ? `${name} — ${question}` : name])
    expect(within(picker).getByRole('button', { name: `${name}の設問文を表示` })).toBeInTheDocument()
  })
})

describe('global weight selector labels', () => {
  it.each([
    { name: 'Weight', question: undefined, id: 'weight-same-id', queries: ['Weight', 'weight-same-id'] },
    { name: 'Q_WEIGHT', question: '人口構成の補正係数', id: 'weight-question-id', queries: ['Q_WEIGHT', '補正係数', 'weight-question-id'] },
  ])('shows $name once with a separate distinct question in search and committed values', async ({ name, question, id, queries }) => {
    const { local, dispatch } = mount(<GlobalHeaderControlBar />)
    const picker = screen.getByTestId('global-weight-select').closest('.column-select-multi-wrap') as HTMLElement
    const { dialog, results, search } = await openPicker(picker)
    // Only numeric, non-MA weight columns remain eligible.
    expect(within(results).getAllByRole('radio')).toHaveLength(2)
    expectOption(results, 'Weight')
    expectOption(results, 'Q_WEIGHT', '人口構成の補正係数')
    for (const query of queries) {
      fireEvent.change(search, { target: { value: query } })
      // A name substring may also match another weight; its exact name must stay visible.
      expectOption(results, name, question)
      if (query !== 'Weight') expect(within(results).getAllByRole('radio')).toHaveLength(1)
    }
    fireEvent.click(expectOption(results, name, question))
    await commit(dialog)
    expect(Array.from(picker.querySelectorAll('.ant-select-selection-item'), selectedText))
      .toEqual([question ? `${name} — ${question}` : name])
    expect(local.getState().globalVariables.weightColumnId).toBe(id)
    expect(dispatch).toHaveBeenCalledWith(weightColumnSet({ columnId: id, datasetId: 'support-selector-labels' }))
  })
})
