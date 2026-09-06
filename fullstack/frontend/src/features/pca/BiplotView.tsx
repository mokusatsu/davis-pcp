import { useEffect, useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Checkbox, Dropdown, Select, Space, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import type { PcaResponse } from './types'

interface BiplotViewProps {
  pcaData: PcaResponse | null
  selectedX: number
  selectedY: number
  onSelectX: (val: number) => void
  onSelectY: (val: number) => void
}

export const BiplotView: FC<BiplotViewProps> = ({

  pcaData,
  selectedX,
  selectedY,
  onSelectX,
  onSelectY,
}) => {
  const { isTargetActive } = useFocusMode()
  const active = isTargetActive('pca-biplot')
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const [showVectors, setShowVectors] = useState(true)
  const { getColor, isSelected: isRowSelected, selectionColor } = useRowColorResolver()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragEnd = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const width = 720
  const height = 480
  const margin = { top: 30, right: 40, bottom: 50, left: 60 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  // Coordinate ranges for scores
  const scoreBounds = useMemo(() => {
    if (!pcaData || pcaData.scores.length === 0) {
      return { minX: -3, maxX: 3, minY: -3, maxY: 3 }
    }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (const item of pcaData.scores) {
      const x = item.pc[selectedX] ?? 0
      const y = item.pc[selectedY] ?? 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    const padX = Math.max((maxX - minX) * 0.08, 0.5)
    const padY = Math.max((maxY - minY) * 0.08, 0.5)

    return {
      minX: minX - padX,
      maxX: maxX + padX,
      minY: minY - padY,
      maxY: maxY + padY,
    }
  }, [pcaData, selectedX, selectedY])

  // Vector scaling to map loading [-1, 1] into plot coordinate scale
  const vectorScale = useMemo(() => {
    const spanX = (scoreBounds.maxX - scoreBounds.minX) / 2
    const spanY = (scoreBounds.maxY - scoreBounds.minY) / 2
    return Math.min(spanX, spanY) * 0.75
  }, [scoreBounds])

  // Scale functions
  const toScreenX = (val: number) =>
    margin.left + ((val - scoreBounds.minX) / (scoreBounds.maxX - scoreBounds.minX)) * plotW
  const toScreenY = (val: number) =>
    margin.top + plotH - ((val - scoreBounds.minY) / (scoreBounds.maxY - scoreBounds.minY)) * plotH


  // Render canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, width, height)

    // Background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    // Plot area background
    ctx.fillStyle = '#fafbfc'
    ctx.fillRect(margin.left, margin.top, plotW, plotH)

    // Grid lines & Zero axes
    const originX = toScreenX(0)
    const originY = toScreenY(0)

    ctx.strokeStyle = '#e8e8e8'
    ctx.lineWidth = 1
    ctx.strokeRect(margin.left, margin.top, plotW, plotH)

    if (originX >= margin.left && originX <= margin.left + plotW) {
      ctx.strokeStyle = '#d9d9d9'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(originX, margin.top)
      ctx.lineTo(originX, margin.top + plotH)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (originY >= margin.top && originY <= margin.top + plotH) {
      ctx.strokeStyle = '#d9d9d9'
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(margin.left, originY)
      ctx.lineTo(margin.left + plotW, originY)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (!pcaData) return

    // Draw score points
    for (const item of pcaData.scores) {
      const rId = item.rowId || item.row_id || ''
      const xVal = item.pc[selectedX] ?? 0
      const yVal = item.pc[selectedY] ?? 0
      const sx = toScreenX(xVal)
      const sy = toScreenY(yVal)

      const isSelected = isRowSelected(rId)
      const color = getColor(rId)

      ctx.beginPath()
      if (isSelected) {
        ctx.arc(sx, sy, 5.0, 0, Math.PI * 2)
        ctx.fillStyle = selectionColor
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
      } else {
        ctx.arc(sx, sy, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        ctx.lineWidth = 0.5
        ctx.strokeStyle = 'rgba(0,0,0,0.15)'
        ctx.stroke()
      }
    }

    // Draw loading vectors (Biplot arrows)
    if (showVectors && pcaData.loadings) {
      for (const col of pcaData.columns) {
        const loadings = pcaData.loadings[col]
        if (!loadings) continue
        const lx = (loadings[selectedX] ?? 0) * vectorScale
        const ly = (loadings[selectedY] ?? 0) * vectorScale

        const endX = toScreenX(lx)
        const endY = toScreenY(ly)

        // Arrow line
        ctx.strokeStyle = '#d4380d'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(originX, originY)
        ctx.lineTo(endX, endY)
        ctx.stroke()

        // Arrow head
        const angle = Math.atan2(endY - originY, endX - originX)
        const arrowLen = 9
        ctx.fillStyle = '#d4380d'
        ctx.beginPath()
        ctx.moveTo(endX, endY)
        ctx.lineTo(
          endX - arrowLen * Math.cos(angle - Math.PI / 6),
          endY - arrowLen * Math.sin(angle - Math.PI / 6)
        )
        ctx.lineTo(
          endX - arrowLen * Math.cos(angle + Math.PI / 6),
          endY - arrowLen * Math.sin(angle + Math.PI / 6)
        )
        ctx.closePath()
        ctx.fill()

        // Variable Label with robust isolated text alignment
        ctx.save()
        ctx.fillStyle = '#871400'
        ctx.font = 'bold 11px sans-serif'
        ctx.textAlign = Math.cos(angle) >= 0 ? 'left' : 'right'
        ctx.textBaseline = Math.sin(angle) >= 0 ? 'top' : 'bottom'
        const textOffset = 6
        const textX = endX + Math.cos(angle) * textOffset
        const textY = endY + Math.sin(angle) * textOffset
        ctx.fillText(col, textX, textY)
        ctx.restore()
      }
    }

    // Draw Drag Box
    if (dragBox) {
      const rx = Math.min(dragBox.x1, dragBox.x2)
      const ry = Math.min(dragBox.y1, dragBox.y2)
      const rw = Math.abs(dragBox.x2 - dragBox.x1)
      const rh = Math.abs(dragBox.y2 - dragBox.y1)

      ctx.fillStyle = 'rgba(42, 120, 214, 0.15)'
      ctx.fillRect(rx, ry, rw, rh)
      ctx.strokeStyle = '#2a78d6'
      ctx.lineWidth = 1.5
      ctx.strokeRect(rx, ry, rw, rh)
    }

    // Axis tick labels and Axis titles
    ctx.save()
    ctx.fillStyle = '#666'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(scoreBounds.minX.toFixed(1), margin.left, margin.top + plotH + 8)
    ctx.fillText(((scoreBounds.minX + scoreBounds.maxX) / 2).toFixed(1), margin.left + plotW / 2, margin.top + plotH + 8)
    ctx.fillText(scoreBounds.maxX.toFixed(1), margin.left + plotW, margin.top + plotH + 8)

    // X Axis Title
    ctx.fillStyle = '#374151'
    ctx.font = '600 12px sans-serif'
    ctx.fillText(`PC${selectedX + 1}`, margin.left + plotW / 2, margin.top + plotH + 26)

    // Y Axis Ticks
    ctx.fillStyle = '#666'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(scoreBounds.maxY.toFixed(1), margin.left - 8, margin.top + 6)
    ctx.fillText(((scoreBounds.minY + scoreBounds.maxY) / 2).toFixed(1), margin.left - 8, margin.top + plotH / 2)
    ctx.fillText(scoreBounds.minY.toFixed(1), margin.left - 8, margin.top + plotH - 6)

    // Y Axis Title (Rotated)
    ctx.save()
    ctx.translate(margin.left - 36, margin.top + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#374151'
    ctx.font = '600 12px sans-serif'
    ctx.fillText(`PC${selectedY + 1}`, 0, 0)
    ctx.restore()

    ctx.restore()
  }, [pcaData, selectedX, selectedY, scoreBounds, vectorScale, showVectors, isRowSelected, getColor, selectionColor, dragBox])

  // Mouse drag handlers
  const handleMouseDown = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
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
    if (!isDragging.current) return
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
    if (!isDragging.current || !pcaData) {
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

    // If drag was noticeable, trigger selection
    if (bx2 - bx1 > 4 || by2 - by1 > 4) {
      const hitIds: string[] = []
      for (const item of pcaData.scores) {
        const xVal = item.pc[selectedX] ?? 0
        const yVal = item.pc[selectedY] ?? 0
        const sx = toScreenX(xVal)
        const sy = toScreenY(yVal)
        if (sx >= bx1 && sx <= bx2 && sy >= by1 && sy <= by2) {
          hitIds.push(item.rowId || item.row_id || '')
        }
      }
      if (hitIds.length > 0) {
        dispatch(
          selectionApplied({
            rowIds: hitIds,
            operation: getBrushOp(),
            label: `PCA Biplot選択 (${hitIds.length}行)`,
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

  const numComponents = pcaData?.nComponents || pcaData?.eigenvalues.length || 2
  const componentOptions = Array.from({ length: numComponents }, (_, i) => {
    const ratio = pcaData?.explainedVarianceRatio[i]
      ? ` (${(pcaData.explainedVarianceRatio[i] * 100).toFixed(1)}%)`
      : ''
    return { label: `PC${i + 1}${ratio}`, value: i }
  })

  return (
    <div
      data-testid="pca-biplot-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: active ? 0 : 10,
        height: active ? '100%' : undefined,
        flex: active ? 1 : undefined,
        minHeight: 0,
      }}
    >
      {!active && (
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space wrap>
            <Typography.Text strong>X軸: </Typography.Text>
            <Select
              style={{ width: 140 }}
              value={selectedX}
              onChange={onSelectX}
              options={componentOptions}
              data-testid="pca-axis-x"
            />
            <Typography.Text strong style={{ marginLeft: 8 }}>Y軸: </Typography.Text>
            <Select
              style={{ width: 140 }}
              value={selectedY}
              onChange={onSelectY}
              options={componentOptions}
              data-testid="pca-axis-y"
            />
            <Checkbox
              checked={showVectors}
              onChange={(e) => setShowVectors(e.target.checked)}
              data-testid="pca-biplot-vectors"
              style={{ marginLeft: 16 }}
            >
              負荷量ベクトル表示 (Loading Vectors)
            </Checkbox>
          </Space>
          <Space wrap>
            <SelectionMenu testId="pca-selection-menu" />
            <FocusEnterButton targetId="pca-biplot" title="PCAバイプロット" />
          </Space>
        </Space>
      )}

      <FocusTarget id="pca-biplot" title="PCAバイプロット">
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              background: '#ffffff',
              display: 'flex',
              flex: active ? 1 : 'none',
              height: active ? '100%' : undefined,
              width: active ? '100%' : undefined,
              justifyContent: 'center',
              alignItems: 'center',
              userSelect: 'none',
              overflow: 'hidden',
              minHeight: active ? 0 : 485,
            }}
          >
            <canvas
              ref={canvasRef}
              width={width}
              height={height}
              style={{
                width: active ? 'auto' : width,
                height: active ? '100%' : height,
                maxHeight: active ? '100%' : undefined,
                maxWidth: '100%',
                aspectRatio: `${width} / ${height}`,
                cursor: 'crosshair',
                display: 'block',
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              data-testid="pca-biplot-canvas"
            />
          </div>
        </Dropdown>
      </FocusTarget>
    </div>
  )
}
