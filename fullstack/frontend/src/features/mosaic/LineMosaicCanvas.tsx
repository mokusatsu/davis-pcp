import { SELECTION_LABELS } from '../selection/selectionLabels'
import EChartSurface from '../charts/EChartSurface'
import GraphPanel, { useGraphPopupContainer, useGraphViewport } from '../common/GraphPanel'
import { getSvgPoint } from '../../utils/svgCoordinates'
import { useEffect, useMemo, useRef, useState, type FC, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { getBrushOp } from '../selection/SelectionMenu'
import type { LineMosaicCell, LineMosaicResponse } from './types'
import { mosaicPathLabel } from './types'

interface LineMosaicCanvasProps {
  mosaicData: LineMosaicResponse
  normalization: 'global' | 'row'
  onSelectCell?: (cell: LineMosaicCell | null) => void
}

/** 枠線まで含めた Line Mosaic の固定論理寸法。GraphPanel と描画子で共有する。 */
export function lineMosaicDimensions(mosaicData: LineMosaicResponse): { width: number; height: number } {
  const nCols = mosaicData.grid.nCols || mosaicData.grid.n_cols || 1
  const nRows = mosaicData.grid.nRows || mosaicData.grid.n_rows || 1
  const boxW = Math.max(Math.min(760 / Math.max(nCols, 1), 160), 75)
  const boxH = Math.max(Math.min(420 / Math.max(nRows, 1), 80), 45)
  const colDepth = mosaicData.grid.colVariables ? mosaicData.grid.colVariables.length : 1
  const rowDepth = mosaicData.grid.rowVariables ? mosaicData.grid.rowVariables.length : 1
  const headerHeight = Math.max(colDepth * 26 + 20, 48)
  const leftLabelWidth = Math.max(rowDepth * 85, 70)
  // 描画コンテナは content-box（padding 10px × 2 + border 1px × 2）。
  // GraphPanel には実際の外形まで含めた論理寸法を渡す。
  return {
    width: leftLabelWidth + nCols * (boxW + 4) + 42,
    height: headerHeight + nRows * (boxH + 6) + 42,
  }
}

export const LineMosaicCanvas: FC<LineMosaicCanvasProps> = (props) => {
  const dispatch = useDispatch<AppDispatch>()
  const selectCell = (cell: LineMosaicCell) => {
    props.onSelectCell?.(cell)
    if (cell.rowIds.length) dispatch(selectionApplied({ rowIds: cell.rowIds, operation: getBrushOp(), label: `モザイクセル選択 (${cell.rowIds.length}行)` }))
  }
  return <GraphPanel graphId="mosaic/main" title="Line Mosaic Plot" sizing="intrinsic" intrinsicSize={lineMosaicDimensions(props.mosaicData)}
    controls={<details><summary>セル一覧・キーボード選択</summary>{props.mosaicData.cells.map(cell =>
      <button key={`${cell.i}-${cell.j}`} type="button" onClick={() => selectCell(cell)} style={{ margin: 3 }}>
        {mosaicPathLabel(props.mosaicData, 'row', cell.rowPath)} × {mosaicPathLabel(props.mosaicData, 'col', cell.colPath)}: {cell.totalCount}行
      </button>)}</details>}>
    <LineMosaicDrawing {...props} />
  </GraphPanel>
}

const LineMosaicDrawing: FC<LineMosaicCanvasProps> = ({
  mosaicData,
  normalization,
  onSelectCell,
}) => {
  const dispatch = useDispatch<AppDispatch>()
  const viewport = useGraphViewport()
  const getPopupContainer = useGraphPopupContainer()
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

  // Cell box dimensions: 通常寸法を固定し、拡大は共通 surface の scale で行う。
  const boxW = Math.max(Math.min(760 / Math.max(nCols, 1), 160), 75)
  const boxH = Math.max(Math.min(420 / Math.max(nRows, 1), 80), 45)
  const colGap = 4
  const rowGap = 6

  // Header column depths
  const colDepth = grid.colVariables ? grid.colVariables.length : 1
  const rowDepth = grid.rowVariables ? grid.rowVariables.length : 1
  const headerHeight = Math.max(colDepth * 26 + 20, 48)
  const leftLabelWidth = Math.max(rowDepth * 85, 70)

  // Drag state
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const dragEnd = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const containerRef = useRef<SVGSVGElement>(null)
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const pointerId = useRef<number | null>(null)

  const positionOf = (clientX: number, clientY: number) => {
    const svg = containerRef.current
    if (!svg) return null
    const point = getSvgPoint(svg, { clientX, clientY }, { width: totalWidth, height: totalHeight })
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null
  }

  const commitDrag = (end: { x: number; y: number }) => {
    const start = dragStart.current
    dragStart.current = null
    pointerId.current = null
    if (!start) {
      setDragBox(null)
      return
    }
    dragEnd.current = end
    const bx1 = Math.min(start.x, end.x)
    const bx2 = Math.max(start.x, end.x)
    const by1 = Math.min(start.y, end.y)
    const by2 = Math.max(start.y, end.y)

    if (bx2 - bx1 > 8 || by2 - by1 > 8) {
      const hit = new Set<string>()
      for (let r = 1; r <= nRows; r++) {
        for (let c = 1; c <= nCols; c++) {
          const cellLeft = leftLabelWidth + (c - 1) * (boxW + colGap)
          const cellRight = cellLeft + boxW
          const cellTop = headerHeight + (r - 1) * (boxH + rowGap)
          const cellBottom = cellTop + boxH
          const intersects = !(cellRight < bx1 || cellLeft > bx2 || cellBottom < by1 || cellTop > by2)
          if (intersects) {
            const cellData = cellMap.get(`${r}-${c}`)
            for (const id of cellData?.rowIds ?? []) hit.add(id)
          }
        }
      }
      const hitRowIds = [...hit]
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

  const handlePointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || dragStart.current) return
    if ((e.target as HTMLElement | null)?.closest?.('[data-selectable]')) return
    const position = positionOf(e.clientX, e.clientY)
    if (!position) return
    dragStart.current = position
    dragEnd.current = position
    pointerId.current = e.pointerId
    setDragBox({ x1: position.x, y1: position.y, x2: position.x, y2: position.y })
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const start = dragStart.current
    if (!start || (pointerId.current !== null && e.pointerId !== pointerId.current)) return
    const position = positionOf(e.clientX, e.clientY)
    if (!position) return
    dragEnd.current = position
    setDragBox({ x1: start.x, y1: start.y, x2: position.x, y2: position.y })
  }

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragStart.current || (pointerId.current !== null && e.pointerId !== pointerId.current)) return
    const position = positionOf(e.clientX, e.clientY) ?? dragEnd.current
    commitDrag(position)
  }

  const handlePointerCancel = () => {
    dragStart.current = null
    pointerId.current = null
    setDragBox(null)
  }

  useEffect(() => {
    dragStart.current = null
    pointerId.current = null
    setDragBox(null)
  }, [mosaicData, viewport.revision, viewport.scale, viewport.zoom, viewport.dpr])

  const handleCellClick = (cell: LineMosaicCell, e: ReactMouseEvent) => {
    e.stopPropagation()
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
      label: SELECTION_LABELS.focus,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: SELECTION_LABELS.exclude,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: SELECTION_LABELS.clear,
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'reset',
      label: SELECTION_LABELS.reset,
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  const { width: visualWidth, height: visualHeight } = lineMosaicDimensions(mosaicData)
  const totalWidth = visualWidth - 22
  const totalHeight = visualHeight - 22

  return (
    <div
      data-testid="mosaic-view"
      style={{
        width: visualWidth,
        height: visualHeight,
        overflow: 'visible',
        padding: 10,
        boxSizing: 'border-box',
      }}
    >
      <Dropdown getPopupContainer={getPopupContainer} menu={{ items: contextMenuItems }} trigger={['contextMenu']}>
        <div>
        <EChartSurface ref={containerRef} width={totalWidth} height={totalHeight} viewBox={`0 0 ${totalWidth} ${totalHeight}`}
          style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'crosshair' }}
          onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerCancel} onLostPointerCapture={handlePointerCancel}
          data-testid="mosaic-canvas" aria-label="Line Mosaic セル度数と内部カテゴリ分布">
          {grid.colLabels?.map((cl, index) => <text key={`col-${index}`} x={leftLabelWidth + ((cl.j ? cl.j - 1 : index) + .5) * (boxW + colGap)}
            y={headerHeight - 12} textAnchor="middle" fontSize={11}>{mosaicPathLabel(mosaicData, 'col', cl.path)}<title>{mosaicPathLabel(mosaicData, 'col', cl.path)}</title></text>)}
          {Array.from({ length: nRows }, (_, index) => <text key={`row-${index}`} x={leftLabelWidth - 10} y={headerHeight + index * (boxH + rowGap) + boxH / 2}
            textAnchor="end" fontSize={11}>{grid.rowLabels[index] ? mosaicPathLabel(mosaicData, 'row', grid.rowLabels[index].path) : `Row ${index + 1}`}</text>)}
          {Array.from({ length: nRows * nCols }, (_, index) => {
            const r = Math.floor(index / nCols) + 1, c = index % nCols + 1
            const cell = cellMap.get(`${r}-${c}`), count = cell?.totalCount ?? 0
            const x = leftLabelWidth + (c - 1) * (boxW + colGap), y = headerHeight + (r - 1) * (boxH + rowGap)
            const maxF = normalization === 'row' ? rowMaxFreq.get(r) || 1 : maxCellFrequency || 1
            const length = Math.max(Math.min(count / maxF, 1) * (boxW - 12), count > 0 ? 3 : 0)
            const selectedCount = cell?.rowIds.filter(id => selectedSet.has(id)).length ?? 0
            let offset = 0
            return <g key={index} data-selectable={!!cell?.rowIds.length} onClick={(event) => cell && handleCellClick(cell, event)} style={{ cursor: cell ? 'pointer' : 'default' }}>
              <rect x={x} y={y} width={boxW} height={boxH} rx={4} fill={selectedCount ? '#e6f7ff' : '#fafafa'} stroke={selectedCount ? '#2a78d6' : '#d9d9d9'} strokeWidth={selectedCount ? 2 : 1}>
                <title>{cell ? `${mosaicPathLabel(mosaicData, 'row', cell.rowPath)} × ${mosaicPathLabel(mosaicData, 'col', cell.colPath)}\n度数: ${count}行 / 最大比率: ${(count / maxF * 100).toFixed(1)}%\n選択中: ${selectedCount}行` : '度数0'}</title>
              </rect>
              <text x={x + 6} y={y + 18} fontSize={10}>{count}{selectedCount ? ' ✓' : ''}</text>
              <rect x={x + 6} y={y + boxH - 16} width={boxW - 12} height={10} fill="#f0f0f0" />
              {target && cell ? target.categories.map((category, categoryIndex) => {
                const n = cell.targetCounts[category] || 0, segmentWidth = count ? length * n / count : 0
                const left = offset; offset += segmentWidth
                return <rect key={category} x={x + 6 + left} y={y + boxH - 16} width={segmentWidth} height={10}
                  fill={target.colors[categoryIndex % target.colors.length]}><title>{`${target.valueLabels?.[category] ?? category}: ${n} (${count ? (n / count * 100).toFixed(1) : 0}%)`}</title></rect>
              }) : <rect x={x + 6} y={y + boxH - 16} width={length} height={10} fill={selectedCount ? '#2a78d6' : '#1677ff'} />}
            </g>
          })}
          {dragBox && <rect x={Math.min(dragBox.x1, dragBox.x2)} y={Math.min(dragBox.y1, dragBox.y2)} width={Math.abs(dragBox.x2 - dragBox.x1)} height={Math.abs(dragBox.y2 - dragBox.y1)}
            fill="rgba(42,120,214,0.15)" stroke="#2a78d6" strokeWidth={1.5} pointerEvents="none" data-testid="mosaic-brush-rect" />}
        </EChartSurface>

        </div>
      </Dropdown>
    </div>
  )
}
