import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { MemoryRouter } from 'react-router-dom'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import PenaltyRewardPage from '../src/features/pra/PenaltyRewardPage'
import ColumnSelect from '../src/features/common/ColumnSelect'
import ImputationModal from '../src/features/dataset/ImputationModal'
import VariableSelectionModal from '../src/features/selection/VariableSelectionModal'
import GraphPanel from '../src/features/common/GraphPanel'
import { GraphExpansionProvider } from '../src/features/common/GraphExpansion'

const columns = [
  { columnId: 'a', name: 'alpha', label: '生活についての長い質問', scaleType: 'ratio', role: 'question' },
  { columnId: 'b', name: 'beta', label: 'beta', scaleType: 'ratio', role: 'question' },
  { columnId: 'c', name: 'gamma', label: 'gamma', scaleType: 'ratio', role: 'question' },
  { columnId: 'd', name: 'delta', label: 'delta', scaleType: 'ratio', role: 'question' },
]
const options = columns.map(c => ({ value: c.name, label: c.name }))
function localStore() {
  const base = store.getState()
  return configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd' },
    codebook: { ...base.codebook, datasetId: 'd', columns },
    globalVariables: { ...base.globalVariables, activeEntities: [{ kind: 'column', columnId: 'a' }] },
  }), middleware: g => g({ serializableCheck: false }) })
}
function mount(children: React.ReactNode) { return render(<Provider store={localStore()}><MemoryRouter>{children}</MemoryRouter></Provider>) }
function picker() { fireEvent.click(screen.getByRole('button', { name: '変数を選択' })); return screen.getByRole('dialog') }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('GUI audit variable picker contracts', () => {
  it('single picker commits exactly one option and cancels pending edits', async () => {
    const change = vi.fn()
    mount(<ColumnSelect options={options} value="alpha" onChange={change} />)
    let dialog = picker()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'beta' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'gamma' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '決 定' }))
    expect(change).toHaveBeenLastCalledWith('gamma', options[2])
    dialog = picker()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'beta' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(change).toHaveBeenCalledTimes(1)
  })
  it('disabled multi select disables input, clear, tags and picker', () => {
    const change = vi.fn()
    const { container } = mount(<ColumnSelect mode="multiple" value={['alpha']} options={options} disabled allowClear onChange={change} />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: '変数を選択' })).toBeDisabled()
    expect(container.querySelector('.ant-tag-close-icon')).toBeNull()
    expect(container.querySelector('.ant-select-clear')).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })
  it('forwards multi-select popup rendering and open callbacks once', async () => {
    const opened = vi.fn(), legacy = vi.fn()
    mount(<ColumnSelect mode="multiple" options={options} onOpenChange={opened} onDropdownVisibleChange={legacy} dropdownRender={menu => <>{menu}<span>カスタム内容</span></>} />)
    fireEvent.mouseDown(screen.getByRole('combobox'))
    await screen.findByText('カスタム内容')
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith(true)
    expect(legacy).toHaveBeenCalledTimes(1)
  })
  it('preserves annotations and shows question only once in each dialog item', () => {
    mount(<ColumnSelect mode="multiple" options={[{ ...options[0], label: 'alpha（数値型）' }, options[1]]} />)
    const dialog = picker()
    expect(within(dialog).getByRole('checkbox', { name: /alpha（数値型）/ }).closest('label')).toHaveTextContent('生活についての長い質問')
    expect(within(dialog).getAllByText('生活についての長い質問')).toHaveLength(1)
    expect(within(dialog).getByRole('checkbox', { name: 'beta' }).closest('label')?.textContent).toBe('beta')
  })
  it('filtered bulk actions preserve hidden selections and disabled options', () => {
    const change = vi.fn()
    mount(<ColumnSelect mode="multiple" value={['beta', 'delta']} options={options.map(o => ({ ...o, disabled: o.value === 'delta' }))} onChange={change} />)
    const dialog = picker()
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '生活' } })
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(within(dialog).getByRole('button', { name: '検索結果を全選択（1件）' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('3件選択中（検索結果外 2件）')
    fireEvent.click(within(dialog).getByRole('button', { name: '検索結果を全解除' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '決 定' }))
    expect(change.mock.calls[0][0]).toEqual(['beta', 'delta'])
  })
  it('enforces maxCount through search and bulk selection without replacing hidden values', () => {
    const change = vi.fn()
    mount(<ColumnSelect mode="multiple" value={['beta']} maxCount={2} options={options} onChange={change} />)
    const dialog = picker()
    fireEvent.click(within(dialog).getByRole('button', { name: '検索結果を全選択（4件）' }))
    expect(within(dialog).getByRole('checkbox', { name: 'gamma' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: '決 定' }))
    expect(change.mock.calls[0][0]).toEqual(['beta', 'alpha'])
  })
  it('puts flex and width constraints on the complete field', () => {
    const { container } = mount(<ColumnSelect options={options} style={{ width: 300, minWidth: 80, maxWidth: '100%', flex: '1 1 200px' }} />)
    expect(container.querySelector('.column-select-multi-wrap')).toHaveStyle({ width: '300px', minWidth: '80px', maxWidth: '100%', flex: '1 1 200px' })
    expect(container.querySelector('.ant-select')).toHaveStyle({ minWidth: '0' })
  })
})

