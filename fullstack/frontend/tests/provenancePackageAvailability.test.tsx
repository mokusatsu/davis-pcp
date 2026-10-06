import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { api } from '../src/api/client'
import { datasetLoaded, selectionReducer, globalVariablesSlice } from '../src/app/store'
import { codebookReceived, codebookSlice } from '../src/features/dataset/codebookSlice'
import { provenanceReducer } from '../src/features/dataset/provenanceSlice'
import ProvenanceHistoryPanel from '../src/features/dataset/ProvenanceHistoryPanel'

const mode = vi.hoisted(() => ({ static: false }))
vi.mock('../src/api/client', async original => ({
  ...await original<typeof import('../src/api/client')>(),
  get IS_STATIC_BUILD() { return mode.static },
}))
vi.mock('../src/features/pcp/useDatasetColumns', () => ({ invalidateColumnarCache: vi.fn(), useColumnarData: () => null }))

const guidance = 'このブラウザー版では再現パッケージを出力できません。サーバー版では、サーバーに保存したデータを出力できます。'
const exportName = '再現パッケージ出力', importName = '再現パッケージ取込'
const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function makeStore(datasetId: string | null = 'package-data') {
  const local = configureStore({
    reducer: { selection: selectionReducer, codebook: codebookSlice.reducer,
      provenance: provenanceReducer, globalVariables: globalVariablesSlice.reducer },
    middleware: get => get({ serializableCheck: false }),
  })
  if (datasetId) {
    local.dispatch(datasetLoaded({ datasetId, name: datasetId, rowIds: ['row-1'], dataRevision: 2 }))
    local.dispatch(codebookReceived({ datasetId, schemaRevision: 2, columns: [] }))
  }
  return local
}
function mount(local = makeStore()) {
  return { ...render(<Provider store={local}><ProvenanceHistoryPanel /></Provider>), local }
}
async function ready() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled())
}
function packageInput(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[type="file"][accept=".zip"]')!
}
beforeEach(() => {
  mode.static = false
  vi.spyOn(api, 'get').mockImplementation(async path => ({ datasetId: path.split('/')[2],
    dataRevision: 2, schemaRevision: 2, currentOperationId: 'op-2', cursorOperationId: 'op-2',
    canUndo: true, canRedo: true, rawDataRevision: 1, maskRevision: 0, steps: [],
  }) as never)
  vi.spyOn(api, 'downloadBlob').mockResolvedValue(new Blob(['test package'], { type: 'application/zip' }))
  vi.spyOn(api, 'upload').mockResolvedValue({ datasetId: 'imported' })
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:package-export') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); mode.static = false
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  else delete (URL as Partial<typeof URL>).createObjectURL
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  else delete (URL as Partial<typeof URL>).revokeObjectURL
})

