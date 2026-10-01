import ModelScatter from './ModelScatter'
import { CorrelationCircle } from './FamdFigure'
import EChart from '../charts/EChart'
import type { SeriesOption } from 'echarts'
import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import Table from '../common/ColumnTable'
import ColumnQuestionTooltip, { useQuestionText } from '../common/ColumnQuestionTooltip'
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
import GraphPanel from '../common/GraphPanel'
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
  const { getColor, selectionColor } = useRowColorResolver()
  const questionText = useQuestionText()
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

  const mapWidth = 460
  const mapHeight = 300
  const biplotSize = 300

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
    <div style={{ padding: 16, height: '100%', overflowY: 'auto' }} data-testid="discriminant-analysis-page">
      {/* Configuration Card */}
      {<Card size="small" style={{ marginBottom: 16 }}>
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

      {result?.diagnostics && <Card size="small" style={{ marginBottom: 16 }}><DiscriminantDiagnostics value={result.diagnostics} /></Card>}
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
            <Col xs={24} lg={13}>
              <GraphPanel graphId="discriminant/map" title="正準判別空間マップ" available={Boolean(result)} sizing="intrinsic" intrinsicSize={{ width: mapWidth, height: mapHeight }}>
              <Card size="small">
                <Space wrap size={[6, 6]} style={{ width: '100%', marginBottom: 8 }}>
                  {result.axes.map((ax) => (
                    <Tag key={ax.axisIndex} color="blue" style={{ marginInlineEnd: 0, whiteSpace: 'nowrap' }}>
                      LD{ax.axisIndex}: {(ax.explainedVarianceRatio * 100).toFixed(1)}% (ρ={ax.canonicalCorrelation.toFixed(2)})
                    </Tag>
                  ))}
                </Space>
                <div style={{ position: 'relative', width: '100%', overflow: 'hidden' }}>
                  <ModelScatter testId="discriminant-map-svg" svgRef={svgRef} height={mapHeight}
                    points={result.samples.map(s => ({ id: s.rowId, rowId:s.rowId, x: s.ld1, y: s.ld2,
                      selected: selectedRowIdSet.has(s.rowId), selectionColor, color: getColor(s.rowId), misclassified: s.isMisclassified,
                      title: `Row: ${s.rowId}\nActual: ${s.actualClass}\nPred: ${s.predictedClass}\nLD1: ${s.ld1}\nLD2: ${s.ld2}\nDist: ${s.mahalanobisDistance}` }))}
                    oneDimensional={result.axes.length < 2} xLabel="LD1 (第1正準判別軸)" yLabel="LD2 (第2正準判別軸)"
                    xExtent={[mapExtents.xMin, mapExtents.xMax]} yExtent={[mapExtents.yMin, mapExtents.yMax]}
                    extraSeries={discriminantBackground(result, classColorMap)}
                    onToggle={id => dispatch(selectionApplied({ rowIds: [id], operation: 'toggle', label: '判別分析の点選択' }))}
                    onBrush={b => handleSelectRows(result.samples.filter(s => s.ld1 >= b.x[0] && s.ld1 <= b.x[1]
                      && (!b.y || s.ld2 >= b.y[0] && s.ld2 <= b.y[1])).map(s => s.rowId))} />
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
              </GraphPanel>
            </Col>

            {/* Loadings Biplot: G38 独立した図として拡大。表は分離 */}
            {<Col xs={24} lg={11}>
              <GraphPanel
                graphId="discriminant/structure"
                title="構造係数バイプロット"
                available={Boolean(result)}
                sizing="intrinsic"
                intrinsicSize={{ width: biplotSize, height: biplotSize }}
              >
              <Card size="small">
                {result.axes.length >= 2 ? (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <CorrelationCircle size={biplotSize} testId="discriminant-loadings-chart" points={result.loadings.map(l => ({
                      id: l.variable, label: l.variable, x: l.ld1, y: l.ld2 ?? 0, title: `${questionText(l.variable)} LD1=${l.ld1}, LD2=${l.ld2}`, color: '#722ed1' }))} />
                  </div>
                ) : (
                  <div style={{ padding: 8 }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>LD1 負荷量 (1D Mode)</Typography.Text>
                    <EChart height={Math.max(220, result.loadings.length * 32 + 60)} ariaLabel="LD1 負荷量"
                      option={{ grid: { left: 110, right: 40, top: 20, bottom: 35 }, tooltip: { trigger: 'axis', renderMode: 'richText', formatter: (params: any) => { const p = params[0]; return p ? `${questionText(p.name)}\nLD1: ${p.value}` : '' } },
                        xAxis: { type: 'value', min: -1, max: 1 }, yAxis: { type: 'category', inverse: true, data: result.loadings.map(l => l.variable), axisLabel: { width: 140 } },
                        series: [{ type: 'bar', data: result.loadings.map(l => ({ value: l.ld1, itemStyle: { color: l.ld1 >= 0 ? '#1890ff' : '#fa8c16' } })),
                          label: { show: true, formatter: (p: any) => Number(p.value).toFixed(3) } }] }} />
                  </div>
                )}
              </Card>
              </GraphPanel>
            </Col>}
          </Row>

          {<>
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

/** Boundary cells use the backend mesh's data extents, not the sample plot extent. */
export function discriminantBackground(result: DiscriminantResponse, colors: Record<string, string>): SeriesOption[] {
  const mesh = result.boundaryMesh
  if (result.axes.length < 2) return [{ type: 'scatter', data: [], markLine: { silent: true, symbol: 'none',
    data: [{ xAxis: result.decisionThreshold1D ?? 0 }], lineStyle: { color: '#ff4d4f' }, label: { formatter: '判別閾値' } } }]
  if (!mesh) return []
  const n = mesh.gridResolution
  const dx = (mesh.xRange[1] - mesh.xRange[0]) / n, dy = (mesh.yRange[1] - mesh.yRange[0]) / n
  return [{ type: 'custom', silent: true, clip: true, z: 0,
    data: mesh.gridClassIndices.flatMap((row, r) => row.map((cls, c) => [mesh.xRange[0] + c * dx, mesh.yRange[0] + r * dy, cls])),
    renderItem: (_params: any, api: any) => {
      const x = Number(api.value(0)), y = Number(api.value(1)), a = api.coord([x, y]), b = api.coord([x + dx, y + dy])
      return { type: 'rect', shape: { x: a[0], y: b[1], width: b[0]-a[0], height: a[1]-b[1] },
        style: { fill: colors[mesh.classes[Number(api.value(2))]] ?? '#ccc', opacity: .15 } }
    } }]
}
