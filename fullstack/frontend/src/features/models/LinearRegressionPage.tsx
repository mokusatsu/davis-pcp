import AsyncExportButton from '../common/AsyncExportButton'
import { useAnalysisScope, AnalysisScopeSummary, captureAnalysisRunContext, AnalysisViewActivityContext, useAnalysisViewActive, type AnalysisScopeSnapshot } from '../selection/analysisScope'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Radio, Select as SelectSetting, Space, Spin, Table, Tabs, Tag, Typography } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { selectionApplied, selectOrdinaryVariables } from '../../app/store'
import { editorModalOpened } from '../dataset/codebookSlice'
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
  selectLinearRegression, type LRContext, type LRPredictRow,
} from './lrApi'
import LinearRegressionFigure from './LinearRegressionFigure'
import { useScoreSaveRefresh } from './useScoreSaveRefresh'
import RegularizedRegressionPanel from './RegularizedRegressionPanel'
import { AnalysisField, AnalysisRunRow, AnalysisSettings } from '../common/AnalysisSetup'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}

export default function LinearRegressionPage(): JSX.Element {
  const active = useAnalysisViewActive()
  const { close } = useGraphExpansion()
  const [regularizedVisited, setRegularizedVisited] = useState(false)
  const [method, setMethod] = useState<'ols' | 'regularized'>('ols')
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Space wrap className="analysis-method-switch"><span>回帰の方法:</span>
      <Radio.Group aria-label="回帰の方法" value={method} onChange={event => { close(); setMethod(event.target.value); if (event.target.value === 'regularized') setRegularizedVisited(true) }}>
        <Radio.Button value="ols">通常の重回帰（OLS）</Radio.Button>
        <Radio.Button value="regularized">正則化回帰</Radio.Button>
      </Radio.Group>
    </Space>
    <div hidden={method !== 'ols'} data-testid="ols-panel"><AnalysisViewActivityContext.Provider value={active && method === 'ols'}>
      <OrdinaryLinearRegressionPanel />
    </AnalysisViewActivityContext.Provider></div>
    {regularizedVisited && <div hidden={method !== 'regularized'} data-testid="regularized-panel"><AnalysisViewActivityContext.Provider value={active && method === 'regularized'}>
      <RegularizedRegressionPanel />
    </AnalysisViewActivityContext.Provider></div>}
  </div>
}

