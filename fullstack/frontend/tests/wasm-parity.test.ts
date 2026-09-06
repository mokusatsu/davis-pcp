import { describe, it, expect, beforeAll } from 'vitest'
import { instantiateGraphCore, WasmMemoryView } from '../src/engine/wasmLoader'
import { LocalEngine } from '../src/engine/local'
import type { PcpGeometryRequest, Rect } from '../src/engine/types'

/**
 * Parity: WASM graph-core vs LocalEngine (TS reference) on identical inputs.
 * Runs in Node via direct WebAssembly instantiation — no Worker involved.
 */

function approxArray(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(a[i] - b[i]) > eps) return false
  }
  return true
}

describe('graph-core WASM parity', () => {
  let wasm: { exports: Awaited<ReturnType<typeof instantiateGraphCore>>; view: WasmMemoryView }
  const local = new LocalEngine()

  beforeAll(async () => {
    const exports = await instantiateGraphCore()
    wasm = { exports, view: new WasmMemoryView(exports) }
  })

  it('pcpGeometry matches LocalEngine (horizontal + jitter + reversed)', async () => {
    const nAxes = 4
    const nRows = 500
    const rowIds = Array.from({ length: nRows }, (_, i) => `row${i}`)
    const values = new Float64Array(nRows * nAxes)
    for (let r = 0; r < nRows; r += 1) {
      for (let a = 0; a < nAxes; a += 1) {
        // deterministic pseudo-data incl. categorical column at axis 2
        values[r * nAxes + a] = a === 2
          ? (r % 3) / 2
          : ((r * 37 + a * 101) % 100) / 10
      }
    }
    const axes = [
      { key: 'a', min: 0, max: 9.9, isCategorical: false },
      { key: 'b', min: 0, max: 9.9, isCategorical: false },
      { key: 'c', min: 0, max: 1, isCategorical: true },
      { key: 'd', min: 0, max: 9.9, isCategorical: false },
    ]
    const req: PcpGeometryRequest = {
      width: 900,
      height: 420,
      orientation: 'horizontal',
      axes,
      reversed: { a: false, b: true, c: false, d: false },
      jitterEnabled: true,
      jitterMode: 'pixel',
      jitterAmount: 6,
      jitterSeed: 20020801,
      rowIds,
      values,
    }

    wasm.exports.arena_reset()
    const v = wasm.view
    const paramsPtr = v.exports.arena_alloc(96, 16)
    const p = new DataView(v.buffer, paramsPtr, 96)
    p.setFloat64(0, req.width, true)
    p.setFloat64(8, req.height, true)
    p.setUint32(16, 0, true)
    p.setUint32(20, nAxes, true)
    p.setUint32(24, nRows, true)
    p.setUint32(28, 1, true)
    p.setUint32(32, 0, true) // pixel jitter
    p.setFloat64(40, req.jitterAmount, true)
    p.setFloat64(48, req.jitterSeed, true)
    const reversedPtr = v.allocU32([0, 1, 0, 0])
    const specData = new Float64Array(nAxes * 3)
    axes.forEach((a, i) => {
      specData[i * 3] = a.isCategorical ? 1 : 0
      specData[i * 3 + 1] = a.min
      specData[i * 3 + 2] = a.max
    })
    const specsPtr = v.allocF64(specData)
    const valuesPtr = v.allocF64(values)
    const keyPtrs = axes.map((a) => {
      const bytes = new TextEncoder().encode(a.key)
      const ptr = v.exports.arena_alloc(bytes.length + 9, 8)
      new Uint8Array(v.buffer, ptr, bytes.length + 1).set(bytes)
      return ptr
    })
    const keysPtr = v.allocU32(keyPtrs)
    const rowIdPtrs = rowIds.map((id) => {
      const bytes = new TextEncoder().encode(id)
      const ptr = v.exports.arena_alloc(bytes.length + 9, 8)
      new Uint8Array(v.buffer, ptr, bytes.length + 1).set(bytes)
      return ptr
    })
    const rowIdsPtr = v.allocU32(rowIdPtrs)
    p.setUint32(56, reversedPtr, true)
    p.setUint32(60, specsPtr, true)
    p.setUint32(64, valuesPtr, true)
    p.setUint32(68, keysPtr, true)
    p.setUint32(72, rowIdsPtr, true)

    const outDesc = wasm.exports.compute_pcp_geometry(paramsPtr)
    const d = new Uint32Array(v.buffer, outDesc, 6)
    const wasmPoints = v.readF64(d[0], d[1] / 8)

    const localResult = await local.pcpGeometry(req)
    expect(approxArray(wasmPoints, localResult.points)).toBe(true)
    expect(Array.from(v.readF64(d[4], 4))).toEqual([
      localResult.bounds.left, localResult.bounds.right,
      localResult.bounds.top, localResult.bounds.bottom,
    ])
  })

  it('polylineHit both modes match on synthetic polylines', async () => {
    const nRows = 400
    const nAxes = 5
    const pts = new Float64Array(nRows * nAxes * 2)
    for (let r = 0; r < nRows; r += 1) {
      for (let a = 0; a < nAxes; a += 1) {
        pts[(r * nAxes + a) * 2] = a * 50
        pts[(r * nAxes + a) * 2 + 1] = ((r * 13 + a * 29) % 200)
      }
    }
    const rect: Rect = { x1: 60, y1: 40, x2: 180, y2: 90 }
    const active = new Uint8Array(nRows).fill(1)

    for (const mode of ['legacyVertex', 'segment'] as const) {
      wasm.exports.arena_reset()
      const v = wasm.view
      const ptsPtr = v.allocF64(pts)
      const rectPtr = v.allocRect(rect)
      const activePtr = v.allocU8(active)
      const outPtr = wasm.exports.arena_alloc(nRows + 8, 8)
      wasm.exports.hit_rows_polyline(ptsPtr, nRows, nAxes, mode === 'segment' ? 1 : 0, rectPtr, activePtr, outPtr)
      const flags = v.readU8(outPtr, nRows)
      const wasmHits: number[] = []
      flags.forEach((f, i) => { if (f) wasmHits.push(i) })

      const localHits = await local.polylineHit(pts, nRows, nAxes, rect, mode, active)
      expect(wasmHits).toEqual(localHits)
    }
  })

  it('nearest_row matches LocalEngine threshold semantics', async () => {
    const nRows = 300
    const nAxes = 4
    const pts = new Float64Array(nRows * nAxes * 2)
    for (let r = 0; r < nRows; r += 1) {
      for (let a = 0; a < nAxes; a += 1) {
        pts[(r * nAxes + a) * 2] = a * 40
        pts[(r * nAxes + a) * 2 + 1] = (r % 97) * 3
      }
    }
    const active = new Uint8Array(nRows).fill(1)
    wasm.exports.arena_reset()
    const v = wasm.view
    const ptsPtr = v.allocF64(pts)
    const activePtr = v.allocU8(active)
    const wasmBest = wasm.exports.nearest_row(ptsPtr, nRows, nAxes, 55, 130, 8, activePtr)
    const localBest = await local.nearest(pts, nRows, nAxes, 55, 130, 8, active)
    expect(wasmBest).toBe(localBest)
  })

  it('scatterHit and bandHit match', async () => {
    const n = 250
    const vals = new Float64Array(n * 2)
    const bandVals = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      vals[i * 2] = (i * 7) % 100
      vals[i * 2 + 1] = (i * 11) % 80
      bandVals[i] = (i * 3) % 50
    }
    const rect: Rect = { x1: 20, y1: 15, x2: 70, y2: 60 }
    const active = new Uint8Array(n).fill(1)

    wasm.exports.arena_reset()
    const v = wasm.view
    let valsPtr = v.allocF64(vals)
    let rectPtr = v.allocRect(rect)
    let activePtr = v.allocU8(active)
    let outPtr = wasm.exports.arena_alloc(n + 8, 8)
    wasm.exports.hit_rows_scatter(valsPtr, n, rectPtr, activePtr, outPtr)
    const scatterFlags = v.readU8(outPtr, n)
    const scatterWasm: number[] = []
    scatterFlags.forEach((f, i) => { if (f) scatterWasm.push(i) })
    expect(scatterWasm).toEqual(await local.scatterHit(vals, n, rect, active))

    wasm.exports.arena_reset()
    valsPtr = v.allocF64(bandVals)
    activePtr = v.allocU8(active)
    outPtr = wasm.exports.arena_alloc(n + 8, 8)
    wasm.exports.hit_rows_band(valsPtr, n, 10, 30, activePtr, outPtr)
    const bandFlags = v.readU8(outPtr, n)
    const bandWasm: number[] = []
    bandFlags.forEach((f, i) => { if (f) bandWasm.push(i) })
    expect(bandWasm).toEqual(await local.bandHit(bandVals, n, 10, 30, active))
  })

  it('histogram / histogramGrouped / boxStats / silhouetteOrder / finiteMinMax match', async () => {
    const n = 600
    const vals = new Float64Array(n)
    const groups = new Uint32Array(n)
    for (let i = 0; i < n; i += 1) {
      vals[i] = ((i * 17) % 120) - 10
      groups[i] = i % 3
    }
    wasm.exports.arena_reset()
    const v = wasm.view

    // histogram
    let ptr = v.allocF64(vals)
    let outPtr = wasm.exports.arena_alloc(12 * 4 + 8, 8)
    wasm.exports.histogram_bins(ptr, n, -10, 110, 12, outPtr)
    const wasmHist = Array.from(v.readU32(outPtr, 12))
    expect(wasmHist).toEqual(await local.histogram(vals, n, -10, 110, 12))

    // grouped histogram
    const grpPtr = v.allocU32(groups)
    const gOutPtr = wasm.exports.arena_alloc(36 * 4 + 8, 8)
    wasm.exports.histogram_grouped(ptr, grpPtr, n, -10, 110, 12, 3, gOutPtr)
    const flat = Array.from(v.readU32(gOutPtr, 36))
    const wasmGrouped: number[][] = [0, 1, 2].map((g) => flat.slice(g * 12, g * 12 + 12))
    const localFlat = await local.histogramGrouped(vals, groups, n, -10, 110, 12, 3)
    expect(wasmGrouped).toEqual([
      localFlat.slice(0, 12), localFlat.slice(12, 24), localFlat.slice(24, 36),
    ])

    // boxStats
    const bOutPtr = wasm.exports.arena_alloc(64, 16)
    const scratchPtr = wasm.exports.arena_alloc(n * 8 + 16, 16)
    wasm.exports.box_stats(ptr, n, scratchPtr, bOutPtr)
    const wasmBox = Array.from(v.readF64(bOutPtr, 5)) as [number, number, number, number, number]
    const localBox = await local.boxStats(vals)
    expect(localBox).not.toBeNull()
    expect(approxArray(wasmBox, localBox as number[])).toBe(true)

    // silhouetteOrder
    const labels = Int32Array.from({ length: n }, (_, i) => i % 3)
    const sils = Float64Array.from({ length: n }, (_, i) => (((i * 31) % 100) - 50) / 50)
    wasm.exports.arena_reset()
    const labelsPtr = v.allocU32(Array.from(labels, (x) => (x < 0 ? 0xffffffff : x)))
    const silPtr = v.allocF64(sils)
    const sOutPtr = wasm.exports.arena_alloc(n * 4 + 8, 8)
    wasm.exports.silhouette_order(labelsPtr, silPtr, n, sOutPtr)
    const wasmOrder = Array.from(v.readU32(sOutPtr, n))
    expect(wasmOrder).toEqual(await local.silhouetteOrder(labels, sils))

    // finiteMinMax
    const withNan = Float64Array.from([NaN, 5, NaN, -7.25, 42])
    wasm.exports.arena_reset()
    const nanPtr = v.allocF64(withNan)
    const mmOut = wasm.exports.arena_alloc(24, 8)
    const ok = wasm.exports.finite_min_max(nanPtr, 5, mmOut)
    expect(ok).toBe(1)
    const mm = v.readF64(mmOut, 2)
    const localMm = await local.finiteMinMax(withNan)
    expect(mm[0]).toBe(localMm!.min)
    expect(mm[1]).toBe(localMm!.max)
  })

  it('describeNumeric matches LocalEngine (with NaN gaps)', async () => {
    const n = 400
    const vals = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      vals[i] = i % 7 === 0 ? NaN : ((i * 37) % 500) / 10 - 12.5
    }
    wasm.exports.arena_reset()
    const v = wasm.view
    const valsPtr = v.allocF64(vals)
    const scratchPtr = wasm.exports.arena_alloc(n * 8 + 16, 16)
    const outPtr = wasm.exports.arena_alloc(80, 8)
    const ok = wasm.exports.describe_numeric(valsPtr, n, scratchPtr, outPtr)
    expect(ok).toBe(1)
    const wasmDesc = Array.from(v.readF64(outPtr, 9))
    const localDesc = await local.describeNumeric(vals)
    expect(localDesc).not.toBeNull()
    for (let i = 0; i < 9; i += 1) {
      if (i === 2 || i === 3) {
        // mean/std: allow tiny float drift from different summation order
        expect(Math.abs(wasmDesc[i] - (localDesc as number[])[i])).toBeLessThan(1e-9)
      } else {
        expect(wasmDesc[i]).toBe((localDesc as number[])[i])
      }
    }
  })

  it('correlationMatrix matches LocalEngine and is symmetric with unit diagonal', async () => {
    const n = 250
    const k = 4
    const vals = new Float64Array(n * k)
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < k; c += 1) {
        vals[r * k + c] = c === 3 && r % 11 === 0 ? NaN : Math.sin(r * 0.7 + c * 1.3) + (c === 1 ? r * 0.01 : 0)
      }
    }
    wasm.exports.arena_reset()
    const v = wasm.view
    const valsPtr = v.allocF64(vals)
    const outPtr = wasm.exports.arena_alloc(k * k * 8 + 16, 8)
    wasm.exports.correlation_matrix(valsPtr, n, k, outPtr)
    const wasmCorr = v.readF64(outPtr, k * k)

    const localCorr = await local.correlationMatrix(vals, n, k)
    expect(approxArray(wasmCorr, localCorr)).toBe(true)
    for (let c = 0; c < k; c += 1) {
      expect(wasmCorr[c * k + c]).toBe(1)
      for (let j = 0; j < c; j += 1) {
        expect(wasmCorr[c * k + j]).toBeCloseTo(wasmCorr[j * k + c], 12)
      }
    }
  })

  it('correlationMatrix handles completely NaN columns safely', async () => {
    const n = 100
    const k = 3
    const vals = new Float64Array(n * k).fill(NaN)
    for (let r = 0; r < n; r += 1) {
      vals[r * k + 0] = r
    }
    const localCorr = await local.correlationMatrix(vals, n, k)
    expect(localCorr[0]).toBe(1)
    expect(Number.isNaN(localCorr[1])).toBe(true)
    expect(Number.isNaN(localCorr[2])).toBe(true)
    expect(Number.isNaN(localCorr[3])).toBe(true)
    expect(localCorr[4]).toBe(1)
  })

  /** Shared kMedoids driver: packs the raw ABI params, runs the WASM op,
   *  and returns the descriptor outputs. */
  function runWasmKMedoids(
    vals: Float64Array, n: number, d: number,
    targetK: number, sampleSize: number, swapRounds: number, seed: number,
    specs: Float64Array,
  ): { medoidIndexes: number[]; sizes: number[]; assignment: number[] } {
    wasm.exports.arena_reset()
    const v = wasm.view
    const valsPtr = v.allocF64(vals)
    const specsPtr = v.allocF64(specs)
    const paramsPtr = v.exports.arena_alloc(40, 4)
    const p = new DataView(v.buffer, paramsPtr, 36)
    p.setUint32(0, valsPtr, true)
    p.setUint32(4, n, true)
    p.setUint32(8, d, true)
    p.setUint32(12, targetK, true)
    p.setUint32(16, sampleSize, true)
    p.setUint32(20, swapRounds, true)
    p.setUint32(24, seed, true)
    p.setUint32(28, specsPtr, true)
    const descPtr = v.exports.arena_alloc(24, 4)
    p.setUint32(32, descPtr, true)
    wasm.exports.compute_kmedoids(paramsPtr)
    const desc = new Uint32Array(v.buffer, descPtr, 5)
    expect(desc[4]).toBe(1)
    const k = desc[3]
    return {
      medoidIndexes: Array.from(v.readU32(desc[0], k)),
      sizes: Array.from(v.readU32(desc[1], k)),
      assignment: Array.from(v.readU32(desc[2], n)),
    }
  }

  function makeKMedoidsCase(n: number, d: number, withNanCol: boolean) {
    const vals = new Float64Array(n * d)
    for (let r = 0; r < n; r += 1) {
      for (let a = 0; a < d; a += 1) {
        if (withNanCol && a === d - 1 && r % 17 === 0) { vals[r * d + a] = NaN; continue }
        // Deterministic pseudo-data: numeric spread + categorical band at axis 0.
        vals[r * d + a] = a === 0
          ? (r % 4) / 3
          : ((r * 53 + a * 197) % 1000) / 100
      }
    }
    const specs = new Float64Array(d * 3)
    for (let a = 0; a < d; a += 1) {
      specs[a * 3] = a === 0 ? 1 : 0
      specs[a * 3 + 1] = a === 0 ? 0 : 0
      specs[a * 3 + 2] = a === 0 ? 1 : 9.99
    }
    return { vals, specs }
  }

  it('kMedoids matches LocalEngine exactly (medoids, sizes, assignment)', async () => {
    const n = 600
    const d = 5
    const targetK = 60
    const { vals, specs } = makeKMedoidsCase(n, d, true)
    const wasmRes = runWasmKMedoids(vals, n, d, targetK, 0, 3, 0x5eed1234, specs)
    const localRes = await local.kMedoids(vals, n, d, targetK, 0, 3, 0x5eed1234, specs)
    expect(wasmRes.medoidIndexes).toEqual(localRes.medoidIndexes)
    expect(wasmRes.sizes).toEqual(localRes.sizes)
    expect(wasmRes.assignment).toEqual(localRes.assignment)
  })

  it('kMedoids satisfies invariants (bounds, partition, determinism)', async () => {
    const n = 400
    const d = 3
    const targetK = 50
    const { vals, specs } = makeKMedoidsCase(n, d, false)
    const a = runWasmKMedoids(vals, n, d, targetK, 0, 3, 0x5eed1234, specs)
    const b = runWasmKMedoids(vals, n, d, targetK, 0, 3, 0x5eed1234, specs)
    // Deterministic: identical inputs → identical outputs.
    expect(a.medoidIndexes).toEqual(b.medoidIndexes)
    expect(a.sizes).toEqual(b.sizes)
    expect(a.assignment).toEqual(b.assignment)
    // Medoids: unique, in range, count = k.
    expect(new Set(a.medoidIndexes).size).toBe(a.medoidIndexes.length)
    for (const m of a.medoidIndexes) expect(m).toBeLessThan(n)
    // Partition: every assignment valid, sizes sum to n.
    for (const g of a.assignment) expect(g).toBeLessThan(a.medoidIndexes.length)
    expect(a.sizes.reduce((s, v) => s + v, 0)).toBe(n)
  })

  it('kMedoids identity when k >= n', async () => {
    const n = 40
    const d = 3
    const { vals, specs } = makeKMedoidsCase(n, d, false)
    const res = runWasmKMedoids(vals, n, d, n, 0, 3, 0x5eed1234, specs)
    expect(res.medoidIndexes).toEqual(Array.from({ length: n }, (_, i) => i))
    expect(res.sizes).toEqual(new Array(n).fill(1))
    expect(res.assignment).toEqual(Array.from({ length: n }, (_, i) => i))
  })
})
