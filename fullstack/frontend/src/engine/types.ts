/**
 * Engine interface — the single compute contract every graph view programs
 * against. Two implementations:
 *  - WasmGraphCore (worker-hosted WASM, production)
 *  - LocalEngine   (pure TS reference/fallback — same algorithms as the
 *    pre-WASM code, used when WASM is unavailable and as parity oracle)
 */

export type Orientation = 'horizontal' | 'vertical'
export type HitMode = 'legacyVertex' | 'segment'
export type BrushOp = 'add' | 'replace' | 'subtract' | 'toggle'

export interface EngineAxis {
  key: string
  /** numeric axes use raw min/max; categorical carry t-normalized [0..1] spec */
  min: number
  max: number
  isCategorical: boolean
}

export interface PcpGeometryRequest {
  width: number
  height: number
  orientation: Orientation
  axes: EngineAxis[]
  reversed: Record<string, boolean>
  jitterEnabled: boolean
  jitterMode: 'pixel' | 'legacyRaw'
  jitterAmount: number
  jitterSeed: number
  /** visible row ids (active set), aligned with values rows */
  rowIds: string[]
  /** row-major [row][axis] raw numeric or t∈[0,1] for categorical */
  values: Float64Array
}

export interface GeometryResult {
  bounds: { left: number; right: number; top: number; bottom: number }
  axisPos: number[]
  /** row-major [row][axis][x,y] */
  points: Float64Array
}

export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface GraphEngine {
  readonly kind: 'wasm' | 'local'

  pcpGeometry(req: PcpGeometryRequest): Promise<GeometryResult>

  /** PCP polyline brush. Returns hit row indexes into req.rowIds order. */
  polylineHit(
    points: ArrayLike<number>, nRows: number, nAxes: number,
    rect: Rect, mode: HitMode, active: Uint8Array,
  ): Promise<number[]>

  /** 2D value-space rect hit for scatter panels. values = [row][2]. */
  scatterHit(values: ArrayLike<number>, nRows: number, rect: Rect, active: Uint8Array): Promise<number[]>

  /** Value-interval band hit (histogram range / distribution lens). */
  bandHit(values: ArrayLike<number>, nRows: number, lo: number, hi: number, active: Uint8Array): Promise<number[]>

  /** Nearest polyline row index within threshold px, else -1. */
  nearest(
    points: ArrayLike<number>, nRows: number, nAxes: number,
    px: number, py: number, threshold: number, active: Uint8Array,
  ): Promise<number>

  histogram(values: ArrayLike<number>, n: number, min: number, max: number, bins: number): Promise<number[]>

  histogramGrouped(
    values: ArrayLike<number>, groupOf: ArrayLike<number>, n: number,
    min: number, max: number, bins: number, nGroups: number,
  ): Promise<number[]>

  boxStats(values: ArrayLike<number>): Promise<[number, number, number, number, number] | null>

  silhouetteOrder(labels: ArrayLike<number>, sil: ArrayLike<number>): Promise<number[]>

  finiteMinMax(values: ArrayLike<number>): Promise<{ min: number; max: number } | null>

  /** [count, missing, mean, std, min, q1, median, q3, max] or null (no finite values) */
  describeNumeric(values: Float64Array): Promise<number[] | null>

  /** Pearson correlation matrix, row-major k×k. values = row-major [row][col]. */
  correlationMatrix(values: Float64Array, n: number, k: number): Promise<Float64Array>

  /** K-Medoids (sampled PAM) over PCP-normalized t-space. specs = axis-major
   *  f64 triplets [isCat, min, max]. Returns input-row-order medoid indexes,
   *  full-assignment cluster sizes (sum = n), and per-row assignment. */
  kMedoids(
    values: ArrayLike<number>, n: number, d: number,
    targetK: number, sampleSize: number, swapRounds: number, seed: number,
    specs: ArrayLike<number>,
  ): Promise<{ medoidIndexes: number[]; sizes: number[]; assignment: number[] }>
}
