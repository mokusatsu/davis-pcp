import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import type { ReactElement } from 'react'
import type { CodebookColumn } from '../src/api/client'
import { store } from '../src/app/store'
import MultipleCorrespondencePage from '../src/features/models/MultipleCorrespondencePage'
import RegularizedRegressionPanel from '../src/features/models/RegularizedRegressionPanel'

// Keep both pages, ColumnSelect, codebook lookup, and Ant Design controls real.
// Selector rendering does not need plot data or a backend request.
vi.mock('../src/theme/useRowColor', () => ({ useRowColorResolver: () => ({ getColor: () => '#1890ff' }) }))

function column(columnId: string, name: string, label = name,
  scaleType: CodebookColumn['scaleType'] = 'nominal', multiResponseGroup: string | null = null): CodebookColumn {
  return { columnId, name, label, scaleType, multiResponseGroup, role: 'question',
    valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {}, isReversed: false }
}

function mount(page: ReactElement, columns: CodebookColumn[]) {
  const base = store.getState()
  const state = { ...base,
    selection: { ...base.selection, datasetId: 'selector-labels', dataRevision: 1 },
    globalVariables: { ...base.globalVariables, activeEntities: null },
    codebook: { ...base.codebook, datasetId: 'selector-labels', schemaRevision: 1, columns, isLoading: false },
  }
  const local = configureStore({ reducer: (s = state) => s })
  return render(<Provider store={local}>{page}</Provider>)
}

async function openPicker(roleName: string) {
  fireEvent.click(screen.getByRole('button', { name: `${roleName}を選択` }))
  const dialog = await screen.findByRole('dialog', { name: `${roleName}を選択` })
  const results = within(dialog).getByLabelText(`${roleName}の検索結果`)
  return { dialog, results, search: within(dialog).getByRole('textbox', { name: `${roleName}を変数名・質問文で絞り込み` }) }
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
  // The adjacent information control is not part of the variable label.
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

describe('MCA variable selector labels', () => {
  const columns = [
    column('species-id', 'species'),
    column('bin-id', 'sepal_length_cm_bin4'),
    column('question-id', 'Q1', '普段の交通手段を教えてください'),
    column('ma-same-id', 'MA1', 'MA1', 'nominal', 'ma-group'),
    column('ma-question-id', 'MA2', '利用しているサービス', 'nominal', 'ma-group'),
  ]

  it('shows identical names once in search results and selected tags', async () => {
    const { container } = mount(<MultipleCorrespondencePage />, columns)
    const { dialog, results } = await openPicker('MCAの分析変数')
    fireEvent.click(expectOption(results, 'species'))
    fireEvent.click(expectOption(results, 'sepal_length_cm_bin4'))
    await commit(dialog)
    expect(Array.from(container.querySelectorAll('.ant-tag'), selectedText))
      .toEqual(['species', 'sepal_length_cm_bin4'])
    expect(screen.getByTestId('mca-run')).not.toBeDisabled()
  })

  it('keeps distinct variable codes and questions searchable and visible without precomposing labels', async () => {
    const { container } = mount(<MultipleCorrespondencePage />, columns)
    const { dialog, results, search } = await openPicker('MCAの分析変数')
    const question = '普段の交通手段を教えてください'
    expectOption(results, 'Q1', question)
    for (const query of ['Q1', '交通手段', 'question-id']) {
      fireEvent.change(search, { target: { value: query } })
      expect(within(results).getAllByRole('checkbox')).toHaveLength(1)
      expectOption(results, 'Q1', question)
    }
    fireEvent.click(within(results).getByRole('checkbox'))
    await commit(dialog)
    expect(selectedText(container.querySelector('.ant-tag')!)).toBe(`Q1 — ${question}`)
    expect(screen.getByRole('button', { name: 'Q1の設問文を表示' })).toBeInTheDocument()
  })

  it('preserves MA annotations while showing the variable name first and a distinct question separately', async () => {
    const { container } = mount(<MultipleCorrespondencePage />, columns)
    fireEvent.click(screen.getByRole('radio', { name: 'MA子を含める' }))
    const { dialog, results, search } = await openPicker('MCAのMA子変数')
    expectOption(results, 'MA1 [MA]')
    expectOption(results, 'MA2 [MA]', '利用しているサービス')
    for (const query of ['MA2', 'サービス', 'ma-question-id']) {
      fireEvent.change(search, { target: { value: query } })
      expect(within(results).getAllByRole('checkbox')).toHaveLength(1)
      expectOption(results, 'MA2 [MA]', '利用しているサービス')
    }
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(expectOption(results, 'MA1 [MA]'))
    fireEvent.click(expectOption(results, 'MA2 [MA]', '利用しているサービス'))
    await commit(dialog)
    const maPicker = container.querySelectorAll('.column-select-multi-wrap')[1]
    expect(Array.from(maPicker.querySelectorAll('.ant-tag'), selectedText))
      .toEqual(['MA1 [MA]', 'MA2 [MA] — 利用しているサービス'])
  })
})

describe('regularized regression variable selector labels', () => {
  const columns = [
    column('outcome-id', 'Outcome', 'Outcome', 'ratio'),
    column('numeric-question-id', 'Q_NUM', '週間の利用時間', 'ratio'),
    column('group-id', 'Group'),
    column('category-question-id', 'Q_CAT', 'よく利用する店舗'),
  ]

  it.each([
    { index: 0, roleName: '正則化の目的変数', role: 'radio', same: 'Outcome', name: 'Q_NUM', question: '週間の利用時間', id: 'numeric-question-id' },
    { index: 1, roleName: '正則化の数値説明変数', role: 'checkbox', same: 'Outcome', name: 'Q_NUM', question: '週間の利用時間', id: 'numeric-question-id' },
    { index: 2, roleName: '正則化のカテゴリ説明変数', role: 'checkbox', same: 'Group', name: 'Q_CAT', question: 'よく利用する店舗', id: 'category-question-id' },
  ])('keeps names and questions distinct in picker $index search and committed values', async ({ index, roleName, role, same, name, question, id }) => {
    const { container } = mount(<RegularizedRegressionPanel />, columns)
    const { dialog, results, search } = await openPicker(roleName)
    fireEvent.click(expectOption(results, same))
    await commit(dialog)
    const picker = container.querySelectorAll('.column-select-multi-wrap')[index]
    const selection = () => role === 'checkbox' ? Array.from(picker.querySelectorAll('.ant-tag'), selectedText)
      : Array.from(picker.querySelectorAll('.ant-select-selection-item'), selectedText)
    expect(selection()).toEqual([same])

    fireEvent.click(within(picker as HTMLElement).getByRole('button', { name: `${roleName}を選択` }))
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
  })
})
