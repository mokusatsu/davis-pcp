/**
 * LocalEngine — pure-TS reference implementation of the GraphEngine contract.
 * Mirrors the pre-WASM algorithms 1:1 (brush.ts, geometry.ts, StatisticsPage
 * binning, DistributionPage boxStats, SilhouettePlot ordering) and serves as
 * the jsdom-test fallback + WASM parity oracle.
 */
import type {
  EngineAxis, GeometryResult, GraphEngine, HitMode, PcpGeometryRequest, Rect,
} from './types'

function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function signedNoise(seed: number, rowId: string, key: string): number {
  let x = hashString(`${seed}|${rowId}|${key}`) || 1
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  return ((x >>> 0) / 4294967295) * 2 - 1
}

function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2
}

function segmentIntersectsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  if (pointInRect(ax, ay, r) || pointInRect(bx, by, r)) return true
  const dx = bx - ax
  const dy = by - ay
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dy, dy]
  const q = [ax - r.x1, r.x2 - ax, ay - r.y1, r.y2 - ay]
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
      continue
    }
    const ratio = q[i] / p[i]
    if (p[i] < 0) {
      if (ratio > t1) return false
      if (ratio > t0) t0 = ratio
    } else {
      if (ratio < t0) return false
      if (ratio < t1) t1 = ratio
    }
  }
  return true
}

function distancePointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function quantileSorted(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q
  const base = Math.floor(position)
  const rest = position - base
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base]
}

export class LocalEngine implements GraphEngine {
  readonly kind = 'local' as const

  async pcpGeometry(req: PcpGeometryRequest): Promise<GeometryResult> {
    const { width, height, orientation } = req
    // Dataset-switch races can deliver a request with missing/stale axes —
    // bail instead of crashing on axes[a].isCategorical (worker-side guard
    // mirrors this; here it protects the main-thread fallback path).
    if (!req || !Array.isArray(req.axes) || req.axes.some((a) => !a || typeof a.key !== 'string')) {
      throw new Error('pcpGeometry: malformed request (missing axes)')
    }
    const nAxes = req.axes.length
    const nRows = req.rowIds.length
    const margin = orientation === 'horizontal'
      ? { left: 72, right: 72, top: 62, bottom: 64 }
      : { left: 84, right: 105, top: 66, bottom: 66 }
    const bounds = { left: margin.left, right: width - margin.right, top: margin.top, bottom: height - margin.bottom }

    const axisPos: number[] = []
    for (let index = 0; index < nAxes; index += 1) {
      const ratio = nAxes <= 1 ? 0.5 : index / (nAxes - 1)
      axisPos.push(orientation === 'horizontal'
        ? bounds.left + ratio * (bounds.right - bounds.left)
        : bounds.top + ratio * (bounds.bottom - bounds.top))
    }

    const points = new Float64Array(nRows * nAxes * 2)
    for (let r = 0; r < nRows; r += 1) {
      const rowId = req.rowIds[r]
      for (let a = 0; a < nAxes; a += 1) {
        const axis: EngineAxis = req.axes[a]
        const raw = req.values[r * nAxes + a]
        const applyRawJitter = req.jitterEnabled && req.jitterMode === 'legacyRaw' && !axis.isCategorical
        const applyPixelJitter = req.jitterEnabled && req.jitterMode === 'pixel'
        let t: number
        if (axis.isCategorical) {
          t = raw
        } else {
          const numeric = applyRawJitter ? raw + signedNoise(req.jitterSeed, rowId, req.axes[a].key) * 0.1 : raw
          t = axis.max === axis.min ? 0.5 : (numeric - axis.min) / (axis.max - axis.min)
        }
        if (req.reversed[axis.key]) t = 1 - t
        const slot = (r * nAxes + a) * 2
        if (orientation === 'horizontal') {
          let y = bounds.bottom - t * (bounds.bottom - bounds.top)
          if (applyPixelJitter) y += signedNoise(req.jitterSeed, rowId, req.axes[a].key) * req.jitterAmount
          points[slot] = axisPos[a]
          points[slot + 1] = Math.min(bounds.bottom, Math.max(bounds.top, y))
        } else {
          let x = bounds.left + t * (bounds.right - bounds.left)
          if (applyPixelJitter) x += signedNoise(req.jitterSeed, rowId, req.axes[a].key) * req.jitterAmount
          points[slot] = Math.min(bounds.right, Math.max(bounds.left, x))
          points[slot + 1] = axisPos[a]
        }
      }
    }
    return { bounds, axisPos, points }
  }

