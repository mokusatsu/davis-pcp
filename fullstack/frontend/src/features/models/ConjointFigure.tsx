import { useMemo } from 'react'
import ModelScatter from './ModelScatter'

export interface ConjointFigurePoint {
  rowId: string
  x: number
  y: number | null
  title: string
}

export function conjointExtent(values: number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
  if (lo === hi) return [lo - 1, hi + 1]
  const pad = (hi - lo) * 0.05
  return [lo - pad, hi + pad]
}

export default function ConjointFigure({ points, xLabel, yLabel, selected, highlighted, getColor, onToggle, onBrush, svgRef, testId }: {
  points: ConjointFigurePoint[]
  xLabel: string
  yLabel: string
  selected: Set<string>
  highlighted: Set<string>
  getColor?: (rowId: string) => string
  onToggle: (rowId: string) => void
  onBrush?: (bounds: { x: [number, number]; y: [number, number] }) => void
  svgRef: React.RefObject<SVGSVGElement>
  testId: string
}): JSX.Element {
  const ext = useMemo(() => ({
    x: conjointExtent(points.map((p) => p.x)),
    y: conjointExtent(points.flatMap((p) => typeof p.y === 'number' ? [p.y] : [])),
  }), [points])
  // Missing residuals remain absent. Ranking's explicit row-order Y comes
  // from the page and is never replaced by an invented residual or jitter.
  const plotted = points.filter((p) => Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y))
  return <ModelScatter
    points={plotted.map((p) => ({
      ...p, id: p.rowId, selected: selected.has(p.rowId), highlighted: highlighted.has(p.rowId),
      color: selected.has(p.rowId) ? '#2a78d6' : getColor?.(p.rowId) ?? '#1890ff',
    }))}
    xLabel={xLabel} yLabel={yLabel} xExtent={ext.x} yExtent={ext.y}
    svgRef={svgRef} testId={testId} onToggle={onToggle}
    onBrush={onBrush ? (bounds) => { if (bounds.y) onBrush({ x: bounds.x, y: bounds.y }) } : undefined}
  />
}
