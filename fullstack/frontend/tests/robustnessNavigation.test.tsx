import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Provider } from 'react-redux'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { store } from '../src/app/store'
import { api } from '../src/api/client'
import RobustnessPage from '../src/features/robustness/RobustnessPage'

vi.mock('../src/features/charts/CategoryBars', () => ({ default: () => null }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const first = { id: 'a', type: 'subgroup_diff', label: 'first candidate', target_col: 'X', group_col: 'Group' }
const second = { id: 'b', type: 'subgroup_diff', label: 'second candidate', target_col: 'Z', group_col: 'Group' }
function KeptPage() {
  const navigate = useNavigate()
  return <><button onClick={() => navigate('/mining')}>leave</button>
    <button onClick={() => navigate('/robustness', { state: { conclusion: first } })}>send first</button>
    <button onClick={() => navigate('/robustness', { state: { conclusion: second } })}>send second</button>
    <button onClick={() => navigate('/robustness')}>return normally</button>
    <RobustnessPage /></>
}
function setup() {
  const base = store.getState()
  const local = configureStore({ reducer: () => ({ ...base,
    selection: { ...base.selection, datasetId: 'd', dataRevision: 1 } }),
    middleware: get => get({ serializableCheck: false }) })
  return render(<Provider store={local}><MemoryRouter initialEntries={['/robustness']}><KeptPage /></MemoryRouter></Provider>)
}
it('accepts later conclusion navigation while the page remains mounted and preserves ordinary revisits', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ run_id: 'r', conclusions: [] })
  const view = setup()
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  fireEvent.click(view.getByText('leave'))
  fireEvent.click(view.getByText('send first'))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/robustness/evaluate', expect.objectContaining({ conclusions: [first] })))
  fireEvent.click(view.getByText('leave'))
  fireEvent.click(view.getByText('send second'))
  await waitFor(() => expect(post).toHaveBeenLastCalledWith('/robustness/evaluate', expect.objectContaining({ conclusions: [second] })))
  expect(view.getByText('second candidate')).toBeInTheDocument()
  const count = post.mock.calls.length
  fireEvent.click(view.getByText('leave'))
  fireEvent.click(view.getByText('return normally'))
  await act(async () => {})
  expect(post).toHaveBeenCalledTimes(count)
  expect(view.getByText('second candidate')).toBeInTheDocument()
})

it('discards an older handoff response and resets to default conclusions once', async () => {
  let finishFirst!: (value: any) => void
  const post = vi.spyOn(api, 'post').mockImplementation(async (_path, payload: any) => {
    if (payload.conclusions?.[0]?.id === 'a') return new Promise(resolve => { finishFirst = resolve })
    return { run_id: 'r', conclusions: [] } as any
  })
  const view = setup()
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  fireEvent.click(view.getByText('send first'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  fireEvent.click(view.getByText('send second'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3))
  await act(async () => { finishFirst({ run_id: 'old', conclusions: [{ id: 'old', label: 'obsolete result' }] }) })
  expect(view.queryByText('obsolete result')).not.toBeInTheDocument()
  expect(view.getByText('second candidate')).toBeInTheDocument()
  fireEvent.click(view.getByText('デフォルト全体結論に戻す'))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(4))
  expect(post).toHaveBeenLastCalledWith('/robustness/evaluate', expect.objectContaining({ datasetId: 'd', bootstrapB: 100, rowIds: [], expectedDataRevision: 1, expectedSchemaRevision: 1 }))
  expect(view.queryByTestId('inherited-conclusion-alert')).not.toBeInTheDocument()
  await waitFor(() => expect(view.container.querySelector('.ant-spin-spinning')).toBeNull())
})