  async polylineHit(
    pts: ArrayLike<number>, nRows: number, nAxes: number,
    rect: Rect, mode: HitMode, active: Uint8Array,
  ): Promise<number[]> {
    const hits: number[] = []
    for (let row = 0; row < nRows; row += 1) {
      if (!active[row]) continue
      const base = row * nAxes * 2
      let hit = false
      for (let k = 0; k < nAxes; k += 1) {
        if (pointInRect(pts[base + k * 2], pts[base + k * 2 + 1], rect)) {
          hit = true
          break
        }
      }
      if (!hit && mode === 'segment' && nAxes > 1) {
        for (let k = 0; k < nAxes - 1; k += 1) {
          if (segmentIntersectsRect(
            pts[base + k * 2], pts[base + k * 2 + 1],
            pts[base + (k + 1) * 2], pts[base + (k + 1) * 2 + 1], rect,
          )) {
            hit = true
            break
          }
        }
      }
      if (hit) hits.push(row)
    }
    return hits
  }

  async scatterHit(values: ArrayLike<number>, nRows: number, rect: Rect, active: Uint8Array): Promise<number[]> {
    const hits: number[] = []
    for (let row = 0; row < nRows; row += 1) {
      if (!active[row]) continue
      if (pointInRect(values[row * 2], values[row * 2 + 1], rect)) hits.push(row)
    }
    return hits
  }

  async bandHit(values: ArrayLike<number>, nRows: number, lo: number, hi: number, active: Uint8Array): Promise<number[]> {
    const hits: number[] = []
    for (let row = 0; row < nRows; row += 1) {
      if (!active[row]) continue
      const v = values[row]
      if (v >= lo && v <= hi) hits.push(row)
    }
    return hits
  }

  async nearest(
    pts: ArrayLike<number>, nRows: number, nAxes: number,
    px: number, py: number, threshold: number, active: Uint8Array,
  ): Promise<number> {
    let best = -1
    let bestDistance = threshold
    for (let row = 0; row < nRows; row += 1) {
      if (!active[row]) continue
      const base = row * nAxes * 2
      for (let k = 0; k < nAxes - 1; k += 1) {
        const d = distancePointToSegment(
          px, py,
          pts[base + k * 2], pts[base + k * 2 + 1],
          pts[base + (k + 1) * 2], pts[base + (k + 1) * 2 + 1],
        )
        if (d < bestDistance) {
          bestDistance = d
          best = row
        }
      }
    }
    return best
  }

  async histogram(values: ArrayLike<number>, n: number, min: number, max: number, bins: number): Promise<number[]> {
    const counts = new Array(bins).fill(0)
    const span = max === min ? 1 : max - min
    for (let i = 0; i < n; i += 1) {
      const b = Math.min(bins - 1, Math.floor(((values[i] - min) / span) * bins))
      counts[b] += 1
    }
    return counts
  }

  async histogramGrouped(
    values: ArrayLike<number>, groupOf: ArrayLike<number>, n: number,
    min: number, max: number, bins: number, nGroups: number,
  ): Promise<number[]> {
    const out: number[] = new Array(nGroups * bins).fill(0)
    const span = max === min ? 1 : max - min
    for (let i = 0; i < n; i += 1) {
      const g = groupOf[i]
      if (g >= nGroups) continue
      const b = Math.min(bins - 1, Math.floor(((values[i] - min) / span) * bins))
      out[g * bins + b] += 1
    }
    return out
  }

  async boxStats(values: ArrayLike<number>): Promise<[number, number, number, number, number] | null> {
    const n = values.length
    if (!n) return null
    const sorted = Array.from(values as number[]).sort((a, b) => a - b)
    return [
      sorted[0],
      quantileSorted(sorted, 0.25),
      quantileSorted(sorted, 0.5),
      quantileSorted(sorted, 0.75),
      sorted[n - 1],
    ]
  }

  async silhouetteOrder(labels: ArrayLike<number>, sil: ArrayLike<number>): Promise<number[]> {
    const idx = Array.from({ length: labels.length }, (_, i) => i)
    idx.sort((a, b) => {
      if (labels[a] !== labels[b]) return labels[a] - labels[b]
      return sil[b] - sil[a]
    })
    return idx
  }

  async finiteMinMax(values: ArrayLike<number>): Promise<{ min: number; max: number } | null> {
    let has = false
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]
      if (Number.isFinite(v)) {
        has = true
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    return has ? { min, max } : null
  }

