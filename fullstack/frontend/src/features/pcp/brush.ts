export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export function normalizedRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) }
}

export function pointInRect(point: { x: number; y: number }, rect: Rect): boolean {
  return point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2
}

/** Liang–Barsky style segment-rectangle intersection (modern extension). */
export function segmentIntersectsRect(a: { x: number; y: number }, b: { x: number; y: number }, rect: Rect): boolean {
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true
  const dx = b.x - a.x
  const dy = b.y - a.y
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dy, dy]
  const q = [a.x - rect.x1, rect.x2 - a.x, a.y - rect.y1, rect.y2 - a.y]
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
      continue
    }
    const r = q[i] / p[i]
    if (p[i] < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
  }
  return true
}

export type HitMode = 'legacyVertex' | 'segment'

/**
 * legacyVertex: initial-JAR semantics — any axis vertex inside the rectangle.
 * segment: modern extension — any polyline segment crosses the rectangle.
 */
export function hitRows(
  pointsById: Map<string, { x: number; y: number }[]>,
  activeIds: Iterable<string>,
  rect: Rect,
  mode: HitMode,
): string[] {
  const hits: string[] = []
  for (const id of activeIds) {
    const points = pointsById.get(id)
    if (!points) continue
    let hit = points.some((point) => pointInRect(point, rect))
    if (!hit && mode === 'segment') {
      for (let i = 0; i < points.length - 1; i += 1) {
        if (segmentIntersectsRect(points[i], points[i + 1], rect)) {
          hit = true
          break
        }
      }
    }
    if (hit) hits.push(id)
  }
  return hits
}

export function distancePointToSegment(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

export function nearestRow(point: { x: number; y: number }, pointsById: Map<string, { x: number; y: number }[]>, activeIds: Iterable<string>, threshold = 8): string | null {
  let best: string | null = null
  let bestDistance = threshold
  for (const id of activeIds) {
    const points = pointsById.get(id)
    if (!points) continue
    for (let i = 0; i < points.length - 1; i += 1) {
      const distance = distancePointToSegment(point, points[i], points[i + 1])
      if (distance < bestDistance) {
        bestDistance = distance
        best = id
      }
    }
  }
  return best
}
