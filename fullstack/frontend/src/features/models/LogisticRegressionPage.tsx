import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Card,
  Row,
  Col,
  Select,
  Button,
  Radio,
  Checkbox,
  Slider,
  Table,
  Typography,
  Space,
  Alert,
  Spin,
  Tag,
  Divider,
  InputNumber,
  message,
} from 'antd'
import {
  ThunderboltOutlined,
  AimOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, selectEffectiveRowIds } from '../../app/store'
import { useColumnarData } from '../pcp/useDatasetColumns'
import { api } from '../../api/client'

export interface CoefficientItem {
  name: string
  coefficient: number
  stdError: number
  zValue: number
  pValue: number
  oddsRatio: number
  ciLower: number
  ciUpper: number
}

export interface SigmoidCurvePoint {
  x: number
  probability: number
}

export interface LogisticSamplePoint {
  rowId: string
  actual: number
  predictedProb: number
  predictedClass: number
  residual: number
  isMisclassified: boolean
}

export interface ConfusionMatrix {
  tn: number
  fp: number
  fn: number
  tp: number
  tnRowIds: string[]
  fpRowIds: string[]
  fnRowIds: string[]
  tpRowIds: string[]
  accuracy: number
  precision: number
  recall: number
  f1Score: number
}

export interface LogisticResponse {
  target: string
  classes: string[]
  features: string[]
  excludedRowCount: number
  coefficients: CoefficientItem[]
  fitMetrics: {
    logLikelihood: number
    nullLogLikelihood: number
    aic: number
    bic: number
    pseudoR2: number
    converged: boolean
  }
  confusionMatrix: ConfusionMatrix
  samples: LogisticSamplePoint[]
  curves: Record<string, SigmoidCurvePoint[]>
  evidenceClass: 'JAR-INITIAL'
}

