export interface MCACategory {
  categoryId: string
  variableId: string
  code: string | null
  kind: string
  label: string
  physicalCount: number
  categoryProbability: number
  categoryMass: number
  principalCoordinates: number[]
  standardCoordinates: number[]
  contributions: number[]
  cos2: (number | null)[]
  distanceSquared: number
}

export interface MCAVariable {
  variableId: string
  label: string
  categoryIds: string[]
  isMaOption: boolean
  maParentId: string | null
}

export interface MCAResponse {
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
    nVariables: number
    nCategories: number
    rank: number
    totalInertia: number
    eigenvalues: number[]
    rawInertiaRatio: number[]
    rawCumulativeInertiaRatio: number[]
    inertiaAdjustment: string
    adjustedEigenvalues: number[] | null
    adjustedInertiaRatio: (number | null)[] | null
    adjustedReason: string | null
    discardedNumericalInertia: number
    degenerateBlocks: { axisIds: number[] }[]
  }
  details: {
    categories: MCACategory[]
    variables: MCAVariable[]
    omittedCategories: { categoryId: string; variableId: string; label: string; reason: string }[]
    maDiagnostics: { parentId: string; selectedChildIds: string[]; statusCounts: Record<string, number> }[]
    rowCount: number
  }
}
