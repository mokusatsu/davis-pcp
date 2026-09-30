import ModelScatter from './ModelScatter'
import OddsRatioForest, { formatOdds } from './OddsRatioForest'
import { selectOrdinaryVariables, selectVariableEntities } from '../../app/store'
import { useQuestionText } from '../common/ColumnQuestionTooltip'
import Table from '../common/ColumnTable'
import GraphPanel from '../common/GraphPanel'
import Select from '../common/ColumnSelect'
import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  Card,
  Row,
  Col,
  Button,
  Radio,
  Checkbox,
  Slider,
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
import MaAxisPicker from '../pcp/MaAxisPicker'
import { api } from '../../api/client'
import { useCodebook } from '../dataset/useCodebookColumn'
import { getBrushOp } from '../selection/SelectionMenu'
import { useRowColorResolver } from '../../theme/useRowColor'
import L1Legend from '../common/L1Legend'

export interface CoefficientItem {
  name: string
  coefficient: number
  stdError: number
  zValue: number
  pValue: number
  oddsRatio: number | null
  ciLower: number | null
  ciUpper: number | null
  logOddsRatio: number
  logCiLower: number
  logCiUpper: number
  exponentiationStatus?: { oddsRatio: string; ciLower: string; ciUpper: string }
}

export interface SigmoidCurvePoint {
  x: number
  probability: number
}

export interface LogisticSamplePoint {
  featureValues: Record<string, number>
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
  warnings?: { code: string; message: string }[]
  diagnostics: { completeSeparation: boolean | null }
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
  const [intercept, setIntercept] = useState<boolean>(true)
  const [regularization, setRegularization] = useState<'none' | 'l2' | 'l1'>('none')
  const [cValue, setCValue] = useState<number>(1.0)
  const [cutoff, setCutoff] = useState<number>(0.5)

  // Computation result
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<LogisticResponse | null>(null)
  const [focusAxis, setFocusAxis] = useState<string>('')
  const inputKey = JSON.stringify([selection.datasetId, selection.dataRevision, schemaRevision, effectiveRowIds,
    targetColumn, selectedFeatures, intercept, regularization, cValue])
  const currentInput = useRef(inputKey)
  currentInput.current = inputKey
  const runVersion = useRef(0)
  useEffect(() => {
    setResult(null)
    setLoading(false)
    return () => { runVersion.current++ }
  }, [inputKey])

