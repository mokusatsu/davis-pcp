export interface LineMosaicLabel {
  path: string[]
  i?: number
  j?: number
}

export interface LineMosaicGrid {
  nCols: number
  nRows: number
  n_cols?: number
  n_rows?: number
  colVariables: string[]
  col_variables?: string[]
  rowVariables: string[]
  row_variables?: string[]
  colLabels: LineMosaicLabel[]
  col_labels?: LineMosaicLabel[]
  rowLabels: LineMosaicLabel[]
  row_labels?: LineMosaicLabel[]
}

export interface LineMosaicTarget {
  valueLabels?: Record<string, string>
  name: string
  categories: string[]
  colors: string[]
}

export interface LineMosaicCell {
  i: number
  j: number
  totalCount: number
  total_count?: number
  colPath: string[]
  col_path?: string[]
  rowPath: string[]
  row_path?: string[]
  targetCounts: Record<string, number>
  target_counts?: Record<string, number>
  rowIds: string[]
  row_ids?: string[]
}

export interface LineMosaicResponse {
  valueLabels?: Record<string, Record<string, string>>
  grid: LineMosaicGrid
  target: LineMosaicTarget | null
  maxCellFrequency: number
  max_cell_frequency?: number
  cells: LineMosaicCell[]
  evidenceClass: string
  scopeCount?: number
  usedRows?: number
  usedColumns?: string[]
  excludedCounts?: Record<string, Record<string, number>>
  excludedRowCount?: number
}

export function mosaicPathLabel(data: LineMosaicResponse, direction: 'row' | 'col', path: string[]): string {
  const variables = direction === 'row' ? data.grid.rowVariables : data.grid.colVariables
  return path.map((value, index) => data.valueLabels?.[variables[index]]?.[value] ?? value).join(' / ')
}
