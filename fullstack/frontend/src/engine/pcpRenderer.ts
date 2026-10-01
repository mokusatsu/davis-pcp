/**
 * PCP render pipeline — runs INSIDE the graph worker (OffscreenCanvas) or on
 * the main thread as a fallback. Batch-draws polylines grouped by color so the
 * per-row cost is one Path2D segment add instead of a styled stroke call.
 */
import { vizTheme, composedColor } from '../theme/viz'
import { buildPcpLabelLayout, pcpAxisTickValues, type PcpLabelLayout } from './pcpLabelLayout'

export function tracePcpRow(ctx: Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo'>, points: Float64Array, base: number, nAxes: number) {
  let connected = false
  for (let axis = 0; axis < nAxes; axis++) {
    const x = points[base + axis * 2], y = points[base + axis * 2 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) { connected = false; continue }
    if (connected) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
    connected = true
  }
}

export interface PcpRenderSpec {
  width: number
  height: number
  /** 有効DPR = rawDpr × 表示scale。バッファ寸法・context変換・背景塗りはすべてこの値で統一する。 */
  dpr: number
  orientation: 'horizontal' | 'vertical'
  /** flattened geometry points [row][axis][x,y] (from the engine) */
  points: Float64Array
  nRows: number
  nAxes: number
  axisPos: number[]
  bounds: { left: number; right: number; top: number; bottom: number }
  axes: { key: string; label: string; isCategorical: boolean; min: number; max: number; categories?: string[]; valueLabels?: Record<string, string> }[]
  reversed: Record<string, boolean>
  /** Precomputed with the same font metrics as the interactive hit regions. */
  labelLayout?: PcpLabelLayout
  style: {
    showContext: boolean
    lineOpacity: number
    lineWidth: number
    selectedLineWidthBoost: number
  }
  /** per visible row color token: packed index — l1Slot (u8) | l2Group (u8<<8); 0xFFFF = context gray */
  rowColorSlots: Uint16Array
  categoricalPalette: string[]
  selectedFlags: Uint8Array
  hoveredRow: number
  /** Skip drawing rows entirely when the plot is hopelessly dense (row count
   *  above this → draw a deterministic subset). 0 = off. */
  maxContextRows: number
  /** Per drawn row: how many source rows it represents (K-Medoids cluster
   *  sizes). Non-null when draw simplification is active — context line
   *  width scales with it (bigger cluster → thicker line, up to 5px). */
  clusterSizes: Uint32Array | null
  /** Horizontal shift (CSS px) from virtual plot space to this viewport.
   *  Non-zero when the canvas shows a scrolled window of a wider plot —
   *  browsers cap canvas width (~32k px), so wide layouts paint a
   *  frame-sized canvas translated by -scrollLeft instead. Segments fully
   *  outside the viewport are skipped (lossless — they could not be seen). */
  viewportX: number
  /** Vertical shift (CSS px) from virtual plot space to this viewport.
   *  Non-zero when the plot is vertically scrollable in vertical orientation. */
  viewportY?: number
  /** Sparse imputation mask: per drawn row, the set of axis indexes whose
   *  point was imputed. Only rows present here get extra marker rendering —
   *  plain rows cost nothing. Axis indexes follow spec.axes order. */
  imputedAxes?: Map<number, Set<number>>
}

/** Resolve the CSS color for a row from its packed slots. Shared by worker and
 *  main-thread paths so both engines paint identically. */
export function rowColor(spec: PcpRenderSpec, row: number): string {
  const packed = spec.rowColorSlots[row]
  if (packed === 0xffff) return vizTheme(false).contextLine
  const theme = vizTheme(false)
  const l1Slot = packed & 0xff
  const l2Group = (packed >> 8) & 0x7f
  const hasL2 = (packed >> 15) !== 0
  const l1 = l1Slot === 0xff ? null : spec.categoricalPalette[l1Slot % spec.categoricalPalette.length]
  return composedColor(theme, { l1, l2Group: hasL2 ? l2Group : null })
}

/** Cached color resolver — packed slot → CSS color string. Identical packed
 *  values (same category × same group) resolve the HSL→hex path once instead
 *  of per-row. Typical cardinality ≤ categories × groups (tens, not thousands). */
