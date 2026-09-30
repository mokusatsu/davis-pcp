export interface ConjointCoefficient {
  designColumnId: string
  termId: string
  label: string
  estimate: number
  standardError: number | null
  statistic: number | null
  pValue: number | null
  ciLower: number | null
  ciUpper: number | null
  reason: string | null
}

export interface ConjointLevelUtility {
  attributeId: string
  categoryId: string | null
  levelCode: string | null
  label: string
  utility: number
  standardError: number | null
  ciLower: number | null
  ciUpper: number | null
  referenceLevel: string | null
}

export interface ConjointImportance {
  attributeId: string
  label: string
  kind: string
  range: number
  importance: number
  rangeLower: number
  rangeUpper: number
}

export interface ConjointWtp {
  attributeId: string
  fromLevel: string
  toLevel: string
  deltaUtility: number
  value: number | null
  standardError: number | null
  ciLower: number | null
  ciUpper: number | null
  priceUnit: string
  status: string
  reason: string | null
}

export interface ConjointResponse {
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
    simulation: boolean
  }
  summary: {
    mode: string
    ratingEffects: string
    respondentCount: number
    taskCount: number
    fitProfileCount: number
    stageCount: number
    sumRespondentWeights: number
    frequencyRespondentN: number | null
    referenceDf: number | null
    inferenceStatus: string
    covarianceMethod: string
    converged: boolean
    fitMetrics: Record<string, unknown>
    optimizer?: Record<string, unknown>
  }
  details: {
    attributes: Record<string, unknown>[]
    designColumns: { designColumnId: string; termId: string; label: string; kind: string }[]
    coefficients: ConjointCoefficient[]
    levelUtilities: ConjointLevelUtility[]
    attributeImportance: ConjointImportance[] | null
    wtp: ConjointWtp[] | null
    omittedLevels: { attributeId: string; levelCode: string; reason: string }[]
    respondentIntercepts: { available: boolean; total: number; exportTable: string; subtables: string[] } | null
    taskDiagnostics: { available: boolean; total: number; exportTable: string; subtables: string[] } | null
    optimizer: Record<string, unknown>
    encoding: Record<string, unknown>
  }
  unavailableReasons: Record<string, { code: string; message: string; relatedFields: string[] }>
}
