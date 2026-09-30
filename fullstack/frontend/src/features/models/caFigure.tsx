import { useMemo } from 'react'
import type { CACategory } from './caTypes'
import { axisLabel, displayCoords, type MapScaling } from './caMap'
import { truncateText } from '../../utils/textUtils'

const W = 560
const H = 400
const PAD = { top: 24, right: 24, bottom: 44, left: 56 }

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
  const points = useMemo(() => {
    const all = [
      ...rows.map((c) => ({ cat: c, x: displayCoords(c, scaling)[0] ?? 0, y: displayCoords(c, scaling)[1] ?? 0 })),
      ...cols.map((c) => ({ cat: c, x: displayCoords(c, scaling)[0] ?? 0, y: displayCoords(c, scaling)[1] ?? 0 })),
    ]
    return all
  }, [rows, cols, scaling])

  const ext = useMemo(() => {
    let xMin = Infinity
    let xMax = -Infinity
    let yMin = Infinity
    let yMax = -Infinity
    for (const p of points) {
      if (p.x < xMin) xMin = p.x
      if (p.x > xMax) xMax = p.x
      if (rank >= 2) {
        if (p.y < yMin) yMin = p.y
        if (p.y > yMax) yMax = p.y
      }
    }
    if (!Number.isFinite(xMin)) { xMin = -1; xMax = 1 }
    if (xMax <= xMin) xMax = xMin + 1
    if (rank < 2) { yMin = -1; yMax = 1 }
    if (!Number.isFinite(yMin)) { yMin = -1; yMax = 1 }
    if (yMax <= yMin) yMax = yMin + 1
    const dx = (xMax - xMin) * 0.1 || 0.1
    const dy = (yMax - yMin) * 0.1 || 0.1
    return { xMin: xMin - dx, xMax: xMax + dx, yMin: yMin - dy, yMax: yMax + dy }
  }, [points, rank])

  const sx = (x: number): number => PAD.left + ((x - ext.xMin) / (ext.xMax - ext.xMin)) * (W - PAD.left - PAD.right)
  const sy = (y: number): number => PAD.top + (1 - (y - ext.yMin) / (ext.yMax - ext.yMin)) * (H - PAD.top - PAD.bottom)

  return (
    <svg
      ref={svgRef}
      data-testid="ca-map-svg"
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ background: '#fafafa', borderRadius: 4, userSelect: 'none', touchAction: 'none' }}
    >
      <line x1={sx(0)} y1={PAD.top} x2={sx(0)} y2={H - PAD.bottom} stroke="#d9d9d9" />
      {rank >= 2 && <line x1={PAD.left} y1={sy(0)} x2={W - PAD.right} y2={sy(0)} stroke="#d9d9d9" />}
      {points.map((p, i) => {
        const cx = sx(p.x)
        const cy = rank >= 2 ? sy(p.y) : PAD.top + 60 + (i % 8) * 22
        const isSel = selected.has(p.cat.categoryId)
        const isLinked = highlighted.has(p.cat.categoryId)
        const isRow = p.cat.side === 'row'
        const fill = isRow ? '#1890ff' : '#52c41a'
        const title = `${p.cat.label} 質量=${p.cat.mass.toFixed(4)} 座標=(${p.x.toFixed(3)}${rank >= 2 ? `, ${p.y.toFixed(3)}` : ''}) cos2=${p.cat.cos2[0] ?? '—'}`
        const label = truncateText(p.cat.label, 16)
        const labelWidth = Array.from(label).length * 7
        const labelOnRight = cx + 8 + labelWidth <= W - PAD.right
        return (
          <g key={p.cat.categoryId} onClick={() => onToggle(p.cat.categoryId)} style={{ cursor: 'pointer' }}>
            {isRow ? (
              <circle cx={cx} cy={cy} r={isSel || isLinked ? 7 : 5} fill={fill} stroke={isSel ? '#2a78d6' : isLinked ? '#fa8c16' : '#fff'} strokeWidth={isSel || isLinked ? 2.5 : 1}>
                <title>{title}</title>
              </circle>
            ) : (
              <rect x={cx - 5} y={cy - 5} width={10} height={10} fill={fill} stroke={isSel ? '#2a78d6' : isLinked ? '#fa8c16' : '#fff'} strokeWidth={isSel || isLinked ? 2.5 : 1}>
                <title>{title}</title>
              </rect>
            )}
            <text x={labelOnRight ? cx + 8 : cx - 8} y={cy + 4} textAnchor={labelOnRight ? 'start' : 'end'} fontSize={11} fill="#333">
              <title>{title}</title>
              {label}
            </text>
          </g>
        )
      })}
      <text x={(W - PAD.left - PAD.right) / 2 + PAD.left} y={H - 8} textAnchor="middle" fontSize={12}>
        {axisLabel(rank, ratio, 1)}
      </text>
      {rank >= 2 && (
        <text x={12} y={(H - PAD.top - PAD.bottom) / 2 + PAD.top} textAnchor="middle" fontSize={12} transform={`rotate(-90 12 ${(H - PAD.top - PAD.bottom) / 2 + PAD.top})`}>
          {axisLabel(rank, ratio, 2)}
        </text>
      )}
    </svg>
  )
}
