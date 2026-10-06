import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { message } from 'antd'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import ProvenanceHistoryPanel from '../src/features/dataset/ProvenanceHistoryPanel'

vi.mock('../src/features/pcp/useDatasetColumns', () => ({
  invalidateColumnarCache: vi.fn(), useColumnarData: () => null,
}))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mountHistory() {
  const base = store.getState()
  const state = { ...base, selection: { ...base.selection, datasetId: 'iris', dataRevision: 2 },
    codebook: { ...base.codebook, datasetId: 'iris', schemaRevision: 2 },
    provenance: { ...base.provenance, ready: true, datasetId: 'iris', dataRevision: 2, schemaRevision: 2,
      canUndo: true, canRedo: false, rawDataRevision: 1, maskRevision: 0,
      loading: false, error: null, steps: [] } }
  const local = configureStore({ reducer: (current = state) => current,
    middleware: get => get({ serializableCheck: false }) })
  vi.spyOn(api, 'get').mockResolvedValue({ dataRevision: 2, schemaRevision: 2,
    datasetId: 'iris', columns: [], steps: [], canUndo: true })
  return render(<Provider store={local}><ProvenanceHistoryPanel /></Provider>)
}

it.each([
  [{ message: 'スナップショットを読み込めません', code: 'PROVENANCE_SNAPSHOT_MISSING' },
    'スナップショットを読み込めません（PROVENANCE_SNAPSHOT_MISSING）'],
  [{ message: '対象が変更されました' }, '対象が変更されました'],
  [new Error('接続に失敗しました'), '接続に失敗しました'],
  [null, '操作に失敗しました。'],
  [{ message: 42, code: 'INVALID' }, '操作に失敗しました。'],
])('shows actionable Undo failures without concealing structured API messages: %j', async (error, expected) => {
  const post = vi.spyOn(api, 'post').mockRejectedValue(error)
  const notice = vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  const view = mountHistory()
  fireEvent.click(view.getByRole('button', { name: 'Undo' }))
  await waitFor(() => expect(notice).toHaveBeenCalledWith(expected))
  expect(post).toHaveBeenCalledWith('/datasets/iris/undo', {
    expectedDataRevision: 2, expectedSchemaRevision: 2,
  })
  await waitFor(() => expect(view.getByRole('button', { name: 'Undo' })).not.toBeDisabled())
  expect(view.getByText('rev 2 / schema 2')).toBeTruthy()
})

it('retains a failed Undo action for an explicit retry', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce({
    message: '保存世代が変更されました', code: 'STALE_RESULT',
  }).mockResolvedValueOnce({ currentDataRevision: 3, maskRevision: 1 })
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
  const view = mountHistory()
  fireEvent.click(view.getByRole('button', { name: 'Undo' }))
  await waitFor(() => expect(message.error).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(view.getByRole('button', { name: 'Undo' })).not.toBeDisabled())
  fireEvent.click(view.getByRole('button', { name: 'Undo' }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(message.error).toHaveBeenCalledTimes(1)
})
