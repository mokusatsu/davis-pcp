import type { LRContext, LRPredictor } from './lrApi'

export type RRContext = LRContext
export type RRAlgorithm = 'ridge' | 'lasso' | 'elasticnet'
export type RRLanguage = 'python' | 'javascript' | 'typescript'
export type RRArtifact = 'model' | 'code' | 'schema' | 'readme' | 'test_vectors' | 'bundle'
export interface RRRequest {
  context: RRContext
  target: string
  predictors: LRPredictor[]
  algorithm: RRAlgorithm
  intercept: boolean
  standardize: boolean
  lambdaValue: number
  l1Ratio: number
  selection: 'manual' | 'cv'
  cv: null | {
    folds: number
    seed: number
    lambdaValues: number[]
    l1Ratios: number[]
    independentRowsAcknowledged: true
  }
  tolerance: number
  maxIterations: number
}
export interface RRCategory { code: string | null; kind: 'value' | 'missing' | 'not_applicable' }
export interface RRCoefficient {
  designColumnId: string
  columnId: string
  label: string
  kind: 'numeric' | 'ordinal' | 'categorical'
  category: RRCategory | null
  estimate: number | null
  estimateReason: string | null
  standardizedEstimate: number | null
  standardizedReason: string | null
  comparisonSd: number | null
  exactZero: boolean
  unit: string
}
export interface RRCategoryReference {
  columnId: string
  reference: RRCategory
  levels: (RRCategory & { label: string })[]
}
export interface RRModelIdentity {
  modelId: string
  modelVersion: '1'
  algorithmVersion: string
  exporterVersion: string
  runtimeVersion: string
  createdAt: string
  contentHash: string
}
export interface RRConvergence { converged: boolean; iterations: number | null; dualGap: number | null }
export interface RRCVSummary {
  folds: number
  seed: number
  assignmentFingerprint: string
  scoring: 'pooled_weighted_mse'
  bestLambdaValue: number
  bestL1Ratio: number
  weightedMse: number
  rmse: number
  candidateCount: number
  invalidCandidateCount: number
}
export interface RRCVFold {
  fold: number
  trainCount: number
  validationCount: number
  validationWeight: number
  libraryAlpha: number | null
  weightedSse: number | null
  failedPredictions: number
  convergence: RRConvergence | null
  failure: { code: string; message: string; details: Record<string, unknown> } | null
}
export interface RRCVCandidate {
  lambdaValue: number
  l1Ratio: number
  valid: boolean
  weightedMse: number | null
  rmse: number | null
  failureCount: number
  folds: RRCVFold[]
}
export interface RRCVAudit {
  summary: RRCVSummary
  candidates: RRCVCandidate[]
  rowUnit: string
  preprocessingScope: string
  upstreamLeakageVerified: false
  foldAudits: Record<string, unknown>[]
  [key: string]: unknown
}
export interface RRResponse {
  status: string
  resultId: string
  method: 'regularized_regression'
  meta: {
    datasetId: string
    dataRevision: number
    schemaRevision: number
    resultState: string
    scope: string
    scopeCount: number
    fitCount: number
    effectiveN: number
    excludedCount: number
    exclusionCounts: Record<string, number>
    weightApplied: boolean
    weightType: string | null
    weightColumn: string | null
    algorithmVersion: string
    warnings: { code: string; message: string; count?: number | null }[]
  }
  config: Omit<RRRequest, 'context'>
  capabilities: {
    rows: boolean
    projection: boolean
    materialize: false
    selectionKinds: []
    exportTables: string[]
    predictionIntervals: ['none']
    exportPredict: boolean
  }
  summary: {
    targetLabel: string
    nDesignColumns: number
    fitRmse: number | null
    fitMae: number | null
    fitRSquared: number | null
    lambdaValue: number
    l1Ratio: number
    algorithm: RRAlgorithm
    convergence: RRConvergence
    cv: RRCVSummary | null
  }
  details: {
    coefficients: RRCoefficient[]
    intercept: { estimate: number | null; reason: string | null }
    categoryReferences: RRCategoryReference[]
    cv: RRCVAudit | null
  }
  portableModel: {
    schemaVersion: 'davis.regularized-regression/1'
    identity: RRModelIdentity
    inputs: { columnId: string; key: string; name: string; label: string; kind: 'numeric' | 'ordinal' | 'categorical'; unit: string | null }[]
    display: { targetLabel: string; targetUnit: string | null }
  }
}
export interface RRFitRow { rowId: string; observed: number | null; fitted: number | null; residual: number | null }
export interface RRPredictRow {
  rowId: string
  predicted: number | null
  observed: number | null
  residual: number | null
  predictionStatus: string
  warnings: { code: string; columnId?: string; message?: string }[]
}
export interface RRPage<T> { total: number; nextOffset: number | null; rows: T[] }
export interface RRPredictResponse {
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
export interface RRExportResponse {
  fileName: string
  mime: string
  payload: string
  encoding: 'utf-8' | 'base64'
  modelId: string
  modelVersion: '1'
  contentHash: string
}
