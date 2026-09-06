import { useEffect, useRef, useState, type FC, type MouseEvent as ReactMouseEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import { getBrushOp } from '../selection/SelectionMenu'
import type { GeodesicEngine, ProjectionPoint } from './geodesicEngine'

interface TgtCanvasProps {
  engine: GeodesicEngine
  rowIds: string[]
  dataMatrix: number[][] // shape: N x p
  isPlaying: boolean
  isTracking: boolean
  onBasisUpdate: (alpha: number[], beta: number[]) => void
}

export const TgtCanvas: FC<TgtCanvasProps> = ({
  engine,
  rowIds,
  dataMatrix,
  isPlaying,
  isTracking,
  onBasisUpdate,
}) => {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const { getColor, isSelected: isRowSelected, selectionColor } = useRowColorResolver()

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragEnd = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  const dimsRef = useRef({ width: 860, height: 540 })
  const [dims, setDims] = useState({ width: 860, height: 540 })

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 50 && height > 50) {
          const w = Math.round(width)
          const h = Math.round(height)
          dimsRef.current = { width: w, height: h }
          setDims({ width: w, height: h })
        }
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const getMetrics = () => {
    const { width, height } = dimsRef.current
    const margin = 30
    const plotW = width - margin * 2
    const plotH = height - margin * 2
    const viewScale = Math.min(plotW, plotH) / 6.5
    const centerX = width / 2
    const centerY = height / 2
    return {
      width,
      height,
      viewScale,
      centerX,
      centerY,
      toScreenX: (x: number) => centerX + x * viewScale,
      toScreenY: (y: number) => centerY - y * viewScale,
    }
  }

  // Animation frame loop
  const pointsRef = useRef<ProjectionPoint[]>([])

  useEffect(() => {
    let animId: number

    const render = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const { width, height, viewScale, centerX, centerY, toScreenX, toScreenY } = getMetrics()

      if (isPlaying) {
        engine.step()
        onBasisUpdate([...engine.alpha], [...engine.beta])
      }

      // Project current points
      const points = engine.project(rowIds, dataMatrix, isTracking)
      pointsRef.current = points

      // Clear Canvas
      ctx.fillStyle = '#141414' // Dark theme for high contrast Grand Tour
      ctx.fillRect(0, 0, width, height)

      // Background guide circle (radius 3 sigma)
      ctx.strokeStyle = '#262626'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(centerX, centerY, 3 * viewScale, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(centerX, centerY, 1.5 * viewScale, 0, Math.PI * 2)
      ctx.stroke()

      // Center crosshair
      ctx.strokeStyle = '#333333'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(centerX - 3 * viewScale, centerY)
      ctx.lineTo(centerX + 3 * viewScale, centerY)
      ctx.moveTo(centerX, centerY - 3 * viewScale)
      ctx.lineTo(centerX, centerY + 3 * viewScale)
      ctx.stroke()
      ctx.setLineDash([])

      // Draw tracking trails
      if (isTracking) {
        for (const pt of points) {
          const trails = engine.getTrails(pt.rowId)
          if (trails.length < 2) continue

          const isSelected = isRowSelected(pt.rowId)
          const ptColor = isSelected ? selectionColor : getColor(pt.rowId)

          ctx.lineWidth = isSelected ? 1.5 : 1
          for (let i = 0; i < trails.length - 1; i++) {
            const p1 = trails[i]
            const p2 = trails[i + 1]
            const alphaVal = ((i + 1) / trails.length) * 0.5 // Fade older frames

            ctx.save()
            ctx.globalAlpha = alphaVal
            ctx.strokeStyle = ptColor
            ctx.beginPath()
            ctx.moveTo(toScreenX(p1.x), toScreenY(p1.y))
            ctx.lineTo(toScreenX(p2.x), toScreenY(p2.y))
            ctx.stroke()
            ctx.restore()
          }
        }
      }

      // Draw points
      for (const pt of points) {
        const sx = toScreenX(pt.x)
        const sy = toScreenY(pt.y)
        const isSelected = isRowSelected(pt.rowId)
        const color = getColor(pt.rowId)

        ctx.beginPath()
        if (isSelected) {
          ctx.arc(sx, sy, 5, 0, Math.PI * 2)
          ctx.fillStyle = selectionColor
          ctx.fill()
          ctx.lineWidth = 2
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
        } else {
          ctx.arc(sx, sy, 3.5, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          ctx.lineWidth = 0.5
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
        }
      }

      // Draw Drag selection box (only when paused)
      if (!isPlaying && dragBox) {
        const rx = Math.min(dragBox.x1, dragBox.x2)
        const ry = Math.min(dragBox.y1, dragBox.y2)
        const rw = Math.abs(dragBox.x2 - dragBox.x1)
        const rh = Math.abs(dragBox.y2 - dragBox.y1)

        ctx.fillStyle = 'rgba(42, 120, 214, 0.25)'
        ctx.fillRect(rx, ry, rw, rh)
        ctx.strokeStyle = '#2a78d6'
        ctx.lineWidth = 1.5
        ctx.strokeRect(rx, ry, rw, rh)
      }

      if (isPlaying) {
        animId = requestAnimationFrame(render)
      }
    }

    render()

    return () => {
      if (animId) cancelAnimationFrame(animId)
    }
  }, [isPlaying, isTracking, rowIds, dataMatrix, engine, isRowSelected, getColor, selectionColor, dragBox, onBasisUpdate, dims])

  // Mouse handlers for dragging when paused
  const handleMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (isPlaying || e.button !== 0) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    isDragging.current = true
    dragStart.current = { x, y }
    dragEnd.current = { x, y }
    setDragBox({ x1: x, y1: y, x2: x, y2: y })
  }

  const handleMouseMove = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (isPlaying || !isDragging.current) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    dragEnd.current = { x, y }
    setDragBox({
      x1: dragStart.current.x,
      y1: dragStart.current.y,
      x2: x,
      y2: y,
    })
  }

  const handleMouseUp = (e?: ReactMouseEvent<HTMLCanvasElement>) => {
    if (isPlaying || !isDragging.current) {
      isDragging.current = false
      setDragBox(null)
      return
    }
    isDragging.current = false

    if (e && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect()
      dragEnd.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const bx1 = Math.min(dragStart.current.x, dragEnd.current.x)
    const bx2 = Math.max(dragStart.current.x, dragEnd.current.x)
    const by1 = Math.min(dragStart.current.y, dragEnd.current.y)
    const by2 = Math.max(dragStart.current.y, dragEnd.current.y)

    if (bx2 - bx1 > 4 || by2 - by1 > 4) {
      const { toScreenX, toScreenY } = getMetrics()
      const hitIds: string[] = []
      for (const pt of pointsRef.current) {
        const sx = toScreenX(pt.x)
        const sy = toScreenY(pt.y)
        if (sx >= bx1 && sx <= bx2 && sy >= by1 && sy <= by2) {
          hitIds.push(pt.rowId)
        }
      }
      if (hitIds.length > 0) {
        dispatch(
          selectionApplied({
            rowIds: hitIds,
            operation: getBrushOp(),
            label: `Touring選択 (${hitIds.length}行)`,
          })
        )
      }
    }

    setDragBox(null)
  }

  const contextMenuItems = [
    {
      key: 'focus',
      label: 'Focus Selected (選択行で絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: '選択解除 (Clear Selection)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'reset',
      label: '作業セット復元 (Reset Working Set)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  return (
    <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          border: '1px solid #333',
          borderRadius: 8,
          overflow: 'hidden',
          display: 'block',
          width: '100%',
          height: '100%',
        }}
      >
        <canvas
          ref={canvasRef}
          width={dims.width}
          height={dims.height}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            cursor: isPlaying ? 'default' : 'crosshair',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          data-testid="tgt-canvas"
        />
      </div>
    </Dropdown>
  )
}
