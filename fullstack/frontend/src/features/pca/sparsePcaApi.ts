import { api } from '../../api/client'
import type { SparsePcaContext, SparsePcaExportTable, SparsePcaRequest, SparsePcaResponse, SparsePcaRowsResponse } from './sparsePcaTypes'

// The static Python worker is serial. Keep this lane outside component lifetime:
// cancel, remount, navigation and dataset switches must not enqueue another fit.
let fitPending = false
const pendingListeners = new Set<() => void>()
export const isSparsePcaFitPending = () => fitPending
export const subscribeSparsePcaFit = (listener: () => void) => {
  pendingListeners.add(listener)
  return () => { pendingListeners.delete(listener) }
}
function setFitPending(value: boolean) {
  fitPending = value
  for (const listener of pendingListeners) listener()
}
export async function runSparsePca(request: SparsePcaRequest): Promise<SparsePcaResponse> {
  if (fitPending) throw new Error('前のSparsePCA計算が終了するまでお待ちください。')
  setFitPending(true)
  try { return await api.post<SparsePcaResponse>('/models/sparse-pca', request) }
  finally { setFitPending(false) }
}

export function fetchSparsePcaRows(resultId: string, offset: number, limit: number, axes: number[]): Promise<SparsePcaRowsResponse> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit), axes: axes.join(',') })
  return api.get(`/analysis-results/${encodeURIComponent(resultId)}/rows?${params.toString()}`)
}

export function selectSparsePca(resultId: string, context: SparsePcaContext,
  selector: { kind: 'row_ids'; rowIds: string[] } | { kind: 'rectangle'; axes: number[]; bounds: [number, number][] }) {
  return api.post<{ status: string; resultId: string; rowIds: string[]; matchedCount: number; fitMatchedCount: number;
    contextIntersectionCount: number; selectionLabel: string }>(`/analysis-results/${encodeURIComponent(resultId)}/select`, { context, selector })
}

export interface SparsePcaExportResponse {
  fileName: string
  mime: string
  payload: string
  nextOffset?: number | null
}

/** Combine every export page without losing diagnostics/meaning metadata. */
export async function prepareSparsePcaExport(resultId: string, table: SparsePcaExportTable,
  format: 'csv' | 'json', isCurrent: () => boolean = () => true): Promise<SparsePcaExportResponse | null> {
  const path = `/analysis-results/${encodeURIComponent(resultId)}/export`
  const parts: string[] = []
  let offset = 0
  let first: SparsePcaExportResponse | null = null
  let jsonBody: Record<string, unknown> | null = null
  for (;;) {
    if (!isCurrent()) return null
    const page = await api.post<SparsePcaExportResponse>(path, { format, table, offset, limit: 5000 })
    if (!isCurrent()) return null
    if (!first) first = page
    if (format === 'json' && table !== 'manifest') {
      const body = JSON.parse(page.payload) as Record<string, unknown> & { columns: string[]; rows: unknown[][] }
      if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) throw new Error('エクスポートの表形式が不正です。')
      if (!jsonBody) jsonBody = { ...body, columns: [...body.columns], rows: [...body.rows] }
      else {
        if (JSON.stringify(jsonBody.columns) !== JSON.stringify(body.columns)) throw new Error('エクスポートの列が途中で変更されました。')
        ;(jsonBody.rows as unknown[][]).push(...body.rows)
      }
    } else if (format === 'csv' && offset > 0) {
      // Column headings cannot contain line breaks; values remain untouched,
      // including quoted multiline values and the backend's formula escaping.
      const newline = page.payload.indexOf('\n')
      parts.push(newline < 0 ? '' : page.payload.slice(newline + 1))
    } else parts.push(page.payload)
    if (page.nextOffset == null) break
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('エクスポートのページ位置が不正です。')
    offset = page.nextOffset
  }
  return { ...first!, payload: jsonBody ? JSON.stringify(jsonBody, null, 2) : parts.join(''), nextOffset: null }
}

export async function exportSparsePcaTable(resultId: string, table: SparsePcaExportTable,
  format: 'csv' | 'json', isCurrent: () => boolean = () => true): Promise<void> {
  const output = await prepareSparsePcaExport(resultId, table, format, isCurrent)
  if (!output || !isCurrent()) return
  const url = URL.createObjectURL(new Blob([output.payload], { type: `${output.mime};charset=utf-8` }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = output.fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