export default function LogisticRegressionPage() {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector((s: RootState) => s.globalVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const data = useColumnarData(selection.datasetId)

  // Form state
  const [targetColumn, setTargetColumn] = useState<string>('')
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>([])
  const [intercept, setIntercept] = useState<boolean>(true)
  const [regularization, setRegularization] = useState<'none' | 'l2' | 'l1'>('none')
  const [cValue, setCValue] = useState<number>(1.0)
  const [cutoff, setCutoff] = useState<number>(0.5)

  // Computation result
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<LogisticResponse | null>(null)
  const [focusAxis, setFocusAxis] = useState<string>('')

  // Brush state on Sigmoid Plot
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [brushBox, setBrushBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)

  // Available columns
  const allColumns = useMemo(() => {
    if (!data?.schema) return []
    return data.schema.map((c) => c.name)
  }, [data])

  const numericColumns = useMemo(() => {
    if (!data?.schema) return []
    return data.schema.filter((c) => c.semanticType === 'numeric').map((c) => c.name)
  }, [data])

  // Initialize target and features from globalVariables
  useEffect(() => {
    if (!allColumns.length) return
    if (!targetColumn) {
      // Pick global target or first non-numeric/nominal or last column
      const defaultTarget = globalVars.targetVariableId || allColumns[allColumns.length - 1]
      setTargetColumn(defaultTarget)
    }
  }, [allColumns, globalVars.targetVariableId, targetColumn])

  useEffect(() => {
    if (!targetColumn) return
    // Default features to activeVariableIds minus target
    const candidateFeats = globalVars.activeVariableIds.filter(
      (v) => v !== targetColumn && numericColumns.includes(v)
    )
    if (candidateFeats.length > 0) {
      setSelectedFeatures(candidateFeats)
    } else {
      setSelectedFeatures(numericColumns.filter((v) => v !== targetColumn).slice(0, 4))
    }
  }, [targetColumn, globalVars.activeVariableIds, numericColumns])

  // Run model
  const handleRunModel = async () => {
    if (!selection.datasetId || !targetColumn || selectedFeatures.length === 0) {
      message.warning('目的変数と1つ以上の説明変数を選択してください。')
      return
    }
    setLoading(true)
    try {
      const res = await api.post<LogisticResponse>('/models/logistic', {
        datasetId: selection.datasetId,
        targetColumn,
        featureColumns: selectedFeatures,
        activeRowIds: effectiveRowIds.length ? effectiveRowIds : undefined,
        intercept,
        regularization,
        cValue,
        cutoff,
      })
      setResult(res)
      if (selectedFeatures.length > 0) {
        setFocusAxis(selectedFeatures[0])
      }
      message.success('ロジスティック回帰モデルを推定しました。')
    } catch (err: any) {
      message.error(err?.message || 'モデルの推定に失敗しました。')
    } finally {
      setLoading(false)
    }
  }

  // Real-time confusion matrix recalculation based on client cutoff slider
  const dynamicMetrics = useMemo(() => {
    if (!result?.samples) return null

    let tp = 0
    let tn = 0
    let fp = 0
    let fn = 0
    const tpRowIds: string[] = []
    const tnRowIds: string[] = []
    const fpRowIds: string[] = []
    const fnRowIds: string[] = []
    const misclassifiedRowIds: string[] = []

    for (const s of result.samples) {
      const pred = s.predictedProb >= cutoff ? 1 : 0
      if (s.actual === 1 && pred === 1) {
        tp++
        tpRowIds.push(s.rowId)
      } else if (s.actual === 0 && pred === 0) {
        tn++
        tnRowIds.push(s.rowId)
      } else if (s.actual === 0 && pred === 1) {
        fp++
        fpRowIds.push(s.rowId)
        misclassifiedRowIds.push(s.rowId)
      } else if (s.actual === 1 && pred === 0) {
        fn++
        fnRowIds.push(s.rowId)
        misclassifiedRowIds.push(s.rowId)
      }
    }

    const n = result.samples.length
    const accuracy = n > 0 ? (tp + tn) / n : 0
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0
    const f1Score = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0

    return {
      tp,
      tn,
      fp,
      fn,
      tpRowIds,
      tnRowIds,
      fpRowIds,
      fnRowIds,
      misclassifiedRowIds,
      accuracy,
      precision,
      recall,
      f1Score,
    }
  }, [result?.samples, cutoff])

  // Selection dispatch helpers
  const handleSelectRows = (rowIds: string[], e?: React.MouseEvent) => {
    if (!rowIds.length) return
    const op = e?.shiftKey ? 'add' : e?.altKey ? 'subtract' : 'replace'
    dispatch(selectionApplied({ rowIds, operation: op, label: 'ロジスティック回帰選択' }))
  }

  const handleSelectMisclassified = (e: React.MouseEvent) => {
    if (!dynamicMetrics?.misclassifiedRowIds.length) {
      message.info('誤分類サンプルはありません。')
      return
    }
    handleSelectRows(dynamicMetrics.misclassifiedRowIds, e)
    message.success(`誤分類 ${dynamicMetrics.misclassifiedRowIds.length} 行を選択しました。`)
  }

  // Selected row ids set for fast lookup
  const selectedRowIdSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])

  // Sigmoid chart dimensions
  const chartWidth = 480
  const chartHeight = 280
  const padding = { top: 20, right: 30, bottom: 40, left: 50 }
  const innerWidth = chartWidth - padding.left - padding.right
  const innerHeight = chartHeight - padding.top - padding.bottom

  // Prepare points and curve for Focus Axis
  const axisCurve = useMemo(() => {
    if (!result?.curves || !focusAxis) return []
    return result.curves[focusAxis] || []
  }, [result, focusAxis])

  const axisMinMax = useMemo(() => {
    if (!data || !focusAxis) return { min: 0, max: 1 }
    const arr = data.numeric[focusAxis]
    if (!arr) return { min: 0, max: 1 }
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (!isNaN(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (min === Infinity) return { min: 0, max: 1 }
    return { min, max: max === min ? min + 1 : max }
  }, [data, focusAxis])

  // Sample points with x coordinate on focusAxis
  const samplePointsWithCoord = useMemo(() => {
    if (!result?.samples || !data || !focusAxis) return []
    const arr = data.numeric[focusAxis]
    if (!arr) return []

    return result.samples.map((s) => {
      const rowIdx = data.rowIndex.get(s.rowId)
      const xVal = rowIdx !== undefined ? arr[rowIdx] : NaN
      // deterministic small jitter for visual separation
      const hash = Math.sin(Number(s.rowId.replace(/\D/g, '') || '1') * 997) * 0.04
      const yCoord = s.actual === 1 ? 1.0 - Math.abs(hash) : 0.0 + Math.abs(hash)
      return {
        ...s,
        xVal,
        jitterY: yCoord,
      }
    }).filter((p) => !isNaN(p.xVal))
  }, [result?.samples, data, focusAxis])

  // Map to SVG coordinates
  const scaleX = (val: number) => {
    const { min, max } = axisMinMax
    if (max <= min) return padding.left
    return padding.left + ((val - min) / (max - min)) * innerWidth
  }

  const scaleY = (prob: number) => {
    return padding.top + (1.0 - prob) * innerHeight
  }

  // Generate SVG path for S-curve
  const curvePath = useMemo(() => {
    if (axisCurve.length < 2) return ''
    return axisCurve
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(pt.x).toFixed(1)} ${scaleY(pt.probability).toFixed(1)}`)
      .join(' ')
  }, [axisCurve, axisMinMax])

  // Brush drag interaction
  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setBrushBox({ startX: x, startY: y, currentX: x, currentY: y })
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!brushBox) return
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setBrushBox((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null))
  }

  const handleMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!brushBox) return
    const xMin = Math.min(brushBox.startX, brushBox.currentX)
    const xMax = Math.max(brushBox.startX, brushBox.currentX)
    const yMin = Math.min(brushBox.startY, brushBox.currentY)
    const yMax = Math.max(brushBox.startY, brushBox.currentY)

    // Check if dragging was intentional (> 4px)
    if (xMax - xMin > 4 || yMax - yMin > 4) {
      const selected: string[] = []
      for (const pt of samplePointsWithCoord) {
        const px = scaleX(pt.xVal)
        const py = scaleY(pt.jitterY)
        if (px >= xMin && px <= xMax && py >= yMin && py <= yMax) {
          selected.push(pt.rowId)
        }
      }
      if (selected.length > 0) {
        handleSelectRows(selected, e)
      }
    }
    setBrushBox(null)
  }

  // Odds ratio forest plot data
  const forestData = useMemo(() => {
    if (!result?.coefficients) return []
    return result.coefficients.filter((c) => c.name !== 'Intercept')
  }, [result])

  const forestMinMax = useMemo(() => {
    if (!forestData.length) return { min: 0.1, max: 10 }
    let min = 0.5
    let max = 2.0
    for (const item of forestData) {
      if (item.ciLower > 0 && item.ciLower < min) min = item.ciLower
      if (item.ciUpper > max && item.ciUpper < 100) max = item.ciUpper
    }
    return { min: Math.max(0.01, min * 0.8), max: Math.min(100, max * 1.2) }
  }, [forestData])

  // Table columns
  const coeffColumns = [
    {
      title: '変数名 (Variable)',
      dataIndex: 'name',
      key: 'name',
      render: (text: string) => <Typography.Text strong>{text}</Typography.Text>,
    },
    {
      title: '係数 β (Coeff)',
      dataIndex: 'coefficient',
      key: 'coefficient',
      render: (v: number) => v.toFixed(4),
    },
    {
      title: '標準誤差 SE(β)',
      dataIndex: 'stdError',
      key: 'stdError',
      render: (v: number) => v.toFixed(4),
    },
    {
      title: 'Wald z',
      dataIndex: 'zValue',
      key: 'zValue',
      render: (v: number) => v.toFixed(3),
    },
    {
      title: 'p-value',
      dataIndex: 'pValue',
      key: 'pValue',
      render: (v: number) => {
        const sig = v < 0.05
        return (
          <span style={{ fontWeight: sig ? 'bold' : 'normal', color: sig ? '#cf1322' : 'inherit' }}>
            {v < 0.0001 ? '< 0.0001' : v.toFixed(4)} {v < 0.01 ? '***' : v < 0.05 ? '*' : ''}
          </span>
        )
      },
    },
    {
      title: 'オッズ比 (OR)',
      dataIndex: 'oddsRatio',
      key: 'oddsRatio',
      render: (v: number) => <Tag color={v > 1.0 ? 'blue' : 'orange'}>{v.toFixed(3)}</Tag>,
    },
    {
      title: '95% 信頼区間 (CI)',
      key: 'ci',
      render: (_: any, r: CoefficientItem) => `[${r.ciLower.toFixed(3)}, ${r.ciUpper.toFixed(3)}]`,
    },
  ]

  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto' }} data-testid="logistic-regression-page">
      {/* Control Card */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col xs={24} sm={12} md={6}>
            <Typography.Text strong>目的変数 Y (Binary Target):</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={targetColumn}
              onChange={setTargetColumn}
              options={allColumns.map((c) => ({ label: c, value: c }))}
              placeholder="目的変数を選択"
              data-testid="logistic-target-select"
            />
          </Col>

          <Col xs={24} sm={12} md={10}>
            <Typography.Text strong>説明変数 X (Features):</Typography.Text>
            <Select
              mode="multiple"
              style={{ width: '100%', marginTop: 4 }}
              value={selectedFeatures}
              onChange={setSelectedFeatures}
              options={numericColumns.filter((c) => c !== targetColumn).map((c) => ({ label: c, value: c }))}
              placeholder="説明変数を選択"
              maxTagCount={3}
              data-testid="logistic-features-select"
            />
          </Col>

          <Col xs={24} sm={12} md={4}>
            <Typography.Text strong>正則化:</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Radio.Group
                size="small"
                value={regularization}
                onChange={(e) => setRegularization(e.target.value)}
              >
                <Radio.Button value="none">None</Radio.Button>
                <Radio.Button value="l2">L2</Radio.Button>
                <Radio.Button value="l1">L1</Radio.Button>
              </Radio.Group>
            </div>
            <div style={{ marginTop: 6 }}>
              <Checkbox checked={intercept} onChange={(e) => setIntercept(e.target.checked)}>
                切片項 (Intercept)
              </Checkbox>
            </div>
          </Col>

          {regularization !== 'none' && (
            <Col xs={24} sm={12} md={4}>
              <Typography.Text strong>C値 (Inverse Penalty):</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <InputNumber
                  size="small"
                  min={0.001}
                  max={1000}
                  step={0.1}
                  value={cValue}
                  onChange={(v) => setCValue(v ?? 1.0)}
                  style={{ width: '100%' }}
                />
              </div>
            </Col>
          )}

          <Col xs={24} sm={24} md={4} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={handleRunModel}
              loading={loading}
              data-testid="run-logistic-btn"
              style={{ flex: 1 }}
            >
              モデル学習 (Run)
            </Button>
          </Col>
        </Row>

        {result && (
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Typography.Text strong>Cutoff 閾値:</Typography.Text>
              <Slider
                min={0.01}
                max={0.99}
                step={0.01}
                value={cutoff}
                onChange={setCutoff}
                style={{ width: 180 }}
                data-testid="logistic-cutoff-slider"
              />
              <Tag color="blue">{cutoff.toFixed(2)}</Tag>
            </div>

            <Button
              icon={<AimOutlined />}
              onClick={handleSelectMisclassified}
              danger
              disabled={!dynamicMetrics || dynamicMetrics.misclassifiedRowIds.length === 0}
              data-testid="select-misclassified-btn"
            >
              誤分類サンプルを一括選択 (FP+FN: {dynamicMetrics?.misclassifiedRowIds.length ?? 0})
            </Button>
          </div>
        )}

        {result && result.excludedRowCount > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`欠損値を含む ${result.excludedRowCount} 行を解析対象から除外しました。`}
            style={{ marginTop: 12 }}
          />
        )}
      </Card>

      {/* Main Content Area */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spin size="large" tip="ロジスティック回帰を計算中..." />
        </div>
      ) : result && dynamicMetrics ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* Top Row: Sigmoid Plot + Forest Plot */}
          <Row gutter={[16, 16]}>
            {/* S-curve Plot */}
            <Col xs={24} lg={12}>
              <Card
                size="small"
                title={
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>▼ 予測確率・S字シグモイド曲線</span>
                    <Space size={8}>
                      <Typography.Text style={{ fontSize: 12 }}>着目軸:</Typography.Text>
                      <Select
                        size="small"
                        value={focusAxis}
                        onChange={setFocusAxis}
                        options={selectedFeatures.map((f) => ({ label: f, value: f }))}
                        style={{ minWidth: 120 }}
                        data-testid="focus-axis-select"
                      />
                    </Space>
                  </div>
                }
              >
                <div style={{ position: 'relative', width: '100%', overflow: 'hidden' }}>
                  <svg
                    ref={svgRef}
                    width={chartWidth}
                    height={chartHeight}
                    style={{ background: '#fafafa', borderRadius: 4, cursor: 'crosshair', userSelect: 'none' }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                  >
                    {/* Axes */}
                    <line
                      x1={padding.left}
                      y1={padding.top + innerHeight}
                      x2={padding.left + innerWidth}
                      y2={padding.top + innerHeight}
                      stroke="#bfbfbf"
                    />
                    <line
                      x1={padding.left}
                      y1={padding.top}
                      x2={padding.left}
                      y2={padding.top + innerHeight}
                      stroke="#bfbfbf"
                    />

                    {/* Cutoff Reference Line */}
                    <line
                      x1={padding.left}
                      y1={scaleY(cutoff)}
                      x2={padding.left + innerWidth}
                      y2={scaleY(cutoff)}
                      stroke="#faad14"
                      strokeDasharray="4 3"
                      strokeWidth={1.5}
                    />
                    <text
                      x={padding.left + innerWidth - 4}
                      y={scaleY(cutoff) - 4}
                      textAnchor="end"
                      fill="#faad14"
                      fontSize={10}
                    >
                      Cutoff = {cutoff.toFixed(2)}
                    </text>

                    {/* Grid lines & labels */}
                    {[0.0, 0.25, 0.5, 0.75, 1.0].map((tick) => (
                      <g key={tick}>
                        <line
                          x1={padding.left}
                          y1={scaleY(tick)}
                          x2={padding.left + innerWidth}
                          y2={scaleY(tick)}
                          stroke="#e8e8e8"
                          strokeDasharray="2 2"
                        />
                        <text
                          x={padding.left - 8}
                          y={scaleY(tick) + 4}
                          textAnchor="end"
                          fontSize={10}
                          fill="#8c8c8c"
                        >
                          {tick.toFixed(2)}
                        </text>
                      </g>
                    ))}

                    {/* S-curve path */}
                    {curvePath && (
                      <path
                        d={curvePath}
                        fill="none"
                        stroke="#1890ff"
                        strokeWidth={2.5}
                      />
                    )}

                    {/* Data Points */}
                    {samplePointsWithCoord.map((pt) => {
                      const cx = scaleX(pt.xVal)
                      const cy = scaleY(pt.jitterY)
                      const isSelected = selectedRowIdSet.has(pt.rowId)
                      const isMisclassified = (pt.predictedProb >= cutoff ? 1 : 0) !== pt.actual

                      return (
                        <circle
                          key={pt.rowId}
                          cx={cx}
                          cy={cy}
                          r={isSelected ? 5.5 : 3.5}
                          fill={isSelected ? '#ff4d4f' : pt.actual === 1 ? '#1890ff' : '#52c41a'}
                          stroke={isSelected ? '#780608' : isMisclassified ? '#ff4d4f' : '#ffffff'}
                          strokeWidth={isSelected ? 2 : isMisclassified ? 1.5 : 0.8}
                          opacity={0.85}
                        >
                          <title>{`Row: ${pt.rowId}\n${focusAxis}: ${pt.xVal}\nActual: ${pt.actual} (${result.classes[pt.actual]})\nProb: ${pt.predictedProb}`}</title>
                        </circle>
                      )
                    })}

                    {/* Drag selection rectangle */}
                    {brushBox && (
                      <rect
                        x={Math.min(brushBox.startX, brushBox.currentX)}
                        y={Math.min(brushBox.startY, brushBox.currentY)}
                        width={Math.abs(brushBox.currentX - brushBox.startX)}
                        height={Math.abs(brushBox.currentY - brushBox.startY)}
                        fill="rgba(24, 144, 255, 0.2)"
                        stroke="#1890ff"
                        strokeDasharray="3 3"
                      />
                    )}

                    {/* Axis Labels */}
                    <text
                      x={padding.left + innerWidth / 2}
                      y={chartHeight - 6}
                      textAnchor="middle"
                      fontSize={11}
                      fill="#595959"
                    >
                      {focusAxis}
                    </text>
                    <text
                      x={14}
                      y={padding.top + innerHeight / 2}
                      textAnchor="middle"
                      transform={`rotate(-90 14 ${padding.top + innerHeight / 2})`}
                      fontSize={11}
                      fill="#595959"
                    >
                      P(Y = 1 | X)
                    </text>
                  </svg>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ※ 矩形ドラッグで点を選択。赤枠点は誤分類サンプル。他変数は中央値に固定。
                </Typography.Text>
              </Card>
            </Col>

            {/* Forest Plot */}
            <Col xs={24} lg={12}>
              <Card size="small" title="▼ オッズ比フォレストプロット (Odds Ratio Forest Plot)">
                <div style={{ height: chartHeight, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', borderBottom: '1px solid #e8e8e8', paddingBottom: 4 }}>
                    <span style={{ width: 120, fontWeight: 'bold', fontSize: 12 }}>変数名</span>
                    <span style={{ width: 140, fontWeight: 'bold', fontSize: 12 }}>OR (95% CI)</span>
                    <span style={{ flex: 1, textAlign: 'center', fontWeight: 'bold', fontSize: 12 }}>
                      抑制 (&lt; 1.0) | 促進 (&gt; 1.0)
                    </span>
                  </div>

                  {forestData.map((item) => {
                    const barWidth = 180
                    const logMin = Math.log(forestMinMax.min)
                    const logMax = Math.log(forestMinMax.max)
                    const scaleLog = (v: number) => {
                      const clamped = Math.max(forestMinMax.min, Math.min(forestMinMax.max, v))
                      const logV = Math.log(clamped)
                      return ((logV - logMin) / (logMax - logMin)) * barWidth
                    }

                    const xRef = scaleLog(1.0)
                    const xOr = scaleLog(item.oddsRatio)
                    const xLow = scaleLog(item.ciLower)
                    const xHigh = scaleLog(item.ciUpper)

                    return (
                      <div key={item.name} style={{ display: 'flex', alignItems: 'center' }}>
                        <span style={{ width: 120, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </span>
                        <span style={{ width: 140, fontSize: 11, fontFamily: 'monospace' }}>
                          {item.oddsRatio.toFixed(2)} [{item.ciLower.toFixed(2)}, {item.ciUpper.toFixed(2)}]
                        </span>
                        <div style={{ flex: 1, position: 'relative', height: 20, display: 'flex', alignItems: 'center' }}>
                          {/* Reference line OR = 1.0 */}
                          <div
                            style={{
                              position: 'absolute',
                              left: xRef,
                              top: 0,
                              bottom: 0,
                              width: 1,
                              background: '#8c8c8c',
                              borderLeft: '1px dashed #8c8c8c',
                            }}
                          />
                          {/* CI Bar */}
                          <div
                            style={{
                              position: 'absolute',
                              left: Math.min(xLow, xHigh),
                              width: Math.max(2, Math.abs(xHigh - xLow)),
                              height: 2,
                              background: item.pValue < 0.05 ? '#1890ff' : '#bfbfbf',
                            }}
                          />
                          {/* OR Point */}
                          <div
                            style={{
                              position: 'absolute',
                              left: xOr - 4,
                              top: 6,
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: item.pValue < 0.05 ? '#1890ff' : '#8c8c8c',
                            }}
                            title={`OR: ${item.oddsRatio.toFixed(3)}, p: ${item.pValue}`}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Card>
            </Col>
          </Row>

          {/* Middle Row: Confusion Matrix + Fit Metrics */}
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Card size="small" title="▼ 混同行列 (Confusion Matrix)">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'center' }}>
                    <thead>
                      <tr>
                        <th style={{ padding: 6 }}></th>
                        <th style={{ padding: 6, background: '#f5f5f5', border: '1px solid #d9d9d9' }}>
                          予測: 0 ({result.classes[0]})
                        </th>
                        <th style={{ padding: 6, background: '#f5f5f5', border: '1px solid #d9d9d9' }}>
                          予測: 1 ({result.classes[1]})
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={{ padding: 6, fontWeight: 'bold', background: '#f5f5f5', border: '1px solid #d9d9d9' }}>
                          実測: 0 ({result.classes[0]})
                        </td>
                        <td
                          style={{
                            padding: 12,
                            border: '1px solid #d9d9d9',
                            cursor: 'pointer',
                            background: '#f6ffed',
                          }}
                          onClick={(e) => handleSelectRows(dynamicMetrics.tnRowIds, e)}
                          title="クリックで TN サンプルを選択"
                          data-testid="cm-tn-cell"
                        >
                          <Typography.Title level={4} style={{ margin: 0, color: '#52c41a' }}>
                            {dynamicMetrics.tn}
                          </Typography.Title>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>True Negative (TN)</Typography.Text>
                        </td>
                        <td
                          style={{
                            padding: 12,
                            border: '1px solid #d9d9d9',
                            cursor: 'pointer',
                            background: '#fff1f0',
                          }}
                          onClick={(e) => handleSelectRows(dynamicMetrics.fpRowIds, e)}
                          title="クリックで FP サンプルを選択"
                          data-testid="cm-fp-cell"
                        >
                          <Typography.Title level={4} style={{ margin: 0, color: '#cf1322' }}>
                            {dynamicMetrics.fp}
                          </Typography.Title>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>False Positive (FP)</Typography.Text>
                        </td>
                      </tr>
                      <tr>
                        <td style={{ padding: 6, fontWeight: 'bold', background: '#f5f5f5', border: '1px solid #d9d9d9' }}>
                          実測: 1 ({result.classes[1]})
                        </td>
                        <td
                          style={{
                            padding: 12,
                            border: '1px solid #d9d9d9',
                            cursor: 'pointer',
                            background: '#fff1f0',
                          }}
                          onClick={(e) => handleSelectRows(dynamicMetrics.fnRowIds, e)}
                          title="クリックで FN サンプルを選択"
                          data-testid="cm-fn-cell"
                        >
                          <Typography.Title level={4} style={{ margin: 0, color: '#cf1322' }}>
                            {dynamicMetrics.fn}
                          </Typography.Title>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>False Negative (FN)</Typography.Text>
                        </td>
                        <td
                          style={{
                            padding: 12,
                            border: '1px solid #d9d9d9',
                            cursor: 'pointer',
                            background: '#e6f7ff',
                          }}
                          onClick={(e) => handleSelectRows(dynamicMetrics.tpRowIds, e)}
                          title="クリックで TP サンプルを選択"
                          data-testid="cm-tp-cell"
                        >
                          <Typography.Title level={4} style={{ margin: 0, color: '#1890ff' }}>
                            {dynamicMetrics.tp}
                          </Typography.Title>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>True Positive (TP)</Typography.Text>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: 8, flexWrap: 'wrap' }}>
                    <Tag color="blue">正解率 (Accuracy): {(dynamicMetrics.accuracy * 100).toFixed(1)}%</Tag>
                    <Tag color="cyan">適合率 (Precision): {(dynamicMetrics.precision * 100).toFixed(1)}%</Tag>
                    <Tag color="green">再現率 (Recall): {(dynamicMetrics.recall * 100).toFixed(1)}%</Tag>
                    <Tag color="purple">F1-Score: {dynamicMetrics.f1Score.toFixed(3)}</Tag>
                  </div>
                </div>
              </Card>
            </Col>

            {/* Model Fit Diagnostics */}
            <Col xs={24} md={12}>
              <Card size="small" title="▼ モデル適合度指標 (Fit Metrics)">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Row gutter={[12, 12]}>
                    <Col span={12}>
                      <Typography.Text type="secondary">赤池情報量基準 (AIC):</Typography.Text>
                      <Typography.Title level={4} style={{ margin: '2px 0 0 0' }}>
                        {result.fitMetrics.aic.toFixed(2)}
                      </Typography.Title>
                    </Col>
                    <Col span={12}>
                      <Typography.Text type="secondary">ベイズ情報量基準 (BIC):</Typography.Text>
                      <Typography.Title level={4} style={{ margin: '2px 0 0 0' }}>
                        {result.fitMetrics.bic.toFixed(2)}
                      </Typography.Title>
                    </Col>
                    <Col span={12}>
                      <Typography.Text type="secondary">McFadden 擬似決定係数 (Pseudo R²):</Typography.Text>
                      <Typography.Title level={4} style={{ margin: '2px 0 0 0', color: '#1890ff' }}>
                        {result.fitMetrics.pseudoR2.toFixed(3)}
                      </Typography.Title>
                    </Col>
                    <Col span={12}>
                      <Typography.Text type="secondary">対数尤度 (Log-Likelihood):</Typography.Text>
                      <Typography.Title level={4} style={{ margin: '2px 0 0 0' }}>
                        {result.fitMetrics.logLikelihood.toFixed(2)}
                      </Typography.Title>
                    </Col>
                  </Row>

                  <Divider style={{ margin: '6px 0' }} />

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Typography.Text strong>収束ステータス:</Typography.Text>
                    {result.fitMetrics.converged ? (
                      <Tag icon={<CheckCircleOutlined />} color="success">収束 (Converged)</Tag>
                    ) : (
                      <Tag icon={<CloseCircleOutlined />} color="warning">未収束 (L2 Fallback)</Tag>
                    )}
                    <Tag color="geekblue">{result.evidenceClass}</Tag>
                  </div>
                </div>
              </Card>
            </Col>
          </Row>

          {/* Bottom Row: Coefficients Table */}
          <Card size="small" title="▼ 回帰係数詳細サマリー (Coefficients Summary)">
            <Table
              size="small"
              dataSource={result.coefficients}
              columns={coeffColumns}
              rowKey="name"
              pagination={false}
              data-testid="coefficients-table"
            />
          </Card>
        </Space>
      ) : (
        <Card size="small" style={{ textAlign: 'center', padding: 40 }}>
          <Typography.Text type="secondary">
            目的変数と説明変数を選択し、「モデル学習 (Run)」ボタンを押してください。
          </Typography.Text>
        </Card>
      )}
    </div>
  )
}
