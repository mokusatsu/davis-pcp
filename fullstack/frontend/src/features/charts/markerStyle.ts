/** Ordinary chart markers, in CSS pixels at 100% graph zoom.
 * Visible size is independent of the interaction target. Keep size-encoded
 * bubbles, tree nodes, arrowheads and reference geometry out of this policy.
 * Automatic Fit is compensated; explicit zoom intentionally scales tokens.
 */
export const CHART_MARKERS = Object.freeze({
  diameter: 6,
  hoverDiameter: 8,
  selectedDiameter: 9,
  hitRadius: 12,
  nearestRadius: 8,
  ringGap: 3,
})

export function pointDiameter(selected = false, hovered = false): number {
  return selected ? CHART_MARKERS.selectedDiameter : hovered ? CHART_MARKERS.hoverDiameter : CHART_MARKERS.diameter
}

export function pointRadius(selected = false, hovered = false): number {
  return pointDiameter(selected, hovered) / 2
}

/** Native hover must not add a second, chart-specific size multiplier. */
export function pointEmphasis(selected = false, hovered = false) {
  return { scale: selected || hovered ? false as const : CHART_MARKERS.hoverDiameter / CHART_MARKERS.diameter }
}

/** Cancel automatic Fit only; explicit 125% zoom still magnifies markers. */
export function markerFitScale(viewport: { scale: number; zoom: number | null }): number {
  return Math.max(.01, viewport.scale / (viewport.zoom ?? 1))
}

/** Keep native scatter/line symbols and their outlines in the same units as
 * custom markers. Size functions and tuples retain their relative encoding;
 * tree nodes, guide geometry and markLine arrowheads are intentionally exempt. */
export function fitPointSeries(series: any, fitScale: number): any {
  if (!series || fitScale === 1) return series
  const symbolSize = (size: any): any => typeof size === 'function'
    ? (...args: any[]) => symbolSize(size(...args))
    : Array.isArray(size) ? size.map(value => value / fitScale) : typeof size === 'number' ? size / fitScale : size
  const point = (item: any): any => !item || typeof item !== 'object' || Array.isArray(item) ? item : ({
    ...item,
    ...(item.symbolSize == null ? {} : { symbolSize: symbolSize(item.symbolSize) }),
    ...(typeof item.itemStyle?.borderWidth === 'number'
      ? { itemStyle: { ...item.itemStyle, borderWidth: item.itemStyle.borderWidth / fitScale } } : {}),
  })
  const adapt = (entry: any) => !['scatter', 'line'].includes(entry.type) ? entry : {
    ...point(entry), ...(Array.isArray(entry.data) ? { data: entry.data.map(point) } : {}),
  }
  return Array.isArray(series) ? series.map(adapt) : adapt(series)
}