  async describeNumeric(values: Float64Array): Promise<number[] | null> {
    const finite: number[] = []
    let missing = 0
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i]
      if (Number.isFinite(v)) finite.push(v)
      else missing += 1
    }
    if (!finite.length) return null
    finite.sort((a, b) => a - b)
    const m = finite.length
    const mean = finite.reduce((s, v) => s + v, 0) / m
    const variance = m > 1 ? finite.reduce((s, v) => s + (v - mean) ** 2, 0) / (m - 1) : 0
    return [m, missing, mean, Math.sqrt(variance), finite[0],
      quantileSorted(finite, 0.25), quantileSorted(finite, 0.5), quantileSorted(finite, 0.75), finite[m - 1]]
  }

  async correlationMatrix(values: Float64Array, n: number, k: number): Promise<Float64Array> {
    const out = new Float64Array(k * k)
    const col = (c: number, i: number) => values[i * k + c]
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        if (i === j) { out[i * k + j] = 1; continue }
        let sx = 0, sy = 0, cnt = 0
        for (let r = 0; r < n; r += 1) {
          const x = col(i, r), y = col(j, r)
          if (Number.isFinite(x) && Number.isFinite(y)) { sx += x; sy += y; cnt += 1 }
        }
        if (!cnt) { out[i * k + j] = NaN; continue }
        const mx = sx / cnt, my = sy / cnt
        let sxy = 0, sxx = 0, syy = 0
        for (let r = 0; r < n; r += 1) {
          const x = col(i, r), y = col(j, r)
          if (Number.isFinite(x) && Number.isFinite(y)) {
            const dx = x - mx, dy = y - my
            sxy += dx * dy; sxx += dx * dx; syy += dy * dy
          }
        }
        const denom = Math.sqrt(sxx * syy)
        out[i * k + j] = denom === 0 ? NaN : sxy / denom
      }
    }
    return out
  }

  /** K-Medoids (CLARA-style sampled PAM) — 1:1 mirror of graph-core
   *  compute_kmedoids (xorshift32 PRNG, f32 normalization via Math.fround,
   *  identical iteration orders) for WASM parity testing. */
  async kMedoids(
    values: ArrayLike<number>, n: number, d: number,
    targetK: number, sampleSize: number, swapRounds: number, seed: number,
    specs: ArrayLike<number>,
  ): Promise<{ medoidIndexes: number[]; sizes: number[]; assignment: number[] }> {
    // Normalize to t-space with f32 rounding (matches Rust `as f32`).
    const tvals = new Float32Array(n * d)
    for (let r = 0; r < n; r += 1) {
      for (let a = 0; a < d; a += 1) {
        const isCat = specs[a * 3] !== 0
        const min = specs[a * 3 + 1]
        const max = specs[a * 3 + 2]
        const raw = values[r * d + a]
        let t: number
        if (isCat) t = raw
        else if (max === min) t = 0.5
        else t = (raw - min) / (max - min)
        tvals[r * d + a] = Math.fround(t)
      }
    }

    const k = targetK >= n ? n : targetK
    if (k === 0) return { medoidIndexes: [], sizes: [], assignment: [] }

    // xorshift32 with rejection sampling — mirrors XorShift32 in stats.rs.
    let rngState = seed === 0 ? 0x9E3779B9 : seed >>> 0
    const nextU32 = () => {
      let x = rngState
      x ^= x << 13; x >>>= 0
      x ^= x >>> 17
      x ^= x << 5; x >>>= 0
      rngState = x
      return x
    }
    const nextBelow = (bound: number) => {
      const threshold = (0 - bound) % bound
      for (;;) {
        const x = nextU32()
        if (x >>> 0 >= threshold) return (x >>> 0) % bound
      }
    }

    // Sample S rows (deterministic partial Fisher-Yates).
    const s = Math.min(sampleSize || n, n, 1500)
    const sample: number[] = Array.from({ length: n }, (_, i) => i)
    for (let i = 0; i < s; i += 1) {
      const j = i + nextBelow(n - i)
      const tmp = sample[i]; sample[i] = sample[j]; sample[j] = tmp
    }

    const l1 = (rowA: number, rowB: number, limit: number) => {
      let sum = 0
      const aOff = rowA * d
      const bOff = rowB * d
      for (let a = 0; a < d; a += 1) {
        const x = tvals[aOff + a]
        const y = tvals[bOff + a]
        if (Number.isFinite(x) && Number.isFinite(y)) sum += Math.abs(x - y)
        else if (Number.isFinite(x) !== Number.isFinite(y)) sum += 1
        if (sum > limit) return sum
      }
      return sum
    }
    const dist = (si: number, sj: number, limit: number) => l1(sample[si], sample[sj], limit)

    // BUILD: mean-nearest first, then greedy gain maximization.
    const mean = new Float64Array(d)
    for (let i = 0; i < s; i += 1) {
      const off = sample[i] * d
      for (let a = 0; a < d; a += 1) {
        const v = tvals[off + a]
        if (Number.isFinite(v)) mean[a] += v
      }
    }
    for (let a = 0; a < d; a += 1) mean[a] /= s
    let first = 0
    let firstCost = Infinity
    for (let si = 0; si < s; si += 1) {
      let cost = 0
      const off = sample[si] * d
      for (let a = 0; a < d; a += 1) {
        const v = tvals[off + a]
        if (Number.isFinite(v)) cost += Math.abs(v - mean[a])
      }
      if (cost < firstCost) { firstCost = cost; first = si }
    }
    const medoids: number[] = [first]
    const bestDist = new Float64Array(s).fill(Infinity)
    for (let si = 0; si < s; si += 1) bestDist[si] = dist(first, si, Infinity)
    while (medoids.length < k) {
      // Farthest-insert (PAM-lite) — mirrors the Rust BUILD phase (O(S·d)
      // per round; the gain-sum form is O(S²·d) and unusable at k=300).
      let bestSi = 0
      let bestD = -1
      for (let si = 0; si < s; si += 1) {
        if (bestDist[si] > bestD) { bestD = bestDist[si]; bestSi = si }
      }
      if (bestD <= 0) break
      for (let si = 0; si < s; si += 1) {
        const dd = dist(bestSi, si, bestDist[si])
        if (dd < bestDist[si]) bestDist[si] = dd
      }
      medoids.push(bestSi)
    }

    // SWAP rounds: worst-covered cluster member swap on an eval subsample.
    const tEval = Math.min(s, 400)
    for (let round = 0; round < swapRounds; round += 1) {
      const owner = new Array<number>(s)
      for (let si = 0; si < s; si += 1) {
        let bi = 0
        let bd = Infinity
        for (let mi = 0; mi < medoids.length; mi += 1) {
          const dd = dist(medoids[mi], si, bd)
          if (dd < bd) { bd = dd; bi = mi }
        }
        owner[si] = bi
      }
      let improved = false
      for (let mi = 0; mi < medoids.length; mi += 1) {
        let worstSi = -1
        let worstD = -1
        for (let si = 0; si < s; si += 1) {
          if (owner[si] === mi && si !== medoids[mi]) {
            const dd = dist(medoids[mi], si, Infinity)
            if (dd > worstD) { worstD = dd; worstSi = si }
          }
        }
        if (worstSi < 0) continue
        // Incremental cost: only the swapped medoid's contribution changes.
        let currentCost = 0
        let swapCost = 0
        for (let si = 0; si < tEval; si += 1) {
          const dCur = dist(medoids[mi], si, Infinity)
          let dOther = Infinity
          for (let mj = 0; mj < medoids.length; mj += 1) {
            if (mj === mi) continue
            const dd = dist(medoids[mj], si, dOther)
            if (dd < dOther) dOther = dd
          }
          currentCost += Math.min(dCur, dOther)
          const dNew = dist(worstSi, si, Infinity)
          swapCost += Math.min(dNew, dOther)
        }
        if (swapCost + 1e-9 < currentCost) {
          medoids[mi] = worstSi
          improved = true
        }
      }
      if (!improved) break
    }

    // Full assignment.
    const medoidRows = medoids.map((si) => sample[si])
    const assignment = new Array<number>(n)
    const sizes = new Array<number>(medoidRows.length).fill(0)
    for (let r = 0; r < n; r += 1) {
      let bi = 0
      let bd = Infinity
      for (let mi = 0; mi < medoidRows.length; mi += 1) {
        const dd = l1(r, medoidRows[mi], bd)
        if (dd < bd) { bd = dd; bi = mi }
      }
      assignment[r] = bi
      sizes[bi] += 1
    }

    return { medoidIndexes: medoidRows, sizes, assignment }
  }
}

export const localEngine = new LocalEngine()
