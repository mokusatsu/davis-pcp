import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { notification } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import BinningModal from '../src/features/dataset/BinningModal'

// Exercise real modal, name, method, cut, and submit controls. Chart rendering is independent.
vi.mock('../src/features/charts/EChartSurface', () => ({ default: () => null }))
const preview = { column: 'x', method: 'equal_width', edges: [0, 1],
  bins: [{ binIndex: 0, label: 'BIN', min: 0, max: 1, count: 1, ratio: 1 }],
  histogram: { counts: [], edges: [0, 1] }, min: 0, max: 1, count: 1 }
function mount() {
  const close = vi.fn(), success = vi.fn()
  const ui = (datasetId: string) => <Provider store={store}>
    <BinningModal open datasetId={datasetId} columnName="x" onClose={close} onSuccess={success} />
  </Provider>
  return { close, success, ui, ...render(ui('original')) }
}
async function submit() {
  const button = screen.getByRole('button', { name: 'ビン列を生成' })
  await waitFor(() => expect(button).toBeEnabled())
  await act(async () => { fireEvent.click(button) })
  return button
}
function response(result: unknown) {
  return vi.spyOn(api, 'post').mockImplementation(async path =>
    (path.endsWith('/preview') ? preview : result) as any)
}
beforeEach(() => {
  vi.spyOn(notification, 'success').mockImplementation(() => {})
  vi.spyOn(notification, 'error').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each([
  { caseName: 'normal', draft: 'x_bin4', requested: 'x_bin4', created: 'x_bin4' },
  { caseName: 'collision', draft: 'x_bin4', requested: 'x_bin4', created: 'x_bin4_1' },
  { caseName: 'trimmed', draft: '  custom bins  ', requested: 'custom bins', created: 'custom bins' },
])('reports the authoritative $caseName completion name and keeps the request unchanged', async ({ draft, requested, created }) => {
  const post = response({ createdColumns: [created] })
  const { close, success } = mount()
  fireEvent.change(screen.getByTestId('binning-output-name'), { target: { value: draft } })
  await submit()
  await waitFor(() => expect(notification.success).toHaveBeenCalledWith({
    message: 'ビン分割完了', description: `新列 1 列 ('${created}') を生成しました。`,
  }))
  expect(post).toHaveBeenCalledTimes(2)
  expect(post).toHaveBeenLastCalledWith('/datasets/original/transform', {
    type: 'binning', source_column: 'x', options: { method: 'equal_width', num_bins: 4,
      custom_cuts: undefined, output_column_name: requested, labels_format: 'range' },
  })
  expect(success).toHaveBeenCalledOnce()
  expect(success).toHaveBeenCalledWith('original')
  expect(close).toHaveBeenCalledOnce()
})

it('uses the returned name when empty output and custom cuts make the backend default differ from requested bins', async () => {
  const post = response({ createdColumns: ['x_bin3'] })
  mount()
  await waitFor(() => expect(screen.getByRole('button', { name: 'ビン列を生成' })).toBeEnabled())
  fireEvent.click(screen.getByRole('radio', { name: 'カスタム境界値' }))
  fireEvent.change(screen.getByPlaceholderText('例: 5.0, 6.0, 7.0'), { target: { value: '0.3,0.6' } })
  fireEvent.change(screen.getByTestId('binning-output-name'), { target: { value: '   ' } })
  await submit()
  await waitFor(() => expect(notification.success).toHaveBeenCalledWith({
    message: 'ビン分割完了', description: "新列 1 列 ('x_bin3') を生成しました。",
  }))
  expect(post).toHaveBeenLastCalledWith('/datasets/original/transform', {
    type: 'binning', source_column: 'x', options: { method: 'custom', num_bins: 4,
      custom_cuts: [0.3, 0.6], output_column_name: undefined, labels_format: 'range' },
  })
})

it.each([undefined, {}, { createdColumns: [] }, { createdColumns: null }, { createdColumns: [''] }, { createdColumns: ['actual_name', null] }])(
  'does not invent a created name or count when result metadata is absent, empty or malformed: %j', async result => {
    response(result)
    const { close, success } = mount()
    fireEvent.change(screen.getByTestId('binning-output-name'), { target: { value: 'unconfirmed_name' } })
    await submit()
    await waitFor(() => expect(notification.success).toHaveBeenCalledWith({
      message: 'ビン分割完了', description: 'ビン分割を完了しました。生成列名を応答から確認できませんでした。',
    }))
    expect(notification.error).not.toHaveBeenCalled()
    expect(success).toHaveBeenCalledOnce()
    expect(success).toHaveBeenCalledWith('original')
    expect(close).toHaveBeenCalledOnce()
  },
)

it('derives the completion count and every name from returned metadata', async () => {
  response({ createdColumns: ['actual_first', 'actual_second'] })
  mount()
  await submit()
  await waitFor(() => expect(notification.success).toHaveBeenCalledWith({
    message: 'ビン分割完了', description: "新列 2 列 ('actual_first', 'actual_second') を生成しました。",
  }))
})

it('preserves busy locks and original-dataset completion without closing a newer dialog', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => { resolve = done })
  const post = vi.spyOn(api, 'post').mockImplementation(path =>
    (path.endsWith('/preview') ? Promise.resolve(preview) : pending) as any)
  const { close, success, ui, rerender } = mount()
  const button = await submit()
  fireEvent.click(button)
  expect(post.mock.calls.filter(([path]) => path.endsWith('/transform'))).toHaveLength(1)
  expect(screen.getByTestId('binning-output-name')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape', keyCode: 27 })
  expect(close).not.toHaveBeenCalled()
  rerender(ui('newer'))
  await act(async () => { resolve({ createdColumns: ['x_bin4_1'] }); await pending })
  expect(notification.success).toHaveBeenCalledWith({
    message: 'ビン分割完了', description: "新列 1 列 ('x_bin4_1') を生成しました。",
  })
  expect(success).toHaveBeenCalledOnce()
  expect(success).toHaveBeenCalledWith('original')
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByTestId('binning-output-name')).toBeEnabled()
  expect(screen.getByRole('button', { name: 'キャンセル' })).toBeEnabled()
})
