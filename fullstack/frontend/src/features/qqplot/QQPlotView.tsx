import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Card, Dropdown, Select, Space, Tag, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet, selectEffectiveRowIds } from '../../app/store'
import { api } from '../../api/client'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { useRowColorResolver } from '../../theme/useRowColor'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { getBrushOp } from '../selection/SelectionMenu'
import EmptyStatePanel from '../common/EmptyStatePanel'
import { truncateText } from '../../utils/textUtils'

interface QQPoint {
  rowId: string
  rank: number
  sampleValue: number
  theoreticalQuantile: number
}

interface QQResponse {
  column: string
  count: number
  normalityTest: {
    shapiroWilkW: number | null
    pValue: number | null
    isNormalAlpha05: boolean | null
    skewness: number
    kurtosis: number
  }
  referenceLine: {
    slope: number
    intercept: number
    q1Sample: number
    q3Sample: number
    q1Theoretical: number
    q3Theoretical: number
  }
  points: QQPoint[]
  minZ: number
  maxZ: number
  minVal: number
  maxVal: number
}

export default function QQPlotView() {
  const { focused } = useFocusMode()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)

  const numericColumns = useMemo(() => {
    if (!data) return []
    const activeVarSet = globalVars?.activeVariableIds?.length ? new Set(globalVars.activeVariableIds) : null
    return data.schema
      .filter((c) => c.semanticType === 'numeric' && (!activeVarSet || activeVarSet.has(c.name)))
      .map((c) => c.name)
  }, [data, globalVars?.activeVariableIds])

  const [selectedColumn, setSelectedColumn] = useState<string>('')
  const [qqData, setQqData] = useState<QQResponse | null>(null)
  const [loading, setLoading] = useState(false)

  // Brush drag state
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  useEffect(() => {
    if (numericColumns.length > 0 && (!selectedColumn || !numericColumns.includes(selectedColumn))) {
      setSelectedColumn(numericColumns[0])
    }
  }, [numericColumns, selectedColumn])

  useEffect(() => {
    if (!selection.datasetId || !selectedColumn) return
    setLoading(true)
    api.post<QQResponse>('/summaries/qqplot', {
      datasetId: selection.datasetId,
      column: selectedColumn,
      rowIds: effectiveRowIds.length < (data?.rowIds.length ?? 0) ? effectiveRowIds : undefined,
    })
      .then(setQqData)
      .catch(() => setQqData(null))
      .finally(() => setLoading(false))
  }, [selection.datasetId, selectedColumn, effectiveRowIds, data])

  const { selectedSet, getColor, selectionColor } = useRowColorResolver()

  // Canvas dimensions
  const width = focused ? 960 : 680
  const height = focused ? 600 : 440
  const margin = focused ? { top: 40, right: 40, bottom: 60, left: 70 } : { top: 30, right: 30, bottom: 50, left: 60 }
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom

  // Scales
  const scales = useMemo(() => {
    if (!qqData) return null
    const zPad = (qqData.maxZ - qqData.minZ) * 0.08 || 0.5
    const vPad = (qqData.maxVal - qqData.minVal) * 0.08 || 0.5

    const minZ = qqData.minZ - zPad
    const maxZ = qqData.maxZ + zPad
    const minV = qqData.minVal - vPad
    const maxV = qqData.maxVal + vPad

    const scaleX = (z: number) => margin.left + ((z - minZ) / (maxZ - minZ)) * plotW
    const scaleY = (v: number) => margin.top + plotH - ((v - minV) / (maxV - minV)) * plotH

    const invertX = (px: number) => minZ + ((px - margin.left) / plotW) * (maxZ - minZ)
    const invertY = (py: number) => minV + ((margin.top + plotH - py) / plotH) * (maxV - minV)

    return { scaleX, scaleY, invertX, invertY, minZ, maxZ, minV, maxV }
  }, [qqData, plotW, plotH, margin.left, margin.top])

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !qqData || !scales) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    // Clear
    ctx.clearRect(0, 0, width, height)

    // Background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    // Grid lines
    ctx.strokeStyle = '#f0f0f0'
    ctx.lineWidth = 1
    for (let z = Math.ceil(scales.minZ); z <= Math.floor(scales.maxZ); z++) {
      const x = scales.scaleX(z)
      ctx.beginPath()
      ctx.moveTo(x, margin.top)
      ctx.lineTo(x, margin.top + plotH)
      ctx.stroke()
    }

    // Axes
    ctx.strokeStyle = '#d9d9d9'
    ctx.lineWidth = 1.2
    ctx.strokeRect(margin.left, margin.top, plotW, plotH)

    // Axis Ticks
    ctx.fillStyle = '#6b7280'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    for (let z = Math.ceil(scales.minZ); z <= Math.floor(scales.maxZ); z++) {
      const x = scales.scaleX(z)
      ctx.fillText(String(z), x, margin.top + plotH + 18)
    }

    // X Axis Title
    ctx.fillStyle = '#374151'
    ctx.font = '600 12px sans-serif'
    ctx.fillText('理論正規分位点 (Theoretical Normal Quantiles)', margin.left + plotW / 2, height - (focused ? 16 : 12))

    // Y Ticks
    ctx.fillStyle = '#6b7280'
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'right'
    const nYTicks = 5
    for (let i = 0; i <= nYTicks; i++) {
      const v = scales.minV + (i / nYTicks) * (scales.maxV - scales.minV)
      const y = scales.scaleY(v)
      ctx.fillText(v.toFixed(1), margin.left - 8, y + 4)
    }
    // Y Axis Label (vertical)
    ctx.save()
    ctx.translate(16, margin.top + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#374151'
    ctx.font = '600 12px sans-serif'
    ctx.fillText(`サンプル分位点 (${truncateText(qqData.column, 24)})`, 0, 0)
    ctx.restore()

    // Robust Reference Line (Q1 - Q3)
    const ref = qqData.referenceLine
    const lineX1 = scales.minZ
    const lineY1 = ref.intercept + ref.slope * lineX1
    const lineX2 = scales.maxZ
    const lineY2 = ref.intercept + ref.slope * lineX2

    ctx.strokeStyle = '#ff4d4f'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(scales.scaleX(lineX1), scales.scaleY(lineY1))
    ctx.lineTo(scales.scaleX(lineX2), scales.scaleY(lineY2))
    ctx.stroke()
    ctx.setLineDash([])

    // Data points with L1/L2 and selection coloring
    for (const pt of qqData.points) {
      const px = scales.scaleX(pt.theoreticalQuantile)
      const py = scales.scaleY(pt.sampleValue)
      const isSelected = selectedSet.has(pt.rowId)
      const ptColor = getColor(pt.rowId)

      ctx.beginPath()
      ctx.arc(px, py, isSelected ? (focused ? 6.0 : 5.0) : (focused ? 4.5 : 3.5), 0, Math.PI * 2)
      if (isSelected) {
        ctx.fillStyle = selectionColor
        ctx.fill()
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      } else {
        ctx.fillStyle = ptColor
        ctx.globalAlpha = 0.7
        ctx.fill()
        ctx.globalAlpha = 1.0
      }
    }

    // Drag selection box (AGENTS.md rule 5.2)
    if (dragBox) {
      const bx = Math.min(dragBox.x1, dragBox.x2)
      const by = Math.min(dragBox.y1, dragBox.y2)
      const bw = Math.abs(dragBox.x2 - dragBox.x1)
      const bh = Math.abs(dragBox.y2 - dragBox.y1)

      ctx.fillStyle = 'rgba(42, 120, 214, 0.15)'
      ctx.strokeStyle = '#2a78d6'
      ctx.lineWidth = 1.5
      ctx.fillRect(bx, by, bw, bh)
      ctx.strokeRect(bx, by, bw, bh)
    }
  }, [qqData, scales, selectedSet, getColor, selectionColor, dragBox, width, height, plotW, plotH, focused, margin.left, margin.top])

  // Mouse drag handlers normalized to canvas coordinates
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleXFactor = width / (rect.width || 1)
    const scaleYFactor = height / (rect.height || 1)
    const x = (e.clientX - rect.left) * scaleXFactor
    const y = (e.clientY - rect.top) * scaleYFactor
    isDragging.current = true
    dragStart.current = { x, y }
    setDragBox({ x1: x, y1: y, x2: x, y2: y })
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging.current || !canvasRef.current) return
    const rect = canvasRef.current.getBoundingClientRect()
    const scaleXFactor = width / (rect.width || 1)
    const scaleYFactor = height / (rect.height || 1)
    const x = (e.clientX - rect.left) * scaleXFactor
    const y = (e.clientY - rect.top) * scaleYFactor
    setDragBox({ x1: dragStart.current.x, y1: dragStart.current.y, x2: x, y2: y })
  }

  const handleMouseUp = () => {
    if (!isDragging.current || !dragBox || !qqData || !scales) {
      isDragging.current = false
      setDragBox(null)
      return
    }
    isDragging.current = false

    const minX = Math.min(dragBox.x1, dragBox.x2)
    const maxX = Math.max(dragBox.x1, dragBox.x2)
    const minY = Math.min(dragBox.y1, dragBox.y2)
    const maxY = Math.max(dragBox.y1, dragBox.y2)

    // Find points in box
    const selectedIds: string[] = []
    for (const pt of qqData.points) {
      const px = scales.scaleX(pt.theoreticalQuantile)
      const py = scales.scaleY(pt.sampleValue)
      if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
        selectedIds.push(pt.rowId)
      }
    }

    if (selectedIds.length > 0) {
      dispatch(selectionApplied({
        rowIds: selectedIds,
        operation: getBrushOp(),
        label: `QQ-Plotから${selectedIds.length}件選択`,
      }))
    }
    setDragBox(null)
  }

  // Right-click context menu items (DAVIS legacy)
  const contextMenuItems = [
    {
      key: 'focus',
      label: 'Focus Selected (選択行のみに絞り込み)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(focusSelected()),
    },
    {
      key: 'delete',
      label: 'Delete Selected (選択行を一時除外)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(deleteSelected()),
    },
    {
      key: 'clear',
      label: 'Clear Selection (選択解除)',
      disabled: selection.selectedRowIds.length === 0,
      onClick: () => dispatch(selectionCleared()),
    },
    {
      key: 'reset',
      label: 'Reset to Base Data (全データ復帰)',
      onClick: () => dispatch(resetWorkingSet()),
    },
  ]

  if (numericColumns.length === 0) {
    return <EmptyStatePanel message="QQプロットには1つ以上の数値変数が必要です。上部の変数セレクタから追加してください。" />
  }

  return (
    <div
      data-testid="qqplot-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: focused ? 0 : 12,
        height: focused ? '100%' : undefined,
        flex: focused ? 1 : 'none',
        minHeight: focused ? 0 : undefined,
      }}
    >
      {!focused && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, flexShrink: 0 }}>
          <Space wrap align="center">
            <Typography.Text strong>対象変数: </Typography.Text>
            <Select
              style={{ width: 180 }}
              value={selectedColumn}
              onChange={setSelectedColumn}
              options={numericColumns.map((c) => ({ label: c, value: c }))}
              data-testid="qqplot-column-select"
            />
            <FocusEnterButton targetId="qqplot" title="正規Q-Qプロット" />
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            ドラッグで矩形範囲ブラシ · 右クリックで Focus/Delete
          </Typography.Text>
        </div>
      )}

      <FocusTarget id="qqplot" title="正規Q-Qプロット">
        <div
          style={{
            display: 'flex',
            gap: focused ? 0 : 16,
            alignItems: 'stretch',
            flex: focused ? 1 : undefined,
            height: focused ? '100%' : undefined,
            minHeight: 0,
          }}
        >
          {/* Canvas Plot */}
          <Dropdown menu={{ items: contextMenuItems }} trigger={['contextMenu']} getPopupContainer={() => document.body}>
            <div
              style={{
                border: focused ? 'none' : '1px solid #e5e7eb',
                borderRadius: 6,
                background: '#ffffff',
                display: 'flex',
                flex: 1,
                width: focused ? '100%' : undefined,
                height: focused ? '100%' : undefined,
                userSelect: 'none',
                overflow: 'hidden',
                minHeight: 0,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <canvas
                ref={canvasRef}
                title={`正規Q-Qプロット: ${qqData?.column ?? ''}`}
                style={{
                  width: focused ? '100%' : width,
                  height: focused ? '100%' : height,
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  cursor: 'crosshair',
                  display: 'block',
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                data-testid="qqplot-canvas"
              />
            </div>
          </Dropdown>

          {/* Diagnostics Card */}
          {!focused && qqData && (
            <Card
              size="small"
              title="正規性診断サマリー (Normality)"
              style={{ width: 300, flexShrink: 0 }}
              loading={loading}
              data-testid="qqplot-diagnostics"
            >
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div>
                  <Typography.Text type="secondary">サンプル数: </Typography.Text>
                  <Typography.Text strong>{qqData.count}</Typography.Text>
                </div>

                <div>
                  <Typography.Text type="secondary">Shapiro-Wilk 検定: </Typography.Text>
                  <div>
                    W = {qqData.normalityTest.shapiroWilkW?.toFixed(4) ?? '—'}, p = {qqData.normalityTest.pValue?.toFixed(4) ?? '—'}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {qqData.normalityTest.isNormalAlpha05 ? (
                      <Tag color="success">正規分布 (p &ge; 0.05)</Tag>
                    ) : (
                      <Tag color="error">非正規分布 (p &lt; 0.05)</Tag>
                    )}
                  </div>
                </div>

                <div>
                  <Typography.Text type="secondary">歪度 (Skewness): </Typography.Text>
                  <Typography.Text strong>
                    {qqData.normalityTest.skewness.toFixed(3)}
                    {' '}
                    <span style={{ fontSize: 11, color: '#888' }}>
                      {qqData.normalityTest.skewness > 0.5 ? '(右に裾が長い)' : qqData.normalityTest.skewness < -0.5 ? '(左に裾が長い)' : '(対称に近い)'}
                    </span>
                  </Typography.Text>
                </div>

                <div>
                  <Typography.Text type="secondary">尖度 (Kurtosis): </Typography.Text>
                  <Typography.Text strong>
                    {qqData.normalityTest.kurtosis.toFixed(3)}
                    {' '}
                    <span style={{ fontSize: 11, color: '#888' }}>
                      {qqData.normalityTest.kurtosis > 0.5 ? '(尖鋭・重裾)' : qqData.normalityTest.kurtosis < -0.5 ? '(平坦・軽裾)' : '(正規に近い)'}
                    </span>
                  </Typography.Text>
                </div>

                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #e8e8e8' }}>
                  <Typography.Text type="secondary">Q1-Q3 頑健基準線: </Typography.Text>
                  <div style={{ fontSize: 11 }}>
                    Slope: {qqData.referenceLine.slope.toFixed(3)} (標準偏差近似)
                  </div>
                </div>
              </Space>
            </Card>
          )}
        </div>
      </FocusTarget>
    </div>
  )
}
