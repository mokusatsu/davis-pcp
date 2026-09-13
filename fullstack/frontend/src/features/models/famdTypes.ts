export interface FAMDCategory {
  categoryId: string
  variableId: string
  code: string | null
  kind: string
  label: string
  physicalCount: number
  probability: number
  barycenterCoordinates: number[]
  contributions: number[]
  cos2: (number | null)[]
  distanceSquared: number
}

export interface FAMDNumericVariable {
  variableId: string
  label: string
  mean: number
  scale: number
  correlations: number[]
  contributions: number[]
  cos2: number[]
}

export interface FAMDCategoricalVariable {
  variableId: string
  label: string
  categoryIds: string[]
  relationStrength: number[]
  contributions: number[]
}

export interface FAMDResponse {
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
  }
  summary: {
    rank: number
    totalInertia: number
    eigenvalues: number[]
    inertiaRatio: number[]
    cumulativeInertiaRatio: number[]
    nNumericVariables: number
    nCategoricalVariables: number
    nCategories: number
    coordinateConvention: string
    discardedNumericalInertia: number
    degenerateBlocks: { axisIds: number[] }[]
  }
  details: {
    numericVariables: FAMDNumericVariable[]
    categoricalVariables: FAMDCategoricalVariable[]
    categories: FAMDCategory[]
    variableRelation: { variableId: string; kind: string; relationStrength: number[]; contributions: number[] }[]
    omittedCategories: { categoryId: string; variableId: string; label: string; reason: string }[]
    rowCount: number
  }
}
