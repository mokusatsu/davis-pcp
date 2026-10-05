import { useEffect, useMemo, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Radio, Select, Space, Table, Tag, Typography } from 'antd'
import { selectOrdinaryVariables, type RootState } from '../../app/store'
import ColumnSelect from '../common/ColumnSelect'
import AsyncExportButton from '../common/AsyncExportButton'
import { AnalysisField, AnalysisRunRow, AnalysisSettings } from '../common/AnalysisSetup'
import { useRequestIdentity } from '../common/useRequestIdentity'
import { useCodebook } from '../dataset/useCodebookColumn'
import { AnalysisScopeSummary, captureAnalysisRunContext, useAnalysisScope, useAnalysisViewActive, type AnalysisScopeSnapshot } from '../selection/analysisScope'
import { downloadRegularizedArtifact, exportRegularizedPredict, fetchRegularizedPredictions, fetchRegularizedRows, predictRegularizedRegression, runRegularizedRegression } from './rrApi'
import type { RRAlgorithm, RRArtifact, RRCategory, RRCoefficient, RRContext, RRFitRow, RRLanguage, RRPage, RRPredictResponse, RRPredictRow, RRRequest, RRResponse } from './rrTypes'

const ALGORITHM_LABELS = { ridge: 'Ridge', lasso: 'Lasso', elasticnet: 'Elastic Net' }
const PAGE_SIZE = 50
const ARTIFACTS: { value: RRArtifact; label: string }[] = [
  { value: 'model', label: 'model.json' }, { value: 'code', label: 'Predict ソース' },
  { value: 'schema', label: 'input-schema.json' }, { value: 'readme', label: 'README' },
  { value: 'test_vectors', label: '合成テストデータ' }, { value: 'bundle', label: 'ZIP（任意）' },
]
function errorMessage(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null || !('message' in error)) return fallback
  return `${String(error.message)}${'code' in error && error.code ? `（${String(error.code)}）` : ''}`
}
export function categoryKey(category: RRCategory): string { return JSON.stringify([category.kind, category.code]) }
/** Significant digits never turn a small nonzero coefficient into a displayed exact zero. */
export function formatRegularizedNumber(value: number | null | undefined, precision = 8, scientific = false): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const digits = Number.isFinite(precision) ? Math.max(3, Math.min(17, Math.trunc(precision))) : 8
  return scientific ? value.toExponential(digits - 1) : Number(value.toPrecision(digits)).toString()
}
/** Display arithmetic only: do not manufacture zero for a nonzero product that underflows. */
export function regularizedDeltaEffect(coefficient: Pick<RRCoefficient, 'estimate' | 'estimateReason' | 'exactZero' | 'kind'>,
  delta: number | null): { value: number | null; reason: string | null } {
  if (coefficient.kind === 'categorical') return { value: null, reason: 'カテゴリは基準水準との差を参照してください。' }
  if (delta === null || !Number.isFinite(delta)) return { value: null, reason: 'Δxは有限の数値で指定してください。' }
  if (coefficient.kind === 'ordinal' && !Number.isInteger(delta)) return { value: null, reason: '順序得点のΔxは整数の段階差で指定してください。' }
  if (delta === 0) return { value: 0, reason: null }
  const estimate = coefficient.estimate
  if (estimate === null || !Number.isFinite(estimate)) return { value: null, reason: coefficient.estimateReason ?? '元単位の係数を有限値で表示できません。' }
  if (estimate === 0 && !coefficient.exactZero) return { value: null, reason: '非ゼロの学習係数が元単位表示でアンダーフローしています。' }
  const value = estimate * delta
  if (!Number.isFinite(value)) return { value: null, reason: 'b×Δxがオーバーフローするため表示できません。' }
  if (value === 0 && estimate !== 0) return { value: null, reason: 'b×Δxがアンダーフローするため表示できません（厳密なゼロではありません）。' }
  return { value, reason: null }
}
export function parseRegularizedCandidates(text: string, kind: 'lambda' | 'ratio'): { values: number[]; error: string | null } {
  const tokens = text.trim().split(/[,\s]+/).filter(Boolean)
  const validToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
  const values = tokens.map(Number)
  const limit = kind === 'lambda' ? 100 : 20
  if (!tokens.length || tokens.length > limit || tokens.some(token => !validToken.test(token))
    || values.some(value => !Number.isFinite(value) || (kind === 'lambda' ? value <= 0 : value < .01 || value >= 1))
    || new Set(values).size !== values.length) {
    return { values: [], error: kind === 'lambda'
      ? 'λ候補は重複のない有限の正数を1〜100個指定してください。'
      : 'ρ候補は重複のない0.01以上1未満の数を1〜20個指定してください。0はRidge、1はLassoを選択します。' }
  }
  return { values, error: null }
}
interface DisplayCoefficient extends RRCoefficient { displayEstimate: number | null; displayReason: string | null; isReference: boolean }
/** Re-expression is a pure display operation; canonical execution coefficients remain untouched. */
export function referenceDisplay(result: Pick<RRResponse, 'details'>, choices: Record<string, string>): {
  coefficients: DisplayCoefficient[]; intercept: number | null; interceptReason: string | null
} {
  const referenceRows = new Map<string, RRCoefficient>()
  for (const group of result.details.categoryReferences) {
    const key = choices[group.columnId] ?? categoryKey(group.reference)
    const row = result.details.coefficients.find(coefficient => coefficient.columnId === group.columnId
      && coefficient.category !== null && categoryKey(coefficient.category) === key)
    if (row) referenceRows.set(group.columnId, row)
  }
  let intercept = result.details.intercept.estimate
  let interceptReason = result.details.intercept.reason
  for (const row of referenceRows.values()) {
    if (intercept === null || row.estimate === null || !Number.isFinite(intercept + row.estimate)) {
      intercept = null
      interceptReason = '基準カテゴリで再表現した切片は有限値で表示できません。保存モデルの点予測を使用してください。'
    } else intercept += row.estimate
  }
  return {
    intercept, interceptReason,
    coefficients: result.details.coefficients.map(row => {
      const reference = referenceRows.get(row.columnId)
      if (row.kind !== 'categorical' || !reference) return { ...row, displayEstimate: row.estimate, displayReason: row.estimateReason, isReference: false }
      const isReference = row.designColumnId === reference.designColumnId
      const difference = row.estimate === null || reference.estimate === null ? null : row.estimate - reference.estimate
      const displayEstimate = isReference ? 0 : difference !== null && Number.isFinite(difference) ? difference : null
      return { ...row, displayEstimate, displayReason: displayEstimate === null ? '基準との差は有限値で表示できません。' : null, isReference }
    }),
  }
}

