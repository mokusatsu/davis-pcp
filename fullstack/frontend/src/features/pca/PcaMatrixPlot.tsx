import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC, type PointerEvent as ReactPointerEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown, Space, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { useRowColorResolver } from '../../theme/useRowColor'
import GraphPanel, { useGraphPopupContainer, useGraphViewport } from '../common/GraphPanel'
import { canvasBufferSize, clientToCanvas } from '../common/graphCoordinates'
import { getBrushOp } from '../selection/SelectionMenu'
import type { PcaResponse } from './types'

interface PcaMatrixPlotProps {
  pcaData: PcaResponse | null
}

type CanvasViewport = Pick<ReturnType<typeof useGraphViewport>, 'scale' | 'dpr' | 'revision'>

/** GraphPanel の子で実倍率を取得し、親所有の Canvas の描画バッファへ反映する。 */
function PcaMatrixViewportSync({ onViewportChange }: { onViewportChange: (viewport: CanvasViewport) => void }) {
  const { scale, dpr, revision } = useGraphViewport()
  useLayoutEffect(() => {
    onViewportChange({ scale, dpr, revision })
  }, [scale, dpr, revision, onViewportChange])
  return null
}

export const PcaMatrixPlot: FC<PcaMatrixPlotProps> = ({ pcaData }) => {
  const [canvasViewport, setCanvasViewport] = useState<CanvasViewport>(() => ({
    scale: 1,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
    revision: 0,
  }))
  const updateCanvasViewport = useCallback((next: CanvasViewport) => {
    setCanvasViewport(current => current.scale === next.scale && current.dpr === next.dpr && current.revision === next.revision
      ? current
      : next)
  }, [])
  const { scale: viewportScale, dpr: viewportDpr, revision: viewportRevision } = canvasViewport
  const graphPopupContainer = useGraphPopupContainer('pca/matrix')
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

  // Draw matrix: 行列全体を一組。セル内座標と全体座標を区別する。
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const buffer = canvasBufferSize({ width, height }, viewportScale, viewportDpr)
    if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
      canvas.width = buffer.width
      canvas.height = buffer.height
    }
    ctx.setTransform(buffer.width / width, 0, 0, buffer.height / height, 0, 0)

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
              ctx.fillStyle = color
              ctx.fill()
              ctx.lineWidth = 1.5
              ctx.strokeStyle = selectionColor
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
  }, [pcaData, k, compBounds, cellW, cellH, isRowSelected, getColor, selectionColor, dragBox, viewportScale, viewportDpr, viewportRevision])

  // Mouse drag handlers: Canvas 自体の表示矩形と論理寸法を基準に変換する。
  const canvasPoint = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return { x: NaN, y: NaN }
    return clientToCanvas(canvasRef.current, e, { width, height })
  }
  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const { x, y } = canvasPoint(e)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    isDragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStart.current = { x, y }
    dragEnd.current = { x, y }
    setDragBox({ x1: x, y1: y, x2: x, y2: y })
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDragging.current) return
    const { x, y } = canvasPoint(e)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    dragEnd.current = { x, y }
    setDragBox({
      x1: dragStart.current.x,
      y1: dragStart.current.y,
      x2: x,
      y2: y,
    })
  }

  const handlePointerUp = (e?: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDragging.current || !pcaData || compBounds.length < k) {
      isDragging.current = false
      setDragBox(null)
      return
    }
    isDragging.current = false

    if (e && canvasRef.current) {
      const pt = canvasPoint(e)
      if (Number.isFinite(pt.x) && Number.isFinite(pt.y)) dragEnd.current = pt
    }

    const bx1 = Math.min(dragStart.current.x, dragEnd.current.x)
    const bx2 = Math.max(dragStart.current.x, dragEnd.current.x)
    const by1 = Math.min(dragStart.current.y, dragEnd.current.y)
    const by2 = Math.max(dragStart.current.y, dragEnd.current.y)

    const display = canvasRef.current!.getBoundingClientRect()
    const scaleX = display.width / width, scaleY = display.height / height
    const brush = (bx2 - bx1) * scaleX > 4 || (by2 - by1) * scaleY > 4
    {
      // Find which cell the drag was initiated in
      const c = Math.floor((dragStart.current.x - margin.left) / cellW)
      const r = Math.floor((dragStart.current.y - margin.top) / cellH)

      if (r >= 0 && r < k && c >= 0 && c < k && r !== c) {
        const cellX = margin.left + c * cellW
        const cellY = margin.top + r * cellH
        const bX = compBounds[c]
        const bY = compBounds[r]

        const hitIds: string[] = []
        let nearestDistance = 49
        for (const item of pcaData.scores) {
          const vx = item.pc[c] ?? 0
          const vy = item.pc[r] ?? 0
          const px = cellX + ((vx - bX.min) / (bX.max - bX.min)) * cellW
          const py = cellY + cellH - ((vy - bY.min) / (bY.max - bY.min)) * cellH

          if (brush && px >= bx1 && px <= bx2 && py >= by1 && py <= by2) {
            hitIds.push(item.rowId || item.row_id || '')
          } else if (!brush) {
            const distance = ((px - dragEnd.current.x) * scaleX) ** 2 + ((py - dragEnd.current.y) * scaleY) ** 2
            if (distance < nearestDistance) {
              nearestDistance = distance
              hitIds.splice(0, hitIds.length, item.rowId || item.row_id || '')
            }
          }
        }

        dispatch(
          selectionApplied({
            rowIds: hitIds,
            operation: brush ? getBrushOp() : 'toggle',
            label: `PCAマトリクス選択 [PC${c + 1} vs PC${r + 1}] (${hitIds.length}行)`,
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
    <div
      data-testid="pca-matrix-view"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}
    >
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Typography.Text strong>主成分散布図行列 (PC1〜PC{k})</Typography.Text>
          <Space wrap>
          </Space>
        </Space>

      <GraphPanel
        graphId="pca/matrix"
        title="PCA主成分散布図行列"
        available={Boolean(pcaData && pcaData.scores.length)}
        sizing="intrinsic"
        intrinsicSize={{ width, height }}
      >
        <PcaMatrixViewportSync onViewportChange={updateCanvasViewport} />
        <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
          <div
            style={{
              boxShadow: 'inset 0 0 0 1px #e5e7eb',
              borderRadius: 6,
              background: '#ffffff',
              display: 'inline-block',
              justifyContent: 'center',
              alignItems: 'center',
              userSelect: 'none',
              overflow: 'hidden',
              minHeight: 0,
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width, height, maxWidth: '100%',
                aspectRatio: `${width} / ${height}`,
                cursor: 'crosshair',
                touchAction: 'none',
                display: 'block',
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { isDragging.current = false; setDragBox(null) }}
              onLostPointerCapture={() => { isDragging.current = false; setDragBox(null) }}
              data-testid="pca-matrix-canvas"
            />
          </div>
        </Dropdown>
      </GraphPanel>
    </div>
  )
}
