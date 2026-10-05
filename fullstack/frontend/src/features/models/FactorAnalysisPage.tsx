import AsyncExportButton from '../common/AsyncExportButton'
import { useAnalysisScope, AnalysisScopeSummary, captureAnalysisRunContext } from '../selection/analysisScope'
import { CHART_MARKERS, pointEmphasis } from '../charts/markerStyle'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Alert, Button, Card, Checkbox, Input, InputNumber, Radio, Select as SelectSetting, Space, Spin, Table, Tabs, Tag, Typography, message } from 'antd'
import type { AppDispatch, RootState } from '../../app/store'
import { datasetValuesUpdated, selectionApplied } from '../../app/store'
import { fetchCodebookThunk } from '../dataset/codebookSlice'
import { fetchProvenanceThunk } from '../dataset/provenanceSlice'
import { invalidateColumnarCache } from '../pcp/useDatasetColumns'
import { useCodebook } from '../dataset/useCodebookColumn'
import SelectColumn from '../common/ColumnSelect'
import { AnalysisField, AnalysisRunRow, AnalysisSettings } from '../common/AnalysisSetup'
import GraphPanel from '../common/GraphPanel'
import SelectionMenu, { getBrushOp } from '../selection/SelectionMenu'
import type { EFAContext, EFAResponse } from './efaApi'
import { cancelEFAComparison, exportEFATable, fetchAllEFARows, fetchEFAComparison, materializeEFA, predictEFA, runEFA, selectEFA } from './efaApi'
import EfaScoreFigure from './EfaScoreFigure'
import type { EChartsOption } from 'echarts'
import EChart from '../charts/EChart'
import L1Legend from '../common/L1Legend'
import { useRowColorResolver } from '../../theme/useRowColor'

function apiErrorMessage(err: unknown, fallback: string): string {
  const { message: msg, code } = (err ?? {}) as { message?: unknown; code?: unknown }
  if (typeof msg !== 'string' || !msg) return fallback
  return typeof code === 'string' && code ? msg + '(' + code + ')' : msg
}

