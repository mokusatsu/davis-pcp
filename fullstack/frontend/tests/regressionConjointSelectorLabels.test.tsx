import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import type { ReactElement } from 'react'
import type { CodebookColumn } from '../src/api/client'
import { store } from '../src/app/store'
import LinearRegressionPage from '../src/features/models/LinearRegressionPage'
import ConjointPage from '../src/features/models/ConjointPage'

// Exercise the actual callers, shared ColumnSelect, codebook lookup, and Ant Design
// controls. Opening and committing variable pickers does not need plot data.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))

function column(columnId: string, name: string, label = name,
  scaleType: CodebookColumn['scaleType'] = 'nominal', multiResponseGroup: string | null = null): CodebookColumn {
  return { columnId, name, label, scaleType, multiResponseGroup, role: 'question',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false }
}

const columns = [
  column('outcome-id', 'Outcome', 'Outcome', 'ratio'),
  column('numeric-question-id', 'Q_NUM', '週間の利用時間', 'ratio'),
  column('group-id', 'Group'),
  column('category-question-id', 'Q_CAT', 'よく利用する店舗'),
  column('rank-id', 'Rank', 'Rank', 'ordinal'),
  column('ma-id', 'MA1', '複数回答の選択肢', 'nominal', 'ma-group'),
]

function mount(page: ReactElement) {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'regression-conjoint-labels', dataRevision: 1 },
    globalVariables: { ...base.globalVariables, activeEntities: null },
    codebook: { ...base.codebook, datasetId: 'regression-conjoint-labels', schemaRevision: 1, columns, isLoading: false },
  }
  const local = configureStore({ reducer: (s = state) => s })
  return render(<Provider store={local}>{page}</Provider>)
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
  // Ignore the adjacent information control when checking the variable label.
  label.querySelectorAll('[data-column-question]').forEach(control => control.remove())
  return label.textContent
}

async function commit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}

type PickerCase = {
  group: string
  role: 'radio' | 'checkbox'
  same: string
  name: string
  question: string
  id: string
  eligible: string[]
}

async function verifyPicker(picker: HTMLElement, { role, same, name, question, id, eligible }: PickerCase) {
  fireEvent.click(within(picker).getByRole('button', { name: '変数を選択' }))
  const dialog = await screen.findByRole('dialog', { name: '変数を選択' })
  const results = within(dialog).getByLabelText('検索結果')
  const search = within(dialog).getByRole('textbox', { name: '変数名・質問文で絞り込み' })
  expect(within(results).getAllByRole(role)).toHaveLength(eligible.length)
  for (const option of columns.filter(c => eligible.includes(c.name))) {
    expectOption(results, option.name, option.label === option.name ? undefined : option.label)
  }
  fireEvent.change(search, { target: { value: same } })
  expect(within(results).getAllByRole(role)).toHaveLength(1)
  fireEvent.click(expectOption(results, same))
  await commit(dialog)
  const selection = () => Array.from(picker.querySelectorAll(
    role === 'checkbox' ? '.ant-tag' : '.ant-select-selection-item'), selectedText)
  expect(selection()).toEqual([same])

  fireEvent.click(within(picker).getByRole('button', { name: '変数を選択' }))
  await waitFor(() => expect(dialog).toBeVisible())
  expectOption(results, name, question)
  for (const query of [name, question, id]) {
    fireEvent.change(search, { target: { value: query } })
    expect(within(results).getAllByRole(role)).toHaveLength(1)
    expectOption(results, name, question)
  }
  fireEvent.click(within(results).getByRole(role))
  await commit(dialog)
  expect(selection()).toEqual(role === 'checkbox' ? [same, `${name} — ${question}`] : [`${name} — ${question}`])
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ordinary regression variable selector labels', () => {
  it.each<PickerCase & { index: number }>([
    { group: 'target', index: 0, role: 'radio', same: 'Outcome', name: 'Q_NUM', question: '週間の利用時間', id: 'numeric-question-id', eligible: ['Outcome', 'Q_NUM'] },
    { group: 'numeric', index: 1, role: 'checkbox', same: 'Outcome', name: 'Q_NUM', question: '週間の利用時間', id: 'numeric-question-id', eligible: ['Outcome', 'Q_NUM', 'Rank'] },
    { group: 'categorical', index: 2, role: 'checkbox', same: 'Group', name: 'Q_CAT', question: 'よく利用する店舗', id: 'category-question-id', eligible: ['Group', 'Q_CAT', 'Rank'] },
  ])('keeps $group names and questions distinct in search and committed values', async testCase => {
    const { container } = mount(<LinearRegressionPage />)
    const picker = container.querySelectorAll<HTMLElement>('.column-select-multi-wrap')[testCase.index]
    await verifyPicker(picker, testCase)
  })
})

describe('conjoint variable selector labels', () => {
  it.each<PickerCase & { testId: string }>([
    { group: 'identifier', testId: 'cj-respondent-col', role: 'radio', same: 'Group', name: 'Q_CAT', question: 'よく利用する店舗', id: 'category-question-id', eligible: ['Outcome', 'Q_NUM', 'Group', 'Q_CAT', 'Rank'] },
    { group: 'categorical', testId: 'cj-cat-attrs', role: 'checkbox', same: 'Group', name: 'Q_CAT', question: 'よく利用する店舗', id: 'category-question-id', eligible: ['Group', 'Q_CAT', 'Rank'] },
    { group: 'linear', testId: 'cj-lin-attrs', role: 'checkbox', same: 'Outcome', name: 'Q_NUM', question: '週間の利用時間', id: 'numeric-question-id', eligible: ['Outcome', 'Q_NUM'] },
  ])('keeps $group names and questions distinct in search and committed values', async testCase => {
    mount(<ConjointPage />)
    await verifyPicker(screen.getByTestId(testCase.testId), testCase)
  })
})
