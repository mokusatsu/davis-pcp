import { api } from '../../api/client'
import type { CAResponse } from './caTypes'

export interface CAContext {
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

export async function runCa(
  context: CAContext,
  input:
    | { kind: 'respondents'; rowVariable: string; columnVariable: string }
    | {
        kind: 'contingency'
        rowLabelColumn: string
        valueColumns: string[]
        cellSemantics: 'frequency' | 'mass'
        independentCountsAcknowledged: boolean
      },
  mapScaling: string,
): Promise<CAResponse> {
  return api.post<CAResponse>('/models/ca', { context, input, mapScaling })
}

export interface CASelectResponse {
  status: string
  resultId: string
  rowIds: string[]
  matchedCount: number
  fitMatchedCount: number
  contextIntersectionCount: number
  selectionLabel: string
}

export async function selectCaCategories(
  resultId: string,
  context: CAContext,
  categoryIds: string[],
  betweenVariables: 'and' | 'or',
): Promise<CASelectResponse> {
  return api.post<CASelectResponse>(`/analysis-results/${resultId}/select`, {
    context,
    selector: { kind: 'categories', categoryIds, betweenVariables },
  })
}
