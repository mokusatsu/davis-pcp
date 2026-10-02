import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { api, type CodebookColumn } from '../src/api/client'
import { store } from '../src/app/store'
import { codebookSlice } from '../src/features/dataset/codebookSlice'
import CorrespondenceAnalysisPage from '../src/features/models/CorrespondenceAnalysisPage'
import FamdPage from '../src/features/models/FamdPage'
import CrosstabPage from '../src/features/crosstab/CrosstabPage'

// Keep the real pages, codebook, and ColumnSelect controls. Plot data is unrelated.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))

function column(name: string, label = name, scaleType: CodebookColumn['scaleType'] = 'nominal',
  role: CodebookColumn['role'] = 'question'): CodebookColumn {
  return { columnId: `${name}-id`, name, label, scaleType, role, multiResponseGroup: null,
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false }
}
const columns = [
  column('Category'), column('Q_CAT', 'いつも利用する店舗'),
  column('Numeric', 'Numeric', 'ratio'), column('Q_NUM', '週間の利用時間', 'ratio'),
  column('Weight', 'Weight', 'ratio', 'weight'), column('Q_WEIGHT', '集計用の重み', 'ratio', 'weight'),
]

function mount(page: ReactElement) {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'selector-labels', dataRevision: 1 },
    globalVariables: { ...base.globalVariables, activeEntities: null },
    codebook: { ...base.codebook, datasetId: 'selector-labels', schemaRevision: 1, columns, isLoading: false,
      weightConfig: { weightColumnId: 'Weight-id', weightType: 'survey' as const },
      surveyDesign: { weightColumnId: 'Weight-id' },
    },
  }
  const local = configureStore({
    reducer: (s = state, action) => ({ ...s, codebook: codebookSlice.reducer(s.codebook, action) }),
    middleware: get => get({ serializableCheck: false }),
  })
  return render(<Provider store={local}><MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{page}</MemoryRouter></Provider>)
}

async function openPicker(index: number) {
  fireEvent.click(screen.getAllByRole('button', { name: '変数を選択' })[index])
  const dialog = await screen.findByRole('dialog', { name: '変数を選択' })
  return { dialog, results: within(dialog).getByLabelText('検索結果'),
    search: within(dialog).getByRole('textbox', { name: '変数名・質問文で絞り込み' }) }
}

function expectOption(results: HTMLElement, name: string, question?: string) {
  const label = within(results).getByText(name, { exact: true }).closest('label')!
  expect(label.textContent).toBe(`${name}${question ?? ''}`)
  expect(label.querySelector('small')?.textContent).toBe(question)
  return label
}

async function commit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
  await waitFor(() => expect(dialog).not.toBeVisible())
}

function selectedText(element: Element) {
  const label = element.cloneNode(true) as Element
  label.querySelectorAll('[data-column-question]').forEach(control => control.remove())
  return label.textContent
}

async function expectLabels(container: HTMLElement, index: number, multiple: boolean,
  same: string, name: string, question: string) {
  const first = await openPicker(index)
  fireEvent.click(expectOption(first.results, same))
  await commit(first.dialog)
  const picker = container.querySelectorAll('.column-select-multi-wrap')[index]
  const selected = () => Array.from(picker.querySelectorAll(multiple ? '.ant-tag' : '.ant-select-selection-item'), selectedText)
  await waitFor(() => expect(selected()).toEqual([same]))

  const { dialog, results, search } = await openPicker(index)
  expectOption(results, name, question)
  for (const query of [name, question]) {
    fireEvent.change(search, { target: { value: query } })
    expect(within(results).getAllByRole(multiple ? 'checkbox' : 'radio')).toHaveLength(1)
    expectOption(results, name, question)
  }
  fireEvent.click(within(results).getByRole(multiple ? 'checkbox' : 'radio'))
  await commit(dialog)
  await waitFor(() => expect(selected()).toEqual(multiple ? [same, `${name} — ${question}`] : [`${name} — ${question}`]))
}

const computedStyle = window.getComputedStyle.bind(window)
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => computedStyle(element))
  // Survey-design selectors persist through the real thunk/reducer; echo the saved fields.
  vi.spyOn(api, 'put').mockImplementation(async (_path, body) => ({
    status: 'ok', datasetId: 'selector-labels', schemaRevision: 2, updatedColumns: 0,
    codebook: { ...(body as object), columns },
  }) as any)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CA selector labels', () => {
  it.each([
    { label: 'respondent row', index: 0, contingency: false, multiple: false, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
    { label: 'respondent column', index: 1, contingency: false, multiple: false, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
    { label: 'contingency row label', index: 0, contingency: true, multiple: false, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
    { label: 'contingency cells', index: 1, contingency: true, multiple: true, same: 'Numeric', name: 'Q_NUM', question: '週間の利用時間' },
  ])('keeps $label names and questions distinct in search and selection', async ({ index, contingency, multiple, same, name, question }) => {
    const { container } = mount(<CorrespondenceAnalysisPage />)
    if (contingency) fireEvent.click(screen.getByRole('radio', { name: '分割表' }))
    await expectLabels(container, index, multiple, same, name, question)
  })
})

describe('FAMD selector labels', () => {
  it.each([
    { label: 'numeric', index: 0, same: 'Numeric', name: 'Q_NUM', question: '週間の利用時間' },
    { label: 'categorical', index: 1, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
  ])('keeps $label names and questions distinct in search and tags', async ({ index, same, name, question }) => {
    const { container } = mount(<FamdPage />)
    await expectLabels(container, index, true, same, name, question)
  })
})

describe('crosstab selector labels', () => {
  it.each([
    { label: 'row', index: 0, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
    { label: 'column', index: 1, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
    { label: 'weight', index: 2, same: 'Weight', name: 'Q_WEIGHT', question: '集計用の重み' },
    { label: 'strata design', index: 3, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
    { label: 'PSU design', index: 4, same: 'Category', name: 'Q_CAT', question: 'いつも利用する店舗' },
  ])('keeps $label names and questions distinct in search and selection', async ({ index, same, name, question }) => {
    const { container } = mount(<CrosstabPage />)
    if (index >= 3) {
      const { dialog, results } = await openPicker(2)
      fireEvent.click(expectOption(results, 'Weight'))
      await commit(dialog)
    }
    await expectLabels(container, index, false, same, name, question)
  })
})
