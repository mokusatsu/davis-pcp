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
  it('keeps native radio selection independent across retained picker dialogs', () => {
    const rowChange = vi.fn()
    const columnChange = vi.fn()
    const variables = [{ value: 'SEX', label: 'SEX' }, { value: 'AGEID', label: 'AGEID' }]
    mount(<>
      <ColumnSelect roleName="行変数" aria-label="行変数" options={variables} onChange={rowChange} />
      <ColumnSelect roleName="列変数" aria-label="列変数" options={variables} onChange={columnChange} />
    </>)
    const rowDialog = openPicker('行変数を選択')
    const rowRadio = within(rowDialog).getByRole('radio', { name: 'SEX' })
    const rowGroupName = rowRadio.getAttribute('name')
    expect(within(rowDialog).getByRole('radio', { name: 'AGEID' })).toHaveAttribute('name', rowGroupName)
    fireEvent.click(rowRadio)
    expect(rowRadio).toBeChecked()
    fireEvent.click(within(rowDialog).getByRole('button', { name: /決\s*定/ }))
    expect(rowChange).toHaveBeenCalledWith('SEX', variables[0])
    expect(rowDialog).not.toBeVisible()
    expect(rowRadio).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '列変数を選択' }))
    // rc-dialog uses the same title ID for every modal in its test environment.
    const columnDialog = screen.getByRole('dialog')
    expect(columnDialog).toHaveTextContent('列変数を選択')
    fireEvent.change(within(columnDialog).getByRole('textbox'), { target: { value: 'AGEID' } })
    const columnRadio = within(columnDialog).getByRole('radio', { name: 'AGEID' })
    fireEvent.click(columnRadio)
    expect(within(columnDialog).getByRole('status')).toHaveTextContent('1件選択中')
    expect(columnRadio).toBeChecked()
    expect(rowRadio).toBeChecked()
    expect(columnRadio).not.toHaveAttribute('name', rowGroupName)
    fireEvent.click(within(columnDialog).getByRole('button', { name: /決\s*定/ }))
    expect(columnChange).toHaveBeenCalledWith('AGEID', variables[1])
    expect(rowChange).toHaveBeenCalledOnce()

    const reopenedRow = openPicker('行変数を選択')
    expect(within(reopenedRow).getByRole('radio', { name: 'SEX' })).toBeChecked()
    expect(within(reopenedRow).getByRole('radio', { name: 'AGEID' })).not.toBeChecked()
    expect(within(reopenedRow).getByRole('radio', { name: 'SEX' })).toHaveAttribute('name', rowGroupName)
    expect(columnRadio).toBeChecked()
  })

  it.each([undefined, 'multiple'])('discards cancelled dialog edits without changing the committed selection (mode=%s)', mode => {
    const change = vi.fn()
    mount(<ColumnSelect mode={mode} defaultValue={mode ? ['Q1'] : 'Q1'} options={options} onChange={change} />)
    const role = mode ? 'checkbox' : 'radio'
    const dialog = openPicker()
    fireEvent.click(within(dialog).getByRole(role, { name: /Q2/ }))
    expect(within(dialog).getByRole(role, { name: /Q2/ })).toBeChecked()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(dialog).not.toBeVisible()
    expect(change).not.toHaveBeenCalled()

    const reopened = openPicker()
    expect(within(reopened).getByRole(role, { name: /Q1/ })).toBeChecked()
    expect(within(reopened).getByRole(role, { name: /Q2/ })).not.toBeChecked()
    expect(within(reopened).getByRole('status')).toHaveTextContent('1件選択中')
    fireEvent.click(within(reopened).getByRole(role, { name: /Q2/ }))
    fireEvent.click(within(reopened).getByRole('button', { name: /決\s*定/ }))
    expect(change).toHaveBeenCalledOnce()
    expect(change).toHaveBeenCalledWith(mode ? ['Q1', 'Q2'] : 'Q2', mode ? [options[0], options[1]] : options[1])
  })

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
