/** Durability is independent of a successful in-memory API operation. */
export interface PersistenceState {
  mode: 'persistent' | 'temporary'
  pending: boolean
  error: string | null
}

export interface PersistenceReceipt<T> {
  data: T
  persistence: PersistenceState
}
