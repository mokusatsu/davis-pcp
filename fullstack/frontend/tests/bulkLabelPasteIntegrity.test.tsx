import { useState } from 'react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, type CodebookColumn } from '../src/api/client'
import { datasetLoaded, selectionReducer } from '../src/app/store'
import {
  bulkLabelsApplied, codebookReceived, codebookSlice, draftReverted,
} from '../src/features/dataset/codebookSlice'
import BulkLabelPasteModal from '../src/features/dataset/BulkLabelPasteModal'

const columns: CodebookColumn[] = [
  { columnId: 'sex-id', name: 'SEX', label: '性別', role: 'attribute' },
  { columnId: 'sq4-id', name: 'SQ4', label: '混雑度', role: 'question' },
  { columnId: 'sq5-id', name: 'SQ5', label: '頻度', role: 'question' },
].map(column => ({
  ...column, scaleType: 'nominal', valueLabels: {}, categoryOrder: [], missingCodes: [],
  missingReasons: {}, isReversed: false, multiResponseGroup: null,
} as CodebookColumn))
const dialogTitle = '質問文（ラベル）の一括貼り付け'

function mountBulk(inputColumns = columns) {
  const local = configureStore({
    reducer: { selection: selectionReducer, codebook: codebookSlice.reducer },
    middleware: getDefault => getDefault({ serializableCheck: false }),
  })
  local.dispatch(datasetLoaded({ datasetId: 'labels', name: 'Labels', rowIds: ['r1'], dataRevision: 2 }))
  local.dispatch(codebookReceived({ datasetId: 'labels', schemaRevision: 2, columns: inputColumns }))
  const onApply = vi.fn((updates: { columnId: string; label: string }[]) => {
    local.dispatch(bulkLabelsApplied(updates))
  })
  const onClose = vi.fn()
  const put = vi.spyOn(api, 'put')
  function Harness() {
    const [open, setOpen] = useState(true)
    return <Provider store={local}>
      <button onClick={() => setOpen(true)}>貼り付けを再開</button>
      <BulkLabelPasteModal open={open} columns={inputColumns} onApply={onApply}
        onClose={() => { onClose(); setOpen(false) }} />
    </Provider>
  }
  render(<Harness />)
  return { local, onApply, onClose, put }
}
const paste = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: '貼り付ける質問文' }), { target: { value } })
const applyButton = (count: number) => screen.getByRole('button', { name: `反映する (${count}件)` })
const previewRow = (line: number) => within(screen.getByRole('table')).getAllByRole('row')
  .find(row => within(row).queryAllByRole('cell')[0]?.textContent === String(line))!
