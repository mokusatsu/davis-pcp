import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspacePersistence } from '../src/app/useWorkspacePersistence'
import { store, datasetLoaded, variablesInitialized, selectionApplied } from '../src/app/store'
import type { PersistenceState } from '../src/engine/persistence'

const storage = vi.hoisted(() => ({ getState: vi.fn(), subscribe: vi.fn(), flush: vi.fn(), save: vi.fn() }))
vi.mock('../src/app/workspaceStorage', () => ({ workspaceStorage: storage }))
const durable: PersistenceState = { mode: 'persistent', pending: false, error: null }
const failed: PersistenceState = { mode: 'persistent', pending: true, error: 'Quota exceeded' }
let listener: (state: PersistenceState) => void
beforeEach(() => {
  vi.clearAllMocks()
  storage.getState.mockReturnValue(durable)
  storage.subscribe.mockImplementation(fn => { listener = fn; return () => {} })
  storage.flush.mockResolvedValue(durable)
  store.dispatch(datasetLoaded({ datasetId: 'a', name: 'Data A', rowIds: ['a1'], dataRevision: 1 }))
  store.dispatch(variablesInitialized({ datasetId: 'a', variables: ['x'] }))
})
afterEach(cleanup)
function mount() {
  const onSaved = vi.fn()
  const hook = renderHook(() => useWorkspacePersistence(onSaved), { wrapper: ({children}) => <Provider store={store}>{children}</Provider> })
  return { ...hook, onSaved }
}
const data = { sessionId: 'new-id', datasetId: 'a', name: 'draft', revision: 2, versionToken: 'new-token', state: {} }
async function save(hook: ReturnType<typeof mount>) {
  act(() => hook.result.current.beginSave())
  act(() => hook.result.current.setSessionName('draft'))
  await act(async () => { await hook.result.current.saveSession() })
}
it('retains applied create receipt and retries only flush, then updates using its new token', async () => {
  storage.save.mockResolvedValueOnce({ data, persistence: failed })
  const hook = mount(); await save(hook)
  expect(hook.result.current.identity).toMatchObject({ sessionId: 'new-id', revision: 2, versionToken: 'new-token' })
  expect(hook.result.current.pendingSave).toMatchObject({ sessionId: 'new-id' })
  expect(hook.onSaved).not.toHaveBeenCalled()
  await act(async () => { await hook.result.current.saveSession(true) })
  expect(storage.save).toHaveBeenCalledTimes(1)
  const originalSnapshot = structuredClone(storage.save.mock.calls[0][2].state)
  act(() => store.dispatch(selectionApplied({ operation: 'replace', rowIds: ['a1'] })))
  storage.flush.mockResolvedValueOnce(failed)
  await act(async () => { await hook.result.current.retryPersistence() })
  expect(hook.result.current.pendingSave).not.toBeNull()
  expect(hook.onSaved).not.toHaveBeenCalled()
  await act(async () => { await hook.result.current.retryPersistence() })
  expect(storage.save).toHaveBeenCalledTimes(1)
  expect(hook.result.current.pendingSave).toBeNull()
  expect(storage.save.mock.calls[0][2].state).toEqual(originalSnapshot)
  expect(hook.onSaved).toHaveBeenCalledWith(expect.stringContaining('その後の画面変更は含みません'))
  storage.save.mockResolvedValueOnce({ data: { ...data, revision: 3 }, persistence: durable })
  await act(async () => { await hook.result.current.saveSession() })
  expect(storage.save).toHaveBeenLastCalledWith('/sessions/new-id', 'PUT', expect.objectContaining({ versionToken: 'new-token' }))
})
it('retains applied update revision and does not replay it after flush rejection', async () => {
  storage.save.mockResolvedValueOnce({ data, persistence: durable })
  const hook = mount(); await save(hook)
  storage.save.mockResolvedValueOnce({ data: { ...data, revision: 3, versionToken: 'r3' }, persistence: failed })
  await save(hook)
  storage.flush.mockRejectedValueOnce(new Error('still blocked'))
  await act(async () => { await hook.result.current.retryPersistence() })
  expect(hook.result.current.identity?.versionToken).toBe('r3')
  expect(hook.result.current.pendingSave?.revision).toBe(3)
  expect(storage.save).toHaveBeenCalledTimes(2)
  expect(hook.onSaved).toHaveBeenCalledTimes(1)
})
it('clears pending receipt only on confirmed durability, including successful later operation', async () => {
  storage.save.mockResolvedValueOnce({ data, persistence: failed })
  const hook = mount(); await save(hook)
  act(() => listener({ ...failed, error: null }))
  expect(hook.result.current.pendingSave).not.toBeNull()
  act(() => listener(durable))
  expect(hook.result.current.pendingSave).toBeNull()
  expect(hook.onSaved).toHaveBeenCalledTimes(1)
  act(() => listener(durable))
  expect(hook.onSaved).toHaveBeenCalledTimes(1)
})
it('preflights temporary mode without creating a session or attempting unsafe recovery', async () => {
  storage.getState.mockReturnValue({ mode: 'temporary', pending: true, error: 'populate failed' })
  const hook = mount(); await save(hook)
  expect(storage.save).not.toHaveBeenCalled()
  expect(hook.result.current.saveError).toContain('セッション保存は実行していません')
  await act(async () => { await hook.result.current.retryPersistence() })
  expect(storage.flush).not.toHaveBeenCalled()
})
it('flush retries are single flight', async () => {
  storage.save.mockResolvedValueOnce({ data, persistence: failed })
  const hook = mount(); await save(hook)
  let resolve!: (state: PersistenceState) => void
  storage.flush.mockReturnValue(new Promise<PersistenceState>(done => { resolve = done }))
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.retryPersistence(); void hook.result.current.retryPersistence() })
  expect(storage.flush).toHaveBeenCalledTimes(1)
  expect(hook.result.current.flushBusy).toBe(true)
  await act(async () => { resolve(durable); await pending })
  await waitFor(() => expect(hook.result.current.flushBusy).toBe(false))
})
