import { useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown, Tooltip } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { getBrushOp } from '../selection/SelectionMenu'
import { useFocusMode } from '../common/FocusMode'
import type { LineMosaicCell, LineMosaicResponse } from './types'

interface LineMosaicCanvasProps {
  mosaicData: LineMosaicResponse
  normalization: 'global' | 'row'
  onSelectCell?: (cell: LineMosaicCell | null) => void
}

export const LineMosaicCanvas: FC<LineMosaicCanvasProps> = ({
  mosaicData,
  normalization,
  onSelectCell,
}) => {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)

  const selectedSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])

  const { grid, target, maxCellFrequency, cells } = mosaicData
  const nCols = grid.nCols || grid.n_cols || 1
  const nRows = grid.nRows || grid.n_rows || 1

  // Row max frequency if row-normalized
  const rowMaxFreq = useMemo(() => {
    const map = new Map<number, number>()
    for (const c of cells) {
      const cur = map.get(c.i) || 1
      if (c.totalCount > cur) map.set(c.i, c.totalCount)
    }
    return map
  }, [cells])

  // Cell lookup map (i, j) -> LineMosaicCell
  const cellMap = useMemo(() => {
    const m = new Map<string, LineMosaicCell>()
    for (const c of cells) {
      m.set(`${c.i}-${c.j}`, c)
    }
    return m
  }, [cells])

  // Cell box dimensions
  const boxW = focused
    ? Math.max(Math.min(1300 / Math.max(nCols, 1), 320), 120)
    : Math.max(Math.min(760 / Math.max(nCols, 1), 160), 75)
  const boxH = focused
    ? Math.max(Math.min(720 / Math.max(nRows, 1), 160), 80)
    : Math.max(Math.min(420 / Math.max(nRows, 1), 80), 45)
  const colGap = 4
  const rowGap = 6

  // Header column depths
  const colDepth = grid.colVariables ? grid.colVariables.length : 1
  const rowDepth = grid.rowVariables ? grid.rowVariables.length : 1
  const headerHeight = Math.max(colDepth * 26 + 20, 48)
  const leftLabelWidth = Math.max(rowDepth * (focused ? 110 : 85), 70)

  // Drag state
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const dragEnd = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    isDragging.current = true
    dragStart.current = { x, y }
    dragEnd.current = { x, y }
    setDragBox({ x1: x, y1: y, x2: x, y2: y })
  }

  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!isDragging.current) return
    const rect = containerRef.current?.getBoundingClientRect()
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

  const handleMouseUp = (e?: ReactMouseEvent<HTMLDivElement>) => {
    if (!isDragging.current) {
      isDragging.current = false
      setDragBox(null)
      return
    }
    isDragging.current = false

    if (e && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      dragEnd.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const bx1 = Math.min(dragStart.current.x, dragEnd.current.x)
    const bx2 = Math.max(dragStart.current.x, dragEnd.current.x)
    const by1 = Math.min(dragStart.current.y, dragEnd.current.y)
    const by2 = Math.max(dragStart.current.y, dragEnd.current.y)

    // Check if drag was larger than tiny jitter
    if (bx2 - bx1 > 8 || by2 - by1 > 8) {
      const hitRowIds: string[] = []
      // Check which cells intersect with drag box
      for (let r = 1; r <= nRows; r++) {
        for (let c = 1; c <= nCols; c++) {
          const cellLeft = leftLabelWidth + (c - 1) * (boxW + colGap)
          const cellRight = cellLeft + boxW
          const cellTop = headerHeight + (r - 1) * (boxH + rowGap)
          const cellBottom = cellTop + boxH

          const intersects = !(cellRight < bx1 || cellLeft > bx2 || cellBottom < by1 || cellTop > by2)
          if (intersects) {
            const cellData = cellMap.get(`${r}-${c}`)
            if (cellData && cellData.rowIds) {
              hitRowIds.push(...cellData.rowIds)
            }
          }
        }
      }

      if (hitRowIds.length > 0) {
        dispatch(
          selectionApplied({
            rowIds: hitRowIds,
            operation: getBrushOp(),
            label: `モザイク範囲選択 (${hitRowIds.length}行)`,
          })
        )
      }
    }

    setDragBox(null)
  }

  const handleCellClick = (cell: LineMosaicCell, _e: ReactMouseEvent) => {
    if (onSelectCell) onSelectCell(cell)
    if (cell.rowIds && cell.rowIds.length > 0) {
      dispatch(
        selectionApplied({
          rowIds: cell.rowIds,
          operation: getBrushOp(),
          label: `モザイクセル選択 [${cell.rowPath.join('/')} × ${cell.colPath.join('/')}] (${cell.rowIds.length}行)`,
        })
      )
    }
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

  const totalWidth = leftLabelWidth + nCols * (boxW + colGap) + 20
  const totalHeight = headerHeight + nRows * (boxH + rowGap) + 20

  return (
    <div
      data-testid="mosaic-view"
      style={{
        overflow: 'auto',
        maxHeight: focused ? 'none' : '72vh',
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : undefined,
        padding: 8,
      }}
    >
      <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
        <div
          ref={containerRef}
          style={{
            position: 'relative',
            width: totalWidth,
            height: totalHeight,
            background: '#ffffff',
            borderRadius: 6,
            border: '1px solid #e5e7eb',
            padding: 10,
            userSelect: 'none',
            cursor: 'crosshair',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          data-testid="mosaic-canvas"
        >
          {/* Column Header Labels */}
          {grid.colLabels &&
            grid.colLabels.map((cl, idx) => {
              const cIdx = cl.j ? cl.j - 1 : idx
              const cx = leftLabelWidth + cIdx * (boxW + colGap)
              return (
                <div
                  key={`col-label-${idx}`}
                  style={{
                    position: 'absolute',
                    left: cx,
                    top: 4,
                    width: boxW,
                    height: headerHeight - 8,
                    textAlign: 'center',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    fontSize: focused ? 12 : 11,
                    fontWeight: 600,
                    color: '#333',
                    borderBottom: '2px solid #d9d9d9',
                    paddingBottom: 4,
                    paddingTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={cl.path.join(' / ')}
                >
                  {cl.path.map((p, pIdx) => (
                    <div key={pIdx} style={{ fontSize: focused ? (pIdx === 0 ? 12 : 11) : (pIdx === 0 ? 11 : 10), color: pIdx === 0 ? '#111' : '#666', lineHeight: 1.3 }}>
                      {p}
                    </div>
                  ))}
                </div>
              )
            })}

          {/* Row Labels & Cell Boxes */}
          {Array.from({ length: nRows }, (_, rIdx) => {
            const r = rIdx + 1
            const cy = headerHeight + rIdx * (boxH + rowGap)
            const rl = grid.rowLabels ? grid.rowLabels[rIdx] : null

            return (
              <div key={`row-${r}`}>
                {/* Left Row Header */}
                <div
                  style={{
                    position: 'absolute',
                    left: 8,
                    top: cy,
                    width: leftLabelWidth - 14,
                    height: boxH,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    paddingRight: 8,
                    fontSize: focused ? 12 : 11,
                    fontWeight: 600,
                    color: '#333',
                    textAlign: 'right',
                    borderRight: '2px solid #d9d9d9',
                  }}
                  title={rl ? rl.path.join(' / ') : undefined}
                >
                  {rl ? rl.path.join(' / ') : `Row ${r}`}
                </div>

                {/* Cells in Row */}
                {Array.from({ length: nCols }, (_, cIdx) => {
                  const c = cIdx + 1
                  const cx = leftLabelWidth + cIdx * (boxW + colGap)
                  const cell = cellMap.get(`${r}-${c}`)
                  const count = cell ? cell.totalCount : 0
                  const maxF = normalization === 'row' ? (rowMaxFreq.get(r) || 1) : maxCellFrequency
                  const lineLengthRatio = Math.min(count / maxF, 1.0)
                  const linePixelLength = Math.max(lineLengthRatio * (boxW - 12), count > 0 ? 3 : 0)

                  // Check if any rowIds in cell are currently selected
                  const selectedInCell = cell
                    ? cell.rowIds.filter((id) => selectedSet.has(id)).length
                    : 0
                  const isCellSelected = selectedInCell > 0

                  // Build tooltip text
                  const tooltipContent = cell ? (
                    <div style={{ fontSize: 11 }}>
                      <div><strong>{cell.rowPath.join(' / ')} × {cell.colPath.join(' / ')}</strong></div>
                      <div>度数: <strong>{cell.totalCount}</strong> 行 ({(lineLengthRatio * 100).toFixed(1)}%)</div>
                      {target && (
                        <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px dashed #666' }}>
                          <div>{target.name} 分布:</div>
                          {target.categories.map((cat) => {
                            const tc = cell.targetCounts[cat] || 0
                            const pct = cell.totalCount > 0 ? ((tc / cell.totalCount) * 100).toFixed(1) : '0.0'
                            return (
                              <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                <span>{cat}:</span>
                                <strong>{tc} ({pct}%)</strong>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      {selectedInCell > 0 && (
                        <div style={{ color: '#2a78d6', marginTop: 2 }}>
                          選択行数: {selectedInCell} / {cell.totalCount}
                        </div>
                      )}
                    </div>
                  ) : null

                  return (
                    <Tooltip key={`cell-${r}-${c}`} title={tooltipContent} placement="top">
                      <div
                        onClick={(e) => cell && handleCellClick(cell, e)}
                        style={{
                          position: 'absolute',
                          left: cx,
                          top: cy,
                          width: boxW,
                          height: boxH,
                          background: isCellSelected ? '#e6f7ff' : '#fafafa',
                          border: isCellSelected ? '2px solid #2a78d6' : '1px solid #d9d9d9',
                          borderRadius: 4,
                          padding: '4px 6px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          boxSizing: 'border-box',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {/* Cell Count Label */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: focused ? 12 : 10, color: '#666' }}>
                          <span style={{ fontWeight: count > 0 ? 600 : 'normal', color: count > 0 ? '#222' : '#aaa' }}>
                            {count}
                          </span>
                          {isCellSelected && (
                            <span style={{ color: '#2a78d6', fontWeight: 'bold' }}>●</span>
                          )}
                        </div>

                        {/* Aligned Horizontal Line (Line Mosaic Core) */}
                        <div
                          style={{
                            width: '100%',
                            height: focused ? 14 : 10,
                            background: '#f0f0f0',
                            borderRadius: 2,
                            overflow: 'hidden',
                            display: 'flex',
                          }}
                        >
                          {count > 0 && target && cell ? (
                            // Segmented by target variable
                            target.categories.map((cat, catIdx) => {
                              const catCount = cell.targetCounts[cat] || 0
                              const segRatio = catCount / count
                              const segW = linePixelLength * segRatio
                              const color = target.colors[catIdx % target.colors.length]

                              if (segW <= 0) return null
                              return (
                                <div
                                  key={cat}
                                  style={{
                                    width: segW,
                                    height: '100%',
                                    backgroundColor: color,
                                  }}
                                  title={`${cat}: ${catCount}`}
                                />
                              )
                            })
                          ) : count > 0 ? (
                            // Standard primary blue line
                            <div
                              style={{
                                width: linePixelLength,
                                height: '100%',
                                backgroundColor: isCellSelected ? '#2a78d6' : '#1677ff',
                                borderRadius: 2,
                              }}
                            />
                          ) : null}
                        </div>
                      </div>
                    </Tooltip>
                  )
                })}
              </div>
            )
          })}

          {/* Drag Selection Box Overlay */}
          {dragBox && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(dragBox.x1, dragBox.x2),
                top: Math.min(dragBox.y1, dragBox.y2),
                width: Math.abs(dragBox.x2 - dragBox.x1),
                height: Math.abs(dragBox.y2 - dragBox.y1),
                backgroundColor: 'rgba(42, 120, 214, 0.15)',
                border: '1.5px solid #2a78d6',
                pointerEvents: 'none',
                borderRadius: 2,
              }}
            />
          )}
        </div>
      </Dropdown>
    </div>
  )
}
