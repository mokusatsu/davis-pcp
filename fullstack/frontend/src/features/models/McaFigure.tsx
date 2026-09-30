import type { MCACategory } from './mcaTypes'
import ModelScatter from './ModelScatter'

export function axisLabel(rank: number, ratio: number[], axis: number): string {
  if (axis < 1 || axis > rank) return `第${axis}軸`
  const pct = ((ratio[axis - 1] ?? 0) * 100).toFixed(1)
  return `第${axis}軸 (${pct}%)`
}

export default function McaFigure({ points, rank, dispRank, xAxis, yAxis, ratio, selected, highlighted, getColor, onToggle, onBrush, onCategoryBrush, svgRef, testId, overlayNote }: {
  points: { id: string; label: string; x: number; y: number | null; title: string; rowId?: string; color?: string }[]
  rank: number
  dispRank?: number
  xAxis?: number
  yAxis?: number
  ratio: number[]
  selected: Set<string>
  highlighted: Set<string>
  getColor?: (rowId: string) => string
  onToggle: (id: string) => void
  onBrush?: (axes: number[], bounds: [number, number][]) => void
  onCategoryBrush?: (bounds: { x: [number, number]; y: [number, number] | null }) => void
  svgRef: React.RefObject<SVGSVGElement>
  testId: string
  overlayNote?: string
}): JSX.Element {
  const shown = dispRank ?? rank
  return <ModelScatter points={points.map(p => ({ ...p, selected: selected.has(p.id), highlighted: highlighted.has(p.id),
    color: p.color ?? (getColor && p.rowId ? getColor(p.rowId) : '#1890ff') }))}
    xLabel={axisLabel(rank, ratio, xAxis ?? 1)} yLabel={axisLabel(rank, ratio, yAxis ?? 2)}
    oneDimensional={shown < 2} svgRef={svgRef} testId={testId} note={overlayNote} onToggle={onToggle}
    onBrush={b => { if (onCategoryBrush) onCategoryBrush(b)
      else onBrush?.(shown >= 2 ? [1, 2] : [1], b.y ? [b.x, b.y] : [b.x]) }} />
}

export function categoryPoints(cats: MCACategory[], varColor: (variableId: string) => string, axisX = 1, axisY = 2): { id: string; label: string; x: number; y: number | null; title: string; color: string }[] {
  return cats.map((c) => ({
    id: c.categoryId,
    label: `${c.label}`,
    x: c.principalCoordinates[axisX - 1] ?? 0,
    y: c.principalCoordinates.length >= axisY ? c.principalCoordinates[axisY - 1] : null,
    title: `${c.label} 質量=${c.categoryMass.toFixed(4)} 座標=(${(c.principalCoordinates[axisX - 1] ?? 0).toFixed(3)}${c.principalCoordinates.length >= axisY ? `, ${(c.principalCoordinates[axisY - 1] ?? 0).toFixed(3)}` : ''})`,
    color: varColor(c.variableId),
  }))
}
