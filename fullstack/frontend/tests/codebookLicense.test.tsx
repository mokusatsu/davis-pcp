import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type CodebookColumn } from '../src/api/client'
import { codebookReceived, codebookSlice, draftColumnUpdated, editorModalOpened, saveLicenseTextThunk } from '../src/features/dataset/codebookSlice'
import CodebookEditorModal from '../src/features/dataset/CodebookEditorModal'
import DatasetLicenseNotice from '../src/features/dataset/DatasetLicenseNotice'

const column: CodebookColumn = { columnId: 'q', name: 'Q1', label: '質問', role: 'question', scaleType: 'ordinal',
  categoryOrder: ['1', '2'], valueLabels: { '1': '低い', '2': '高い' }, missingCodes: [], missingReasons: {},
  isReversed: false, multiResponseGroup: null }
function setup() {
  const local = configureStore({ reducer: { codebook: codebookSlice.reducer,
    selection: () => ({ datasetId: 'd', datasetName: 'Data', allRowIds: ['r1'] }) } })
  local.dispatch(codebookReceived({ datasetId: 'd', schemaRevision: 7, licenseRevision: 2,
    licenseText: '保存済み\n©出典', columns: [column] }))
  local.dispatch(editorModalOpened())
  render(<Provider store={local}><CodebookEditorModal /></Provider>)
  return local
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('positions the change tag after Rev and license control at the footer left', () => {
  setup()
  const revision = screen.getByText('Rev: 7')
  expect(revision.nextElementSibling?.textContent).toBe('変更なし')
  const button = screen.getByRole('button', { name: /ライセンス情報/ })
  expect(button.closest('.ant-modal-footer')?.firstElementChild?.firstElementChild).toBe(button)
})

it('saves multiline Unicode immediately without touching the outer dirty draft or schema revision', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({ codebook: { licenseText: '利用条件\n©研究室 😀\n<script>x</script>', licenseRevision: 3 } })
  const local = setup()
  act(() => local.dispatch(draftColumnUpdated({ columnId: 'q', patch: { label: 'まだ保存しない質問文' } })))
  fireEvent.click(screen.getByRole('button', { name: /ライセンス情報/ }))
  const dialog = screen.getByRole('textbox', { name: 'ライセンス情報の本文' }).closest('[role=dialog]') as HTMLElement
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '利用条件\n©研究室 😀\n<script>x</script>' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'ライセンス情報の本文' })).not.toBeInTheDocument())
  expect(put).toHaveBeenCalledWith('/datasets/d/codebook', { columns: [], licenseText: '利用条件\n©研究室 😀\n<script>x</script>', expectedLicenseRevision: 2 })
  expect(local.getState().codebook).toMatchObject({ schemaRevision: 7, licenseRevision: 3,
    hasChanges: true, licenseText: '利用条件\n©研究室 😀\n<script>x</script>' })
  expect(local.getState().codebook.draftColumns[0].label).toBe('まだ保存しない質問文')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  act(() => local.dispatch(editorModalOpened()))
  fireEvent.click(screen.getByRole('button', { name: /ライセンス情報/ }))
  expect(screen.getByRole('textbox', { name: 'ライセンス情報の本文' })).toHaveValue('利用条件\n©研究室 😀\n<script>x</script>')
})

it('nested cancel discards only its draft, reopens saved text, and permits clearing it', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({ codebook: { licenseText: '', licenseRevision: 3 } })
  const local = setup()
  fireEvent.click(screen.getByRole('button', { name: /ライセンス情報/ }))
  let dialog = screen.getByRole('textbox', { name: 'ライセンス情報の本文' }).closest('[role=dialog]') as HTMLElement
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'cancel me' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  expect(put).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /ライセンス情報/ }))
  dialog = screen.getByRole('textbox', { name: 'ライセンス情報の本文' }).closest('[role=dialog]') as HTMLElement
  expect(within(dialog).getByRole('textbox')).toHaveValue('保存済み\n©出典')
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
  await waitFor(() => expect(local.getState().codebook.licenseText).toBe(''))
})

it('failed save keeps the entered text visible for recovery', async () => {
  vi.spyOn(api, 'put').mockRejectedValue(new Error('他の画面で更新されました'))
  setup()
  fireEvent.click(screen.getByRole('button', { name: /ライセンス情報/ }))
  const dialog = screen.getByRole('textbox', { name: 'ライセンス情報の本文' }).closest('[role=dialog]') as HTMLElement
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '復旧用の入力' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
  await within(dialog).findByText('他の画面で更新されました')
  expect(within(dialog).getByRole('textbox')).toHaveValue('復旧用の入力')
})

it('ignores late metadata saves for a different dataset or an older metadata revision', () => {
  const local = setup()
  const fulfill = (id: string, revision: number) => local.dispatch(saveLicenseTextThunk.fulfilled(
    { datasetId: id, licenseText: 'late', licenseRevision: revision }, 'request', { datasetId: id, licenseText: 'late', expectedLicenseRevision: 1 }))
  act(() => { fulfill('other', 5); fulfill('d', 1) })
  expect(local.getState().codebook.licenseText).toBe('保存済み\n©出典')
})

it('renders arbitrary long notice text literally and closes with OK', () => {
  const text = '<img src=x onerror=alert(1)>\n日本語©\n' + '長い説明'.repeat(3000)
  const close = vi.fn()
  render(<DatasetLicenseNotice license={{ datasetId: 'd', name: 'Data', text }} onClose={close} />)
  const content = screen.getByTestId('dataset-license-text')
  expect(content.textContent).toBe(text)
  expect(content.querySelector('img')).toBeNull()
  expect(content).toHaveStyle({ whiteSpace: 'pre-wrap', overflowY: 'auto' })
  fireEvent.click(screen.getByRole('button', { name: 'OK' }))
  expect(close).toHaveBeenCalledOnce()
})
it('does not open a notice for empty or whitespace-only text', () => {
  render(<DatasetLicenseNotice license={{ datasetId: 'd', name: 'Data', text: ' \n ' }} onClose={() => {}} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('conflict recovery explicitly reloads current saved metadata and permits a fresh revision save', async () => {
  const put = vi.spyOn(api, 'put').mockRejectedValueOnce(new Error('競合'))
    .mockResolvedValueOnce({ codebook: { licenseText: '再編集', licenseRevision: 8 } })
  vi.spyOn(api, 'get').mockResolvedValue({ datasetId: 'd', licenseText: '他の画面の最新', licenseRevision: 7, schemaRevision: 7, columns: [column] })
  const local = setup()
  fireEvent.click(screen.getByRole('button', { name: /ライセンス情報/ }))
  const dialog = screen.getByRole('textbox', { name: 'ライセンス情報の本文' }).closest('[role=dialog]') as HTMLElement
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '競合した入力' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
  fireEvent.click(await within(dialog).findByRole('button', { name: '最新の保存済みを再読込（入力を置換）' }))
  await waitFor(() => expect(within(dialog).getByRole('textbox')).toHaveValue('他の画面の最新'))
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '再編集' } })
  fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存/ }))
  await waitFor(() => expect(local.getState().codebook.licenseRevision).toBe(8))
  expect(put.mock.calls[1][1]).toMatchObject({ licenseText: '再編集', expectedLicenseRevision: 7 })
})