it('disables the native history Export in static mode without starting an operation or blocking Import', async () => {
  mode.static = true
  const { container, local } = mount(); await ready()
  const button = screen.getByRole('button', { name: exportName, exact: true })
  expect(button.tagName).toBe('BUTTON')
  expect(button).toBeDisabled()
  const before = local.getState()
  fireEvent.click(button)
  expect(api.downloadBlob).not.toHaveBeenCalled()
  expect(message.error).not.toHaveBeenCalled()
  expect(message.success).not.toHaveBeenCalled()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(local.getState()).toBe(before)
  expect(screen.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
  const input = packageInput(container), open = vi.spyOn(input, 'click')
  const importButton = screen.getByRole('button', { name: importName, exact: true })
  expect(importButton).toBeEnabled(); expect(input).toBeEnabled()
  fireEvent.click(importButton)
  expect(open).toHaveBeenCalledOnce()
  fireEvent(input, new Event('cancel', { bubbles: true }))
  fireEvent.change(input, { target: { files: [] } })
  expect(api.upload).not.toHaveBeenCalled()
  expect(local.getState()).toBe(before)
})

it('shows persistent static guidance first in the card body, preserving the Export name and control order', async () => {
  mode.static = true
  mount(); await ready()
  const panel = screen.getByTestId('provenance-panel')
  const button = within(panel).getByRole('button', { name: exportName, exact: true })
  const description = within(panel).getByText(guidance, { exact: true })
  expect(description).toBeVisible()
  expect(panel.querySelector('.ant-card-body')?.firstElementChild).toBe(description)
  expect(button).toHaveAttribute('aria-describedby', description.id)
  expect(description.id).not.toBe('')
  expect(button).toHaveAccessibleName(exportName)
  expect(button).toHaveAccessibleDescription(guidance)
  const names = [exportName, importName, 'Revert to Raw', 'Undo', 'Redo']
  expect(within(panel).getAllByRole('button').slice(0, 5))
    .toEqual(names.map(name => within(panel).getByRole('button', { name, exact: true })))
  expect(within(panel).getByText('データ来歴・操作履歴').compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(button.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('associates each static panel with its own visible description', async () => {
  mode.static = true
  const first = makeStore('first'), second = makeStore('second')
  render(<><Provider store={first}><ProvenanceHistoryPanel /></Provider><Provider store={second}><ProvenanceHistoryPanel /></Provider></>)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Undo', exact: true }).every(button => !button.hasAttribute('disabled'))).toBe(true))
  const panels = screen.getAllByTestId('provenance-panel')
  const ids = panels.map(panel => {
    const button = within(panel).getByRole('button', { name: exportName, exact: true })
    const description = within(panel).getByText(guidance, { exact: true })
    expect(description).toBeVisible()
    expect(button).toHaveAttribute('aria-describedby', description.id)
    expect(button).toHaveAccessibleDescription(guidance)
    return description.id
  })
  expect(new Set(ids).size).toBe(2)
})

it.each([false, true])('renders neither controls nor guidance without a dataset (static=%s)', staticMode => {
  mode.static = staticMode
  const { container } = mount(makeStore(null))
  expect(container).toBeEmptyDOMElement()
  expect(screen.queryByRole('button', { name: exportName, exact: true })).not.toBeInTheDocument()
  expect(screen.queryByText(guidance)).not.toBeInTheDocument()
  expect(api.downloadBlob).not.toHaveBeenCalled()
  expect(api.get).not.toHaveBeenCalled()
})

it('preserves server Export path, returned Blob, ZIP filename, click/revoke order, success and busy release', async () => {
  const request = deferred<Blob>()
  vi.mocked(api.downloadBlob).mockReturnValue(request.promise)
  const { container, local } = mount(); await ready()
  const button = screen.getByRole('button', { name: exportName, exact: true })
  expect(button).toBeEnabled()
  expect(button).not.toHaveAttribute('aria-describedby')
  expect(screen.queryByText(guidance)).not.toBeInTheDocument()
  const before = local.getState(), input = packageInput(container), open = vi.spyOn(input, 'click')
  const importButton = screen.getByRole('button', { name: importName, exact: true })
  const clicked: { href: string; download: string }[] = []
  vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, download: this.download })
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  })
  fireEvent.click(button)
  expect(api.downloadBlob).toHaveBeenCalledOnce(); expect(api.downloadBlob).toHaveBeenCalledWith('/datasets/package-data/export_package')
  expect(button).toBeDisabled(); expect(importButton).toBeDisabled(); expect(input).toBeDisabled()
  fireEvent.click(button); fireEvent.click(importButton)
  expect(api.downloadBlob).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  const blob = new Blob(['mock server bytes'], { type: 'application/zip' })
  await act(async () => { request.resolve(blob); await request.promise })
  await waitFor(() => expect(button).toBeEnabled())
  expect(URL.createObjectURL).toHaveBeenCalledOnce(); expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
  expect(clicked).toEqual([{ href: 'blob:package-export', download: 'package-data-package.zip' }])
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:package-export')
  expect(message.success).toHaveBeenCalledOnce(); expect(message.success).toHaveBeenCalledWith('再現パッケージを出力しました。')
  expect(message.error).not.toHaveBeenCalled()
  expect(importButton).toBeEnabled(); expect(input).toBeEnabled()
  fireEvent.click(importButton); expect(open).toHaveBeenCalledOnce()
  expect(api.upload).not.toHaveBeenCalled()
  expect(local.getState()).toBe(before)
})

it.each([false, true])('retains Import chooser and shared busy rules without changing export capability (static=%s)', async staticMode => {
  mode.static = staticMode
  const request = deferred<never>()
  vi.mocked(api.upload).mockReturnValue(request.promise)
  const { container, local } = mount(); await ready()
  const button = screen.getByRole('button', { name: exportName, exact: true })
  const importButton = screen.getByRole('button', { name: importName, exact: true })
  const input = packageInput(container), open = vi.spyOn(input, 'click'), before = local.getState()
  fireEvent.click(importButton); expect(open).toHaveBeenCalledOnce()
  const file = new File(['fixture only'], 'package.zip', { type: 'application/zip' })
  fireEvent.change(input, { target: { files: [file] } })
  expect(api.upload).toHaveBeenCalledOnce(); expect(api.upload).toHaveBeenCalledWith('/datasets/import_package', file)
  expect(button).toBeDisabled(); expect(importButton).toBeDisabled(); expect(input).toBeDisabled()
  fireEvent.click(button); fireEvent.click(importButton)
  expect(api.downloadBlob).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledOnce()
  await act(async () => { request.reject(new Error('mock import failure')) })
  await waitFor(() => expect(importButton).toBeEnabled())
  expect(input).toBeEnabled(); expect(input).toHaveValue('')
  if (staticMode) {
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(guidance)
    expect(screen.getByText(guidance)).toBeVisible()
  } else expect(button).toBeEnabled()
  fireEvent.click(importButton); expect(open).toHaveBeenCalledTimes(2)
  expect(message.error).toHaveBeenCalledOnce(); expect(message.error).toHaveBeenCalledWith('mock import failure')
  expect(local.getState()).toBe(before)
})
