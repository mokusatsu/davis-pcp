/**
 * Shared graph compute worker: owns the WASM graph-core instance and serves
 * every view's engine calls via request/response RPC. Falls back to running
 * LocalEngine inside the worker when WASM fails to instantiate.
 */
/// <reference lib="webworker" />
import { instantiateGraphCore, WasmMemoryView, type GraphCoreExports } from './wasmLoader'
import { LocalEngine } from './local'
import type { PcpGeometryRequest, Rect } from './types'

type RpcRequest =
  | { id: number; op: 'ping' }
  | { id: number; op: 'pcpGeometry'; req: PcpGeometryRequest }
  | { id: number; op: 'polylineHit'; points: Float64Array; nRows: number; nAxes: number; rect: Rect; mode: string; active: Uint8Array }
  | { id: number; op: 'scatterHit'; values: Float64Array; nRows: number; rect: Rect; active: Uint8Array }
  | { id: number; op: 'bandHit'; values: Float64Array; nRows: number; lo: number; hi: number; active: Uint8Array }
  | { id: number; op: 'nearest'; points: Float64Array; nRows: number; nAxes: number; px: number; py: number; threshold: number; active: Uint8Array }
  | { id: number; op: 'histogram'; values: Float64Array; n: number; min: number; max: number; bins: number }
  | { id: number; op: 'histogramGrouped'; values: Float64Array; groupOf: Uint32Array; n: number; min: number; max: number; bins: number; nGroups: number }
  | { id: number; op: 'boxStats'; values: Float64Array }
  | { id: number; op: 'silhouetteOrder'; labels: Int32Array; sil: Float64Array }
  | { id: number; op: 'finiteMinMax'; values: Float64Array }
  | { id: number; op: 'describeNumeric'; values: Float64Array }
  | { id: number; op: 'correlationMatrix'; values: Float64Array; n: number; k: number }
  | { id: number; op: 'kMedoids'; values: Float64Array; n: number; d: number; targetK: number; sampleSize: number; swapRounds: number; seed: number; specs: Float64Array }

type RpcResponse =
  | { id: number; ok: true; result: unknown; engineKind: 'wasm' | 'local' }
  | { id: number; ok: false; error: string }

let wasm: { exports: GraphCoreExports; view: WasmMemoryView } | null = null
let wasmFailed = false

async function ensureWasm(): Promise<{ exports: GraphCoreExports; view: WasmMemoryView } | null> {
  if (wasm) return wasm
  if (wasmFailed) return null
  try {
    const exports = await instantiateGraphCore()
    wasm = { exports, view: new WasmMemoryView(exports) }
    return wasm
  } catch {
    wasmFailed = true
    return null
  }
}

