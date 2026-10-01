import EChartSurface from '../charts/EChartSurface'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Button, Dropdown, Radio, Slider, Space, Spin, Switch, Tag, Typography } from 'antd'
import { DotChartOutlined, FilterOutlined } from '@ant-design/icons'
import type { RootState } from '../../app/store'
import { selectOrdinaryVariables } from '../../app/store'
import { selectionApplied, selectionCleared, focusSelected, deleteSelected, resetWorkingSet } from '../../app/store'
import { api } from '../../api/client'
import { useBrushOp } from '../selection/SelectionMenu'
import GraphPanel, { useGraphPopupContainer } from '../common/GraphPanel'
import { useRowColorResolver } from '../../theme/useRowColor'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { getSvgPoint } from '../../utils/svgCoordinates'

interface LoessPoint {
  id: string
  x: number
  y: number
  fitted: number
  residual: number
  isOutlier: boolean
}

interface LoessCurvePoint {
  x: number
  fitted: number
  ciLower: number
  ciUpper: number
}

interface LoessResponse {
  xCol: string
  yCol: string
  span: number
  degree: number
  rSquared: number
  residualStd: number
  outlierCount: number
  outlierRowIds: string[]
  points: LoessPoint[]
  curve: LoessCurvePoint[]
  xRange: [number, number]
  yRange: [number, number]
}

