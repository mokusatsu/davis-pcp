import type { EChartsOption } from 'echarts'
import { chartLabelLineHeight, chartLabelWidth, wrapChartLabel } from '../../utils/chartLabelLayout'

const array = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value]
const pixels = (value: unknown, extent: number, fallback: number): number => typeof value === 'number' ? value
  : typeof value === 'string' && value.endsWith('%') ? Number.parseFloat(value) * extent / 100 : fallback
const valueOf = (value: any): string => String(value != null && typeof value === 'object' ? value.value ?? '' : value ?? '')
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

/** Bounded category-label layout using the chart's logical viewport. It never
 * changes category data, numerical ticks, series, or the parent's dimensions. */
export function layoutCategoryAxes(option: EChartsOption, width: number, height: number): EChartsOption {
  const xAxes = array(option.xAxis), yAxes = array(option.yAxis)
  const isCategory = (axis: any) => axis.type === 'category' && axis.show !== false && axis.axisLabel?.show !== false && axis.data?.length
  const numericalCategories = (axis: any) => axis.data?.every((entry: any) => /^[-+]?\d+(\.\d+)?$/.test(valueOf(entry))) && !axis.axisLabel?.rotate
  if (!yAxes.some(isCategory) && !xAxes.some(axis => isCategory(axis) && !numericalCategories(axis))) return option
  const grids = array(option.grid ?? {}).map(grid => ({ ...grid }))
  const bounds = grids.map(grid => ({
    left: pixels(grid.left, width, width * .1), right: pixels(grid.right, width, width * .1),
    top: pixels(grid.top, height, 60), bottom: pixels(grid.bottom, height, 60),
  }))
  const labelFont = (axis: any, fontSize: number) => `${axis.axisLabel?.fontStyle ?? option.textStyle?.fontStyle ?? 'normal'} ${axis.axisLabel?.fontWeight ?? option.textStyle?.fontWeight ?? 'normal'} ${fontSize}px ${axis.axisLabel?.fontFamily ?? option.textStyle?.fontFamily ?? 'sans-serif'}`
  const nextY = yAxes.map(axis => {
    if (!isCategory(axis)) return axis
    const index = axis.gridIndex ?? 0, grid = grids[index], rect = bounds[index]
    if (!grid || !rect) return axis
    const side = axis.position === 'right' ? 'right' : 'left'
    const requested = axis.axisLabel?.width ?? (grid.containLabel ? 130 : rect[side] - 16)
    const labelWidth = Math.max(32, Math.min(240, width * .38, requested))
    // containLabel + a label-sized gutter used to reserve the same space twice.
    rect[side] = Math.max(grid.containLabel ? 12 : Math.min(rect[side], width * .42), labelWidth + 16)
    const fontSize = axis.axisLabel?.fontSize ?? option.textStyle?.fontSize ?? 12, lineHeight = chartLabelLineHeight(fontSize)
    const font = labelFont(axis, fontSize)
    const slot = (height - rect.top - rect.bottom) / axis.data.length
    const maxLines = Math.max(1, Math.min(3, Math.floor((slot - 3) / lineHeight)))
    const original = axis.axisLabel?.formatter
    return { ...axis, tooltip: axis.tooltip ?? (axis.triggerEvent ? undefined : { show: true, confine: true, enterable: true, renderMode: 'html', className: 'davis-chart-tooltip',
        extraCssText: 'max-width: min(420px, 80vw); max-height: 50vh; white-space: normal; overflow-wrap: anywhere; overflow: auto',
        formatter: (p: any) => escapeHtml(p.value).replaceAll('\n', '<br/>') }),
      axisLabel: { ...axis.axisLabel, rotate: 0, width: labelWidth, overflow: undefined, lineHeight, interval: 0,
        formatter: (value: string, i: number) => wrapChartLabel(formatValue(original, value, i), labelWidth, maxLines, fontSize, font).join('\n') } }
  })
  const nextX = xAxes.map(axis => {
    if (!isCategory(axis)) return axis
    // Ordinal numerical tick marks (e.g. factor eigenvalue ranks) remain unchanged.
    if (numericalCategories(axis)) return axis
    const index = axis.gridIndex ?? 0, grid = grids[index], rect = bounds[index]
    if (!grid || !rect) return axis
    const fontSize = axis.axisLabel?.fontSize ?? option.textStyle?.fontSize ?? 12, lineHeight = chartLabelLineHeight(fontSize)
    const font = labelFont(axis, fontSize)
    const count = axis.data.length, original = axis.axisLabel?.formatter
    const slot = (width - rect.left - rect.right) / Math.max(1, count)
    const texts = axis.data.map((entry: any, i: number) => formatValue(original, valueOf(entry), i))
    const stagger = texts.some((text: string) => chartLabelWidth(text, fontSize, font) > slot - 10) && count > 1
    const edgeWidth = slot + 2 * Math.min(rect.left, rect.right) - 12
    const labelWidth = Math.max(20, Math.min(220, slot * (stagger ? 2 : 1) - 12, edgeWidth))
    const lineCount = Math.max(...texts.map((text: string) => wrapChartLabel(text, labelWidth, 2, fontSize, font).length))
    const totalLines = lineCount * (stagger ? 2 : 1)
    const side = axis.position === 'top' ? 'top' : 'bottom'
    const labelSpace = totalLines * lineHeight + 14
    // Keep existing title/legend/visualMap space; replace obsolete diagonal-label space.
    const extra = side === 'bottom' ? (option.visualMap ? 34 : axis.name ? 30 : 8) : 8
    rect[side] = Math.max(rect[side], labelSpace + extra)
    const formatter = (value: string, i: number) => {
      const wrapped = wrapChartLabel(formatValue(original, value, i), labelWidth, 2, fontSize, font)
      if (!stagger) return wrapped.join('\n')
      const padded = [...wrapped, ...Array(Math.max(0, lineCount - wrapped.length)).fill('')]
      const gap = Array(lineCount).fill('')
      // Equal-height blocks keep baseline alignment stable for both axis positions.
      return (i % 2 === 0 ? [...padded, ...gap] : [...gap, ...padded]).join('\n')
    }
    return { ...axis, tooltip: axis.tooltip ?? (axis.triggerEvent ? undefined : { show: true, confine: true, enterable: true, renderMode: 'html', className: 'davis-chart-tooltip',
        extraCssText: 'max-width: min(420px, 80vw); max-height: 50vh; white-space: normal; overflow-wrap: anywhere; overflow: auto',
        formatter: (p: any) => escapeHtml(p.value).replaceAll('\n', '<br/>') }),
      axisLabel: { ...axis.axisLabel, rotate: 0, width: labelWidth, overflow: undefined, lineHeight,
        interval: 0, hideOverlap: false, align: 'center', formatter } }
  })
  // X-label allocation can reduce the row slots. Recompute side labels once from
  // the final bounds, with no measurement or iterative resize feedback.
  const finalY = nextY.map((axis, index) => {
    if (!isCategory(axis)) return axis
    const rect = bounds[axis.gridIndex ?? 0]
    if (!rect) return axis
    const fontSize = axis.axisLabel?.fontSize ?? option.textStyle?.fontSize ?? 12, lineHeight = chartLabelLineHeight(fontSize)
    const font = labelFont(axis, fontSize)
    const maxLines = Math.max(1, Math.min(3, Math.floor(((height - rect.top - rect.bottom) / axis.data.length - 3) / lineHeight)))
    const original = yAxes[index].axisLabel?.formatter, labelWidth = axis.axisLabel.width
    return { ...axis, axisLabel: { ...axis.axisLabel,
      formatter: (value: string, i: number) => wrapChartLabel(formatValue(original, value, i), labelWidth, maxLines, fontSize, font).join('\n') } }
  })
  const nextGrids = grids.map((grid, index) => ({ ...grid, ...bounds[index], containLabel: false, outerBoundsMode: 'none' }))
  return { ...option, grid: Array.isArray(option.grid) ? nextGrids : nextGrids[0],
    ...(xAxes.length ? { xAxis: Array.isArray(option.xAxis) ? nextX : nextX[0] } : {}),
    ...(yAxes.length ? { yAxis: Array.isArray(option.yAxis) ? finalY : finalY[0] } : {}) }
}

function formatValue(formatter: any, value: string, index: number): string {
  return typeof formatter === 'function' ? String(formatter(value, index))
    : typeof formatter === 'string' ? formatter.replaceAll('{value}', value) : value
}
