import { api } from '../../api/client'
import type { LRResponse } from './lrTypes'

export interface LRContext {
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

export interface LRPredictor {
  columnId: string
  kind: 'numeric' | 'categorical'
  ordinalAsNumericAcknowledged?: boolean
  score?: 'ordered_rank' | null
  referenceCategory?: string | null
}

export async function runLinearRegression(
  context: LRContext,
  target: string,
  predictors: LRPredictor[],
  interactions: string[][],
  intercept: boolean,
  covariance: 'auto' | 'hc3' | 'classical' | 'taylor',
  confidenceLevel: number,
): Promise<LRResponse> {
  return api.post<LRResponse>('/models/linear-regression', {
    context, target, predictors, interactions, intercept, covariance, confidenceLevel,
  })
}

export interface LRSelectResponse {
  status: string
  resultId: string
  rowIds: string[]
  matchedCount: number
  fitMatchedCount: number
  contextIntersectionCount: number
  selectionLabel: string
}

export async function selectLinearRegression(
  resultId: string,
  context: LRContext,
  selector:
    | { kind: 'diagnostic_rectangle'; xField: string; yField: string; xBounds: [number, number]; yBounds: [number, number] }
    | { kind: 'row_ids'; rowIds: string[] },
): Promise<LRSelectResponse> {
  return api.post<LRSelectResponse>(`/analysis-results/${resultId}/select`, { context, selector })
}

export interface LRFitRow {
  rowId: string
  observed: number | null
  fitted: number | null
  residual: number | null
  leverageTotal: number | null
  leveragePerReplica: number | null
  studentizedResidual: number | null
  cooksDistance: number | null
}

export async function fetchLinearRegressionRows(
  resultId: string,
  offset: number,
  limit: number,
): Promise<{ total: number; nextOffset: number | null; rows: LRFitRow[] }> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return api.get(`/analysis-results/${resultId}/rows?${params.toString()}`)
}

export interface LRPredictResponse {
  status: string
  resultId: string
  predictionId: string
  summary: {
    requestedCount: number
    successfulPredictions: number
    failedPredictions: number
    statusCounts: Record<string, number>
    evaluation: {
      evaluatedCount: number
      fitOverlapCount: number
      nonFitEvaluationCount: number
      metrics: { rmse: number | null; mae: number | null; rSquared: number | null } | null
    } | null
  }
}

export interface LRPredictRow {
  rowId: string
  predicted: number | null
  observed: number | null
  residual: number | null
  meanCiLower: number | null
  meanCiUpper: number | null
  individualPiLower: number | null
  individualPiUpper: number | null
  predictionStatus: string
}

export async function predictLinearRegression(
  resultId: string,
  context: LRContext,
  interval: 'none' | 'mean_ci' | 'individual_pi',
  evaluate: boolean,
): Promise<LRPredictResponse> {
  return api.post<LRPredictResponse>(`/analysis-results/${resultId}/predict`, {
    context, options: { interval, evaluate },
  })
}

export async function fetchLinearRegressionPredictions(
  resultId: string,
  predictionId: string,
  offset: number,
  limit: number,
): Promise<{ total: number; nextOffset: number | null; rows: LRPredictRow[] }> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return api.get(`/analysis-results/${resultId}/predictions/${predictionId}/rows?${params.toString()}`)
}

export async function materializeLinearRegression(
  resultId: string,
  context: LRContext,
  source: string,
  columns: { sourceField: string; name: string; label?: string }[],
  idempotencyKey: string,
): Promise<{ operationId: string; datasetId: string; dataRevision: number; schemaRevision: number; createdColumns: { columnId: string; name: string; label: string; sourceField: string }[]; writtenRowCount: number; idempotentReplay: boolean }> {
  return api.post(`/analysis-results/${resultId}/materialize`, { context, source, columns, idempotencyKey })
}

export async function exportLinearRegressionTable(
  resultId: string,
  table: 'manifest' | 'coefficients' | 'diagnostics' | 'rows',
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

export { downloadSvg, downloadPng } from '../charts/chartExport'
