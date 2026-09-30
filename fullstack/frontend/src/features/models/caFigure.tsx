import type { CACategory } from './caTypes'
import { axisLabel, displayCoords, type MapScaling } from './caMap'
import ModelScatter from './ModelScatter'

export default function CaFigure({ rows, cols, rank, ratio, scaling, selected, highlighted, onToggle, svgRef }: {
  rows: CACategory[]
  cols: CACategory[]
  rank: number
  ratio: number[]
  scaling: MapScaling
  selected: Set<string>
  highlighted: Set<string>
  onToggle: (id: string) => void
  svgRef: React.RefObject<SVGSVGElement>
}): JSX.Element {
  const points = [...rows, ...cols].map(c => {
    const coords = displayCoords(c, scaling)
    return { id: c.categoryId, x: coords[0] ?? 0, y: coords[1] ?? 0, label: c.label,
      title: `${c.label} 質量=${c.mass.toFixed(4)} 座標=(${coords.join(', ')}) cos2=${c.cos2[0] ?? '—'}`,
      color: c.side === 'row' ? '#1890ff' : '#52c41a', symbol: c.side === 'row' ? 'circle' : 'rect',
      selected: selected.has(c.categoryId), highlighted: highlighted.has(c.categoryId) }
  })
  return <ModelScatter points={points} xLabel={axisLabel(rank, ratio, 1)} yLabel={axisLabel(rank, ratio, 2)}
    oneDimensional={rank < 2} onToggle={onToggle} svgRef={svgRef} testId="ca-map-svg" />
}
