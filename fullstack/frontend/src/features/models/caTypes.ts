export interface CACategory {
  categoryId: string
  side: 'row' | 'column'
  variableId: string
  code: string | null
  kind: string
  label: string
  mass: number
  physicalCount: number | null
  principalCoordinates: number[]
  standardCoordinates: number[]
  contributions: number[]
  cos2: (number | null)[]
  distanceSquared: number
}

export interface CAPearson {
  statistic: number | null
  df: number | null
  pValue: number | null
  status: 'available' | 'not_applicable'
  reason: string | null
  smallExpectedCellsLt1: number | null
  smallExpectedCellsLt5: number | null
  fractionExpectedLt5: number | null
}

export interface CAResponse {
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
    analysisUnit: string
    weightApplied: boolean
    weightType: string | null
    weightColumn: string | null
    algorithmVersion: string
    warnings: { code: string; message: string }[]
  }
  config: Record<string, unknown>
  capabilities: { selectionKinds: string[]; exportTables: string[] }
  summary: {
    rank: number
    totalInertia: number
    eigenvalues: number[]
    inertiaRatio: number[]
    cumulativeInertiaRatio: number[]
    discardedNumericalInertia: number
    tableTotal: number
    activeRowCategoryCount: number
    activeColumnCategoryCount: number
    pearson: CAPearson
  }
  details: {
    rowCategories: CACategory[]
    columnCategories: CACategory[]
    omittedCategories: { categoryId: string; label: string; side: string; reason: string }[]
    table: number[][]
    tableRowCategoryIds: string[]
    tableColumnCategoryIds: string[]
    physicalTable: number[][] | null
    mapScaling: string
  }
}
