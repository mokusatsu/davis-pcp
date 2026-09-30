import { api } from '../../api/client'

export interface EFAContext {
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

export interface EFAVariable {
  columnId: string
  measurement: 'ordinal' | 'continuous'
  treatment: 'ordinal' | 'continuous' | 'continuous_approximation'
  categoryOrder?: string[] | null
  reverse?: boolean
  approximationAcknowledged?: boolean
}

export interface EFAResponse {
  status: string
  resultId: string
  method: string
  meta: Record<string, unknown> & {
    datasetId: string
    dataRevision: number
    schemaRevision: number
    resultState: string
    fitCount: number
    scopeCount: number
    excludedCount: number
    exclusionCounts: Record<string, number>
  }
  config: Record<string, unknown>
  capabilities: {
    rows: boolean
    projection: boolean
    materialize: boolean
    selectionKinds: string[]
    exportTables: string[]
    materializeFitFields: string[]
    materializePredictionFields: string[]
  }
  summary: {
    computationStatus: string
    solutionStatus: string
    nVariables: number
    nFactors: number
    modelDf: number
    objective: { id: string; value: number | null; offDiagonalSse: number | null }
    rmsr: number | null
    totalCommunalityRatio: number | null
    inferenceStatus: string
    scoreMethod: string
  }
  details: {
    variables: { columnId: string; label: string }[]
    factorIds: string[]
    factorLabels: string[]
    pattern: number[][]
    structure: number[][]
    factorCorrelation: number[][]
    communality: number[]
    uniqueness: number[]
    sampleCorrelation: number[][]
    reproducedCorrelation: number[][]
    residualCorrelation: number[][]
    thresholds: { columnId: string; cuts: number[] }[] | null
    parallelAnalysis: {
      status: string
      observedEigenvalues: number[] | null
      referenceQuantiles: number[] | null
      suggestedFactors: number | null
      reasonCode: string | null
    }
    factorComparisons: { q: number; status: string }[]
    distributionProfiles: Record<string, unknown>[]
    sensitivityAnalysis?: { enabled: boolean; comparisonId: string; status: string } | null
    referenceInference?: {
      status: string
      fit?: { statistic: number | null; df: number; pValue: number | null; rmsea: number | null; reasonCode: string | null } | null
      kmo?: number | null
      bartlett?: { statistic: number | null; df: number; pValue: number | null; reasonCode: string | null } | null
    } | null
    correlationPairs?: { pair: number[]; rho: number | null; status: string; reasonCode: string | null; zeroCells: number; smallCells: number; boundary: boolean }[] | null
    solutionDiagnostics?: { code: string; severity: string; stage: string }[] | null
    optimizerStarts?: { startIndex: number; status: string; iterations: number; objective: number | null; projectedGradientNorm: number | null }[] | null
  }
  unavailableReasons: Record<string, unknown>
}

export async function runEFA(body: Record<string, unknown>): Promise<EFAResponse> {
  return api.post<EFAResponse>('/models/factor-analysis', body)
}

export async function fetchEFARows(
  resultId: string,
  offset: number,
  limit: number,
): Promise<{ total: number; nextOffset: number | null; rows: { rowId: string; scores: (number | null)[] }[] }> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  return api.get(`/analysis-results/${resultId}/rows?${params.toString()}`)
}

export async function fetchAllEFARows(
  resultId: string,
): Promise<{ rowId: string; scores: (number | null)[] }[]> {
  const out: { rowId: string; scores: (number | null)[] }[] = []
  let offset: number | null = 0
  for (;;) {
    const page = await fetchEFARows(resultId, offset ?? 0, 5000)
    out.push(...page.rows)
    if (page.nextOffset === null || page.nextOffset === undefined) break
    offset = page.nextOffset
  }
  return out
}

export async function selectEFA(
  resultId: string,
  context: EFAContext,
  selector: { kind: 'row_ids'; rowIds: string[] } | { kind: 'rectangle'; axes: number[]; bounds: [number, number][] },
): Promise<{ rowIds: string[]; matchedCount: number }> {
  return api.post(`/analysis-results/${resultId}/select`, { context, selector })
}

export async function predictEFA(resultId: string, context: EFAContext): Promise<{ predictionId: string }> {
  return api.post(`/analysis-results/${resultId}/predict`, { context, options: { interval: 'none', evaluate: false } })
}

export async function materializeEFA(
  resultId: string,
  context: EFAContext,
  source: string,
  columns: { source: string; name: string }[],
  idempotencyKey: string,
): Promise<Record<string, unknown> & { dataRevision?: number; schemaRevision?: number }> {
  return api.post(`/analysis-results/${resultId}/materialize`, { context, source, columns, idempotencyKey })
}

export async function exportEFATable(
  resultId: string,
  table: 'manifest' | 'variables' | 'diagnostics' | 'parallel_analysis' | 'factor_comparisons' | 'rows',
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

export async function fetchEFAComparison(comparisonId: string): Promise<Record<string, unknown>> {
  return api.get(`/analysis-comparisons/${comparisonId}`)
}

export async function cancelEFAComparison(comparisonId: string): Promise<Record<string, unknown>> {
  return api.post(`/analysis-comparisons/${comparisonId}/cancel`, {})
}
