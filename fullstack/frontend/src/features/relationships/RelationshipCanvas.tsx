import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { hovered, selectionApplied, type RootState } from '../../app/store'
import { getBrushOp } from '../selection/SelectionMenu'

export interface RelationshipPoints { rowIds: string[]; x: number[]; y: number[] }

export function projectRelationshipPoints(data: RelationshipPoints) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < data.rowIds.length; i++) {
    minX = Math.min(minX, data.x[i]); maxX = Math.max(maxX, data.x[i])
    minY = Math.min(minY, data.y[i]); maxY = Math.max(maxY, data.y[i])
  }
  return data.rowIds.map((id, i) => ({ id,
    x: minX === maxX ? 320 : 50 + (data.x[i] - minX) / (maxX - minX) * 530,
    y: minY === maxY ? 195 : 370 - (data.y[i] - minY) / (maxY - minY) * 340,
  }))
}

export default function RelationshipCanvas({ data, labels, colorOf }: {
  data: RelationshipPoints; labels: [string, string]; colorOf: (id: string) => string
}) {
  const dispatch = useDispatch()
  const selected = useSelector((state: RootState) => state.selection.selectedRowIds)
  const hover = useSelector((state: RootState) => state.selection.hoveredRowId)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [rectangle, setRectangle] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const points = useMemo(() => projectRelationshipPoints(data), [data])
  useEffect(() => { drag.current = null; setRectangle(null) }, [data])
  useEffect(() => {
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx) return
    const ratio = window.devicePixelRatio || 1
    element.width = 600 * ratio; element.height = 420 * ratio
    ctx.scale(ratio, ratio)
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 420)
    ctx.strokeStyle = '#d9d9d9'; ctx.beginPath(); ctx.moveTo(50, 30); ctx.lineTo(50, 370); ctx.lineTo(580, 370); ctx.stroke()
    ctx.fillStyle = '#595959'; ctx.font = '12px sans-serif'
    ctx.fillText(labels[0], 50, 405, 530); ctx.fillText(labels[1], 50, 18, 530)
    if (data.rowIds.length) {
      const limits = (values: number[]) => values.reduce((range, value) => [Math.min(range[0], value), Math.max(range[1], value)], [Infinity, -Infinity])
      const xRange = limits(data.x), yRange = limits(data.y)
      for (let tick = 0; tick <= 4; tick++) {
        const t = tick / 4
        ctx.fillText(String(Number((xRange[0] + (xRange[1] - xRange[0]) * t).toPrecision(4))), 40 + 530 * t, 387)
        ctx.fillText(String(Number((yRange[0] + (yRange[1] - yRange[0]) * t).toPrecision(4))), 4, 374 - 340 * t, 42)
      }
    }
    const selectedSet = new Set(selected)
    for (const point of points) {
      ctx.globalAlpha = selectedSet.has(point.id) || point.id === hover ? 1 : 0.55
      ctx.beginPath(); ctx.arc(point.x, point.y, selectedSet.has(point.id) || point.id === hover ? 4.5 : 2.5, 0, 2 * Math.PI)
      ctx.fillStyle = colorOf(point.id); ctx.fill()
      if (selectedSet.has(point.id)) { ctx.strokeStyle = '#1677ff'; ctx.lineWidth = 1.5; ctx.stroke() }
    }
    ctx.globalAlpha = 1
    if (rectangle) {
      ctx.fillStyle = 'rgba(22,119,255,0.12)'; ctx.strokeStyle = '#1677ff'
      ctx.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
      ctx.strokeRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height)
    }
  }, [points, selected, hover, colorOf, labels[0], labels[1], rectangle])
  const position = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.left) * 600 / box.width, y: (event.clientY - box.top) * 420 / box.height }
  }
  const nearest = (location: { x: number; y: number }) => {
    let best: string | null = null, distance = 49
    for (const point of points) {
      const next = (point.x - location.x) ** 2 + (point.y - location.y) ** 2
      if (next < distance) { distance = next; best = point.id }
    }
    return best
  }
  return <canvas ref={canvas} role="img" aria-label="焦点ペア散布図" data-testid="relationship-canvas"
    style={{ width: '100%', aspectRatio: '600 / 420', display: 'block', touchAction: 'none' }}
    onPointerDown={event => { if (event.button !== 0) return; drag.current = position(event); event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={event => {
      const location = position(event), start = drag.current
      if (!start) { dispatch(hovered(nearest(location))); return }
      setRectangle({ x: Math.min(start.x, location.x), y: Math.min(start.y, location.y), width: Math.abs(start.x - location.x), height: Math.abs(start.y - location.y) })
    }}
    onPointerUp={event => {
      const start = drag.current; drag.current = null; setRectangle(null)
      if (!start) return
      const end = position(event)
      const point = nearest(end)
      const ids = Math.abs(start.x - end.x) < 5 && Math.abs(start.y - end.y) < 5 ? (point ? [point] : [])
        : points.filter(point => point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x)
          && point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y)).map(point => point.id)
      dispatch(selectionApplied({ rowIds: ids, operation: getBrushOp(), label: '焦点ペア選択' }))
    }}
    onPointerCancel={() => { drag.current = null; setRectangle(null) }}
    onPointerLeave={() => dispatch(hovered(null))} />
}
