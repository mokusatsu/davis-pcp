/**
 * Geodesic Grand Tour computational engine (Asimov 1985, Huh 2001).
 * Smoothly rotates a 2D orthonormal projection plane through p-dimensional space.
 */

export interface ProjectionPoint {
  rowId: string
  x: number
  y: number
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a))
}

function normalize(a: number[]): number[] {
  const n = norm(a)
  if (n < 1e-12) return a.map(() => 0)
  return a.map((v) => v / n)
}

/** Generate a random orthonormal 2D basis [alpha, beta] in R^p */
export function randomOrthonormalBasis(p: number): [number[], number[]] {
  if (p < 2) throw new Error('Grand Tour requires at least 2 dimensions')

  // Random normal vector alpha
  const a: number[] = []
  for (let i = 0; i < p; i++) {
    // Box-Muller transform
    const u1 = Math.max(Math.random(), 1e-10)
    const u2 = Math.random()
    a.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2))
  }
  const alpha = normalize(a)

  // Random vector b orthogonalized against alpha
  const b: number[] = []
  for (let i = 0; i < p; i++) {
    const u1 = Math.max(Math.random(), 1e-10)
    const u2 = Math.random()
    b.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2))
  }
  const d = dot(alpha, b)
  const bOrth = b.map((v, i) => v - d * alpha[i])
  const beta = normalize(bOrth)

  return [alpha, beta]
}

export class GeodesicEngine {
  p: number
  alpha: number[]
  beta: number[]
  private qAlpha: number[] = []
  private qBeta: number[] = []
  private thetaAlpha: number = 0
  private thetaBeta: number = 0
  private t: number = 0
  private stepDelta: number = 0.015

  // Tracking ring buffer: rowId -> array of past (x, y) points
  private trailHistory: Map<string, Array<{ x: number; y: number }>> = new Map()
  maxTrailLength: number = 12

  constructor(p: number) {
    this.p = p
    const [a, b] = randomOrthonormalBasis(p)
    this.alpha = a
    this.beta = b
    this.initNextTarget()
  }

  setSpeed(speedFactor: number) {
    // speedFactor roughly 0.2 to 3.0, default 1.0 -> stepDelta ~ 0.015
    this.stepDelta = Math.max(0.003, 0.015 * speedFactor)
  }

  /** Choose a new target plane and initialize geodesic interpolation */
  private initNextTarget() {
    const [tA, tB] = randomOrthonormalBasis(this.p)

    // Compute component of tA orthogonal to span{alpha, beta}
    const dAA = dot(this.alpha, tA)
    const dBA = dot(this.beta, tA)
    const resA = tA.map((v, i) => v - dAA * this.alpha[i] - dBA * this.beta[i])
    const normA = norm(resA)
    this.qAlpha = normA > 1e-8 ? resA.map((v) => v / normA) : randomOrthonormalBasis(this.p)[0]
    this.thetaAlpha = Math.atan2(normA, Math.sqrt(dAA * dAA + dBA * dBA))

    // Compute component of tB orthogonal to span{alpha, beta, qAlpha}
    const dAB = dot(this.alpha, tB)
    const dBB = dot(this.beta, tB)
    const dQB = dot(this.qAlpha, tB)
    const resB = tB.map((v, i) => v - dAB * this.alpha[i] - dBB * this.beta[i] - dQB * this.qAlpha[i])
    const normB = norm(resB)
    this.qBeta = normB > 1e-8 ? resB.map((v) => v / normB) : randomOrthonormalBasis(this.p)[1]
    this.thetaBeta = Math.atan2(normB, Math.sqrt(dAB * dAB + dBB * dBB))

    this.t = 0
  }

  /** Advance geodesic rotation by one frame */
  step() {
    this.t += this.stepDelta
    if (this.t >= 1) {
      // Reached target plane, make current basis orthonormal and pick next target
      this.alpha = this.evalAlpha(1)
      this.beta = this.evalBeta(1)
      // Re-orthogonalize to avoid any floating drift
      this.alpha = normalize(this.alpha)
      const d = dot(this.alpha, this.beta)
      this.beta = normalize(this.beta.map((v, i) => v - d * this.alpha[i]))
      this.initNextTarget()
    } else {
      this.alpha = this.evalAlpha(this.t)
      this.beta = this.evalBeta(this.t)
    }
  }

  private evalAlpha(s: number): number[] {
    const angle = s * this.thetaAlpha
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    return this.alpha.map((v, i) => c * v + sn * this.qAlpha[i])
  }

  private evalBeta(s: number): number[] {
    const angle = s * this.thetaBeta
    const c = Math.cos(angle)
    const sn = Math.sin(angle)
    return this.beta.map((v, i) => c * v + sn * this.qBeta[i])
  }

  /** Project standard-scaled data rows into 2D coordinates */
  project(
    rowIds: string[],
    dataMatrix: number[][], // shape: N x p
    recordHistory: boolean = true
  ): ProjectionPoint[] {
    const result: ProjectionPoint[] = []

    for (let r = 0; r < rowIds.length; r++) {
      const rowId = rowIds[r]
      const rowData = dataMatrix[r]
      if (!rowData) continue

      let x = 0
      let y = 0
      for (let j = 0; j < this.p; j++) {
        const val = rowData[j] ?? 0
        x += val * this.alpha[j]
        y += val * this.beta[j]
      }

      result.push({ rowId, x, y })

      if (recordHistory) {
        let history = this.trailHistory.get(rowId)
        if (!history) {
          history = []
          this.trailHistory.set(rowId, history)
        }
        history.push({ x, y })
        if (history.length > this.maxTrailLength) {
          history.shift()
        }
      }
    }

    return result
  }

  getTrails(rowId: string): Array<{ x: number; y: number }> {
    return this.trailHistory.get(rowId) || []
  }

  clearHistory() {
    this.trailHistory.clear()
  }

  reset() {
    const [a, b] = randomOrthonormalBasis(this.p)
    this.alpha = a
    this.beta = b
    this.trailHistory.clear()
    this.initNextTarget()
  }
}