function runWasm(message: RpcRequest): unknown | undefined {
  const w = wasm!
  w.exports.arena_reset()
  const v = w.view

  switch (message.op) {
    case 'pcpGeometry': {
      const req = message.req
      // A dataset switch mid-flight can deliver a request whose axes/rowIds
      // arrays are stale/undefined — fail fast into the local fallback
      // instead of throwing "reading 'isCategorical'" (audit #5). Element-level
      // check matters: throwing from runWasm permanently marks the WASM
      // instance failed (wasmFailed latches), so a transient race must not
      // reach the throw path.
      if (!req || !Array.isArray(req.axes) || !Array.isArray(req.rowIds) || !req.values
        || req.axes.some((a) => !a || typeof a.key !== 'string')
        || req.rowIds.some((id) => typeof id !== 'string')) {
        throw new Error('pcpGeometry: malformed request (missing axes/rowIds/values)')
      }
      const nAxes = req.axes.length
      const nRows = req.rowIds.length
      if (!nAxes || !nRows) {
        throw new Error('pcpGeometry: empty axes or rows')
      }
      if (req.values.length < nRows * nAxes) {
        throw new Error('pcpGeometry: values shorter than rows×axes')
      }
      // params block (72 bytes):
      // width f64 | height f64 | orientation u32 | nAxes u32 | nRows u32 |
      // jitterEnabled u32 | jitterMode u32 | pad u32 | jitterAmount f64 |
      // jitterSeed f64(i32) | reversedPtr u32 | specsPtr u32 | valuesPtr u32
      const paramsPtr = v.exports.arena_alloc(96)
      const p = new DataView(v.buffer, paramsPtr, 96)
      p.setFloat64(0, req.width, true)
      p.setFloat64(8, req.height, true)
      p.setUint32(16, req.orientation === 'vertical' ? 1 : 0, true)
      p.setUint32(20, nAxes, true)
      p.setUint32(24, nRows, true)
      p.setUint32(28, req.jitterEnabled ? 1 : 0, true)
      p.setUint32(32, req.jitterMode === 'legacyRaw' ? 1 : 0, true)
      p.setFloat64(40, req.jitterAmount, true)
      p.setFloat64(48, req.jitterSeed, true)
      const reversedPtr = v.allocU32(req.axes.map((a) => (req.reversed[a.key] ? 1 : 0)))
      const specData = new Float64Array(nAxes * 3)
      req.axes.forEach((a, i) => {
        specData[i * 3] = a.isCategorical ? 1 : 0
        specData[i * 3 + 1] = a.min
        specData[i * 3 + 2] = a.max
      })
      const specsPtr = v.allocF64(specData)
      const valuesPtr = v.allocF64(req.values)
      // NUL-terminated axis key strings (jitter determinism uses real names).
      const keyPtrs = req.axes.map((a) => {
        const bytes = new TextEncoder().encode(a.key)
        const ptr = v.exports.arena_alloc(bytes.length + 9)
        const u8 = new Uint8Array(v.buffer, ptr, bytes.length + 1)
        u8.set(bytes)
        return ptr
      })
      const keysPtr = v.allocU32(keyPtrs)
      // Row-id strings (jitter determinism uses the real row id).
      const rowIdPtrs = req.rowIds.map((id) => {
        const bytes = new TextEncoder().encode(id)
        const ptr = v.exports.arena_alloc(bytes.length + 9)
        new Uint8Array(v.buffer, ptr, bytes.length + 1).set(bytes)
        return ptr
      })
      const rowIdsPtr = v.allocU32(rowIdPtrs)
      p.setUint32(56, reversedPtr, true)
      p.setUint32(60, specsPtr, true)
      p.setUint32(64, valuesPtr, true)
      p.setUint32(68, keysPtr, true)
      p.setUint32(72, rowIdsPtr, true)

      const outDesc = w.exports.compute_pcp_geometry(paramsPtr)
      const d = new Uint32Array(v.buffer, outDesc, 6)
      const ptsLen = d[1] / 8
      const b = v.readF64(d[4], 4)
      return {
        // {left,right,top,bottom} object — GeometryResult contract; the
        // LocalEngine fallback and every consumer use named fields.
        bounds: { left: b[0], right: b[1], top: b[2], bottom: b[3] },
        axisPos: Array.from(v.readF64(d[2], d[3] / 8)),
        points: v.readF64(d[0], ptsLen),
      }
    }
    case 'polylineHit': {
      const ptsPtr = v.allocF64(message.points)
      const rectPtr = v.allocRect(message.rect)
      const activePtr = v.allocU8(message.active)
      const outPtr = v.exports.arena_alloc(message.nRows + 8)
      const mode = message.mode === 'segment' ? 1 : 0
      w.exports.hit_rows_polyline(ptsPtr, message.nRows, message.nAxes, mode, rectPtr, activePtr, outPtr)
      return collectHits(v.readU8(outPtr, message.nRows))
    }
    case 'scatterHit': {
      const valsPtr = v.allocF64(message.values)
      const rectPtr = v.allocRect(message.rect)
      const activePtr = v.allocU8(message.active)
      const outPtr = v.exports.arena_alloc(message.nRows + 8)
      w.exports.hit_rows_scatter(valsPtr, message.nRows, rectPtr, activePtr, outPtr)
      return collectHits(v.readU8(outPtr, message.nRows))
    }
    case 'bandHit': {
      const valsPtr = v.allocF64(message.values)
      const activePtr = v.allocU8(message.active)
      const outPtr = v.exports.arena_alloc(message.nRows + 8)
      w.exports.hit_rows_band(valsPtr, message.nRows, message.lo, message.hi, activePtr, outPtr)
      return collectHits(v.readU8(outPtr, message.nRows))
    }
    case 'nearest': {
      const ptsPtr = v.allocF64(message.points)
      const activePtr = v.allocU8(message.active)
      return w.exports.nearest_row(
        ptsPtr, message.nRows, message.nAxes,
        message.px, message.py, message.threshold, activePtr,
      )
    }
    case 'histogram': {
      const valsPtr = v.allocF64(message.values)
      const outPtr = v.exports.arena_alloc(message.bins * 4 + 8)
      w.exports.histogram_bins(valsPtr, message.n, message.min, message.max, message.bins, outPtr)
      return Array.from(v.readU32(outPtr, message.bins))
    }
    case 'histogramGrouped': {
      const valsPtr = v.allocF64(message.values)
      const grpPtr = v.allocU32(message.groupOf)
      const outPtr = v.exports.arena_alloc(message.nGroups * message.bins * 4 + 8)
      w.exports.histogram_grouped(
        valsPtr, grpPtr, message.n, message.min, message.max,
        message.bins, message.nGroups, outPtr,
      )
      return Array.from(v.readU32(outPtr, message.nGroups * message.bins))
    }
    case 'boxStats': {
      if (!message.values.length) return null
      const valsPtr = v.allocF64(message.values)
      const scratchPtr = v.exports.arena_alloc(message.values.length * 8 + 16)
      const outPtr = v.exports.arena_alloc(64)
      const ok = w.exports.box_stats(valsPtr, message.values.length, scratchPtr, outPtr)
      if (!ok) return null
      return Array.from(v.readF64(outPtr, 5))
    }
    case 'silhouetteOrder': {
      const labelsPtr = v.allocU32(Array.from(message.labels, (x) => x < 0 ? 0xffffffff : x))
      const silPtr = v.allocF64(message.sil)
      const outPtr = v.exports.arena_alloc(message.labels.length * 4 + 8)
      w.exports.silhouette_order(labelsPtr, silPtr, message.labels.length, outPtr)
      return Array.from(v.readU32(outPtr, message.labels.length))
    }
    case 'finiteMinMax': {
      const valsPtr = v.allocF64(message.values)
      const outPtr = v.exports.arena_alloc(24)
      const ok = w.exports.finite_min_max(valsPtr, message.values.length, outPtr)
      if (!ok) return null
      const mm = v.readF64(outPtr, 2)
      return { min: mm[0], max: mm[1] }
    }
    case 'describeNumeric': {
      if (!message.values.length) return null
      const valsPtr = v.allocF64(message.values)
      const scratchPtr = v.exports.arena_alloc(message.values.length * 8 + 16)
      const outPtr = v.exports.arena_alloc(80)
      const ok = w.exports.describe_numeric(valsPtr, message.values.length, scratchPtr, outPtr)
      if (!ok) return null
      return Array.from(v.readF64(outPtr, 9))
    }
    case 'correlationMatrix': {
      if (!message.k) return new Float64Array(0)
      const valsPtr = v.allocF64(message.values)
      const outPtr = v.exports.arena_alloc(message.k * message.k * 8 + 16)
      w.exports.correlation_matrix(valsPtr, message.n, message.k, outPtr)
      return v.readF64(outPtr, message.k * message.k)
    }
    case 'kMedoids': {
      const n = message.n
      const d = message.d
      const valsPtr = v.allocF64(message.values)
      const specsPtr = v.allocF64(message.specs)
      const paramsPtr = v.exports.arena_alloc(40)
      const p = new DataView(v.buffer, paramsPtr, 36)
      p.setUint32(0, valsPtr, true)
      p.setUint32(4, n, true)
      p.setUint32(8, d, true)
      p.setUint32(12, message.targetK, true)
      p.setUint32(16, message.sampleSize, true)
      p.setUint32(20, message.swapRounds, true)
      p.setUint32(24, message.seed, true)
      p.setUint32(28, specsPtr, true)
      const descPtr = v.exports.arena_alloc(24)
      p.setUint32(32, descPtr, true)
      w.exports.compute_kmedoids(paramsPtr)
      const desc = new Uint32Array(v.buffer, descPtr, 5)
      const k = desc[3]
      return {
        medoidIndexes: Array.from(v.readU32(desc[0], k)),
        sizes: Array.from(v.readU32(desc[1], k)),
        assignment: Array.from(v.readU32(desc[2], n)),
      }
    }
    default:
      return undefined
  }
}

