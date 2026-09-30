import ModelScatter from './ModelScatter'

export interface LRFigurePoint {
  rowId: string
  x: number
  y: number
  title: string
  color?: string
}

export function lrExtent(values: number[]): [number, number] {
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

export default function LinearRegressionFigure({ points, xLabel, yLabel, selected, highlighted, getColor, onToggle, onBrush, svgRef, testId }: {
  points: LRFigurePoint[]
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
  return <ModelScatter points={points.map(p => ({ ...p, id: p.rowId, selected: selected.has(p.rowId),
    highlighted: highlighted.has(p.rowId), color: getColor ? getColor(p.rowId) : p.color }))}
    xLabel={xLabel} yLabel={yLabel} xExtent={lrExtent(points.map(p => p.x))} yExtent={lrExtent(points.map(p => p.y))}
    svgRef={svgRef} testId={testId} onToggle={onToggle} onBrush={b => { if (b.y) onBrush?.({ x: b.x, y: b.y }) }} />
}
