export interface LRCoefficient {
  designColumnId: string
  termId: string
  label: string
  estimate: number
  standardError: number | null
  statistic: number | null
  pValue: number | null
  ciLower: number | null
  ciUpper: number | null
  standardizedEstimate: number | null
  standardizedReason: string | null
  inferenceReason: string | null
}

export interface LRDesignColumn {
  designColumnId: string
  termId: string
  label: string
  kind: string
}

export interface LRResponse {
  status: string
  resultId: string
  method: string
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
    warnings: { code: string; message: string; count?: number | null; columnIds?: string[] }[]
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
    predictionIntervals: string[]
  }
  summary: {
    targetLabel: string
    nDesignColumns: number
    rank: number
    conditionNumber: number | null
    rSquared: number | null
    rSquaredType: string
    adjustedRSquared: number | null
    rmse: number | null
    residualStdError: number | null
    residualDf: number | null
    referenceDf: number | null
    logLikelihood: number | null
    aic: number | null
    bic: number | null
    kAic: number
    inferenceStatus: string
    covarianceMethod: string
    jointTest: {
      kind: string | null
      statistic: number | null
      dfNumerator: number | null
      dfDenominator: number | null
      pValue: number | null
    } | null
    modelFormula: string
  }
  details: {
    designColumns: LRDesignColumn[]
    coefficients: LRCoefficient[]
    categoryReferences: {
      columnId: string
      referenceCategoryId: string
      referenceCode: string
      observedCategoryIds: string[]
      coding: string
    }[]
    vif: { designColumnId: string; value: number | null; status: string }[]
    omittedLevels: { variableId: string; categoryId: string; code: string; reason: string }[]
    designDiagnostics: {
      fitted: number[]
      residual: number[]
      leveragePerReplica: (number | null)[]
      leverageTotal: (number | null)[]
      studentizedResidual: (number | null)[]
      cooksDistance: (number | null)[]
      surveyNote?: string | null
    }
    modelFormula: string
  }
  unavailableReasons: Record<string, { code: string; message: string; relatedFields: string[] }>
}