/** WASM silhouette ABI uses unsigned labels; map back is unnecessary here —
 *  hits are indexes either way. Kept for clarity in parity tests. */
function collectHits(flags: Uint8Array): number[] {
  const hits: number[] = []
  for (let i = 0; i < flags.length; i += 1) if (flags[i]) hits.push(i)
  return hits
}

const local = new LocalEngine()

async function handle(message: RpcRequest): Promise<unknown> {
  const w = await ensureWasm()
  if (w) {
    try {
      return runWasm(message)
    } catch {
      // Malformed-request races (stale arrays mid dataset switch) must NOT
      // latch wasmFailed — the WASM instance itself is healthy and the next
      // well-formed request should use it again. Only a genuine
      // instantiation failure (ensureWasm catch) disables WASM permanently.
      wasm = null
      // fall through to local
    }
  }
  switch (message.op) {
    case 'ping': return 'pong'
    case 'pcpGeometry': return local.pcpGeometry(message.req)
    case 'polylineHit': return local.polylineHit(message.points, message.nRows, message.nAxes, message.rect, message.mode as 'legacyVertex' | 'segment', message.active)
    case 'scatterHit': return local.scatterHit(message.values, message.nRows, message.rect, message.active)
    case 'bandHit': return local.bandHit(message.values, message.nRows, message.lo, message.hi, message.active)
    case 'nearest': return local.nearest(message.points, message.nRows, message.nAxes, message.px, message.py, message.threshold, message.active)
    case 'histogram': return local.histogram(message.values, message.n, message.min, message.max, message.bins)
    case 'histogramGrouped': return local.histogramGrouped(message.values, message.groupOf, message.n, message.min, message.max, message.bins, message.nGroups)
    case 'boxStats': return local.boxStats(message.values)
    case 'silhouetteOrder': return local.silhouetteOrder(message.labels, message.sil)
    case 'finiteMinMax': return local.finiteMinMax(message.values)
    case 'describeNumeric': return local.describeNumeric(message.values)
    case 'correlationMatrix': return local.correlationMatrix(message.values, message.n, message.k)
    case 'kMedoids': return local.kMedoids(message.values, message.n, message.d, message.targetK, message.sampleSize, message.swapRounds, message.seed, message.specs)
  }
}

self.onmessage = async (event: MessageEvent<RpcRequest>) => {
  const message = event.data
  try {
    const result = await handle(message)
    const response: RpcResponse = {
      id: message.id,
      ok: true,
      result,
      engineKind: wasm && !wasmFailed ? 'wasm' : 'local',
    }
    self.postMessage(response)
  } catch (error) {
    const response: RpcResponse = { id: message.id, ok: false, error: String(error) }
    self.postMessage(response)
  }
}

export {}