function resolveRowColor(
  spec: PcpRenderSpec, row: number,
  theme: ReturnType<typeof vizTheme>, cache: Map<number, string>,
): string {
  const packed = spec.rowColorSlots[row]
  let color = cache.get(packed)
  if (color !== undefined) return color
  if (packed === 0xffff) {
    color = theme.contextLine
  } else {
    const l1Slot = packed & 0xff
    const l2Group = (packed >> 8) & 0x7f
    const hasL2 = (packed >> 15) !== 0
    const l1 = l1Slot === 0xff ? null : spec.categoricalPalette[l1Slot % spec.categoricalPalette.length]
    color = composedColor(theme, { l1, l2Group: hasL2 ? l2Group : null })
  }
  cache.set(packed, color)
  return color
}

/** The drawing subset used by PCP. Canvas remains the interactive renderer;
 * SVG export implements the same commands so styling cannot drift. */
export interface PcpDrawingContext extends Pick<CanvasRenderingContext2D,
  'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'lineCap' | 'globalAlpha'
  | 'font' | 'textAlign' | 'textBaseline' | 'save' | 'restore' | 'translate' | 'rotate'
  | 'fillRect' | 'setLineDash' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath'
  | 'stroke' | 'fill' | 'fillText'> {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
}

export function renderPcp(ctx: PcpDrawingContext, spec: PcpRenderSpec): void {
  const { width, height, dpr, points, nRows, nAxes, bounds } = spec
  const vpX = spec.viewportX ?? 0
  const vpY = spec.viewportY ?? 0
  // Viewport translation: virtual plot coords → this canvas's local coords.
  ctx.setTransform(dpr, 0, 0, dpr, -vpX * dpr, -vpY * dpr)
  const theme = vizTheme(false)
  ctx.fillStyle = theme.surface
  // Background must cover the CANVAS (not the virtual span): with the
  // translated transform a full-virtual-width rect would only paint whatever
  // intersects the viewport anyway — use an identity-transform fill instead.
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillRect(0, 0, Math.round(width * dpr), Math.round(height * dpr))
  ctx.restore()

  // Batch rows into color buckets: one beginPath/stroke per distinct color.
  // Density decimation: when rows vastly outnumber pixels the overdraw is
  // total — a deterministic subset (every k-th row) paints the same picture
  // for a fraction of the cost. Selected/hovered rows always survive.
  const stride = spec.maxContextRows > 0 && nRows > spec.maxContextRows
    ? Math.ceil(nRows / spec.maxContextRows)
    : 1
  // Viewport bounds in virtual coords (canvas shows [viewportX, viewportX+width]).
  // Segments entirely outside this span are skipped — they could never be
  // seen, so dropping them is lossless (unlike overdraw heuristics, which
  // visibly thin out translucent lines and make selection change the look).
  const vpLeft = vpX - spec.style.lineWidth
  const vpRight = vpX + width + spec.style.lineWidth
  const vpTop = vpY - spec.style.lineWidth
  const vpBottom = vpY + height + spec.style.lineWidth

  // Cluster-size → line width: a drawn row representing more source rows is
  // thicker (up to 5px). sqrt scaling: with sizes spanning 1..hundreds a
  // linear ramp pins almost everything at base width, hiding mid clusters.
  let maxSize = 1
  if (spec.clusterSizes) {
    for (let i = 0; i < spec.clusterSizes.length; i += 1) {
      if (spec.clusterSizes[i] > maxSize) maxSize = spec.clusterSizes[i]
    }
  }
  const rowWidth = (r: number): number => {
    if (!spec.clusterSizes) return spec.style.lineWidth
    const base = spec.style.lineWidth
    const size = spec.clusterSizes[r] ?? 1
    const w = base + (5 - base) * Math.sqrt(Math.max(0, size - 1) / Math.max(1, maxSize - 1))
    return Math.min(5, Math.max(base, w))
  }

  // Packed-slot → CSS color cache: avoids redundant hex→HSL→hex conversions.
  // Typical cardinality ≤ categories × L2 groups (tens, not thousands).
  const colorCache = new Map<number, string>()

  // Viewport culling helper: returns true if the row is entirely outside the
  // visible viewport and can be safely skipped.
  const isOutsideViewport = (base: number): boolean => {
    if (spec.orientation === 'vertical') {
      // PCP lines connect adjacent axis positions; for vertical orientation
      // the first and last axis bracket the row's y-extent.
      const firstY = points[base + 1]
      const lastY = points[base + (nAxes - 1) * 2 + 1]
      const minY = firstY < lastY ? firstY : lastY
      const maxY = firstY > lastY ? firstY : lastY
      return maxY < vpTop || minY > vpBottom
    }
    // Horizontal: first and last axis bracket the row's x-extent (axes are
    // evenly spaced left-to-right, so the first and last x values are the
    // extremes for a horizontal PCP row).
    const firstX = points[base]
    const lastX = points[base + (nAxes - 1) * 2]
    const minX = firstX < lastX ? firstX : lastX
    const maxX = firstX > lastX ? firstX : lastX
    return maxX < vpLeft || minX > vpRight
  }

  // Bucket key = color + 0.25px-quantized width so each stroke call is one
  // style pair; width varies per row only under draw simplification.
  // Viewport culling is done HERE so rejected rows never enter any bucket.
  const buckets = new Map<string, number[]>()
  let selectedCount = 0
  for (let r = 0; r < nRows; r += 1) {
    if (spec.selectedFlags[r]) { selectedCount += 1; continue }
    if (!spec.style.showContext && spec.hoveredRow !== r) continue
    if (stride > 1 && r % stride !== 0 && r !== spec.hoveredRow) continue
    // Viewport cull at bucket stage: skip rows entirely outside the viewport.
    const base = r * nAxes * 2
    if (nAxes > 1 && isOutsideViewport(base)) continue
    const color = resolveRowColor(spec, r, theme, colorCache)
    const wq = Math.round(rowWidth(r) * 4) / 4
    const key = `${color}|${wq}`
    let list = buckets.get(key)
    if (!list) {
      list = []
      buckets.set(key, list)
    }
    list.push(r)
  }

  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.globalAlpha = spec.style.lineOpacity
  for (const [key, rows] of buckets) {
    const sep = key.lastIndexOf('|')
    ctx.strokeStyle = key.slice(0, sep)
    ctx.lineWidth = Number(key.slice(sep + 1))
    ctx.beginPath()
    for (const r of rows) {
      const base = r * nAxes * 2
      // Viewport culling already done at bucket stage — no per-row check here.
      tracePcpRow(ctx, points, base, nAxes)
    }
    ctx.stroke()
  }

  // Selected lines with halo — batched by color to minimise draw calls.
  // Pass 0 (halo): all selected rows share the same style → one stroke.
  // Pass 1 (foreground): bucket by resolved color → one stroke per color.
  if (selectedCount > 0) {
    // Pass 0: halo — single style for all selected rows.
    ctx.globalAlpha = 0.88
    ctx.strokeStyle = theme.surface
    ctx.lineWidth = spec.style.lineWidth + 3.8
    ctx.beginPath()
    for (let r = 0; r < nRows; r += 1) {
      if (!spec.selectedFlags[r]) continue
      const base = r * nAxes * 2
      tracePcpRow(ctx, points, base, nAxes)
    }
    ctx.stroke()

    // Pass 1: foreground — bucket by color.
    ctx.globalAlpha = 0.96
    ctx.lineWidth = Math.max(2.2, spec.style.lineWidth + 1.3)
    const selBuckets = new Map<string, number[]>()
    for (let r = 0; r < nRows; r += 1) {
      if (!spec.selectedFlags[r]) continue
      const color = resolveRowColor(spec, r, theme, colorCache)
      const resolved = color === theme.contextLine ? theme.selection : color
      let list = selBuckets.get(resolved)
      if (!list) {
        list = []
        selBuckets.set(resolved, list)
      }
      list.push(r)
    }
    for (const [color, rows] of selBuckets) {
      ctx.strokeStyle = color
      ctx.beginPath()
      for (const r of rows) {
        const base = r * nAxes * 2
        tracePcpRow(ctx, points, base, nAxes)
      }
      ctx.stroke()
    }
  }

  // Imputed-point markers: diamond at each imputed point plus a dashed
  // overlay on the two segments touching it. Normal rows cost nothing.
  if (spec.imputedAxes && spec.imputedAxes.size > 0) {
    ctx.save()
    ctx.globalAlpha = 1
    for (const [row, axes] of spec.imputedAxes) {
      if (row < 0 || row >= nRows) continue
      const base = row * nAxes * 2
      ctx.strokeStyle = '#7c3aed'
      ctx.fillStyle = '#7c3aed'
      ctx.lineWidth = Math.max(1.5, spec.style.lineWidth)
      ctx.setLineDash([4, 3])
      for (const axis of axes) {
        if (axis < 0 || axis >= nAxes) continue
        for (const neighbor of [axis - 1, axis]) {
          if (neighbor < 0 || neighbor >= nAxes - 1) continue
          const x1 = points[base + neighbor * 2], y1 = points[base + neighbor * 2 + 1]
          const x2 = points[base + (neighbor + 1) * 2], y2 = points[base + (neighbor + 1) * 2 + 1]
          if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue
          ctx.beginPath()
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          ctx.stroke()
        }
        const px = points[base + axis * 2], py = points[base + axis * 2 + 1]
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue
        const size = 4
        ctx.beginPath()
        ctx.moveTo(px, py - size)
        ctx.lineTo(px + size, py)
        ctx.lineTo(px, py + size)
        ctx.lineTo(px - size, py)
        ctx.closePath()
        ctx.fill()
      }
      ctx.setLineDash([])
    }
    ctx.restore()
  }

  // Hover highlight.
  if (spec.hoveredRow >= 0 && spec.hoveredRow < nRows) {
    const base = spec.hoveredRow * nAxes * 2
    ctx.save()
    ctx.globalAlpha = 1
    ctx.strokeStyle = theme.surface
    ctx.lineWidth = spec.style.lineWidth + 6
    ctx.beginPath()
    tracePcpRow(ctx, points, base, nAxes)
    ctx.stroke()
    const color = resolveRowColor(spec, spec.hoveredRow, theme, colorCache)
    ctx.strokeStyle = spec.selectedFlags[spec.hoveredRow] ? theme.selection : color
    ctx.lineWidth = spec.style.lineWidth + 3
    ctx.beginPath()
    tracePcpRow(ctx, points, base, nAxes)
    ctx.stroke()
    ctx.restore()
  }

  // Axis chrome: hairlines + tick labels. Reset alpha — with no selection the
  // context-line opacity (0.22) is still in effect and would render the axis
  // names washed-out gray (user-visible bug).
  ctx.globalAlpha = 1
  ctx.lineWidth = 1
  ctx.font = '10px sans-serif'

  for (let a = 0; a < nAxes; a += 1) {
    const axis = spec.axes[a]
    const anchor = spec.axisPos[a]
    ctx.strokeStyle = theme.axis
    ctx.fillStyle = theme.inkMuted
    if (spec.orientation === 'horizontal') {
      ctx.beginPath()
      ctx.moveTo(anchor, bounds.top)
      ctx.lineTo(anchor, bounds.bottom)
      ctx.stroke()
      const ticks = pcpAxisTickValues(axis)
      for (const value of ticks) {
        let t = axis.max === axis.min ? 0.5 : (value - axis.min) / (axis.max - axis.min)
        if (spec.reversed[axis.key]) t = 1 - t
        const y = bounds.bottom - t * (bounds.bottom - bounds.top)
        ctx.beginPath()
        ctx.moveTo(anchor - 4, y)
        ctx.lineTo(anchor + 4, y)
        ctx.stroke()
      }
    } else {
      ctx.beginPath()
      ctx.moveTo(bounds.left, anchor)
      ctx.lineTo(bounds.right, anchor)
      ctx.stroke()
      const ticks = pcpAxisTickValues(axis)
      for (const value of ticks) {
        let t = axis.max === axis.min ? 0.5 : (value - axis.min) / (axis.max - axis.min)
        if (spec.reversed[axis.key]) t = 1 - t
        const x = bounds.left + t * (bounds.right - bounds.left)
        ctx.beginPath()
        ctx.moveTo(x, anchor - 3)
        ctx.lineTo(x, anchor + 3)
        ctx.stroke()
      }
    }
  }
  const labelLayout = spec.labelLayout ?? buildPcpLabelLayout(spec)
  for (const label of [...labelLayout.ticks, ...labelLayout.axes]) {
    ctx.fillStyle = label.kind === 'axis' ? theme.inkPrimary : theme.inkMuted
    ctx.font = label.kind === 'axis' ? `700 ${label.fontSize}px system-ui, sans-serif` : `${label.fontSize}px sans-serif`
    ctx.textAlign = label.align
    ctx.textBaseline = 'top'
    const x = label.x + (label.align === 'right' ? label.width : label.width / 2)
    label.lines.forEach((line, index) => ctx.fillText(line, x, label.y + index * label.lineHeight))
  }
  ctx.globalAlpha = 1
}
