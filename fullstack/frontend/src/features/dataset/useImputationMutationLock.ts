import { useSyncExternalStore } from 'react'

// An imputation can target several columns and outlives its dialog. Dataset
// ownership prevents remounts or changed target/strategy choices from resubmitting.
const owners = new Map<string, symbol>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const notify = () => { for (const listener of listeners) listener() }

export function useImputationMutationLock(datasetId: string) {
  const pending = useSyncExternalStore(subscribe, () => owners.has(datasetId))
  const acquire = (): (() => void) | null => {
    if (owners.has(datasetId)) return null
    const owner = Symbol()
    owners.set(datasetId, owner)
    notify()
    // Only this request may release its owner, including after its dialog unmounts.
    return () => {
      if (owners.get(datasetId) !== owner) return
      owners.delete(datasetId)
      notify()
    }
  }
  return { pending, acquire }
}