it('S07 imputation target search matches question text and only changes visible targets', () => {
  const close = vi.fn()
  mount(<ImputationModal open datasetId="d" columnsWithMissing={columns.map(c => ({ name: c.name, missing: 2, total: 10 }))} onClose={close} onSuccess={() => {}} />)
  fireEvent.change(screen.getByRole('textbox', { name: '補完対象を変数名・質問文で検索' }), { target: { value: '生活' } })
  const group = screen.getByRole('group', { name: '補完対象の検索結果' })
  expect(within(group).getAllByRole('checkbox')).toHaveLength(1)
  expect(group).toHaveTextContent('欠損 2 (20.0%)')
  fireEvent.click(screen.getByRole('button', { name: '検索結果を全解除' }))
  expect(screen.getByRole('status')).toHaveTextContent('3件選択中（検索結果外 3件）')
  expect(within(group).getByRole('checkbox')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '検索結果を全選択（1件）' }))
  expect(within(group).getByRole('checkbox')).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(close).toHaveBeenCalledOnce()
})

it('I13 variable manager supports row traversal, selection, transfer and reorder from keyboard', () => {
  mount(<VariableSelectionModal open onClose={() => {}} />)
  const available = screen.getByRole('listbox', { name: '利用可能変数' })
  const first = within(available).getAllByRole('option')[0]
  act(() => first.focus())
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  const second = within(available).getAllByRole('option')[1]
  expect(second).toHaveFocus()
  fireEvent.keyDown(second, { key: ' ' })
  expect(second).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('button', { name: '選択に追加' }))
  const active = screen.getByRole('listbox', { name: '選択・表示変数' })
  const last = within(active).getAllByRole('option').at(-1)!
  fireEvent.keyDown(last, { key: 'Enter' })
  expect(screen.getByRole('button', { name: '上へ' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '上へ' }))
  expect(within(active).getAllByRole('option')[0]).toHaveTextContent('gamma')
  expect(screen.getByRole('button', { name: '選択から除外' })).toBeEnabled()
})

it('I06 keyboard zoom keeps the activated control focused and closing returns to the origin', async () => {
  mount(<GraphExpansionProvider><GraphPanel graphId="audit/zoom" title="テスト図" sizing="intrinsic" intrinsicSize={{ width: 320, height: 200 }}><svg /></GraphPanel></GraphExpansionProvider>)
  const origin = screen.getByTestId('graph-expand-audit/zoom')
  fireEvent.click(origin)
  const zoom = screen.getByRole('button', { name: '拡大' })
  act(() => zoom.focus())
  fireEvent.click(zoom)
  expect(zoom).toHaveFocus()
  fireEvent.click(zoom)
  expect(zoom).toHaveFocus()
  const exit = screen.getByTestId('graph-expansion-exit')
  fireEvent.click(exit)
  await waitFor(() => expect(screen.getByTestId('graph-expand-audit/zoom')).toHaveFocus())
})

it('L02 penalty actions wrap within their card and long execution text can grow vertically', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ schema: columns.map(c => ({ name: c.name, semanticType: 'numeric' })) })
  vi.spyOn(api, 'post').mockResolvedValue({
    run_id: 'test', outcome: { name: 'delta', label: 'delta', type: 'numeric' }, scale: { min: 1, max: 5, neutral: 3 },
    model: { r_squared: .5, n_valid: 4, alpha: .05, asymmetry_alpha: .15, warnings: [] },
    attributes: [{ name: 'alpha', label: '長い属性名'.repeat(20), penalty: { coef: -.5, se: .1, p: .01, ci: [-.7, -.3] }, reward: { coef: .2, se: .1, p: .2, ci: [0, .4] },
      asymmetry: -.3, asym_p: .07, asymmetry_significant: true, classification: 'basic', class_label: '当たり前品質', n_dissatisfied: 2, dissatisfied_row_ids: ['r1', 'r2'], narrative: '説明' }],
    all_basic_dissatisfied_row_ids: ['r1', 'r2'],
  })
  const state = localStore().getState()
  const local = configureStore({ reducer: () => ({ ...state, globalVariables: { ...state.globalVariables, activeEntities: columns.map(c => ({ kind: 'column', columnId: c.columnId })) } }) })
  render(<Provider store={local}><MemoryRouter><PenaltyRewardPage /></MemoryRouter></Provider>)
  await waitFor(() => expect(screen.getByTestId('pra-outcome-select')).toHaveTextContent('delta'))
  const run = screen.getByTestId('pra-run-btn')
  expect(run).toHaveStyle({ height: 'auto', whiteSpace: 'normal' })
  fireEvent.click(run)
  const action = await screen.findByTestId('select-dissatisfied-pcp')
  expect(action.parentElement).toHaveStyle({ flexWrap: 'wrap', minWidth: '0' })
  expect(action).toHaveStyle({ maxWidth: '100%', height: 'auto', whiteSpace: 'normal' })
  expect(screen.getByRole('button', { name: /選択してPCPへ移動/ })).toBeInTheDocument()
})
