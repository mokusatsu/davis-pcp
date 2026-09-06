export interface PcaScore {
  rowId: string
  row_id?: string
  pc: number[]
}

export interface PcaResponse {
  columns: string[]
  nSamples: number
  n_samples?: number
  nComponents: number
  n_components?: number
  useCorrelation: boolean
  use_correlation?: boolean
  eigenvalues: number[]
  explainedVarianceRatio: number[]
  explained_variance_ratio?: number[]
  cumulativeVarianceRatio: number[]
  cumulative_variance_ratio?: number[]
  kaiserThreshold: number
  kaiserThresholdComponents: number
  kaiser_threshold_components?: number
  eigenvectors: number[][]
  loadings: Record<string, number[]>
  scores: PcaScore[]
  evidenceClass: string
}
