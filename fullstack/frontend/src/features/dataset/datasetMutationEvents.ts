/** Completion survives a dialog/page unmount; each subscriber checks its current dataset. */
const listeners = new Set<(datasetId: string) => void>()

export function notifyDatasetMutationCommitted(datasetId: string) {
  for (const listener of listeners) listener(datasetId)
}

export function onDatasetMutationCommitted(listener: (datasetId: string) => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
