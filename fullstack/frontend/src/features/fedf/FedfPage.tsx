import EChartSurface from '../charts/EChartSurface'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Dropdown, Radio, Space, Spin, Typography } from 'antd'
import { LineChartOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectOrdinaryVariables } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { api } from '../../api/client'
import { useBrushOp } from '../selection/SelectionMenu'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import { useRowColorResolver } from '../../theme/useRowColor'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { truncateText } from '../../utils/textUtils'

interface FedfCurvePoint {
  quantile: number
  val: number
  folded: number
}

interface FedfProfile {
  curve: FedfCurvePoint[]
  minVal: number
  maxVal: number
}

interface FedfStat {
  min: number
  q25: number
  median: number
  q75: number
  max: number
  iqr: number
  mean: number
  std: number
  validCount: number
}

interface FedfResponse {
  columns: string[]
  profiles: Record<string, FedfProfile>
  rowCoords: Record<string, Record<string, { val: number; quantile: number; folded: number; rank: number }>>
  statistics: Record<string, FedfStat>
  totalRows: number
  mode: string
}

export default function FedfPage() {
  const graphPopupContainer = useGraphPopupContainer('fedf/main')
  const questionText = useQuestionText()
  const dispatch = useDispatch()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const activeRowIds = useSelector((s: RootState) => s.selection.activeRowIds)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)
  const data = useColumnarData(datasetId)
  const { getColor } = useRowColorResolver()
  const [brushOp] = useBrushOp()

  const [mode, setMode] = useState<'standard' | 'folded'>('standard')
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [fedfData, setFedfData] = useState<FedfResponse | null>(null)
  const [hoveredPoint, setHoveredPoint] = useState<{ col: string; id: string; val: number; q: number } | null>(null)

  // Drag brushing state per axis
  const [dragAxis, setDragAxis] = useState<string | null>(null)
  const [dragRange, setDragRange] = useState<{ y1: number; y2: number } | null>(null)
  useEffect(() => { setDragAxis(null); setDragRange(null) }, [fedfData, datasetId, mode])
  const svgRef = useRef<SVGSVGElement>(null)
  const graphHostRef = useRef<HTMLDivElement>(null)
  const [graphHostWidth, setGraphHostWidth] = useState(0)

  const globalVars = useSelector(selectOrdinaryVariables)
  // Numeric column list (follows the global active variables)
  const allNumericColumns = useMemo(
    () => (data ? data.schema.filter((c) => c.semanticType === 'numeric').map((c) => c.name) : []),
    [data],
  )
  const numericColumns = useMemo(
    () => allNumericColumns.filter((name) => globalVars.activeVariableIds.includes(name)),
    [allNumericColumns, globalVars.activeVariableIds],
  )

  useEffect(() => {
    setSelectedColumns((prev) => prev.filter((name) => numericColumns.includes(name)))
  }, [numericColumns])

  useEffect(() => {
    if (numericColumns.length > 0 && selectedColumns.length === 0) {
      setSelectedColumns(numericColumns.slice(0, 5))
    }
  }, [numericColumns, selectedColumns.length])

  const fetchFedf = useCallback(async () => {
    if (!datasetId || selectedColumns.length === 0) return
    setLoading(true)
    try {
      const res = await api.post<FedfResponse>('/distribution/fedf', {
        datasetId,
        columns: selectedColumns,
        mode,
        rowIds: activeRowIds,
      })
      setFedfData(res)
    } catch (err) {
      console.error('Failed to fetch FEDF', err)
    } finally {
      setLoading(false)
    }
  }, [datasetId, selectedColumns, mode, activeRowIds])

  useEffect(() => {
    void fetchFedf()
  }, [fetchFedf])

  // Presets
  const applyQuantilePreset = (col: string, qMin: number, qMax: number) => {
    if (!fedfData) return
    const matched: string[] = []
    for (const [rid, cols] of Object.entries(fedfData.rowCoords)) {
      const c = cols[col]
      if (c && c.quantile >= qMin && c.quantile <= qMax) {
        matched.push(rid)
      }
    }
    dispatch(selectionApplied({ rowIds: matched, operation: brushOp, label: 'FEDF-Preset' }))
  }

  // Right-click context menu
  const contextMenuItems = [
    { key: 'focus', label: '選択に絞り込み', disabled: selectedRowIds.length === 0 },
    { key: 'delete', label: '選択を削除', disabled: selectedRowIds.length === 0 },
    { key: 'clear', label: '選択解除', disabled: selectedRowIds.length === 0 },
    { type: 'divider' as const },
    { key: 'reset', label: 'ベースデータに戻す' },
  ]

  const onContextMenuClick = (key: string) => {
    if (key === 'focus') dispatch(focusSelected())
    else if (key === 'delete') dispatch(deleteSelected())
    else if (key === 'clear') dispatch(selectionCleared())
    else if (key === 'reset') dispatch(resetWorkingSet())
  }

  // Layout calculations
  const AXIS_WIDTH = 120
  const AXIS_SPACING = selectedColumns.length <= 4 ? 190 : selectedColumns.length === 5 ? 155 : 150
  const PLOT_TOP = 70
  const PLOT_HEIGHT = 440
  const MARGIN_LEFT = 70
  const totalWidth = MARGIN_LEFT + (selectedColumns.length) * AXIS_SPACING + 30
  const totalHeight = PLOT_TOP + PLOT_HEIGHT + 70
  const displayWidth = Math.max(totalWidth, graphHostWidth)
  const displayHeight = Math.round(totalHeight * displayWidth / totalWidth)

  // 描画面の外側だけを計測する。surface/scrollbar の幅を再入力にしないので、
  // 横幅に合わせても ResizeObserver とスクロールバーが相互に揺れない。
  useEffect(() => {
    const host = graphHostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const updateWidth = (width: number) => {
      const next = Math.floor(width)
      if (next > 0) setGraphHostWidth((previous) => previous === next ? previous : next)
    }
    const observer = new ResizeObserver((entries) => updateWidth(entries[0]?.contentRect.width ?? 0))
    observer.observe(host)
    updateWidth(host.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  const svgLogicalY = (clientY: number): number => {
    const svg = svgRef.current
    if (!svg) return NaN
    const rect = svg.getBoundingClientRect()
    if (!rect.height || !totalHeight) return NaN
    return ((clientY - rect.top) / rect.height) * totalHeight
  }

  const handleMouseDown = (col: string, e: React.MouseEvent<SVGRectElement>) => {
    if (!svgRef.current) return
    const y = svgLogicalY(e.clientY)
    if (!Number.isFinite(y)) return
    setDragAxis(col)
    setDragRange({ y1: y, y2: y })
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragAxis || !dragRange || !svgRef.current) return
    const yRaw = svgLogicalY(e.clientY)
    if (!Number.isFinite(yRaw)) return
    const y = Math.max(PLOT_TOP, Math.min(PLOT_TOP + PLOT_HEIGHT, yRaw))
    setDragRange((prev) => (prev ? { ...prev, y2: y } : null))
  }

  const handleMouseUp = () => {
    if (!dragAxis || !dragRange || !fedfData) {
      setDragAxis(null)
      setDragRange(null)
      return
    }

    const stat = fedfData.statistics[dragAxis]
    if (stat) {
      const minY = Math.min(dragRange.y1, dragRange.y2)
      const maxY = Math.max(dragRange.y1, dragRange.y2)

      // Convert Y range to Value range
      // y = PLOT_TOP + (1 - (val - min) / (max - min)) * PLOT_HEIGHT
      const rangeValMax = stat.min + (1 - (minY - PLOT_TOP) / PLOT_HEIGHT) * (stat.max - stat.min)
      const rangeValMin = stat.min + (1 - (maxY - PLOT_TOP) / PLOT_HEIGHT) * (stat.max - stat.min)

      const matched: string[] = []
      for (const [rid, cols] of Object.entries(fedfData.rowCoords)) {
        const c = cols[dragAxis]
        if (c && c.val >= rangeValMin && c.val <= rangeValMax) {
          matched.push(rid)
        }
      }
      dispatch(selectionApplied({ rowIds: matched, operation: brushOp, label: 'FEDF-Brush' }))
    }

    setDragAxis(null)
    setDragRange(null)
  }

  const selectedSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds])

  return (
    <div
      data-testid="fedf-page"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}
    >
      {/* Top Controls Card */}
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: '#ffffff',
            padding: '10px 16px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <Space wrap size={16}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              <LineChartOutlined style={{ marginRight: 6, color: '#2a78d6' }} />
              平行FEDFプロット (Parallel FEDF)
            </Typography.Text>

            <Radio.Group
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value="standard" data-testid="fedf-mode-standard">累積分位点 (0%〜100%)</Radio.Button>
              <Radio.Button value="folded" data-testid="fedf-mode-folded">Mountain折返し (中央値対称)</Radio.Button>
            </Radio.Group>

            <Select
              mode="multiple"
              style={{ minWidth: 260 }}
              placeholder="表示する数値列を選択"
              value={selectedColumns}
              onChange={setSelectedColumns}
              options={numericColumns.map((c) => ({ label: c, value: c }))}
              maxTagCount={4}
              size="small"
            />
          </Space>

          <Space size={12}>
          </Space>
        </div>

      {/* Main Visualization Card */}
      <div ref={graphHostRef} style={{ width: '100%', minWidth: 0 }}>
        <GraphPanel
          graphId="fedf/main"
          title="平行FEDFプロット"
          available={Boolean(!loading && fedfData)}
          sizing="intrinsic"
          intrinsicSize={{ width: displayWidth, height: displayHeight }}
        >
          <Dropdown menu={{ items: contextMenuItems, onClick: ({ key }) => onContextMenuClick(key) }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
            <div
              style={{
                position: 'relative',
                width: displayWidth,
                height: displayHeight,
                outline: '1px solid #e5e7eb',
                outlineOffset: -1,
                borderRadius: 6,
                background: '#ffffff',
                userSelect: 'none',
              }}
            >
            {loading && (
              <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10 }}>
                <Spin tip="FEDF曲線を計算中..." />
              </div>
            )}

            {!loading && fedfData && (
              <EChartSurface
                onViewportChange={() => { setDragAxis(null); setDragRange(null) }}
                ref={svgRef}
                data-testid="fedf-svg"
                width={displayWidth}
                height={displayHeight}
                viewBox={`0 0 ${totalWidth} ${totalHeight}`}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                style={{ cursor: dragAxis ? 'ns-resize' : 'crosshair', display: 'block', width: displayWidth, height: displayHeight }}
              >
                {/* Axis definitions */}
                {fedfData.columns.map((col, idx) => {
                  const xBase = MARGIN_LEFT + idx * AXIS_SPACING
                  const profile = fedfData.profiles[col]
                  const stat = fedfData.statistics[col]
                  if (!profile || !stat) return null

                  const valSpan = stat.max - stat.min || 1
                  const getY = (val: number) => PLOT_TOP + (1 - (val - stat.min) / valSpan) * PLOT_HEIGHT

                  // Build SVG path for FEDF curve
                  const pathParts = profile.curve.map((pt, pIdx) => {
                    const qX = mode === 'standard' ? pt.quantile : pt.folded
                    const px = xBase + qX * AXIS_WIDTH
                    const py = getY(pt.val)
                    return `${pIdx === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`
                  })
                  const curvePath = pathParts.join(' ')

                  // Shaded area path (down to axis)
                  const areaPath = `${curvePath} L ${xBase} ${getY(stat.max)} L ${xBase} ${getY(stat.min)} Z`

                  return (
                    <g key={col} data-testid={`fedf-axis-${idx}`}>
                      {/* Column Title and Presets */}
                      <ColumnQuestionTooltip nameOrId={col} svg><text
                        x={xBase + AXIS_WIDTH / 2}
                        y={PLOT_TOP - 40}
                        textAnchor="middle"
                        style={{ fontSize: 12, fontWeight: 600, fill: '#374151' }}
                      >

                        {truncateText(col, 14)}
                      </text></ColumnQuestionTooltip>

                      {/* Quick Quantile Presets */}
                      <g transform={`translate(${xBase - 15}, ${PLOT_TOP - 16})`}>
                        <text
                          className="fedf-preset-btn"
                          x={0}
                          y={0}
                          style={{ fontSize: 10, fill: '#2a78d6', cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => applyQuantilePreset(col, 0.25, 0.75)}
                          data-testid="fedf-select-iqr"
                        >
                          [IQR 25-75%]
                        </text>
                        <text
                          className="fedf-preset-btn"
                          x={75}
                          y={0}
                          style={{ fontSize: 10, fill: '#6b7280', cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => applyQuantilePreset(col, 0.95, 1.0)}
                        >
                          [Top 5%]
                        </text>
                        <text
                          className="fedf-preset-btn"
                          x={125}
                          y={0}
                          style={{ fontSize: 10, fill: '#6b7280', cursor: 'pointer', userSelect: 'none' }}
                          onClick={() => applyQuantilePreset(col, 0.0, 0.05)}
                        >
                          [Bottom 5%]
                        </text>
                      </g>

                      {/* Shaded Area Under FEDF Curve */}
                      <path d={areaPath} fill="rgba(42, 120, 214, 0.08)" />

                      {/* FEDF Curve Line */}
                      <path d={curvePath} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinecap="round" />

                      {/* Vertical Spine Line */}
                      <line
                        x1={xBase}
                        y1={PLOT_TOP}
                        x2={xBase}
                        y2={PLOT_TOP + PLOT_HEIGHT}
                        stroke="#9ca3af"
                        strokeWidth={1.5}
                      />

                      {/* Quantile Reference Lines (Q25, Median, Q75) */}
                      <line
                        x1={xBase}
                        y1={getY(stat.median)}
                        x2={xBase + (mode === 'standard' ? 0.5 : 1.0) * AXIS_WIDTH}
                        y2={getY(stat.median)}
                        stroke="#ef4444"
                        strokeWidth={1.5}
                        strokeDasharray="3,3"
                      />
                      <text
                        x={xBase - 8}
                        y={getY(stat.median) + 3}
                        textAnchor="end"
                        style={{ fontSize: 10, fill: '#ef4444', fontWeight: 600 }}
                      >
                        Med: {stat.median.toFixed(2)}
                      </text>

                      {/* Min / Max labels */}
                      <text x={xBase - 8} y={PLOT_TOP + 4} textAnchor="end" style={{ fontSize: 10, fill: '#6b7280' }}>
                        {stat.max.toFixed(2)}
                      </text>
                      <text
                        x={xBase - 8}
                        y={PLOT_TOP + PLOT_HEIGHT}
                        textAnchor="end"
                        style={{ fontSize: 10, fill: '#6b7280' }}
                      >
                        {stat.min.toFixed(2)}
                      </text>

                      {/* Horizontal Quantile Scale Hairline */}
                      <line
                        x1={xBase}
                        y1={PLOT_TOP + PLOT_HEIGHT + 15}
                        x2={xBase + AXIS_WIDTH}
                        y2={PLOT_TOP + PLOT_HEIGHT + 15}
                        stroke="#d1d5db"
                        strokeWidth={1}
                      />
                      <text
                        x={xBase}
                        y={PLOT_TOP + PLOT_HEIGHT + 28}
                        textAnchor="start"
                        style={{ fontSize: 10, fill: '#9ca3af' }}
                      >
                        0%
                      </text>
                      <text
                        x={xBase + (mode === 'standard' ? AXIS_WIDTH / 2 : AXIS_WIDTH)}
                        y={PLOT_TOP + PLOT_HEIGHT + 28}
                        textAnchor="middle"
                        style={{ fontSize: 10, fill: mode === 'standard' ? '#9ca3af' : '#ef4444', fontWeight: mode === 'folded' ? 600 : 400 }}
                      >
                        {mode === 'standard' ? '50%' : '100% (Median)'}
                      </text>
                      <text
                        x={xBase + AXIS_WIDTH}
                        y={PLOT_TOP + PLOT_HEIGHT + 28}
                        textAnchor="end"
                        style={{ fontSize: 10, fill: '#9ca3af' }}
                      >
                        {mode === 'standard' ? '100%' : '0%'}
                      </text>

                      {/* Individual Data Points */}
                      {Object.entries(fedfData.rowCoords).map(([rid, rowColMap]) => {
                        const coord = rowColMap[col]
                        if (!coord) return null
                        const qVal = mode === 'standard' ? coord.quantile : coord.folded
                        const cx = xBase + qVal * AXIS_WIDTH
                        const cy = getY(coord.val)
                        const isSelected = selectedSet.has(rid)
                        const ptColor = getColor(rid)

                        return (
                          <circle
                            key={rid}
                            cx={cx}
                            cy={cy}
                            r={isSelected ? 5.0 : 3.0}
                            fill={isSelected ? '#2a78d6' : ptColor}
                            stroke={isSelected ? '#ffffff' : 'rgba(0,0,0,0.2)'}
                            strokeWidth={isSelected ? 1.5 : 0.5}
                            opacity={isSelected ? 1 : 0.65}
                            style={{ cursor: 'pointer' }}
                            onMouseEnter={() => setHoveredPoint({ col, id: rid, val: coord.val, q: coord.quantile })}
                            onMouseLeave={() => setHoveredPoint(null)}
                            onClick={() => dispatch(selectionApplied({ rowIds: [rid], operation: brushOp, label: 'FEDF-Point' }))}
                          />
                        )
                      })}

                      {/* Drag overlay on this axis */}
                      <rect
                        x={xBase - 15}
                        y={PLOT_TOP}
                        width={AXIS_WIDTH + 30}
                        height={PLOT_HEIGHT}
                        fill="transparent"
                        style={{ cursor: 'ns-resize' }}
                        onMouseDown={(e) => handleMouseDown(col, e)}
                      />

                      {/* Active Drag selection highlight box */}
                      {dragAxis === col && dragRange && (
                        <rect
                          x={xBase - 5}
                          y={Math.min(dragRange.y1, dragRange.y2)}
                          width={AXIS_WIDTH + 10}
                          height={Math.abs(dragRange.y2 - dragRange.y1)}
                          fill="rgba(42, 120, 214, 0.2)"
                          stroke="#2a78d6"
                          strokeWidth={1.5}
                          strokeDasharray="4,2"
                          pointerEvents="none"
                        />
                      )}
                    </g>
                  )
                })}

                {/* Hover Tooltip Overlay */}
                {hoveredPoint && (
                  <g transform={`translate(${MARGIN_LEFT + 20}, ${PLOT_TOP + PLOT_HEIGHT + 45})`}>
                    <rect x={-8} y={-14} width={340} height={22} rx={4} fill="#1f2937" opacity={0.85} />
                    <text x={0} y={1} style={{ fontSize: 11, fill: '#ffffff' }}>
                      ID: {hoveredPoint.id} | {questionText(hoveredPoint.col)}: {hoveredPoint.val.toFixed(3)} | 累積分位: {(hoveredPoint.q * 100).toFixed(1)}%
                    </text>
                  </g>
                )}
              </EChartSurface>
            )}

            {!loading && (!fedfData || fedfData.columns.length === 0) && (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>
                有効な数値列が選択されていません。
              </div>
            )}
            </div>
          </Dropdown>
        </GraphPanel>
      </div>

      {/* Guide Note */}
        <div style={{ color: '#6b7280', fontSize: 12, padding: '0 4px' }}>
          ※ 縦軸に変数の生値、横軸に経験累積確率（または中央値からの山型距離）を展開するFlipped Empirical Distribution Function (Huh 1995)です。軸上ドラッグで値／分位点範囲選択、プリセットボタンでIQRや外れ値の上位/下位5%を瞬時に選択しPCPへ伝播できます。
        </div>
    </div>
  )
}