function expectPreview(count: number, total: number) {
  expect(screen.getByText(`マッピング・差分プレビュー (${count} / ${total}件を反映)`)).toBeInTheDocument()
  expect(applyButton(count)).toBeInTheDocument()
}
async function selectRole(label: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: '対象フィルタ' }))
  fireEvent.click(await screen.findByText(label, { selector: '.ant-select-item-option-content' }))
}
function selectStart(name: string) {
  fireEvent.click(screen.getByRole('button', { name: '変数を選択' }))
  // Ant Design's jsdom IDs repeat across nested modals; identify the real picker by its radio group.
  const picker = screen.getByRole('radiogroup', { name: '検索結果' }).closest('[role="dialog"]') as HTMLElement
  fireEvent.click(within(picker).getByRole('radio', { name: new RegExp(name) }))
  fireEvent.click(within(picker).getByRole('button', { name: /決\s*定/ }))
}
function expectNoApply(result: ReturnType<typeof mountBulk>, text: string) {
  const before = result.local.getState().codebook
  expect(applyButton(0)).toBeDisabled()
  fireEvent.click(applyButton(0))
  expect(result.onApply).not.toHaveBeenCalled()
  expect(result.onClose).not.toHaveBeenCalled()
  expect(result.local.getState().codebook).toBe(before)
  expect(before.hasChanges).toBe(false)
  expect(screen.getByRole('dialog', { name: dialogTitle })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: '貼り付ける質問文' })).toHaveValue(text)
  expect(result.put).not.toHaveBeenCalled()
}
function expectDraft(result: ReturnType<typeof mountBulk>, labels: string[]) {
  expect(result.local.getState().codebook.draftColumns.map(column => column.label)).toEqual(labels)
  expect(result.local.getState().codebook.columns).toEqual(columns)
  expect(result.local.getState().codebook.schemaRevision).toBe(2)
  expect(result.local.getState().codebook.hasChanges).toBe(true)
  expect(result.put).not.toHaveBeenCalled()
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Bulk label paste draft integrity', () => {
  it.each([
    { role: 'すべての列', ids: ['sq5-id', 'sex-id', 'sq4-id'], labels: ['属性の更新', '質問4の更新', '質問5の更新'] },
    { role: '役割: 質問のみ', ids: ['sq5-id', 'sq4-id'], labels: ['性別', '質問4の更新', '質問5の更新'] },
    { role: '役割: 属性のみ', ids: ['sex-id'], labels: ['属性の更新', '混雑度', '頻度'] },
  ])('honors $role for case-insensitive, order-independent named rows', async ({ role, ids, labels }) => {
    const result = mountBulk()
    // TSV matches names rather than the selected positional start or column IDs.
    selectStart('SQ5')
    await selectRole(role)
    paste('sq5\t質問5の更新\nsex\t属性の更新\nSq4\t質問4の更新')
    expectPreview(ids.length, 3)
    expect(within(screen.getByRole('table')).getAllByText('反映対象')).toHaveLength(ids.length)
    expect(within(screen.getByRole('table')).queryAllByText('対象フィルタ外')).toHaveLength(3 - ids.length)
    fireEvent.click(applyButton(ids.length))
    const allUpdates = [
      { columnId: 'sq5-id', label: '質問5の更新' },
      { columnId: 'sex-id', label: '属性の更新' },
      { columnId: 'sq4-id', label: '質問4の更新' },
    ]
    expect(result.onApply).toHaveBeenCalledOnce()
    expect(result.onApply).toHaveBeenCalledWith(allUpdates.filter(update => ids.includes(update.columnId)))
    expect(result.onClose).toHaveBeenCalledOnce()
    expectDraft(result, labels)
    // Apply updates the draft only; the existing editor revert still restores it.
    result.local.dispatch(draftReverted())
    expect(result.local.getState().codebook.draftColumns).toEqual(columns)
    expect(result.local.getState().codebook.hasChanges).toBe(false)
  })

  it('retains excluded, unknown and malformed named rows when the selected role has no columns', async () => {
    const result = mountBulk(columns.filter(column => column.role === 'attribute'))
    await selectRole('役割: 質問のみ')
    const text = 'SEX\t属性の更新\nMISSING\t不明な変数\n変数名のない行\n\t空の変数名'
    paste(text)
    expectPreview(0, 4)
    expect(previewRow(1)).toHaveTextContent('対象フィルタ外')
    expect(previewRow(1)).toHaveTextContent('性別')
    expect(previewRow(2)).toHaveTextContent('変数名不明')
    expect(previewRow(3)).toHaveTextContent('変数名不明')
    expect(previewRow(4)).toHaveTextContent('変数名不明')
    expectNoApply(result, text)
    await selectRole('すべての列')
    expect(screen.getByRole('textbox', { name: '貼り付ける質問文' })).toHaveValue(text)
    expectPreview(1, 4)
    fireEvent.click(applyButton(1))
    expect(result.onApply).toHaveBeenCalledOnce()
    expect(result.onApply).toHaveBeenCalledWith([{ columnId: 'sex-id', label: '属性の更新' }])
  })

  it('shows positional rows as out of range when there are no candidate columns', () => {
    const result = mountBulk([])
    paste('対応先なし')
    expectPreview(0, 1)
    expect(within(previewRow(1)).getByText('範囲超過')).toBeInTheDocument()
    expectNoApply(result, '対応先なし')
  })

  it('keeps wholly unknown named input open and unchanged', () => {
    const result = mountBulk()
    const text = 'MISSING\t不明な変数'
    paste(text)
    expectPreview(0, 1)
    expect(previewRow(1)).toHaveTextContent('変数名不明')
    expectNoApply(result, text)
  })

  it.each([true, false])('never dispatches or closes for blank named labels (skipEmpty=%s)', skipEmpty => {
    const result = mountBulk()
    if (!skipEmpty) fireEvent.click(screen.getByRole('checkbox', { name: '空行をスキップ' }))
    const text = 'SQ4\t\nSQ5\t   '
    paste(text)
    expectPreview(0, 2)
    expect(within(screen.getByRole('table')).getAllByText('空欄（変更なし）')).toHaveLength(2)
    expectNoApply(result, text)
  })

  it('counts and applies only eligible nonblank rows in a mixed named preview', async () => {
    const result = mountBulk()
    await selectRole('役割: 質問のみ')
    paste('SEX\t属性の更新\nSQ4\t\nMISSING\t不明な変数\nSQ5\t頻度の更新')
    expectPreview(1, 4)
    expect(previewRow(1)).toHaveTextContent('対象フィルタ外')
    expect(previewRow(2)).toHaveTextContent('空欄（変更なし）')
    expect(previewRow(3)).toHaveTextContent('変数名不明')
    expect(previewRow(4)).toHaveTextContent('反映対象')
    // Component-style coverage only; physical narrow-viewport QA is separate.
    expect(screen.getByRole('table').closest('.ant-table-content')).toHaveStyle({ overflowX: 'auto' })
    expect(screen.getByRole('table')).toHaveStyle({ width: '700px', minWidth: '100%' })
    fireEvent.click(applyButton(1))
    expect(result.onApply).toHaveBeenCalledOnce()
    expect(result.onApply).toHaveBeenCalledWith([{ columnId: 'sq5-id', label: '頻度の更新' }])
    expectDraft(result, ['性別', '混雑度', '頻度の更新'])
  })

  it('preserves blank positional slots without clearing labels or shifting the next row', () => {
    const result = mountBulk()
    fireEvent.click(screen.getByRole('checkbox', { name: '空行をスキップ' }))
    paste('属性の更新\n\n頻度の更新')
    expectPreview(2, 3)
    expect(previewRow(2)).toHaveTextContent('SQ4')
    expect(previewRow(2)).toHaveTextContent('空欄（変更なし）')
    expect(previewRow(3)).toHaveTextContent('SQ5')
    fireEvent.click(applyButton(2))
    expect(result.onApply).toHaveBeenCalledOnce()
    expect(result.onApply).toHaveBeenCalledWith([
      { columnId: 'sex-id', label: '属性の更新' }, { columnId: 'sq5-id', label: '頻度の更新' },
    ])
    expectDraft(result, ['属性の更新', '混雑度', '頻度の更新'])
  })

  it.each([true, false])('preserves the chosen start and skip-empty offset (skipEmpty=%s)', async skipEmpty => {
    const result = mountBulk()
    await selectRole('役割: 質問のみ')
    selectStart('SQ4')
    if (!skipEmpty) fireEvent.click(screen.getByRole('checkbox', { name: '空行をスキップ' }))
    paste('混雑度の更新\n\n頻度の更新\n範囲外の質問')
    expectPreview(skipEmpty ? 2 : 1, skipEmpty ? 3 : 4)
    expect(previewRow(1)).toHaveTextContent('SQ4')
    if (skipEmpty) {
      expect(previewRow(2)).toBeUndefined()
      expect(previewRow(3)).toHaveTextContent('SQ5')
    } else {
      expect(previewRow(2)).toHaveTextContent('SQ5')
      expect(previewRow(2)).toHaveTextContent('空欄（変更なし）')
      expect(within(previewRow(3)).getByText('範囲超過')).toBeInTheDocument()
    }
    expect(within(previewRow(4)).getByText('範囲超過')).toBeInTheDocument()
    fireEvent.click(applyButton(skipEmpty ? 2 : 1))
    expect(result.onApply).toHaveBeenCalledOnce()
    expect(result.onApply).toHaveBeenCalledWith([
      { columnId: 'sq4-id', label: '混雑度の更新' },
      ...(skipEmpty ? [{ columnId: 'sq5-id', label: '頻度の更新' }] : []),
    ])
    expectDraft(result, ['性別', '混雑度の更新', skipEmpty ? '頻度の更新' : '頻度'])
  })

  it.each([true, false])('does not dirty the draft or discard all-blank positional input (skipEmpty=%s)', skipEmpty => {
    const result = mountBulk()
    if (!skipEmpty) fireEvent.click(screen.getByRole('checkbox', { name: '空行をスキップ' }))
    const text = '  \n  '
    paste(text)
    if (skipEmpty) expect(screen.queryByRole('table')).not.toBeInTheDocument()
    else {
      expectPreview(0, 2)
      expect(within(screen.getByRole('table')).getAllByText('空欄（変更なし）')).toHaveLength(2)
    }
    expectNoApply(result, text)
  })

  it('preserves paste and settings after Cancel, then clears paste only after a nonempty Apply', async () => {
    const result = mountBulk()
    await selectRole('役割: 質問のみ')
    selectStart('SQ5')
    fireEvent.click(screen.getByRole('checkbox', { name: '空行をスキップ' }))
    const text = '頻度の更新'
    paste(text)
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogTitle })).not.toBeInTheDocument())
    expect(result.onApply).not.toHaveBeenCalled()
    expect(result.local.getState().codebook.hasChanges).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '貼り付けを再開' }))
    expect(screen.getByRole('textbox', { name: '貼り付ける質問文' })).toHaveValue(text)
    expect(screen.getByRole('checkbox', { name: '空行をスキップ' })).not.toBeChecked()
    expect(previewRow(1)).toHaveTextContent('SQ5')
    expectPreview(1, 1)
    fireEvent.click(applyButton(1))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogTitle })).not.toBeInTheDocument())
    expect(result.onApply).toHaveBeenCalledOnce()
    expect(result.onApply).toHaveBeenCalledWith([{ columnId: 'sq5-id', label: text }])
    expect(result.onClose).toHaveBeenCalledTimes(2)
    expectDraft(result, ['性別', '混雑度', text])
    fireEvent.click(screen.getByRole('button', { name: '貼り付けを再開' }))
    expect(screen.getByRole('textbox', { name: '貼り付ける質問文' })).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: '空行をスキップ' })).not.toBeChecked()
    expect(applyButton(0)).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '対象フィルタ' }).closest('.ant-select')).toHaveTextContent('役割: 質問のみ')
    expect(screen.getByRole('combobox', { name: '開始変数' }).closest('.ant-select')).toHaveTextContent('SQ5')
    expect(result.onApply).toHaveBeenCalledOnce()
  })
})
