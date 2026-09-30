import { api } from '../../api/client'
import type { ConjointResponse } from './conjointTypes'

export interface ConjointContext {
  datasetId: string
  expectedDataRevision: number
  expectedSchemaRevision: number
  scope: 'all' | 'active' | 'selected' | 'sampled' | 'explicit'
  activeRowIds?: string[]
  selectedRowIds?: string[]
  sampledRowIds?: string[]
  rowIds?: string[]
  weightMode: 'dataset' | 'none' | 'column'
  weightColumn?: string
  weightType?: 'survey' | 'frequency'
  missingPolicy: string
}

export interface ConjointAttribute {
  columnId: string
  kind: 'categorical' | 'linear'
  referenceLevel?: string | null
  utilityRange?: [number, number] | null
}

export async function runConjoint(
  context: ConjointContext,
  mode: 'ratings' | 'choice' | 'ranking',
  columns: Record<string, string>,
  attributes: ConjointAttribute[],
  ratingEffects: 'pooled' | 'respondent_fixed',
  priceAttribute: string | null,
): Promise<ConjointResponse> {
  return api.post<ConjointResponse>('/models/conjoint', {
    method: 'conjoint', context, mode, columns, attributes, ratingEffects,
    priceAttribute, confidenceLevel: 0.95, maxIterations: 1000,
  })
}

export interface ConjointExpandScopeResponse {
  status: string
  originalRowCount: number
  expandedRowCount: number
  addedRowCount: number
  expandedRowIds: string[]
  // G006-11: FE側で付与する拡張元条件（API応答には含まれない）。
  mapping?: Record<string, string>
  scopeSnapshot?: string
  dataRevision?: number
  schemaRevision?: number
}

export async function expandConjointScope(
  context: ConjointContext,
  columns: Record<string, string>,
): Promise<ConjointExpandScopeResponse> {
  return api.post('/models/conjoint/expand-scope', { context, columns })
}

export interface ConjointSelectResponse {
  status: string
  resultId: string
  rowIds: string[]
  matchedCount: number
  fitMatchedCount: number
  contextIntersectionCount: number
  selectionLabel: string
}

export async function selectConjoint(
  resultId: string,
  context: ConjointContext,
  selector:
    | { kind: 'row_ids'; rowIds: string[] }
    | { kind: 'respondents'; respondentIds: string[] },
): Promise<ConjointSelectResponse> {
  return api.post<ConjointSelectResponse>(`/analysis-results/${resultId}/select`, { context, selector })
}

export interface ConjointFitRow {
  rowId: string
  respondentId: string
  taskId: string
  alternativeId: string
  observed: number | null
  predictedRating: number | null
  probability: number | null
  residual: number | null
  predictionStatus: string
}

export async function fetchConjointRows(
  resultId: string,
  offset: number,
  limit: number,
): Promise<{ total: number; nextOffset: number | null; rows: ConjointFitRow[] }> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return api.get(`/analysis-results/${resultId}/rows?${params.toString()}`)
}

export interface ConjointPredictResponse {
  status: string
  resultId: string
  predictionId: string
  summary: {
    requestedCount: number
    successfulPredictions: number
    failedPredictions: number
    statusCounts: Record<string, number>
    evaluation: {
      fitOverlapCount: number
      fitOverlapRespondentCount: number
      fitOverlapRespondents: string[]
      newTaskKnownRespondentCount: number
      nonFitEvaluationCount: number
      note: string
    } | null
  }
}

export interface ConjointPredictRow {
  rowId: string
  respondentId: string
  taskId: string
  alternativeId: string
  predictedRating: number | null
  probability: number | null
  residual: number | null
  observed: number | null
  predictionStatus: string
}

export async function predictConjoint(
  resultId: string,
  context: ConjointContext,
): Promise<ConjointPredictResponse> {
  return api.post<ConjointPredictResponse>(`/analysis-results/${resultId}/predict`, {
    context, options: { interval: 'none', evaluate: true },
  })
}

export async function fetchConjointPredictions(
  resultId: string,
  predictionId: string,
  offset: number,
  limit: number,
): Promise<{ total: number; nextOffset: number | null; rows: ConjointPredictRow[] }> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return api.get(`/analysis-results/${resultId}/predictions/${predictionId}/rows?${params.toString()}`)
}

export interface ConjointSimProfile {
  alternativeId: string
  values: Record<string, string | number>
  optOut?: boolean
}

export interface ConjointSimResult {
  status: string
  resultId: string
  profiles: { alternativeId: string; utility: number; predictedRating: number | null; probability: number | null; firstChoiceShare: number | null }[]
  attributeImportance: ConjointResponse['details']['attributeImportance']
  wtp: ConjointResponse['details']['wtp']
  warnings: { code: string; message: string; count?: number | null; columnIds?: string[] }[]
}

export async function simulateConjoint(
  resultId: string,
  context: ConjointContext,
  profiles: ConjointSimProfile[],
  includeWtp: boolean,
): Promise<ConjointSimResult> {
  return api.post<ConjointSimResult>(`/models/conjoint/${resultId}/simulate`, {
    context, profiles, includeWtp,
  })
}

export interface ConjointCreatedColumn {
  columnId: string
  name: string
  label: string
  sourceField: string
  nonNullCount?: number
}

export async function materializeConjoint(
  resultId: string,
  context: ConjointContext,
  source: string,
  columns: { sourceField: string; name: string; label?: string }[],
  idempotencyKey: string,
): Promise<{ operationId: string; datasetId: string; dataRevision: number; schemaRevision: number; createdColumns: ConjointCreatedColumn[]; writtenRowCount: number; idempotentReplay: boolean }> {
  return api.post(`/analysis-results/${resultId}/materialize`, { context, source, columns, idempotencyKey })
}

export interface ConjointTableData {
  columns: string[]
  rows: unknown[][]
  total: number
}

export async function fetchConjointTable(
  resultId: string,
  table: 'manifest' | 'coefficients' | 'diagnostics' | 'rows' | 'utilities',
  _format: 'json' | 'csv' = 'json',
): Promise<ConjointTableData> {
  let offset = 0
  const columns: string[] = []
  const rows: unknown[][] = []
  let total = 0
  for (;;) {
    const res = await api.post<{ payload: string; nextOffset: number | null; total: number }>(
      `/analysis-results/${resultId}/export`, { format: 'json', table, offset, limit: 5000 },
    )
    const body = JSON.parse(res.payload) as { columns: string[]; rows: unknown[][] }
    if (offset === 0) columns.push(...body.columns)
    rows.push(...body.rows)
    total = res.total
    if (res.nextOffset === null || res.nextOffset === undefined) break
    offset = res.nextOffset
  }
  return { columns, rows, total }
}

export async function exportConjointTable(
  resultId: string,
  table: 'manifest' | 'coefficients' | 'diagnostics' | 'rows' | 'utilities',
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
  img.onload = (): void => {
    const canvas = document.createElement('canvas')
    canvas.width = 960
    canvas.height = 640
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (!blob) return
        const a2 = document.createElement('a')
        a2.href = URL.createObjectURL(blob)
        a2.download = fileName
        document.body.appendChild(a2)
        a2.click()
        a2.remove()
      })
    }
    URL.revokeObjectURL(url)
  }
  img.src = url
}
