import { configureStore } from '@reduxjs/toolkit'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { notification } from 'antd'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadCodebookExport, importCodebook, type CodebookResponse } from '../src/api/client'
import { datasetLoaded, selectionReducer } from '../src/app/store'
import CodebookCsvImportDialog from '../src/features/dataset/CodebookCsvImportDialog'
import CodebookEditorModal from '../src/features/dataset/CodebookEditorModal'
import { codebookReceived, codebookSlice, draftColumnUpdated, editorModalOpened } from '../src/features/dataset/codebookSlice'

// Exercise the real menu, import dialog, file picker and commit button. The
// unrelated column/MA/license editors do not participate in format guidance.
vi.mock('../src/features/dataset/CodebookVariableList', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookDetailForm', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookGridView', () => ({ default: () => null }))
vi.mock('../src/features/dataset/BulkLabelPasteModal', () => ({ default: () => null }))
vi.mock('../src/features/dataset/MultiResponseGroupDialog', () => ({ default: () => null }))
vi.mock('../src/features/dataset/CodebookLicenseEditor', () => ({ default: () => null }))
vi.mock('../src/api/client', async original => ({
  ...await original<typeof import('../src/api/client')>(),
  downloadCodebookExport: vi.fn().mockResolvedValue(undefined),
  importCodebook: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(downloadCodebookExport).mockReset().mockResolvedValue(undefined)
  vi.mocked(importCodebook).mockReset().mockResolvedValue({
    status: 'success', datasetId: 'survey', updatedColumns: 1, schemaRevision: 2,
  })
  vi.spyOn(notification, 'success').mockImplementation(() => undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function createStore() {
  const local = configureStore({
    reducer: { selection: selectionReducer, codebook: codebookSlice.reducer },
    middleware: get => get({ serializableCheck: false }),
  })
  local.dispatch(datasetLoaded({ datasetId: 'survey', name: 'survey.csv', rowIds: ['r1'], dataRevision: 1 }))
  const snapshot: CodebookResponse = {
    datasetId: 'survey', schemaRevision: 1, multiResponseGroups: [],
    columns: [{ columnId: 'q', name: 'answer', label: '保存済み', scaleType: 'nominal', role: 'question',
      valueLabels: {}, categoryOrder: [], missingCodes: [], missingReasons: {},
      isReversed: false, multiResponseGroup: null, multiResponseOptionLabel: '' }],
  }
  local.dispatch(codebookReceived(snapshot))
  local.dispatch(editorModalOpened())
  return local
}

describe('Codebook interchange guidance at the action boundary', () => {
  it.each(['csv', 'json'] as const)('explains the saved format before exporting %s and preserves a dirty draft', async format => {
    const local = createStore()
    local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: '未保存の編集' } }))
    render(<Provider store={local}><CodebookEditorModal /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /エクスポート/ }))
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveStyle({ width: '360px', maxWidth: 'calc(100vw - 32px)' })
    const savedNotice = within(menu).getByText('保存済みの設定を出力（未保存の編集は含みません）')
    await waitFor(() => expect(savedNotice).toBeVisible())
    expect(savedNotice).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' })
    const csv = within(menu).getByRole('menuitem', { name: /CSV形式でエクスポート/ })
    const json = within(menu).getByRole('menuitem', { name: /JSON形式でエクスポート/ })
    expect(csv).toHaveTextContent('列定義・ライセンスのみ（MA親設問・重み設定・調査設計は含みません）')
    expect(json).toHaveTextContent('MA親設問・重み設定・調査設計を含む対応メタデータ')
    for (const item of [csv, json]) {
      expect(item.querySelector('div[style]')).toHaveStyle({ whiteSpace: 'normal', overflowWrap: 'anywhere' })
    }
    fireEvent.click(format === 'csv' ? csv : json)
    expect(downloadCodebookExport).toHaveBeenCalledOnce()
    expect(downloadCodebookExport).toHaveBeenCalledWith('survey', format)
    expect(local.getState().codebook.hasChanges).toBe(true)
    expect(local.getState().codebook.draftColumns[0].label).toBe('未保存の編集')
    expect(importCodebook).not.toHaveBeenCalled()
  })

  it('explains immediate persistence while choosing and cancelling a file performs no import', async () => {
    const close = vi.fn(), success = vi.fn()
    render(<CodebookCsvImportDialog open datasetId="survey" onClose={close} onSuccess={success} />)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(within(dialog).getByText(/MA親設問・重み設定・調査設計も引き継ぐにはJSON/)).toBeVisible())
    expect(within(dialog).getByText(/「インポート実行」で検証後すぐに保存/)).toHaveTextContent(
      '外側の「保存」は不要で、実行後の「キャンセル」やUndoでは取り消せません。ファイルを選ぶだけでは検証・保存されません。')
    expect(within(dialog).getByText(/未保存の編集は別に保持/)).toHaveTextContent('後から保存すると取込内容を上書きする場合')
    const file = new File(['{"columns":[{"name":"answer","label":"更新"}]}'], 'dictionary.json')
    fireEvent.change(dialog.querySelector('input[type=file]')!, { target: { files: [file] } })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'インポート実行' })).toBeEnabled())
    expect(importCodebook).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(close).toHaveBeenCalledOnce()
    expect(importCodebook).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
  })

  it('imports the chosen file at the documented button without another Save step', async () => {
    const close = vi.fn(), success = vi.fn()
    render(<CodebookCsvImportDialog open datasetId="survey" onClose={close} onSuccess={success} />)
    const file = new File(['name,label\nanswer,更新'], 'dictionary.csv')
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })
    const submit = screen.getByRole('button', { name: 'インポート実行' })
    await waitFor(() => expect(submit).toBeEnabled())
    expect(importCodebook).not.toHaveBeenCalled()
    fireEvent.click(submit)
    await waitFor(() => expect(success).toHaveBeenCalledOnce())
    expect(success).toHaveBeenCalledWith('survey')
    expect(importCodebook).toHaveBeenCalledOnce()
    expect(importCodebook).toHaveBeenCalledWith('survey', file)
    expect(close).toHaveBeenCalledOnce()
  })
})
