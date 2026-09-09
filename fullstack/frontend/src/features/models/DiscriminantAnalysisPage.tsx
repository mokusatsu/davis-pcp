import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip from '../common/ColumnQuestionTooltip'
import Select from '../common/ColumnSelect'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Card,
  Row,
  Col,
  Button,
  Radio,
  Typography,
  Space,
  Alert,
  Spin,
  Tag,
  InputNumber,
  message,
} from 'antd'
import {
  ThunderboltOutlined,
  AimOutlined,
  CheckOutlined,
} from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { RootState, AppDispatch } from '../../app/store'
import { selectionApplied, activeEntitiesSet, selectEffectiveRowIds } from '../../app/store'
import type { VariableEntity } from '../selection/variableEntities'
import MaAxisPicker from '../pcp/MaAxisPicker'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'
import { useRowColorResolver } from '../../theme/useRowColor'
import L1Legend from '../common/L1Legend'
import { FocusEnterButton, FocusTarget, useFocusMode } from '../common/FocusMode'
import { getBrushOp } from '../selection/SelectionMenu'
import DiscriminantDiagnostics, { type DiscriminantDiagnosticsData } from './DiscriminantDiagnostics'

export interface CanonicalAxisInfo {
  axisIndex: number
  eigenvalue: number
  explainedVarianceRatio: number
  canonicalCorrelation: number
}

export interface VariableLoading {
  variable: string
  ld1: number
  ld2?: number | null
}

export interface StepwiseTraceStep {
  step: number
  action: 'entered' | 'removed'
  variable: string
  wilksLambda: number
  partialF: number
  pValue: number
  activeVariables: string[]
}

export interface DiscriminantSamplePoint {
  rowId: string
  actualClass: string
  predictedClass: string
  isMisclassified: boolean
  ld1: number
  ld2: number
  posteriorProbabilities: Record<string, number>
  mahalanobisDistance: number
}

export interface BoundaryMesh {
  xRange: [number, number]
  yRange: [number, number]
  gridResolution: number
  classes: string[]
  gridClassIndices: number[][]
}

export interface DiscriminantResponse {
  diagnostics: DiscriminantDiagnosticsData
  target: string
  classes: string[]
  features: string[]
  method: 'lda' | 'qda' | 'stepwise'
  accuracy: number
  axes: CanonicalAxisInfo[]
  loadings: VariableLoading[]
  samples: DiscriminantSamplePoint[]
  boundaryMesh?: BoundaryMesh | null
  decisionThreshold1D?: number | null
  stepwiseTrace?: StepwiseTraceStep[] | null
  misclassifiedRowIds: string[]
  wilksLambdaOverall: number
  pOverall: number
  excludedRowCount: number
  evidenceClass: string
}

const CLASS_PALETTE = [
  '#1890ff',
  '#52c41a',
  '#fa8c16',
  '#722ed1',
  '#13c2c2',
  '#eb2f96',
  '#faad14',
  '#2f54eb',
]

