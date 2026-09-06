export interface PcpAxis {
  key: string
  label: string
  type: 'numeric' | 'categorical'
  min: number
  max: number
  categories?: string[]
}

export interface PcpPoint {
  x: number
  y: number
}

export interface PcpGeometry {
  width: number
  height: number
  bounds: { left: number; right: number; top: number; bottom: number }
  axes: { key: string; x: number | null; y: number | null }[]
  pointsById: Map<string, PcpPoint[]>
  valuesById: Map<string, Record<string, number | string>>
}

function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deterministic noise in [-1, 1] from seed|rowId|axis — matches static v1. */
export function signedNoise(seed: number, rowId: string, key: string): number {
  let x = hashString(`${seed}|${rowId}|${key}`) || 1
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) / 4294967295) * 2 - 1
}

export interface GeometryParams {
  width: number
  height: number
  orientation: 'horizontal' | 'vertical'
  orderedAxes: PcpAxis[]
  reversed: Record<string, boolean>
  jitterEnabled: boolean
  /** 'pixel': deterministic pixel displacement on the drawn coordinate.
   *  'legacyRaw': initial-JAR intent — add uniform ±0.1 to the raw value
   *  BEFORE min-max normalization (static v1 semantics). */
  jitterMode: 'pixel' | 'legacyRaw'
  jitterAmount: number
  jitterSeed: number
  rows: { id: string; values: Record<string, number | string> }[]
}

export function createGeometry(params: GeometryParams): PcpGeometry {
  const { width, height, orientation, orderedAxes } = params
  const margin = orientation === 'horizontal'
    ? { left: 72, right: 72, top: 62, bottom: 64 }
    : { left: 84, right: 105, top: 66, bottom: 66 }
  const bounds = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom }
  const positions = orderedAxes.map((axis, index) => {
    const ratio = orderedAxes.length <= 1 ? 0.5 : index / (orderedAxes.length - 1)
    return orientation === 'horizontal'
      ? { key: axis.key, x: bounds.left + ratio * (bounds.right - bounds.left), y: null as number | null }
      : { key: axis.key, x: null as number | null, y: bounds.top + ratio * (bounds.bottom - bounds.top) }
  })
  const axisByKey = new Map(orderedAxes.map((a) => [a.key, a]))
  const pointsById = new Map<string, PcpPoint[]>()
  const valuesById = new Map<string, Record<string, number | string>>()

  const pointFor = (rowId: string, value: number | string, axis: PcpAxis, position: { x: number | null; y: number | null }): PcpPoint => {
    const applyRawJitter = params.jitterEnabled && params.jitterMode === 'legacyRaw' && axis.type === 'numeric'
    // Pixel jitter applies to every axis type including categorical (nominal):
    // the displacement is on the drawn coordinate, not the value.
    const applyPixelJitter = params.jitterEnabled && params.jitterMode === 'pixel'
    let t: number
    if (axis.type === 'categorical') {
      const categories = axis.categories ?? []
      const index = Math.max(0, categories.indexOf(String(value)))
      t = categories.length <= 1 ? 0.5 : index / (categories.length - 1)
    } else {
      // legacyRaw jitters the RAW value before normalization (static v1 line 472).
      const raw = typeof value === 'number' ? value : Number(value)
      const numeric = applyRawJitter ? raw + signedNoise(params.jitterSeed, rowId, axis.key) * 0.1 : raw
      t = axis.max === axis.min ? 0.5 : (numeric - axis.min) / (axis.max - axis.min)
    }
    if (params.reversed[axis.key]) t = 1 - t
    if (orientation === 'horizontal') {
      let y = bounds.bottom - t * (bounds.bottom - bounds.top)
      if (applyPixelJitter) y += signedNoise(params.jitterSeed, rowId, axis.key) * params.jitterAmount
      return { x: position.x ?? 0, y: Math.min(bounds.bottom, Math.max(bounds.top, y)) }
    }
    let x = bounds.left + t * (bounds.right - bounds.left)
    if (applyPixelJitter) x += signedNoise(params.jitterSeed, rowId, axis.key) * params.jitterAmount
    return { x: Math.min(bounds.right, Math.max(bounds.left, x)), y: position.y ?? 0 }
  }

  for (const row of params.rows) {
    valuesById.set(row.id, row.values)
    pointsById.set(row.id, positions.map((position) =>
      pointFor(row.id, row.values[position.key], axisByKey.get(position.key)!, position)))
  }
  return { width, height, bounds, axes: positions, pointsById, valuesById }
}
