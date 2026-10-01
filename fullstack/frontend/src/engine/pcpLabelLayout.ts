import { chartLabelLineHeight, chartLabelWidth, wrapChartLabel } from '../utils/chartLabelLayout'

export interface PcpTextLayout {
  axisIndex: number
  fullText: string
  lines: string[]
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  lineHeight: number
  align: 'center' | 'right'
  kind: 'axis' | 'tick'
  code?: string
}
export interface PcpLabelLayout { axes: PcpTextLayout[]; ticks: PcpTextLayout[] }
interface LayoutInput {
  orientation: 'horizontal' | 'vertical'
  axisPos: number[]
  bounds: { left: number; right: number; top: number; bottom: number }
  axes: { key: string; label: string; isCategorical: boolean; min: number; max: number; categories?: string[]; valueLabels?: Record<string, string> }[]
  reversed: Record<string, boolean>
}

/** A constant/all-missing numeric domain has one midpoint tick, not five copies. */
export function pcpAxisTickValues(axis: LayoutInput['axes'][number]): number[] {
  if (axis.isCategorical) return (axis.categories ?? []).map((_, index) => index)
  if (axis.min === axis.max) return [axis.min]
  return Array.from({ length: 5 }, (_, index) => axis.min + ((axis.max - axis.min) * index) / 4)
}

/** Keep signs, exponents and decimal places in one atomic numeric token. */
function numericTick(value: number, width: number, fontSize: number): string | undefined {
  const ordinary = value !== 0 && Math.abs(value) < .05 ? String(value) : value.toFixed(1)
  const candidates = [ordinary, String(value), ...[3, 2, 1, 0].map(precision => value.toExponential(precision))]
  return candidates.find(candidate => chartLabelWidth(candidate, fontSize) <= width)
}

/** One logical-pixel layout is reused by Canvas, the SVG hit layer and export.
 * No measured text dimension flows back into the viewport or graph geometry. */
export function buildPcpLabelLayout(input: LayoutInput): PcpLabelLayout {
  const { axisPos, bounds, axes, orientation, reversed } = input
  const horizontal = orientation === 'horizontal'
  const output: PcpLabelLayout = { axes: [], ticks: [] }
  const fontSize = 11, lineHeight = chartLabelLineHeight(fontSize)
  const pitch = axisPos.length > 1
    ? Math.min(...axisPos.slice(1).map((position, index) => Math.abs(position - axisPos[index])))
    : horizontal ? bounds.right - bounds.left : bounds.bottom - bounds.top
  const stagger = horizontal && pitch < 150 && axes.length > 1
  axes.forEach((axis, axisIndex) => {
    const anchor = axisPos[axisIndex]
    if (!Number.isFinite(anchor)) return
    const laneStep = stagger ? 2 : 1
    const laneLeft = axisIndex >= laneStep ? (anchor + axisPos[axisIndex - laneStep]) / 2 + 6 : 4
    const laneRight = axisIndex + laneStep < axisPos.length ? (anchor + axisPos[axisIndex + laneStep]) / 2 - 6 : bounds.right + bounds.left - 4
    const width = horizontal ? Math.max(12, Math.min(240, pitch * laneStep - 12, laneRight - laneLeft)) : Math.max(12, bounds.left - 18)
    const maxLines = horizontal ? 2 : Math.max(1, Math.min(3, Math.floor((pitch - 6) / lineHeight)))
    const lines = wrapChartLabel(axis.label, width, maxLines, fontSize, `700 ${fontSize}px system-ui, sans-serif`)
    const height = lines.length * lineHeight
    // 64px bottom gutter supports two rows, each with two horizontal lines.
    const x = horizontal ? Math.max(laneLeft, Math.min(anchor - width / 2, laneRight - width)) : 4
    const y = horizontal ? bounds.bottom + 5 + (stagger ? axisIndex % 2 : 0) * (2 * lineHeight + 2) : anchor - height / 2
    output.axes.push({ axisIndex, fullText: axis.label, lines, x, y, width, height, fontSize, lineHeight, align: horizontal ? 'center' : 'right', kind: 'axis' })

    const ticks = pcpAxisTickValues(axis)
    const tickFont = 10, tickLineHeight = chartLabelLineHeight(tickFont)
    const tickPitch = (horizontal ? bounds.bottom - bounds.top : bounds.right - bounds.left) / Math.max(1, ticks.length - 1)
    const labelStride = horizontal ? Math.max(1, Math.ceil(tickLineHeight / Math.max(1, tickPitch))) : 1
    ticks.forEach((value, index) => {
      if (index % labelStride !== 0) return
      let t = axis.max === axis.min ? 0.5 : (value - axis.min) / (axis.max - axis.min)
      if (reversed[axis.key]) t = 1 - t
      const code = axis.isCategorical ? String(axis.categories?.[value] ?? value) : String(Number(value))
      const mapped = axis.valueLabels?.[code]
      const fullText = mapped ?? (axis.isCategorical ? code : String(value))
      const tickWidth = horizontal ? Math.max(12, Math.min(140, pitch - 14, anchor - 11)) : Math.max(12, Math.min(140, tickPitch - 8))
      const maxTickLines = horizontal ? Math.max(1, Math.min(3, Math.floor((tickPitch - 3) / tickLineHeight)))
        : Math.max(1, Math.min(2, Math.floor((pitch / 2 - 5) / tickLineHeight)))
      const numeric = numericTick(value, tickWidth, tickFont)
      // Textual value labels may wrap; numeric tick tokens never wrap or use ellipses.
      const tickLines = axis.isCategorical || mapped !== undefined
        ? wrapChartLabel(fullText, tickWidth, maxTickLines, tickFont) : numeric ? [numeric] : []
      if (!tickLines.length) return
      const tickHeight = tickLines.length * tickLineHeight
      const tickX = horizontal ? anchor - 7 - tickWidth : Math.max(bounds.left, Math.min(bounds.right - tickWidth, bounds.left + t * (bounds.right - bounds.left) - tickWidth / 2))
      const tickY = horizontal ? Math.max(bounds.top, Math.min(bounds.bottom - tickHeight, bounds.bottom - t * (bounds.bottom - bounds.top) - tickHeight / 2)) : anchor - 5 - tickHeight
      output.ticks.push({ axisIndex, code, fullText, lines: tickLines, x: tickX, y: tickY, width: tickWidth, height: tickHeight, fontSize: tickFont, lineHeight: tickLineHeight, align: horizontal ? 'right' : 'center', kind: 'tick' })
    })
  })
  return output
}
