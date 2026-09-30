import type { FAMDCategory } from './famdTypes'
import EChart from '../charts/EChart'
import ModelScatter from './ModelScatter'
import { truncateText } from '../../utils/textUtils'

export function famdAxisLabel(rank: number, ratio: number[], axis: number): string {
  if (axis < 1 || axis > rank) return `第${axis}軸`
  const pct = ((ratio[axis - 1] ?? 0) * 100).toFixed(1)
  return `第${axis}軸 (${pct}%)`
}

export interface FamdPoint {
  id: string
  label: string
  x: number
  y: number | null
  title: string
  rowId?: string
  color?: string
}

export function famdCategoryPoints(
  cats: FAMDCategory[],
  varColor: (variableId: string) => string,
  axisX = 1,
  axisY = 2,
): FamdPoint[] {
  return cats.map((c) => ({
    id: c.categoryId,
    label: `${c.label}`,
    x: c.barycenterCoordinates[axisX - 1] ?? 0,
    y: c.barycenterCoordinates.length >= axisY ? c.barycenterCoordinates[axisY - 1] : null,
    title: `${c.label} 確率=${c.probability.toFixed(4)} 重心=(${(c.barycenterCoordinates[axisX - 1] ?? 0).toFixed(3)}${c.barycenterCoordinates.length >= axisY ? `, ${(c.barycenterCoordinates[axisY - 1] ?? 0).toFixed(3)}` : ''})`,
    color: varColor(c.variableId),
  }))
}

export function CorrelationCircle({ points, testId, axisX = 1, axisY = 2, rank = 2, size = 420 }: {
  points: { id: string; label: string; x: number; y: number | null; title: string; color?: string }[]
  testId: string; axisX?: number; axisY?: number; rank?: number; size?: number
}): JSX.Element {
  const circle = Array.from({ length: 129 }, (_, i) => [Math.cos(i * Math.PI / 64), Math.sin(i * Math.PI / 64)])
  return <div style={{ maxWidth: size, aspectRatio: '1', width: '100%' }}><EChart height="100%" testId={testId} ariaLabel="相関円"
    option={{ animation: false, backgroundColor: '#fafafa', grid: { left: 55, right: 55, top: 55, bottom: 55 },
      tooltip: { renderMode: 'richText', formatter: (p: any) => p.data?.title ?? p.seriesName ?? '' },
      xAxis: { type: 'value', min: -1.15, max: 1.15, name: `第${axisX}軸 相関`, nameLocation: 'middle', nameGap: 30 },
      yAxis: { type: 'value', min: -1.15, max: 1.15, name: rank >= 2 ? `第${axisY}軸 相関` : '', nameLocation: 'middle', nameGap: 32 },
      series: [{ type: 'line', data: circle, symbol: 'none', silent: true, lineStyle: { color: '#aaa', width: 1 } },
        ...points.map(p => ({ type: 'line' as const, name: p.title, data: [[0, 0], [p.x, p.y ?? 0]],
          symbol: 'none', lineStyle: { color: p.color ?? '#1890ff', width: 2 } })),
        { type: 'scatter', labelLayout: { hideOverlap: true, moveOverlap: 'shiftY' }, data: points.map(p => ({ value: [p.x, p.y ?? 0], title: p.title, name: p.label,
          itemStyle: { color: p.color ?? '#1890ff' }, label: { show: true, formatter: () => truncateText(p.label, 14), position: p.x >= 0 ? 'left' : 'right', color: '#333' } })) }],
    }} /></div>
}

export default function FamdFigure({ points, rank, dispRank, xAxis, yAxis, ratio, selected, highlighted, getColor, onToggle, onBrush, onCategoryBrush, svgRef, testId, overlayNote }: {
  points: FamdPoint[]
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
    xLabel={famdAxisLabel(rank, ratio, xAxis ?? 1)} yLabel={famdAxisLabel(rank, ratio, yAxis ?? 2)}
    oneDimensional={shown < 2} svgRef={svgRef} testId={testId} note={overlayNote} onToggle={onToggle}
    onBrush={b => { if (onCategoryBrush) onCategoryBrush(b)
      else onBrush?.(shown >= 2 ? [1, 2] : [1], b.y ? [b.x, b.y] : [b.x]) }} />
}
