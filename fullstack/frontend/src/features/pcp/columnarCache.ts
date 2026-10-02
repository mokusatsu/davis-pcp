import type { ColumnarData } from './useDatasetColumns'

// These bounds cover cache-owned references, not the data still used by mounted
// views. Large results remain usable by their consumers without being cached.
export const COLUMNAR_CACHE_MAX_ENTRIES = 8
export const COLUMNAR_CACHE_MAX_BYTES = 64 * 1024 * 1024

export interface ColumnarCacheContext {
  datasetId: string
  dataRevision: number
  // Raw columns do not depend on codebook-only changes; MA projections do.
  schemaRevision: number | null
}

interface CacheEntry {
  context: ColumnarCacheContext
  data: ColumnarData
  bytes: number
}
interface PendingLoad {
  context: ColumnarCacheContext
  consumers: Set<(data: ColumnarData) => void>
}

const cache = new Map<string, CacheEntry>()
const pending = new Map<string, PendingLoad>()
let retainedBytes = 0
let generation = 0
const invalidationListeners = new Set<() => void>()

/** Conservative JS retention estimate, not an engine-specific heap measurement. */
function estimateBytes(data: ColumnarData): number {
  const seen = new Set<object>()
  let bytes = 0
  const visit = (value: unknown): void => {
    if (bytes > COLUMNAR_CACHE_MAX_BYTES || value == null) return
    if (typeof value === 'string') { bytes += 24 + 2 * value.length; return }
    if (typeof value === 'number' || typeof value === 'bigint') { bytes += 8; return }
    if (typeof value === 'boolean') { bytes += 4; return }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    bytes += 64
    if (ArrayBuffer.isView(value)) { visit(value.buffer); return }
    if (value instanceof ArrayBuffer) { bytes += value.byteLength; return }
    if (Array.isArray(value)) {
      bytes += 8 * value.length
      for (const item of value) { visit(item); if (bytes > COLUMNAR_CACHE_MAX_BYTES) break }
    } else if (value instanceof Map) {
      bytes += 32 * value.size
      for (const [key, item] of value) {
        visit(key); visit(item)
        if (bytes > COLUMNAR_CACHE_MAX_BYTES) break
      }
    } else {
      for (const [key, item] of Object.entries(value)) {
        bytes += 16
        visit(key); visit(item)
        if (bytes > COLUMNAR_CACHE_MAX_BYTES) break
      }
    }
  }
  visit(data)
  return bytes
}

function removeCached(key: string): void {
  const entry = cache.get(key)
  if (!entry) return
  retainedBytes -= entry.bytes
  cache.delete(key)
}

function remember(key: string, context: ColumnarCacheContext, data: ColumnarData): void {
  const bytes = estimateBytes(data) + 128 + 2 * (key.length + context.datasetId.length)
  removeCached(key)
  if (bytes > COLUMNAR_CACHE_MAX_BYTES) return
  cache.set(key, { context, data, bytes })
  retainedBytes += bytes
  while (cache.size > COLUMNAR_CACHE_MAX_ENTRIES || retainedBytes > COLUMNAR_CACHE_MAX_BYTES) {
    removeCached(cache.keys().next().value!)
  }
}

export function readColumnarCache(key: string): ColumnarData | null {
  const entry = cache.get(key)
  if (!entry) return null
  // Map iteration order is the LRU order. Reading is the only recency signal;
  // unrelated renders/selection changes do not keep an unused projection hot.
  cache.delete(key)
  cache.set(key, entry)
  return entry.data
}

/**
 * Drop references from an obsolete dataset/revision, including old MA schemas.
 * In-flight consumers still own their request until cleanup/completion, but a
 * retired request cannot enter the cache or replace a newer identical request.
 */
export function retainColumnarCacheScope(scope: { datasetId: string | null; dataRevision: number; schemaRevision: number }): void {
  const current = (context: ColumnarCacheContext) => context.datasetId === scope.datasetId
    && context.dataRevision === scope.dataRevision
    && (context.schemaRevision === null || context.schemaRevision === scope.schemaRevision)
  for (const [key, entry] of cache) if (!current(entry.context)) removeCached(key)
  for (const [key, load] of pending) if (!current(load.context)) pending.delete(key)
}

export function invalidateColumnarCache(): void {
  cache.clear()
  retainedBytes = 0
  // Remove React callbacks as well as map references. Invalidated responses must
  // not publish stale data to mounted consumers, even when their key is unchanged.
  for (const load of pending.values()) load.consumers.clear()
  pending.clear()
  generation += 1
  for (const notify of invalidationListeners) notify()
}

export const getColumnarCacheGeneration = () => generation
export function subscribeColumnarCacheInvalidation(notify: () => void): () => void {
  invalidationListeners.add(notify)
  return () => { invalidationListeners.delete(notify) }
}

// Keep promise callbacks outside acquireColumnarData's lexical scope, so an
// unsettled transport cannot retain its individual consumer callback after release.
function startLoad(key: string, request: PendingLoad, load: () => Promise<ColumnarData>): void {
  const requestGeneration = generation
  let result: Promise<ColumnarData>
  try { result = load() } catch (error) { result = Promise.reject(error) }
  void result.then(data => {
    const ownsKey = pending.get(key) === request
    if (ownsKey) pending.delete(key)
    try {
      if (requestGeneration !== generation || request.consumers.size === 0) return
      if (ownsKey) remember(key, request.context, data)
      // A subscriber arriving while callbacks run must see the completed cache
      // entry or start a new oversize load, never join an already-delivered request.
      for (const callback of request.consumers) callback(data)
    } finally {
      request.consumers.clear()
    }
  }, () => {
    request.consumers.clear()
    if (pending.get(key) === request) pending.delete(key)
  }).catch(() => undefined)
}

/** Subscribe to a shared request; cleanup releases the callback immediately. */
export function acquireColumnarData(
  key: string,
  context: ColumnarCacheContext,
  load: () => Promise<ColumnarData>,
  receive: (data: ColumnarData) => void,
): () => void {
  const cached = readColumnarCache(key)
  if (cached) { receive(cached); return () => {} }
  let shared = pending.get(key)
  if (!shared) {
    shared = { context, consumers: new Set([receive]) }
    pending.set(key, shared)
    startLoad(key, shared, load)
  }
  const request = shared
  request.consumers.add(receive)
  return () => {
    request.consumers.delete(receive)
    if (request.consumers.size === 0 && pending.get(key) === request) pending.delete(key)
  }
}

/** Read-only counters for bounded-retention regression checks/diagnostics. */
export function getColumnarCacheStats() {
  return {
    entries: cache.size,
    estimatedBytes: retainedBytes,
    pendingLoads: pending.size,
    pendingConsumers: [...pending.values()].reduce((count, load) => count + load.consumers.size, 0),
  }
}
