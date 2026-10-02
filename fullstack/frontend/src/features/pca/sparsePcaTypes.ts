import type { CodebookColumn } from '../../api/client'

export interface SparsePcaContext {
  datasetId: string
  expectedDataRevision: number
  expectedSchemaRevision: number
  scope: 'all' | 'active' | 'selected' | 'sampled' | 'explicit'
  rowIds?: string[]
  activeRowIds?: string[]
  selectedRowIds?: string[]
  sampledRowIds?: string[]
  weightMode: 'dataset' | 'none'
  missingPolicy: 'exclude'
  imputationPolicy: 'use_current_values'
}

export interface SparsePcaVariable {
  columnId: string
  kind: 'numeric'
  ordinalAsNumericAcknowledged: boolean
  score: 'ordered_rank' | null
}

export interface SparsePcaRequest {
  context: SparsePcaContext
  variables: SparsePcaVariable[]
  preprocessing: 'correlation' | 'covariance'
  nComponents: number
  alpha: number
  ridgeAlpha: number
  tolerance: number
  maxIterations: number
  seed: number
}

export interface SparsePcaMeta {
  datasetId: string
  dataRevision: number
  schemaRevision: number
  maskRevision: number | null
  resultState: string
  scope: string
  scopeHash: string
  scopeCount: number
  fitCount: number
  excludedCount: number
  exclusionCounts: Record<string, number>
  imputedCellCount: number
  imputedRowCount: number
  weightApplied: false
  algorithmVersion: string
  modelFingerprint: string
  snapshotFingerprint: string | null
  numericalRuntime: { engine: string; python: string | null; sklearn: string | null; pyodide: string | null; [key: string]: unknown }
  warnings: { code: string; message: string; count?: number | null }[]
}

export type SparsePcaExportTable = 'manifest' | 'coefficients' | 'variables' | 'diagnostics' | 'rows'

/** Independent of ordinary PCA: nonorthogonal components have no PCA eigenvalue fields. */
export interface SparsePcaResponse {
  status: 'success'
  resultId: string
  method: 'sparse_pca'
  meta: SparsePcaMeta
  config: Omit<SparsePcaRequest, 'context'> & { solver: 'lars' }
  capabilities: {
    rows: boolean
    projection: false
    materialize: false
    selectionKinds: ('row_ids' | 'rectangle')[]
    exportTables: SparsePcaExportTable[]
    predictionIntervals: []
    exportPredict: false
  }
  summary: {
    nComponents: number
    nVariables: number
    basisRank: number
    nonzeroPerComponent: number[]
    zeroFraction: number
    reconstructionFraction: number
    reconstructionSpace: 'standardized' | 'centered_analysis_values'
    convergence: {
      status: 'tolerance_reached' | 'iteration_limit' | 'objective_increase'
      nIterations: number
      maxIterations: number
      tolerance: number
      objectiveHistory: number[]
      finalObjective: number
      finalImprovement: number | null
    }
  }
  details: {
    variables: (Pick<CodebookColumn, 'columnId' | 'name' | 'label' | 'scaleType' | 'missingCodes' | 'isReversed' | 'categoryOrder' | 'valueLabels'> & {
      ordinalAsNumericAcknowledged: boolean
      score: 'ordered_rank' | null
    })[]
    excludedConstantColumns: { columnId: string; name: string; label: string }[]
    preprocessing: {
      mode: SparsePcaRequest['preprocessing']
      columns: {
        columnId: string
        inputMagnitude: number
        inputAnchor: number
        normalizedMean: number
        normalizedMeanOffset: number
        normalizedSampleSd: number
        rawMean: number | null
        rawMeanReason: string | null
        rawSampleSd: number | null
        rawSampleSdReason: string | null
      }[]
      estimatorMean: number[]
    }
    componentOrder: string[]
    components: number[][]
    scoreCoefficients: number[][]
    variableScoreCorrelations: (number | null)[][]
    variableScoreCorrelationReasons: (string | null)[][]
    scoreCorrelations: (number | null)[][]
    scoreCorrelationReasons: (string | null)[][]
    componentGram: number[][]
    scoreVariances: (number | null)[]
    scoreVarianceReasons: (string | null)[]
    rankTolerance: number
  }
  unavailableReasons: Record<string, { code: string; message: string; relatedFields: string[] }>
}

export interface SparsePcaRow { rowId: string; coordinates: number[] }
export interface SparsePcaRowsResponse {
  status: 'success'
  resultId: string
  offset: number
  limit: number
  total: number
  nextOffset: number | null
  axes: number[]
  rows: SparsePcaRow[]
  meta: SparsePcaMeta
}
