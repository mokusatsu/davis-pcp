import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Radio, Select as SelectSetting, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated, selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { fetchCodebookThunk } from '../dataset/codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'
import { useCodebook } from '../dataset/useCodebookColumn'
import GraphPanel from '../common/GraphPanel'
import { useGraphExpansion } from '../common/GraphExpansion'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import SelectColumn from '../common/ColumnSelect'
import L1Legend from '../common/L1Legend'
import { useRowColorResolver } from '../../theme/useRowColor'
import type { LRResponse } from './lrTypes'
import {
  exportLinearRegressionTable, fetchLinearRegressionPredictions, fetchLinearRegressionRows,
  materializeLinearRegression, predictLinearRegression, runLinearRegression,
  selectLinearRegression, downloadPng, downloadSvg, type LRContext, type LRPredictRow,
} from './lrApi'
import LinearRegressionFigure from './LinearRegressionFigure'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}

export default function LinearRegressionPage(): JSX.Element {
  const { openWhenAvailable } = useGraphExpansion()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const obs = useSelector((s: RootState) => s.globalObservations)
  const codebook = useCodebook()
  const { columns, schemaRevision } = codebook
  const datasetId = selection.datasetId
  const { getColor } = useRowColorResolver()

  const globalVars = useSelector(selectOrdinaryVariables)
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const activeSet = useMemo(() => new Set(globalVars.activeVariableIds), [globalVars.activeVariableIds])
  const targetOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const numericOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio', 'ordinal'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name, scaleType: c.scaleType })),
    [columns, activeSet, hasGlobalSignal],
  )
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const colById = useMemo(() => {
    const m = new Map<string, { name: string; label: string; scaleType: string; categoryOrder?: string[] }>()
    for (const c of columns) m.set(c.columnId, c as never)
    return m
  }, [columns])

  const [target, setTarget] = useState<string | null>(null)
  const [numSel, setNumSel] = useState<string[]>([])
  const [catSel, setCatSel] = useState<string[]>([])
  const [ordinalAck, setOrdinalAck] = useState<Record<string, boolean>>({})
  const [references, setReferences] = useState<Record<string, string | undefined>>({})
  const [interactions, setInteractions] = useState<string[][]>([])
  const [interDraft, setInterDraft] = useState<[string | null, string | null]>([null, null])
  const [intercept, setIntercept] = useState(true)
  const [covariance, setCovariance] = useState<'auto' | 'hc3' | 'classical' | 'taylor'>('auto')
  const [confidenceLevel, setConfidenceLevel] = useState(0.95)
  const [scope, setScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('active')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')
  const [tab, setTab] = useState('figure')
  const [diagField, setDiagField] = useState<'fitted' | 'residual' | 'leverage'>('fitted')

  const [result, setResult] = useState<LRResponse | null>(null)
  const [submittedKey, setSubmittedKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selectInfo, setSelectInfo] = useState<string | null>(null)
  const [rows, setRows] = useState<{ rowId: string; observed: number | null; fitted: number | null; residual: number | null; leverageTotal: number | null; leveragePerReplica: number | null; studentizedResidual: number | null; cooksDistance: number | null }[]>([])
  const [, setRowsTotal] = useState(0)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [rowsResultId, setRowsResultId] = useState<string | null>(null)
  const rowsReady = !rowsLoading && !rowsError && rowsResultId !== null
    && result !== null && rowsResultId === result.resultId
  const [predictScope, setPredictScope] = useState<'all' | 'active' | 'selected' | 'sampled'>('all')
  const [predictInterval, setPredictInterval] = useState<'none' | 'mean_ci' | 'individual_pi'>('mean_ci')
  const [predicting, setPredicting] = useState(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [predictInfo, setPredictInfo] = useState<string | null>(null)
  const [predictRows, setPredictRows] = useState<LRPredictRow[]>([])
  const [, setPredictTotal] = useState(0)
  const [predictResultId, setPredictResultId] = useState<string | null>(null)
  const [predictId, setPredictId] = useState<string | null>(null)
  const [matSource, setMatSource] = useState('fit')
  const [matField, setMatField] = useState('fitted')
  const matFieldsFor = (source: string): string[] => {
    if (!result) return []
    return source === 'fit'
      ? result.capabilities.materializeFitFields
      : result.capabilities.materializePredictionFields
  }
  const handleMatSourceChange = (v: string): void => {
    setMatSource(v)
    const fields = matFieldsFor(v)
    setMatField((f) => (fields.includes(f) ? f : (fields[0] ?? '')))
  }
  const [matName, setMatName] = useState('LR_FITTED')
  const [saving, setSaving] = useState(false)
  const runSequence = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const draftKey = JSON.stringify([datasetId, target, numSel, catSel, ordinalAck, references, interactions, intercept, covariance, confidenceLevel, scope, missingPolicy, weightChoice, selection.dataRevision, schemaRevision])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

  useEffect(() => {
    runSequence.current += 1
    setResult(null)
    setSubmittedKey('')
    setError(null)
    setLoading(false)
    setSelecting(false)
    setSelectInfo(null)
    setRows([])
    setRowsTotal(0)
    setRowsResultId(null)
    setTarget(null)
    setNumSel([])
    setCatSel([])
    setInteractions([])
    setPredictRows([])
    setPredictTotal(0)
    setPredictResultId(null)
    setPredictId(null)
    setPredictInfo(null)
    setPredictError(null)
    setMatSource('fit')
    setMatField((f) => {
      const fitFields = ['fitted', 'residual', 'leverage_total', 'leverage_per_replica']
      return fitFields.includes(f) ? f : 'fitted'
    })
  }, [datasetId])

  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const schemaRef = useRef(schemaRevision)
  schemaRef.current = schemaRevision

  const buildContext = (): LRContext => ({
    datasetId: datasetId ?? '',
    expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: schemaRevision,
    scope,
    activeRowIds: scope === 'active' ? selection.activeRowIds : undefined,
    selectedRowIds: scope === 'selected' ? selection.selectedRowIds : undefined,
    sampledRowIds: scope === 'sampled' ? obs.sampling.sampledRowIds : undefined,
    weightMode: weightChoice,
    missingPolicy,
  })

  const predictorIds = useMemo(() => [...numSel, ...catSel], [numSel, catSel])
  const canRun = Boolean(datasetId && target && predictorIds.length >= 1 && !predictorIds.includes(target ?? ''))

  const handleRun = async (): Promise<void> => {
    if (!datasetId || !target || !canRun) return
    const seq = ++runSequence.current
    const startedDataset = datasetId
    setLoading(true)
    setError(null)
    try {
      const predictors = [
        ...numSel.map((id) => {
          const info = colById.get(id)
          const isOrdinal = info?.scaleType === 'ordinal'
          return {
            columnId: id, kind: 'numeric' as const,
            ordinalAsNumericAcknowledged: isOrdinal ? Boolean(ordinalAck[id]) : false,
            score: (isOrdinal && ordinalAck[id] ? 'ordered_rank' : null) as 'ordered_rank' | null,
          }
        }),
        ...catSel.map((id) => ({ columnId: id, kind: 'categorical' as const, referenceCategory: references[id] ?? null })),
      ]
      const res = await runLinearRegression(buildContext(), target, predictors, interactions, intercept, covariance, confidenceLevel)
      if (runSequence.current !== seq || selectionRef.current.datasetId !== startedDataset) return
      setResult(res)
      setSubmittedKey(draftKey)
      setTab('figure')
      setRows([])
      setRowsResultId(null)
      setPredictRows([])
      setPredictTotal(0)
      setPredictResultId(null)
      setPredictId(null)
      setPredictInfo(null)
      setPredictError(null)
      setMatSource('fit')
      setMatField((f) => {
        const fields = res.capabilities.materializeFitFields
        return fields.includes(f) ? f : (fields[0] ?? '')
      })
      void fetchRows(res.resultId)
    } catch (err) {
      if (runSequence.current !== seq) return
      setError(apiErrorMessage(err, '重回帰分析に失敗しました。'))
    } finally {
      if (runSequence.current === seq) setLoading(false)
    }
  }

  const fetchRows = async (resultId: string): Promise<void> => {
    const seq = runSequence.current
    setRowsLoading(true)
    setRowsError(null)
    try {
      const out: typeof rows = []
      let offset: number | null = 0
      let total = 0
      while (offset !== null) {
        const page = await fetchLinearRegressionRows(resultId, offset, 5000)
        total = page.total
        out.push(...page.rows)
        offset = page.nextOffset
      }
      if (runSequence.current !== seq) return
      setRows(out)
      setRowsTotal(total)
      setRowsResultId(resultId)
    } catch (err) {
      if (runSequence.current !== seq) return
      setRows([])
      setRowsResultId(null)
      setRowsError(apiErrorMessage(err, '行の取得に失敗しました。'))
    } finally {
      if (runSequence.current === seq) setRowsLoading(false)
    }
  }
  const figurePoints = useMemo(() => {
    const pts: { rowId: string; x: number; y: number; title: string }[] = []
    for (const r of rows) {
      const fx = diagField === 'fitted' ? r.fitted : diagField === 'residual' ? r.residual : (r.leverageTotal ?? r.leveragePerReplica)
      const fy = r.residual
      if (fx === null || fx === undefined || fy === null || fy === undefined || !Number.isFinite(fx) || !Number.isFinite(fy)) continue
      pts.push({ rowId: r.rowId, x: fx, y: fy, title: `${r.rowId} 適合=${r.fitted === null ? '—' : r.fitted.toFixed(3)} 残差=${r.residual === null ? '—' : r.residual.toFixed(3)}` })
    }
    return pts
  }, [rows, diagField])

  const selectedSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])
  const highlightedSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])

  const handleToggle = async (rowId: string): Promise<void> => {
    if (!result || !datasetId || !rowsReady) {
      setSelectInfo('行の取得が完了してから選択してください。')
      return
    }
    if (selection.dataRevision !== result.meta.dataRevision
      || schemaRevision !== result.meta.schemaRevision) {
      setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。')
      return
    }
    const seq = runSequence.current
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    try {
      const res = await selectLinearRegression(result.resultId, buildContext(), {
        kind: 'row_ids', rowIds: [rowId],
      })
      if (runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation: getBrushOp(), label: res.selectionLabel || '重回帰 図の点選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${res.contextIntersectionCount}`)
    } catch (err) {
      if (runSequence.current !== seq) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (runSequence.current === seq) setSelecting(false)
    }
  }

  const handleBrush = async (bounds: { x: [number, number]; y: [number, number] }): Promise<void> => {
    if (!result || !datasetId) return
    if (!rowsReady) {
      setSelectInfo('行の取得が完了してから選択してください。')
      return
    }
    if (selection.dataRevision !== result.meta.dataRevision
      || schemaRevision !== result.meta.schemaRevision) {
      setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。')
      return
    }
    const seq = runSequence.current
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    setSelectInfo(null)
    try {
      const res = await selectLinearRegression(result.resultId, buildContext(), {
        kind: 'diagnostic_rectangle',
        xField: diagField === 'leverage' ? 'leverage' : diagField,
        yField: 'residual',
        xBounds: bounds.x, yBounds: bounds.y,
      })
      if (runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation: getBrushOp(), label: res.selectionLabel || '重回帰 診断図の選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${res.contextIntersectionCount}`)
    } catch (err) {
      if (runSequence.current !== seq) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (runSequence.current === seq) setSelecting(false)
    }
  }

  const handlePredict = async (): Promise<void> => {
    if (!datasetId || !result) return
    const seq = ++runSequence.current
    const startedDataset = datasetId
    setPredicting(true)
    setPredictError(null)
    setPredictInfo(null)
    try {
      const pctx: LRContext = {
        datasetId, expectedDataRevision: selection.dataRevision, expectedSchemaRevision: schemaRevision,
        scope: predictScope,
        activeRowIds: predictScope === 'active' ? selection.activeRowIds : undefined,
        selectedRowIds: predictScope === 'selected' ? selection.selectedRowIds : undefined,
        sampledRowIds: predictScope === 'sampled' ? obs.sampling.sampledRowIds : undefined,
        weightMode: weightChoice, missingPolicy,
      }
      const res = await predictLinearRegression(result.resultId, pctx, predictInterval, true)
      if (runSequence.current !== seq || selectionRef.current.datasetId !== startedDataset) return
      const out: LRPredictRow[] = []
      let offset: number | null = 0
      let total = 0
      while (offset !== null) {
        const page = await fetchLinearRegressionPredictions(result.resultId, res.predictionId, offset, 5000)
        total = page.total
        out.push(...page.rows)
        offset = page.nextOffset
      }
      if (runSequence.current !== seq) return
      setPredictRows(out)
      setPredictTotal(total)
      setPredictResultId(result.resultId)
      setPredictId(res.predictionId)
      const ev = res.summary.evaluation
      setPredictInfo(`成功${res.summary.successfulPredictions}/${res.summary.requestedCount}` + (ev && ev.metrics ? ` RMSE=${ev.metrics.rmse === null ? '—' : ev.metrics.rmse.toFixed(4)}` : ''))
      setMatSource(res.predictionId)
      setMatField((f) => {
        const fields = result.capabilities.materializePredictionFields
        return fields.includes(f) ? f : (fields[0] ?? '')
      })
    } catch (err) {
      if (runSequence.current !== seq) return
      setPredictError(apiErrorMessage(err, '予測に失敗しました。'))
    } finally {
      if (runSequence.current === seq) setPredicting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!datasetId || !result) return
    setSaving(true)
    try {
      const res = await materializeLinearRegression(result.resultId, buildContext(), matSource, [{ sourceField: matField, name: matName }], `lr-${result.resultId}-${matSource}-${matField}-${matName}`)
      message.success(`保存しました: ${res.createdColumns.map((c) => c.name).join(', ')}`)
      invalidateColumnarCache()
      dispatch(datasetValuesUpdated({ datasetId, dataRevision: res.dataRevision }))
      await dispatch(fetchCodebookThunk(datasetId))
    } catch (err) {
      message.error(apiErrorMessage(err, '保存に失敗しました。'))
    } finally {
      setSaving(false)
    }
  }

  const coefColumns = [
    { title: '係数', dataIndex: 'label', key: 'label' },
    { title: '推定値', dataIndex: 'estimate', key: 'estimate', render: (v: number) => (typeof v === 'number' ? v.toFixed(4) : '—') },
    { title: 'SE', dataIndex: 'standardError', key: 'se', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
    { title: 't', dataIndex: 'statistic', key: 't', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
    { title: 'p', dataIndex: 'pValue', key: 'p', render: (v: number | null) => (v === null || v === undefined ? '—' : (v === 0 ? 'p<1e-300' : v.toExponential(2))) },
    { title: 'CI下限', dataIndex: 'ciLower', key: 'cil', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
    { title: 'CI上限', dataIndex: 'ciUpper', key: 'ciu', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
    { title: '標準化', dataIndex: 'standardizedEstimate', key: 'std', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
  ]

  const s = result?.summary
  const stale = result !== null && (result.meta.resultState === 'stale'
    || selection.dataRevision !== result.meta.dataRevision
    || schemaRevision !== result.meta.schemaRevision)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card title="重回帰分析" size="small">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '8px 16px', alignItems: 'start' }}>
          <Space wrap style={{ gridColumn: '1 / -1' }}>
            <span>対象:</span>
            <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)}>
              <Radio.Button value="all">全体</Radio.Button>
              <Radio.Button value="active">Active</Radio.Button>
              <Radio.Button value="selected">Selected</Radio.Button>
              <Radio.Button value="sampled">標本</Radio.Button>
            </Radio.Group>
            <span>重み:</span>
            <Radio.Group value={weightChoice} onChange={(e) => setWeightChoice(e.target.value)}>
              <Radio.Button value="dataset">データ設定</Radio.Button>
              <Radio.Button value="none">なし</Radio.Button>
            </Radio.Group>
            <span>欠損:</span>
            <SelectSetting value={missingPolicy} onChange={setMissingPolicy} style={{ width: 160 }} options={[
              { value: 'exclude', label: '除外' },
              { value: 'include_missing', label: '欠損カテゴリ' },
              { value: 'separate_not_applicable', label: '非該当を分離' },
            ]} />
          </Space>
          <Space wrap style={{ minWidth: 0 }}>
            <span>目的変数:</span>
            <SelectColumn value={target} onChange={setTarget} options={targetOptions} placeholder="目的変数を選択" style={{ width: 280 }} />
          </Space>
          <Space wrap style={{ minWidth: 0 }}>
            <span>数値説明変数:</span>
            <SelectColumn mode="multiple" value={numSel} onChange={setNumSel} style={{ width: 320 }} options={numericOptions} placeholder="数値を選択" />
          </Space>
          {numSel.filter((id) => colById.get(id)?.scaleType === 'ordinal').map((id) => (
            <Space key={id} style={{ minWidth: 0 }}>
              <Checkbox checked={Boolean(ordinalAck[id])} onChange={(e) => setOrdinalAck({ ...ordinalAck, [id]: e.target.checked })}>
                {colById.get(id)?.label ?? id} を順序得点として使用（等間隔仮定）
              </Checkbox>
            </Space>
          ))}
          <Space wrap style={{ minWidth: 0 }}>
            <span>カテゴリ説明変数:</span>
            <SelectColumn mode="multiple" value={catSel} onChange={setCatSel} style={{ width: 320 }} options={categoricalOptions} placeholder="カテゴリを選択" />
          </Space>
          {catSel.map((id) => (
            <Space key={id} style={{ minWidth: 0 }}>
              <span>{colById.get(id)?.label ?? id} の基準:</span>
              <SelectSetting
                value={references[id] ?? null}
                onChange={(v) => setReferences({ ...references, [id]: v ?? undefined })}
                style={{ width: 240 }}
                allowClear
                placeholder="自動（先頭水準）"
                options={(colById.get(id)?.categoryOrder ?? []).map((c) => ({ value: c, label: c }))}
              />
            </Space>
          ))}
          <Space wrap style={{ gridColumn: '1 / -1' }}>
            <span>交互作用:</span>
            <SelectColumn value={interDraft[0]} onChange={(v) => setInterDraft([v, interDraft[1]])} style={{ width: 200 }} allowClear placeholder="変数1" options={predictorIds.map((id) => ({ value: id, label: colById.get(id)?.label ?? id }))} />
            <span>×</span>
            <SelectColumn value={interDraft[1]} onChange={(v) => setInterDraft([interDraft[0], v ?? null])} style={{ width: 200 }} allowClear placeholder="変数2" options={predictorIds.map((id) => ({ value: id, label: colById.get(id)?.label ?? id }))} />
            <Button onClick={() => {
              if (interDraft[0] && interDraft[1] && interDraft[0] !== interDraft[1]) {
                setInteractions([...interactions, [interDraft[0], interDraft[1]]])
                setInterDraft([null, null])
              }
            }}>追加</Button>
            {interactions.map((pair, i) => (
              <Tag key={i} closable onClose={() => setInteractions(interactions.filter((_, j) => j !== i))}>{pair.join(' × ')}</Tag>
            ))}
          </Space>
          <Space wrap style={{ gridColumn: '1 / -1' }}>
            <Checkbox checked={intercept} onChange={(e) => setIntercept(e.target.checked)}>切片あり</Checkbox>
            <span>共分散:</span>
            <SelectSetting value={covariance} onChange={setCovariance} style={{ width: 160 }} options={[
              { value: 'auto', label: '自動' },
              { value: 'hc3', label: 'HC3' },
              { value: 'classical', label: 'classical' },
              { value: 'taylor', label: 'taylor' },
            ]} />
            <span>信頼水準:</span>
            <InputNumber value={confidenceLevel} onChange={(v) => setConfidenceLevel(typeof v === 'number' ? v : 0.95)} min={0.01} max={0.99} step={0.01} />
            <Button type="primary" onClick={() => void handleRun()} disabled={!canRun} loading={loading}>実行</Button>
            {dirty && <Tag color="orange">設定が変更されています。結果は前回実行分です</Tag>}
          </Space>
          {!canRun && <Typography.Text type="secondary">目的変数1列・説明変数1つ以上（目的変数と重複不可）を選択してください。</Typography.Text>}
        </div>
      </Card>

      {error && <Alert type="error" message={error} showIcon />}
      {loading && <Spin tip="計算中…" />}
      {result && (
        <Card
          size="small"
          title={`結果: ${s?.modelFormula ?? ''}`}
          extra={<span>共分散={s?.covarianceMethod} 参照df={s?.referenceDf === null || s?.referenceDf === undefined ? '—' : s.referenceDf}</span>}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {stale && <Alert type="warning" message="古い版の結果です（stale）。保存・予測・選択はできません。" showIcon />}
            {(s?.rSquaredType === 'uncentered') && <Alert type="info" message="切片なしのため R²・調整済R² は非中心化です。" showIcon />}
            {(result.meta.weightType === 'survey') && <Alert type="info" message="survey 近似: PSU未指定時は回答者を独立単位とした近似です。調整済R²・AIC/BICは提供しません。" showIcon />}
            {(s?.covarianceMethod === 'hc3') && <Alert type="info" message="HC3 は異分散に頑健ですがクラスター依存や選択バイアスの補正ではありません。" showIcon />}
            {result.meta.warnings.map((w) => (
              <Alert key={w.code} type="warning" message={`${w.message}（${w.code}）`} showIcon />
            ))}
            {Object.entries(result.unavailableReasons ?? {}).map(([path, r]) => (
              <Alert key={path} type="warning" message={`${r.message}（${r.code}）`} showIcon />
            ))}
            <Typography.Text>
              有効{s?.nDesignColumns}列 R²={s?.rSquared === null || s?.rSquared === undefined ? '—' : s.rSquared.toFixed(4)}
              （{s?.rSquaredType === 'uncentered' ? '非中心化' : '中心化'}）
              調整済={s?.adjustedRSquared === null || s?.adjustedRSquared === undefined ? '—' : s.adjustedRSquared.toFixed(4)}
              RMSE={s?.rmse === null || s?.rmse === undefined ? '—' : s.rmse.toFixed(4)}
              条件数={s?.conditionNumber === null || s?.conditionNumber === undefined ? '—' : s.conditionNumber.toExponential(2)}
            </Typography.Text>
            <Tabs activeKey={tab} onChange={setTab} items={[
              {
                key: 'figure', label: '診断図',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <GraphPanel
                      graphId="linear-regression/diagnostics"
                      title="残差診断散布図"
                      available={tab === 'figure'}
                      sizing="intrinsic"
                      intrinsicSize={{ width: 560, height: 400 }}
                      controls={(
                        <Space wrap>
                          <span>X軸:</span>
                          <Radio.Group value={diagField} onChange={(e) => setDiagField(e.target.value)}>
                            <Radio.Button value="fitted">適合値</Radio.Button>
                            <Radio.Button value="residual">残差</Radio.Button>
                            <Radio.Button value="leverage">leverage</Radio.Button>
                          </Radio.Group>
                          <SelectionMenu />
                          {selecting && <Spin size="small" />}
                          {selectInfo && <Typography.Text>{selectInfo}</Typography.Text>}
                          {rowsLoading && <Typography.Text type="secondary">行を取得中…</Typography.Text>}
                          {rowsError && <Alert type="error" message={rowsError} showIcon />}
                          {result && !rowsReady && !rowsLoading && (
                            <Typography.Text type="warning">行の取得が完了していないため選択できません。</Typography.Text>
                          )}
                        </Space>
                      )}
                    >
                      <LinearRegressionFigure
                        points={figurePoints}
                        xLabel={diagField === 'fitted' ? '適合値' : diagField === 'residual' ? '残差' : 'leverage'}
                        yLabel="残差"
                        selected={selectedSet}
                        highlighted={highlightedSet}
                        getColor={getColor}
                        onToggle={handleToggle}
                        onBrush={(b) => void handleBrush(b)}
                        svgRef={svgRef}
                        testId="lr-figure"
                      />
                    </GraphPanel>
                    <L1Legend />
                    <Space wrap>
                      <Button onClick={() => svgRef.current && downloadSvg(svgRef.current, `${result.resultId}-lr.svg`)}>SVG保存</Button>
                      <Button onClick={() => svgRef.current && downloadPng(svgRef.current, `${result.resultId}-lr.png`)}>PNG保存</Button>
                    </Space>
                  </Space>
                ),
              },
              {
                key: 'coef', label: '係数',
                children: (
                  <Table dataSource={result.details.coefficients} columns={coefColumns} rowKey="designColumnId" pagination={false} size="small" />
                ),
              },
              {
                key: 'vif', label: 'VIF',
                children: (
                  <Table
                    dataSource={result.details.vif}
                    columns={[
                      { title: '設計列', dataIndex: 'designColumnId', key: 'id' },
                      { title: 'VIF', dataIndex: 'value', key: 'v', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                      { title: '状態', dataIndex: 'status', key: 's' },
                    ]}
                    rowKey="designColumnId"
                    pagination={false}
                    size="small"
                  />
                ),
              },
              {
                key: 'predict', label: '予測・評価',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space wrap>
                      <span>予測対象:</span>
                      <Radio.Group value={predictScope} onChange={(e) => setPredictScope(e.target.value)}>
                        <Radio.Button value="all">全体</Radio.Button>
                        <Radio.Button value="active">Active</Radio.Button>
                        <Radio.Button value="selected">Selected</Radio.Button>
                        <Radio.Button value="sampled">標本</Radio.Button>
                      </Radio.Group>
                      <span>区間:</span>
                      <SelectSetting value={predictInterval} onChange={setPredictInterval} style={{ width: 200 }} options={[
                        { value: 'none', label: '点予測のみ' },
                        { value: 'mean_ci', label: '平均CI' },
                        { value: 'individual_pi', label: '個別PI' },
                      ]} />
                      <Button onClick={() => void handlePredict()} loading={predicting}>予測・評価</Button>
                      {predictInfo && predictResultId === result.resultId && <Typography.Text>{predictInfo}</Typography.Text>}
                    </Space>
                    {predictError && <Alert type="error" message={predictError} showIcon />}
                    {predictRows.length > 0 && predictResultId === result.resultId && (
                      <Table
                        dataSource={predictRows.slice(0, 50)}
                        columns={[
                          { title: 'rowId', dataIndex: 'rowId', key: 'id' },
                          { title: '予測', dataIndex: 'predicted', key: 'p', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: '観測', dataIndex: 'observed', key: 'o', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: '状態', dataIndex: 'predictionStatus', key: 's' },
                        ]}
                        rowKey="rowId"
                        pagination={false}
                        size="small"
                      />
                    )}
                    <Typography.Text type="secondary">学習重複を含む評価は汎化精度ではなく参考値です。因果効果として解釈しないでください。</Typography.Text>
                  </Space>
                ),
              },
              {
                key: 'save', label: '保存・出力',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space wrap>
                      <span>保存元:</span>
                      <SelectSetting
                        value={matSource}
                        onChange={handleMatSourceChange}
                        style={{ width: 200 }}
                        options={[
                          { value: 'fit', label: 'fit' },
                          ...((predictId !== null && predictResultId === result.resultId)
                            ? [{ value: predictId, label: `予測:${predictId.slice(0, 8)}` }]
                            : []),
                        ]}
                      />
                      <span>項目:</span>
                      <SelectSetting value={matField} onChange={setMatField} style={{ width: 220 }} options={(matSource === 'fit' ? result.capabilities.materializeFitFields : result.capabilities.materializePredictionFields).map((f) => ({ value: f, label: f }))} />
                      <span>列名:</span>
                      <Input
                        value={matName}
                        onChange={(e) => setMatName(e.target.value)}
                        style={{ width: 200 }}
                        placeholder="LR_FITTED"
                      />
                      <Button onClick={() => void handleSave()} loading={saving}>表示結果の列へ保存</Button>
                      <Button
                        onClick={() => { setTab('figure'); openWhenAvailable('linear-regression/diagnostics') }}
                      >
                        図へ移動
                      </Button>
                    </Space>
                    <Space wrap>
                      {(['coefficients', 'diagnostics', 'rows'] as const).map((t) => (
                        <span key={t}>
                          <Button size="small" onClick={() => void exportLinearRegressionTable(result.resultId, t, 'csv')}>{t} CSV</Button>
                          {' '}
                          <Button size="small" onClick={() => void exportLinearRegressionTable(result.resultId, t, 'json')}>{t} JSON</Button>
                        </span>
                      ))}
                    </Space>
                    <Typography.Text type="secondary">使用版・対象数・有効数・除外理由・重みの意味は結果メタ情報に表示されます。</Typography.Text>
                  </Space>
                ),
              },
            ]} />
          </Space>
        </Card>
      )}
    </div>
  )
}
