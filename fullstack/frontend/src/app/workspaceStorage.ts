import { api } from '../api/client'
import { IS_STATIC_BUILD } from '../engine/buildMode'
import { pyodideClient } from '../engine/pyodideClient'
import type { PersistenceReceipt, PersistenceState } from '../engine/persistence'

const serverState: PersistenceState = { mode: 'persistent', pending: false, error: null }
export const workspaceStorage = {
  getState: (): PersistenceState => IS_STATIC_BUILD ? pyodideClient.getPersistence() : serverState,
  subscribe: (listener: (state: PersistenceState) => void): (() => void) =>
    IS_STATIC_BUILD ? pyodideClient.onPersistence(listener) : () => {},
  flush: (): Promise<PersistenceState> => IS_STATIC_BUILD ? pyodideClient.flushPersistence() : Promise.resolve(serverState),
  save: async <T,>(path: string, method: 'POST' | 'PUT', body: unknown): Promise<PersistenceReceipt<T>> => {
    if (IS_STATIC_BUILD) return pyodideClient.requestWithPersistence<T>(path, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = method === 'POST' ? await api.post<T>(path, body) : await api.put<T>(path, body)
    return { data, persistence: serverState }
  },
}
