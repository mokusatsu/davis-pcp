import { useAnalysisScope, AnalysisScopeSummary, captureAnalysisRunContext } from '../selection/analysisScope'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Radio, Select as SelectSetting, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd'
import { store, type AppDispatch, type RootState } from '../../app/store'
import { datasetValuesUpdated, selectionApplied } from '../../app/store'
import { fetchCodebookThunk } from '../dataset/codebookSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'
import { useCodebook } from '../dataset/useCodebookColumn'
import GraphPanel from '../common/GraphPanel'
import { useGraphExpansion } from '../common/GraphExpansion'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import SelectColumn from '../common/ColumnSelect'
import L1Legend from '../common/L1Legend'
import { useRowColorResolver } from '../../theme/useRowColor'
import type { ConjointResponse } from './conjointTypes'
import ConjointFigure from './ConjointFigure'
import {
  downloadPng,
  downloadSvg,
  expandConjointScope,
  exportConjointTable,
  fetchConjointPredictions,
  fetchConjointRows,
  fetchConjointTable,
  materializeConjoint,
  predictConjoint,
  runConjoint,
  selectConjoint,
  simulateConjoint,
  type ConjointAttribute,
  type ConjointContext,
  type ConjointExpandScopeResponse,
  type ConjointFitRow,
  type ConjointPredictRow,
  type ConjointSimResult,
} from './conjointApi'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? `${msg}（${code}）` : msg
}
type ConjointInputSnapshot = { context: ConjointContext; scopeKey: string; label: string; count: number }

