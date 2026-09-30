import { api } from '../../api/client'
import type { MCAResponse } from './mcaTypes'

export interface MCAContext {
  datasetId: string
  expectedDataRevision: number
  expectedSchemaRevision: number
  scope: 'all' | 'active' | 'selected' | 'sampled' | 'explicit'
  activeRowIds?: string[]
  selectedRowIds?: string[]
  sampledRowIds?: string[]
  rowIds?: string[]
  weightMode: 'dataset' | 'none'
  missingPolicy: string
}

export async function runMca(
  context: MCAContext,
  variables: string[],
  maMode: 'ordinary_only' | 'explicit_binary_options',
  inertiaAdjustment: 'raw' | 'benzecri',
): Promise<MCAResponse> {
  return api.post<MCAResponse>('/models/mca', { context, variables, maMode, inertiaAdjustment })
}

export interface MCASelectResponse {
  status: string
  resultId: string
  rowIds: string[]
  matchedCount: number
  fitMatchedCount: number
  contextIntersectionCount: number
  selectionLabel: string
}

export async function selectMca(
  resultId: string,
  context: MCAContext,
  selector:
    | { kind: 'categories'; categoryIds: string[]; betweenVariables: 'and' | 'or' }
    | { kind: 'rectangle'; axes: number[]; bounds: [number, number][] }
    | { kind: 'row_ids'; rowIds: string[] }
    | { kind: 'rowIds'; rowIds: string[] },
): Promise<MCASelectResponse> {
  return api.post<MCASelectResponse>(`/analysis-results/${resultId}/select`, { context, selector })
}

export async function fetchMcaRows(
  resultId: string,
  offset: number,
  limit: number,
  axes?: number[],
): Promise<{ total: number; nextOffset: number | null; axes: number[]; rows: { rowId: string; coordinates: number[] }[] }> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  if (axes) params.set('axes', axes.join(','))
  return api.get(`/analysis-results/${resultId}/rows?${params.toString()}`)
}

export async function exportMcaTable(
  resultId: string,
  table: 'eigenvalues' | 'categories' | 'rows' | 'manifest',
  format: 'json' | 'csv',
): Promise<void> {
  const download = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (table === 'manifest') {
    const res = await api.post<{ mime: string; fileName: string; payload: string }>(
      `/analysis-results/${resultId}/export`, { format, table },
    )
    download(new Blob([res.payload], { type: 'application/json;charset=utf-8' }), res.fileName)
    return
  }
  if (format === 'json') {
    let offset = 0
    const columns: string[] = []
    const rows: unknown[][] = []
    let fileName = `${resultId}-${table}.json`
    for (;;) {
      const res = await api.post<{ fileName: string; payload: string; nextOffset: number | null }>(
        `/analysis-results/${resultId}/export`, { format, table, offset, limit: 5000 },
      )
      fileName = res.fileName
      const body = JSON.parse(res.payload) as { columns: string[]; rows: unknown[][] }
      if (offset === 0) columns.push(...body.columns)
      rows.push(...body.rows)
      if (res.nextOffset === null || res.nextOffset === undefined) break
      offset = res.nextOffset
    }
    download(new Blob([JSON.stringify({ columns, rows }, null, 2)], { type: 'application/json;charset=utf-8' }), fileName)
    return
  }
  const parts: string[] = []
  let fileName = `${resultId}-${table}.csv`
  let offset = 0
  for (;;) {
    const res = await api.post<{ fileName: string; payload: string; nextOffset: number | null }>(
      `/analysis-results/${resultId}/export`, { format, table, offset, limit: 5000 },
    )
    fileName = res.fileName
    const lines = res.payload.split('\n')
    if (offset === 0) {
      parts.push(res.payload)
    } else {
      const headerEnd = lines.findIndex((l) => l.length > 0 && !l.startsWith('#'))
      parts.push(lines.slice(headerEnd + 1).join('\n'))
    }
    if (res.nextOffset === null || res.nextOffset === undefined) break
    offset = res.nextOffset
  }
  download(new Blob([parts.join('')], { type: 'text/csv;charset=utf-8' }), fileName)
}

export { downloadSvg } from '../charts/chartExport'

export function downloadPng(svg: SVGSVGElement, fileName: string): void {
  const text = new XMLSerializer().serializeToString(svg)
  const img = new Image()
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }))
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 640
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (blob) {
          const out = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = out
          anchor.download = fileName
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(out), 1000)
        }
        URL.revokeObjectURL(url)
      })
    } else {
      URL.revokeObjectURL(url)
    }
  }
  img.src = url
}