function OrdinaryLinearRegressionPanel(): JSX.Element {
  const viewActive = useAnalysisViewActive()
  const activeRef = useRef(viewActive)
  activeRef.current = viewActive
  const rowsSequence = useRef(0)
  const { openWhenAvailable } = useGraphExpansion()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const analysisScope = useAnalysisScope()
  const codebook = useCodebook()
  const { columns, schemaRevision, weightConfig } = codebook
  const datasetId = selection.datasetId
  const { getColor } = useRowColorResolver()

  const globalVars = useSelector(selectOrdinaryVariables)
  const hasGlobalSignal = globalVars.allVariables.length > 0
  const activeSet = useMemo(() => new Set(globalVars.activeVariableIds), [globalVars.activeVariableIds])
  const targetOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.name, questionName: c.name, questionText: c.label, name: c.name })),
    [columns, activeSet, hasGlobalSignal],
  )
  const numericOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio', 'ordinal'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.name, questionName: c.name, questionText: c.label, name: c.name, scaleType: c.scaleType })),
    [columns, activeSet, hasGlobalSignal],
  )
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal'].includes(c.scaleType) && !c.multiResponseGroup
        && (!hasGlobalSignal || activeSet.has(c.name)))
      .map((c) => ({ value: c.columnId, label: c.name, questionName: c.name, questionText: c.label, name: c.name })),
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
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')
  const [tab, setTab] = useState('figure')
  const [diagField, setDiagField] = useState<'fitted' | 'residual' | 'leverage'>('fitted')

  const [completed, setCompleted] = useState<{ result: LRResponse; context: LRContext; snapshot: AnalysisScopeSnapshot } | null>(null)
  const result = completed?.result ?? null
  const resultContext = completed?.context
  const resultRef = useRef(result)
  resultRef.current = result
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
  const [predictInterval, setPredictInterval] = useState<'none' | 'mean_ci' | 'individual_pi'>('mean_ci')
  const [predicting, setPredicting] = useState(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [predictInfo, setPredictInfo] = useState<string | null>(null)
  const [predictRows, setPredictRows] = useState<LRPredictRow[]>([])
  const [, setPredictTotal] = useState(0)
  const [predictResultId, setPredictResultId] = useState<string | null>(null)
  const [predictId, setPredictId] = useState<string | null>(null)
  const [predictionContext, setPredictionContext] = useState<LRContext | null>(null)
  const [predictionScope, setPredictionScope] = useState<AnalysisScopeSnapshot | null>(null)
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
  const scoreSave = useScoreSaveRefresh(completed)
  const runSequence = useRef(0)
  const selectionSequence = useRef(0)
  const predictionSequence = useRef(0)
  const mounted = useRef(true)
  const activeWaiters = useRef(new Set<() => void>())
  const releaseActiveWaiters = () => { for (const resolve of activeWaiters.current) resolve(); activeWaiters.current.clear() }
  const waitUntilActive = async () => {
    if (activeRef.current || !mounted.current) return
    await new Promise<void>(resolve => { activeWaiters.current.add(resolve) })
  }
  useEffect(() => { if (viewActive) releaseActiveWaiters() }, [viewActive])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      releaseActiveWaiters()
      runSequence.current += 1
      selectionSequence.current += 1
      predictionSequence.current += 1
    }
  }, [])
  const svgRef = useRef<SVGSVGElement | null>(null)

  const unavailableVariables = [
    ...(target && !targetOptions.some(option => option.value === target) ? [target] : []),
    ...numSel.filter(id => !numericOptions.some(option => option.value === id)),
    ...catSel.filter(id => !categoricalOptions.some(option => option.value === id)),
  ]
  const draftKey = JSON.stringify([datasetId, target, numSel, catSel, ordinalAck, references, interactions, intercept, covariance, confidenceLevel, analysisScope.scopeKey, missingPolicy, weightChoice, selection.dataRevision, schemaRevision, unavailableVariables])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

  useEffect(() => {
    runSequence.current += 1
    predictionSequence.current += 1
    selectionSequence.current += 1
    releaseActiveWaiters()
    setCompleted(null)
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
    setPredictionContext(null)
    setPredictionScope(null)
    setPredicting(false)
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
    ...analysisScope.contextRows,
    weightMode: weightChoice,
    missingPolicy,
  })

  const predictorIds = useMemo(() => [...numSel, ...catSel], [numSel, catSel])
  const ordinalMissing = numSel.some(id => colById.get(id)?.scaleType === 'ordinal' && !ordinalAck[id])
  const variableIssue = !datasetId ? 'データセットを選択してください。'
    : !target ? '目的変数を1列選択してください。'
      : !predictorIds.length ? '数値またはカテゴリの説明変数を1つ以上選択してください。'
        : predictorIds.includes(target) ? '目的変数は説明変数に含められません。'
          : new Set(predictorIds).size !== predictorIds.length ? '同じ列を数値とカテゴリの両方に指定できません。'
            : unavailableVariables.length ? '使用列が共通選択から外れました。再指定してください。'
              : ordinalMissing ? '順序変数を数値として使うには、等間隔仮定を確認してください。' : null
  const surveyWeight = weightChoice === 'dataset' && weightConfig?.weightType === 'survey'
  const settingsIssues = [
    !Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1
      ? '信頼水準は0より大きく1未満の値にしてください。' : null,
    interactions.some(pair => pair.some(id => !predictorIds.includes(id)))
      ? '交互作用に、現在の説明変数にない列があります。交互作用を削除するか、説明変数に追加してください。' : null,
    new Set(interactions.map(pair => [...pair].sort().join('\u0000'))).size !== interactions.length
      ? '同じ交互作用が重複しています。詳細設定で重複を削除してください。' : null,
    catSel.some(id => references[id] !== undefined && !(colById.get(id)?.categoryOrder ?? []).includes(references[id]!))
      ? '指定した基準カテゴリが現在の列定義にありません。基準を再指定するか自動に戻してください。' : null,
    weightChoice === 'dataset' && weightConfig && !['frequency', 'survey'].includes(weightConfig.weightType ?? '')
      ? '重みの種類が不明です。コードブックの設定を確認するか、明示的に重みなしを選択してください。' : null,
    surveyWeight && ['hc3', 'classical'].includes(covariance)
      ? '調査ウェイトには共分散「自動」または「taylor」を選択してください。' : null,
    covariance === 'taylor' && !surveyWeight
      ? '共分散「taylor」にはデータ設定の調査ウェイトが必要です。' : null,
  ].filter((issue): issue is string => Boolean(issue))
  const canRun = !variableIssue && settingsIssues.length === 0
  const settingsSummary = [
    intercept ? '切片あり' : '切片なし',
    `共分散 ${covariance === 'auto' ? '自動' : covariance}`,
    `信頼水準 ${Number((confidenceLevel * 100).toFixed(2))}%`,
    weightChoice === 'none' ? '重みなし' : weightConfig ? `重み ${weightConfig.weightType ?? '不明'}` : 'データ重み未設定（無加重）',
    missingPolicy === 'exclude' ? '欠損を除外' : missingPolicy === 'include_missing' ? '欠損カテゴリ' : '非該当を分離',
    ...(interactions.length ? [`交互作用 ${interactions.length}件`] : []),
    ...(catSel.filter(id => references[id] !== undefined).length ? [`基準カテゴリ指定 ${catSel.filter(id => references[id] !== undefined).length}件`] : []),
  ].join(' / ')

  const handleRun = async (): Promise<void> => {
    if (!datasetId || !target || !canRun) return
    const seq = ++runSequence.current
    const startedDataset = datasetId
    const startedContext = captureAnalysisRunContext(buildContext())
    const startedScope = analysisScope
    selectionSequence.current += 1
    setSelecting(false)
    predictionSequence.current += 1
    setPredicting(false)
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
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
      const res = await runLinearRegression(startedContext, target, predictors, interactions, intercept, covariance, confidenceLevel)
      if (runSequence.current !== seq || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision || schemaRef.current !== startedSchemaRevision) return
      setCompleted({ result: res, context: startedContext, snapshot: startedScope })
      setSubmittedKey(draftKey)
      setTab('figure')
      setRows([])
      setRowsResultId(null)
      setPredictRows([])
      setPredictTotal(0)
      setPredictResultId(null)
      setPredictId(null)
      setPredictionContext(null)
      setPredictionScope(null)
      setPredicting(false)
      setPredictInfo(null)
      setPredictError(null)
      setMatSource('fit')
      setMatField((f) => {
        const fields = res.capabilities.materializeFitFields
        return fields.includes(f) ? f : (fields[0] ?? '')
      })
    } catch (err) {
      if (runSequence.current !== seq || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision || schemaRef.current !== startedSchemaRevision) return
      setError(apiErrorMessage(err, '重回帰分析に失敗しました。'))
    } finally {
      if (runSequence.current === seq) setLoading(false)
    }
  }

  const fetchRows = async (resultId: string, context: LRContext): Promise<void> => {
    if (!activeRef.current) return
    const rowSeq = ++rowsSequence.current
    const seq = runSequence.current
    const isCurrent = () => activeRef.current && rowsSequence.current === rowSeq && runSequence.current === seq && selectionRef.current.datasetId === context.datasetId
      && selectionRef.current.dataRevision === context.expectedDataRevision && schemaRef.current === context.expectedSchemaRevision
    setRowsLoading(true)
    setRowsError(null)
    try {
      const out: typeof rows = []
      let offset: number | null = 0
      let total = 0
      while (offset !== null) {
        const page = await fetchLinearRegressionRows(resultId, offset, 5000)
        if (!isCurrent()) return
        total = page.total
        out.push(...page.rows)
        offset = page.nextOffset
      }
      if (!isCurrent()) return
      setRows(out)
      setRowsTotal(total)
      setRowsResultId(resultId)
    } catch (err) {
      if (!isCurrent()) return
      setRows([])
      setRowsResultId(null)
      setRowsError(apiErrorMessage(err, '行の取得に失敗しました。'))
    } finally {
      if (rowsSequence.current === rowSeq) setRowsLoading(false)
    }
  }
  useEffect(() => {
    // A hidden method retains its fit; supplementary row requests resume only
    // when shown. Never continue paging or accept an obsolete hidden request.
    if (viewActive && result && resultContext && rowsResultId !== result.resultId) {
      void fetchRows(result.resultId, resultContext)
    }
    return () => { rowsSequence.current += 1; setRowsLoading(false) }
    // Rows belong to the completed fit, not to subsequent draft/scope edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewActive, result, resultContext])

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
    if (!result || !resultContext || loading || !datasetId || !rowsReady) {
      setSelectInfo('行の取得が完了してから選択してください。')
      return
    }
    if (selection.dataRevision !== result.meta.dataRevision
      || schemaRevision !== result.meta.schemaRevision) {
      setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。')
      return
    }
    // Preserve the interaction's operation while row IDs are resolved.
    const operation = getBrushOp()
    const seq = ++selectionSequence.current
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    try {
      const res = await selectLinearRegression(result.resultId, resultContext, {
        kind: 'row_ids', rowIds: [rowId],
      })
      if (selectionSequence.current !== seq || resultRef.current?.resultId !== result.resultId
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      const active = new Set(selectionRef.current.activeRowIds)
      const eligibleRows = res.rowIds.filter(id => active.has(id))
      const outsideActive = res.rowIds.length - eligibleRows.length
      dispatch(selectionApplied({ rowIds: eligibleRows, operation, label: res.selectionLabel || '重回帰 図の点選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${eligibleRows.length}${outsideActive ? ` / Active外 ${outsideActive}行` : ''}`)
    } catch (err) {
      if (selectionSequence.current !== seq || resultRef.current?.resultId !== result.resultId) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === seq) setSelecting(false)
    }
  }

  const handleBrush = async (bounds: { x: [number, number]; y: [number, number] }): Promise<void> => {
    if (!result || !resultContext || loading || !datasetId) return
    if (!rowsReady) {
      setSelectInfo('行の取得が完了してから選択してください。')
      return
    }
    if (selection.dataRevision !== result.meta.dataRevision
      || schemaRevision !== result.meta.schemaRevision) {
      setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。')
      return
    }
    // Preserve the interaction's operation while row IDs are resolved.
    const operation = getBrushOp()
    const seq = ++selectionSequence.current
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    setSelectInfo(null)
    try {
      const res = await selectLinearRegression(result.resultId, resultContext, {
        kind: 'diagnostic_rectangle',
        xField: diagField === 'leverage' ? 'leverage' : diagField,
        yField: 'residual',
        xBounds: bounds.x, yBounds: bounds.y,
      })
      if (selectionSequence.current !== seq || resultRef.current?.resultId !== result.resultId
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      const active = new Set(selectionRef.current.activeRowIds)
      const eligibleRows = res.rowIds.filter(id => active.has(id))
      const outsideActive = res.rowIds.length - eligibleRows.length
      dispatch(selectionApplied({ rowIds: eligibleRows, operation, label: res.selectionLabel || '重回帰 診断図の選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${eligibleRows.length}${outsideActive ? ` / Active外 ${outsideActive}行` : ''}`)
    } catch (err) {
      if (selectionSequence.current !== seq || resultRef.current?.resultId !== result.resultId) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === seq) setSelecting(false)
    }
  }

  const handlePredict = async (): Promise<void> => {
    if (!datasetId || !result || loading || stale) return
    const seq = ++predictionSequence.current
    const startedResultId = result.resultId
    const context = captureAnalysisRunContext(buildContext())
    const snapshot = analysisScope
    const isCurrent = () => seq === predictionSequence.current
      && resultRef.current?.resultId === startedResultId
      && selectionRef.current.datasetId === context.datasetId
      && selectionRef.current.dataRevision === context.expectedDataRevision
      && schemaRef.current === context.expectedSchemaRevision
    setPredicting(true)
    setPredictError(null)
    setPredictInfo(null)
    setPredictRows([])
    setPredictId(null)
    setPredictionContext(null)
    setPredictionScope(null)
    setPredictResultId(null)
    setMatSource('fit')
    try {
      const res = await predictLinearRegression(startedResultId, context, predictInterval, true)
      if (!isCurrent()) return
      const out: LRPredictRow[] = []
      let offset: number | null = 0
      let total = 0
      while (offset !== null) {
        await waitUntilActive()
        if (!isCurrent()) return
        const page = await fetchLinearRegressionPredictions(startedResultId, res.predictionId, offset, 5000)
        if (!isCurrent()) return
        total = page.total
        out.push(...page.rows)
        offset = page.nextOffset
      }
      setPredictRows(out)
      setPredictTotal(total)
      setPredictResultId(startedResultId)
      setPredictId(res.predictionId)
      setPredictionContext(context)
      setPredictionScope(snapshot)
      const ev = res.summary.evaluation
      setPredictInfo(`成功${res.summary.successfulPredictions}/${res.summary.requestedCount}` + (ev && ev.metrics ? ` RMSE=${ev.metrics.rmse === null ? '—' : ev.metrics.rmse.toFixed(4)}` : ''))
      setMatSource(res.predictionId)
      setMatField((f) => {
        const fields = result.capabilities.materializePredictionFields
        return fields.includes(f) ? f : (fields[0] ?? '')
      })
    } catch (err) {
      if (!isCurrent()) return
      setPredictError(apiErrorMessage(err, '予測に失敗しました。'))
    } finally {
      if (seq === predictionSequence.current) setPredicting(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!datasetId || !result || stale || loading || scoreSave.saving) return
    const context = matSource === 'fit' ? resultContext
      : matSource === predictId && predictResultId === result.resultId ? predictionContext : null
    if (!context) return
    const submittedResultId = result.resultId
    const submittedSource = matSource
    const submittedField = matField
    const submittedName = matName
    await scoreSave.save(submittedName, () => materializeLinearRegression(
      submittedResultId, context, submittedSource,
      [{ sourceField: submittedField, name: submittedName }],
      `lr-${submittedResultId}-${submittedSource}-${submittedField}-${submittedName}`,
    ), err => apiErrorMessage(err, '保存に失敗しました。'))
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
      <Card title="重回帰分析" size="small" className="analysis-setup">
        <div className="analysis-form-stack">
          <AnalysisScopeSummary snapshot={completed?.snapshot} />
          <div className="analysis-variable-grid">
            <AnalysisField label="目的変数" htmlFor="lr-target" help="予測・説明したい連続の数値を1列選びます。">
              <SelectColumn id="lr-target" aria-describedby="lr-target-help" roleName="重回帰の目的変数" value={target} onChange={setTarget} options={targetOptions} placeholder="目的変数を選択" style={{ width: '100%' }}
                emptyHint={{ roleLabel: '目的', reason: '目的変数の候補がありません。',
                  guidance: '共通の有効変数に含まれる、間隔・比率尺度の単一列が対象です。共通の変数選択とコードブックの尺度・複数回答（MA）設定を確認してください。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }} />
            </AnalysisField>
            <AnalysisField label="数値説明変数" htmlFor="lr-numeric" help="数値・カテゴリのいずれかから、説明変数を1つ以上選びます。">
              <SelectColumn id="lr-numeric" aria-describedby="lr-numeric-help" roleName="重回帰の数値説明変数" mode="multiple" value={numSel} onChange={setNumSel} style={{ width: '100%' }} options={numericOptions} placeholder="数値を選択"
                emptyHint={{ roleLabel: '数値説明', reason: '数値説明変数の候補がありません。',
                  guidance: '共通の有効変数に含まれる、間隔・比率・順序尺度の単一列が対象です。共通の変数選択とコードブックの尺度・複数回答（MA）設定を確認してください。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }} />
            </AnalysisField>
            <AnalysisField label="カテゴリ説明変数" htmlFor="lr-categorical" help="グループなどのカテゴリを選びます。使わない場合は空欄で構いません。">
              <SelectColumn id="lr-categorical" aria-describedby="lr-categorical-help" roleName="重回帰のカテゴリ説明変数" mode="multiple" value={catSel} onChange={setCatSel} style={{ width: '100%' }} options={categoricalOptions} placeholder="カテゴリを選択"
                emptyHint={{ roleLabel: 'カテゴリ説明', reason: 'カテゴリ説明変数の候補がありません。',
                  guidance: '共通の有効変数に含まれる、名義・順序尺度の単一列が対象です。共通の変数選択とコードブックの尺度・複数回答（MA）設定を確認してください。',
                  onOpenCodebook: () => dispatch(editorModalOpened()) }} />
            </AnalysisField>
          </div>
          {numSel.filter((id) => colById.get(id)?.scaleType === 'ordinal').map((id) => (
            <Checkbox key={id} checked={Boolean(ordinalAck[id])} onChange={(e) => setOrdinalAck({ ...ordinalAck, [id]: e.target.checked })}>
              {colById.get(id)?.label ?? id} を順序得点として使用（等間隔仮定）
            </Checkbox>
          ))}
          <AnalysisSettings title="回帰の詳細設定" summary={settingsSummary} attention={settingsIssues.length > 0}>
            <Typography.Text type="secondary">必要に応じて変更してください。標準設定は切片あり・共分散自動・信頼水準95%です。</Typography.Text>
            <div className="analysis-variable-grid">
              <AnalysisField label="重み" help="データ設定のウェイトを使います。無加重で分析する場合のみ「なし」を選びます。">
                <Radio.Group aria-label="重回帰の重み" value={weightChoice} onChange={(e) => setWeightChoice(e.target.value)}>
                  <Radio.Button value="dataset">データ設定</Radio.Button>
                  <Radio.Button value="none">なし</Radio.Button>
                </Radio.Group>
              </AnalysisField>
              <AnalysisField label="欠損の扱い" htmlFor="lr-missing" help="初期設定は欠損を含む行の除外です。カテゴリとして扱う方法にも変更できます。">
                <SelectSetting id="lr-missing" aria-describedby="lr-missing-help" value={missingPolicy} onChange={setMissingPolicy} style={{ width: '100%' }} options={[
                  { value: 'exclude', label: '除外' },
                  { value: 'include_missing', label: '欠損カテゴリ' },
                  { value: 'separate_not_applicable', label: '非該当を分離' },
                ]} />
              </AnalysisField>
              <AnalysisField label="共分散" htmlFor="lr-covariance" help="係数の標準誤差・信頼区間の計算方法です。自動では重みの種類に合わせて選びます。">
                <SelectSetting id="lr-covariance" aria-describedby="lr-covariance-help" value={covariance} onChange={setCovariance} style={{ width: '100%' }} options={[
                  { value: 'auto', label: '自動' }, { value: 'hc3', label: 'HC3' },
                  { value: 'classical', label: 'classical' }, { value: 'taylor', label: 'taylor' },
                ]} />
              </AnalysisField>
              <AnalysisField label="信頼水準" htmlFor="lr-confidence" help="0〜1で指定します。0.95は95%の信頼区間を表します。">
                <InputNumber id="lr-confidence" aria-describedby="lr-confidence-help" value={confidenceLevel} onChange={(v) => setConfidenceLevel(typeof v === 'number' ? v : 0.95)} min={0.01} max={0.99} step={0.01} style={{ width: '100%' }} />
              </AnalysisField>
            </div>
            <Checkbox checked={intercept} onChange={(e) => setIntercept(e.target.checked)}>切片あり</Checkbox>
            {catSel.length > 0 && <div className="analysis-variable-grid">
              {catSel.map((id) => (
                <AnalysisField key={id} label={`${colById.get(id)?.label ?? id} の基準`} htmlFor={`lr-reference-${id}`} help="係数を比較する基準カテゴリです。未指定では先頭水準を使います。">
                  <SelectSetting id={`lr-reference-${id}`} aria-describedby={`lr-reference-${id}-help`} value={references[id] ?? null}
                    onChange={(v) => setReferences({ ...references, [id]: v ?? undefined })}
                    style={{ width: '100%' }} allowClear placeholder="自動（先頭水準）"
                    options={(colById.get(id)?.categoryOrder ?? []).map((c) => ({ value: c, label: c }))} />
                </AnalysisField>
              ))}
            </div>}
            <AnalysisField label="交互作用" help="ある説明変数の効果が別の変数によって変わる場合に追加します。通常は空欄のまま実行できます。">
              <div className="analysis-inline-fields">
                <AnalysisField label="変数1" htmlFor="lr-interaction-first">
                  <SelectColumn id="lr-interaction-first" roleName="重回帰の交互作用の変数1" value={interDraft[0]} onChange={(v) => setInterDraft([v ?? null, interDraft[1]])} style={{ width: '100%' }} allowClear placeholder="変数1" options={predictorIds.map((id) => ({ value: id, label: colById.get(id)?.label ?? id }))}
                    emptyHint={{ roleLabel: '交互作用の変数1', reason: '交互作用の変数1の候補がありません。',
                      guidance: '先に数値説明変数またはカテゴリ説明変数を選択してください。説明変数の候補がない場合は、共通の変数選択とコードブックの尺度・複数回答（MA）設定を確認してください。',
                      onOpenCodebook: () => dispatch(editorModalOpened()) }} />
                </AnalysisField>
                <AnalysisField label="変数2" htmlFor="lr-interaction-second">
                  <SelectColumn id="lr-interaction-second" roleName="重回帰の交互作用の変数2" value={interDraft[1]} onChange={(v) => setInterDraft([interDraft[0], v ?? null])} style={{ width: '100%' }} allowClear placeholder="変数2" options={predictorIds.map((id) => ({ value: id, label: colById.get(id)?.label ?? id }))}
                    emptyHint={{ roleLabel: '交互作用の変数2', reason: '交互作用の変数2の候補がありません。',
                      guidance: '先に数値説明変数またはカテゴリ説明変数を選択してください。説明変数の候補がない場合は、共通の変数選択とコードブックの尺度・複数回答（MA）設定を確認してください。',
                      onOpenCodebook: () => dispatch(editorModalOpened()) }} />
                </AnalysisField>
                <Button disabled={!interDraft[0] || !interDraft[1] || interDraft[0] === interDraft[1]} onClick={() => {
                  if (interDraft[0] && interDraft[1] && interDraft[0] !== interDraft[1]) {
                    setInteractions([...interactions, [interDraft[0], interDraft[1]]])
                    setInterDraft([null, null])
                  }
                }}>追加</Button>
              </div>
              <Space wrap>{interactions.map((pair, i) => (
                <Tag key={i} closable onClose={() => setInteractions(interactions.filter((_, j) => j !== i))}>{pair.map(id => colById.get(id)?.name ?? id).join(' × ')}</Tag>
              ))}</Space>
            </AnalysisField>
          </AnalysisSettings>
          {settingsIssues.length > 0 && <Alert data-testid="lr-settings-issues" type="error" showIcon message={settingsIssues.join(' ')} />}
          {variableIssue && <Typography.Text type="secondary" role="status">{variableIssue}</Typography.Text>}
          {dirty && <Tag color="orange">対象または設定が変更されています。結果は前回実行分です</Tag>}
          <AnalysisRunRow>
            <Button data-testid="lr-run" type="primary" onClick={() => void handleRun()} disabled={!canRun} loading={loading}>実行</Button>
          </AnalysisRunRow>
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
            <Typography.Text>この結果の対象: {completed?.snapshot.label} {result.meta.scopeCount ?? completed?.snapshot.count}行 / 有効 {result.meta.fitCount ?? '—'}行</Typography.Text>
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
                      available={viewActive && tab === 'figure'}
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
                      {viewActive && <LinearRegressionFigure
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
                      />}
                    </GraphPanel>
                    <L1Legend />
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
                      <AnalysisScopeSummary label="次回予測の対象" snapshot={predictionScope} />
                      <span>区間:</span>
                      <SelectSetting value={predictInterval} onChange={setPredictInterval} style={{ width: 200 }} options={[
                        { value: 'none', label: '点予測のみ' },
                        { value: 'mean_ci', label: '平均CI' },
                        { value: 'individual_pi', label: '個別PI' },
                      ]} />
                      <Button onClick={() => void handlePredict()} disabled={stale || loading} loading={predicting}>予測・評価</Button>
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
                      <Button onClick={() => void handleSave()} disabled={stale || loading || scoreSave.saving || (matSource !== 'fit' && (!predictionContext || predictResultId !== result.resultId))} loading={scoreSave.saving}>表示結果の列へ保存</Button>
                      <Button
                        onClick={() => { setTab('figure'); openWhenAvailable('linear-regression/diagnostics') }}
                      >
                        図へ移動
                      </Button>
                    </Space>
                    <Space wrap>
                      {(['coefficients', 'diagnostics', 'rows'] as const).map((t) => (
                        <span key={t}>
                          <AsyncExportButton size="small" exportKey={result.resultId} statusLabel={`${t} CSV`} onExport={() => exportLinearRegressionTable(result.resultId, t, 'csv')}>{t} CSV</AsyncExportButton>
                          {' '}
                          <AsyncExportButton size="small" exportKey={result.resultId} statusLabel={`${t} JSON`} onExport={() => exportLinearRegressionTable(result.resultId, t, 'json')}>{t} JSON</AsyncExportButton>
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
      {scoreSave.notice}
    </div>
  )
}