export default function LoessPlotPage() {
  const graphPopupContainer = useGraphPopupContainer('loess/main')
  const dispatch = useDispatch()
  const datasetId = useSelector((s: RootState) => s.selection.datasetId)
  const activeRowIds = useSelector((s: RootState) => s.selection.activeRowIds)
  const selectedRowIds = useSelector((s: RootState) => s.selection.selectedRowIds)
  const data = useColumnarData(datasetId)
  const { getColor } = useRowColorResolver()
  const [brushOp] = useBrushOp()

  const [xCol, setXCol] = useState<string>('')
  const [yCol, setYCol] = useState<string>('')
  const [span, setSpan] = useState<number>(0.5)
  const [degree, setDegree] = useState<number>(1)
  const [showCi, setShowCi] = useState<boolean>(true)

  const [loading, setLoading] = useState(false)
  const [loessData, setLoessData] = useState<LoessResponse | null>(null)
  const [hoveredPt, setHoveredPt] = useState<LoessPoint | null>(null)

  // Drag box selection
  const [drag, setDrag] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const globalVars = useSelector(selectOrdinaryVariables)
  const numericColumns = useMemo(
    () => (data ? data.schema.filter((c) => c.semanticType === 'numeric' && globalVars.activeVariableIds.includes(c.name)).map((c) => c.name) : []),
    [data, globalVars.activeVariableIds],
  )

  useEffect(() => {
    if (xCol && !numericColumns.includes(xCol)) setXCol('')
    if (yCol && !numericColumns.includes(yCol)) setYCol('')
  }, [numericColumns, xCol, yCol])

  useEffect(() => {
    if (numericColumns.length >= 2 && (!xCol || !yCol)) {
      setXCol(numericColumns[0])
      setYCol(numericColumns[1])
    }
  }, [numericColumns, xCol, yCol])

  const fetchLoess = useCallback(async () => {
    if (!datasetId || !xCol || !yCol) return
    setLoading(true)
    try {
      const res = await api.post<LoessResponse>('/regression/loess', {
        datasetId,
        xCol,
        yCol,
        span,
        degree,
        nPoints: 80,
        rowIds: activeRowIds,
      })
      setLoessData(res)
    } catch (err) {
      console.error('Failed to fetch LOESS', err)
    } finally {
      setLoading(false)
    }
  }, [datasetId, xCol, yCol, span, degree, activeRowIds])

  useEffect(() => {
    void fetchLoess()
  }, [fetchLoess])

  const selectedSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds])

  // Context menu
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

  // Layout metrics
  const MARGIN_LEFT = 166
  const MARGIN_RIGHT = 40
  const MARGIN_TOP = 30
  const MARGIN_BOTTOM = 60
  const PLOT_WIDTH = 680
  const PLOT_HEIGHT = 440
  const totalSvgWidth = MARGIN_LEFT + PLOT_WIDTH + MARGIN_RIGHT
  const totalSvgHeight = MARGIN_TOP + PLOT_HEIGHT + MARGIN_BOTTOM

  // Scales
  const scales = useMemo(() => {
    if (!loessData) return null
    const xMin = loessData.xRange[0]
    const xMax = loessData.xRange[1]
    const xSpan = xMax - xMin || 1

    let yMin = loessData.yRange[0]
    let yMax = loessData.yRange[1]
    if (showCi) {
      for (const pt of loessData.curve) {
        if (pt.ciLower < yMin) yMin = pt.ciLower
        if (pt.ciUpper > yMax) yMax = pt.ciUpper
      }
    }
    const ySpan = yMax - yMin || 1

    const getSvgX = (vx: number) => MARGIN_LEFT + ((vx - xMin) / xSpan) * PLOT_WIDTH
    const getSvgY = (vy: number) => MARGIN_TOP + (1 - (vy - yMin) / ySpan) * PLOT_HEIGHT
    const getValX = (sx: number) => xMin + ((sx - MARGIN_LEFT) / PLOT_WIDTH) * xSpan
    const getValY = (sy: number) => yMin + (1 - (sy - MARGIN_TOP) / PLOT_HEIGHT) * ySpan

    return { xMin, xMax, yMin, yMax, getSvgX, getSvgY, getValX, getValY }
  }, [loessData, showCi])

  useEffect(() => setDrag(null), [loessData, scales, datasetId])

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return
    const pt = getSvgPoint(svgRef.current, e, { width: totalSvgWidth, height: totalSvgHeight })
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return
    setDrag({ x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y })
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drag || !svgRef.current) return
    const pt = getSvgPoint(svgRef.current, e, { width: totalSvgWidth, height: totalSvgHeight })
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return
    const x = Math.max(MARGIN_LEFT, Math.min(MARGIN_LEFT + PLOT_WIDTH, pt.x))
    const y = Math.max(MARGIN_TOP, Math.min(MARGIN_TOP + PLOT_HEIGHT, pt.y))
    setDrag((prev) => (prev ? { ...prev, x2: x, y2: y } : null))
  }

  const handleMouseUp = () => {
    if (!drag || !scales || !loessData) {
      setDrag(null)
      return
    }

    const minSx = Math.min(drag.x1, drag.x2)
    const maxSx = Math.max(drag.x1, drag.x2)
    const minSy = Math.min(drag.y1, drag.y2)
    const maxSy = Math.max(drag.y1, drag.y2)

    if (maxSx - minSx > 4 && maxSy - minSy > 4) {
      const minValX = scales.getValX(minSx)
      const maxValX = scales.getValX(maxSx)
      const minValY = scales.getValY(maxSy)
      const maxValY = scales.getValY(minSy)

      const matched: string[] = []
      for (const pt of loessData.points) {
        if (pt.x >= minValX && pt.x <= maxValX && pt.y >= minValY && pt.y <= maxValY) {
          matched.push(pt.id)
        }
      }
      dispatch(selectionApplied({ rowIds: matched, operation: brushOp, label: 'LOESS-Brush' }))
    }

    setDrag(null)
  }

  return (
    <div
      data-testid="loess-page"
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
              <DotChartOutlined style={{ marginRight: 6, color: '#2a78d6' }} />
              Loess 平滑化付き散布図 (Loess Curve Fitting)
            </Typography.Text>

            <Space size={6}>
              <span style={{ fontSize: 13, color: '#4b5563' }}>X軸:</span>
              <Select
                data-testid="loess-x-select"
                style={{ width: 140 }}
                value={xCol}
                onChange={setXCol}
                options={numericColumns.map((c) => ({ label: c, value: c }))}
                size="small"
              />
            </Space>

            <Space size={6}>
              <span style={{ fontSize: 13, color: '#4b5563' }}>Y軸:</span>
              <Select
                data-testid="loess-y-select"
                style={{ width: 140 }}
                value={yCol}
                onChange={setYCol}
                options={numericColumns.map((c) => ({ label: c, value: c }))}
                size="small"
              />
            </Space>

            <Space size={6}>
              <span style={{ fontSize: 13, color: '#4b5563' }}>平滑度 (Span):</span>
              <Slider
                min={0.1}
                max={1.0}
                step={0.05}
                value={span}
                onChange={setSpan}
                style={{ width: 100, margin: '0 6px' }}
              />
              <span style={{ fontSize: 12, color: '#6b7280', width: 28 }}>{span.toFixed(2)}</span>
            </Space>

            <Radio.Group
              value={degree}
              onChange={(e) => setDegree(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              size="small"
            >
              <Radio.Button value={1}>1次 (線形)</Radio.Button>
              <Radio.Button value={2}>2次 (多項式)</Radio.Button>
            </Radio.Group>

            <Space size={4}>
              <Switch checked={showCi} onChange={setShowCi} size="small" />
              <span style={{ fontSize: 12, color: '#4b5563' }}>95%信頼帯</span>
            </Space>

            <Button
              data-testid="loess-select-outliers"
              size="small"
              icon={<FilterOutlined />}
              onClick={() => {
                if (loessData && loessData.outlierRowIds.length > 0) {
                  dispatch(selectionApplied({ rowIds: loessData.outlierRowIds, operation: brushOp, label: 'LOESS-Outliers' }))
                }
              }}
            >
              外れ値選択 ({loessData ? loessData.outlierCount : 0})
            </Button>
          </Space>

          <Space size={12}>
          </Space>
        </div>

      {/* Main Plot Card */}
      <GraphPanel
        graphId="loess/main"
        title="Loess 平滑化付き散布図"
        available={Boolean(!loading && loessData)}
        sizing="intrinsic"
        intrinsicSize={{ width: totalSvgWidth, height: totalSvgHeight }}
        controls={loessData ? (
          <Space wrap size={10}>
            <Tag color="blue">R²: {loessData.rSquared}</Tag>
            <Tag color="cyan">残差標準偏差 σ: {loessData.residualStd}</Tag>
            <Tag color={loessData.outlierCount > 0 ? 'volcano' : 'default'}>
              外れ値 (|e| &gt; 2.5σ): {loessData.outlierCount}点
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              矩形ドラッグで範囲選択・点クリックでトグル
            </Typography.Text>
          </Space>
        ) : undefined}
      >
        <Dropdown menu={{ items: contextMenuItems, onClick: ({ key }) => onContextMenuClick(key) }} trigger={['contextMenu']} getPopupContainer={graphPopupContainer}>
          <div
            style={{
              position: 'relative',
              width: totalSvgWidth,
              height: totalSvgHeight,
              outline: '1px solid #e5e7eb',
              outlineOffset: -1,
              borderRadius: 6,
              background: '#ffffff',
              userSelect: 'none',
            }}
          >
            {loading && (
              <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 10 }}>
                <Spin tip="Loess平滑化曲線を計算中..." />
              </div>
            )}

            {!loading && loessData && scales && (
              <EChartSurface
                onViewportChange={() => setDrag(null)}
                ref={svgRef}
                data-testid="loess-svg"
                viewBox={`0 0 ${totalSvgWidth} ${totalSvgHeight}`}
                width={totalSvgWidth}
                height={totalSvgHeight}
                style={{ cursor: 'crosshair', display: 'block', width: totalSvgWidth, height: totalSvgHeight }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
              >
                {/* Axes and Grid */}
                <rect
                  x={MARGIN_LEFT}
                  y={MARGIN_TOP}
                  width={PLOT_WIDTH}
                  height={PLOT_HEIGHT}
                  fill="#fafafa"
                  stroke="#e5e7eb"
                  strokeWidth={1}
                />

                {/* X and Y Grid Lines */}
                {[0, 0.25, 0.5, 0.75, 1.0].map((f) => {
                  const gx = MARGIN_LEFT + f * PLOT_WIDTH
                  const gy = MARGIN_TOP + f * PLOT_HEIGHT
                  const xVal = scales.xMin + f * (scales.xMax - scales.xMin)
                  const yVal = scales.yMax - f * (scales.yMax - scales.yMin)

                  return (
                    <g key={f}>
                      <line x1={gx} y1={MARGIN_TOP} x2={gx} y2={MARGIN_TOP + PLOT_HEIGHT} stroke="#f0f0f0" strokeWidth={1} />
                      <line x1={MARGIN_LEFT} y1={gy} x2={MARGIN_LEFT + PLOT_WIDTH} y2={gy} stroke="#f0f0f0" strokeWidth={1} />
                      <text x={gx} y={MARGIN_TOP + PLOT_HEIGHT + 18} textAnchor="middle" style={{ fontSize: 10, fill: '#6b7280' }}>
                        {xVal.toFixed(1)}
                      </text>
                      <text x={MARGIN_LEFT - 8} y={gy + 4} textAnchor="end" style={{ fontSize: 10, fill: '#6b7280' }}>
                        {yVal.toFixed(1)}
                      </text>
                    </g>
                  )
                })}

                {/* 95% Confidence Band Polygon */}
                {showCi && loessData.curve.length > 1 && (
                  (() => {
                    const upperPts = loessData.curve.map((p) => `${scales.getSvgX(p.x).toFixed(1)},${scales.getSvgY(p.ciUpper).toFixed(1)}`)
                    const lowerPts = [...loessData.curve].reverse().map((p) => `${scales.getSvgX(p.x).toFixed(1)},${scales.getSvgY(p.ciLower).toFixed(1)}`)
                    const polyD = `M ${upperPts.join(' L ')} L ${lowerPts.join(' L ')} Z`
                    return <path d={polyD} fill="rgba(42, 120, 214, 0.14)" />
                  })()
                )}

                {/* Loess Fitted Line */}
                {loessData.curve.length > 1 && (
                  (() => {
                    const lineD = loessData.curve
                      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${scales.getSvgX(p.x).toFixed(1)} ${scales.getSvgY(p.fitted).toFixed(1)}`)
                      .join(' ')
                    return <path d={lineD} fill="none" stroke="#2a78d6" strokeWidth={2.5} strokeLinecap="round" />
                  })()
                )}

                {/* Data Points */}
                {loessData.points.map((pt) => {
                  const cx = scales.getSvgX(pt.x)
                  const cy = scales.getSvgY(pt.y)
                  const isSelected = selectedSet.has(pt.id)
                  const ptColor = getColor(pt.id)

                  return (
                    <g key={pt.id}>
                      {pt.isOutlier && (
                        <circle cx={cx} cy={cy} r={6.5} fill="none" stroke="#ef4444" strokeWidth={1.5} opacity={0.7} />
                      )}
                      <circle
                        cx={cx}
                        cy={cy}
                        r={isSelected ? 5.0 : 3.5}
                        fill={isSelected ? '#2a78d6' : ptColor}
                        stroke={isSelected ? '#ffffff' : 'rgba(0,0,0,0.25)'}
                        strokeWidth={isSelected ? 1.5 : 0.5}
                        opacity={isSelected ? 1 : 0.7}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredPt(pt)}
                        onMouseLeave={() => setHoveredPt(null)}
                        onClick={(e) => {
                          e.stopPropagation()
                          dispatch(selectionApplied({ rowIds: [pt.id], operation: brushOp, label: 'LOESS-Point' }))
                        }}
                      />
                    </g>
                  )
                })}

                {/* Axis Labels */}
                <ColumnQuestionTooltip nameOrId={xCol} svg><text
                  data-label-width={PLOT_WIDTH}
                  data-label-lines={2}
                  x={MARGIN_LEFT + PLOT_WIDTH / 2}
                  y={MARGIN_TOP + PLOT_HEIGHT + 56}
                  textAnchor="middle"
                  style={{ fontSize: 12, fontWeight: 600, fill: '#374151' }}
                >

                  {xCol}
                </text></ColumnQuestionTooltip>
                <ColumnQuestionTooltip nameOrId={yCol} svg><text
                  data-label-width={MARGIN_LEFT - 58}
                  data-label-lines={3}
                  x={8}
                  y={MARGIN_TOP + PLOT_HEIGHT / 2}
                  textAnchor="start"
                  dominantBaseline="middle"
                  style={{ fontSize: 12, fontWeight: 600, fill: '#374151' }}
                >

                  {yCol}
                </text></ColumnQuestionTooltip>

                {/* Drag Box Selection Overlay */}
                {drag && (
                  <rect
                    x={Math.min(drag.x1, drag.x2)}
                    y={Math.min(drag.y1, drag.y2)}
                    width={Math.abs(drag.x2 - drag.x1)}
                    height={Math.abs(drag.y2 - drag.y1)}
                    fill="rgba(42, 120, 214, 0.15)"
                    stroke="#2a78d6"
                    strokeWidth={1.5}
                    strokeDasharray="4,2"
                    pointerEvents="none"
                  />
                )}

                {/* Hover Tooltip Overlay */}
                {hoveredPt && (
                  <g transform={`translate(${MARGIN_LEFT + 15}, ${MARGIN_TOP + 20})`}>
                    <rect x={-6} y={-14} width={380} height={22} rx={4} fill="#1e293b" opacity={0.88} />
                    <text x={0} y={1} style={{ fontSize: 11, fill: '#ffffff' }}>
                      ID: {hoveredPt.id} | X: {hoveredPt.x.toFixed(2)} | Y: {hoveredPt.y.toFixed(2)} | Fitted: {hoveredPt.fitted.toFixed(2)} | 残差: {hoveredPt.residual.toFixed(3)}
                    </text>
                  </g>
                )}
              </EChartSurface>
            )}

            {!loading && (!loessData || !scales) && (
              <div style={{ textAlign: 'center', padding: '60px 0', color: '#9ca3af' }}>
                有効な2つの数値列を選択してください。
              </div>
            )}
          </div>
        </Dropdown>
      </GraphPanel>

      {/* Guide Note */}
        <div style={{ color: '#6b7280', fontSize: 12, padding: '0 4px' }}>
          ※ 局所重み付き多項式回帰（LOWESS / LOESS）により、2変数間の非線形トレンドと95%信頼帯を算出します。ドラッグによる点選択のほか、「外れ値選択」ボタンで回帰曲線から2.5σ以上乖離した特異点を即座に抽出しPCPへ連動できます。
        </div>
    </div>
  )
}
