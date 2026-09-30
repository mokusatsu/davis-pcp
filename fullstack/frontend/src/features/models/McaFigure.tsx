import { useMemo, useRef, useState } from 'react'
import type { MCACategory } from './mcaTypes'
import { truncateText } from '../../utils/textUtils'

const W = 560
const H = 400
const PAD = { top: 24, right: 24, bottom: 44, left: 56 }

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
  const ext = useMemo(() => {
    let xMin = Infinity
    let xMax = -Infinity
    let yMin = Infinity
    let yMax = -Infinity
    for (const p of points) {
      if (p.x < xMin) xMin = p.x
      if (p.x > xMax) xMax = p.x
      if (shown >= 2 && p.y !== null) {
        if (p.y < yMin) yMin = p.y
        if (p.y > yMax) yMax = p.y
      }
    }
    if (!Number.isFinite(xMin)) { xMin = -1; xMax = 1 }
    if (xMax <= xMin) xMax = xMin + 1
    if (shown < 2) { yMin = -1; yMax = 1 }
    if (!Number.isFinite(yMin)) { yMin = -1; yMax = 1 }
    if (yMax <= yMin) yMax = yMin + 1
    const dx = (xMax - xMin) * 0.1 || 0.1
    const dy = (yMax - yMin) * 0.1 || 0.1
    return { xMin: xMin - dx, xMax: xMax + dx, yMin: yMin - dy, yMax: yMax + dy }
  }, [points, rank])

  const sx = (x: number): number => PAD.left + ((x - ext.xMin) / (ext.xMax - ext.xMin)) * (W - PAD.left - PAD.right)
  const sy = (y: number): number => PAD.top + (1 - (y - ext.yMin) / (ext.yMax - ext.yMin)) * (H - PAD.top - PAD.bottom)
  const invX = (px: number): number => ext.xMin + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (ext.xMax - ext.xMin)
  const invY = (py: number): number => ext.yMin + (1 - (py - PAD.top) / (H - PAD.top - PAD.bottom)) * (ext.yMax - ext.yMin)

  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const pos = (e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
    const scaleX = W / rect.width
    const scaleY = H / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  return (
    <svg
      ref={svgRef}
      data-testid={testId}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{ background: '#fafafa', borderRadius: 4, userSelect: 'none', touchAction: 'none' }}
      onPointerDown={(e) => {
        const t = e.target as Element | null
        if (t && typeof (t as Element).closest === 'function' && (t as Element).closest('circle, rect[data-selectable]')) return
        const p = pos(e)
        start.current = p
        setDrag({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
        ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        const p = pos(e)
        setDrag({ x1: start.current.x, y1: start.current.y, x2: p.x, y2: p.y })
      }}
      onPointerUp={(e) => {
        if (!start.current || !drag) { start.current = null; return }
        const p = pos(e)
        const x1 = Math.min(start.current.x, p.x)
        const x2 = Math.max(start.current.x, p.x)
        const y1 = Math.min(start.current.y, p.y)
        const y2 = Math.max(start.current.y, p.y)
        start.current = null
        setDrag(null)
        if (Math.abs(x2 - x1) < 4 && (shown < 2 || Math.abs(y2 - y1) < 4)) return
        if (onCategoryBrush) {
          onCategoryBrush(shown >= 2
            ? { x: [invX(x1), invX(x2)], y: [invY(y2), invY(y1)] }
            : { x: [invX(x1), invX(x2)], y: null })
          return
        }
        if (shown >= 2) {
          const xb: [number, number] = [invX(x1), invX(x2)]
          const yb: [number, number] = [invY(y2), invY(y1)]
          onBrush?.([1, 2], [xb, yb])
        } else {
          onBrush?.([1], [[invX(x1), invX(x2)]])
        }
      }}
    >
      <line x1={sx(0)} y1={PAD.top} x2={sx(0)} y2={H - PAD.bottom} stroke="#d9d9d9" />
      {shown >= 2 && <line x1={PAD.left} y1={sy(0)} x2={W - PAD.right} y2={sy(0)} stroke="#d9d9d9" />}
      {points.map((p, i) => {
        const cx = sx(p.x)
        const cy = shown >= 2 && p.y !== null ? sy(p.y) : PAD.top + 40 + (i % 12) * 24
        const isSel = selected.has(p.id)
        const isLinked = highlighted.has(p.id)
        const fill = p.color ?? (getColor && p.rowId ? getColor(p.rowId) : '#1890ff')
        const label = truncateText(p.label, 16)
        const labelWidth = Array.from(label).length * 7
        const labelOnRight = cx + 8 + labelWidth <= W - PAD.right
        return (
          <g key={p.id} style={{ cursor: 'pointer' }}>
            <circle
              cx={cx}
              cy={cy}
              r={isSel ? 7 : 5}
              fill={fill}
              fillOpacity={isSel ? 1 : 0.75}
              stroke={isSel ? '#2a78d6' : isLinked ? '#fa8c16' : '#fff'}
              strokeWidth={isSel || isLinked ? 2.5 : 1}
              data-selectable="true"
              onClick={(ev) => { ev.stopPropagation(); onToggle(p.id) }}
            >
              <title>{p.title}</title>
            </circle>
            <circle cx={cx} cy={cy} r={12} fill="transparent" data-selectable="true" onClick={(ev) => { ev.stopPropagation(); onToggle(p.id) }}>
              <title>{p.title}</title>
            </circle>
            <text x={labelOnRight ? cx + 8 : cx - 8} y={cy + 4} textAnchor={labelOnRight ? 'start' : 'end'} fontSize={11} fill="#333">
              <title>{p.title}</title>
              {label}
            </text>
          </g>
        )
      })}
      {drag && (
        <rect
          x={Math.min(drag.x1, drag.x2)}
          y={Math.min(drag.y1, drag.y2)}
          width={Math.abs(drag.x2 - drag.x1)}
          height={Math.abs(drag.y2 - drag.y1)}
          fill="rgba(42,120,214,0.15)"
          stroke="#2a78d6"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      )}
      <text x={(W - PAD.left - PAD.right) / 2 + PAD.left} y={H - 8} textAnchor="middle" fontSize={12}>
        {axisLabel(rank, ratio, xAxis ?? 1)}
      </text>
      {shown >= 2 && (
        <text x={12} y={(H - PAD.top - PAD.bottom) / 2 + PAD.top} textAnchor="middle" fontSize={12} transform={`rotate(-90 12 ${(H - PAD.top - PAD.bottom) / 2 + PAD.top})`}>
          {axisLabel(rank, ratio, yAxis ?? 2)}
        </text>
      )}
      {overlayNote && (
        <text x={PAD.left} y={PAD.top - 6} fontSize={11} fill="#8c8c8c">{overlayNote}</text>
      )}
    </svg>
  )
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
