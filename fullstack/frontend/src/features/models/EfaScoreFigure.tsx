import { useMemo } from 'react'
import ModelScatter from './ModelScatter'

export interface EfaFigurePoint {
  rowId: string
  x: number | null
  y: number | null
  title: string
}

function extent(values: (number | null)[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (lo === hi) return [lo - 1, hi + 1]
  const pad = (hi - lo) * 0.05
  return [lo - pad, hi + pad]
}

/** Factor-score scatter with real-pointer brush + point toggle (E009). */
export default function EfaScoreFigure({ points, xLabel, yLabel, selected, hovered, getColor, onToggle, onBrush, svgRef, testId }: {
  points: EfaFigurePoint[]
  xLabel: string
  yLabel: string
  selected: Set<string>
  hovered: string | null
  getColor?: (rowId: string) => string
  onToggle: (rowId: string) => void
  onBrush?: (bounds: { x: [number, number]; y: [number, number] }) => void
  svgRef: React.RefObject<SVGSVGElement>
  testId: string
}): JSX.Element {
  const ext = useMemo(() => ({
    x: extent(points.map((p) => p.x)),
    y: extent(points.map((p) => p.y)),
  }), [points])
  const plotted = points.filter((p): p is EfaFigurePoint & { x: number; y: number } =>
    typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y))
  return <ModelScatter
    points={plotted.map((p) => ({
      ...p, id: p.rowId, selected: selected.has(p.rowId), highlighted: hovered === p.rowId,
      color: selected.has(p.rowId) ? '#2a78d6' : getColor?.(p.rowId) ?? '#1890ff',
    }))}
    xLabel={xLabel} yLabel={yLabel} xExtent={ext.x} yExtent={ext.y}
    svgRef={svgRef} testId={testId} onToggle={onToggle}
    onBrush={onBrush ? (bounds) => { if (bounds.y) onBrush({ x: bounds.x, y: bounds.y }) } : undefined}
  />
}