export default function ConjointPage(): JSX.Element {
  const { openWhenAvailable } = useGraphExpansion()
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const analysisScope = useAnalysisScope()
  const codebook = useCodebook()
  const { columns, schemaRevision } = codebook
  const datasetId = selection.datasetId
  const { getColor } = useRowColorResolver()
  const runSequence = useRef(0)
  const selectionSequence = useRef(0)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const schemaRef = useRef(schemaRevision)
  schemaRef.current = schemaRevision
  const [mode, setMode] = useState<'ratings' | 'choice' | 'ranking'>('choice')
  const [respondentCol, setRespondentCol] = useState<string | null>(null)
  const [taskCol, setTaskCol] = useState<string | null>(null)
  const [altCol, setAltCol] = useState<string | null>(null)
  const [responseCol, setResponseCol] = useState<string | null>(null)
  const [catAttrs, setCatAttrs] = useState<string[]>([])
  const [linAttrs, setLinAttrs] = useState<string[]>([])
  const [refLevels, setRefLevels] = useState<Record<string, string | undefined>>({})
  // G008-01: 下限・上限を独立した nullable 値として保持し、反対側を補正しない。
  const [utilLo, setUtilLo] = useState<Record<string, number | undefined>>({})
  const [utilHi, setUtilHi] = useState<Record<string, number | undefined>>({})
  const [availCol, setAvailCol] = useState<string | null>(null)
  const [optOutCol, setOptOutCol] = useState<string | null>(null)
  const [ratingEffects, setRatingEffects] = useState<'pooled' | 'respondent_fixed'>('pooled')
  // CJ-GUI-04: dataset を初期値とし、保存済み重みを尊重する（LR/MCAと同様）。
  const [weightMode, setWeightMode] = useState<'none' | 'dataset'>('dataset')
  const [priceAttr, setPriceAttr] = useState<string | null>(null)
  const [includeWtp, setIncludeWtp] = useState(false)
  const [result, setResult] = useState<ConjointResponse | null>(null)
  const [resultInput, setResultInput] = useState<ConjointInputSnapshot | null>(null)
  const [predictionInput, setPredictionInput] = useState<ConjointInputSnapshot | null>(null)
  const resultRef = useRef<ConjointResponse | null>(null)
  resultRef.current = result
  const [rowsResultId, setRowsResultId] = useState<string | null>(null)
  const [submittedKey, setSubmittedKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('figure')
  const [inputErrors, setInputErrors] = useState<string[]>([])
  const [selecting, setSelecting] = useState(false)
  const [selectInfo, setSelectInfo] = useState<string | null>(null)
  const [expanding, setExpanding] = useState(false)
  const [rows, setRows] = useState<ConjointFitRow[]>([])
  const [, setRowsTotal] = useState(0)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [simProfiles, setSimProfiles] = useState<{ key: number; alternativeId: string; values: Record<string, string>; optOut: boolean }[]>([])
  const [simResult, setSimResult] = useState<ConjointSimResult | null>(null)
  const [simResultId, setSimResultId] = useState<string | null>(null)
  const [simulating, setSimulating] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)
  const simSequence = useRef(0)
  // G006-05: 予測は fit の runSequence と独立した世代を使う。
  const predSequence = useRef(0)
  const [predicting, setPredicting] = useState(false)
  const [predictError, setPredictError] = useState<string | null>(null)
  const [predictInfo, setPredictInfo] = useState<string | null>(null)
  const [predictRows, setPredictRows] = useState<ConjointPredictRow[]>([])
  const [, setPredictTotal] = useState(0)
  const [predictResultId, setPredictResultId] = useState<string | null>(null)
  const [predictId, setPredictId] = useState<string | null>(null)
  const [matSource, setMatSource] = useState('fit')
  const [matField, setMatField] = useState('probability')
  const [matName, setMatName] = useState('CJ_PROB')
  const [saving, setSaving] = useState(false)
  const [expandInfo, setExpandInfo] = useState<(ConjointExpandScopeResponse & { originScopeKey: string }) | null>(null)
  const [expandError, setExpandError] = useState<string | null>(null)
  const expandSequence = useRef(0)
  const diagSequence = useRef(0)
  const saveSequence = useRef(0)
  const svgRef = useRef<SVGSVGElement | null>(null)

  const savedWeightColumnId = codebook.weightConfig?.weightColumnId ?? null
  const savedWeightType = codebook.weightConfig?.weightType ?? null
  const colById = useMemo(() => {
    const m = new Map<string, { name: string; label: string; scaleType: string; categoryOrder?: string[] }>()
    for (const c of columns) m.set(c.columnId, c as never)
    return m
  }, [columns])
  const colLabel = (id: string | null): string => {
    if (!id) return '—'
    const c = colById.get(id)
    return c ? (c.label ? `${c.label} (${c.name})` : c.name) : id
  }
  const idOptions = useMemo(
    () => columns
      .filter((c) => !c.multiResponseGroup)
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )
  const categoricalOptions = useMemo(
    () => columns
      .filter((c) => ['nominal', 'ordinal'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )
  const linearOptions = useMemo(
    () => columns
      .filter((c) => ['interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.columnId, label: c.label ? `${c.label} (${c.name})` : c.name })),
    [columns],
  )

  useEffect(() => {
    runSequence.current += 1
    selectionSequence.current += 1
    predSequence.current += 1
    simSequence.current += 1
    expandSequence.current += 1
    diagSequence.current += 1
    saveSequence.current += 1
    setResult(null)
    setResultInput(null)
    setPredictionInput(null)
    setSubmittedKey('')
    setError(null)
    setInputErrors([])
    setLoading(false)
    setPredicting(false)
    setSimulating(false)
    setExpanding(false)
    setSaving(false)
    setSelecting(false)
    setSelectInfo(null)
    setRows([])
    setRowsTotal(0)
    setRowsResultId(null)
    setRowsError(null)
    setSimResult(null)
    setSimResultId(null)
    setSimError(null)
    setPredictRows([])
    setPredictTotal(0)
    setPredictResultId(null)
    setPredictId(null)
    setPredictInfo(null)
    setPredictError(null)
    setDiag(null)
    setDiagResultId(null)
    setDiagError(null)
    setDiagLoading(false)
    setRowsLoading(false)
    setMatSource('fit')
    setRespondentCol(null)
    setTaskCol(null)
    setAltCol(null)
    setResponseCol(null)
    setCatAttrs([])
    setLinAttrs([])
    setAvailCol(null)
    setOptOutCol(null)
    setPriceAttr(null)
    setExpandInfo(null)
    setExpandError(null)
    // B020: unmountした旧インスタンスの非同期処理が画面通知・共有更新を
    // 実行しないよう、ライフサイクル終了時に全世代を進めて無効化する。
    // dataset切替で旧ConjointPageはunmountされる(KeepAliveOutletのkey)。
    // 旧refは最後の値を保持するため、応答後のガードだけでは旧保存・旧選択の
    // グローバル副作用(message・store dispatch)を防げない。
    return () => {
      runSequence.current += 1
      selectionSequence.current += 1
      predSequence.current += 1
      simSequence.current += 1
      expandSequence.current += 1
      diagSequence.current += 1
      saveSequence.current += 1
    }
  }, [datasetId])

  // Keep completed results visible as stale while refusing late old-revision work.
  useEffect(() => {
    runSequence.current += 1
    selectionSequence.current += 1
    predSequence.current += 1
    simSequence.current += 1
    expandSequence.current += 1
    diagSequence.current += 1
    setLoading(false)
    setRowsLoading(false)
    setPredicting(false)
    setSimulating(false)
    setExpanding(false)
    setSelecting(false)
    setDiagLoading(false)
  }, [selection.dataRevision, schemaRevision])

  const matchesContext = (context: ConjointContext) => selectionRef.current.datasetId === context.datasetId
    && selectionRef.current.dataRevision === context.expectedDataRevision
    && schemaRef.current === context.expectedSchemaRevision

  const buildContext = (): ConjointContext => ({
    datasetId: datasetId ?? '',
    expectedDataRevision: selection.dataRevision ?? 1,
    expectedSchemaRevision: schemaRevision ?? 1,
    ...analysisScope.contextRows,
    weightMode,
    missingPolicy: 'exclude',
  })

  const attributes: ConjointAttribute[] = [
    ...catAttrs.map((id) => ({
      columnId: id, kind: 'categorical' as const,
      referenceLevel: refLevels[id] ?? null,
    })),
    // G008-01: 両側が入力され下限＜上限のときだけ送信する。
    ...linAttrs.map((id) => {
      const lo = utilLo[id]
      const hi = utilHi[id]
      return {
        columnId: id, kind: 'linear' as const,
        utilityRange: (lo !== undefined && hi !== undefined && lo < hi
          ? [lo, hi] as [number, number] : null),
      }
    }),
  ]
  const mappingColumns: Record<string, string> = {}
  if (respondentCol) mappingColumns['respondentId'] = respondentCol
  if (taskCol) mappingColumns['taskId'] = taskCol
  if (altCol) mappingColumns['alternativeId'] = altCol
  if (responseCol) mappingColumns['response'] = responseCol
  if (availCol) mappingColumns['availability'] = availCol
  // G006-06: ratings では opt-out を送信しない（表示・canRun・送信を一致）。
  if (optOutCol && mode !== 'ratings') mappingColumns['optOutIndicator'] = optOutCol

  const draftKey = JSON.stringify([datasetId, mode, respondentCol, taskCol, altCol, responseCol,
    catAttrs, linAttrs, refLevels, utilLo, utilHi, availCol, optOutCol,
    ratingEffects, weightMode, priceAttr, includeWtp, analysisScope.scopeKey,
    selection.dataRevision, schemaRevision])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey
  // G009-01: 両方空欄は省略、両方入力かつ下限＜上限は有効、
  // 片側のみは未完成として実行不可にする。入力値を黙って捨てない。
  const rangeValid = linAttrs.every((id) => {
    const lo = utilLo[id]
    const hi = utilHi[id]
    if (lo === undefined && hi === undefined) return true
    if (lo === undefined || hi === undefined) return false
    return lo < hi
  })
  const canRun = Boolean(datasetId && respondentCol && taskCol && altCol && responseCol
    && attributes.length >= 1
    && !(new Set([...catAttrs, ...linAttrs]).size !== catAttrs.length + linAttrs.length)
    && !Object.values(mappingColumns).some((v) => attributes.some((a) => a.columnId === v))
    && rangeValid && analysisScope.count > 0)

  const handleRun = async (explicitIds?: string[]): Promise<void> => {
    if (!datasetId) return
    const errs: string[] = []
    if (!respondentCol || !taskCol || !altCol || !responseCol) errs.push('回答者・タスク・代替案・応答の各列を選択してください。')
    if (attributes.length < 1) errs.push('属性を1つ以上選択してください。')
    if (new Set([...catAttrs, ...linAttrs]).size !== catAttrs.length + linAttrs.length) errs.push('属性に重複があります。')
    if (Object.values(mappingColumns).some((v) => attributes.some((a) => a.columnId === v))) errs.push('属性列と mapping 列が重複しています。')
    for (const id of linAttrs) {
      const lo = utilLo[id]
      const hi = utilHi[id]
      // G009-01: 片側のみは未完成として実行不可にする。
      if ((lo === undefined) !== (hi === undefined)) {
        errs.push(`${colLabel(id)} の効用範囲は下限・上限の両方を入力してください（省略時は両方空欄）。`)
      } else if (lo !== undefined && hi !== undefined && !(lo < hi)) {
        errs.push(`${colLabel(id)} の効用範囲は下限＜上限にしてください。`)
      }
    }
    setInputErrors(errs)
    if (errs.length || !canRun) return
    const seq = ++runSequence.current
    selectionSequence.current += 1
    setSelecting(false)
    const startedDataset = datasetId
    const startedDataRev = selection.dataRevision
    const startedSchemaRev = schemaRevision
    const current = () => runSequence.current === seq && selectionRef.current.datasetId === startedDataset
      && selectionRef.current.dataRevision === startedDataRev && schemaRef.current === startedSchemaRev
    // G007-02/07/G008-03: fit開始時に旧予測・診断を失効させ、
    // 待機表示を解除する。診断の世代・結果IDも初期化する。
    predSequence.current += 1
    diagSequence.current += 1
    setPredicting(false)
    setPredictInfo(null)
    setPredictionInput(null)
    setPredictRows([])
    setPredictResultId(null)
    setPredictId(null)
    setPredictError(null)
    setDiag(null)
    setDiagResultId(null)
    setDiagLoading(false)
    setDiagError(null)
    // G007-07: fit開始時に行取得の待機表示を明示的に処理する。
    setRowsLoading(false)
    setLoading(true)
    setError(null)
    try {
      const ctx = explicitIds
        ? {
            ...buildContext(), scope: 'explicit' as const,
            rowIds: [...explicitIds],
            activeRowIds: undefined, selectedRowIds: undefined,
            sampledRowIds: undefined,
          }
        : buildContext()
      const input: ConjointInputSnapshot = { context: captureAnalysisRunContext(ctx), scopeKey: analysisScope.scopeKey,
        label: explicitIds ? `${analysisScope.label}からタスク全体へ拡張` : analysisScope.label, count: explicitIds?.length ?? analysisScope.count }
      const res = await runConjoint(
        input.context, mode, { ...mappingColumns }, attributes, ratingEffects,
        priceAttr,
      )
      if (!current()) return
      setRows([])
      setRowsResultId(null)
      setResult(res)
      setResultInput(input)
      setSubmittedKey(draftKey)
      setTab('figure')
      setMatSource('fit')
      setMatField((f) => {
        const fields = res.capabilities.materializeFitFields
        return fields.includes(f) ? f : (fields[0] ?? '')
      })
      void fetchRows(res.resultId, seq, input.context)
    } catch (err) {
      if (!current()) return
      setError(apiErrorMessage(err, 'コンジョイント分析に失敗しました。'))
    } finally {
      if (current()) setLoading(false)
    }
  }

  // G006-05: 行取得は開始した fit 世代にひもづける。行取得中の予測開始で
  // 無効化されないよう、fit 世代だけを見る（予測は独立世代）。
  const fetchRows = async (resultId: string, fitSeq: number, context: ConjointContext): Promise<void> => {
    const seq = fitSeq
    const current = () => runSequence.current === seq && matchesContext(context)
    setRowsLoading(true)
    setRowsError(null)
    try {
      const out: ConjointFitRow[] = []
      let offset: number | null = 0
      let total = 0
      while (offset !== null) {
        const pg: { total: number; nextOffset: number | null; rows: ConjointFitRow[] } = await fetchConjointRows(resultId, offset, 5000)
        if (!current()) return
        total = pg.total
        out.push(...pg.rows)
        offset = pg.nextOffset
      }
      if (!current()) return
      setRows(out)
      setRowsTotal(total)
      setRowsResultId(resultId)
    } catch (err) {
      if (!current()) return
      setRows([])
      setRowsResultId(null)
      setRowsError(apiErrorMessage(err, '行の取得に失敗しました。'))
    } finally {
      if (current()) setRowsLoading(false)
    }
  }

  const handleExpandScope = async (): Promise<void> => {
    if (!datasetId || !respondentCol || !taskCol || !altCol || !responseCol) {
      setExpandError('回答者・タスク・代替案・応答の各列を選択してください。')
      return
    }
    if (analysisScope.count === 0) { setExpandError('共通対象は0行です。上部で対象を変更してください。'); return }
    const eseq = ++expandSequence.current
    const startedDataset = datasetId
    setExpandError(null)
    setExpanding(true)
    try {
      const ctxSnapshot = captureAnalysisRunContext(buildContext())
      const res = await expandConjointScope(ctxSnapshot, { ...mappingColumns })
      if (expandSequence.current !== eseq
        || selectionRef.current.datasetId !== startedDataset || !matchesContext(ctxSnapshot)) return
      // G006-11: 拡張元の条件を保持し、設定変更時に失効させる。
      setExpandInfo({
        ...res,
        expandedRowIds: [...res.expandedRowIds],
        originScopeKey: analysisScope.scopeKey,
        mapping: { ...mappingColumns },
        scopeSnapshot: JSON.stringify([ctxSnapshot.weightMode, ctxSnapshot.missingPolicy]),
        dataRevision: selection.dataRevision ?? 1,
        schemaRevision,
      })
    } catch (err) {
      if (expandSequence.current !== eseq) return
      setExpandError(apiErrorMessage(err, 'スコープ拡張に失敗しました。'))
    } finally {
      if (expandSequence.current === eseq) setExpanding(false)
    }
  }

  const handleToggle = async (rowId: string): Promise<void> => {
    if (!result || !resultInput || !datasetId || !rowsReady || loading) {
      setSelectInfo('行の取得が完了してから選択してください。')
      return
    }
    if (selection.dataRevision !== result.meta.dataRevision
      || schemaRevision !== result.meta.schemaRevision) {
      setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。')
      return
    }
    const seq = runSequence.current
    const selectionSeq = ++selectionSequence.current
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    try {
      const res = await selectConjoint(result.resultId, resultInput!.context, {
        kind: 'row_ids', rowIds: [rowId],
      })
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation: 'toggle', label: res.selectionLabel || 'コンジョイント 図の点選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${res.contextIntersectionCount}`)
    } catch (err) {
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === selectionSeq && runSequence.current === seq) setSelecting(false)
    }
  }

  const handleRespondentSelect = async (respondentId: string): Promise<void> => {
    if (!result || !resultInput || !datasetId || !rowsReady || loading) {
      setSelectInfo('行の取得が完了してから選択してください。')
      return
    }
    if (selection.dataRevision !== result.meta.dataRevision
      || schemaRevision !== result.meta.schemaRevision) {
      setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。')
      return
    }
    const seq = runSequence.current
    const selectionSeq = ++selectionSequence.current
    const operation = getBrushOp()
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    try {
      const res = await selectConjoint(result.resultId, resultInput!.context, {
        kind: 'respondents', respondentIds: [respondentId],
      })
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation, label: res.selectionLabel || 'コンジョイント 回答者の全タスク選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${res.contextIntersectionCount}`)
    } catch (err) {
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === selectionSeq && runSequence.current === seq) setSelecting(false)
    }
  }

  const handleBrush = async (bounds: { x: [number, number]; y: [number, number] }): Promise<void> => {
    if (!result || !resultInput || !datasetId || loading) return
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
    const selectionSeq = ++selectionSequence.current
    const operation = getBrushOp()
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    setSelectInfo(null)
    try {
      // G007-01: ranking では Y を行順で描くため、範囲選択も行順で判定する。
      const withX = rows.filter((r) => {
        const fx = resultMode === 'ratings' ? r.predictedRating : r.probability
        return fx !== null && fx !== undefined && Number.isFinite(fx)
      })
      const inBox = withX
        .filter((r, i) => {
          const fx = (resultMode === 'ratings' ? r.predictedRating : r.probability) as number
          if (figureMode === 'ranking') {
            const y = i + 1
            return fx >= bounds.x[0] && fx <= bounds.x[1] && y >= bounds.y[0] && y <= bounds.y[1]
          }
          const fy = r.residual
          if (fy === null || fy === undefined) return false
          return fx >= bounds.x[0] && fx <= bounds.x[1] && fy >= bounds.y[0] && fy <= bounds.y[1]
        })
        .map((r) => r.rowId)
      const res = await selectConjoint(result.resultId, resultInput!.context, {
        kind: 'row_ids', rowIds: inBox,
      })
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation, label: res.selectionLabel || 'コンジョイント 図の範囲選択' }))
      setSelectInfo(`一致${res.matchedCount} / 適用${res.contextIntersectionCount}`)
    } catch (err) {
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === selectionSeq && runSequence.current === seq) setSelecting(false)
    }
  }

  // G006-02: シミュレーションは保存済みモデルの属性で組み立てる。
  // 設定欄の未実行変更（attributes）とは分離する。
  const simAttributes: { columnId: string; kind: string }[] = (() => {
    const det = result?.details as unknown as
      { attributes?: { columnId: string; kind: string }[] } | undefined
    if (det?.attributes && det.attributes.length > 0) return det.attributes
    return attributes
  })()
  const handleSimulate = async (): Promise<void> => {
    if (!datasetId || !result) return
    const seq = ++simSequence.current
    const startedDataset = datasetId
    setSimulating(true)
    setSimError(null)
    try {
      const ids = simProfiles.map((p) => p.alternativeId.trim()).filter((v) => v !== '')
      if (new Set(ids).size !== ids.length) {
        setSimError('代替案IDが重複しています。一意にしてください。')
        setSimulating(false)
        return
      }
      const cleaned = simProfiles
        .filter((p) => p.alternativeId.trim() !== '')
        .map((p) => ({
          alternativeId: p.alternativeId.trim(),
          values: Object.fromEntries(
            Object.entries(p.values)
              .filter(([, v]) => v !== '')
              .map(([k, v]) => {
                const attr = simAttributes.find((a) => a.columnId === k)
                if (attr?.kind === 'linear') {
                  const n = Number(v)
                  return [k, Number.isFinite(n) ? n : v]
                }
                return [k, v]
              }),
          ) as Record<string, string | number>,
          ...(p.optOut ? { optOut: true } : {}),
        }))
      const res = await simulateConjoint(
        result.resultId,
        {
          datasetId, expectedDataRevision: selection.dataRevision ?? 1,
          expectedSchemaRevision: schemaRevision ?? 1,
          scope: 'all', weightMode: 'none', missingPolicy: 'exclude',
        },
        cleaned, includeWtp,
      )
      if (simSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset) return
      setSimResult(res)
      setSimResultId(result.resultId)
    } catch (err) {
      if (simSequence.current !== seq) return
      setSimError(apiErrorMessage(err, 'シミュレーションに失敗しました。'))
    } finally {
      if (simSequence.current === seq) setSimulating(false)
    }
  }

  const handlePredict = async (): Promise<void> => {
    // G008-02: 再分析中に開始した旧モデル予測を失効させる。開始した fit
    // 世代・版を保持し、runSequence.current・ref と比較する。予測ボタンは
    // stale・loading 中も旧結果で押せるため、入口で fit 世代を記録する。
    if (!datasetId || !result || !resultInput || !matchesContext(resultInput.context) || loading || analysisScope.count === 0) return
    const seq = ++predSequence.current
    const startedDataset = datasetId
    const startedResultId = result.resultId
    const startedFitSeq = runSequence.current
    const startedDataRev = selectionRef.current.dataRevision
    const startedSchemaRev = schemaRef.current
    const current = () => predSequence.current === seq && runSequence.current === startedFitSeq
      && selectionRef.current.datasetId === startedDataset && resultRef.current?.resultId === startedResultId
      && selectionRef.current.dataRevision === startedDataRev && schemaRef.current === startedSchemaRev
    setPredicting(true)
    setPredictError(null)
    setPredictInfo(null)
    try {
      const input: ConjointInputSnapshot = { context: captureAnalysisRunContext(buildContext()), scopeKey: analysisScope.scopeKey, label: analysisScope.label, count: analysisScope.count }
      const res = await predictConjoint(startedResultId, input.context)
      // G008-02: 開始した fit 世代・版・モデルと現在値を照合する。
      // 同じレンダーのクロージャ同士ではなく runSequence.current・ref を使う。
      if (!current()) return
      const out: ConjointPredictRow[] = []
      let offset: number | null = 0
      let total = 0
      while (offset !== null) {
        const page = await fetchConjointPredictions(startedResultId, res.predictionId, offset, 5000)
        if (!current()) return
        total = page.total
        out.push(...page.rows)
        offset = page.nextOffset
      }
      // G008-02: 行取得後・失敗時も開始世代・モデル・版を照合する。
      // 保存元は現在のモデルと一致する場合だけ遷移させる。
      if (!current()) return
      setPredictRows(out)
      setPredictTotal(total)
      setPredictResultId(startedResultId)
      setPredictId(res.predictionId)
      setPredictionInput(input)
      const ev = res.summary.evaluation
      setPredictInfo(`この予測の対象: ${input.label} ${input.count}行（実行時） / 成功${res.summary.successfulPredictions}/${res.summary.requestedCount}`
        + (ev ? ` 回答者重複${ev.fitOverlapRespondentCount}（行重複${ev.fitOverlapCount}）` : ''))
      if (resultRef.current?.resultId === startedResultId) {
        setMatSource(res.predictionId)
        setMatField((f) => {
          const fields = result.capabilities.materializePredictionFields
          return fields.includes(f) ? f : (fields[0] ?? '')
        })
      }
    } catch (err) {
      if (!current()) return
      setPredictError(apiErrorMessage(err, '予測に失敗しました。'))
    } finally {
      if (current()) setPredicting(false)
    }
  }

  // G006-10: 保存応答も開始時の dataset/世代で照合し、旧応答の
  // キャッシュ更新・コードブック再取得を防ぐ。
  // G006-09/G007-03: 診断内容を resultId・要求世代にひもづけて保持する。
  // （saveSequence/diagSequence は上部の effect より前で宣言済み）
  const [diag, setDiag] = useState<{ columns: string[]; rows: unknown[][] } | null>(null)
  const [diagResultId, setDiagResultId] = useState<string | null>(null)
  const [diagLoading, setDiagLoading] = useState(false)
  const [diagError, setDiagError] = useState<string | null>(null)
  const handleLoadDiagnostics = async (): Promise<void> => {
    // G008-03/G009-02: 診断を読込世代・開始モデル・開始fit世代にひもづける。
    // 再分析中は旧結果の診断読込を開始しない。応答時は ref で現在値を照合する
    //（同じレンダーのクロージャ同士の比較では失効を検出できない）。
    if (!datasetId || !result) return
    if (loading) return
    const seq = ++diagSequence.current
    const startedDataset = datasetId
    const startedResultId = result.resultId
    const startedFitSeq = runSequence.current
    const startedDataRev = selectionRef.current.dataRevision
    const startedSchemaRev = schemaRef.current
    setDiagLoading(true)
    setDiagError(null)
    try {
      const res = await fetchConjointTable(startedResultId, 'diagnostics', 'json')
      if (diagSequence.current !== seq
        || runSequence.current !== startedFitSeq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRev
        || schemaRef.current !== startedSchemaRev) return
      setDiag({ columns: res.columns, rows: res.rows })
      setDiagResultId(startedResultId)
    } catch (err) {
      if (diagSequence.current !== seq
        || runSequence.current !== startedFitSeq) return
      setDiagError(apiErrorMessage(err, '診断の取得に失敗しました。'))
    } finally {
      if (diagSequence.current === seq
        && runSequence.current === startedFitSeq) setDiagLoading(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!datasetId || !result) return
    const input = matSource === 'fit' ? resultInput : predictId === matSource && predictResultId === result.resultId ? predictionInput : null
    if (!input) return
    const seq = ++saveSequence.current
    const startedDataset = datasetId
    const startedResultId = result.resultId
    setSaving(true)
    try {
      const res = await materializeConjoint(result.resultId, input.context, matSource,
        [{ sourceField: matField, name: matName }], `cj-${result.resultId}-${matSource}-${matField}-${matName}`)
      // B023-01: 現在datasetの判定に、unmount済みインスタンスのrefを
      // 使わない。KeepAliveOutletはdatasetIdをkeyに子を作り直すため、
      // Aの旧インスタンスがunmountするとselectionRefは最後のAを保持し、
      // 中央の現在dataset(B)を参照しない。保存完了時にライフサイクル
      // 終了後も有効な中央storeの現在datasetで判定する。
      // 実データ変更の通知は必要だが、非表示datasetの更新を現在の
      // コードブックへロードしてはならない。現在表示への更新と
      // 非表示datasetのキャッシュ無効化を区別する。
      const currentDataset = store.getState().selection.datasetId
      const isCurrentDataset = currentDataset === startedDataset
      invalidateColumnarCache()
      dispatch(datasetValuesUpdated({ datasetId: startedDataset, dataRevision: res.dataRevision }))
      if (isCurrentDataset) {
        await dispatch(fetchCodebookThunk(startedDataset))
      }
      // B022-02: 通知直前にfreshを再検査する。コードブック取得のawait中に
      // dataset切替・unmount・再分析が起きても、事前計算のbooleanでは旧通知を
      // 抑止できない。await後の現在世代・dataset・結果で再判定する。
      const stillFresh = saveSequence.current === seq
        && selectionRef.current.datasetId === startedDataset
        && resultRef.current?.resultId === startedResultId
      if (!stillFresh) return
      message.success(`保存しました: ${res.createdColumns.map((c) => c.name).join(', ')}`)
    } catch (err) {
      if (saveSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || resultRef.current?.resultId !== startedResultId) return
      message.error(apiErrorMessage(err, '保存に失敗しました。'))
    } finally {
      if (saveSequence.current === seq) setSaving(false)
    }
  }

  const stale = result !== null && (result.meta.resultState === 'stale'
    || selection.dataRevision !== result.meta.dataRevision
    || schemaRevision !== result.meta.schemaRevision)
  const resultMode = String((result?.summary.mode ?? mode) as string)
  const rowsReady = !rowsLoading && !rowsError && rowsResultId !== null
    && result !== null && rowsResultId === result.resultId
  const selectedSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])
  const highlightedSet = useMemo(() => new Set(selection.hoveredRowId ? [selection.hoveredRowId] : []), [selection.hoveredRowId])
  const showSim = simResultId !== null && result !== null && simResultId === result.resultId ? simResult : null
  // CJ-GUI-06/G007-01: ranking の residual は未提供。ranking では
  // 第1位確率の1次元図（Y=行順）で点選択・範囲選択できる構成にする。
  // 欠損残差を偽の数値座標に変換せず、全点も捨てない。
  const figureMode = resultMode === 'ratings' ? 'ratings' : resultMode === 'ranking' ? 'ranking' : 'choice'
  const figurePoints = useMemo(() => {
    const pts: { rowId: string; x: number; y: number | null; title: string }[] = []
    const withX = rows.filter((r) => {
      const fx = resultMode === 'ratings' ? r.predictedRating : r.probability
      return fx !== null && fx !== undefined && Number.isFinite(fx)
    })
    withX.forEach((r, i) => {
      const fx = (resultMode === 'ratings' ? r.predictedRating : r.probability) as number
      const fy = r.residual
      const hasRes = fy !== null && fy !== undefined && Number.isFinite(fy)
      const val = resultMode === 'ratings'
        ? `予測評点=${fx.toFixed(3)}`
        : resultMode === 'ranking' ? `第1位確率=${fx.toFixed(3)}` : `選択確率=${fx.toFixed(3)}`
      pts.push({
        rowId: r.rowId,
        x: fx,
        // ranking では Y を行順（1始まり）にする。ratings/choice は残差。
        y: figureMode === 'ranking' ? i + 1 : (hasRes ? (fy as number) : null),
        // G008-05: 表示上の行順を回答順位と誤認させない。「行順」と明示し、
        // 回答順位は observed を別項目として示す。
        title: `${r.rowId} ${val}` + (figureMode === 'ranking'
          ? ` 行順=${i + 1}/${withX.length}（観測順位=${r.observed ?? '—'}）`
          : hasRes ? ` 残差=${(fy as number).toFixed(3)}` : ' 残差=未提供'),
      })
    })
    return pts
  }, [rows, resultMode, figureMode])
  const coefColumns = [
    { title: '係数', dataIndex: 'label', key: 'label' },
    { title: '推定値', dataIndex: 'estimate', key: 'estimate', render: (v: number) => (typeof v === 'number' ? v.toFixed(4) : '—') },
    { title: 'SE', dataIndex: 'standardError', key: 'se', render: (v: number | null) => (v === null || v === undefined ? '推測不能' : v.toFixed(4)) },
    { title: 't', dataIndex: 'statistic', key: 't', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
    { title: 'p', dataIndex: 'pValue', key: 'p', render: (v: number | null) => (v === null || v === undefined ? '—' : (v === 0 ? 'p<1e-300' : v.toExponential(2))) },
    { title: 'CI下限', dataIndex: 'ciLower', key: 'cil', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
    { title: 'CI上限', dataIndex: 'ciUpper', key: 'ciu', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
  ]
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

  if (!datasetId) return <Typography.Text>データセットを読み込んでください。</Typography.Text>

  return (
    <div data-testid="conjoint-page" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card size="small" title="コンジョイント分析">
        <Space direction="vertical" style={{ width: '100%' }} size="small">
          <Space wrap align="center">
            <span>方式:</span>
            <Radio.Group value={mode} onChange={(e) => {
              const next = e.target.value as 'ratings' | 'choice' | 'ranking'
              setMode(next)
              // G006-06: ratings では opt-out を送信しない。表示と送信を一致させる。
              if (next === 'ratings') setOptOutCol(null)
              if (next !== 'ratings') setRatingEffects('pooled')
            }}>
              <Radio.Button value="ratings" title="プロフィールごとの数値評点から効用を推定（pooled OLS／回答者固定効果OLS）">評点</Radio.Button>
              <Radio.Button value="choice" title="各選択タスクで1つだけ選んだ代替案から効用を推定（条件付きロジット）">選択</Radio.Button>
              <Radio.Button value="ranking" title="各タスクの全代替案の完全順位から効用を推定（逐次選択ロジット）">順位</Radio.Button>
            </Radio.Group>
            <AnalysisScopeSummary label="次回の分析対象" />
            <span>重み:</span>
            <SelectSetting
              value={weightMode}
              onChange={setWeightMode}
              style={{ minWidth: 220 }}
              options={[
                { value: 'dataset', label: savedWeightColumnId ? `データ設定 (${savedWeightType ?? '未宣言'})` : 'データ設定（なし）' },
                { value: 'none', label: '重みなし' },
              ]}
            />
            <Button
              size="small"
              loading={expanding}
              disabled={!respondentCol || !taskCol || !altCol || !responseCol || analysisScope.count === 0}
              onClick={() => void handleExpandScope()}
            >
              タスク全体へ拡張
            </Button>
            <SelectionMenu />
          </Space>
          <Space wrap align="center">
            <span>回答者ID列:</span>
            <span data-testid="cj-respondent-col">
              <SelectColumn value={respondentCol} onChange={setRespondentCol} options={idOptions} placeholder="回答者ID列" style={{ minWidth: 200 }} />
            </span>
            <span>タスク列:</span>
            <span data-testid="cj-task-col">
              <SelectColumn value={taskCol} onChange={setTaskCol} options={idOptions} placeholder="タスク列" style={{ minWidth: 200 }} />
            </span>
            <span>代替案列:</span>
            <span data-testid="cj-alt-col">
              <SelectColumn value={altCol} onChange={setAltCol} options={idOptions} placeholder="代替案列" style={{ minWidth: 200 }} />
            </span>
            <span>応答列:</span>
            <span data-testid="cj-response-col">
              <SelectColumn value={responseCol} onChange={setResponseCol} options={idOptions} placeholder={mode === 'ratings' ? '評点（数値）' : mode === 'choice' ? '選択（0/1・タスク内1件）' : '順位（1が最良・1..J完全順位）'} style={{ minWidth: 200 }} />
            </span>
          </Space>
          <Typography.Text type="secondary">
            {mode === 'ratings'
              ? '評点: プロフィールごとの数値評点。回答者固定効果は水準差を除去する方法で、個人別効用の推定ではありません。'
              : mode === 'choice'
                ? '選択: 各タスクで1つだけ1となる0/1。opt-out行は属性design=0・ASC=1です。'
                : '順位: 1が最良で各タスクに1..Jの完全順位。部分順位・同順位は対象外です。'}
          </Typography.Text>
          <Space wrap align="center">
            <span>availability列:</span>
            <SelectColumn value={availCol} onChange={setAvailCol} options={idOptions} placeholder="未指定" style={{ minWidth: 180 }} allowClear />
            <span>opt-out列:</span>
            <span data-testid="cj-optout-col">
              <SelectColumn value={mode === 'ratings' ? null : optOutCol} onChange={setOptOutCol} options={idOptions} placeholder="未指定（choice/rankingのみ）" style={{ minWidth: 200 }} allowClear disabled={mode === 'ratings'} />
            </span>
            <span>評点効果:</span>
            <SelectSetting value={ratingEffects} onChange={setRatingEffects} style={{ width: 170 }} disabled={mode !== 'ratings'} options={[
              { value: 'pooled', label: 'pooled' },
              { value: 'respondent_fixed', label: 'respondent_fixed' },
            ]} />
          </Space>
          <Space wrap align="center">
            <span>カテゴリ属性:</span>
            <span data-testid="cj-cat-attrs">
              <SelectColumn mode="multiple" value={catAttrs} onChange={setCatAttrs} style={{ minWidth: 280 }} options={categoricalOptions} placeholder="カテゴリを選択" />
            </span>
            <span>線形属性:</span>
            <span data-testid="cj-lin-attrs">
              <SelectColumn
                mode="multiple"
                value={linAttrs}
                onChange={(v) => {
                  setLinAttrs(v)
                  // G006-08: 属性から外した価格設定は解除する。
                  if (priceAttr && !v.includes(priceAttr)) setPriceAttr(null)
                }}
                style={{ width: 280 }}
                options={linearOptions}
                placeholder="線形を選択"
              />
            </span>
          </Space>
          {linAttrs.map((id) => {
            // G008-01: 下限・上限を独立した nullable 値として保持し、
            // 反対側の利用者入力を補正しない。不正な大小は表示と実行可否で扱う。
            const lo = utilLo[id]
            const hi = utilHi[id]
            const invalid = lo !== undefined && hi !== undefined && !(lo < hi)
            return (
              <Space key={id} wrap align="center">
                <span>{colLabel(id)} の効用範囲:</span>
                <span>下限</span>
                <InputNumber
                  value={lo ?? null}
                  onChange={(v) => {
                    setUtilLo({ ...utilLo, [id]: (v === null || v === undefined ? undefined : v) })
                  }}
                  style={{ width: 120 }}
                  placeholder="下限（省略可）"
                />
                <span>上限</span>
                <InputNumber
                  value={hi ?? null}
                  onChange={(v) => {
                    setUtilHi({ ...utilHi, [id]: (v === null || v === undefined ? undefined : v) })
                  }}
                  style={{ width: 120 }}
                  placeholder="上限（省略可）"
                />
                {invalid && (
                  <Typography.Text type="danger">下限は上限より小さくしてください（実行できません）。</Typography.Text>
                )}
              </Space>
            )
          })}
          {catAttrs.map((id) => (
            <Space key={id} wrap>
              <span>{colLabel(id)} の基準水準:</span>
              <SelectSetting
                value={refLevels[id] ?? null}
                onChange={(v) => setRefLevels({ ...refLevels, [id]: v ?? undefined })}
                style={{ width: 240 }}
                allowClear
                placeholder="自動（末尾水準）"
                options={(colById.get(id)?.categoryOrder ?? []).map((c) => ({ value: c, label: c }))}
              />
            </Space>
          ))}
          <Space wrap align="center">
            <span>価格属性（WTP用・登録済み線形属性のみ）:</span>
            <SelectColumn
              value={priceAttr}
              onChange={setPriceAttr}
              style={{ minWidth: 200 }}
              allowClear
              placeholder="未指定"
              options={linAttrs.map((id) => ({ value: id, label: colLabel(id) }))}
            />
            <Checkbox checked={includeWtp} onChange={(e) => setIncludeWtp(e.target.checked)}>WTPを含める</Checkbox>
            <Button type="primary" data-testid="cj-run" onClick={() => void handleRun()} disabled={!canRun} loading={loading}>実行</Button>
            {dirty && <Tag color="orange">設定が変更されています。結果は前回実行分です</Tag>}
          </Space>
          {inputErrors.length > 0 && (
            <Space direction="vertical" style={{ width: '100%' }} size="small">
              {inputErrors.map((e, i) => (
                <Alert key={i} type="error" message={e} showIcon />
              ))}
            </Space>
          )}
          {expandInfo && (() => {
            // G006-11: 拡張元の条件と現在の設定が一致する場合のみ有効。
            const sameMapping = expandInfo.mapping
              && expandInfo.mapping['respondentId'] === respondentCol
              && expandInfo.mapping['taskId'] === taskCol
              && expandInfo.mapping['alternativeId'] === altCol
              && expandInfo.mapping['response'] === responseCol
            const sameScope = expandInfo.originScopeKey === analysisScope.scopeKey
              && expandInfo.scopeSnapshot === JSON.stringify([weightMode, 'exclude'])
            const valid = sameMapping && sameScope
              && expandInfo.dataRevision === selection.dataRevision
              && expandInfo.schemaRevision === schemaRevision
            return (
              <Alert
                type={valid ? 'info' : 'warning'}
                message={valid
                  ? `タスク全体への拡張: 元${expandInfo.originalRowCount}件→拡張後${expandInfo.expandedRowCount}件（+${expandInfo.addedRowCount}件）。この条件で実行します。`
                  : '拡張後に設定・対象・版が変更されたため、この拡張結果は失効しました。再度「タスク全体へ拡張」を実行してください。'}
                action={valid ? <Button size="small" onClick={() => void handleRun(expandInfo.expandedRowIds)}>明示スコープで再実行</Button> : undefined}
                showIcon
              />
            )
          })()}
          {expandError && <Alert type="error" message={expandError} showIcon />}
          {!canRun && <Typography.Text type="secondary">回答者・タスク・代替案・応答の各列と属性1つ以上を選択してください（属性列と mapping 列の重複不可）。</Typography.Text>}
          <Typography.Text type="secondary">
            choice/ranking はタスク完全性を要求します。部分集合は CONJOINT_PARTIAL_TASK で拒否されます。ratings の probability は提供しません。
          </Typography.Text>
        </Space>
      </Card>

      {error && <Alert type="error" message={error} showIcon />}
      {loading && <Spin tip="計算中…" />}
      {result && (
        <Card
          size="small"
          title={`結果: ${result.summary.mode} 回答者${result.summary.respondentCount}・タスク${result.summary.taskCount}・プロフィール${result.summary.fitProfileCount}・ステージ${result.summary.stageCount}`}
          extra={<span>共分散={result.summary.covarianceMethod} 参照df={result.summary.referenceDf === null || result.summary.referenceDf === undefined ? '—' : result.summary.referenceDf}</span>}
        >
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {stale && <Alert type="warning" message="古い版の結果です（stale）。保存・予測・選択はできません。" showIcon />}
            {result.meta.warnings.map((w) => (
              <Alert key={w.code} type="warning" message={`${w.message}（${w.code}）`} showIcon />
            ))}
            {Object.entries(result.unavailableReasons ?? {}).map(([path, r]) => (
              <Alert key={path} type="warning" message={`${r.message}（${r.code}）`} showIcon />
            ))}
            <Typography.Text>
              推測={result.summary.inferenceStatus}（共分散={result.summary.covarianceMethod}）
              {result.summary.mode === 'ratings' ? ' ratings に logit 確率は提供しません' : ''}
              {result.summary.mode === 'ranking' ? ' ranking の行確率は第1位確率です' : ''}
            </Typography.Text>
            <Typography.Text type="secondary">
              {resultInput && <span data-testid="conjoint-result-scope">この結果の対象: {resultInput.label} {resultInput.count}行（実行時） / </span>}
              対象: {result.meta.scope}（scope {result.meta.scopeCount}行中有効{result.meta.fitCount}行・除外{result.meta.excludedCount}行）
              除外内訳: {Object.entries(result.meta.exclusionCounts ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'なし'}
              ・重み: {result.meta.weightApplied ? `あり（${result.meta.weightType ?? ''}）` : 'なし（回答者単位で適用）'}
            </Typography.Text>
            <Typography.Text type="secondary">
              適合: {(() => {
                const m = result.summary.fitMetrics as Record<string, unknown>
                if (result.summary.mode === 'ratings') {
                  return `RMSE=${m['rmse'] === null || m['rmse'] === undefined ? '—' : Number(m['rmse']).toFixed(4)} MAE=${m['mae'] === null || m['mae'] === undefined ? '—' : Number(m['mae']).toFixed(4)} overallR²=${m['overallRSquared'] === null || m['overallRSquared'] === undefined ? '—' : Number(m['overallRSquared']).toFixed(4)} withinR²=${m['withinRSquared'] === null || m['withinRSquared'] === undefined ? '—' : Number(m['withinRSquared']).toFixed(4)}`
                }
                return `平均NLL=${m['meanNegativeLogLikelihood'] === null || m['meanNegativeLogLikelihood'] === undefined ? '—' : Number(m['meanNegativeLogLikelihood']).toFixed(4)} McFaddenR²=${m['mcfaddenRSquared'] === null || m['mcfaddenRSquared'] === undefined ? '—' : Number(m['mcfaddenRSquared']).toFixed(4)} hitRate=${m['hitRate'] === null || m['hitRate'] === undefined ? '—' : Number(m['hitRate']).toFixed(3)}`
              })()}
              ・収束: {(() => {
                const o = result.details.optimizer as Record<string, unknown> | undefined
                if (!o || Object.keys(o).length === 0) return '—'
                return `反復${String(o['iterations'] ?? '—')} scoreNorm=${o['scoreInfNorm'] === null || o['scoreInfNorm'] === undefined ? '—' : Number(o['scoreInfNorm']).toExponential(2)}`
              })()}
              ・タスク診断: {result.details.taskDiagnostics ? `${result.details.taskDiagnostics.total}件（${result.details.taskDiagnostics.subtables.join(', ')}）・export「diagnostics」で取得` : '—'}
            </Typography.Text>
            <Tabs activeKey={tab} onChange={setTab} items={[
              {
                key: 'figure', label: '連動図',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space wrap>
                      <SelectionMenu />
                      {selecting && <Spin size="small" />}
                      {selectInfo && <Typography.Text>{selectInfo}</Typography.Text>}
                      {rowsLoading && <Typography.Text type="secondary">行を取得中…</Typography.Text>}
                      {rowsError && <Alert type="error" message={rowsError} showIcon />}
                      {result && !rowsReady && !rowsLoading && (
                        <Typography.Text type="warning">行の取得が完了していないため選択できません。</Typography.Text>
                      )}
                    </Space>
                    {figureMode === 'ranking' && (
                      <Alert type="info" message="順位分析の行確率は第1位確率です。残差は未提供のため、Yは行順（1始まり）です。" showIcon />
                    )}
                    <GraphPanel
                      graphId="conjoint/diagnostics"
                      title="コンジョイント診断図"
                      available={tab === 'figure'}
                      sizing="intrinsic"
                      intrinsicSize={{ width: 560, height: 400 }}
                    >
                      <ConjointFigure
                        points={figurePoints}
                        xLabel={resultMode === 'ratings' ? '予測評点' : resultMode === 'ranking' ? '第1位確率' : '選択確率'}
                        yLabel={figureMode === 'ranking' ? '行順' : '残差'}
                        selected={selectedSet}
                        highlighted={highlightedSet}
                        getColor={getColor}
                        onToggle={(id: string) => void handleToggle(id)}
                        onBrush={(b: { x: [number, number]; y: [number, number] }) => void handleBrush(b)}
                        svgRef={svgRef}
                        testId="cj-figure"
                      />
                    </GraphPanel>
                    <L1Legend />
                    <Space wrap>
                      <Button onClick={() => svgRef.current && downloadSvg(svgRef.current, `${result.resultId}-cj.svg`)}>SVG保存</Button>
                      <Button onClick={() => svgRef.current && downloadPng(svgRef.current, `${result.resultId}-cj.png`)}>PNG保存</Button>
                      <Button onClick={() => handleRespondentSelect(rows.find((r) => selectedSet.has(r.rowId))?.respondentId ?? '')} disabled={selectedSet.size === 0 || stale || !rowsReady}>選択行の回答者の全タスクを選択</Button>
                    </Space>
                  </Space>
                ),
              },
              {
                key: 'coef', label: '係数・効用',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Table dataSource={result.details.coefficients} columns={coefColumns} rowKey="designColumnId" pagination={false} size="small" />
                    <Table
                      dataSource={result.details.levelUtilities}
                      columns={[
                        { title: '属性', key: 'a', render: (_: unknown, r: { attributeId: string }) => colLabel(r.attributeId) },
                        { title: '水準', dataIndex: 'label', key: 'l' },
                        { title: '効用', dataIndex: 'utility', key: 'u', render: (v: number) => (typeof v === 'number' ? v.toFixed(4) : '—') },
                        { title: 'SE', dataIndex: 'standardError', key: 'se', render: (v: number | null) => (v === null || v === undefined ? '推測不能' : v.toFixed(4)) },
                        { title: 'CI下限', dataIndex: 'ciLower', key: 'cil', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
                        { title: 'CI上限', dataIndex: 'ciUpper', key: 'ciu', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(4)) },
                      ]}
                      rowKey="categoryId"
                      pagination={false}
                      size="small"
                    />
                    {result.details.attributeImportance ? (
                      <Space direction="vertical" style={{ width: '100%' }} size="small">
                        <Table
                          dataSource={result.details.attributeImportance}
                          columns={[
                            { title: '属性', key: 'a', render: (_: unknown, r: { attributeId: string }) => colLabel(r.attributeId) },
                            { title: '重要度', dataIndex: 'importance', key: 'i', render: (v: number) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—') },
                            { title: 'range', dataIndex: 'range', key: 'r', render: (v: number) => (typeof v === 'number' ? v.toFixed(3) : '—') },
                            { title: '範囲下限', dataIndex: 'rangeLower', key: 'rl', render: (v: number) => (typeof v === 'number' ? v.toFixed(3) : '—') },
                            { title: '範囲上限', dataIndex: 'rangeUpper', key: 'ru', render: (v: number) => (typeof v === 'number' ? v.toFixed(3) : '—') },
                          ]}
                          rowKey="attributeId"
                          pagination={false}
                          size="small"
                        />
                        <Typography.Text type="secondary">重要度は今回提示した水準範囲に依存する指標です。範囲を変えると値が変わります。</Typography.Text>
                      </Space>
                    ) : (
                      <Alert type="info" message="属性重要度は算出できませんでした（全レンジ0のため）。均等配分はしません。" showIcon />
                    )}
                    {result.details.wtp && result.details.wtp.length > 0 ? (
                      <Space direction="vertical" style={{ width: '100%' }} size="small">
                        <Table
                          dataSource={result.details.wtp}
                          columns={[
                            { title: '属性', key: 'a', render: (_: unknown, r: { attributeId: string }) => colLabel(r.attributeId) },
                            { title: '比較', key: 'c', render: (_: unknown, r: { fromLevel: string; toLevel: string; attributeId: string }) => `${r.fromLevel}→${r.toLevel}` },
                            { title: 'WTP', dataIndex: 'value', key: 'v', render: (v: number | null) => (v === null || v === undefined ? '未提供' : v.toFixed(3)) },
                            { title: 'SE', dataIndex: 'standardError', key: 'se', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                            { title: 'CI下限', dataIndex: 'ciLower', key: 'cil', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                            { title: 'CI上限', dataIndex: 'ciUpper', key: 'ciu', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                            { title: '単位', dataIndex: 'priceUnit', key: 'u' },
                            { title: '状態', dataIndex: 'status', key: 's' },
                          ]}
                          rowKey={(r) => `${r.attributeId}:${r.fromLevel}:${r.toLevel}`}
                          pagination={false}
                          size="small"
                        />
                        <Typography.Text type="secondary">WTPはモデル上の参考値（delta法CI）です。実購買行動の因果的価格弾力性ではありません。価格係数不安定時は未提供（WTP_UNSTABLE）とします。</Typography.Text>
                      </Space>
                    ) : null}
                    {result.details.omittedLevels.length > 0 && (
                      <Typography.Text type="secondary">未観測水準（0係数として追加しません）: {result.details.omittedLevels.map((o) => `${colLabel(o.attributeId)}=${o.levelCode}`).join(', ')}</Typography.Text>
                    )}
                  </Space>
                ),
              },
              {
                // G006-09: タスク診断を画面から読める診断タブ。
                key: 'diagnostics', label: '診断',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space wrap>
                      <Button size="small" onClick={() => void handleLoadDiagnostics()} loading={diagLoading} disabled={stale || loading}>診断を読込</Button>
                      {diagError && <Typography.Text type="danger">{diagError}</Typography.Text>}
                    </Space>
                    {diag && diagResultId === result.resultId && (
                      <Table
                        dataSource={diag.rows.map((r, i) => ({ key: i, ...(Object.fromEntries(diag.columns.map((c, j) => [c, r[j]])) as Record<string, unknown>) }))}
                        columns={diag.columns.map((c) => ({ title: c, dataIndex: c, key: c, render: (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v)) }))}
                        rowKey="key"
                        pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (t) => `全${t}件` }}
                        size="small"
                      />
                    )}
                    {!diag && !diagLoading && (
                      <Typography.Text type="secondary">タスク診断（{result.details.taskDiagnostics ? `${result.details.taskDiagnostics.total}件・${result.details.taskDiagnostics.subtables.join(', ')}` : '—'}）を読込ボタンで表示します。CSV出力でも取得できます。</Typography.Text>
                    )}
                  </Space>
                ),
              },
              {
                key: 'rows', label: '行',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Typography.Text type="secondary">
                      回答者・タスク・代替案ごとの観測・予測・残差・状態の一覧です。行選択は点選択、回答者全タスク選択は別操作です。
                    </Typography.Text>
                    {rowsLoading && <Typography.Text type="secondary">行を取得中…</Typography.Text>}
                    {rowsError && <Alert type="error" message={rowsError} showIcon />}
                    <Table
                      dataSource={rows}
                      columns={[
                        { title: '回答者', dataIndex: 'respondentId', key: 'resp' },
                        { title: 'タスク', dataIndex: 'taskId', key: 'task' },
                        { title: '代替案', dataIndex: 'alternativeId', key: 'alt' },
                        { title: '観測', dataIndex: 'observed', key: 'o', render: (v: number | null) => (v === null || v === undefined ? '—' : String(v)) },
                        { title: '予測評点', dataIndex: 'predictedRating', key: 'pr', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                        { title: '確率', dataIndex: 'probability', key: 'p', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                        { title: '残差', dataIndex: 'residual', key: 'r', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                        { title: '状態', dataIndex: 'predictionStatus', key: 's' },
                        {
                          title: '選択', key: 'op',
                          render: (_: unknown, r: ConjointFitRow) => (
                            <Space>
                              <Button size="small" onClick={() => void handleToggle(r.rowId)} disabled={stale || !rowsReady}>点選択</Button>
                              <Button size="small" onClick={() => void handleRespondentSelect(r.respondentId)} disabled={stale || !rowsReady}>全タスク</Button>
                            </Space>
                          ),
                        },
                      ]}
                      rowKey="rowId"
                      pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (t) => `全${t}件` }}
                      size="small"
                    />
                  </Space>
                ),
              },
              {
                key: 'predict', label: '予測・評価',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Space wrap>
                      <AnalysisScopeSummary label="次回の予測対象" />
                      <Button onClick={() => void handlePredict()} loading={predicting} disabled={stale || loading || analysisScope.count === 0}>予測・評価</Button>
                      {predictInfo && predictResultId === result.resultId && <Typography.Text>{predictInfo}</Typography.Text>}
                    </Space>
                    {predictError && <Alert type="error" message={predictError} showIcon />}
                    {predictRows.length > 0 && predictResultId === result.resultId && (
                      <Table
                        dataSource={predictRows}
                        columns={[
                          { title: '回答者', dataIndex: 'respondentId', key: 'resp' },
                          { title: 'タスク', dataIndex: 'taskId', key: 'task' },
                          { title: '代替案', dataIndex: 'alternativeId', key: 'alt' },
                          { title: '観測', dataIndex: 'observed', key: 'o', render: (v: number | null) => (v === null || v === undefined ? '—' : String(v)) },
                          { title: '予測評点', dataIndex: 'predictedRating', key: 'pr', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: '確率', dataIndex: 'probability', key: 'p', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: '残差', dataIndex: 'residual', key: 'r', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: '状態', dataIndex: 'predictionStatus', key: 's' },
                        ]}
                        rowKey="rowId"
                        pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (t) => `全${t}件` }}
                        size="small"
                      />
                    )}
                    <Typography.Text type="secondary">学習重複を含む評価は汎化精度ではなく参考値です。同じ回答者の新タスクは回答者外検証と呼びません。</Typography.Text>
                  </Space>
                ),
              },
              {
                key: 'simulate', label: 'シミュレーション',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Table
                      dataSource={simProfiles}
                      columns={[
                        {
                          title: '代替案', key: 'a',
                          render: (_: unknown, p: { key: number; alternativeId: string; values: Record<string, string>; optOut: boolean }) => {
                            const dup = simProfiles.filter((q) => q.alternativeId.trim() !== '' && q.alternativeId === p.alternativeId).length > 1
                            return (
                              <span>
                                <Input
                                  value={p.alternativeId}
                                  onChange={(e) => setSimProfiles(simProfiles.map((q) => (q.key === p.key ? { ...q, alternativeId: e.target.value } : q)))}
                                  style={{ width: 110, ...(dup ? { borderColor: 'red' } : {}) }}
                                  placeholder="代替案ID（一意）"
                                />
                                {dup && <Typography.Text type="danger">重複</Typography.Text>}
                              </span>
                            )
                          },
                        },
                        ...simAttributes.map((a: { columnId: string; kind: string }) => ({
                          title: colLabel(a.columnId), key: a.columnId,
                          render: (_: unknown, p: { key: number; alternativeId: string; values: Record<string, string>; optOut: boolean }) => {
                            // G006-02: 保存済みモデルの辞書は details.encoding を参照する
                            //（config はリクエスト由来で encoding を含まない）。
                            const detEnc = (result?.details as Record<string, unknown> | undefined) as unknown as {
                              encoding?: { catalog?: Record<string, string[]>; linearRanges?: Record<string, { fitMin?: number; fitMax?: number }> }
                            } | undefined
                            const learnedLevels = detEnc?.encoding?.catalog?.[a.columnId]
                            const linRange = detEnc?.encoding?.linearRanges?.[a.columnId]
                            if (a.kind === 'linear') {
                              return (
                                <span>
                                  <Input
                                    value={p.values[a.columnId] ?? ''}
                                    onChange={(e) => setSimProfiles(simProfiles.map((q) => (q.key === p.key ? { ...q, values: { ...q.values, [a.columnId]: e.target.value } } : q)))}
                                    style={{ width: 100 }}
                                    placeholder={linRange ? `範囲 ${linRange.fitMin ?? ''}〜${linRange.fitMax ?? ''}` : '数値'}
                                  />
                                </span>
                              )
                            }
                            // G006-02: 学習水準のみ候補にし、除外水準は選べない。
                            // 学習辞書がない場合（未実行時）はコードブック順を使う。
                            const opts = learnedLevels ?? colById.get(a.columnId)?.categoryOrder ?? []
                            return (
                              <SelectSetting
                                value={p.values[a.columnId] ?? null}
                                onChange={(v) => setSimProfiles(simProfiles.map((q) => (q.key === p.key ? { ...q, values: { ...q.values, [a.columnId]: String(v ?? '') } } : q)))}
                                style={{ width: 140 }}
                                allowClear
                                placeholder={learnedLevels ? '学習水準を選択' : '水準を選択'}
                                options={opts.map((c) => ({ value: c, label: c }))}
                              />
                            )
                          },
                        })),
                        {
                          title: 'opt-out', key: 'o',
                          render: (_: unknown, p: { key: number; alternativeId: string; values: Record<string, string>; optOut: boolean }) => (
                            <Checkbox checked={p.optOut} onChange={(e) => setSimProfiles(simProfiles.map((q) => (q.key === p.key ? { ...q, optOut: e.target.checked } : q)))} />
                          ),
                        },
                        {
                          title: '操作', key: 'op',
                          render: (_: unknown, p: { key: number; alternativeId: string; values: Record<string, string>; optOut: boolean }) => (
                            <Button size="small" danger onClick={() => setSimProfiles(simProfiles.filter((q) => q.key !== p.key))}>削除</Button>
                          ),
                        },
                      ]}
                      rowKey="key"
                      pagination={false}
                      size="small"
                    />
                    <Space wrap>
                      <Button size="small" onClick={() => {
                        // G006-07: 削除で巻き戻らない連番を使い、ID重複を防ぐ。
                        const used = new Set(simProfiles.map((q) => q.alternativeId))
                        let n = simProfiles.length + 1
                        while (used.has(`s${n}`)) n += 1
                        setSimProfiles([...simProfiles, { key: Date.now() + Math.random(), alternativeId: `s${n}`, values: {}, optOut: false }])
                      }}>プロフィール追加</Button>
                      <Button type="primary" onClick={() => void handleSimulate()} loading={simulating} disabled={simProfiles.length < 1}>シミュレーション実行</Button>
                    </Space>
                    {simError && <Alert type="error" message={simError} showIcon />}
                    {showSim && (
                      <Table
                        dataSource={showSim.profiles}
                        columns={[
                          { title: '代替案', dataIndex: 'alternativeId', key: 'a' },
                          { title: '効用', dataIndex: 'utility', key: 'u', render: (v: number) => (typeof v === 'number' ? v.toFixed(4) : '—') },
                          { title: '予測評点', dataIndex: 'predictedRating', key: 'pr', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: '確率', dataIndex: 'probability', key: 'p', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                          { title: 'firstChoiceShare', dataIndex: 'firstChoiceShare', key: 'f', render: (v: number | null) => (v === null || v === undefined ? '—' : v.toFixed(3)) },
                        ]}
                        rowKey="alternativeId"
                        pagination={false}
                        size="small"
                      />
                    )}
                    {showSim && showSim.warnings.length > 0 && (
                      <Typography.Text type="warning">警告: {showSim.warnings.map((w) => `${w.code}(${w.columnIds?.join(',') ?? ''})`).join(' / ')}</Typography.Text>
                    )}
                    <Typography.Text type="secondary">指定集合におけるモデル選択確率です。「市場シェア」ではありません。ratings に softmax 確率は付けません。</Typography.Text>
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
                        placeholder="CJ_PROB"
                      />
                      <Button onClick={() => void handleSave()} loading={saving} disabled={stale}>表示結果の列へ保存</Button>
                      <Button onClick={() => { setTab('figure'); openWhenAvailable('conjoint/diagnostics') }}>図へ移動</Button>
                    </Space>
                    <Space wrap>
                      {(['coefficients', 'diagnostics', 'rows', 'utilities'] as const).map((t) => (
                        <span key={t}>
                          <Button size="small" onClick={() => void exportConjointTable(result.resultId, t, 'csv')}>{t} CSV</Button>
                          {' '}
                          <Button size="small" onClick={() => void exportConjointTable(result.resultId, t, 'json')}>{t} JSON</Button>
                        </span>
                      ))}
                      <Button size="small" onClick={() => void exportConjointTable(result.resultId, 'manifest', 'json')}>モデルJSON</Button>
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