  // Brush state on Sigmoid Plot
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Run model
  const handleRunModel = async () => {
    if (!selection.datasetId || !targetColumn || selectedFeatures.length === 0) {
      message.warning('目的変数と1つ以上の説明変数を選択してください。')
      return
    }
    setLoading(true)
    setResult(null)
    const version = ++runVersion.current
    try {
      const res = await api.post<LogisticResponse>('/models/logistic', {
        datasetId: selection.datasetId,
        targetColumn,
        featureColumns: selectedFeatures,
        activeRowIds: effectiveRowIds,
        expectedDataRevision: selection.dataRevision,
        expectedSchemaRevision: schemaRevision,
        intercept,
        regularization,
        cValue,
        cutoff,
      })
      if (currentInput.current !== inputKey || version !== runVersion.current) return
      setResult(res)
      if (selectedFeatures.length > 0) {
        setFocusAxis(selectedFeatures[0])
      }
      message.success('ロジスティック回帰モデルを推定しました。')
    } catch (err: any) {
      if (currentInput.current === inputKey && version === runVersion.current) message.error(err?.message || 'モデルの推定に失敗しました。')
    } finally {
      if (version === runVersion.current) setLoading(false)
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
  const handleSelectRows = (rowIds: string[], _event?: React.MouseEvent) => {
    const op = getBrushOp()
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

  const chartWidth = 560
  const chartHeight = 280

  // Prepare points and curve for Focus Axis
  const axisCurve = useMemo(() => {
    if (!result?.curves || !focusAxis) return []
    return result.curves[focusAxis] || []
  }, [result, focusAxis])

  const axisMinMax = useMemo(() => {
    if (!result || !focusAxis) return { min: 0, max: 1 }
    const arr = result.samples.map(sample => sample.featureValues[focusAxis])
    let min = Infinity
    let max = -Infinity
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (Number.isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (min === Infinity) return { min: 0, max: 1 }
    return { min, max: max === min ? min + 1 : max }
  }, [result, focusAxis])

  // Sample points with x coordinate on focusAxis
  const samplePointsWithCoord = useMemo(() => {
    if (!result?.samples || !focusAxis) return []

    return result.samples.map((s) => {
      const xVal = s.featureValues[focusAxis]
      // deterministic small jitter for visual separation
      const hash = Math.sin(Number(s.rowId.replace(/\D/g, '') || '1') * 997) * 0.04
      const yCoord = s.actual === 1 ? 1.0 - Math.abs(hash) : 0.0 + Math.abs(hash)
      return {
        ...s,
        xVal,
        jitterY: yCoord,
      }
    }).filter((p) => !isNaN(p.xVal))
  }, [result?.samples, focusAxis])

  // Odds ratio forest plot data
  const forestData = useMemo(() => {
    if (!result?.coefficients) return []
    return result.coefficients.filter((c) => c.name !== 'Intercept')
  }, [result])

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
      render: (v: number | null, r: CoefficientItem) => <Tag color={r.coefficient > 0 ? 'blue' : 'orange'}>{formatOdds(v, r.exponentiationStatus?.oddsRatio)}</Tag>,
    },
    {
      title: '95% 信頼区間 (CI)',
      key: 'ci',
      render: (_: any, r: CoefficientItem) => `[${formatOdds(r.ciLower, r.exponentiationStatus?.ciLower)}, ${formatOdds(r.ciUpper, r.exponentiationStatus?.ciUpper)}]`,
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
        <Space style={{ marginTop: 12 }} wrap>
          <MaAxisPicker allowCount={false} groups={groups} columns={definitions} onAdd={axes => {
            const names = definitions.filter(column => axes.some(axis => axis.columnId === column.columnId)).map(column => column.name)
            setAdded({ datasetId: selection.datasetId, names: [...new Set([...(added.datasetId === selection.datasetId ? added.names : []), ...names])] })
          }} />
          <Typography.Text type="secondary">追加したMA選択肢は目的変数・説明変数の候補になります。</Typography.Text>
        </Space>

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
        {result?.warnings?.map((warning, i) => <Alert key={`${warning.code}-${i}`} type="warning" showIcon
          style={{ marginTop: 12 }} message={warning.message} />)}
        {result?.diagnostics?.completeSeparation === true && <Alert type="warning" showIcon style={{ marginTop: 12 }}
          message="完全分離が検出されました。"
          description="説明変数で2クラスを完全に分離できます。通常の最尤推定では有限の係数が定まらないため、係数・標準誤差・p値・信頼区間を通常の推論として解釈できません。正則化や変数の見直しを検討してください。" />}
        {result?.diagnostics?.completeSeparation === null && <Alert type="warning" showIcon style={{ marginTop: 12 }}
          message="完全分離の診断を確定できませんでした。" />}
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
              <GraphPanel
                graphId="logistic/sigmoid"
                title="予測確率・シグモイド曲線"
                available={Boolean(result && focusAxis)}
                sizing="intrinsic"
                intrinsicSize={{ width: chartWidth, height: chartHeight }}
              >
              <Card
                size="small"
                title={
                  <Space wrap size={8}>
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
                }
              >
                <div style={{ position: 'relative', width: '100%', overflow: 'hidden' }}>
                  <L1Legend />
                  <ModelScatter testId="logistic-sigmoid-svg" svgRef={svgRef} height={chartHeight}
                    points={samplePointsWithCoord.map(p => ({ id: p.rowId, rowId:p.rowId, x: p.xVal, y: p.jitterY,
                      selected: selectedRowIdSet.has(p.rowId), selectionColor, color: getColor(p.rowId),
                      misclassified: (p.predictedProb >= cutoff ? 1 : 0) !== p.actual,
                      title: `Row: ${p.rowId}\n${questionText(focusAxis)}: ${p.xVal}\nActual: ${p.actual} (${result.classes[p.actual]})\nProb: ${p.predictedProb}` }))}
                    xLabel={questionText(focusAxis)} yLabel="P(Y = 1 | X)" xExtent={[axisMinMax.min, axisMinMax.max]} yExtent={[0, 1]}
                    extraSeries={[{ type: 'line', data: axisCurve.map(p => [p.x, p.probability]), symbol: 'none', silent: true,
                      lineStyle: { color: '#1890ff', width: 2.5 }, markLine: { symbol: 'none', data: [{ yAxis: cutoff }],
                        lineStyle: { color: '#faad14' }, label: { formatter: `Cutoff = ${cutoff.toFixed(2)}` } } }]}
                    onToggle={id => dispatch(selectionApplied({ rowIds: [id], operation: 'toggle', label: 'ロジスティック回帰の点選択' }))}
                    onBrush={b => handleSelectRows(samplePointsWithCoord.filter(p => p.xVal >= b.x[0] && p.xVal <= b.x[1]
                      && (!b.y || p.jitterY >= b.y[0] && p.jitterY <= b.y[1])).map(p => p.rowId))} />
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ※ 矩形ドラッグで点を選択。赤枠点は誤分類サンプル。他変数は中央値に固定。
                </Typography.Text>
              </Card>
              </GraphPanel>
            </Col>

            {/* Forest Plot */}
            <Col xs={24} lg={12}>
              <GraphPanel
                graphId="logistic/forest"
                title="オッズ比フォレストプロット"
                available={Boolean(result && forestData.length)}
                sizing="intrinsic"
                intrinsicSize={{ width: 560, height: Math.max(280, 120 + forestData.length * 48) }}
                normalWidth="viewport"
              >
              <Card size="small">
                <OddsRatioForest items={forestData} />
              </Card>
              </GraphPanel>
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