export default function DiscriminantAnalysisPage() {
  const { focused, zoom } = useFocusMode()
  const { getColor, selectionColor } = useRowColorResolver()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const globalVars = useSelector(selectOrdinaryVariables)
  const effectiveRowIds = useSelector(selectEffectiveRowIds)
  const { schemaRevision, columns: definitions } = useCodebook()

  const entities = useSelector(selectVariableEntities)
  const [added, setAdded] = useState<{ datasetId: string | null; names: string[] }>({ datasetId: null, names: [] })
  const groups = entities.items.filter(item => item.entity.kind === 'ma' && entities.selected.has(item.key))
    .map(item => ({ groupId: item.name, label: item.label }))
  const candidates = definitions.filter(column => ['question', 'attribute'].includes(column.role)
    && (column.multiResponseGroup ? added.datasetId === selection.datasetId && added.names.includes(column.name)
      && groups.some(group => group.groupId === column.multiResponseGroup) : globalVars.activeVariableIds.includes(column.name)))

  // Form state
  const [requestedTarget, setTargetColumn] = useState<string>('')
  const [requestedFeatures, setSelectedFeatures] = useState<string[]>([])
  const allColumns = candidates.filter(column => column.multiResponseGroup || ['nominal', 'ordinal', 'interval', 'ratio'].includes(column.scaleType)).map(column => column.name)
  const targetColumn = allColumns.includes(requestedTarget) ? requestedTarget : ''
  const targetGroup = candidates.find(column => column.name === targetColumn)?.multiResponseGroup
  const numericColumns = candidates.filter(column => column.name !== targetColumn && (!targetGroup || column.multiResponseGroup !== targetGroup)
    && (column.multiResponseGroup || ['ordinal', 'interval', 'ratio'].includes(column.scaleType))).map(column => column.name)
  const selectedFeatures = requestedFeatures.filter(name => numericColumns.includes(name))
  useEffect(() => { setTargetColumn(''); setSelectedFeatures([]) }, [selection.datasetId])
  const [method, setMethod] = useState<'lda' | 'qda' | 'stepwise'>('lda')
  const [shrinkage, setShrinkage] = useState<'none' | 'auto'>('none')
  const [priors, setPriors] = useState<'proportional' | 'uniform'>('proportional')
  const [fEnter, setFEnter] = useState<number>(3.84)
  const [fRemove, setFRemove] = useState<number>(2.71)

  // Execution state
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DiscriminantResponse | null>(null)
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, effectiveRowIds,
    targetColumn, selectedFeatures, method, shrinkage, priors, fEnter, fRemove])
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const runVersion = useRef(0)
  useEffect(() => {
    setResult(null)
    setLoading(false)
    return () => { runVersion.current++ }
  }, [inputKey])

  // Brush state on 2D Map
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [brushBox, setBrushBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)

  const brushStart = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null)
  useEffect(() => { brushStart.current = null; setBrushBox(null) }, [inputKey, focused, zoom])

  // Run analysis
  const handleRunAnalysis = async () => {
    if (!selection.datasetId || !targetColumn || selectedFeatures.length === 0) {
      message.warning('目的変数と1つ以上の説明変数を選択してください。')
      return
    }
    setLoading(true)
    setResult(null)
    const version = ++runVersion.current
    try {
      const res = await api.post<DiscriminantResponse>('/models/discriminant', {
        datasetId: selection.datasetId,
        targetColumn,
        featureColumns: selectedFeatures,
        activeRowIds: effectiveRowIds,
        expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision,
        method,
        shrinkage,
        priors,
        stepwiseConfig: method === 'stepwise' ? { fEnter, fRemove, maxSteps: 20 } : undefined,
      })
      if (version !== runVersion.current || currentInput.current !== inputKey) return
      setResult(res)
      message.success('判別分析を実行しました。')
    } catch (err: any) {
      if (version === runVersion.current && currentInput.current === inputKey) message.error(err?.message || '判別分析の実行に失敗しました。')
    } finally {
      if (version === runVersion.current) setLoading(false)
    }
  }

  // Fast selection set
  const selectedRowIdSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])

  // Row selection handler
  const handleSelectRows = (rowIds: string[], _event?: React.MouseEvent) => {
    const op = getBrushOp()
    dispatch(selectionApplied({ rowIds, operation: op, label: '判別分析選択' }))
  }

  const handleSelectMisclassified = (e: React.MouseEvent) => {
    if (!result?.misclassifiedRowIds.length) {
      message.info('誤分類サンプルはありません。')
      return
    }
    handleSelectRows(result.misclassifiedRowIds, e)
    message.success(`誤分類 ${result.misclassifiedRowIds.length} 行を選択しました。`)
  }

  // Apply stepwise variables to globalVariables
  const handleApplyStepwiseVars = (vars: string[]) => {
    const entities: VariableEntity[] = []
    const seen = new Set<string>()
    for (const name of vars) {
      const column = definitions.find(column => column.name === name)
      if (!column) continue
      const entity: VariableEntity = column.multiResponseGroup ? { kind: 'ma', groupId: column.multiResponseGroup } : { kind: 'column', columnId: column.columnId }
      const key = JSON.stringify(entity)
      if (!seen.has(key)) { seen.add(key); entities.push(entity) }
    }
    dispatch(activeEntitiesSet(entities))
    message.success(`グローバル有効変数を [${vars.join(', ')}] に更新しました。`)
  }

  // Map 2D plot dimensions
  const mapWidth = 460
  const mapHeight = 300
  const padding = { top: 20, right: 20, bottom: 40, left: 45 }
  const innerWidth = mapWidth - padding.left - padding.right
  const innerHeight = mapHeight - padding.top - padding.bottom

  // Map scales
  const mapExtents = useMemo(() => {
    if (!result?.samples || result.samples.length === 0) return { xMin: -5, xMax: 5, yMin: -5, yMax: 5 }
    let xMin = Infinity
    let xMax = -Infinity
    let yMin = Infinity
    let yMax = -Infinity
    for (const s of result.samples) {
      if (s.ld1 < xMin) xMin = s.ld1
      if (s.ld1 > xMax) xMax = s.ld1
      if (s.ld2 < yMin) yMin = s.ld2
      if (s.ld2 > yMax) yMax = s.ld2
    }
    const padX = Math.max(0.5, (xMax - xMin) * 0.15)
    const padY = Math.max(0.5, (yMax - yMin) * 0.15)
    return {
      xMin: xMin - padX,
      xMax: xMax + padX,
      yMin: yMin - padY,
      yMax: yMax + padY,
    }
  }, [result])

  const scaleMapX = (ld1: number) => {
    const { xMin, xMax } = mapExtents
    if (xMax <= xMin) return padding.left
    return padding.left + ((ld1 - xMin) / (xMax - xMin)) * innerWidth
  }

  const scaleMapY = (ld2: number) => {
    const { yMin, yMax } = mapExtents
    if (yMax <= yMin) return padding.top
    return padding.top + (1.0 - (ld2 - yMin) / (yMax - yMin)) * innerHeight
  }

  const sampleY = (sample: DiscriminantSamplePoint) => {
    if ((result?.axes.length ?? 0) >= 2) return scaleMapY(sample.ld2)
    const jitter = (((sample.rowId.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) * 17) % 100) / 100 - 0.5) * innerHeight * 0.4
    return padding.top + innerHeight / 2 + jitter
  }

  // Brush drag interaction
  const plotCoordinates = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return null
    const rect = svgRef.current.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return { x: (e.clientX - rect.left) * mapWidth / rect.width, y: (e.clientY - rect.top) * mapHeight / rect.height, rect }
  }
  const handleMouseDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const point = plotCoordinates(e)
    if (!point) return
    const { x, y } = point
    brushStart.current = { x, y, clientX: e.clientX, clientY: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
    setBrushBox({ startX: x, startY: y, currentX: x, currentY: y })
  }

  const handleMouseMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!brushStart.current) return
    const point = plotCoordinates(e)
    if (!point) return
    const { x, y } = point
    setBrushBox((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null))
  }

  const handleMouseUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = brushStart.current
    const end = plotCoordinates(e)
    brushStart.current = null
    setBrushBox(null)
    if (!start || !end) return
    const xMin = Math.min(start.x, end.x)
    const xMax = Math.max(start.x, end.x)
    const yMin = Math.min(start.y, end.y)
    const yMax = Math.max(start.y, end.y)

    // Check if dragging was intentional (> 4px)
    if (Math.abs(e.clientX - start.clientX) > 4 || Math.abs(e.clientY - start.clientY) > 4) {
      const selected: string[] = []
      for (const pt of result?.samples ?? []) {
        const px = scaleMapX(pt.ld1)
        const py = sampleY(pt)
        if (px >= xMin && px <= xMax && py >= yMin && py <= yMax) {
          selected.push(pt.rowId)
        }
      }
      handleSelectRows(selected)
    } else {
      let nearest: string | null = null
      let distance = 49
      for (const pt of result?.samples ?? []) {
        const dx = (scaleMapX(pt.ld1) - end.x) * end.rect.width / mapWidth
        const dy = (sampleY(pt) - end.y) * end.rect.height / mapHeight
        const squared = dx * dx + dy * dy
        if (squared < distance) { nearest = pt.rowId; distance = squared }
      }
      if (nearest) dispatch(selectionApplied({ rowIds: [nearest], operation: 'toggle', label: '判別分析の点選択' }))
    }
  }

  // Biplot dimensions
  const biplotSize = 300
  const biplotPadding = 40
  const biplotRadius = (biplotSize - biplotPadding * 2) / 2
  const biplotCenter = biplotSize / 2

  // Color mapping helper
  const classColorMap = useMemo(() => {
    if (!result?.classes) return {}
    const map: Record<string, string> = {}
    result.classes.forEach((c, i) => {
      map[c] = CLASS_PALETTE[i % CLASS_PALETTE.length]
    })
    return map
  }, [result?.classes])

  return (
    <div style={{ padding: focused ? 0 : 16, height: '100%', overflowY: 'auto' }} data-testid="discriminant-analysis-page">
      {/* Configuration Card */}
      {!focused && <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col xs={24} sm={12} md={6}>
            <Typography.Text strong>目的クラス Y (Target / Class):</Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={targetColumn}
              onChange={setTargetColumn}
              options={allColumns.map((c) => ({ label: c, value: c }))}
              placeholder="クラス変数を選択"
              data-testid="discriminant-target-select"
            />
          </Col>

          <Col xs={24} sm={12} md={8}>
            <Typography.Text strong>説明変数 X (Features):</Typography.Text>
            <Select
              mode="multiple"
              style={{ width: '100%', marginTop: 4 }}
              value={selectedFeatures}
              onChange={setSelectedFeatures}
              options={numericColumns.filter((c) => c !== targetColumn).map((c) => ({ label: c, value: c }))}
              placeholder="説明変数を選択"
              maxTagCount={3}
              data-testid="discriminant-features-select"
            />
          </Col>

          <Col xs={24} sm={12} md={5}>
            <Typography.Text strong>手法 (Method):</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Radio.Group
                size="small"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                data-testid="discriminant-method-radio"
              >
                <Radio.Button value="lda">LDA</Radio.Button>
                <Radio.Button value="qda">QDA</Radio.Button>
                <Radio.Button value="stepwise">Stepwise</Radio.Button>
              </Radio.Group>
            </div>
          </Col>

          <Col xs={24} sm={12} md={5}>
            <Typography.Text strong>縮小 (Shrinkage):</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Radio.Group
                size="small"
                value={shrinkage}
                onChange={(e) => setShrinkage(e.target.value)}
                disabled={method === 'qda'}
              >
                <Radio.Button value="none">None</Radio.Button>
                <Radio.Button value="auto">Auto</Radio.Button>
              </Radio.Group>
            </div>
          </Col>
          <Col xs={24} sm={12} md={5}>
            <Typography.Text strong>事前確率 (Priors):</Typography.Text>
            <div style={{ marginTop: 4 }}>
              <Radio.Group
                size="small"
                value={priors}
                onChange={(e) => setPriors(e.target.value)}
              >
                <Radio.Button value="proportional">比率</Radio.Button>
                <Radio.Button value="uniform">等確率</Radio.Button>
              </Radio.Group>
            </div>
          </Col>
        </Row>

        <Space style={{ marginTop: 12 }} wrap>
          <MaAxisPicker allowCount={false} groups={groups} columns={definitions} onAdd={axes => {
            const names = definitions.filter(column => axes.some(axis => axis.columnId === column.columnId)).map(column => column.name)
            setAdded({ datasetId: selection.datasetId, names: [...new Set([...(added.datasetId === selection.datasetId ? added.names : []), ...names])] })
          }} />
          <Typography.Text type="secondary">追加したMA選択肢は目的変数・説明変数の候補になります。</Typography.Text>
        </Space>

        {method === 'stepwise' && (
          <Row gutter={[16, 8]} style={{ marginTop: 12 }} align="middle">
            <Col xs={12} sm={6}>
              <Typography.Text style={{ fontSize: 12 }}>投入 F値 (F-Enter):</Typography.Text>
              <InputNumber
                size="small"
                value={fEnter}
                onChange={(v) => setFEnter(v ?? 3.84)}
                step={0.1}
                style={{ width: '100%' }}
              />
            </Col>
            <Col xs={12} sm={6}>
              <Typography.Text style={{ fontSize: 12 }}>除外 F値 (F-Remove):</Typography.Text>
              <InputNumber
                size="small"
                value={fRemove}
                onChange={(v) => setFRemove(v ?? 2.71)}
                step={0.1}
                style={{ width: '100%' }}
              />
            </Col>
            <Col xs={24} sm={12}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                ※ WilksのΛを最小化し、偏F検定により寄与する変数を自動選択します。
              </Typography.Text>
            </Col>
          </Row>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, flexWrap: 'wrap', gap: 10 }}>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={handleRunAnalysis}
            loading={loading}
            data-testid="run-discriminant-btn"
          >
            判別分析実行 (Run Analysis)
          </Button>

          {result && (
            <Space size={12}>
              <Button
                icon={<AimOutlined />}
                danger
                onClick={handleSelectMisclassified}
                disabled={result.misclassifiedRowIds.length === 0}
                data-testid="select-misclassified-btn"
              >
                誤分類サンプル選択 (Misclassified: {result.misclassifiedRowIds.length})
              </Button>
            </Space>
          )}
        </div>

        {result && result.excludedRowCount > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`欠損値を含む ${result.excludedRowCount} 行を除外しました。`}
            style={{ marginTop: 12 }}
          />
        )}
      </Card>}

      {!focused && result?.diagnostics && <Card size="small" style={{ marginBottom: 16 }}><DiscriminantDiagnostics value={result.diagnostics} /></Card>}
      {/* Main Content */}
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
          <Spin size="large" tip="判別分析を計算中..." />
        </div>
      ) : result ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* Top Row: 2D Canonical Map + Loadings Biplot */}
          <Row gutter={[16, 16]}>
            {/* 2D Canonical Map */}
            <Col xs={24} lg={focused ? 24 : 13}>
              <FocusTarget id="discriminant-map" title="正準判別空間マップ">
              <Card
                extra={!focused && <FocusEnterButton targetId="discriminant-map" title="正準判別空間マップ" />}
                size="small"
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>▼ 正準判別空間マップ ({result.axes.length >= 2 ? 'LD1 vs LD2' : 'LD1 (1D Mode)'})</span>
                    <Space size={6}>
                      {result.axes.map((ax) => (
                        <Tag key={ax.axisIndex} color="blue">
                          LD{ax.axisIndex}: {(ax.explainedVarianceRatio * 100).toFixed(1)}% (ρ={ax.canonicalCorrelation.toFixed(2)})
                        </Tag>
                      ))}
                    </Space>
                  </div>
                }
              >
                <div style={{ position: 'relative', width: '100%', overflow: 'hidden' }}>
                  <svg
                    ref={svgRef}
                    data-testid="discriminant-map-svg"
                    viewBox={`0 0 ${mapWidth} ${mapHeight}`}
                    width="100%"
                    style={{ aspectRatio: `${mapWidth} / ${mapHeight}`, touchAction: 'none', background: '#fafafa', borderRadius: 4, cursor: 'crosshair', userSelect: 'none' }}
                    onPointerDown={handleMouseDown}
                    onPointerMove={handleMouseMove}
                    onPointerUp={handleMouseUp}
                    onPointerCancel={() => { brushStart.current = null; setBrushBox(null) }}
                    onLostPointerCapture={() => { brushStart.current = null; setBrushBox(null) }}
                  >
                    {/* Boundary Mesh Background (if available) */}
                    {result.boundaryMesh && (
                      <g opacity={0.15}>
                        {(() => {
                          const mesh = result.boundaryMesh
                          const res = mesh.gridResolution
                          const cellW = innerWidth / res
                          const cellH = innerHeight / res
                          const rects = []
                          for (let r = 0; r < res; r++) {
                            for (let c = 0; c < res; c++) {
                              const cIdx = mesh.gridClassIndices[r][c]
                              const cls = mesh.classes[cIdx]
                              const fill = classColorMap[cls] || '#ccc'
                              rects.push(
                                <rect
                                  key={`${r}-${c}`}
                                  x={padding.left + c * cellW}
                                  y={padding.top + (res - 1 - r) * cellH}
                                  width={cellW + 0.5}
                                  height={cellH + 0.5}
                                  fill={fill}
                                />
                              )
                            }
                          }
                          return rects
                        })()}
                      </g>
                    )}

                    {/* Zero Axes */}
                    {mapExtents.xMin <= 0 && mapExtents.xMax >= 0 && (
                      <line
                        x1={scaleMapX(0)}
                        y1={padding.top}
                        x2={scaleMapX(0)}
                        y2={padding.top + innerHeight}
                        stroke="#d9d9d9"
                        strokeDasharray="2 2"
                      />
                    )}
                    {result.axes.length >= 2 && mapExtents.yMin <= 0 && mapExtents.yMax >= 0 && (
                      <line
                        x1={padding.left}
                        y1={scaleMapY(0)}
                        x2={padding.left + innerWidth}
                        y2={scaleMapY(0)}
                        stroke="#d9d9d9"
                        strokeDasharray="2 2"
                      />
                    )}

                    {/* Boundary line for 1D mode */}
                    {result.axes.length < 2 && (
                      <line
                        x1={scaleMapX(result.decisionThreshold1D ?? 0)}
                        y1={padding.top}
                        x2={scaleMapX(result.decisionThreshold1D ?? 0)}
                        y2={padding.top + innerHeight}
                        stroke="#ff4d4f"
                        strokeWidth={1.5}
                        strokeDasharray="4 3"
                      />
                    )}

                    {/* Samples */}
                    {result.samples.map((s) => {
                      const cx = scaleMapX(s.ld1)
                      const cy = sampleY(s)
                      const isSelected = selectedRowIdSet.has(s.rowId)
                      const color = getColor(s.rowId)

                      return (
                        <g key={s.rowId}>
                        {s.isMisclassified && <circle cx={cx} cy={cy} r={isSelected ? 9 : 7} fill="none" stroke="#ff4d4f" strokeWidth={1.5} />}
                        <circle
                          data-row-id={s.rowId}
                          cx={cx}
                          cy={cy}
                          r={isSelected ? 6 : 4}
                          fill={color}
                          stroke={isSelected ? selectionColor : '#ffffff'}
                          strokeWidth={isSelected ? 2.5 : 0.8}
                          opacity={0.88}
                        >
                          <title>{`Row: ${s.rowId}\nActual: ${s.actualClass}\nPred: ${s.predictedClass}\nLD1: ${s.ld1}\nLD2: ${s.ld2}\nDist: ${s.mahalanobisDistance}`}</title>
                        </circle>
                        </g>
                      )
                    })}

                    {/* Brush box */}
                    {brushBox && (
                      <rect
                        x={Math.min(brushBox.startX, brushBox.currentX)}
                        y={Math.min(brushBox.startY, brushBox.currentY)}
                        width={Math.abs(brushBox.currentX - brushBox.startX)}
                        height={Math.abs(brushBox.currentY - brushBox.startY)}
                        fill="rgba(42,120,214,0.15)"
                        stroke="#2a78d6"
                        strokeWidth={1.5}
                        pointerEvents="none"
                      />
                    )}

                    {/* Axis labels */}
                    <text
                      x={padding.left + innerWidth / 2}
                      y={mapHeight - 6}
                      textAnchor="middle"
                      fontSize={11}
                      fill="#595959"
                    >
                      LD1 (第1正準判別軸)
                    </text>
                    {result.axes.length >= 2 && (
                      <text
                        x={12}
                        y={padding.top + innerHeight / 2}
                        textAnchor="middle"
                        transform={`rotate(-90 12 ${padding.top + innerHeight / 2})`}
                        fontSize={11}
                        fill="#595959"
                      >
                        LD2 (第2正準判別軸)
                      </text>
                    )}
                  </svg>
                </div>

                <L1Legend />
                {/* Class legend */}
                <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                  {result.boundaryMesh && <Typography.Text type="secondary" style={{ fontSize: 11 }}>背景の予測クラス:</Typography.Text>}
                  {result.boundaryMesh && result.classes.map((cls) => (
                    <div key={cls} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: classColorMap[cls],
                        }}
                      />
                      <Typography.Text style={{ fontSize: 11 }}>{cls}</Typography.Text>
                    </div>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                    ※ 赤枠は誤分類サンプル。矩形ドラッグで範囲選択。
                  </Typography.Text>
                </div>
              </Card>
              </FocusTarget>
            </Col>

            {/* Loadings Biplot */}
            {!focused && <Col xs={24} lg={11}>
              <Card size="small" title="▼ 正準判別負荷量バイプロット (Canonical Loadings)">
                {result.axes.length >= 2 ? (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <svg width={biplotSize} height={biplotSize} style={{ background: '#fafafa', borderRadius: 4 }}>
                      {/* Unit circle */}
                      <circle
                        cx={biplotCenter}
                        cy={biplotCenter}
                        r={biplotRadius}
                        fill="none"
                        stroke="#d9d9d9"
                        strokeDasharray="2 2"
                      />
                      {/* Axes */}
                      <line
                        x1={biplotPadding}
                        y1={biplotCenter}
                        x2={biplotSize - biplotPadding}
                        y2={biplotCenter}
                        stroke="#bfbfbf"
                      />
                      <line
                        x1={biplotCenter}
                        y1={biplotPadding}
                        x2={biplotCenter}
                        y2={biplotSize - biplotPadding}
                        stroke="#bfbfbf"
                      />

                      {/* Vector arrows */}
                      {result.loadings.map((l) => {
                        const targetX = biplotCenter + l.ld1 * biplotRadius
                        const targetY = biplotCenter - (l.ld2 ?? 0) * biplotRadius

                        return (
                          <g key={l.variable}>
                            <line
                              x1={biplotCenter}
                              y1={biplotCenter}
                              x2={targetX}
                              y2={targetY}
                              stroke="#722ed1"
                              strokeWidth={1.8}
                            />
                            <circle cx={targetX} cy={targetY} r={3} fill="#722ed1" />
                            <ColumnQuestionTooltip nameOrId={l.variable} svg><text
                              x={targetX + (l.ld1 >= 0 ? 5 : -5)}
                              y={targetY + (l.ld2 && l.ld2 >= 0 ? -4 : 10)}
                              textAnchor={l.ld1 >= 0 ? 'start' : 'end'}
                              fontSize={10}
                              fontWeight="bold"
                              fill="#531dab"
                            >
                              {l.variable}
                            </text></ColumnQuestionTooltip>
                          </g>
                        )
                      })}

                      <text x={biplotSize - 16} y={biplotCenter - 4} fontSize={9} fill="#8c8c8c">LD1</text>
                      <text x={biplotCenter + 4} y={16} fontSize={9} fill="#8c8c8c">LD2</text>
                    </svg>
                  </div>
                ) : (
                  <div style={{ height: biplotSize, overflowY: 'auto', padding: 8 }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>LD1 負荷量 (1D Mode)</Typography.Text>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                      {result.loadings.map((l) => (
                        <div key={l.variable} style={{ display: 'flex', alignItems: 'center' }}>
                          <span style={{ width: 100, fontSize: 12 }}><ColumnQuestionTooltip nameOrId={l.variable}>{l.variable}</ColumnQuestionTooltip></span>
                          <div style={{ flex: 1, position: 'relative', height: 16, background: '#f0f0f0', borderRadius: 2 }}>
                            <div
                              style={{
                                position: 'absolute',
                                left: l.ld1 >= 0 ? '50%' : `${50 + l.ld1 * 50}%`,
                                width: `${Math.abs(l.ld1) * 50}%`,
                                height: '100%',
                                background: l.ld1 >= 0 ? '#1890ff' : '#fa8c16',
                                borderRadius: 2,
                              }}
                            />
                            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#8c8c8c' }} />
                          </div>
                          <span style={{ width: 50, textAlign: 'right', fontSize: 11, fontFamily: 'monospace' }}>
                            {l.ld1.toFixed(3)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>
            </Col>}
          </Row>

          {!focused && <>
          {/* Diagnostics Bar */}
          <Card size="small">
            <Row gutter={[16, 8]} align="middle">
              <Col xs={12} sm={6}>
                <Typography.Text type="secondary">全体正解率 (Accuracy):</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0, color: '#52c41a' }}>
                  {(result.accuracy * 100).toFixed(1)}%
                </Typography.Title>
              </Col>
              <Col xs={12} sm={6}>
                <Typography.Text type="secondary">Wilks' Λ (Overall):</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {result.wilksLambdaOverall.toFixed(4)}
                </Typography.Title>
              </Col>
              <Col xs={12} sm={6}>
                <Typography.Text type="secondary">検定有意確率 p値:</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {result.pOverall < 0.0001 ? '< 0.0001' : result.pOverall.toFixed(4)}
                </Typography.Title>
              </Col>
              <Col xs={12} sm={6}>
                <Typography.Text type="secondary">誤分類サンプル数:</Typography.Text>
                <Typography.Title level={4} style={{ margin: 0, color: result.misclassifiedRowIds.length ? '#cf1322' : '#52c41a' }}>
                  {result.misclassifiedRowIds.length} / {result.samples.length}
                </Typography.Title>
              </Col>
            </Row>
          </Card>

          {/* Stepwise Trace Table (if method == 'stepwise') */}
          {result.stepwiseTrace && result.stepwiseTrace.length > 0 && (
            <Card size="small" title="▼ ステップワイズ変数選択トレース (Stepwise Trace)">
              <Table
                size="small"
                dataSource={result.stepwiseTrace}
                rowKey="step"
                pagination={false}
                columns={[
                  { title: 'Step', dataIndex: 'step', key: 'step', width: 60 },
                  {
                    title: 'Action',
                    dataIndex: 'action',
                    key: 'action',
                    render: (a: string) => (
                      <Tag color={a === 'entered' ? 'green' : 'red'}>
                        {a === 'entered' ? '投入 (Entered)' : '除外 (Removed)'}
                      </Tag>
                    ),
                  },
                  {
                    title: '変数 (Variable)',
                    dataIndex: 'variable',
                    key: 'variable',
                    render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
                  },
                  {
                    title: "Wilks' Λ",
                    dataIndex: 'wilksLambda',
                    key: 'wilksLambda',
                    render: (v: number) => v.toFixed(5),
                  },
                  {
                    title: 'Partial F',
                    dataIndex: 'partialF',
                    key: 'partialF',
                    render: (v: number) => v.toFixed(2),
                  },
                  {
                    title: 'p-value',
                    dataIndex: 'pValue',
                    key: 'pValue',
                    render: (v: number) => (v < 0.0001 ? '< 0.0001' : v.toFixed(4)),
                  },
                  {
                    title: '有効変数セット (Active Variables)',
                    dataIndex: 'activeVariables',
                    key: 'activeVariables',
                    render: (vars: string[]) => (
                      <Space size={4} wrap>
                        {vars.map((vr) => (
                          <Tag key={vr}><ColumnQuestionTooltip nameOrId={vr}>{vr}</ColumnQuestionTooltip></Tag>
                        ))}
                      </Space>
                    ),
                  },
                  {
                    title: '一括適用',
                    key: 'apply',
                    render: (_: any, r: StepwiseTraceStep) => (
                      <Button
                        size="small"
                        icon={<CheckOutlined />}
                        onClick={() => handleApplyStepwiseVars(r.activeVariables)}
                        data-testid={`stepwise-apply-step-${r.step}`}
                      >
                        この状態に
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          )}
          </>}
        </Space>
      ) : (
        <Card size="small" style={{ textAlign: 'center', padding: 40 }}>
          <Typography.Text type="secondary">
            目的クラス変数と説明変数を選択し、「判別分析実行 (Run Analysis)」を押してください。
          </Typography.Text>
        </Card>
      )}
    </div>
  )
}
