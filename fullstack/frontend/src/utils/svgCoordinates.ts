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

  const vbMinX = fallbackViewBox?.minX ?? svg.viewBox?.baseVal?.x ?? 0
  const vbMinY = fallbackViewBox?.minY ?? svg.viewBox?.baseVal?.y ?? 0
  const vbW = fallbackViewBox?.width || svg.viewBox?.baseVal?.width || rect.width
  const vbH = fallbackViewBox?.height || svg.viewBox?.baseVal?.height || rect.height

  // If no viewBox was specified on svg nor in fallback, or preserveAspectRatio is "none"
  const preserve = svg.getAttribute('preserveAspectRatio')
  const hasViewBox = Boolean(svg.viewBox?.baseVal?.width || fallbackViewBox)
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