export default function RegularizedRegressionPanel(): JSX.Element {
  const viewActive = useAnalysisViewActive()
  const activeRef = useRef(viewActive)
  activeRef.current = viewActive
  const selection = useSelector((state: RootState) => state.selection)
  const globalVariables = useSelector(selectOrdinaryVariables)
  const { columns, schemaRevision, weightConfig, surveyDesign, isLoading: codebookLoading } = useCodebook()
  const scope = useAnalysisScope()
  const datasetId = selection.datasetId
  const identity = JSON.stringify([datasetId, selection.dataRevision, schemaRevision])
  const runRequest = useRequestIdentity(identity)
  const rowsRequest = useRequestIdentity(identity)
  const predictionRequest = useRequestIdentity(identity)
  const predictionRowsRequest = useRequestIdentity(identity)
  const runPending = useRef(false)
  const predictionPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const eligibleColumns = useMemo(() => {
    const active = new Set(globalVariables.activeVariableIds)
    return columns.filter(column => !column.multiResponseGroup
      && (!globalVariables.allVariables.length || active.has(column.name)))
  }, [columns, globalVariables.activeVariableIds, globalVariables.allVariables.length])
  const optionsFor = (scales: string[]) => eligibleColumns.filter(column => scales.includes(column.scaleType))
    .map(column => ({ value: column.columnId, label: column.name, questionName: column.name, questionText: column.label }))
  const targetOptions = optionsFor(['interval', 'ratio'])
  const numericOptions = optionsFor(['interval', 'ratio', 'ordinal'])
  const categoricalOptions = optionsFor(['nominal', 'ordinal'])
  const columnById = new Map(columns.map(column => [column.columnId, column]))

  const [target, setTarget] = useState<string | null>(null)
  const [numeric, setNumeric] = useState<string[]>([])
  const [categorical, setCategorical] = useState<string[]>([])
  const [ordinalAcknowledged, setOrdinalAcknowledged] = useState<Record<string, boolean>>({})
  const [weightChoice, setWeightChoice] = useState<'dataset' | 'none'>('dataset')
  const [missingPolicy, setMissingPolicy] = useState('exclude')
  const [intercept, setIntercept] = useState(true)
  const [standardize, setStandardize] = useState(true)
  const [lambdaValue, setLambdaValue] = useState<number | null>(0.1)
  const [algorithm, setAlgorithm] = useState<RRAlgorithm>('ridge')
  const [l1Ratio, setL1Ratio] = useState<number | null>(0.5)
  const [selectionMode, setSelectionMode] = useState<'manual' | 'cv'>('manual')
  const [folds, setFolds] = useState<number | null>(5)
  const [seed, setSeed] = useState<number | null>(42)
  const [lambdaGrid, setLambdaGrid] = useState('0.001, 0.01, 0.1, 1, 10')
  const [ratioGrid, setRatioGrid] = useState('0.1, 0.5, 0.9')
  const [independentRows, setIndependentRows] = useState(false)
  const [tolerance, setTolerance] = useState<number | null>(1e-8)
  const [maxIterations, setMaxIterations] = useState<number | null>(10000)
  const [completed, setCompleted] = useState<{ result: RRResponse; request: RRRequest; scope: AnalysisScopeSnapshot; draftKey: string } | null>(null)
  // Dataset changes are reflected before effects, so no old-dataset result can be exported for one render.
  const result = completed?.request.context.datasetId === datasetId ? completed.result : null
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [fitRows, setFitRows] = useState<RRPage<RRFitRow> & { resultId: string; page: number } | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [requestedFitPage, setRequestedFitPage] = useState(1)
  const [prediction, setPrediction] = useState<{ response: RRPredictResponse; scope: AnalysisScopeSnapshot; context: RRContext; evaluate: boolean } | null>(null)
  const [predictionRows, setPredictionRows] = useState<RRPage<RRPredictRow> & { predictionId: string; page: number } | null>(null)
  const [predicting, setPredicting] = useState(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [predictionRowsLoading, setPredictionRowsLoading] = useState(false)
  const [predictionRowsError, setPredictionRowsError] = useState<string | null>(null)
  const [requestedPredictionPage, setRequestedPredictionPage] = useState(1)
  const [evaluate, setEvaluate] = useState(false)
  const [displayMode, setDisplayMode] = useState<'original' | 'standardized' | 'both'>('original')
  const [displayReferences, setDisplayReferences] = useState<Record<string, string>>({})
  const [displayDelta, setDisplayDelta] = useState<number | null>(1)
  const [precision, setPrecision] = useState(8)
  const [scientific, setScientific] = useState(false)
  const [language, setLanguage] = useState<RRLanguage>('python')
  const currentResult = useRef(result)
  currentResult.current = result
  const currentDataset = useRef(datasetId)
  currentDataset.current = datasetId
  const exportIdentity = `${datasetId}:${result?.resultId ?? ''}:${language}`
  const currentExportIdentity = useRef(exportIdentity)
  currentExportIdentity.current = exportIdentity

  useEffect(() => {
    runPending.current = false
    predictionPending.current = false
    setLoading(false); setRowsLoading(false); setPredicting(false); setPredictionRowsLoading(false)
    setError(null); setPredictError(null); setNotice(null)
  }, [identity])
  useEffect(() => {
    setTarget(null); setNumeric([]); setCategorical([]); setOrdinalAcknowledged({})
    setCompleted(null); setFitRows(null); setPrediction(null); setPredictionRows(null)
    setRowsError(null); setPredictionRowsError(null); setDisplayReferences({})
    setWeightChoice('dataset'); setIndependentRows(false)
  }, [datasetId])

  const buildContext = (): RRContext => ({ datasetId: datasetId ?? '', expectedDataRevision: selection.dataRevision,
    expectedSchemaRevision: schemaRevision, ...scope.contextRows, weightMode: weightChoice, missingPolicy })
  const unavailableVariables = [
    ...(target && !targetOptions.some(option => option.value === target) ? [target] : []),
    ...numeric.filter(id => !numericOptions.some(option => option.value === id)),
    ...categorical.filter(id => !categoricalOptions.some(option => option.value === id)),
  ]
  const ordinalMissing = numeric.some(id => columnById.get(id)?.scaleType === 'ordinal' && !ordinalAcknowledged[id])
  const unsupportedWeight = weightChoice === 'dataset' && Boolean(weightConfig)
    && weightConfig?.weightType !== 'frequency'
  const weightError = unsupportedWeight ? weightConfig?.weightType === 'survey'
    ? '調査ウェイト（survey）は正則化回帰で未対応です。無加重へ自動で切り替えることはありません。'
    : '重みの種類が不明です。コードブックで frequency / survey を確認してください。' : null
  const validLambda = lambdaValue !== null && Number.isFinite(lambdaValue) && lambdaValue > 0
  const predictorIds = [...numeric, ...categorical]
  const validVariables = Boolean(datasetId && target && predictorIds.length && !predictorIds.includes(target)
    && new Set(predictorIds).size === predictorIds.length && !unavailableVariables.length && !ordinalMissing)
  const lambdaCandidates = parseRegularizedCandidates(lambdaGrid, 'lambda')
  const ratioCandidates = parseRegularizedCandidates(ratioGrid, 'ratio')
  const groupedCV = Boolean(surveyDesign?.psuColumnId || surveyDesign?.strataColumnId || surveyDesign?.replicateWeightColumnIds?.length)
  const validRatio = l1Ratio !== null && Number.isFinite(l1Ratio) && l1Ratio > 0 && l1Ratio < 1
  const validCV = folds !== null && Number.isInteger(folds) && folds >= 2 && folds <= 20
    && seed !== null && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295
    && !lambdaCandidates.error && (algorithm !== 'elasticnet' || !ratioCandidates.error)
    && lambdaCandidates.values.length * (algorithm === 'elasticnet' ? ratioCandidates.values.length : 1) * folds <= 2000
    && independentRows && !groupedCV
  const validSolver = tolerance !== null && Number.isFinite(tolerance) && tolerance > 0 && tolerance <= .1
    && maxIterations !== null && Number.isInteger(maxIterations) && maxIterations >= 100 && maxIterations <= 100000
  const canRun = validVariables && validSolver && !unsupportedWeight && !codebookLoading
    && (selectionMode === 'cv' ? validCV : validLambda && (algorithm !== 'elasticnet' || validRatio))
  const variableIssue = !datasetId ? 'データセットを選択してください。'
    : codebookLoading ? '変数の情報を読み込んでいます。'
      : !target ? '目的変数を1列選択してください。'
        : !predictorIds.length ? '数値またはカテゴリの説明変数を1つ以上選択してください。'
          : predictorIds.includes(target) ? '目的変数は説明変数に含められません。'
            : new Set(predictorIds).size !== predictorIds.length ? '同じ列を数値とカテゴリの両方に指定できません。'
              : unavailableVariables.length ? '使用列が共通選択から外れました。再指定してください。'
                : ordinalMissing ? '順序変数を数値として使うには、等間隔仮定を確認してください。' : null
  const settingsIssues = [
    weightError,
    selectionMode === 'manual' && !validLambda ? 'λ は有限の正の値が必要です。λ=0 は通常の重回帰（OLS）を選択してください。' : null,
    selectionMode === 'manual' && algorithm === 'elasticnet' && !validRatio
      ? 'Elastic Net のρは0より大きく1未満です。0はRidge、1はLassoを選択してください。' : null,
    selectionMode === 'cv' && groupedCV
      ? 'PSU・層・反復ウェイトの設定があるデータにランダム行CVは使えません。グループ依存に対応するCVは未実装です。' : null,
    selectionMode === 'cv' ? lambdaCandidates.error : null,
    selectionMode === 'cv' && algorithm === 'elasticnet' ? ratioCandidates.error : null,
    selectionMode === 'cv' && (folds === null || !Number.isInteger(folds) || folds < 2 || folds > 20)
      ? 'CVのfold数は2〜20の整数にしてください。' : null,
    selectionMode === 'cv' && (seed === null || !Number.isInteger(seed) || seed < 0 || seed > 4294967295)
      ? 'CVのseedは0〜4294967295の整数にしてください。' : null,
    selectionMode === 'cv' && folds !== null && lambdaCandidates.values.length * (algorithm === 'elasticnet' ? ratioCandidates.values.length : 1) * folds > 2000
      ? 'CVの候補数×fold数は合計2000 fits以内にしてください。' : null,
    selectionMode === 'cv' && !independentRows ? 'CVを使うには、各行を独立した観測として分割できることを確認してください。' : null,
    !validSolver ? '許容誤差は0より大きく0.1以下、最大反復回数は100〜100000の整数にしてください。' : null,
  ].filter((issue): issue is string => Boolean(issue))
  const settingsSummary = [
    selectionMode === 'manual' ? `手動 λ=${lambdaValue ?? '未指定'}（固定値・CV未使用）${algorithm === 'elasticnet' ? ` / ρ=${l1Ratio ?? '未指定'}` : ''}`
      : `CV ${folds ?? '未指定'}分割 / seed=${seed ?? '未指定'} / λ候補 ${lambdaCandidates.values.length}個${lambdaGrid !== '0.001, 0.01, 0.1, 1, 10' ? '（変更あり）' : ''}${algorithm === 'elasticnet' ? ` / ρ候補 ${ratioCandidates.values.length}個${ratioGrid !== '0.1, 0.5, 0.9' ? '（変更あり）' : ''}` : ''}`,
    standardize ? '標準化あり' : '標準化なし', intercept ? '切片あり' : '切片なし',
    weightChoice === 'none' ? '重みなし' : weightConfig ? `重み ${weightConfig.weightType ?? '不明'}` : 'データ重み未設定（無加重）',
    missingPolicy === 'exclude' ? '欠損を除外' : missingPolicy === 'include_missing' ? '欠損カテゴリ' : '非該当を分離',
    ...(tolerance !== 1e-8 || maxIterations !== 10000 ? [`許容誤差 ${tolerance ?? '未指定'} / 最大反復 ${maxIterations ?? '未指定'}`] : []),
  ].join(' / ')
  const draftKey = JSON.stringify([identity, target, numeric, categorical, ordinalAcknowledged, intercept, standardize,
    lambdaValue, missingPolicy, weightChoice, scope.scopeKey, unavailableVariables, weightConfig, surveyDesign,
    algorithm, l1Ratio, selectionMode, folds, seed, lambdaGrid, ratioGrid, independentRows, tolerance, maxIterations])
  const dirty = Boolean(result && completed && draftKey !== completed.draftKey)
  const stale = Boolean(result && (result.meta.resultState === 'stale' || result.meta.dataRevision !== selection.dataRevision
    || result.meta.schemaRevision !== schemaRevision))
  const display = result ? referenceDisplay(result, displayReferences) : null
  const format = (value: number | null | undefined) => formatRegularizedNumber(value, precision, scientific)

  const loadFitRows = async (source: RRResponse, page: number) => {
    if (!activeRef.current) return
    const isCurrent = rowsRequest.begin()
    setRowsLoading(true); setRowsError(null); setRequestedFitPage(page)
    try {
      const rows = await fetchRegularizedRows(source.resultId, (page - 1) * PAGE_SIZE, PAGE_SIZE)
      if (isCurrent() && currentResult.current?.resultId === source.resultId) setFitRows({ ...rows, resultId: source.resultId, page })
    } catch (failure) {
      if (isCurrent()) setRowsError(errorMessage(failure, '適合行を取得できませんでした。'))
    } finally { if (isCurrent()) setRowsLoading(false) }
  }
  useEffect(() => {
    setFitRows(null); setRowsError(null); setPrediction(null); setPredictionRows(null); setDisplayReferences({})
    setDisplayMode('original'); setDisplayDelta(1)
    setRequestedFitPage(1)
    // A completed fit owns these rows; scope and draft edits must not refetch or relabel them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.resultId])

  useEffect(() => {
    if (viewActive && result?.capabilities.rows
      && (fitRows?.resultId !== result.resultId || fitRows.page !== requestedFitPage)) {
      void loadFitRows(result, fitRows?.resultId === result.resultId ? requestedFitPage : 1)
    }
    return () => { rowsRequest.invalidate(); setRowsLoading(false) }
    // Activity resumes unfinished rows without resetting completed input/result/display state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewActive, result?.resultId])

  const handleRun = async () => {
    if (!canRun || !target || tolerance === null || maxIterations === null || runPending.current) return
    runPending.current = true
    const isCurrent = runRequest.begin()
    predictionRequest.invalidate(); predictionRowsRequest.invalidate(); rowsRequest.invalidate()
    predictionPending.current = false
    setPredicting(false); setPredictionRowsLoading(false); setRowsLoading(false)
    const request: RRRequest = captureAnalysisRunContext({
      context: buildContext(), target,
      predictors: [
        ...numeric.map(columnId => ({ columnId, kind: 'numeric' as const,
          ordinalAsNumericAcknowledged: columnById.get(columnId)?.scaleType === 'ordinal' && Boolean(ordinalAcknowledged[columnId]),
          score: columnById.get(columnId)?.scaleType === 'ordinal' ? 'ordered_rank' as const : null })),
        ...categorical.map(columnId => ({ columnId, kind: 'categorical' as const, referenceCategory: null })),
      ], algorithm, intercept, standardize,
      lambdaValue: selectionMode === 'manual' ? lambdaValue! : 0.1,
      l1Ratio: algorithm === 'elasticnet' && selectionMode === 'manual' ? l1Ratio! : 0.5,
      selection: selectionMode,
      cv: selectionMode === 'cv' ? { folds: folds!, seed: seed!, lambdaValues: lambdaCandidates.values,
        l1Ratios: algorithm === 'elasticnet' ? ratioCandidates.values : [0.5], independentRowsAcknowledged: true } : null,
      tolerance, maxIterations,
    })
    const startedScope = captureAnalysisRunContext(scope)
    setLoading(true); setError(null); setNotice(null)
    try {
      const response = await runRegularizedRegression(request)
      if (!isCurrent()) return
      if (!response.summary.convergence.converged) throw new Error('収束していない結果は完了として扱えません。設定を確認して再実行してください。')
      setDisplayMode('original'); setDisplayDelta(1); setDisplayReferences({})
      setCompleted({ result: captureAnalysisRunContext(response), request, scope: startedScope, draftKey })
    } catch (failure) {
      if (isCurrent()) setError(errorMessage(failure, '正則化回帰に失敗しました。'))
    } finally { if (isCurrent()) { runPending.current = false; setLoading(false) } }
  }
  const loadPredictionRows = async (source: RRPredictResponse, page: number) => {
    if (!activeRef.current) return
    const isCurrent = predictionRowsRequest.begin()
    setPredictionRowsLoading(true); setPredictionRowsError(null); setRequestedPredictionPage(page)
    try {
      const rows = await fetchRegularizedPredictions(source.resultId, source.predictionId, (page - 1) * PAGE_SIZE, PAGE_SIZE)
      if (isCurrent() && currentResult.current?.resultId === source.resultId) setPredictionRows({ ...rows, predictionId: source.predictionId, page })
    } catch (failure) {
      if (isCurrent()) setPredictionRowsError(errorMessage(failure, '予測行を取得できませんでした。'))
    } finally { if (isCurrent()) setPredictionRowsLoading(false) }
  }
  useEffect(() => {
    if (viewActive && prediction
      && (predictionRows?.predictionId !== prediction.response.predictionId || predictionRows.page !== requestedPredictionPage)) {
      void loadPredictionRows(prediction.response, predictionRows?.predictionId === prediction.response.predictionId ? requestedPredictionPage : 1)
    }
    return () => { predictionRowsRequest.invalidate(); setPredictionRowsLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewActive, prediction?.response.predictionId])
  const handlePredict = async () => {
    if (!result || stale || loading || predictionPending.current || unsupportedWeight) return
    const source = result
    const isCurrent = predictionRequest.begin()
    predictionRowsRequest.invalidate()
    predictionPending.current = true
    setPredicting(true); setPredictError(null); setPredictionRowsLoading(false)
    const context = captureAnalysisRunContext(buildContext())
    const startedScope = captureAnalysisRunContext(scope)
    try {
      const response = await predictRegularizedRegression(source.resultId, context, evaluate)
      if (!isCurrent() || currentResult.current?.resultId !== source.resultId) return
      setPrediction({ response, scope: startedScope, context, evaluate }); setPredictionRows(null)
      setRequestedPredictionPage(1)
    } catch (failure) {
      if (isCurrent()) setPredictError(errorMessage(failure, '点予測に失敗しました。'))
    } finally { if (isCurrent()) { predictionPending.current = false; setPredicting(false) } }
  }
  const cancelPending = () => {
    runRequest.invalidate(); predictionRequest.invalidate(); predictionRowsRequest.invalidate(); rowsRequest.invalidate()
    runPending.current = false; predictionPending.current = false
    setLoading(false); setPredicting(false); setRowsLoading(false); setPredictionRowsLoading(false)
    setNotice('結果の反映待ちをキャンセルしました。サーバー側の計算は完了する場合があります。前回の完了結果は保持しています。')
  }
  const exportArtifact = async (artifact: RRArtifact) => {
    if (!result) return
    const source = result
    const identity = source.portableModel.identity
    const startedExportIdentity = exportIdentity
    const exported = await exportRegularizedPredict(source.resultId, language, artifact, identity.modelVersion)
    if (!mounted.current || currentExportIdentity.current !== startedExportIdentity || currentResult.current?.resultId !== source.resultId || currentDataset.current !== source.meta.datasetId) return
    if (exported.modelId !== identity.modelId || exported.modelVersion !== identity.modelVersion || exported.contentHash !== identity.contentHash) {
      throw new Error('保存モデルの識別子・版・ハッシュが一致しません。出力を中止しました。')
    }
    downloadRegularizedArtifact(exported)
  }
  const scalarColumn = (title: string, dataIndex: string) => ({ title, dataIndex, key: dataIndex, render: format })
  const coefficientColumns = [
    { title: '説明変数・水準', dataIndex: 'label', key: 'label' },
    ...(displayMode !== 'standardized' ? [{ title: '元単位の係数 / 基準との差', key: 'estimate', render: (_: unknown, row: DisplayCoefficient) =>
      <span title={row.displayEstimate === null ? row.displayReason ?? undefined : String(row.displayEstimate)}>{format(row.displayEstimate)}{row.displayReason && <small> ({row.displayReason})</small>}</span> },
    { title: '単位', dataIndex: 'unit', key: 'unit' }] : []),
    ...(displayMode !== 'original' ? [{ title: '比較用標準化係数', key: 'standardized', render: (_: unknown, row: DisplayCoefficient) =>
      <span title={row.standardizedEstimate === null ? row.standardizedReason ?? undefined : String(row.standardizedEstimate)}>{format(row.standardizedEstimate)}{row.standardizedEstimate === null && <small> ({row.standardizedReason ?? 'カテゴリには定義しません'})</small>}</span> }] : []),
    { title: '予測値の変化の読み方', key: 'interpretation', render: (_: unknown, row: DisplayCoefficient) => {
      const input = result?.portableModel.inputs.find(item => item.columnId === row.columnId)
      if (row.kind === 'categorical') {
        const group = result?.details.categoryReferences.find(item => item.columnId === row.columnId)
        const reference = group?.levels.find(level => categoryKey(level) === (displayReferences[row.columnId] ?? categoryKey(group.reference)))
        return row.isReference ? `表示基準: ${reference?.label ?? '—'}` : `基準「${reference?.label ?? '—'}」からこの水準へ変わるときの差`
      }
      const original = row.kind === 'ordinal' ? '順序得点が1段階増加するとき' : `${input?.label ?? row.label} が1 ${input?.unit ?? '元単位'}増加するとき`
      const standardized = '説明変数が1 SD増加するとき、目的変数のSD単位で表した差'
      return displayMode === 'standardized' ? standardized : displayMode === 'both' ? `${original} / 標準化: ${standardized}` : original
    } },
    { title: 'Δxによる予測値の変化（元単位）', key: 'delta', render: (_: unknown, row: DisplayCoefficient) => {
      if (row.kind === 'categorical') return '基準との差を参照'
      const effect = regularizedDeltaEffect(row, displayDelta)
      return <span data-testid={`rr-delta-${row.designColumnId}`} title={effect.reason ?? String(effect.value)}>
        {format(effect.value)}{effect.value !== null && ` ${result?.portableModel.display.targetUnit ?? '目的変数の単位'}`}
        {effect.reason && <small> ({effect.reason})</small>}
      </span>
    } },
    { title: '状態', key: 'zero', render: (_: unknown, row: DisplayCoefficient) => <>
      {row.isReference && <Tag>基準（差 0）</Tag>}
      {row.exactZero && <Tag color="blue">学習係数が厳密に 0</Tag>}
      {!row.exactZero && row.estimate === 0 && <Tag>元単位表示で 0（学習係数は非ゼロ）</Tag>}
    </> },
  ]
  const activePrediction = prediction?.response.resultId === result?.resultId ? prediction : null
  const activeFitRows = fitRows?.resultId === result?.resultId ? fitRows : null
  const activePredictionRows = predictionRows?.predictionId === activePrediction?.response.predictionId ? predictionRows : null

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <Card title="正則化回帰" size="small" className="analysis-setup">
      <div className="analysis-form-stack">
        <AnalysisScopeSummary snapshot={result ? completed?.scope : null} />
        <div className="analysis-variable-grid">
          <AnalysisField label="目的変数" htmlFor="rr-target" help="予測したい連続の数値を1列選びます。">
            <ColumnSelect id="rr-target" aria-describedby="rr-target-help" aria-label="正則化の目的変数" placeholder="正則化の目的変数" value={target} onChange={setTarget} options={targetOptions} style={{ width: '100%' }} />
          </AnalysisField>
          <AnalysisField label="数値説明変数" htmlFor="rr-numeric" help="数値・カテゴリのいずれかから、説明変数を1つ以上選びます。">
            <ColumnSelect id="rr-numeric" aria-describedby="rr-numeric-help" aria-label="正則化の数値説明変数" placeholder="正則化の数値説明変数" mode="multiple" value={numeric} onChange={setNumeric} options={numericOptions} style={{ width: '100%' }} />
          </AnalysisField>
          <AnalysisField label="カテゴリ説明変数" htmlFor="rr-categorical" help="グループなどのカテゴリを選びます。使わない場合は空欄で構いません。">
            <ColumnSelect id="rr-categorical" aria-describedby="rr-categorical-help" aria-label="正則化のカテゴリ説明変数" placeholder="正則化のカテゴリ説明変数" mode="multiple" value={categorical} onChange={setCategorical} options={categoricalOptions} style={{ width: '100%' }} />
          </AnalysisField>
        </div>
        {numeric.filter(id => columnById.get(id)?.scaleType === 'ordinal').map(id => <Checkbox key={id} checked={Boolean(ordinalAcknowledged[id])}
          onChange={event => setOrdinalAcknowledged(previous => ({ ...previous, [id]: event.target.checked }))}>
          {columnById.get(id)?.label ?? id} を順序得点として使用（等間隔仮定）</Checkbox>)}
        <AnalysisField label="アルゴリズム" help="Ridgeは係数を縮小し、Lassoは変数の絞り込みも行います。Elastic Netは両方を組み合わせます。">
          <Radio.Group className="analysis-method-switch" aria-label="正則化アルゴリズム" value={algorithm} onChange={event => setAlgorithm(event.target.value)}>
            <Radio.Button value="ridge">Ridge</Radio.Button><Radio.Button value="lasso">Lasso</Radio.Button><Radio.Button value="elasticnet">Elastic Net</Radio.Button>
          </Radio.Group>
        </AnalysisField>
        <AnalysisSettings title="正則化の詳細設定" summary={settingsSummary} attention={settingsIssues.length > 0}>
          <Typography.Text type="secondary">初期設定はRidge・手動 λ=0.1・標準化ありです。λ=0.1は固定の初期値で、このデータに合わせて調整した値ではありません。</Typography.Text>
          <AnalysisField label="正則化強度の選び方" help="手動では指定した強度を使います。交差検証（CV）では候補を比較して強度を選びます。">
            <Radio.Group aria-label="正則化強度の選択" value={selectionMode} onChange={event => setSelectionMode(event.target.value)}>
              <Radio.Button value="manual">手動</Radio.Button><Radio.Button value="cv">交差検証（CV）</Radio.Button>
            </Radio.Group>
          </AnalysisField>
          {selectionMode === 'manual' && <div className="analysis-variable-grid">
            <AnalysisField label="正則化強度 λ" htmlFor="rr-lambda" help="大きいほど係数を強く縮小します。0より大きい値を指定します。">
              <InputNumber id="rr-lambda" aria-describedby="rr-lambda-help" aria-label="正則化強度 λ" value={lambdaValue} onChange={setLambdaValue} step={0.1} style={{ width: '100%' }} />
            </AnalysisField>
            {algorithm === 'elasticnet' && <AnalysisField label="L1比率 ρ" htmlFor="rr-ratio" help="0に近いほどRidge寄り、1に近いほどLasso寄りです。0と1の間を指定します。">
              <InputNumber id="rr-ratio" aria-describedby="rr-ratio-help" aria-label="L1比率 ρ" value={l1Ratio} onChange={setL1Ratio} step={0.1} style={{ width: '100%' }} />
            </AnalysisField>}
          </div>}
          {selectionMode === 'cv' && <div className="analysis-form-stack">
            <div className="analysis-variable-grid">
              <AnalysisField label="fold数" htmlFor="rr-folds" help="学習と検証に分ける数です。2〜20で指定します。">
                <InputNumber id="rr-folds" aria-describedby="rr-folds-help" aria-label="CV fold数" value={folds} onChange={setFolds} min={2} max={20} precision={0} style={{ width: '100%' }} />
              </AnalysisField>
              <AnalysisField label="seed" htmlFor="rr-seed" help="ランダム分割を再現するための整数です。">
                <InputNumber id="rr-seed" aria-describedby="rr-seed-help" aria-label="CV seed" value={seed} onChange={setSeed} min={0} max={4294967295} precision={0} style={{ width: '100%' }} />
              </AnalysisField>
              <AnalysisField label="λ候補（カンマ区切り）" htmlFor="rr-lambda-grid" help="比較する正の強度を指定します。候補数×fold数は合計2000以下です。">
                <Input id="rr-lambda-grid" aria-describedby="rr-lambda-grid-help" aria-label="CV λ候補" value={lambdaGrid} onChange={event => setLambdaGrid(event.target.value)} />
              </AnalysisField>
              {algorithm === 'elasticnet' && <AnalysisField label="ρ候補（カンマ区切り）" htmlFor="rr-ratio-grid" help="0.01以上1未満の比率を比較します。各λ候補と組み合わせます。">
                <Input id="rr-ratio-grid" aria-describedby="rr-ratio-grid-help" aria-label="CV ρ候補" value={ratioGrid} onChange={event => setRatioGrid(event.target.value)} />
              </AnalysisField>}
            </div>
            <Checkbox checked={independentRows} onChange={event => setIndependentRows(event.target.checked)}>各行を独立した観測としてランダムに分割してよいことを確認しました</Checkbox>
            <Typography.Text type="secondary">分割単位はデータの行です。frequencyの複製を別foldには分けません。foldの学習行だけで尺度・カテゴリを決め、検証加重SSE合計÷検証重み合計を最小化します。</Typography.Text>
            <Alert type="warning" message="既存の変換・補完列の上流処理について、CVの情報漏洩は検証できません。グループ・時系列・反復測定の依存がある場合はランダム行CVを使わないでください。" />
          </div>}
          <AnalysisField label="前処理" help="初期設定は説明変数の標準化あり・切片ありです。目的変数の標準化や欠損の補完は行いません。">
            <Space wrap>
              <Checkbox checked={intercept} onChange={event => setIntercept(event.target.checked)}>切片あり</Checkbox>
              <Checkbox checked={standardize} onChange={event => setStandardize(event.target.checked)}>説明変数を学習時に標準化</Checkbox>
            </Space>
          </AnalysisField>
          <div className="analysis-variable-grid">
            <AnalysisField label="重み" help="frequencyのウェイトに対応します。無加重へは自動で切り替えません。">
              <Radio.Group aria-label="正則化の重み" value={weightChoice} onChange={event => setWeightChoice(event.target.value)}>
                <Radio.Button value="dataset">データ設定</Radio.Button><Radio.Button value="none">なし（明示）</Radio.Button>
              </Radio.Group>
              <Typography.Text type="secondary">{weightChoice === 'none' ? '無加重' : weightConfig ? `${weightConfig.weightType ?? '不明'}: ${weightConfig.weightColumnId}` : 'データ重み未設定（無加重）'}</Typography.Text>
            </AnalysisField>
            <AnalysisField label="欠損の扱い" htmlFor="rr-missing" help="初期設定は欠損を含む行の除外です。カテゴリとして扱う方法にも変更できます。">
              <Select id="rr-missing" aria-describedby="rr-missing-help" aria-label="正則化の欠損処理" value={missingPolicy} onChange={setMissingPolicy} style={{ width: '100%' }} options={[
                { value: 'exclude', label: '欠損を除外' }, { value: 'include_missing', label: '欠損カテゴリ' },
                { value: 'separate_not_applicable', label: '非該当を分離' },
              ]} />
            </AnalysisField>
            <AnalysisField label="ソルバー許容誤差" htmlFor="rr-tolerance" help="収束判定の厳しさです。通常は初期値1e-8のまま使えます。">
              <InputNumber id="rr-tolerance" aria-describedby="rr-tolerance-help" aria-label="ソルバー許容誤差" value={tolerance} onChange={setTolerance} style={{ width: '100%' }} />
            </AnalysisField>
            <AnalysisField label="ソルバー最大反復回数" htmlFor="rr-iterations" help="計算の上限です。初期値は10000回です。">
              <InputNumber id="rr-iterations" aria-describedby="rr-iterations-help" aria-label="ソルバー最大反復回数" value={maxIterations} onChange={setMaxIterations} min={100} max={100000} precision={0} style={{ width: '100%' }} />
            </AnalysisField>
          </div>
        </AnalysisSettings>
        {weightChoice === 'none' && weightConfig && <Alert type="warning" message="明示的に無加重を選択しています。データに設定されたウェイトは学習・評価に使用しません。" showIcon />}
        <Typography.Text type="secondary">主効果のみ・点予測専用。既存の変換列は現在の値を入力に使用します。</Typography.Text>
        {settingsIssues.length > 0 && <Alert data-testid="rr-settings-issues" type="error" showIcon message={settingsIssues.join(' ')} />}
        {variableIssue && <Typography.Text type="secondary" role="status">{variableIssue}</Typography.Text>}
        {dirty && <Tag color="orange">対象または設定が変更されています。結果と出力は前回の完了モデルです</Tag>}
        <AnalysisRunRow>
          {(loading || predicting) && <Button onClick={cancelPending}>待機をキャンセル</Button>}
          <Button type="primary" data-testid="rr-run" disabled={!canRun || loading} loading={loading} onClick={() => void handleRun()}>正則化を実行</Button>
        </AnalysisRunRow>
      </div>
    </Card>
    {error && <Alert type="error" message={error} showIcon />}
    {notice && <Alert type="info" message={notice} />}
    {result && display && <>
      <Card title={`結果: ${ALGORITHM_LABELS[result.summary.algorithm]} / ${result.summary.targetLabel}`} size="small">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text data-testid="rr-model-identity">モデル {result.portableModel.identity.modelId} / 版 {result.portableModel.identity.modelVersion} / 結果 {result.resultId}</Typography.Text>
          <Typography.Text style={{ overflowWrap: 'anywhere' }}>SHA-256: {result.portableModel.identity.contentHash}</Typography.Text>
          <Typography.Text>この結果の対象: {completed?.scope.label} {result.meta.scopeCount}行 / 学習 {result.meta.fitCount}行 / 除外 {result.meta.excludedCount}行 / 重み {result.meta.weightApplied ? result.meta.weightType : 'なし'}</Typography.Text>
          {Object.entries(result.meta.exclusionCounts).length > 0 && <Typography.Text>除外理由: {Object.entries(result.meta.exclusionCounts).map(([reason, count]) => `${reason}: ${count}`).join(' / ')}</Typography.Text>}
          {stale && <Alert type="warning" message="古い版の完了モデルです（stale）。現在のデータへの予測は再実行が必要です。出力は表示中の保存モデルとその版を使用します。" showIcon />}
          {result.meta.warnings.map((warning, index) => <Alert key={`${warning.code}-${index}`} type="warning" message={`${warning.message}（${warning.code}）`} showIcon />)}
          <Typography.Text>保存された学習設定: 説明変数の標準化 {result.config.standardize ? 'あり' : 'なし'} / 学習切片 {result.config.intercept ? 'あり' : 'なし'} / 選択 {result.config.selection === 'cv' ? 'CV' : '手動'}</Typography.Text>
          <Typography.Text>λ={format(result.summary.lambdaValue)} / ρ={format(result.summary.l1Ratio)} / 学習列 {result.summary.nDesignColumns} / 収束 {result.summary.convergence.converged ? '済' : '未達'} / 反復 {result.summary.convergence.iterations ?? '—'} / dual gap {format(result.summary.convergence.dualGap)}</Typography.Text>
          <Typography.Text>学習内の記述指標: RMSE={format(result.summary.fitRmse)} / MAE={format(result.summary.fitMae)} / R²={format(result.summary.fitRSquared)}</Typography.Text>
          <Typography.Text type="secondary">学習内指標は汎化精度ではありません。正則化係数に OLS の有意差検定・信頼区間は付けません。</Typography.Text>
          <Space wrap><span>係数表示（再学習しません）:</span>
            <Radio.Group aria-label="係数の表示尺度" value={displayMode} onChange={event => setDisplayMode(event.target.value)}>
              <Radio.Button value="original">元単位</Radio.Button><Radio.Button value="standardized">比較用標準化</Radio.Button><Radio.Button value="both">両方</Radio.Button>
            </Radio.Group>
            <label>有効桁 <InputNumber aria-label="係数の有効桁" value={precision} min={3} max={17} precision={0} onChange={value => setPrecision(Math.max(3, Math.min(17, Math.trunc(value ?? 8))))} /></label>
            <Checkbox checked={scientific} onChange={event => setScientific(event.target.checked)}>科学表記</Checkbox>
          </Space>
          <Space wrap><label>表示用の増分 Δx <InputNumber key={result.resultId} aria-label="表示用の増分 Δx" value={displayDelta} onChange={setDisplayDelta} step={1} /></label>
            <Typography.Text type="secondary">数値は元単位、順序得点は整数の段階差。b×Δxを目的変数の元単位で表示します（再学習なし）。</Typography.Text>
          </Space>
          {(displayDelta === null || !Number.isFinite(displayDelta)) && <Alert type="warning" message="Δxは有限の数値で指定してください。保存モデルは変更されません。" />}
          <Typography.Text type="secondary">増分は他の入力を固定した差です。順序得点は実在する段階間で解釈し、学習範囲外への変化には注意してください。</Typography.Text>
          <Typography.Text data-testid="rr-intercept">元単位の表示切片: {format(display.intercept)} {result.portableModel.display.targetUnit ?? ''}{display.interceptReason && ` (${display.interceptReason})`}</Typography.Text>
          <Typography.Text type="secondary">係数は他の説明変数を固定した予測値の差です。因果効果を示すものではありません。</Typography.Text>
          <Typography.Text type="secondary">比較用標準化係数は b×SD(x)/SD(y) です。切片は常に元単位、カテゴリは基準との差で表示します。学習切片なしでも、表示切片には基準水準の寄与を含みます。厳密なゼロは丸め値ではなく学習係数で判定します。</Typography.Text>
          {result.details.categoryReferences.map(group => <Space key={group.columnId} wrap><span>{result.portableModel.inputs.find(input => input.columnId === group.columnId)?.label ?? group.columnId} の表示基準:</span>
            <Select aria-label={`${group.columnId} の表示基準`} value={displayReferences[group.columnId] ?? categoryKey(group.reference)} style={{ minWidth: 200 }}
              options={group.levels.map(level => ({ value: categoryKey(level), label: `${level.label} (${level.kind === 'value' ? level.code : level.kind})` }))}
              onChange={value => setDisplayReferences(previous => ({ ...previous, [group.columnId]: value }))} />
          </Space>)}
          <Table data-testid="rr-coefficients" dataSource={display.coefficients} columns={coefficientColumns} rowKey="designColumnId" pagination={{ pageSize: 50, showSizeChanger: false }} size="small" scroll={{ x: 'max-content' }} />
        </Space>
      </Card>
      {result.summary.cv && result.details.cv && <Card title="交差検証の結果（選択用）" size="small">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>選択λ={format(result.summary.cv.bestLambdaValue)} / 選択ρ={format(result.summary.cv.bestL1Ratio)} / 加重MSE={format(result.summary.cv.weightedMse)} / RMSE={format(result.summary.cv.rmse)}</Typography.Text>
          <Typography.Text>fold {result.summary.cv.folds} / seed {result.summary.cv.seed} / 候補 {result.summary.cv.candidateCount} / 無効候補 {result.summary.cv.invalidCandidateCount}</Typography.Text>
          <Typography.Text style={{ overflowWrap: 'anywhere' }}>分割 fingerprint: {result.summary.cv.assignmentFingerprint}</Typography.Text>
          <Typography.Text type="secondary">CVはハイパーパラメータの選択用です。最終モデルは選択した設定で全学習行に再適合します。同じCVで選んだ最小誤差は独立した汎化性能評価ではありません。</Typography.Text>
          <Table dataSource={result.details.cv.candidates} rowKey={row => `${row.lambdaValue}:${row.l1Ratio}`} size="small" scroll={{ x: 'max-content' }} pagination={{ pageSize: 10, showSizeChanger: false }}
            columns={[scalarColumn('λ', 'lambdaValue'), scalarColumn('ρ', 'l1Ratio'), scalarColumn('加重MSE', 'weightedMse'), scalarColumn('RMSE', 'rmse'),
              { title: '有効', dataIndex: 'valid', render: (valid: boolean) => valid ? '有効' : '無効' }, { title: '失敗fold数', dataIndex: 'failureCount' }]}
            expandable={{ expandedRowRender: candidate => <Table dataSource={candidate.folds} rowKey="fold" pagination={false} size="small" scroll={{ x: 'max-content' }}
              columns={[{ title: 'fold', dataIndex: 'fold' }, { title: '学習行数', dataIndex: 'trainCount' }, { title: '検証行数', dataIndex: 'validationCount' },
                scalarColumn('検証重み', 'validationWeight'), scalarColumn('加重SSE', 'weightedSse'), { title: '予測失敗数', dataIndex: 'failedPredictions' },
                { title: '収束', key: 'convergence', render: (_, fold) => fold.convergence ? (fold.convergence.converged ? '済' : '未達') : '—' },
                { title: '失敗理由', key: 'failure', render: (_, fold) => fold.failure ? `${fold.failure.message} (${fold.failure.code})` : '—' }]} /> }} />
          <details><summary>foldごとの前処理監査</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 420, overflow: 'auto' }}>{JSON.stringify(result.details.cv.foldAudits, null, 2)}</pre></details>
        </Space>
      </Card>}
      <Card title="適合行（保存された学習結果）" size="small">
        {rowsError && <Alert type="error" message={rowsError} action={<Button onClick={() => void loadFitRows(result, requestedFitPage)}>再試行</Button>} />}
        <Table dataSource={activeFitRows?.rows ?? []} loading={rowsLoading} rowKey="rowId" size="small" scroll={{ x: 'max-content' }}
          columns={[{ title: 'rowId', dataIndex: 'rowId' }, scalarColumn('観測', 'observed'), scalarColumn('適合', 'fitted'), scalarColumn('残差', 'residual')]}
          pagination={{ current: activeFitRows?.page ?? 1, total: activeFitRows?.total ?? 0, pageSize: PAGE_SIZE, showSizeChanger: false, onChange: page => void loadFitRows(result, page) }} />
      </Card>
      <Card title="保存モデルで点予測" size="small">
        <Space direction="vertical" style={{ width: '100%' }}>
          <AnalysisScopeSummary label="次回予測の対象" snapshot={activePrediction?.scope} />
          <Typography.Text>予測モデル: {result.portableModel.identity.modelId} / 版 {result.portableModel.identity.modelVersion}（未実行の学習設定は適用しません）</Typography.Text>
          <Typography.Text type="secondary">次回評価の重み: {weightChoice === 'none' ? '明示的に無加重' : weightConfig ? `${weightConfig.weightType}: ${weightConfig.weightColumnId}` : '無加重'}。予測変換には保存された欠損・カテゴリ規則を使います。</Typography.Text>
          <Space wrap><Checkbox checked={evaluate} onChange={event => setEvaluate(event.target.checked)}>観測された目的変数で評価する</Checkbox>
            <Button data-testid="rr-predict" disabled={stale || loading || unsupportedWeight || predicting} loading={predicting} onClick={() => void handlePredict()}>点予測</Button>
          </Space>
          {predictError && <Alert type="error" message={predictError} />}
          {activePrediction && <>
            <Typography.Text>この予測の評価: {activePrediction.evaluate ? `あり / 重み指定 ${activePrediction.context.weightMode === 'none' ? '明示的に無加重' : 'データ設定（実行時）'}` : 'なし'}</Typography.Text>
            <Typography.Text>対象 {activePrediction.response.summary.requestedCount} / 成功 {activePrediction.response.summary.successfulPredictions} / 失敗 {activePrediction.response.summary.failedPredictions}</Typography.Text>
            <Typography.Text>状態別: {Object.entries(activePrediction.response.summary.statusCounts).map(([status, count]) => `${status}: ${count}`).join(' / ')}</Typography.Text>
            {activePrediction.response.summary.evaluation && <Typography.Text>評価 {activePrediction.response.summary.evaluation.evaluatedCount} / 学習との重複 {activePrediction.response.summary.evaluation.fitOverlapCount} / 学習外 {activePrediction.response.summary.evaluation.nonFitEvaluationCount} / RMSE {format(activePrediction.response.summary.evaluation.metrics?.rmse)} / MAE {format(activePrediction.response.summary.evaluation.metrics?.mae)} / R² {format(activePrediction.response.summary.evaluation.metrics?.rSquared)}</Typography.Text>}
            {predictionRowsError && <Alert type="error" message={predictionRowsError} action={<Button onClick={() => void loadPredictionRows(activePrediction.response, requestedPredictionPage)}>再試行</Button>} />}
            <Table dataSource={activePredictionRows?.rows ?? []} loading={predictionRowsLoading} rowKey="rowId" size="small" scroll={{ x: 'max-content' }}
              columns={[{ title: 'rowId', dataIndex: 'rowId' }, scalarColumn('点予測', 'predicted'), scalarColumn('観測', 'observed'), scalarColumn('残差', 'residual'),
                { title: '状態', dataIndex: 'predictionStatus' }, { title: '警告', key: 'warnings', render: (_: unknown, row: RRPredictRow) => row.warnings.map(warning => warning.message ?? warning.code).join(' / ') }]}
              pagination={{ current: activePredictionRows?.page ?? 1, total: activePredictionRows?.total ?? 0, pageSize: PAGE_SIZE, showSizeChanger: false, onChange: page => void loadPredictionRows(activePrediction.response, page) }} />
          </>}
          <Typography.Text type="secondary">行ごとの失敗を保持し、成功行だけ点予測を返します。目的変数は予測に不要です。学習重複を含む評価は汎化精度ではありません。</Typography.Text>
        </Space>
      </Card>
      <Card title="Predict ファイル出力" size="small">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>出力元: {result.portableModel.identity.modelId} / 版 {result.portableModel.identity.modelVersion} / 結果 {result.resultId}</Typography.Text>
          <Typography.Text>保存された入力キー対応（読み取り専用）</Typography.Text>
          <Table data-testid="rr-input-mapping" dataSource={result.portableModel.inputs} rowKey="columnId" size="small" scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
              { title: 'columnId', dataIndex: 'columnId' }, { title: '列名', dataIndex: 'name' }, { title: 'ラベル', dataIndex: 'label' },
              { title: '外部入力キー', dataIndex: 'key' }, { title: '種類', dataIndex: 'kind', render: (kind: string) => ({ numeric: '数値', ordinal: '順序得点', categorical: 'カテゴリ' })[kind] ?? kind },
            ]} />
          <Typography.Text type="secondary">Predictはこの保存された外部入力キーで照合します。列ラベルからキーを推測したり、同じラベルの列を自動対応させたりしません。別のキーを使う場合は出力APIのcolumnMappingにcolumnId→入力キーを明示してください。この画面からは保存キーのまま出力します。</Typography.Text>
          <Select aria-label="Predict の言語" value={language} onChange={setLanguage} style={{ width: 180 }} options={[
            { value: 'python', label: 'Python' }, { value: 'javascript', label: 'JavaScript' }, { value: 'typescript', label: 'TypeScript' },
          ]} />
          <Space wrap>{ARTIFACTS.map(artifact => <AsyncExportButton key={artifact.value}
            exportKey={exportIdentity} disabled={!result.capabilities.exportPredict}
            statusLabel={artifact.label} onExport={() => exportArtifact(artifact.value)}>{artifact.label}</AsyncExportButton>)}</Space>
          <Typography.Text type="secondary">各ファイルを個別にダウンロードできます。入力スキーマの固定キー・カテゴリ・欠損規則を使用してください。テストデータは合成値で、学習行は含みません。変換列から元の生データを復元する機能はありません。</Typography.Text>
        </Space>
      </Card>
    </>}
  </div>
}
