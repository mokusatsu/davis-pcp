import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { store } from '../src/app/store'
import ColumnSelect from '../src/features/common/ColumnSelect'

const options = [
  { value: 'Q1', label: 'Q1', questionText: '普段の交通手段' },
  { value: 'Q2', label: 'Q2', questionText: '利用頻度' },
  { value: 'Q3', label: 'Q3', questionText: '利用時間' },
]
const state = store.getState()
const local = configureStore({ reducer: () => state })
function mount(children: ReactNode) {
  return render(children, { wrapper: ({ children }) => <Provider store={local}>{children}</Provider> })
}
function openPicker(title = '変数を選択') {
  fireEvent.click(screen.getByRole('button', { name: title }))
  return screen.getByRole('dialog', { name: title })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ColumnSelect accessible purpose and empty guidance', () => {
  it.each([undefined, 'multiple'])('uses the explicit role throughout the picker (mode=%s)', mode => {
    const { container } = mount(<ColumnSelect roleName="目的変数" aria-label="分析の目的変数" mode={mode} options={options} />)
    const opener = screen.getByRole('button', { name: '目的変数を選択' })
    expect(opener).toHaveAttribute('title', '目的変数を選択')
    expect(screen.getByRole('combobox', { name: '分析の目的変数' })).toBeInTheDocument()
    expect(container.querySelector('[rolename]')).toBeNull()
    const dialog = openPicker('目的変数を選択')
    const search = within(dialog).getByRole('textbox', { name: '目的変数を変数名・質問文で絞り込み' })
    const results = within(dialog).getByRole(mode ? 'group' : 'radiogroup', { name: '目的変数の検索結果' })
    fireEvent.change(search, { target: { value: '交通' } })
    expect(within(results).getAllByRole(mode ? 'checkbox' : 'radio')).toHaveLength(1)
    expect(within(results).getByText('普段の交通手段')).toBeInTheDocument()
  })

  it.each([undefined, '  '])('retains generic picker names without an explicit role (roleName=%s)', roleName => {
    mount(<ColumnSelect roleName={roleName} aria-label="既存の選択欄" options={options} />)
    const dialog = openPicker()
    expect(within(dialog).getByRole('textbox', { name: '変数名・質問文で絞り込み' })).toBeInTheDocument()
    expect(within(dialog).getByRole('radiogroup', { name: '検索結果' })).toBeInTheDocument()
  })

  it('keeps the existing empty hint text and codebook action for callers without custom guidance', () => {
    const openCodebook = vi.fn()
    mount(<ColumnSelect options={[]} emptyHint={{ roleLabel: 'カテゴリ', onOpenCodebook: openCodebook }} />)
    const dialog = openPicker()
    expect(dialog).toHaveTextContent('カテゴリ変数がありません')
    expect(dialog).toHaveTextContent('コードブックでカテゴリ変数を指定してください')
    fireEvent.click(within(dialog).getByRole('button', { name: 'コードブックを開く' }))
    expect(openCodebook).toHaveBeenCalledOnce()
    expect(dialog).not.toBeVisible()
  })

  it('uses the supplied eligibility reason and repair guidance in both the dropdown and dialog', () => {
    const openCodebook = vi.fn()
    const reason = '群分けに使用できる変数がありません'
    const guidance = '使用変数とコードブックの尺度を確認してください。ID・日付・MA列は対象外です'
    mount(<ColumnSelect roleName="群分け変数" options={[]} emptyHint={{ roleLabel: 'カテゴリ', reason, guidance, onOpenCodebook: openCodebook }} />)
    fireEvent.mouseDown(screen.getByRole('combobox'))
    expect(screen.getByText(reason, { exact: false })).toHaveTextContent(guidance)
    const dialog = openPicker('群分け変数を選択')
    const results = within(dialog).getByRole('radiogroup', { name: '群分け変数の検索結果' })
    expect(results).toHaveTextContent(reason)
    expect(results).toHaveTextContent(guidance)
    expect(results).not.toHaveTextContent('コードブックでカテゴリ変数を指定してください')
    fireEvent.click(within(results).getByRole('button', { name: 'コードブックを開く' }))
    expect(openCodebook).toHaveBeenCalledOnce()
    expect(dialog).not.toBeVisible()
  })

  it('offers search repair instead of codebook repair when eligible options exist but none match', () => {
    mount(<ColumnSelect roleName="説明変数" mode="multiple" options={options}
      emptyHint={{ roleLabel: '数値', reason: '数値の候補がありません', guidance: '尺度を確認してください', onOpenCodebook: vi.fn() }} />)
    const dialog = openPicker('説明変数を選択')
    const search = within(dialog).getByRole('textbox', { name: '説明変数を変数名・質問文で絞り込み' })
    const results = within(dialog).getByRole('group', { name: '説明変数の検索結果' })
    fireEvent.change(search, { target: { value: '存在しない質問' } })
    expect(results).toHaveTextContent('該当する変数がありません')
    expect(results).toHaveTextContent('検索条件を変更または解除してください')
    expect(within(results).queryByRole('button', { name: 'コードブックを開く' })).not.toBeInTheDocument()
    expect(results).not.toHaveTextContent('尺度を確認してください')
    fireEvent.change(search, { target: { value: '' } })
    expect(within(results).getAllByRole('checkbox')).toHaveLength(3)
  })

  it('retains disabled and maxCount protections with role-specific names', () => {
    const change = vi.fn()
    const props = { roleName: '説明変数', mode: 'multiple' as const, value: ['Q2'], maxCount: 2,
      options: [...options, { value: 'Q4', label: 'Q4', disabled: true }], onChange: change }
    const view = mount(<ColumnSelect {...props} />)
    const dialog = openPicker('説明変数を選択')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '交通' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '検索結果を全選択（1件）' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('2件選択中（検索結果外 1件） / 上限 2件')
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '' } })
    expect(within(dialog).getByRole('checkbox', { name: /Q3/ })).toBeDisabled()
    expect(within(dialog).getByRole('checkbox', { name: 'Q4' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: /決\s*定/ }))
    expect(change).toHaveBeenCalledWith(['Q2', 'Q1'], [props.options[1], props.options[0]])
    view.rerender(<ColumnSelect {...props} disabled />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '説明変数を選択' })).toBeDisabled()
  })

  it('disables custom repair actions if the caller becomes disabled while the dialog is open', () => {
    const openCodebook = vi.fn()
    const props = { roleName: '目的変数', options: [], emptyHint: { roleLabel: 'カテゴリ',
      reason: '目的変数の候補がありません', guidance: '使用変数と尺度を確認してください', onOpenCodebook: openCodebook } }
    const view = mount(<ColumnSelect {...props} />)
    const dialog = openPicker('目的変数を選択')
    view.rerender(<ColumnSelect {...props} disabled />)
    expect(within(dialog).getByRole('textbox')).toBeDisabled()
    const repair = within(dialog).getByRole('button', { name: 'コードブックを開く' })
    expect(repair).toBeDisabled()
    fireEvent.click(repair)
    expect(openCodebook).not.toHaveBeenCalled()
  })
})
