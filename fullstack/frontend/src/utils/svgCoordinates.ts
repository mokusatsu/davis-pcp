/**
 * Converts client pointer coordinates (clientX, clientY) to SVG user coordinates (viewBox units).
 *
 * Uses native SVG getScreenCTM().inverse() which mathematically and automatically handles:
 * - viewBox definitions (including offsets)
 * - preserveAspectRatio behavior (xMidYMid meet letterboxing / pillarboxing)
 * - CSS transforms, zoom, scaling, high-DPI
 * - Page and container scrolling
 *
 * Provides a robust analytical fallback if getScreenCTM() is unavailable or singular.
 */
export function getSvgPoint(
  svg: SVGSVGElement | null | undefined,
  event: { clientX: number; clientY: number },
  fallbackViewBox?: { width: number; height: number; minX?: number; minY?: number },
): { x: number; y: number } {
  if (!svg) return { x: NaN, y: NaN }

  // ECharts custom graphics retain logical statistical coordinates through resize.
  if (svg.dataset?.logicalWidth && svg.dataset?.logicalHeight) {
    const rect = svg.getBoundingClientRect()
    const width = Number(svg.dataset.logicalWidth), height = Number(svg.dataset.logicalHeight)
    if (!rect.width || !rect.height) return { x: NaN, y: NaN }
    if (svg.dataset.logicalAspect === 'none') return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height }
    const scale = Math.min(rect.width / width, rect.height / height)
    return { x: (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale,
      y: (event.clientY - rect.top - (rect.height - height * scale) / 2) / scale }
  }

  // 1. Primary: Native SVG CTM inversion
  try {
    if (typeof svg.getScreenCTM === 'function') {
      const ctm = svg.getScreenCTM()
      if (ctm) {
        const inv = ctm.inverse()
        if (typeof svg.createSVGPoint === 'function') {
          const pt = svg.createSVGPoint()
          pt.x = event.clientX
          pt.y = event.clientY
          const res = pt.matrixTransform(inv)
          if (Number.isFinite(res.x) && Number.isFinite(res.y)) {
            return { x: res.x, y: res.y }
          }
        }
      }
    }
  } catch {
    // If matrix is singular or detached, proceed to fallback
  }

  // 2. Analytical Fallback
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return { x: NaN, y: NaN }

  const hasSvgViewBox = Boolean(svg.viewBox?.baseVal && svg.viewBox.baseVal.width > 0 && svg.viewBox.baseVal.height > 0)
  const vbMinX = hasSvgViewBox ? svg.viewBox.baseVal.x : (fallbackViewBox?.minX ?? 0)
  const vbMinY = hasSvgViewBox ? svg.viewBox.baseVal.y : (fallbackViewBox?.minY ?? 0)
  const vbW = (hasSvgViewBox ? svg.viewBox.baseVal.width : fallbackViewBox?.width) || rect.width
  const vbH = (hasSvgViewBox ? svg.viewBox.baseVal.height : fallbackViewBox?.height) || rect.height

  // If no viewBox was specified on svg nor in fallback, or preserveAspectRatio is "none"
  const preserve = svg.getAttribute('preserveAspectRatio')
  const hasViewBox = hasSvgViewBox || Boolean(fallbackViewBox)
  if (!hasViewBox || (preserve && preserve.includes('none'))) {
    const scaleX = vbW / rect.width
    const scaleY = vbH / rect.height
    return {
      x: vbMinX + (event.clientX - rect.left) * scaleX,
      y: vbMinY + (event.clientY - rect.top) * scaleY,
    }
  }

  // Standard preserveAspectRatio="xMidYMid meet"
  const scale = Math.min(rect.width / vbW, rect.height / vbH)
  const offsetX = (rect.width - vbW * scale) / 2
  const offsetY = (rect.height - vbH * scale) / 2

  return {
    x: vbMinX + (event.clientX - rect.left - offsetX) / scale,
    y: vbMinY + (event.clientY - rect.top - offsetY) / scale,
  }
}
