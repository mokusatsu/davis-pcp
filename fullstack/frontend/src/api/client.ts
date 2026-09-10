import { pyodideClient } from '../engine/pyodideClient'

const BASE = '/api/v1'

export const IS_STATIC_BUILD =
  import.meta.env.VITE_STATIC_BUILD === 'true' ||
  (typeof window !== 'undefined' && (window as any).__DAVIS_PCP_STATIC__ === true)

export interface ApiError {
  code: string
  message: string
  details: Record<string, unknown>
  recoverable: boolean
  suggestedActions: string[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (IS_STATIC_BUILD) {
    return pyodideClient.request<T>(path, init)
  }

  const response = await fetch(`${BASE}${path}`, init)
  if (!response.ok) {
    let error: ApiError = { code: 'HTTP_ERROR', message: `HTTP ${response.status}`, details: {}, recoverable: true, suggestedActions: [] }
    try {
      const body = await response.json()
      if (body.error) error = body.error
    } catch { /* keep default */ }
    throw error
  }
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('json')) return response.json()
  return response as unknown as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  downloadBlob: async (path: string, init?: RequestInit): Promise<Blob> => {
    if (IS_STATIC_BUILD) {
      throw new Error('再現パッケージ出力はstaticビルドで未対応です (ANALYSIS_CONTEXT_UNSUPPORTED)。')
    }
    const response = await fetch(`${BASE}${path}`, init)
    if (!response.ok) {
      let code = `HTTP ${response.status}`
      try {
        const body = await response.json()
        if (body.error?.message) throw body.error
      } catch (err) {
        if ((err as { message?: string })?.message) throw err
      }
      throw new Error(code)
    }
    return response.blob()
  },
  upload: async <T>(path: string, file: File, extra: Record<string, string> = {}) => {
    if (IS_STATIC_BUILD) {
      return pyodideClient.upload<T>(path, file, extra)
    }

    const form = new FormData()
    form.append('file', file)
    for (const [key, value] of Object.entries(extra)) form.append(key, value)
    const response = await fetch(`${BASE}${path}`, { method: 'POST', body: form })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw body?.error ?? { code: 'UPLOAD_FAILED', message: 'uploadに失敗しました', details: {}, recoverable: true, suggestedActions: [] }
    }
    return response.json() as Promise<T>
  },
}

export type MaDisplayAxis = { key: string; kind: 'maOption' | 'maCount'; groupId: string; columnId?: string }
export type ArrowViewOptions = { maAxes?: MaDisplayAxis[]; expectedSchemaRevision?: number; expectedDataRevision?: number }

export async function fetchArrowView(datasetId: string, columns?: string[], rowIds?: string[], options?: ArrowViewOptions): Promise<Record<string, unknown[]>> {
  if (IS_STATIC_BUILD) {
    return pyodideClient.fetchArrowView(datasetId, columns, rowIds, options)
  }

  const response = await fetch(`${BASE}/datasets/${datasetId}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columns, rowIds, ...options }),
  })
  if (!response.ok) throw new Error(`view failed: ${response.status}`)
  const { tableFromIPC } = await import('apache-arrow')
  const table = tableFromIPC(await response.arrayBuffer())
  const result: Record<string, unknown[]> = {}
  for (const column of table.schema.fields) {
    result[column.name] = Array.from(table.getChild(column.name) ?? [])
  }
  return result
}

export async function downloadExport(datasetId: string, scope: 'selected' | 'active' | 'all', format: 'csv' | 'parquet' | 'arrow' | 'xlsx', rowIds?: string[], useValueLabels = false) {
  if (IS_STATIC_BUILD) {
    return pyodideClient.downloadExport(datasetId, scope, format, rowIds, useValueLabels)
  }

  const response = await fetch(`${BASE}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetId, scope, format, rowIds, useValueLabels }),
  })
  if (!response.ok) throw new Error('export failed')
  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') || ''
  const match = /filename="?([^";]+)"?/.exec(disposition)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = match?.[1] ?? `export.${format}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface CodebookColumn {
  columnId: string
  name: string
  label: string
  scaleType: 'nominal' | 'ordinal' | 'interval' | 'ratio' | 'text' | 'id'
  role: 'question' | 'attribute' | 'weight' | 'id' | 'other'
  valueLabels: Record<string, string>
  categoryOrder: string[]
  missingCodes: string[]
  missingReasons: Record<string, string>
  isReversed: boolean
  multiResponseGroup: string | null
  multiResponseOptionLabel?: string
}

export interface MultiResponseGroup {
  groupId: string
  label: string
  selectedCodes: string[]
  unselectedCodes: string[]
  allUnselectedMeaning: 'valid' | 'missing' | 'notApplicable'
  maxSelections: number | null
  optionOrder: string[]
}

export interface CodebookResponse {
  datasetId: string
  schemaRevision: number
  columns: CodebookColumn[]
  multiResponseGroups?: MultiResponseGroup[]
}

export async function getCodebook(datasetId: string): Promise<CodebookResponse> {
  return api.get<CodebookResponse>(`/datasets/${datasetId}/codebook`)
}

export async function updateCodebook(
  datasetId: string,
  columns: Partial<CodebookColumn>[],
  options?: {
    multiResponseGroups?: MultiResponseGroup[]
    expectedSchemaRevision?: number
  }
): Promise<{ status: string; datasetId: string; schemaRevision: number; updatedColumns: number }> {
  return api.put(`/datasets/${datasetId}/codebook`, {
    columns,
    ...(options ?? {}),
  })
}

export async function importCodebook(
  datasetId: string,
  file: File
): Promise<{ status: string; datasetId: string; schemaRevision: number; updatedColumns: number }> {
  return api.upload(`/datasets/${datasetId}/codebook/import`, file)
}

export async function downloadCodebookExport(datasetId: string, format: 'csv' | 'json' = 'csv'): Promise<void> {
  const response = await fetch(`${BASE}/datasets/${datasetId}/codebook/export?format=${format}`)
  if (!response.ok) throw new Error('Codebook export failed')
  const blob = await response.blob()
  const disposition = response.headers.get('Content-Disposition') || ''
  const match = /filename="?([^";]+)"?/.exec(disposition)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = match?.[1] ?? `codebook_${datasetId}.${format}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface MultiResponseSummary {
  groupId: string
  label: string
  denominators: {
    total: number
    target: number
    valid: number
    missing: number
    partial: number
    invalid: number
    notApplicable: number
  }
  allUnselectedN: number
  totalResponses: number
  items: {
    columnId: string
    name: string
    label: string
    selectedN: number
    selectedInSelection: number
    pctRespondent: number | null
    pctResponse: number | null
  }[]
}

export interface MultiResponseSummaryResponse {
  datasetId: string
  schemaRevision: number
  dataRevision: number
  scopeHash: string
  groups: MultiResponseSummary[]
}
