import { useSyncExternalStore } from 'react'

// A submitted transform outlives its dialog, including dataset/page remounts.
const owners = new Map<string, symbol>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const notify = () => { for (const listener of listeners) listener() }

export function useOneHotMutationLock(datasetId: string, sourceColumn: string) {
  const key = JSON.stringify([datasetId, sourceColumn])
  const pending = useSyncExternalStore(subscribe, () => owners.has(key))
  const acquire = (): (() => void) | null => {
    if (owners.has(key)) return null
    const owner = Symbol()
    owners.set(key, owner)
    notify()
    // Only this request can release its lock; repeated/obsolete releases are
    // harmless even after another request acquires the same dataset/source.
    return () => {
      if (owners.get(key) !== owner) return
      owners.delete(key)
      notify()
    }
  }
  return { pending, acquire }
}