/** Keep parallel-analysis ranks aligned, including missing reference quantiles. */
export function efaScreeOption(observed: (number | null)[], reference: (number | null)[], suggestedFactors: number | null): EChartsOption {
  const ranks = Array.from({ length: Math.max(observed.length, reference.length) }, (_, i) => String(i + 1))
  const values = (source: (number | null)[]) => ranks.map((_, i) =>
    typeof source[i] === 'number' && Number.isFinite(source[i]) ? source[i] : null)
  return {
    animation: false, backgroundColor: '#fafafa',
    title: { text: `平行分析（候補 ${suggestedFactors ?? 'x'}）`, left: 12, top: 6,
      textStyle: { fontSize: 11, fontWeight: 'normal' } },
    grid: { left: 54, right: 24, top: 56, bottom: 42 },
    legend: { data: ['観測', '参照分位'], top: 24, left: 'center' },
    tooltip: { trigger: 'axis', renderMode: 'richText', valueFormatter: (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : '未提供' },
    xAxis: { type: 'category', data: ranks, name: '順位', nameLocation: 'middle', nameGap: 26, boundaryGap: false },
    yAxis: { type: 'value', name: '固有値', scale: false },
    series: [
      { id: 'efa-observed-eigenvalues', name: '観測', type: 'line', data: values(observed),
        connectNulls: false, symbol: 'circle', symbolSize: CHART_MARKERS.diameter, emphasis: pointEmphasis(), itemStyle: { color: '#1890ff' }, lineStyle: { width: 1.5 } },
      { id: 'efa-reference-quantiles', name: '参照分位', type: 'line', data: values(reference),
        connectNulls: false, symbol: 'emptyCircle', symbolSize: CHART_MARKERS.diameter, emphasis: pointEmphasis(), itemStyle: { color: '#fa8c16' }, lineStyle: { width: 1.5, type: 'dashed' } },
    ],
  }
}

type Treat = 'ordinal' | 'continuous_approximation' | 'continuous'

export default function FactorAnalysisPage(): JSX.Element {
  const dispatch = useDispatch<AppDispatch>()
  const selection = useSelector((s: RootState) => s.selection)
  const codebook = useCodebook()
  const { columns, schemaRevision } = codebook
  const datasetId = selection.datasetId
  const { getColor } = useRowColorResolver()

  const colById = useMemo(() => {
    const m = new Map<string, { name: string; label: string; scaleType: string; categoryOrder?: string[] }>()
    for (const c of columns) m.set(c.columnId, c as never)
    return m
  }, [columns])
  const itemOptions = useMemo(
    () => columns
      .filter((c) => ['ordinal', 'interval', 'ratio'].includes(c.scaleType) && !c.multiResponseGroup)
      .map((c) => ({ value: c.columnId, label: c.label ? c.label + ' (' + c.name + ')' : c.name })),
    [columns],
  )

  const [items, setItems] = useState<string[]>([])
  const [treat, setTreat] = useState<Record<string, Treat>>({})
  const [reverse, setReverse] = useState<Record<string, boolean>>({})
  const [ack, setAck] = useState<Record<string, boolean>>({})
  const [correlationMode, setCorrelationMode] = useState<'auto' | 'pearson' | 'polychoric'>('auto')
  const [extraction, setExtraction] = useState<'minres' | 'ml'>('minres')
  const [nFactorsOverride, setNFactorsOverride] = useState<number | null>(null)
  // The backend identification rule permits only one factor with 3–4 items.
  // Keep the previous two-factor default for larger sets, unless explicitly changed.
  const nFactors = nFactorsOverride ?? (items.length >= 3 && items.length <= 4 ? 1 : 2)
  const [compareText, setCompareText] = useState<string>('')
  const [rotation, setRotation] = useState<'promax' | 'varimax' | 'none'>('promax')
  const [scoreMethod, setScoreMethod] = useState<'none' | 'regression' | 'bartlett'>('none')
  const [paEnabled, setPaEnabled] = useState<boolean>(true)
  const [paIter, setPaIter] = useState<number>(500)
  const [sensEnabled, setSensEnabled] = useState<boolean>(false)
  const [sensAck, setSensAck] = useState<boolean>(false)
  const analysisScope = useAnalysisScope()
  // E013 2nd round: default to the dataset setting so a configured
  // weight is refused (FA_WEIGHT_UNSUPPORTED) before the user explicitly
  // opts into an unweighted run; an explicit none is a separate trial.
  const [weightMode, setWeightMode] = useState<'dataset' | 'none'>('dataset')
  const [tab, setTab] = useState<string>('loadings')

  const [result, setResult] = useState<EFAResponse | null>(null)
  const [resultInput, setResultInput] = useState<{ context: EFAContext; scopeKey: string; label: string; count: number } | null>(null)
  const [predictionInfo, setPredictionInfo] = useState<string | null>(null)
  const [submittedKey, setSubmittedKey] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [comparison, setComparison] = useState<Record<string, unknown> | null>(null)
  const [rows, setRows] = useState<{ rowId: string; scores: (number | null)[] }[]>([])
  const [rowsTotal, setRowsTotal] = useState<number>(0)
  const [rowsResultId, setRowsResultId] = useState<string | null>(null)
  const rowsReady = result !== null && rowsResultId === result.resultId
  const [selecting, setSelecting] = useState<boolean>(false)
  const [selectInfo, setSelectInfo] = useState<string | null>(null)
  const [saving, setSaving] = useState<boolean>(false)
  const [matFactor, setMatFactor] = useState<number>(1)
  const [matName, setMatName] = useState<string>('efa_f1')
  const [figX, setFigX] = useState<number>(1)
  const [figY, setFigY] = useState<number>(2)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const runSequence = useRef(0)
  const selectionSequence = useRef(0)
  const predictionSequence = useRef(0)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const schemaRef = useRef(schemaRevision)
  schemaRef.current = schemaRevision

  useEffect(() => {
    runSequence.current += 1
    selectionSequence.current += 1
    predictionSequence.current += 1
    setResult(null)
    setResultInput(null)
    setPredictionInfo(null)
    setSubmittedKey('')
    setError(null)
    setComparison(null)
    setRows([])
    setRowsTotal(0)
    setRowsResultId(null)
    setSelectInfo(null)
    setItems([])
    setLoading(false)
    setSelecting(false)
    return () => { runSequence.current += 1; selectionSequence.current += 1; predictionSequence.current += 1 }
  }, [datasetId])

  // Revision changes retain the old result for inspection but cancel pending work.
  useEffect(() => {
    runSequence.current += 1
    selectionSequence.current += 1
    predictionSequence.current += 1
    setLoading(false)
    setSelecting(false)
  }, [selection.dataRevision, schemaRevision])

  const matchesContext = (context: EFAContext) => selectionRef.current.datasetId === context.datasetId
    && selectionRef.current.dataRevision === context.expectedDataRevision
    && schemaRef.current === context.expectedSchemaRevision

  const buildContext = (): EFAContext => ({
    datasetId: datasetId ?? '', expectedDataRevision: selection.dataRevision ?? 1,
    expectedSchemaRevision: schemaRevision ?? 1, ...analysisScope.contextRows,
    weightMode, missingPolicy: 'exclude',
  })

  const variables = useMemo(() => items.map((id) => {
    const c = colById.get(id)
    const isOrd = c?.scaleType === 'ordinal'
    const t: Treat = treat[id] ?? (isOrd ? 'ordinal' : 'continuous')
    return {
      columnId: id,
      measurement: (isOrd ? 'ordinal' : 'continuous') as 'ordinal' | 'continuous',
      treatment: t,
      categoryOrder: isOrd ? (c?.categoryOrder ?? null) : null,
      reverse: isOrd ? Boolean(reverse[id]) : false,
      approximationAcknowledged: t === 'continuous_approximation' ? Boolean(ack[id]) : false,
    }
  }), [items, treat, reverse, ack, colById])

  const allOrdinal = variables.length > 0 && variables.every((v) => v.treatment === 'ordinal')
  const correlation = correlationMode === 'auto' ? (allOrdinal ? 'polychoric' : 'pearson') : correlationMode
  const correlationLabel = correlation === 'polychoric' ? 'Polychoric' : 'Pearson'
  const treatmentSummary = items.length === 0
    ? '通常は尺度をそのまま使用します。順序項目の逆転や連続近似を行う場合に変更してください。'
    : [
      ['順序モデル', variables.filter((v) => v.treatment === 'ordinal').length],
      ['連続', variables.filter((v) => v.treatment === 'continuous').length],
      ['連続近似', variables.filter((v) => v.treatment === 'continuous_approximation').length],
      ['近似の同意待ち', variables.filter((v) => v.treatment === 'continuous_approximation' && !v.approximationAcknowledged).length],
      ['逆転', variables.filter((v) => v.reverse).length],
    ].filter(([, count]) => Number(count) > 0).map(([label, count]) => label + ' ' + count + '項目').join(' / ')
  const compareFactors = useMemo(() => compareText.trim() ? compareText.split(',').map((v) => Number(v.trim())) : [], [compareText])
  const factorIsIdentified = (count: number) => Number.isInteger(count) && count >= 1 && count < items.length
    && (items.length - count) ** 2 - items.length - count >= 0
  const itemIssues: string[] = []
  const methodIssues: string[] = []
  const weightIssues: string[] = []
  for (const v of variables) {
    const label = colById.get(v.columnId)?.label || v.columnId
    if (v.measurement === 'ordinal' && (!v.categoryOrder || v.categoryOrder.length < 2)) {
      itemIssues.push('順序項目「' + label + '」のカテゴリ順序が不足しています。コードブックで2水準以上の順序を設定してください。')
    }
    if (v.treatment === 'continuous_approximation' && !v.approximationAcknowledged) {
      itemIssues.push('「' + label + '」の連続近似には、項目ごとの等間隔の明示同意が必要です。')
    }
  }
  if (variables.some((v) => v.treatment === 'ordinal') && !allOrdinal) {
    itemIssues.push('順序モデルと連続項目は混在できません。項目を選び直すか、「項目の扱い・逆転」で順序項目の連続近似を選び、項目ごとに同意してください。')
  }
  if (variables.length > 0 && (allOrdinal ? correlation !== 'polychoric' : correlation !== 'pearson')) {
    methodIssues.push(allOrdinal ? '順序モデルでは相関をPolychoricにしてください。' : '連続項目・連続近似では相関をPearsonにしてください。')
  }
  if (allOrdinal && extraction !== 'minres') methodIssues.push('順序モデルの抽出はMINRES／ULS系を選択してください。')
  if (allOrdinal && scoreMethod !== 'none') methodIssues.push('順序モデルでは因子得点を計算できません。得点を「なし」にしてください。')
  if (items.length >= 3 && !factorIsIdentified(nFactors)) {
    methodIssues.push('選択した' + items.length + '項目では因子数' + nFactors + 'を推定できません。因子数を減らすか、項目を追加してください。')
  }
  if (compareText.trim() && (compareText.split(',').some((value) => !value.trim())
    || compareFactors.some((value) => !Number.isInteger(value) || value < 1)
    || new Set(compareFactors).size !== compareFactors.length)) {
    methodIssues.push('候補比較には重複のない正の整数をカンマ区切りで入力してください。')
  } else if (items.length >= 3 && compareFactors.some((value) => !factorIsIdentified(value))) {
    methodIssues.push('候補比較に選択項目数では推定できない因子数があります。候補を減らすか、項目を追加してください。')
  }
  if (!Number.isInteger(paIter) || paIter < 100 || paIter > 10000) methodIssues.push('平行分析の反復数は100～10000の整数を入力してください。')
  if (sensEnabled) {
    if (!sensAck) methodIssues.push('感度比較には連続近似の独立同意が必要です。')
    if (!paEnabled) methodIssues.push('感度比較を使う場合は平行分析を有効にしてください。')
    if (variables.some((v) => v.measurement !== 'ordinal')) methodIssues.push('感度比較は元の尺度がすべて順序尺度の項目に限り利用できます。')
  }
  if (weightMode === 'dataset' && codebook.weightConfig?.weightColumnId) {
    weightIssues.push('このデータには重みが設定されています。EFAは非加重のみ対応のため、「重み・欠損値」で「なし（明示）」を選ぶ必要があります。')
  }
  const setupIssues = [...itemIssues, ...methodIssues, ...weightIssues]
  const canRun = items.length >= 3 && Boolean(datasetId) && analysisScope.count > 0 && setupIssues.length === 0
  const requiredMessage = !datasetId ? 'データセットを読み込んでください。'
    : analysisScope.count === 0 ? '分析対象が0行です。共通の分析対象で行を選択してください。'
      : items.length < 3 ? '項目を3つ以上選択してください（現在' + items.length + '項目）。'
        : setupIssues.length > 0 ? '設定の確認が必要です。上の案内を確認してください。'
          : items.length + '項目 / ' + nFactors + '因子 / ' + correlationLabel
  const errorPanel = !error ? null : /FA_WEIGHT|weight/i.test(error) ? 'weight'
    : /categoryOrder|treatment|column|カテゴリ|項目/i.test(error) ? 'items' : 'method'
  const draftKey = JSON.stringify([datasetId, items, treat, reverse, ack, correlation, extraction, nFactors, compareText, rotation, scoreMethod, paEnabled, paIter, sensEnabled, sensAck, analysisScope.scopeKey, weightMode, selection.dataRevision, schemaRevision])
  const dirty = result !== null && submittedKey !== '' && draftKey !== submittedKey

  const handleRun = async (): Promise<void> => {
    if (!canRun || loading) return
    const seq = ++runSequence.current
    selectionSequence.current += 1
    setSelecting(false)
    predictionSequence.current += 1
    setLoading(true)
    setError(null)
    setComparison(null)
    setPredictionInfo(null)
    const input = { context: captureAnalysisRunContext(buildContext()), scopeKey: analysisScope.scopeKey, label: analysisScope.label, count: analysisScope.count }
    const current = () => runSequence.current === seq && matchesContext(input.context)
    try {
      const res = await runEFA({
        method: 'efa', schemaVersion: 'factor_extensions.1',
        context: input.context, variables, correlation, extraction,
        nFactors, compareFactors, rotation, scoreMethod,
        parallelAnalysis: { enabled: paEnabled, iterations: paIter, quantile: 0.95, seed: 42 },
        sensitivityAnalysis: { enabled: sensEnabled, approximationAcknowledged: sensAck },
        uniquenessLower: 0.005, nStarts: 5, maxIterations: 2000, seed: 42,
      })
      if (!current()) return
      // E009: clear stale rows BEFORE fetching the new result's rows, so a
      // failed fetch never leaves the previous figure on screen. Clamp the
      // figure axes and the save factor into the new factor range (1-factor
      // results reset Y to F1).
      setRows([])
      setRowsTotal(0)
      setRowsResultId(null)
      setResult(res)
      setResultInput(input)
      setSubmittedKey(draftKey)
      const nq = res.summary.nFactors ?? 1
      setFigX((x) => (x >= 1 && x <= nq ? x : 1))
      setFigY((y) => (y >= 1 && y <= nq ? y : 1))
      setMatFactor((m) => (m >= 1 && m <= nq ? m : 1))
      const sens = res.details.sensitivityAnalysis
      if (sens && sens.comparisonId) {
        // E011 3rd round: the comparison runs in the background after the
        // main result publishes. Poll until it leaves running state so
        // progress, completion, failure, and cancel are visible
        // independently of the main result.
        const cid = sens.comparisonId as string
        setComparison({ comparisonId: cid, status: 'running' })
        void (async () => {
          for (let i = 0; i < 120; i++) {
            await new Promise((r) => setTimeout(r, 2000))
            if (!current()) return
            try {
              const c = await fetchEFAComparison(cid) as Record<string, unknown>
              if (!current()) return
              setComparison(c)
              if (c.status !== 'running' && c.status !== 'queued') return
            } catch {
              return
            }
          }
        })()
      }
      if (res.capabilities.rows) {
        const all = await fetchAllEFARows(res.resultId)
        if (!current()) return
        setRows(all)
        setRowsTotal(all.length)
        setRowsResultId(res.resultId)
      } else {
        setRows([])
        setRowsTotal(0)
        setRowsResultId(res.resultId)
      }
    } catch (err) {
      if (!current()) return
      setError(apiErrorMessage(err, '実行に失敗しました。'))
    } finally {
      if (current()) setLoading(false)
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
    const startedResultId = result.resultId
    setSelecting(true)
    setSelectInfo(null)
    try {
      // E009 3rd round: same-factor brushes send ONE axis whose range is
      // the INTERSECTION of the X and Y brush ranges (points lie on y=x,
      // so both conditions must hold). An empty intersection selects
      // nothing instead of ignoring the Y range.
      const sameAxis = figX === figY
      const axes = sameAxis ? [figX] : [figX, figY]
      const bb: [number, number][] = sameAxis
        ? [[Math.max(bounds.x[0], bounds.y[0]), Math.min(bounds.x[1], bounds.y[1])]]
        : [bounds.x, bounds.y]
      if (sameAxis && bb[0][0] > bb[0][1]) {
        setSelectInfo('一致0（X/Y範囲の共通部分が空です）')
        if (selectionSequence.current === selectionSeq && runSequence.current === seq) setSelecting(false)
        return
      }
      const res = await selectEFA(result.resultId, resultInput!.context, {
        kind: 'rectangle', axes, bounds: bb,
      })
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      if (result.resultId !== startedResultId) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation, label: 'EFA因子得点の選択' }))
      setSelectInfo(`一致${res.matchedCount}`)
    } catch (err) {
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq) return
      setSelectInfo(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === selectionSeq && runSequence.current === seq) setSelecting(false)
    }
  }

  const handleToggleScore = async (rowId: string): Promise<void> => {
    if (!result || !resultInput || !datasetId || !rowsReady || loading) return
    if (!matchesContext(resultInput.context)) { setSelectInfo('結果の版が現在のデータと一致しません。再実行してください。'); return }
    const seq = runSequence.current
    const selectionSeq = ++selectionSequence.current
    const startedDataset = datasetId
    const startedDataRevision = selection.dataRevision
    const startedSchemaRevision = schemaRevision
    setSelecting(true)
    try {
      const res = await selectEFA(result.resultId, resultInput!.context, { kind: 'row_ids', rowIds: [rowId] })
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq
        || selectionRef.current.datasetId !== startedDataset
        || selectionRef.current.dataRevision !== startedDataRevision
        || schemaRef.current !== startedSchemaRevision) return
      dispatch(selectionApplied({ rowIds: res.rowIds, operation: 'toggle', label: 'EFA因子得点の選択' }))
    } catch (err) {
      if (selectionSequence.current !== selectionSeq || runSequence.current !== seq) return
      message.error(apiErrorMessage(err, '選択に失敗しました。'))
    } finally {
      if (selectionSequence.current === selectionSeq && runSequence.current === seq) setSelecting(false)
    }
  }

  const handlePredict = async (): Promise<void> => {
    if (!result || !resultInput || !matchesContext(resultInput.context) || analysisScope.count === 0 || loading) return
    const seq = runSequence.current
    const predictionSeq = ++predictionSequence.current
    const context = captureAnalysisRunContext(buildContext())
    const targetLabel = `${analysisScope.label} ${analysisScope.count}行`
    try {
      const res = await predictEFA(result.resultId, context)
      if (runSequence.current !== seq || predictionSequence.current !== predictionSeq || selectionRef.current.datasetId !== context.datasetId || selectionRef.current.dataRevision !== context.expectedDataRevision || schemaRef.current !== context.expectedSchemaRevision) return
      setPredictionInfo(`この予測の対象: ${targetLabel}（実行時）`)
      message.success('予測を作成しました: ' + (res as { predictionId: string }).predictionId)
    } catch (err) {
      if (runSequence.current !== seq || predictionSequence.current !== predictionSeq) return
      message.error(apiErrorMessage(err, '予測に失敗しました。'))
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!result || !resultInput || !datasetId || !matchesContext(resultInput.context)) return
    setSaving(true)
    try {
      // E010: the saved factor and the output column name are chosen
      // separately; renaming the column never changes which scores persist.
      const field = 'score:' + matFactor
      const res = await materializeEFA(result.resultId, resultInput!.context, 'fit', [{ source: field, name: matName }], 'efa-' + result.resultId + '-' + field)
      message.success('保存しました: ' + matName)
      invalidateColumnarCache()
      const r = res as { dataRevision?: number }
      dispatch(datasetValuesUpdated({ datasetId, dataRevision: typeof r.dataRevision === 'number' ? r.dataRevision : (selection.dataRevision ?? 1) + 1 }))
      await dispatch(fetchCodebookThunk(datasetId))
    } catch (err) {
      message.error(apiErrorMessage(err, '保存に失敗しました。'))
    } finally {
      setSaving(false)
    }
  }

  const s = result?.summary
  // E012: stale is judged against the live central revisions (data/schema),
  // not only the response's stored resultState.
  const stale = result !== null && (
    (result.meta.resultState as string) === 'stale'
    || selection.dataRevision !== result.meta.dataRevision
    || schemaRevision !== result.meta.schemaRevision)
  const liveMaskRev = useSelector((s: RootState) => s.provenance.maskRevision)
  const fitMaskRev = (result?.meta as { maskRevision?: number | null } | undefined)?.maskRevision ?? null
  const maskStale = result !== null && fitMaskRev !== null && liveMaskRev !== fitMaskRev
  useEffect(() => {
    if (datasetId) void dispatch(fetchProvenanceThunk(datasetId))
  }, [datasetId, dispatch])
  const q = result?.summary.nFactors ?? 0
  const figPoints = useMemo(() => rows.map((r) => ({
    rowId: r.rowId,
    x: r.scores[figX - 1] ?? null,
    y: r.scores[figY - 1] ?? null,
    title: r.rowId + ' F' + figX + '=' + (r.scores[figX - 1] === null || r.scores[figX - 1] === undefined ? 'x' : Number(r.scores[figX - 1]).toFixed(3))
      + ' F' + figY + '=' + (r.scores[figY - 1] === null || r.scores[figY - 1] === undefined ? 'x' : Number(r.scores[figY - 1]).toFixed(3)),
  })), [rows, figX, figY])
  const selectedSet = useMemo(() => new Set(selection.selectedRowIds), [selection.selectedRowIds])
  const pattern = result?.details.pattern ?? []
  const varLabels = result?.details.variables.map((v) => v.label) ?? []
  const factorIds = result?.details.factorIds ?? []
  const loadingRows = pattern.map((row, j) => {
    const rec: Record<string, unknown> = { key: String(j), item: varLabels[j] ?? String(j) }
    row.forEach((v, a) => { rec['f' + a] = typeof v === 'number' ? v.toFixed(3) : 'x' })
    rec.communality = result ? Number(result.details.communality[j]).toFixed(3) : 'x'
    return rec
  })
  const loadingCols = [
    { title: '項目', dataIndex: 'item', key: 'item' },
    ...factorIds.map((f, a) => ({ title: f, dataIndex: 'f' + a, key: 'f' + a })),
    { title: '共通性', dataIndex: 'communality', key: 'h2' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card title="探索的因子分析（EFA）" size="small" className="analysis-setup">
        <div className="analysis-form-stack">
          <Space wrap>
            <AnalysisScopeSummary label="次回の分析対象" />
            <Tag>非加重・完全ケースのみ</Tag>
          </Space>
          <AnalysisField label="項目（必須・3つ以上）" htmlFor="efa-items"
            help="順序尺度または連続尺度の項目を選びます。まずは既定の設定で実行し、必要な場合だけ下の設定を変更してください。">
            <SelectColumn id="efa-items" aria-describedby="efa-items-help" mode="multiple" value={items} onChange={setItems} style={{ width: '100%', minWidth: 0 }} options={itemOptions} placeholder="項目を選択" />
          </AnalysisField>
          <AnalysisSettings title="項目の扱い・逆転"
            summary={treatmentSummary}
            attention={itemIssues.length > 0 || errorPanel === 'items'}>
            <Typography.Text type="secondary">順序項目は既定で順序モデルとして扱います。連続近似は等間隔とみなす判断が必要です。自動では変更しません。</Typography.Text>
            {items.length === 0 && <Typography.Text type="secondary">項目を選ぶと、項目ごとの設定が表示されます。</Typography.Text>}
            {items.map((id, index) => {
              const c = colById.get(id)
              const isOrd = c?.scaleType === 'ordinal'
              return (
                <AnalysisField key={id} label={c?.label || c?.name || id} htmlFor={isOrd ? 'efa-treatment-' + index : undefined}
                  help={isOrd ? '逆転はコードブックのカテゴリ順序に沿って反転します。' : '連続項目としてそのまま使用します。'}>
                  {isOrd ? (
                    <div className="analysis-inline-fields">
                      <SelectSetting id={'efa-treatment-' + index} aria-describedby={'efa-treatment-' + index + '-help'} value={treat[id] ?? 'ordinal'} onChange={(v) => setTreat({ ...treat, [id]: v })} style={{ width: 200 }} options={[
                        { value: 'ordinal', label: '順序モデル' },
                        { value: 'continuous_approximation', label: '連続近似' },
                      ]} />
                      <Checkbox checked={Boolean(reverse[id])} onChange={(e) => setReverse({ ...reverse, [id]: e.target.checked })}>逆転</Checkbox>
                      {(treat[id] ?? 'ordinal') === 'continuous_approximation' && (
                        <Checkbox checked={Boolean(ack[id])} onChange={(e) => setAck({ ...ack, [id]: e.target.checked })}>等間隔の明示同意</Checkbox>
                      )}
                    </div>
                  ) : <Tag>連続</Tag>}
                </AnalysisField>
              )
            })}
          </AnalysisSettings>
          <AnalysisSettings title="分析方法・詳細設定"
            summary={'現在: ' + (correlationMode === 'auto' ? '相関は自動（' + correlationLabel + '）' : correlationLabel) + ' / ' + nFactors + '因子' + (nFactorsOverride === null ? '（項目数に応じた初期値）' : '') + ' / ' + (extraction === 'minres' ? 'MINRES' : 'ML') + ' / ' + rotation + ' / 平行分析' + (paEnabled ? paIter + '回' : 'なし')
              + (scoreMethod !== 'none' ? ' / 得点: ' + scoreMethod : '') + (compareText.trim() ? ' / 候補比較: ' + compareText : '')
              + (sensEnabled ? ' / 感度比較あり' + (sensAck ? '' : '（同意待ち）') : '')}
            attention={methodIssues.length > 0 || errorPanel === 'method'}>
            <div className="analysis-variable-grid">
              <AnalysisField label="相関" htmlFor="efa-correlation"
                help="自動では、すべて順序モデルならPolychoric、連続項目または同意済みの連続近似ならPearsonを使います。">
                <SelectSetting id="efa-correlation" aria-describedby="efa-correlation-help" value={correlationMode} onChange={setCorrelationMode} style={{ width: '100%' }} options={[
                  { value: 'auto', label: '自動（項目の扱いに合わせる）' },
                  { value: 'polychoric', label: 'Polychoric' },
                  { value: 'pearson', label: 'Pearson' },
                ]} />
              </AnalysisField>
              <AnalysisField label="抽出" htmlFor="efa-extraction" help="既定はMINRES／ULS系です。MLは連続項目・連続近似の場合に選べます。">
                <SelectSetting id="efa-extraction" aria-describedby="efa-extraction-help" value={extraction} onChange={setExtraction} style={{ width: '100%' }} options={[
                  { value: 'minres', label: 'MINRES／ULS系' }, { value: 'ml', label: 'ML' },
                ]} />
              </AnalysisField>
              <AnalysisField label="因子数" htmlFor="efa-factor-count" help="既定は2因子です。3～4項目では推定可能な1因子を初期値にします。変更後は指定した数を維持します。">
                <div className="analysis-inline-fields">
                  <InputNumber id="efa-factor-count" aria-describedby="efa-factor-count-help" value={nFactors} onChange={(v) => setNFactorsOverride(v)} min={1} precision={0} />
                  {nFactorsOverride !== null && <Button size="small" onClick={() => setNFactorsOverride(null)}>初期設定に戻す</Button>}
                </div>
              </AnalysisField>
              <AnalysisField label="候補比較" htmlFor="efa-compare-factors" help="任意です。別の因子数も比較したい場合に、正の整数をカンマ区切りで指定します。">
                <Input id="efa-compare-factors" aria-describedby="efa-compare-factors-help" value={compareText} onChange={(e) => setCompareText(e.target.value)} placeholder="例: 1,3" />
              </AnalysisField>
              <AnalysisField label="回転" htmlFor="efa-rotation" help="既定は因子間の相関を許すPromaxです。Varimaxは直交回転、無回転は抽出したまま表示します。">
                <SelectSetting id="efa-rotation" aria-describedby="efa-rotation-help" value={rotation} onChange={setRotation} style={{ width: '100%' }} options={[
                  { value: 'promax', label: 'Promax' }, { value: 'varimax', label: 'Varimax' }, { value: 'none', label: '無回転' },
                ]} />
              </AnalysisField>
              <AnalysisField label="得点" htmlFor="efa-score-method" help="既定は「なし」です。連続項目・連続近似の因子得点が必要な場合に選びます。順序モデルでは利用できません。">
                <SelectSetting id="efa-score-method" aria-describedby="efa-score-method-help" value={scoreMethod} onChange={setScoreMethod} style={{ width: '100%' }} options={[
                  { value: 'none', label: 'なし' }, { value: 'regression', label: 'regression' }, { value: 'bartlett', label: 'bartlett' },
                ]} />
              </AnalysisField>
              <AnalysisField label="平行分析" htmlFor="efa-pa-enabled" help="既定で有効です。ランダムな参照データと固有値を比較し、因子数の判断材料を表示します。指定した因子数は変更しません。">
                <Checkbox id="efa-pa-enabled" aria-describedby="efa-pa-enabled-help" checked={paEnabled} onChange={(e) => setPaEnabled(e.target.checked)}>平行分析を行う</Checkbox>
                {paEnabled && <AnalysisField label="反復数" htmlFor="efa-pa-iterations" help="既定は500回です。回数を増やすと計算時間が長くなります。">
                  <InputNumber id="efa-pa-iterations" aria-describedby="efa-pa-iterations-help" value={paIter} onChange={(v) => setPaIter(typeof v === 'number' ? v : 500)} min={100} max={10000} precision={0} />
                </AnalysisField>}
              </AnalysisField>
              <AnalysisField label="感度比較" htmlFor="efa-sensitivity" help="既定は無効です。すべて順序尺度の項目について連続近似との違いを調べます。平行分析と独立した同意が必要です。">
                <Checkbox id="efa-sensitivity" aria-describedby="efa-sensitivity-help" checked={sensEnabled} onChange={(e) => { setSensEnabled(e.target.checked); if (!e.target.checked) setSensAck(false) }}>感度比較を行う</Checkbox>
                {sensEnabled && <Checkbox checked={sensAck} onChange={(e) => setSensAck(e.target.checked)}>連続近似の独立同意</Checkbox>}
              </AnalysisField>
            </div>
          </AnalysisSettings>
          <AnalysisSettings title="重み・欠損値" summary={'重み: ' + (weightMode === 'dataset' ? 'データ設定を確認' : 'なし（明示）') + ' / 欠損行は除外'}
            attention={weightIssues.length > 0 || errorPanel === 'weight'}>
            <AnalysisField label="重み" help="EFAは非加重のみ対応です。データ設定に重みがある場合、そのままでは実行できません。非加重でよい場合だけ「なし（明示）」を選んでください。">
              <Radio.Group aria-label="重み" value={weightMode} onChange={(e) => setWeightMode(e.target.value)}>
                <Radio.Button value="dataset">データ設定</Radio.Button>
                <Radio.Button value="none">なし（明示）</Radio.Button>
              </Radio.Group>
            </AnalysisField>
            <Typography.Text type="secondary">欠損値の扱いは完全ケースのみです。選択項目に欠損のある行を除外して計算します。</Typography.Text>
          </AnalysisSettings>
          {itemIssues.length > 0 && <Alert type="warning" message="項目の扱い・逆転を確認してください" description={itemIssues.join(' / ')} showIcon />}
          {methodIssues.length > 0 && <Alert type="warning" message="分析方法・詳細設定を確認してください" description={methodIssues.join(' / ')} showIcon />}
          {weightIssues.length > 0 && <Alert type="warning" message="重み・欠損値を確認してください" description={weightIssues.join(' / ')} showIcon />}
          {error && <Alert type="error" message={error}
            description={(errorPanel === 'weight' ? '重み・欠損値' : errorPanel === 'items' ? '項目の扱い・逆転' : '分析方法・詳細設定') + 'を開いて設定を確認してください。'} showIcon />}
          <AnalysisRunRow>
            <div aria-live="polite">
              <Typography.Text type="secondary">{requiredMessage}</Typography.Text>
              {dirty && <div><Tag color="orange" className="analysis-status-tag">設定が変更されています。結果は前回実行分です</Tag></div>}
            </div>
            <Button type="primary" onClick={() => void handleRun()} disabled={!canRun} loading={loading}>実行</Button>
          </AnalysisRunRow>
        </div>
      </Card>

      {loading && <Spin tip="計算中" />}

      {result && (
        <Card size="small" title={'結果: ' + result.resultId} extra={<span>解={s?.solutionStatus} 推論={s?.inferenceStatus}</span>}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {resultInput && <Tag data-testid="efa-result-scope">この結果の対象: {resultInput.label} {resultInput.count}行（実行時） / 有効{result.meta.fitCount}行</Tag>}
            {predictionInfo && <Typography.Text>{predictionInfo}</Typography.Text>}
            {stale && <Alert type="warning" message="古い版の結果です。保存・予測・選択はできません。" showIcon />}
            {maskStale && <Alert type="warning" message={'補完マスクが更新されています（結果mask ' + String(fitMaskRev) + ' / 現在 ' + String(liveMaskRev) + '）。再実行してください。'} showIcon />}
            <Space wrap>
              <Tag>目的値 {s?.objective.id}: {s?.objective.value === null || s?.objective.value === undefined ? 'x' : Number(s.objective.value).toFixed(6)}</Tag>
              <Tag>RMSR: {s?.rmsr === null || s?.rmsr === undefined ? 'x' : Number(s.rmsr).toFixed(4)}</Tag>
              <Tag>PA候補: {result.details.parallelAnalysis.suggestedFactors ?? 'x'}（{result.details.parallelAnalysis.status}）</Tag>
              {result.details.sensitivityAnalysis && (<Tag>感度比較: {String((comparison as Record<string, unknown> | null)?.assessment ?? result.details.sensitivityAnalysis.status)}</Tag>)}
            </Space>
            <Tabs activeKey={tab} onChange={setTab} items={[
              { key: 'loadings', label: '負荷量・残差', children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Table columns={loadingCols} dataSource={loadingRows} size="small" pagination={false} scroll={{ x: true }} />
                  <Typography.Text type="secondary">強調目安は表示のみ。斜交pattern二乗和は加算寄与率にしません。</Typography.Text>
                  <Table
                    columns={[{ title: '項目', dataIndex: 'item', key: 'item' }, ...factorIds.map((f, a) => ({ title: f + '(structure)', dataIndex: 's' + a, key: 's' + a })), { title: '独自性', dataIndex: 'psi', key: 'psi' }]}
                    dataSource={(result.details.structure ?? []).map((row, j) => {
                      const rec: Record<string, unknown> = { key: 's' + String(j), item: varLabels[j] ?? String(j) }
                      row.forEach((v, a) => { rec['s' + a] = typeof v === 'number' ? v.toFixed(3) : 'x' })
                      rec.psi = Number(result.details.uniqueness[j]).toFixed(3)
                      return rec
                    })}
                    size="small" pagination={false} scroll={{ x: true }} />
                  <Table
                    columns={[{ title: '', dataIndex: 'r', key: 'r' }, ...factorIds.map((f, a) => ({ title: f, dataIndex: 'c' + a, key: 'c' + a }))]}
                    dataSource={(result.details.factorCorrelation ?? []).map((row, j) => {
                      const rec: Record<string, unknown> = { key: 'p' + String(j), r: factorIds[j] ?? String(j) }
                      row.forEach((v, a) => { rec['c' + a] = typeof v === 'number' ? v.toFixed(3) : 'x' })
                      return rec
                    })}
                    size="small" pagination={false} title={() => '因子間相関Φ'} />
                  <Table
                    columns={[{ title: '行', dataIndex: 'r', key: 'r' }, { title: '列', dataIndex: 'c', key: 'c' }, { title: '観測', dataIndex: 'o', key: 'o' }, { title: '再現', dataIndex: 'rp', key: 'rp' }, { title: '残差', dataIndex: 'rs', key: 'rs' }]}
                    dataSource={(result.details.sampleCorrelation ?? []).flatMap((rrow, i) => rrow.map((v, j) => ({
                      key: i + '-' + j, r: varLabels[i] ?? i, c: varLabels[j] ?? j,
                      o: typeof v === 'number' ? v.toFixed(3) : 'x',
                      rp: typeof result.details.reproducedCorrelation?.[i]?.[j] === 'number' ? Number(result.details.reproducedCorrelation?.[i]?.[j]).toFixed(3) : 'x',
                      rs: typeof result.details.residualCorrelation?.[i]?.[j] === 'number' ? Number(result.details.residualCorrelation?.[i]?.[j]).toFixed(3) : 'x',
                    })))}
                    size="small" pagination={{ pageSize: 20 }} scroll={{ x: true, y: 320 }} />
                </Space>
              ) },
              { key: 'pa', label: '平行分析・候補比較', children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <GraphPanel
                    graphId="factor-analysis/scree"
                    title="固有値・平行分析スクリープロット"
                    available={tab === 'pa'}
                    sizing="intrinsic"
                    intrinsicSize={{ width: 560, height: 220 }}
                  >
                  <EChart fitPointMarkers
                    option={efaScreeOption(result.details.parallelAnalysis.observedEigenvalues ?? [],
                      result.details.parallelAnalysis.referenceQuantiles ?? [], result.details.parallelAnalysis.suggestedFactors)}
                    height={220} testId="efa-scree" ariaLabel="固有値・平行分析スクリープロット"
                  />
                  </GraphPanel>
                  <Table
                    columns={[{ title: '順位', dataIndex: 'rank', key: 'rank' }, { title: '観測', dataIndex: 'obs', key: 'obs' }, { title: '参照分位', dataIndex: 'ref', key: 'ref' }]}
                    dataSource={(result.details.parallelAnalysis.observedEigenvalues ?? []).map((v, i) => ({
                      key: String(i), rank: i + 1, obs: Number(v).toFixed(3),
                      ref: result.details.parallelAnalysis.referenceQuantiles?.[i] === null || result.details.parallelAnalysis.referenceQuantiles?.[i] === undefined ? 'x' : Number(result.details.parallelAnalysis.referenceQuantiles?.[i]).toFixed(3),
                    }))}
                    size="small" pagination={false}
                  />
                  <Table
                    columns={[{ title: 'q', dataIndex: 'q', key: 'q' }, { title: '状態', dataIndex: 'status', key: 'status' }]}
                    dataSource={result.details.factorComparisons.map((c, i) => ({ key: String(i), q: c.q, status: c.status }))}
                    size="small" pagination={false}
                  />
                </Space>
              ) },
              { key: 'diag', label: '診断・推論', children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Table
                    columns={[
                      { title: '項目', dataIndex: 'item', key: 'item' },
                      { title: '分布', dataIndex: 'dist', key: 'dist' },
                      { title: 'カテゴリ件数', dataIndex: 'cc', key: 'cc' },
                      { title: '割合', dataIndex: 'cp', key: 'cp' },
                      { title: '最小件数', dataIndex: 'mn', key: 'mn' },
                      { title: '最大割合', dataIndex: 'mx', key: 'mx' },
                      { title: '床/天井', dataIndex: 'fc', key: 'fc' },
                      { title: '歪度', dataIndex: 'sk', key: 'sk' },
                      { title: '欠損', dataIndex: 'mis', key: 'mis' },
                      { title: '非該当', dataIndex: 'na', key: 'na' },
                      { title: '不正', dataIndex: 'inv', key: 'inv' },
                    ]}
                    dataSource={(result.details.distributionProfiles ?? []).map((d, i) => {
                      const r = d as Record<string, unknown>
                      const fmt = (v: unknown): string => (typeof v === 'number' ? String(v) : 'x')
                      const f3 = (v: unknown): string => (typeof v === 'number' ? Number(v).toFixed(3) : 'x')
                      const arr = (v: unknown): string => (Array.isArray(v) ? v.map((x) => (typeof x === 'number' ? Number(x).toFixed(3) : String(x))).join(', ') : 'x')
                      return {
                        key: 'd' + i, item: varLabels[i] ?? String(r.columnId ?? i), dist: (r.kind as string) ?? 'x',
                        cc: Array.isArray(r.categoryCounts) ? (r.categoryCounts as unknown[]).join('/') : '—',
                        cp: arr(r.categoryProportions),
                        mn: fmt(r.minCategoryCount), mx: f3(r.maxCategoryProportion),
                        fc: f3(r.floorProportion) + '/' + f3(r.ceilingProportion),
                        sk: f3(r.rankSkewness),
                        mis: fmt(r.missing), na: fmt(r.notApplicable), inv: fmt(r.invalid),
                      }
                    })}
                    size="small" pagination={false} scroll={{ x: true }} />
                  <Typography.Text type="secondary">連続近似の判断材料: カテゴリ別件数・割合、床／天井集中、歪度、欠損／非該当／不正の内訳。目安（少数・集中・歪度）は表示のみで実行経路を強制しません。</Typography.Text>
                  <Table
                    columns={[{ title: '対', dataIndex: 'pair', key: 'pair' }, { title: 'ρ', dataIndex: 'rho', key: 'rho' }, { title: '状態', dataIndex: 'st', key: 'st' }, { title: '0セル', dataIndex: 'z', key: 'z' }, { title: '少数', dataIndex: 'sm', key: 'sm' }, { title: '境界', dataIndex: 'bd', key: 'bd' }]}
                    dataSource={(result.details.correlationPairs ?? []).map((p, i) => ({
                      key: 'c' + i,
                      pair: (varLabels[p.pair?.[0] ?? 0] ?? '?') + '–' + (varLabels[p.pair?.[1] ?? 0] ?? '?'),
                      rho: p.rho === null || p.rho === undefined ? 'x' : Number(p.rho).toFixed(4),
                      st: p.status + (p.reasonCode ? '(' + p.reasonCode + ')' : ''),
                      z: p.zeroCells, sm: p.smallCells, bd: p.boundary ? '境界' : '—',
                    }))}
                    size="small" pagination={{ pageSize: 15 }} scroll={{ y: 300 }} />
                  <Table
                    columns={[{ title: 'start', dataIndex: 'si', key: 'si' }, { title: '状態', dataIndex: 'st', key: 'st' }, { title: '反復', dataIndex: 'it', key: 'it' }, { title: '目的値', dataIndex: 'ob', key: 'ob' }, { title: '射影勾配', dataIndex: 'pg', key: 'pg' }]}
                    dataSource={(result.details.optimizerStarts ?? []).map((t) => ({
                      key: 't' + t.startIndex, si: t.startIndex, st: t.status, it: t.iterations,
                      ob: t.objective === null || t.objective === undefined ? 'x' : Number(t.objective).toFixed(6),
                      pg: t.projectedGradientNorm === null || t.projectedGradientNorm === undefined ? 'x' : Number(t.projectedGradientNorm).toExponential(2),
                    }))}
                    size="small" pagination={false} />
                  <Space direction="vertical" style={{ width: '100%' }} size="small">
                    <Typography.Text>参考推論（{result.details.referenceInference?.status ?? 'x'}）: ML Pearson経路のみ提供、ULS系は非対応。</Typography.Text>
                    {result.details.referenceInference?.fit && (
                      <Typography.Text>
                        χ²={result.details.referenceInference.fit.statistic === null || result.details.referenceInference.fit.statistic === undefined ? 'x' : Number(result.details.referenceInference.fit.statistic).toFixed(3)}
                        （df {result.details.referenceInference.fit.df}）
                        p={result.details.referenceInference.fit.pValue === null || result.details.referenceInference.fit.pValue === undefined ? 'x' : Number(result.details.referenceInference.fit.pValue).toExponential(2)}
                        RMSEA={result.details.referenceInference.fit.rmsea === null || result.details.referenceInference.fit.rmsea === undefined ? 'x' : Number(result.details.referenceInference.fit.rmsea).toFixed(4)}
                        {result.details.referenceInference.fit.reasonCode ? '(' + result.details.referenceInference.fit.reasonCode + ')' : ''}
                      </Typography.Text>
                    )}
                    <Typography.Text>
                      KMO={result.details.referenceInference?.kmo === null || result.details.referenceInference?.kmo === undefined ? 'x' : Number(result.details.referenceInference.kmo).toFixed(3)}
                      / Bartlett χ²={result.details.referenceInference?.bartlett?.statistic === null || result.details.referenceInference?.bartlett?.statistic === undefined ? 'x' : Number(result.details.referenceInference?.bartlett?.statistic).toFixed(2)}
                      （df {result.details.referenceInference?.bartlett?.df ?? 'x'}）
                      p={result.details.referenceInference?.bartlett?.pValue === null || result.details.referenceInference?.bartlett?.pValue === undefined ? 'x' : Number(result.details.referenceInference?.bartlett?.pValue).toExponential(2)}
                      {result.details.referenceInference?.bartlett?.reasonCode ? '(' + result.details.referenceInference.bartlett.reasonCode + ')' : ''}
                    </Typography.Text>
                    <Typography.Text type="secondary">解診断: {(result.details.solutionDiagnostics ?? []).map((d) => d.code + '(' + d.severity + '/' + d.stage + ')').join(' / ') || 'なし'}</Typography.Text>
                  </Space>
                </Space>
              ) },
              { key: 'sens', label: '感度比較', children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  {comparison
                    ? (<Space direction="vertical" style={{ width: '100%' }} size="small">
                      <Space wrap>
                        <Typography.Text>状態: {String((comparison as Record<string, unknown>).status ?? 'x')}</Typography.Text>
                        {typeof (comparison as Record<string, unknown>).progress === 'number' && (
                          <Typography.Text type="secondary">
                            進捗 {String((comparison as Record<string, unknown>).completedIterations ?? '?')}/{String((comparison as Record<string, unknown>).totalIterations ?? '?')}
                            （{Math.round(Number((comparison as Record<string, unknown>).progress) * 100)}%・{(comparison as Record<string, unknown>).stage as string})
                          </Typography.Text>
                        )}
                        {((comparison as Record<string, unknown>).status === 'running' || (comparison as Record<string, unknown>).status === 'queued') && (
                          <Button size="small" onClick={() => {
                            const cid = (comparison as Record<string, unknown>).comparisonId as string
                            if (cid) void cancelEFAComparison(cid).then((c) => setComparison({ ...(comparison as Record<string, unknown>), ...(c as Record<string, unknown>) })).catch(() => undefined)
                          }}>比較を中断</Button>
                        )}
                      </Space>
                      <Typography.Text>判定: {String((comparison as Record<string, unknown>).assessment ?? 'x')}</Typography.Text>
                      <Table
                        columns={[{ title: '指標', dataIndex: 'm', key: 'm' }, { title: '最大差', dataIndex: 'mx', key: 'mx' }, { title: '中央値差', dataIndex: 'md', key: 'md' }]}
                        dataSource={(() => {
                          const met = (comparison as Record<string, { max: number | null; median: number | null }>).metrics as unknown as Record<string, { max: number | null; median: number | null }> | undefined
                          if (!met) return []
                          const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? 'x' : Number(v).toFixed(4))
                          return [
                            { key: 'c', m: '相関', mx: fmt(met.correlationDifference?.max), md: fmt(met.correlationDifference?.median) },
                            { key: 'l', m: '負荷量', mx: fmt(met.loadingDifference?.max), md: fmt(met.loadingDifference?.median) },
                            { key: 'h', m: '共通性', mx: fmt(met.communalityDifference?.max), md: fmt(met.communalityDifference?.median) },
                            { key: 'p', m: 'Φ', mx: fmt(met.factorCorrelationDifference?.max), md: fmt(met.factorCorrelationDifference?.median) },
                          ]
                        })()}
                        size="small" pagination={false} />
                      <Typography.Text type="secondary">割当変更: {String((comparison as Record<string, unknown>).assignmentChanges ?? 'x')} / PA差: {JSON.stringify((comparison as Record<string, unknown>).factorCountComparison ?? null)}</Typography.Text>
                    </Space>)
                    : (<Typography.Text type="secondary">感度比較は主結果と独立に保持されます。一致は同等性証明ではありません。</Typography.Text>)}
                </Space>
              ) },
              { key: 'scores', label: '得点操作', children: (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  {!result.capabilities.rows && (<Alert type="info" message="得点操作は適切なPearson解の明示選択時のみ有効です。" showIcon />)}
                  <SelectionMenu />
                  <Space wrap>
                    <span>X軸:</span>
                    <SelectSetting value={figX} onChange={setFigX} style={{ width: 110 }} options={factorIds.map((f, a) => ({ value: a + 1, label: f }))} />
                    <span>Y軸:</span>
                    <SelectSetting value={figY} onChange={setFigY} style={{ width: 110 }} options={factorIds.map((f, a) => ({ value: a + 1, label: f }))} />
                    <span>全{rowsTotal}行{q >= 2 ? '' : '（1因子のため単軸選択）'}</span>
                  </Space>
                  {selectInfo && <Alert type={selectInfo.startsWith('一致') ? 'success' : 'warning'} message={selectInfo} showIcon />}
                  {selecting && <Spin size="small" tip="選択中" />}
                  {result.capabilities.rows && q >= 1 && rowsReady && (
                    <GraphPanel
                      graphId="factor-analysis/scores"
                      title="因子得点散布図"
                      available={tab === 'scores'}
                      sizing="intrinsic"
                      intrinsicSize={{ width: 560, height: 400 }}
                    >
                    <EfaScoreFigure
                      points={figPoints}
                      xLabel={factorIds[figX - 1] ?? ('F' + figX)}
                      yLabel={factorIds[figY - 1] ?? ('F' + figY)}
                      selected={selectedSet}
                      hovered={selection.hoveredRowId ?? null}
                      getColor={getColor}
                      onToggle={(id) => void handleToggleScore(id)}
                      onBrush={(b) => void handleBrush(b)}
                      svgRef={svgRef}
                      testId="efa-score-figure"
                    />
                    </GraphPanel>
                  )}
                  <L1Legend />
                  <Space wrap>
                    <AnalysisScopeSummary label="次回の予測対象" />
                    <Button disabled={stale || loading || analysisScope.count === 0 || !result.capabilities.rows} onClick={() => void handlePredict()}>予測</Button>
                    <span>保存する因子:</span>
                    <SelectSetting value={matFactor} onChange={setMatFactor} style={{ width: 110 }} options={factorIds.map((f, a) => ({ value: a + 1, label: f }))} />
                    <Input value={matName} onChange={(e) => setMatName(e.target.value)} style={{ width: 160 }} placeholder="保存列名" />
                    <Button disabled={stale || loading || !result.capabilities.rows} loading={saving} onClick={() => void handleSave()}>派生列保存</Button>
                  </Space>
                  <Table
                    columns={[{ title: 'rowId', dataIndex: 'rowId', key: 'rowId' }, { title: '得点', dataIndex: 'scores', key: 'scores' }]}
                    dataSource={rows.slice(0, 50).map((r) => ({ key: r.rowId, rowId: r.rowId, scores: r.scores.map((v) => v === null ? 'x' : Number(v).toFixed(3)).join(', ') }))}
                    size="small" pagination={false}
                  />
                  <Space>
                    <AsyncExportButton exportKey={result.resultId} statusLabel="変数CSV" onExport={() => exportEFATable(result.resultId, 'variables', 'csv')}>変数CSV</AsyncExportButton>
                    <AsyncExportButton exportKey={result.resultId} statusLabel="診断CSV" onExport={() => exportEFATable(result.resultId, 'diagnostics', 'csv')}>診断CSV</AsyncExportButton>
                    <AsyncExportButton exportKey={result.resultId} statusLabel="PA CSV" onExport={() => exportEFATable(result.resultId, 'parallel_analysis', 'csv')}>PA CSV</AsyncExportButton>
                  </Space>
                </Space>
              ) },
            ]} />
          </Space>
        </Card>
      )}
    </div>
  )
}
