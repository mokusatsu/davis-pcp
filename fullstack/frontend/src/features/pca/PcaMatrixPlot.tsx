import { useEffect, useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown, Space, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { getBrushOp } from '../selection/SelectionMenu'
import type { PcaResponse } from './types'

interface PcaMatrixPlotProps {
  pcaData: PcaResponse | null
}

export const PcaMatrixPlot: FC<PcaMatrixPlotProps> = ({ pcaData }) => {
  const { isTargetActive } = useFocusMode()
  const active = isTargetActive('pca-matrix')
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const { getColor, isSelected: isRowSelected, selectionColor } = useRowColorResolver()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragEnd = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const width = 640
  const height = 640
  const margin = { top: 25, right: 25, bottom: 25, left: 25 }

  const k = Math.min(pcaData?.nComponents || pcaData?.eigenvalues.length || 4, 4)
  const cellW = (width - margin.left - margin.right) / Math.max(k, 1)
  const cellH = (height - margin.top - margin.bottom) / Math.max(k, 1)

  // Bounds for each component
  const compBounds = useMemo(() => {
    if (!pcaData || pcaData.scores.length === 0) return []
    const bounds = []
    for (let c = 0; c < k; c++) {
      let minVal = Infinity
      let maxVal = -Infinity
      for (const s of pcaData.scores) {
        const v = s.pc[c] ?? 0
        if (v < minVal) minVal = v
        if (v > maxVal) maxVal = v
      }
      const pad = Math.max((maxVal - minVal) * 0.1, 0.5)
      bounds.push({ min: minVal - pad, max: maxVal + pad })
    }
    return bounds
  }, [pcaData, k])

  // Draw matrix
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    if (!pcaData || k <= 1 || compBounds.length < k) {
      ctx.fillStyle = '#888888'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('PCAデータが不足しています。', width / 2, height / 2)
      return
    }

    // Draw cells
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) {
        const cellX = margin.left + c * cellW
        const cellY = margin.top + r * cellH

        // Cell border & bg
        ctx.fillStyle = r === c ? '#f5f5f5' : '#fafbfc'
        ctx.fillRect(cellX, cellY, cellW, cellH)
        ctx.strokeStyle = '#e8e8e8'
        ctx.lineWidth = 1
        ctx.strokeRect(cellX, cellY, cellW, cellH)

        if (r === c) {
          // Diagonal: Histogram
          const b = compBounds[r]
          const numBins = 15
          const binCounts = new Array(numBins).fill(0)
          const span = b.max - b.min

          for (const s of pcaData.scores) {
            const v = s.pc[r] ?? 0
            const bin = Math.min(Math.floor(((v - b.min) / span) * numBins), numBins - 1)
            if (bin >= 0 && bin < numBins) {
              binCounts[bin]++
            }
          }

          const maxCount = Math.max(...binCounts, 1)
          const bw = cellW / numBins

          ctx.fillStyle = '#bae0ff'
          for (let bIdx = 0; bIdx < numBins; bIdx++) {
            const bh = (binCounts[bIdx] / maxCount) * (cellH * 0.75)
            const bx = cellX + bIdx * bw
            const by = cellY + cellH - bh
            ctx.fillRect(bx, by, bw - 1, bh)
          }

          // Cell title
          ctx.fillStyle = '#1677ff'
          ctx.font = 'bold 12px sans-serif'
          ctx.textAlign = 'center'
          const pct = (pcaData.explainedVarianceRatio[r] * 100).toFixed(1)
          ctx.fillText(`PC${r + 1} (${pct}%)`, cellX + cellW / 2, cellY + 16)
        } else {
          // Off-diagonal: Scatter plot (X: component c, Y: component r)
          const bX = compBounds[c]
          const bY = compBounds[r]

          for (const item of pcaData.scores) {
            const rId = item.rowId || item.row_id || ''
            const vx = item.pc[c] ?? 0
            const vy = item.pc[r] ?? 0

            const px = cellX + ((vx - bX.min) / (bX.max - bX.min)) * cellW
            const py = cellY + cellH - ((vy - bY.min) / (bY.max - bY.min)) * cellH

            const isSelected = isRowSelected(rId)
            const color = getColor(rId)

            ctx.beginPath()
            if (isSelected) {
              ctx.arc(px, py, 3.5, 0, Math.PI * 2)
              ctx.fillStyle = selectionColor
              ctx.fill()
              ctx.lineWidth = 1.5
              ctx.strokeStyle = '#ffffff'
              ctx.stroke()
            } else {
              ctx.arc(px, py, 2.0, 0, Math.PI * 2)
              ctx.fillStyle = color
              ctx.fill()
            }
          }
        }
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
  }, [pcaData, k, compBounds, cellW, cellH, isRowSelected, getColor, selectionColor, dragBox])

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
    if (!isDragging.current || !pcaData || compBounds.length < k) {
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
      // Find which cell the drag was initiated in
      const c = Math.floor((dragStart.current.x - margin.left) / cellW)
      const r = Math.floor((dragStart.current.y - margin.top) / cellH)

      if (r >= 0 && r < k && c >= 0 && c < k && r !== c) {
        const cellX = margin.left + c * cellW
        const cellY = margin.top + r * cellH
        const bX = compBounds[c]
        const bY = compBounds[r]

        const hitIds: string[] = []
        for (const item of pcaData.scores) {
          const vx = item.pc[c] ?? 0
          const vy = item.pc[r] ?? 0
          const px = cellX + ((vx - bX.min) / (bX.max - bX.min)) * cellW
          const py = cellY + cellH - ((vy - bY.min) / (bY.max - bY.min)) * cellH

          if (px >= bx1 && px <= bx2 && py >= by1 && py <= by2) {
            hitIds.push(item.rowId || item.row_id || '')
          }
        }

        if (hitIds.length > 0) {
          dispatch(
            selectionApplied({
              rowIds: hitIds,
              operation: getBrushOp(),
              label: `PCAマトリクス選択 [PC${c + 1} vs PC${r + 1}] (${hitIds.length}行)`,
            })
          )
        }
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
    <div
      data-testid="pca-matrix-view"
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
          <Typography.Text strong>主成分散布図行列 (PC1〜PC{k})</Typography.Text>
          <Space wrap>
            <FocusEnterButton targetId="pca-matrix" title="PCA主成分散布図行列" />
          </Space>
        </Space>
      )}

      <FocusTarget id="pca-matrix" title="PCA主成分散布図行列">
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              background: '#ffffff',
              display: active ? 'flex' : 'inline-block',
              flex: active ? 1 : undefined,
              height: active ? '100%' : undefined,
              width: active ? '100%' : undefined,
              justifyContent: 'center',
              alignItems: 'center',
              userSelect: 'none',
              overflow: 'hidden',
              minHeight: 0,
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
                maxWidth: active ? '100%' : undefined,
                aspectRatio: `${width} / ${height}`,
                cursor: 'crosshair',
                display: 'block',
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              data-testid="pca-matrix-canvas"
            />
          </div>
        </Dropdown>
      </FocusTarget>
    </div>
  )
}
