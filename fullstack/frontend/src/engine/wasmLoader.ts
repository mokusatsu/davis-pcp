/**
 * Raw WASM loader for graph-core (no wasm-bindgen).
 * Exports used: memory, arena_reset, arena_alloc, compute_pcp_geometry,
 * hit_rows_polyline, hit_rows_scatter, hit_rows_band, nearest_row,
 * histogram_bins, histogram_grouped, box_stats, silhouette_order, finite_min_max.
 */

export interface GraphCoreExports {
  memory: WebAssembly.Memory
  arena_reset: () => void
  /** size in bytes; 16-byte aligned, returns an absolute linear-memory pointer */
  arena_alloc: (size: number) => number
  compute_pcp_geometry: (paramsPtr: number) => number
  hit_rows_polyline: (
    pointsPtr: number, nRows: number, nAxes: number, mode: number,
    rectPtr: number, activePtr: number, outPtr: number,
  ) => number
  hit_rows_scatter: (
    valuesPtr: number, nRows: number, rectPtr: number, activePtr: number, outPtr: number,
  ) => number
  hit_rows_band: (
    valuesPtr: number, n: number, lo: number, hi: number, activePtr: number, outPtr: number,
  ) => number
  nearest_row: (
    pointsPtr: number, nRows: number, nAxes: number,
    px: number, py: number, threshold: number, activePtr: number,
  ) => number
  histogram_bins: (valuesPtr: number, n: number, min: number, max: number, bins: number, outPtr: number) => number
  histogram_grouped: (
    valuesPtr: number, groupOfPtr: number, n: number, min: number, max: number,
    bins: number, nGroups: number, outPtr: number,
  ) => number
  box_stats: (valuesPtr: number, n: number, scratchPtr: number, outPtr: number) => number
  silhouette_order: (labelsPtr: number, silPtr: number, n: number, outPtr: number) => number
  finite_min_max: (valuesPtr: number, n: number, outPtr: number) => number
  describe_numeric: (valuesPtr: number, n: number, scratchPtr: number, outPtr: number) => number
  correlation_matrix: (valuesPtr: number, n: number, k: number, outPtr: number) => number
  compute_kmedoids: (paramsPtr: number) => number
}

let cachedModule: WebAssembly.Module | null = null

/** Compile once; instantiate per consumer (worker + tests).
 *  Browser: fetch the artifact relative to this module.
 *  Node (vitest): read from disk via fs so no HTTP server is needed. */
export async function compileGraphCore(): Promise<WebAssembly.Module> {
  if (!cachedModule) {
    const bytes = await loadWasmBytes()
    cachedModule = await WebAssembly.compile(bytes)
  }
  return cachedModule
}

async function loadWasmBytes(): Promise<ArrayBuffer> {
  const isNode = typeof process !== 'undefined' && process.versions?.node
  if (isNode) {
    // vitest/Node: resolve relative to this module URL, read from disk.
    const { fileURLToPath } = await import('node:url' as string) as never as { fileURLToPath: (u: string) => string }
    const path = await import('node:path' as string) as never as { resolve: (...p: string[]) => string }
    const req = (await import('node:module' as string) as never as { createRequire: (id: string) => NodeRequire }).createRequire(import.meta.url)
    const here = fileURLToPath(import.meta.url)
    const wasmPath = path.resolve(here, '../../../rust/graph-core/target/wasm32-unknown-unknown/release/graph_core.wasm')
    const buf = req('fs').readFileSync(wasmPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  }
  const url = new URL('../../rust/graph-core/target/wasm32-unknown-unknown/release/graph_core.wasm', import.meta.url)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`graph-core.wasm fetch failed: ${response.status}`)
  return response.arrayBuffer()
}

export async function instantiateGraphCore(): Promise<GraphCoreExports> {
  const module = await compileGraphCore()
  const instance = await WebAssembly.instantiate(module, {})
  return instance.exports as unknown as GraphCoreExports
}

/* ---------- typed memory helpers over the arena ---------- */

export class WasmMemoryView {
  constructor(public exports: GraphCoreExports) {}

  get buffer(): ArrayBuffer {
    return this.exports.memory.buffer
  }

  allocF64(values: ArrayLike<number>): number {
    const bytes = values.length * 8
    const ptr = this.exports.arena_alloc(bytes + 16)
    const view = new Float64Array(this.buffer, ptr, values.length)
    for (let i = 0; i < values.length; i += 1) view[i] = values[i]
    return ptr
  }

  allocU32(values: ArrayLike<number>): number {
    const bytes = values.length * 4
    const ptr = this.exports.arena_alloc(bytes + 8)
    const view = new Uint32Array(this.buffer, ptr, values.length)
    for (let i = 0; i < values.length; i += 1) view[i] = values[i]
    return ptr
  }

  allocU8(values: ArrayLike<number>): number {
    const bytes = values.length
    const ptr = this.exports.arena_alloc(bytes + 8)
    const view = new Uint8Array(this.buffer, ptr, values.length)
    for (let i = 0; i < values.length; i += 1) view[i] = values[i]
    return ptr
  }

  allocRect(rect: { x1: number; y1: number; x2: number; y2: number }): number {
    // [x1,y1,x2,y2] f64 — matches Rust [f64;4] read order (min-x,min-y,max-x,max-y)
    const ptr = this.exports.arena_alloc(40)
    const view = new Float64Array(this.buffer, ptr, 4)
    view[0] = Math.min(rect.x1, rect.x2)
    view[1] = Math.min(rect.y1, rect.y2)
    view[2] = Math.max(rect.x1, rect.x2)
    view[3] = Math.max(rect.y1, rect.y2)
    return ptr
  }

  readF64(ptr: number, len: number): Float64Array {
    return new Float64Array(this.buffer, ptr, len).slice()
  }

  readU32(ptr: number, len: number): Uint32Array {
    return new Uint32Array(this.buffer, ptr, len).slice()
  }

  readU8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.buffer, ptr, len).slice()
  }
}
