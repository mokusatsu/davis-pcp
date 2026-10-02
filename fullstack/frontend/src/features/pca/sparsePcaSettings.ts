import type { CodebookColumn, SurveyDesignSpec, WeightConfig } from '../../api/client'

export interface SparsePcaSettings {
  nComponents: number | null
  alpha: number | null
  ridgeAlpha: number | null
  tolerance: number | null
  maxIterations: number | null
  seed: number | null
}
export const DEFAULT_SPARSE_PCA_SETTINGS: SparsePcaSettings = {
  nComponents: 2, alpha: 1, ridgeAlpha: .01, tolerance: 1e-8, maxIterations: 1000, seed: 0,
}
export function sparsePcaSettingsError(settings: SparsePcaSettings): string | null {
  const { nComponents: k, alpha, ridgeAlpha, tolerance, maxIterations, seed } = settings
  if (k === null || !Number.isInteger(k) || k < 1 || k > 20) return '成分数は1〜20の整数で指定してください。実行時の上限はcomplete-case行数と定数除外後の変数数でも制限されます。'
  if (alpha === null || !Number.isFinite(alpha) || alpha < 0) return 'alphaは0以上の有限値で指定してください。'
  if (ridgeAlpha === null || !Number.isFinite(ridgeAlpha) || ridgeAlpha < 0) return 'ridgeAlphaは0以上の有限値で指定してください。'
  if (tolerance === null || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > .1) return '許容誤差は0より大きく0.1以下で指定してください。'
  if (maxIterations === null || !Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5000) return '最大反復は1〜5000の整数で指定してください。'
  if (seed === null || !Number.isInteger(seed) || seed < 0 || seed > 4294967295) return 'seedは0〜4294967295の整数で指定してください。'
  return null
}
export function sparsePcaColumnEligible(column: CodebookColumn): boolean {
  return !column.multiResponseGroup && ['question', 'attribute'].includes(column.role)
    && ['interval', 'ratio', 'ordinal'].includes(column.scaleType)
}
export function sparsePcaHasWeight(weight: WeightConfig | null | undefined, design: SurveyDesignSpec | null | undefined): boolean {
  return Boolean(weight || design?.weightColumnId)
}
